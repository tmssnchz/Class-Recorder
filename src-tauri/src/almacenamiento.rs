//! Detección de OneDrive y creación de la carpeta de grabaciones cuando el
//! usuario elige guardarlas en OneDrive o Google Drive.
//!
//! Igual que con Google Drive (ver `importar.rs`), no se usa ninguna API en la
//! nube: todo pasa por el sistema de archivos. Para OneDrive se lee el
//! registro con `reg query` en vez de agregar una dependencia solo para eso.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "windows")]
use windows::Win32::Storage::FileSystem::{
    FileStandardInfo, GetFileAttributesW, GetFileInformationByHandleEx,
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN, FILE_STANDARD_INFO,
    INVALID_FILE_ATTRIBUTES,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HANDLE;
#[cfg(target_os = "windows")]
use windows::core::PCWSTR;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuentaOneDrive {
    /// Nombre para mostrar: el de la carpeta misma, que OneDrive ya arma como
    /// "OneDrive" o "OneDrive - <organización>" según la cuenta.
    pub nombre: String,
    pub carpeta: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoOneDrive {
    pub instalado: bool,
    pub cuentas: Vec<CuentaOneDrive>,
}

fn onedrive_exe_existe() -> bool {
    std::env::var("LOCALAPPDATA")
        .map(|local| Path::new(&local).join(r"Microsoft\OneDrive\OneDrive.exe").exists())
        .unwrap_or(false)
}

/// Lee `HKCU\Software\Microsoft\OneDrive\Accounts`, donde OneDrive deja una
/// subclave por cuenta (personal y una por cada organización) con su
/// `UserFolder`. Se filtran las que ya no existan en disco.
fn leer_cuentas_onedrive() -> Vec<CuentaOneDrive> {
    let salida = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\OneDrive\Accounts", "/s"])
        .output();
    let Ok(salida) = salida else { return Vec::new() };
    if !salida.status.success() {
        return Vec::new();
    }
    let texto = String::from_utf8_lossy(&salida.stdout);

    texto
        .lines()
        .filter_map(|linea| {
            let resto = linea.trim().strip_prefix("UserFolder")?;
            let valor = resto.split("REG_SZ").nth(1)?.trim();
            if valor.is_empty() { None } else { Some(valor.to_string()) }
        })
        .filter(|carpeta| Path::new(carpeta).exists())
        .map(|carpeta| {
            let nombre = Path::new(&carpeta)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "OneDrive".to_string());
            CuentaOneDrive { nombre, carpeta }
        })
        .collect()
}

/// Busca OneDrive Desktop instalado y sus cuentas, para ofrecerlas como
/// candidatas al elegir dónde crear la carpeta de grabaciones.
#[tauri::command]
pub fn detectar_onedrive() -> InfoOneDrive {
    let cuentas = leer_cuentas_onedrive();
    let instalado = onedrive_exe_existe()
        || std::env::var("OneDriveConsumer").is_ok()
        || std::env::var("OneDriveCommercial").is_ok()
        || !cuentas.is_empty();
    InfoOneDrive { instalado, cuentas }
}

fn ruta_ancha(ruta: &str) -> Vec<u16> {
    ruta.encode_utf16().chain(std::iter::once(0)).collect()
}

/// true si `ruta` es un placeholder de OneDrive: figura en el índice pero el
/// contenido todavía no bajó a disco (modo ahorro de espacio). En cualquier
/// otro sistema operativo el atributo no existe, así que nunca es true.
#[tauri::command]
pub fn es_placeholder(ruta: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let ancha = ruta_ancha(&ruta);
        let atributos = unsafe { GetFileAttributesW(PCWSTR(ancha.as_ptr())) };
        if atributos == INVALID_FILE_ATTRIBUTES {
            return Err(format!("No se pudo leer los atributos de {ruta}."));
        }
        let marca = FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS.0 | FILE_ATTRIBUTE_RECALL_ON_OPEN.0;
        Ok(atributos & marca != 0)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = ruta;
        Ok(false)
    }
}

/// Bytes ya bajados a disco (AllocationSize) y tamaño total (EndOfFile) de un
/// archivo, sondeando la misma información que usa el Explorador para pintar
/// el ícono de sincronización. Solo tiene sentido en Windows.
#[cfg(target_os = "windows")]
fn tamano_fisico(archivo: &std::fs::File) -> Option<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;

    let handle = HANDLE(archivo.as_raw_handle());
    let mut info: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    ok.ok()
        .map(|_| (info.AllocationSize.max(0) as u64, info.EndOfFile.max(0) as u64))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgresoHidratacion {
    tarea: String,
    bytes: u64,
    total: u64,
}

/// Fuerza la descarga completa de un placeholder leyéndolo de punta a punta:
/// alcanza con pedirle los bytes al sistema de archivos, sin ninguna llamada
/// específica de OneDrive. Mientras lee, sondea cuánto ya bajó a disco para
/// emitir el progreso real, igual que las barras de descarga de modelos.
#[tauri::command]
pub async fn hidratar_archivo(app: AppHandle, ruta: String, tarea: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut archivo =
            std::fs::File::open(&ruta).map_err(|e| format!("No se pudo abrir {ruta}: {e}"))?;
        let total = archivo.metadata().map(|m| m.len()).unwrap_or(0);

        #[cfg(target_os = "windows")]
        let detener = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(target_os = "windows")]
        let hilo_sondeo = archivo.try_clone().ok().map(|clon| {
            let app = app.clone();
            let tarea = tarea.clone();
            let detener = detener.clone();
            std::thread::spawn(move || {
                while !detener.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Some((bytes, total)) = tamano_fisico(&clon) {
                        let _ = app.emit(
                            "hidratacion://progreso",
                            ProgresoHidratacion { tarea: tarea.clone(), bytes, total },
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            })
        });

        let mut buffer = [0u8; 1024 * 1024];
        let resultado: std::io::Result<()> = (|| {
            loop {
                if archivo.read(&mut buffer)? == 0 {
                    break;
                }
            }
            Ok(())
        })();

        #[cfg(target_os = "windows")]
        {
            detener.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(hilo) = hilo_sondeo {
                let _ = hilo.join();
            }
        }

        resultado.map_err(|e| format!("No se pudo descargar {ruta}: {e}"))?;
        let _ = app.emit(
            "hidratacion://progreso",
            ProgresoHidratacion { tarea, bytes: total, total },
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("Falló la tarea de hidratación: {e}"))?
}

/// Archivos de una grabación en curso: nunca se migran, se recuperan solos al
/// reabrir la app en la carpeta donde quedaron.
fn es_temporal(nombre: &str) -> bool {
    nombre.ends_with(".webm.part") || nombre.ends_with(".parcial.json") || nombre.ends_with(".tmp")
}

fn juntar_archivos(dir: &Path, raiz: &Path, salida: &mut Vec<(PathBuf, PathBuf)>) {
    let Ok(entradas) = std::fs::read_dir(dir) else { return };
    for entrada in entradas.flatten() {
        let ruta = entrada.path();
        if ruta.is_dir() {
            juntar_archivos(&ruta, raiz, salida);
            continue;
        }
        let nombre = entrada.file_name().to_string_lossy().to_string();
        if es_temporal(&nombre) {
            continue;
        }
        if let Ok(relativa) = ruta.strip_prefix(raiz) {
            salida.push((ruta.clone(), relativa.to_path_buf()));
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgresoMigracion {
    tarea: String,
    archivos: u64,
    total_archivos: u64,
    bytes: u64,
    total_bytes: u64,
}

/// Copia toda la carpeta `origen` dentro de `destino`, preservando la
/// estructura, y solo borra el origen si la copia completa terminó bien: así
/// nunca se pierde un archivo por un fallo a mitad de camino. Devuelve cuántos
/// archivos se movieron.
#[tauri::command]
pub async fn mover_carpeta_grabaciones(
    app: AppHandle,
    origen: String,
    destino: String,
    tarea: String,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let origen_ruta = PathBuf::from(&origen);
        let destino_ruta = PathBuf::from(&destino);

        if !origen_ruta.exists() || origen_ruta == destino_ruta {
            return Ok(0);
        }

        let mut archivos = Vec::new();
        juntar_archivos(&origen_ruta, &origen_ruta, &mut archivos);
        if archivos.is_empty() {
            return Ok(0);
        }

        let total_archivos = archivos.len() as u64;
        let total_bytes: u64 = archivos
            .iter()
            .filter_map(|(abs, _)| std::fs::metadata(abs).ok())
            .map(|m| m.len())
            .sum();

        let mut hechos: u64 = 0;
        let mut bytes: u64 = 0;

        for (abs, relativa) in &archivos {
            let destino_archivo = destino_ruta.join(relativa);
            if let Some(padre) = destino_archivo.parent() {
                std::fs::create_dir_all(padre)
                    .map_err(|e| format!("No se pudo crear {}: {e}", padre.display()))?;
            }
            std::fs::copy(abs, &destino_archivo).map_err(|e| {
                format!("No se pudo copiar {} a {}: {e}", abs.display(), destino_archivo.display())
            })?;

            // Se verifica el tamaño antes de seguir: si algo quedó a medias, mejor
            // frenar ahora (el origen sigue intacto) que borrar después algo mal copiado.
            let tam_origen = std::fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
            let tam_destino = std::fs::metadata(&destino_archivo).map(|m| m.len()).unwrap_or(0);
            if tam_origen != tam_destino {
                return Err(format!(
                    "La copia de {} no coincide en tamaño: el origen no se tocó.",
                    abs.display()
                ));
            }

            hechos += 1;
            bytes += tam_destino;
            let _ = app.emit(
                "migracion://progreso",
                ProgresoMigracion {
                    tarea: tarea.clone(),
                    archivos: hechos,
                    total_archivos,
                    bytes,
                    total_bytes,
                },
            );
        }

        // Todo copiado y verificado: recién ahora se borra el origen.
        let _ = std::fs::remove_dir_all(&origen_ruta);

        Ok(total_archivos)
    })
    .await
    .map_err(|e| format!("La migración falló: {e}"))?
}

/// Crea (o reutiliza) `nombre` dentro de `raiz` y devuelve la ruta completa.
/// Se usa tanto para OneDrive como para Google Drive cuando el usuario elige
/// que la app arme la carpeta sola, en vez de apuntar a una ya existente.
#[tauri::command]
pub fn crear_carpeta_en_raiz(raiz: String, nombre: String) -> Result<String, String> {
    let base = PathBuf::from(&raiz);
    if !base.exists() {
        return Err(format!("La carpeta {raiz} no existe."));
    }
    let destino = base.join(&nombre);
    std::fs::create_dir_all(&destino)
        .map_err(|e| format!("No se pudo crear {}: {e}", destino.display()))?;
    Ok(destino.to_string_lossy().to_string())
}
