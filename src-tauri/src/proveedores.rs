//! Proveedores de transcripción por API, intercambiables detrás de un trait.
//!
//! Cada llamada transcribe **un trozo** de audio corto (el troceo, el solape y
//! el reajuste de tiempos viven en `src/lib/troceo.ts`). Acá solo se habla con
//! el proveedor, se clasifican los errores y se reintenta ante 429 y 5xx.
//!
//! Proveedores:
//!   - `OpenRouter`: el activo. `openai/whisper-large-v3-turbo` por
//!     `POST /api/v1/audio/transcriptions` (JSON con el audio en base64).
//!   - `Groq`: multipart estilo OpenAI. Deshabilitado (`GROQ_HABILITADO`).
//!   - `LocalWhisper`: espacio reservado para whisper.cpp; sin implementar.
//!
//! La clave llega cifrada (DPAPI) y se descifra acá; nunca se loguea ni se
//! incluye en un mensaje de error.

use std::time::{Duration, Instant};

use serde::Serialize;

/// Cambiar a `true` para reactivar Groq. Sigue sin aparecer en la UI de alta de
/// perfiles mientras `deshabilitado` esté marcado en `PROVEEDORES_API` (modelos.ts).
const GROQ_HABILITADO: bool = false;

const URL_OPENROUTER: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const URL_GROQ: &str = "https://api.groq.com/openai/v1/audio/transcriptions";

/// Un trozo pesa ~1 MB (5 min a 24 kbps); esto es solo la red de seguridad
/// frente al tope de 25 MB del endpoint, con margen.
const LIMITE_BYTES_TROZO: u64 = 20 * 1024 * 1024;

/// OpenRouter corta cada request a los 60 s; el cliente espera un poco más para
/// ver su error en vez de cortar antes.
const TIMEOUT_CLIENTE: Duration = Duration::from_secs(90);

const REINTENTOS: u32 = 3;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Codigo {
    ClaveInvalida,
    SinSaldo,
    LimiteTasa,
    SinRed,
    Deshabilitado,
    NoImplementado,
    Otro,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ErrorTranscripcion {
    pub codigo: Codigo,
    pub mensaje: String,
    /// 429, 5xx y fallos de conexión: vale la pena repetir la llamada.
    pub reintentable: bool,
}

impl ErrorTranscripcion {
    fn nuevo(codigo: Codigo, mensaje: impl Into<String>, reintentable: bool) -> Self {
        Self { codigo, mensaje: mensaje.into(), reintentable }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SegmentoApi {
    pub inicio_s: f64,
    pub fin_s: f64,
    pub texto: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RespuestaTrozo {
    pub texto: String,
    /// Vacío si el proveedor no devolvió `segments` con tiempos: quien llama
    /// cae a un solo segmento por trozo y avisa en la UI.
    pub segmentos: Vec<SegmentoApi>,
    /// Lo que tardó la llamada (sin contar reintentos previos fallidos).
    pub ms_respuesta: u64,
}

pub struct Peticion {
    pub audio: Vec<u8>,
    /// Extensión sin punto: "mp3" o "wav".
    pub formato: &'static str,
    pub modelo: String,
    /// Código ISO-639-1, o "auto"/vacío para autodetectar.
    pub idioma: String,
    /// Contexto (vocabulario, nombre del ramo) para orientar a Whisper.
    /// NO FUNCIONA hoy con OpenRouter: la documentación dice que `prompt` se
    /// acepta pero se ignora, y el modo JSON ni lo lista. Se recibe y se pasa
    /// hasta acá para que, si el endpoint lo empieza a respetar, baste con
    /// mandarlo en `OpenRouter::transcribir`.
    #[allow(dead_code)]
    pub prompt: Option<String>,
}

#[allow(async_fn_in_trait)]
pub trait TranscriptionProvider {
    /// Una sola llamada, sin reintentos (ver `con_reintentos`).
    async fn transcribir(
        &self,
        clave: &str,
        peticion: &Peticion,
    ) -> Result<RespuestaTrozo, ErrorTranscripcion>;
}

// ------------------------------------------------------------------ comunes

fn cliente() -> Result<reqwest::Client, ErrorTranscripcion> {
    reqwest::Client::builder()
        .timeout(TIMEOUT_CLIENTE)
        .build()
        .map_err(|e| ErrorTranscripcion::nuevo(Codigo::Otro, format!("No se pudo preparar el cliente HTTP: {e}"), false))
}

/// `reqwest::Error` puede traer la URL pero nunca los headers: no filtra la clave.
fn error_de_red(nombre: &str, e: reqwest::Error) -> ErrorTranscripcion {
    if e.is_timeout() {
        return ErrorTranscripcion::nuevo(
            Codigo::Otro,
            format!("{nombre} tardó demasiado en responder (más de 90 s)."),
            true,
        );
    }
    ErrorTranscripcion::nuevo(
        Codigo::SinRed,
        format!("No se pudo conectar con {nombre}. Revisa tu conexión a internet."),
        true,
    )
}

/// Saca `error.message` del cuerpo `{"error":{"code","message"}}` si viene, más
/// `error.metadata` (en OpenRouter trae el proveedor y su error original, que es
/// lo único que distingue un "Provider returned 400" de otro).
fn detalle_de(cuerpo: &str) -> String {
    let json: serde_json::Value = serde_json::from_str(cuerpo).unwrap_or_default();
    let mut texto = json["error"]["message"].as_str().unwrap_or(cuerpo).to_string();
    if !json["error"]["metadata"].is_null() {
        texto = format!("{texto} {}", json["error"]["metadata"]);
    }
    texto.chars().take(500).collect()
}

fn error_de_estado(nombre: &str, estado: u16, cuerpo: &str) -> ErrorTranscripcion {
    use Codigo::*;
    match estado {
        401 => ErrorTranscripcion::nuevo(
            ClaveInvalida,
            format!("La clave de {nombre} no es válida o fue revocada."),
            false,
        ),
        // OpenRouter documenta 402 y 403 para límites de crédito o gasto.
        402 | 403 => ErrorTranscripcion::nuevo(
            SinSaldo,
            format!("{nombre} rechazó la solicitud: sin saldo, o la clave alcanzó su límite de gasto."),
            false,
        ),
        429 => ErrorTranscripcion::nuevo(
            LimiteTasa,
            format!("{nombre} limitó la velocidad de las solicitudes. Espera unos minutos."),
            true,
        ),
        500..=599 => ErrorTranscripcion::nuevo(
            Otro,
            format!("{nombre} tuvo un error temporal ({estado}): {}", detalle_de(cuerpo)),
            true,
        ),
        // Cualquier otro error (400 incluido): además del mensaje, el cuerpo
        // crudo, porque "Provider returned 400" solo no permite diagnosticar.
        _ => ErrorTranscripcion::nuevo(
            Otro,
            format!(
                "{nombre} respondió {estado}: {} | cuerpo: {}",
                detalle_de(cuerpo),
                cuerpo.chars().take(400).collect::<String>()
            ),
            false,
        ),
    }
}

/// Respuesta `verbose_json`: `text` siempre, `segments[start,end,text]` según
/// el proveedor que OpenRouter haya elegido para servir el modelo.
fn parsear_verbose(cuerpo: &str, ms_respuesta: u64) -> Result<RespuestaTrozo, ErrorTranscripcion> {
    let json: serde_json::Value = serde_json::from_str(cuerpo).map_err(|_| {
        ErrorTranscripcion::nuevo(Codigo::Otro, "La API devolvió una respuesta que no es JSON.", false)
    })?;
    let segmentos = json["segments"]
        .as_array()
        .map(|lista| {
            lista
                .iter()
                .filter_map(|s| {
                    Some(SegmentoApi {
                        inicio_s: s["start"].as_f64()?,
                        fin_s: s["end"].as_f64()?,
                        texto: s["text"].as_str()?.trim().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(RespuestaTrozo {
        texto: json["text"].as_str().unwrap_or_default().trim().to_string(),
        segmentos,
        ms_respuesta,
    })
}

// --------------------------------------------------------------- OpenRouter

pub struct OpenRouter;

impl TranscriptionProvider for OpenRouter {
    async fn transcribir(
        &self,
        clave: &str,
        p: &Peticion,
    ) -> Result<RespuestaTrozo, ErrorTranscripcion> {
        let mut cuerpo = serde_json::json!({
            "model": p.modelo,
            "input_audio": { "data": crate::escaneo::base64(&p.audio), "format": p.formato },
            "response_format": "verbose_json",
            "timestamp_granularities": ["segment"],
        });
        if p.idioma != "auto" && !p.idioma.is_empty() {
            cuerpo["language"] = p.idioma.clone().into();
        }
        // `p.prompt` no se manda a propósito: ver el comentario en `Peticion`.

        let inicio = Instant::now();
        let respuesta = cliente()?
            .post(URL_OPENROUTER)
            .bearer_auth(clave)
            .json(&cuerpo)
            .send()
            .await
            .map_err(|e| error_de_red("OpenRouter", e))?;
        let estado = respuesta.status().as_u16();
        let texto = respuesta.text().await.map_err(|e| error_de_red("OpenRouter", e))?;
        if estado != 200 {
            return Err(error_de_estado("OpenRouter", estado, &texto));
        }
        parsear_verbose(&texto, inicio.elapsed().as_millis() as u64)
    }
}

// --------------------------------------------------------------------- Groq

pub struct Groq;

impl TranscriptionProvider for Groq {
    async fn transcribir(
        &self,
        clave: &str,
        p: &Peticion,
    ) -> Result<RespuestaTrozo, ErrorTranscripcion> {
        if !GROQ_HABILITADO {
            return Err(ErrorTranscripcion::nuevo(
                Codigo::Deshabilitado,
                "Groq está deshabilitado en esta versión. Usa un perfil de OpenRouter.",
                false,
            ));
        }
        let mime = if p.formato == "wav" { "audio/wav" } else { "audio/mpeg" };
        let parte = reqwest::multipart::Part::bytes(p.audio.clone())
            // El proveedor deduce el formato por la extensión del nombre.
            .file_name(format!("audio.{}", p.formato))
            .mime_str(mime)
            .map_err(|e| ErrorTranscripcion::nuevo(Codigo::Otro, format!("Error armando el pedido: {e}"), false))?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", parte)
            .text("model", p.modelo.clone())
            .text("response_format", "verbose_json");
        if p.idioma != "auto" && !p.idioma.is_empty() {
            form = form.text("language", p.idioma.clone());
        }
        if let Some(prompt) = p.prompt.as_ref().filter(|t| !t.is_empty()) {
            form = form.text("prompt", prompt.clone()); // Groq sí lo respeta.
        }

        let inicio = Instant::now();
        let respuesta = cliente()?
            .post(URL_GROQ)
            .bearer_auth(clave)
            .multipart(form)
            .send()
            .await
            .map_err(|e| error_de_red("Groq", e))?;
        let estado = respuesta.status().as_u16();
        let texto = respuesta.text().await.map_err(|e| error_de_red("Groq", e))?;
        if estado != 200 {
            return Err(error_de_estado("Groq", estado, &texto));
        }
        parsear_verbose(&texto, inicio.elapsed().as_millis() as u64)
    }
}

// ------------------------------------------------------------- LocalWhisper

/// Reservado para whisper.cpp detrás de este mismo trait. Hoy el motor local
/// corre por el camino de `transcripcion.rs`, que transcribe la grabación
/// entera y no por trozos; integrarlo acá queda para más adelante.
pub struct LocalWhisper;

impl TranscriptionProvider for LocalWhisper {
    async fn transcribir(&self, _clave: &str, _p: &Peticion) -> Result<RespuestaTrozo, ErrorTranscripcion> {
        Err(ErrorTranscripcion::nuevo(
            Codigo::NoImplementado,
            "LocalWhisperProvider todavía no está implementado.",
            false,
        ))
    }
}

// ---------------------------------------------------------- reintentos + cmd

/// 1 s, 2 s, 4 s entre intentos.
// ponytail: no respeta `Retry-After`; leerlo si los 429 siguen apareciendo.
async fn con_reintentos<P: TranscriptionProvider>(
    proveedor: &P,
    clave: &str,
    peticion: &Peticion,
) -> Result<RespuestaTrozo, ErrorTranscripcion> {
    let mut intento = 0;
    loop {
        match proveedor.transcribir(clave, peticion).await {
            Err(e) if e.reintentable && intento < REINTENTOS => {
                tokio::time::sleep(Duration::from_secs(1 << intento)).await;
                intento += 1;
            }
            otro => return otro,
        }
    }
}

/// Transcribe un trozo con el proveedor que indique la configuración de la app.
#[tauri::command]
pub async fn transcribir_trozo(
    proveedor: String,
    clave_cifrada: String,
    audio: String,
    modelo: String,
    idioma: String,
    prompt: Option<String>,
) -> Result<RespuestaTrozo, ErrorTranscripcion> {
    let otro = |m: String| ErrorTranscripcion::nuevo(Codigo::Otro, m, false);

    let clave = crate::transcripcion_api::clave_de(&clave_cifrada).map_err(otro)?;

    let tamano = tokio::fs::metadata(&audio)
        .await
        .map_err(|e| otro(format!("No se pudo leer el trozo de audio: {e}")))?
        .len();
    if tamano > LIMITE_BYTES_TROZO {
        return Err(otro(format!(
            "El trozo pesa {:.1} MB, por encima del margen del límite de 25 MB.",
            tamano as f64 / 1024.0 / 1024.0
        )));
    }
    let bytes = tokio::fs::read(&audio)
        .await
        .map_err(|e| otro(format!("No se pudo leer el trozo de audio: {e}")))?;

    let peticion = Peticion {
        audio: bytes,
        formato: if audio.ends_with(".wav") { "wav" } else { "mp3" },
        modelo,
        idioma,
        prompt: prompt.filter(|t| !t.trim().is_empty()),
    };

    match proveedor.as_str() {
        "openrouter" => con_reintentos(&OpenRouter, &clave, &peticion).await,
        "groq" => con_reintentos(&Groq, &clave, &peticion).await,
        "local" => con_reintentos(&LocalWhisper, &clave, &peticion).await,
        otro_id => Err(otro(format!("Proveedor de transcripción desconocido: {otro_id}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estados_se_clasifican() {
        let c = |n| error_de_estado("X", n, "");
        assert_eq!(c(401).codigo, Codigo::ClaveInvalida);
        assert_eq!(c(402).codigo, Codigo::SinSaldo);
        assert_eq!(c(403).codigo, Codigo::SinSaldo);
        assert_eq!(c(429).codigo, Codigo::LimiteTasa);
        assert!(c(429).reintentable && c(503).reintentable);
        assert!(!c(401).reintentable && !c(400).reintentable);
    }

    #[test]
    fn detalle_usa_el_mensaje_del_error() {
        let e = error_de_estado("X", 400, r#"{"error":{"code":400,"message":"audio roto"}}"#);
        assert!(e.mensaje.contains("audio roto"));
    }

    #[test]
    fn verbose_con_segmentos() {
        let r = parsear_verbose(
            r#"{"text":" hola mundo ","segments":[{"start":0.0,"end":1.5,"text":" hola "},{"start":1.5,"end":2.0,"text":"mundo"}]}"#,
            7,
        )
        .unwrap();
        assert_eq!(r.texto, "hola mundo");
        assert_eq!(r.segmentos.len(), 2);
        assert_eq!(r.segmentos[0], SegmentoApi { inicio_s: 0.0, fin_s: 1.5, texto: "hola".into() });
    }

    #[test]
    fn verbose_sin_segmentos_no_falla() {
        let r = parsear_verbose(r#"{"text":"hola"}"#, 0).unwrap();
        assert!(r.segmentos.is_empty());
        assert_eq!(r.texto, "hola");
    }
}
