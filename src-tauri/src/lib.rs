mod descargas;
mod importar;
mod respaldo;
mod transcripcion;

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

fn ruta_existente_mas_cercana(ruta: &Path) -> Option<PathBuf> {
    let mut actual = Some(ruta);
    while let Some(p) = actual {
        if p.exists() {
            return p.canonicalize().ok().or_else(|| Some(p.to_path_buf()));
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
            descargas::descargar_modelo,
            descargas::descargar_modelo_faster,
            descargas::instalar_whisper,
            descargas::instalar_faster_whisper,
            respaldo::medir_respaldo,
            respaldo::exportar_respaldo,
            importar::detectar_drive,
            importar::escanear_inbox,
            importar::archivar_importado,
            importar::preparar_inbox,
            transcripcion::transcribir,
            transcripcion::transcribir_faster,
            transcripcion::cancelar_transcripcion,
            transcripcion::hilos_recomendados,
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar ClassRecorder");
}
