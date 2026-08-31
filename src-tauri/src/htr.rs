//! Reconocimiento de texto manuscrito (HTR) con un modelo local.
//!
//! Sigue el mismo patrón que la transcripción de audio: un ejecutable que se
//! descarga aparte (acá `llama-mtmd-cli.exe`, de los releases de llama.cpp) y
//! se corre como proceso externo, sin bloquear la interfaz y con el PID
//! registrado para poder cancelarlo. Por eso reusa `transcripcion::Procesos`
//! en vez de tener su propio registro: cancelar es lo mismo en los dos casos.
//!
//! El modelo es un VLM en GGUF (por defecto GLM-OCR). A diferencia de whisper,
//! no imprime porcentaje de avance: informa etapas, que es lo único honesto
//! que se puede mostrar.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::transcripcion::Procesos;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgresoHtr {
    tarea: String,
    /// "cargando" | "leyendo" | "listo"
    etapa: String,
}

fn avisar(app: &AppHandle, tarea: &str, etapa: &str) {
    let _ = app.emit(
        "htr://progreso",
        ProgresoHtr {
            tarea: tarea.to_string(),
            etapa: etapa.to_string(),
        },
    );
}

/// Instrucción que se le da al modelo.
///
/// Los diagramas se marcan en vez de transcribirse: reconocer formas dibujadas
/// a mano es otro problema entero, y forzar al modelo a describir un esquema
/// termina inventando texto que el usuario después cree que estaba en la hoja.
/// Marcarlo deja la imagen como fuente de verdad de esa parte.
pub fn prompt_para(idioma: &str) -> String {
    let nombre = nombre_idioma(idioma);
    format!(
        "Transcribe literalmente el texto manuscrito de esta hoja. \
El idioma principal es {nombre}, pero respeta las palabras que estén en otro idioma \
tal como aparecen escritas. \
Devuelve únicamente el texto, conservando los saltos de línea, los títulos y las viñetas. \
Donde haya un diagrama, un esquema, un gráfico o un dibujo, escribe en su lugar una línea \
que diga [diagrama] y sigue con el texto. \
Si una palabra es ilegible, escríbela como [?]. \
No agregues comentarios, explicaciones ni texto que no esté escrito en la hoja."
    )
}

fn nombre_idioma(codigo: &str) -> &str {
    match codigo {
        "es" => "español",
        "en" => "inglés",
        "pt" => "portugués",
        "fr" => "francés",
        "it" => "italiano",
        "de" => "alemán",
        "la" => "latín",
        _ => "español",
    }
}

/// Líneas que llama.cpp escribe por stdout y que no son parte de la respuesta.
fn es_ruido(linea: &str) -> bool {
    let l = linea.trim();
    l.is_empty()
        || l.starts_with("build:")
        || l.starts_with("main:")
        || l.starts_with("llama_")
        || l.starts_with("load_")
        || l.starts_with("print_info:")
        || l.starts_with("mtmd_")
        || l.starts_with("clip_")
        || l.starts_with("encoding image")
        || l.starts_with("image decoded")
        || l.starts_with("ggml_")
}

/// Lado largo, en píxeles, al que se reduce la imagen antes de pasársela al
/// modelo.
///
/// Está medido, no elegido a ojo: la misma hoja a 1969 px de alto tarda 5 min
/// en CPU y a 1181 px tarda 1 min 21 s, con el mismo texto reconocido. El
/// escaneo completo se guarda igual en alta resolución — esta copia reducida
/// existe solo para el reconocimiento y se borra al terminar.
pub const LADO_HTR_PX: u32 = 1400;

/// Deja en un archivo temporal una copia reducida de la imagen. Devuelve la
/// ruta original si ya era chica o si algo falla: reconocer sobre la grande es
/// lento, pero es mejor que no reconocer nada.
fn copia_reducida(imagen: &str) -> Option<PathBuf> {
    let img = image::open(imagen).ok()?;
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= LADO_HTR_PX {
        return None;
    }
    let escala = LADO_HTR_PX as f32 / w.max(h) as f32;
    let reducida = img.resize(
        (w as f32 * escala).round() as u32,
        (h as f32 * escala).round() as u32,
        image::imageops::FilterType::Lanczos3,
    );
    let destino = Path::new(imagen).with_extension("htr.jpg");
    reducida.save(&destino).ok()?;
    Some(destino)
}

#[tauri::command]
pub async fn reconocer_texto_local(
    app: AppHandle,
    procesos: State<'_, Procesos>,
    tarea: String,
    binario: String,
    modelo: String,
    mmproj: String,
    imagen: String,
    idioma: String,
    hilos: u32,
) -> Result<String, String> {
    let procesos = procesos.inner().clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        avisar(&app, &tarea, "cargando");

        let reducida = copia_reducida(&imagen);
        let entrada = reducida
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| imagen.clone());

        let mut comando = Command::new(&binario);
        comando
            .arg("-m")
            .arg(&modelo)
            .arg("--mmproj")
            .arg(&mmproj)
            .arg("--image")
            .arg(&entrada)
            .arg("-p")
            .arg(prompt_para(&idioma))
            .arg("-t")
            .arg(hilos.to_string())
            // Una hoja escrita a mano puede dar bastante texto; el contexto por
            // defecto del modelo se queda corto y corta la salida a la mitad.
            .arg("-c")
            .arg("8192")
            // Temperatura baja: acá no se quiere creatividad, se quiere copiar.
            .arg("--temp")
            .arg("0.1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        comando.creation_flags(CREATE_NO_WINDOW);

        let mut hijo = comando
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar llama-mtmd-cli: {e}"))?;

        procesos.registrar(&tarea, hijo.id());

        // stderr se drena en un hilo aparte: si nadie lo lee y se llena el
        // buffer del pipe, el proceso queda bloqueado escribiendo.
        let stderr_hilo = hijo.stderr.take().map(|stderr| {
            std::thread::spawn(move || {
                let mut texto = String::new();
                let _ = BufReader::new(stderr).read_to_string(&mut texto);
                texto
            })
        });

        avisar(&app, &tarea, "leyendo");

        let mut lineas: Vec<String> = Vec::new();
        if let Some(stdout) = hijo.stdout.take() {
            for linea in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !es_ruido(&linea) {
                    lineas.push(linea);
                }
            }
        }

        let estado = hijo
            .wait()
            .map_err(|e| format!("No se pudo esperar a llama-mtmd-cli: {e}"))?;
        procesos.olvidar(&tarea);

        let log = stderr_hilo.and_then(|h| h.join().ok()).unwrap_or_default();
        if let Some(temporal) = &reducida {
            let _ = std::fs::remove_file(temporal);
        }

        if !estado.success() {
            let cola: Vec<&str> = log.lines().rev().take(20).collect();
            return Err(format!(
                "El reconocimiento terminó con código {}.\n{}",
                estado.code().unwrap_or(-1),
                cola.into_iter().rev().collect::<Vec<_>>().join("\n")
            ));
        }

        avisar(&app, &tarea, "listo");
        Ok(lineas.join("\n").trim().to_string())
    })
    .await
    .map_err(|e| format!("La tarea de reconocimiento falló: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_prompt_nombra_el_idioma_y_pide_marcar_diagramas() {
        let p = prompt_para("es");
        assert!(p.contains("español"));
        assert!(p.contains("[diagrama]"));
        assert!(prompt_para("en").contains("inglés"));
        // Un código desconocido no rompe: cae en español, que es el caso normal.
        assert!(prompt_para("zz").contains("español"));
    }

    #[test]
    fn el_ruido_del_log_no_entra_en_el_texto_reconocido() {
        assert!(es_ruido("llama_model_loader: loaded meta data"));
        assert!(es_ruido("main: loading model"));
        assert!(es_ruido("encoding image or slice..."));
        assert!(es_ruido("   "));
        assert!(!es_ruido("Derecho Civil - Unidad 3"));
        assert!(!es_ruido("[diagrama]"));
    }
}
