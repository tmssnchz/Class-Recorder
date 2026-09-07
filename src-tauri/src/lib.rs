mod almacenamiento;
mod descargas;
mod escaneo;
mod htr;
mod marcadores;
mod importar;
mod respaldo;
mod transcripcion;
mod transcripcion_api;

use std::path::{Path, PathBuf};

use serde::Serialize;
use sysinfo::Disks;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EspacioDisco {
    /// Punto de montaje que se usó para el cálculo (ej: "C:\\")
    pub unidad: String,
    pub total_bytes: u64,
    pub libre_bytes: u64,
}

/// Devuelve el espacio libre del volumen que contiene `ruta`.
/// Si la ruta todavía no existe, sube por los padres hasta encontrar uno que sí.
#[tauri::command]
fn espacio_disco(ruta: String) -> Result<EspacioDisco, String> {
    let objetivo = ruta_existente_mas_cercana(Path::new(&ruta))
        .ok_or_else(|| format!("No se pudo resolver la ruta: {ruta}"))?;

    let discos = Disks::new_with_refreshed_list();

    // Elegimos el disco cuyo punto de montaje sea el prefijo más largo de la ruta.
    let mut mejor: Option<(usize, &sysinfo::Disk)> = None;
    for disco in discos.list() {
        let montaje = disco.mount_point();
        if objetivo.starts_with(montaje) {
            let largo = montaje.as_os_str().len();
            if mejor.as_ref().map_or(true, |(l, _)| largo > *l) {
                mejor = Some((largo, disco));
            }
        }
    }

    let disco = mejor
        .map(|(_, d)| d)
        .ok_or_else(|| format!("No se encontró el volumen de {}", objetivo.display()))?;

    Ok(EspacioDisco {
        unidad: disco.mount_point().to_string_lossy().to_string(),
        total_bytes: disco.total_space(),
        libre_bytes: disco.available_space(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoSistema {
    pub ram_total_bytes: u64,
    pub ram_libre_bytes: u64,
    /// Hilos lógicos. Es lo que se le pasa a whisper y a llama.cpp con `-t`.
    pub nucleos: u32,
}

/// Datos de la máquina para poder recomendar un motor y un modelo que de
/// verdad entren acá, en vez de dejar al usuario adivinar entre nueve opciones.
///
/// No informa la GPU: los dos motores que usa la app corren en CPU (las builds
/// que se descargan son las de CPU), así que la RAM y los núcleos son lo único
/// que cambia la recomendación.
#[tauri::command]
fn info_sistema() -> InfoSistema {
    let mut sistema = sysinfo::System::new();
    sistema.refresh_memory();
    InfoSistema {
        ram_total_bytes: sistema.total_memory(),
        ram_libre_bytes: sistema.available_memory(),
        nucleos: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(4),
    }
}

/// Sube por los padres hasta encontrar uno que exista. Sin `canonicalize`:
/// en Windows agrega el prefijo `\\?\`, que después nunca matchea contra el
/// punto de montaje de sysinfo (que nunca lo trae) y rompe la comparación de
/// abajo.
fn ruta_existente_mas_cercana(ruta: &Path) -> Option<PathBuf> {
    let mut actual = Some(ruta);
    while let Some(p) = actual {
        if p.exists() {
            return Some(p.to_path_buf());
        }
        actual = p.parent();
    }
    None
}

/// WebView2 no concede el micrófono por su cuenta: sin este handler,
/// `getUserMedia` queda esperando o falla con NotAllowedError. Nos enganchamos
/// al evento PermissionRequested y aprobamos únicamente el micrófono.
///
/// El permiso del sistema operativo (Configuración › Privacidad › Micrófono) es
/// otra capa distinta y la sigue controlando Windows.
#[cfg(target_os = "windows")]
fn permitir_microfono(ventana: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let resultado = ventana.with_webview(|webview| unsafe {
        let controlador = webview.controller();
        let nucleo = match controlador.CoreWebView2() {
            Ok(n) => n,
            Err(e) => {
                eprintln!("No se pudo obtener CoreWebView2: {e}");
                return;
            }
        };

        // El token de registro es un i64 de salida que no necesitamos conservar:
        // el handler vive lo mismo que la ventana.
        let mut token = 0i64;
        let registro = nucleo.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut tipo = Default::default();
                args.PermissionKind(&mut tipo)?;
                if tipo == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        );
        if let Err(e) = registro {
            eprintln!("No se pudo registrar el permiso de micrófono: {e}");
        }
    });

    if let Err(e) = resultado {
        eprintln!("No se pudo acceder al webview para el micrófono: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Una sola instancia a la vez: dos ventanas abiertas se pisan config.json
        // y datos.json entre sí, porque cada una guarda su copia en memoria y la
        // última en escribir gana. Si ya hay uno corriendo, se lo trae al frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(ventana) = app.get_webview_window("main") {
                let _ = ventana.unminimize();
                let _ = ventana.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(ventana) = app.get_webview_window("main") {
                    permitir_microfono(&ventana);
                }
            }
            let _ = app;
            Ok(())
        })
        .manage(transcripcion::Procesos::default())
        .invoke_handler(tauri::generate_handler![
            espacio_disco,
            info_sistema,
            almacenamiento::detectar_onedrive,
            almacenamiento::crear_carpeta_en_raiz,
            almacenamiento::es_placeholder,
            almacenamiento::hidratar_archivo,
            almacenamiento::mover_carpeta_grabaciones,
            descargas::descargar_modelo,
            descargas::descargar_modelo_faster,
            descargas::instalar_whisper,
            descargas::instalar_faster_whisper,
            descargas::instalar_llamacpp,
            respaldo::medir_respaldo,
            respaldo::exportar_respaldo,
            importar::detectar_drive,
            importar::escanear_inbox,
            importar::escanear_inbox_fotos,
            importar::archivar_importado,
            importar::preparar_inbox,
            escaneo::analizar_foto,
            escaneo::rectificar_foto,
            escaneo::generar_marcador_png,
            htr::reconocer_texto_local,
            transcripcion::transcribir,
            transcripcion::transcribir_faster,
            transcripcion::cancelar_transcripcion,
            transcripcion::hilos_recomendados,
            transcripcion_api::cifrar_clave_api,
            transcripcion_api::transcribir_api,
            transcripcion_api::reconocer_apunte_api,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar ClassRecorder");
}
