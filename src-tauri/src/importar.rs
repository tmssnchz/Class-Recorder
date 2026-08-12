//! Importación de audios grabados con el celular, vía la carpeta local que
//! Google Drive Desktop ya sincroniza.
//!
//! No se usa la API de Drive ni OAuth: para la app esto es una carpeta más del
//! sistema de archivos. El usuario sube desde el teléfono, Drive Desktop
//! sincroniza, y acá solo se lee lo que ya bajó a disco.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

/// Extensiones de audio que suelen salir de un teléfono.
const EXTENSIONES_AUDIO: [&str; 10] = [
    "m4a", "mp3", "wav", "aac", "ogg", "opus", "3gp", "amr", "flac", "webm",
];

/// Nombre fijo de la carpeta que la app crea dentro del Drive del usuario.
pub const NOMBRE_INBOX: &str = "ClassRecorder_Inbox";
/// Subcarpeta donde se archiva lo ya importado, para no reprocesarlo.
pub const NOMBRE_IMPORTADOS: &str = "importados";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoDrive {
    /// true si se encontró la instalación de Google Drive Desktop.
    pub instalado: bool,
    /// Carpetas que parecen ser la raíz sincronizada, para ofrecerlas primero.
    pub candidatas: Vec<String>,
}

fn es_audio(ruta: &Path) -> bool {
    ruta.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONES_AUDIO.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Busca Google Drive Desktop por sus rutas de instalación típicas y propone
/// las carpetas que suelen ser la raíz sincronizada.
#[tauri::command]
pub fn detectar_drive() -> InfoDrive {
    let instalado = [
        r"C:\Program Files\Google\Drive File Stream",
        r"C:\Program Files (x86)\Google\Drive File Stream",
    ]
    .iter()
    .any(|p| Path::new(p).exists());

    let mut candidatas = Vec::new();

    // Instalación clásica: una carpeta dentro del perfil del usuario.
    if let Ok(perfil) = std::env::var("USERPROFILE") {
        for nombre in ["Google Drive", "Mi unidad", "My Drive"] {
            let ruta = PathBuf::from(&perfil).join(nombre);
            if ruta.exists() {
                candidatas.push(ruta.to_string_lossy().to_string());
            }
        }
    }

    // Instalación como unidad virtual: Drive monta una letra propia y adentro
    // deja "Mi unidad" (o "My Drive" según el idioma).
    for letra in 'D'..='Z' {
        for nombre in ["Mi unidad", "My Drive"] {
            let ruta = PathBuf::from(format!("{letra}:\\")).join(nombre);
            if ruta.exists() {
                candidatas.push(ruta.to_string_lossy().to_string());
            }
        }
    }

    InfoDrive {
        instalado: instalado || !candidatas.is_empty(),
        candidatas,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivoInbox {
    pub nombre: String,
    pub ruta: String,
    pub bytes: u64,
    /// Milisegundos desde epoch: la hora en que el archivo llegó a la carpeta.
    /// Es la señal de último recurso para estimar cuándo se grabó.
    pub llegada_ms: u64,
    /// false si el tamaño cambió durante la comprobación: Drive sigue bajándolo.
    pub estable: bool,
}

fn milisegundos_de(ruta: &Path) -> u64 {
    std::fs::metadata(ruta)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lista los audios del Inbox una sola vez.
///
/// Un archivo que Drive todavía está bajando crece entre lectura y lectura, así
/// que se miden los tamaños dos veces con una pausa en el medio y se marca como
/// inestable el que haya cambiado. La pausa es una sola para todo el lote.
#[tauri::command]
pub async fn escanear_inbox(carpeta: String) -> Result<Vec<ArchivoInbox>, String> {
    let dir = PathBuf::from(&carpeta);
    if !dir.exists() {
        return Err(format!("La carpeta {carpeta} no existe."));
    }

    let mut candidatos: Vec<(PathBuf, u64)> = Vec::new();
    let entradas =
        std::fs::read_dir(&dir).map_err(|e| format!("No se pudo leer {carpeta}: {e}"))?;

    for entrada in entradas.flatten() {
        let ruta = entrada.path();
        if ruta.is_dir() || !es_audio(&ruta) {
            continue;
        }
        let bytes = entrada.metadata().map(|m| m.len()).unwrap_or(0);
        candidatos.push((ruta, bytes));
    }

    if candidatos.is_empty() {
        return Ok(Vec::new());
    }

    tokio::time::sleep(Duration::from_millis(800)).await;

    Ok(candidatos
        .into_iter()
        .map(|(ruta, bytes_antes)| {
            let bytes_ahora = std::fs::metadata(&ruta).map(|m| m.len()).unwrap_or(0);
            ArchivoInbox {
                nombre: ruta
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default(),
                ruta: ruta.to_string_lossy().to_string(),
                bytes: bytes_ahora,
                llegada_ms: milisegundos_de(&ruta),
                // Un archivo de 0 bytes es un marcador de Drive, no un audio.
                estable: bytes_ahora == bytes_antes && bytes_ahora > 0,
            }
        })
        .collect())
}

/// Archiva en `Inbox/importados/` un archivo ya procesado, para que la próxima
/// sincronización no lo vuelva a ver. Devuelve la ruta nueva.
#[tauri::command]
pub fn archivar_importado(ruta: String, carpeta_inbox: String) -> Result<String, String> {
    let origen = PathBuf::from(&ruta);
    let destino_dir = PathBuf::from(&carpeta_inbox).join(NOMBRE_IMPORTADOS);
    std::fs::create_dir_all(&destino_dir)
        .map_err(|e| format!("No se pudo crear {}: {e}", destino_dir.display()))?;

    let nombre = origen
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "Ruta de archivo inválida.".to_string())?;

    // Si ya hay uno con ese nombre archivado, se numera para no pisarlo.
    let (base, ext) = match nombre.rsplit_once('.') {
        Some((b, e)) => (b.to_string(), format!(".{e}")),
        None => (nombre.clone(), String::new()),
    };
    let mut destino = destino_dir.join(&nombre);
    let mut intento = 2;
    while destino.exists() {
        destino = destino_dir.join(format!("{base}_{intento}{ext}"));
        intento += 1;
    }

    // rename falla si Drive tiene el archivo en otro volumen: ahí se copia.
    if std::fs::rename(&origen, &destino).is_err() {
        std::fs::copy(&origen, &destino)
            .map_err(|e| format!("No se pudo archivar {nombre}: {e}"))?;
        std::fs::remove_file(&origen)
            .map_err(|e| format!("Se copió {nombre} pero no se pudo quitar del Inbox: {e}"))?;
    }

    Ok(destino.to_string_lossy().to_string())
}

/// Crea `ClassRecorder_Inbox` dentro de la raíz de Drive elegida y devuelve su ruta.
#[tauri::command]
pub fn preparar_inbox(raiz_drive: String) -> Result<String, String> {
    let raiz = PathBuf::from(&raiz_drive);
    if !raiz.exists() {
        return Err(format!("La carpeta {raiz_drive} no existe."));
    }
    let inbox = raiz.join(NOMBRE_INBOX);
    std::fs::create_dir_all(&inbox)
        .map_err(|e| format!("No se pudo crear {}: {e}", inbox.display()))?;
    Ok(inbox.to_string_lossy().to_string())
}
