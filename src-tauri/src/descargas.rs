//! Descarga del motor de transcripción y de los modelos.
//!
//! Es la única parte de la app que usa internet. Una vez descargados, whisper y
//! sus modelos quedan en `%APPDATA%\com.tomas.classrecorder\whisper` y todo
//! funciona sin conexión.

use std::io::Read;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

/// Archivos del zip de whisper.cpp que realmente hacen falta para transcribir.
/// El resto del paquete son demos (stream, talk-llama, tests) y SDL2.
fn hace_falta(nombre: &str) -> bool {
    nombre.ends_with("whisper-cli.exe")
        || nombre.ends_with("whisper.dll")
        || nombre.ends_with("ggml.dll")
        || nombre.ends_with("ggml-base.dll")
        // Variantes de CPU: whisper elige en tiempo de ejecución la mejor
        // para el procesador de la máquina.
        || nombre.contains("ggml-cpu-")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgresoDescarga {
    tarea: String,
    bytes: u64,
    total: u64,
    /// "descargando" | "extrayendo" | "listo"
    etapa: String,
}

fn avisar(app: &AppHandle, tarea: &str, bytes: u64, total: u64, etapa: &str) {
    let _ = app.emit(
        "descarga://progreso",
        ProgresoDescarga {
            tarea: tarea.to_string(),
            bytes,
            total,
            etapa: etapa.to_string(),
        },
    );
}

async fn bajar_a_disco(
    app: &AppHandle,
    url: &str,
    destino: &Path,
    tarea: &str,
) -> Result<(), String> {
    if let Some(padre) = destino.parent() {
        tokio::fs::create_dir_all(padre)
            .await
            .map_err(|e| format!("No se pudo crear {}: {e}", padre.display()))?;
    }

    let respuesta = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar: {e}"))?;

    if !respuesta.status().is_success() {
        return Err(format!(
            "El servidor respondió {} al pedir {url}",
            respuesta.status()
        ));
    }

    let total = respuesta.content_length().unwrap_or(0);

    // Se baja a .parcial y se renombra al final: así un corte de conexión no
    // deja un archivo incompleto que parezca válido.
    let parcial = destino.with_extension("parcial");
    let mut archivo = tokio::fs::File::create(&parcial)
        .await
        .map_err(|e| format!("No se pudo crear {}: {e}", parcial.display()))?;

    let mut flujo = respuesta.bytes_stream();
    let mut bajados: u64 = 0;
    let mut ultimo_aviso: u64 = 0;

    while let Some(trozo) = flujo.next().await {
        let trozo = trozo.map_err(|e| format!("Se cortó la descarga: {e}"))?;
        archivo
            .write_all(&trozo)
            .await
            .map_err(|e| format!("No se pudo escribir en disco: {e}"))?;
        bajados += trozo.len() as u64;

        // Avisamos cada 512 KB: emitir por cada trozo satura el canal de eventos.
        if bajados - ultimo_aviso > 512 * 1024 {
            ultimo_aviso = bajados;
            avisar(app, tarea, bajados, total, "descargando");
        }
    }

    archivo
        .flush()
        .await
        .map_err(|e| format!("No se pudo cerrar el archivo: {e}"))?;
    drop(archivo);

    if destino.exists() {
        let _ = tokio::fs::remove_file(destino).await;
    }
    tokio::fs::rename(&parcial, destino)
        .await
        .map_err(|e| format!("No se pudo mover el archivo descargado: {e}"))?;

    avisar(app, tarea, bajados, total, "descargando");
    Ok(())
}

/// Descarga un modelo GGML de Hugging Face.
#[tauri::command]
pub async fn descargar_modelo(
    app: AppHandle,
    url: String,
    destino: String,
    tarea: String,
) -> Result<(), String> {
    bajar_a_disco(&app, &url, Path::new(&destino), &tarea).await?;
    avisar(&app, &tarea, 0, 0, "listo");
    Ok(())
}

/// Descarga un modelo CTranslate2 (faster-whisper), que son varios archivos
/// sueltos dentro de una carpeta en vez de un único .bin.
///
/// Se baja a una carpeta `.descargando` y recién al final se renombra: así, un
/// corte de conexión no deja una carpeta a medias que parezca un modelo válido
/// y haga fallar la transcripción con un error incomprensible.
#[tauri::command]
pub async fn descargar_modelo_faster(
    app: AppHandle,
    urls: Vec<String>,
    nombres: Vec<String>,
    carpeta_destino: String,
    tarea: String,
) -> Result<(), String> {
    if urls.len() != nombres.len() {
        return Err("La lista de archivos del modelo está mal formada.".into());
    }

    let destino = PathBuf::from(&carpeta_destino);
    let temporal = destino.with_extension("descargando");

    if temporal.exists() {
        let _ = tokio::fs::remove_dir_all(&temporal).await;
    }
    tokio::fs::create_dir_all(&temporal)
        .await
        .map_err(|e| format!("No se pudo crear {}: {e}", temporal.display()))?;

    for (url, nombre) in urls.iter().zip(nombres.iter()) {
        bajar_a_disco(&app, url, &temporal.join(nombre), &tarea).await?;
    }

    if destino.exists() {
        let _ = tokio::fs::remove_dir_all(&destino).await;
    }
    tokio::fs::rename(&temporal, &destino)
        .await
        .map_err(|e| format!("No se pudo publicar el modelo descargado: {e}"))?;

    avisar(&app, &tarea, 0, 0, "listo");
    Ok(())
}

/// Descarga el zip de faster-whisper standalone y deja `whisper-faster.exe`
/// suelto en `carpeta`. El paquete trae un único ejecutable dentro de una
/// subcarpeta `Whisper-Faster\`, más un license.txt que no hace falta.
#[tauri::command]
pub async fn instalar_faster_whisper(
    app: AppHandle,
    url: String,
    carpeta: String,
    tarea: String,
) -> Result<String, String> {
    let carpeta = PathBuf::from(carpeta);
    let zip = carpeta.join("faster-whisper.zip");

    bajar_a_disco(&app, &url, &zip, &tarea).await?;
    avisar(&app, &tarea, 0, 0, "extrayendo");

    let destino = carpeta.clone();
    let zip_para_hilo = zip.clone();

    let ruta_exe = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let archivo = std::fs::File::open(&zip_para_hilo)
            .map_err(|e| format!("No se pudo abrir el zip: {e}"))?;
        let mut paquete = zip::ZipArchive::new(archivo)
            .map_err(|e| format!("El zip está dañado: {e}"))?;

        let mut exe = String::new();
        for i in 0..paquete.len() {
            let mut entrada = paquete
                .by_index(i)
                .map_err(|e| format!("No se pudo leer el zip: {e}"))?;
            if entrada.is_dir() {
                continue;
            }
            let nombre = entrada.name().to_string();
            if !nombre.ends_with("whisper-faster.exe") {
                continue;
            }
            let salida = destino.join("whisper-faster.exe");
            let mut datos = Vec::with_capacity(entrada.size() as usize);
            entrada
                .read_to_end(&mut datos)
                .map_err(|e| format!("No se pudo extraer el ejecutable: {e}"))?;
            std::fs::write(&salida, &datos)
                .map_err(|e| format!("No se pudo escribir el ejecutable: {e}"))?;
            exe = salida.to_string_lossy().to_string();
            break;
        }

        if exe.is_empty() {
            return Err(
                "El paquete descargado no contiene whisper-faster.exe. ¿Cambió el release?"
                    .to_string(),
            );
        }
        Ok(exe)
    })
    .await
    .map_err(|e| format!("Falló la extracción: {e}"))??;

    let _ = tokio::fs::remove_file(&zip).await;
    avisar(&app, &tarea, 0, 0, "listo");
    Ok(ruta_exe)
}

/// Descarga el zip de whisper.cpp y deja solo los archivos necesarios en `carpeta`.
#[tauri::command]
pub async fn instalar_whisper(
    app: AppHandle,
    url: String,
    carpeta: String,
    tarea: String,
) -> Result<String, String> {
    let carpeta = PathBuf::from(carpeta);
    let zip = carpeta.join("whisper-bin.zip");

    bajar_a_disco(&app, &url, &zip, &tarea).await?;
    avisar(&app, &tarea, 0, 0, "extrayendo");

    let destino = carpeta.clone();
    let zip_para_hilo = zip.clone();

    // La extracción es sincrónica y bloquea: va a un hilo aparte.
    let ruta_cli = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let archivo = std::fs::File::open(&zip_para_hilo)
            .map_err(|e| format!("No se pudo abrir el zip: {e}"))?;
        let mut paquete = zip::ZipArchive::new(archivo)
            .map_err(|e| format!("El zip está dañado: {e}"))?;

        let mut cli = String::new();
        for i in 0..paquete.len() {
            let mut entrada = paquete
                .by_index(i)
                .map_err(|e| format!("No se pudo leer el zip: {e}"))?;
            if entrada.is_dir() {
                continue;
            }
            let nombre = entrada.name().to_string();
            if !hace_falta(&nombre) {
                continue;
            }
            // Aplanamos: todo va suelto en la carpeta, sin el "Release/" del zip.
            let solo_nombre = nombre.rsplit('/').next().unwrap_or(&nombre).to_string();
            let salida = destino.join(&solo_nombre);

            let mut datos = Vec::with_capacity(entrada.size() as usize);
            entrada
                .read_to_end(&mut datos)
                .map_err(|e| format!("No se pudo extraer {solo_nombre}: {e}"))?;
            std::fs::write(&salida, &datos)
                .map_err(|e| format!("No se pudo escribir {solo_nombre}: {e}"))?;

            if solo_nombre == "whisper-cli.exe" {
                cli = salida.to_string_lossy().to_string();
            }
        }

        if cli.is_empty() {
            return Err(
                "El paquete descargado no contiene whisper-cli.exe. ¿Cambió el formato del release?"
                    .to_string(),
            );
        }
        Ok(cli)
    })
    .await
    .map_err(|e| format!("Falló la extracción: {e}"))??;

    let _ = tokio::fs::remove_file(&zip).await;
    avisar(&app, &tarea, 0, 0, "listo");
    Ok(ruta_cli)
}
