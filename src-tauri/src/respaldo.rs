//! Respaldo completo a un único .zip.
//!
//! Incluye la carpeta de grabaciones más `datos.json` y `config.json`, que son
//! los que reconstruyen la biblioteca. El audio se puede excluir: un semestre
//! entero de clases son varios GB, y para llevarse solo las transcripciones
//! alcanza con unos pocos MB.

use std::fs::File;
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// Extensiones de audio: se omiten cuando el respaldo es solo de datos.
const EXTENSIONES_AUDIO: [&str; 3] = ["mp3", "wav", "webm"];

/// Archivos de una grabación en curso. Nunca entran al respaldo: son estado
/// transitorio que solo tiene sentido en la máquina donde se está grabando.
fn es_temporal(nombre: &str) -> bool {
    nombre.ends_with(".webm.part")
        || nombre.ends_with(".parcial.json")
        || nombre.ends_with(".tmp")
}

fn es_audio(ruta: &Path) -> bool {
    ruta.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONES_AUDIO.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResumenRespaldo {
    pub archivos: u64,
    pub bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgresoRespaldo {
    tarea: String,
    archivos: u64,
    total_archivos: u64,
    bytes: u64,
}

/// Recorre la carpeta y junta los archivos que van al zip, con su ruta
/// relativa (la que van a tener adentro).
fn juntar_archivos(
    raiz: &Path,
    incluir_audio: bool,
    excluir: Option<&Path>,
) -> Vec<(PathBuf, String)> {
    let mut encontrados = Vec::new();

    fn recorrer(
        dir: &Path,
        raiz: &Path,
        incluir_audio: bool,
        excluir: Option<&Path>,
        salida: &mut Vec<(PathBuf, String)>,
    ) {
        let Ok(entradas) = std::fs::read_dir(dir) else {
            return;
        };
        for entrada in entradas.flatten() {
            let ruta = entrada.path();
            if Some(ruta.as_path()) == excluir {
                continue;
            }
            if ruta.is_dir() {
                recorrer(&ruta, raiz, incluir_audio, excluir, salida);
                continue;
            }

            let nombre = entrada.file_name().to_string_lossy().to_string();
            if es_temporal(&nombre) {
                continue;
            }
            if !incluir_audio && es_audio(&ruta) {
                continue;
            }

            if let Ok(relativa) = ruta.strip_prefix(raiz) {
                // El zip usa siempre barras normales, no las de Windows.
                let interna = relativa.to_string_lossy().replace('\\', "/");
                salida.push((ruta.clone(), format!("grabaciones/{interna}")));
            }
        }
    }

    recorrer(raiz, raiz, incluir_audio, excluir, &mut encontrados);
    encontrados
}

/// Cuánto va a ocupar el respaldo, para poder avisar antes de arrancar.
#[tauri::command]
pub fn medir_respaldo(
    carpeta_raiz: String,
    carpeta_datos: String,
    incluir_audio: bool,
) -> Result<ResumenRespaldo, String> {
    let raiz = PathBuf::from(&carpeta_raiz);
    let mut resumen = ResumenRespaldo::default();

    if raiz.exists() {
        for (ruta, _) in juntar_archivos(&raiz, incluir_audio, None) {
            if let Ok(meta) = std::fs::metadata(&ruta) {
                resumen.archivos += 1;
                resumen.bytes += meta.len();
            }
        }
    }

    for nombre in ["datos.json", "config.json"] {
        let ruta = PathBuf::from(&carpeta_datos).join(nombre);
        if let Ok(meta) = std::fs::metadata(&ruta) {
            resumen.archivos += 1;
            resumen.bytes += meta.len();
        }
    }

    Ok(resumen)
}

#[tauri::command]
pub async fn exportar_respaldo(
    app: AppHandle,
    carpeta_raiz: String,
    carpeta_datos: String,
    destino: String,
    incluir_audio: bool,
    tarea: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let raiz = PathBuf::from(&carpeta_raiz);
        let destino_ruta = PathBuf::from(&destino);

        // El zip puede estar dentro de la propia carpeta de grabaciones: hay
        // que saltearlo o se intentaría meter dentro de sí mismo.
        let mut archivos = if raiz.exists() {
            juntar_archivos(&raiz, incluir_audio, Some(destino_ruta.as_path()))
        } else {
            Vec::new()
        };

        for nombre in ["datos.json", "config.json"] {
            let ruta = PathBuf::from(&carpeta_datos).join(nombre);
            if ruta.exists() {
                archivos.push((ruta, format!("datos/{nombre}")));
            }
        }

        if archivos.is_empty() {
            return Err("No hay nada para respaldar todavía.".into());
        }

        let total_archivos = archivos.len() as u64;
        let salida = File::create(&destino_ruta)
            .map_err(|e| format!("No se pudo crear {destino}: {e}"))?;
        let mut zip = ZipWriter::new(salida);

        let mut hechos: u64 = 0;
        let mut bytes: u64 = 0;

        for (ruta, interna) in archivos {
            // Comprimir un MP3 no sirve de nada y multiplica el tiempo: se
            // guarda tal cual y se reserva deflate para el texto.
            let metodo = if es_audio(&ruta) {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            };
            let opciones = SimpleFileOptions::default()
                .compression_method(metodo)
                .large_file(true);

            zip.start_file(&interna, opciones)
                .map_err(|e| format!("No se pudo agregar {interna}: {e}"))?;

            let archivo = File::open(&ruta)
                .map_err(|e| format!("No se pudo leer {}: {e}", ruta.display()))?;
            let mut lector = BufReader::new(archivo);
            let copiados = std::io::copy(&mut lector, &mut zip)
                .map_err(|e| format!("No se pudo copiar {}: {e}", ruta.display()))?;

            hechos += 1;
            bytes += copiados;
            let _ = app.emit(
                "respaldo://progreso",
                ProgresoRespaldo {
                    tarea: tarea.clone(),
                    archivos: hechos,
                    total_archivos,
                    bytes,
                },
            );
        }

        let mut final_zip = zip
            .finish()
            .map_err(|e| format!("No se pudo cerrar el zip: {e}"))?;
        final_zip
            .flush()
            .map_err(|e| format!("No se pudo terminar de escribir el zip: {e}"))?;

        Ok(destino)
    })
    .await
    .map_err(|e| format!("El respaldo falló: {e}"))?
}
