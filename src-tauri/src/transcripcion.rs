//! Ejecución de whisper.cpp como proceso externo.
//!
//! Corre en un hilo aparte y reporta progreso por eventos, así la interfaz no se
//! congela durante las horas que puede tardar una clase larga.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Evita que se abra una ventana de consola por cada transcripción.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// PIDs de las transcripciones en curso, para poder cancelarlas.
#[derive(Default, Clone)]
pub struct Procesos(Arc<Mutex<HashMap<String, u32>>>);

impl Procesos {
    fn registrar(&self, tarea: &str, pid: u32) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(tarea.to_string(), pid);
        }
    }

    fn olvidar(&self, tarea: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(tarea);
        }
    }

    fn pid_de(&self, tarea: &str) -> Option<u32> {
        self.0.lock().ok().and_then(|m| m.get(tarea).copied())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgresoTranscripcion {
    tarea: String,
    porcentaje: u8,
}

/// Lee el porcentaje de una línea tipo
/// "whisper_print_progress_callback: progress =  45%".
fn porcentaje_de(linea: &str) -> Option<u8> {
    let resto = linea.split("progress =").nth(1)?;
    resto
        .trim()
        .trim_end_matches('%')
        .trim()
        .parse::<u8>()
        .ok()
        .map(|p| p.min(100))
}

/// faster-whisper imprime otra cosa: " 55% | 33/60 | 00:10<<00:08 | 3.15 audio seconds/s".
/// El porcentaje es lo primero de la línea, antes de la primera barra vertical.
fn porcentaje_faster(linea: &str) -> Option<u8> {
    let cabeza = linea.split('|').next()?.trim();
    let numero = cabeza.strip_suffix('%')?;
    numero.trim().parse::<u8>().ok().map(|p| p.min(100))
}

#[tauri::command]
pub async fn transcribir(
    app: AppHandle,
    procesos: State<'_, Procesos>,
    tarea: String,
    binario: String,
    modelo: String,
    audio: String,
    salida_base: String,
    idioma: String,
    hilos: u32,
) -> Result<String, String> {
    let procesos = procesos.inner().clone();
    let salida_json = format!("{salida_base}.json");

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut comando = Command::new(&binario);
        comando
            .arg("-m")
            .arg(&modelo)
            .arg("-f")
            .arg(&audio)
            .arg("-l")
            .arg(&idioma)
            .arg("-t")
            .arg(hilos.to_string())
            // Imprime "progress = NN%" por stderr.
            .arg("-pp")
            // Salida JSON con los offsets en milisegundos de cada segmento.
            .arg("-oj")
            .arg("-of")
            .arg(&salida_base)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        comando.creation_flags(CREATE_NO_WINDOW);

        let mut hijo = comando
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar whisper-cli: {e}"))?;

        procesos.registrar(&tarea, hijo.id());

        let mut ultimas_lineas: Vec<String> = Vec::new();
        if let Some(stderr) = hijo.stderr.take() {
            for linea in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(pct) = porcentaje_de(&linea) {
                    let _ = app.emit(
                        "transcripcion://progreso",
                        ProgresoTranscripcion {
                            tarea: tarea.clone(),
                            porcentaje: pct,
                        },
                    );
                }
                // Guardamos la cola del log para poder explicar un fallo.
                ultimas_lineas.push(linea);
                if ultimas_lineas.len() > 40 {
                    ultimas_lineas.remove(0);
                }
            }
        }

        let estado = hijo
            .wait()
            .map_err(|e| format!("No se pudo esperar a whisper-cli: {e}"))?;
        procesos.olvidar(&tarea);

        if !estado.success() {
            return Err(format!(
                "whisper-cli terminó con código {}.\n{}",
                estado.code().unwrap_or(-1),
                ultimas_lineas.join("\n")
            ));
        }

        std::fs::read_to_string(&salida_json)
            .map_err(|e| format!("whisper terminó pero no se pudo leer {salida_json}: {e}"))
    })
    .await
    .map_err(|e| format!("La tarea de transcripción falló: {e}"))?
}

/// Transcribe con faster-whisper (build standalone de Purfview).
///
/// Dos diferencias con whisper.cpp que obligan a un comando aparte:
/// el progreso sale por **stdout** (no stderr) y la barra se refresca con `\r`
/// sin salto de línea, así que hay que cortar por ambos caracteres o el avance
/// llegaría todo junto recién al final.
#[tauri::command]
pub async fn transcribir_faster(
    app: AppHandle,
    procesos: State<'_, Procesos>,
    tarea: String,
    binario: String,
    modelo: String,
    carpeta_modelos: String,
    audio: String,
    salida_dir: String,
    salida_json: String,
    idioma: String,
    hilos: u32,
) -> Result<String, String> {
    let procesos = procesos.inner().clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut comando = Command::new(&binario);
        comando
            .arg(&audio)
            .arg("--model")
            .arg(&modelo)
            .arg("--model_dir")
            .arg(&carpeta_modelos)
            .arg("--device")
            .arg("cpu")
            // int8 recorta a la mitad la memoria y acelera bastante en CPU.
            .arg("--compute_type")
            .arg("int8")
            .arg("--output_format")
            .arg("json")
            .arg("--output_dir")
            .arg(&salida_dir)
            .arg("--threads")
            .arg(hilos.to_string())
            .arg("--print_progress")
            // Sin esto el ejecutable hace sonar un pitido al terminar.
            .arg("--beep_off")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // "auto" no es un idioma válido acá: se omite el flag y el modelo lo detecta.
        if idioma != "auto" && !idioma.is_empty() {
            comando.arg("--language").arg(&idioma);
        }

        #[cfg(target_os = "windows")]
        comando.creation_flags(CREATE_NO_WINDOW);

        let mut hijo = comando
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar whisper-faster: {e}"))?;

        procesos.registrar(&tarea, hijo.id());

        // stderr se drena en un hilo aparte: si nadie lo lee y se llena el buffer
        // del pipe, el proceso queda bloqueado escribiendo y no termina nunca.
        let stderr_hilo = hijo.stderr.take().map(|stderr| {
            std::thread::spawn(move || {
                let mut texto = String::new();
                let _ = BufReader::new(stderr).read_to_string(&mut texto);
                texto
            })
        });

        let mut ultimas_lineas: Vec<String> = Vec::new();
        if let Some(stdout) = hijo.stdout.take() {
            let mut lector = BufReader::new(stdout);
            let mut buffer = [0u8; 1024];
            let mut actual = String::new();

            loop {
                let leidos = match lector.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                for &byte in &buffer[..leidos] {
                    if byte == b'\r' || byte == b'\n' {
                        if !actual.trim().is_empty() {
                            if let Some(pct) = porcentaje_faster(&actual) {
                                let _ = app.emit(
                                    "transcripcion://progreso",
                                    ProgresoTranscripcion {
                                        tarea: tarea.clone(),
                                        porcentaje: pct,
                                    },
                                );
                            }
                            ultimas_lineas.push(actual.trim().to_string());
                            if ultimas_lineas.len() > 40 {
                                ultimas_lineas.remove(0);
                            }
                        }
                        actual.clear();
                    } else {
                        actual.push(byte as char);
                    }
                }
            }
        }

        let estado = hijo
            .wait()
            .map_err(|e| format!("No se pudo esperar a whisper-faster: {e}"))?;
        procesos.olvidar(&tarea);

        let error_estandar = stderr_hilo
            .and_then(|h| h.join().ok())
            .unwrap_or_default();

        if !estado.success() {
            return Err(format!(
                "whisper-faster terminó con código {}.\n{}\n{}",
                estado.code().unwrap_or(-1),
                ultimas_lineas.join("\n"),
                error_estandar
            ));
        }

        std::fs::read_to_string(&salida_json).map_err(|e| {
            format!("whisper-faster terminó pero no se pudo leer {salida_json}: {e}")
        })
    })
    .await
    .map_err(|e| format!("La tarea de transcripción falló: {e}"))?
}

#[tauri::command]
pub fn cancelar_transcripcion(procesos: State<'_, Procesos>, tarea: String) -> Result<(), String> {
    let Some(pid) = procesos.pid_de(&tarea) else {
        return Ok(());
    };

    // /T mata también los procesos hijos; whisper-cli no crea, pero cuesta poco.
    let mut comando = Command::new("taskkill");
    comando.args(["/F", "/T", "/PID", &pid.to_string()]);
    #[cfg(target_os = "windows")]
    comando.creation_flags(CREATE_NO_WINDOW);

    comando
        .output()
        .map_err(|e| format!("No se pudo cancelar: {e}"))?;
    procesos.olvidar(&tarea);
    Ok(())
}

/// Cuántos hilos conviene darle a whisper en esta máquina: los núcleos físicos,
/// dejando uno libre para que la app siga respondiendo.
#[tauri::command]
pub fn hilos_recomendados() -> u32 {
    let nucleos = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4);
    nucleos.saturating_sub(1).clamp(1, 8)
}
