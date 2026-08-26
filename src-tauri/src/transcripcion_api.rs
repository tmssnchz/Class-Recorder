//! Transcripción vía API externa (Groq, OpenAI o cualquier endpoint
//! compatible con `audio/transcriptions`), usando la propia clave del usuario.
//!
//! Nada de esto se ejecuta si el usuario no lo habilita y configura una
//! clave desde Configuración: sin eso, la app transcribe igual que siempre
//! con el motor local.

use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::LocalFree;
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Tamaño máximo que aceptan Groq y OpenAI en el endpoint `audio/transcriptions`.
/// El audio ya se manda comprimido (ver `extraerAudioParaApi`), pero se
/// revisa acá también antes de leerlo entero a memoria.
const LIMITE_BYTES_API: u64 = 25 * 1024 * 1024;

fn a_hex(datos: &[u8]) -> String {
    datos.iter().map(|b| format!("{b:02x}")).collect()
}

fn de_hex(texto: &str) -> Result<Vec<u8>, String> {
    if texto.len() % 2 != 0 {
        return Err("clave cifrada corrupta".into());
    }
    (0..texto.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&texto[i..i + 2], 16).map_err(|_| "clave cifrada corrupta".into()))
        .collect()
}

/// Cifra con DPAPI (ligado al usuario de Windows que corre la app): nadie más
/// que este usuario, en esta máquina, puede recuperar el texto plano.
/// `CRYPTPROTECT_UI_FORBIDDEN` evita que Windows muestre algún diálogo.
fn cifrar_dpapi(claro: &[u8]) -> Result<Vec<u8>, String> {
    let mut entrada = CRYPT_INTEGER_BLOB {
        cbData: claro.len() as u32,
        pbData: claro.as_ptr() as *mut u8,
    };
    let mut salida = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &mut entrada,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut salida,
        )
        .map_err(|e| format!("No se pudo cifrar la clave: {e}"))?;

        let bytes = std::slice::from_raw_parts(salida.pbData, salida.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(salida.pbData as *mut _)));
        Ok(bytes)
    }
}

/// Inverso de `cifrar_dpapi`. Si la clave se cifró en otra máquina o con otro
/// usuario de Windows, DPAPI falla acá: por eso nunca se sincroniza `config.json`
/// entre equipos y se espera que cada instalación configure su propia clave.
fn descifrar_dpapi(cifrado: &[u8]) -> Result<Vec<u8>, String> {
    let mut entrada = CRYPT_INTEGER_BLOB {
        cbData: cifrado.len() as u32,
        pbData: cifrado.as_ptr() as *mut u8,
    };
    let mut salida = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(
            &mut entrada,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut salida,
        )
        .map_err(|_| "No se pudo leer la clave guardada: vuelve a escribirla en Configuración.".to_string())?;

        let bytes = std::slice::from_raw_parts(salida.pbData, salida.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(salida.pbData as *mut _)));
        Ok(bytes)
    }
}

/// Cifra la clave que el usuario tipeó en Configuración. Lo que vuelve (hex)
/// es lo único que se guarda en `config.json`.
#[tauri::command]
pub fn cifrar_clave_api(clave: String) -> Result<String, String> {
    Ok(a_hex(&cifrar_dpapi(clave.as_bytes())?))
}

fn mime_de(ruta: &str) -> &'static str {
    if ruta.ends_with(".wav") {
        "audio/wav"
    } else {
        "audio/mpeg"
    }
}

/// Manda el audio a un endpoint compatible con `audio/transcriptions`
/// (Groq, OpenAI o uno personalizado) y devuelve el JSON crudo de la
/// respuesta (`response_format=verbose_json`: trae `segments` con tiempos,
/// igual que faster-whisper).
#[tauri::command]
pub async fn transcribir_api(
    url: String,
    clave_cifrada: String,
    audio: String,
    modelo: String,
    idioma: String,
) -> Result<String, String> {
    let metadata = tokio::fs::metadata(&audio)
        .await
        .map_err(|e| format!("No se pudo leer el audio a mandar: {e}"))?;
    if metadata.len() > LIMITE_BYTES_API {
        return Err(format!(
            "El audio comprimido pesa {:.1} MB, por encima del límite de 25 MB de la API.",
            metadata.len() as f64 / 1024.0 / 1024.0
        ));
    }

    let clave = descifrar_dpapi(&de_hex(&clave_cifrada)?)?;
    let clave = String::from_utf8(clave).map_err(|_| "clave cifrada corrupta".to_string())?;

    let bytes = tokio::fs::read(&audio)
        .await
        .map_err(|e| format!("No se pudo leer el audio a mandar: {e}"))?;

    let parte_audio = reqwest::multipart::Part::bytes(bytes)
        .file_name("audio")
        .mime_str(mime_de(&audio))
        .map_err(|e| format!("Error interno armando el pedido: {e}"))?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", parte_audio)
        .text("model", modelo)
        .text("response_format", "verbose_json");
    if idioma != "auto" && !idioma.is_empty() {
        form = form.text("language", idioma);
    }

    let cliente = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("No se pudo preparar el cliente HTTP: {e}"))?;

    let respuesta = cliente
        .post(&url)
        .bearer_auth(&clave)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con la API: {e}"))?;

    let estado = respuesta.status();
    if estado.as_u16() == 401 {
        return Err("La clave de API no es válida o no tiene permisos.".to_string());
    }
    if estado.as_u16() == 429 {
        return Err(
            "Límite de solicitudes de la API alcanzado. Espera unos minutos e intenta de nuevo."
                .to_string(),
        );
    }
    if !estado.is_success() {
        let cuerpo = respuesta.text().await.unwrap_or_default();
        return Err(format!("La API respondió {estado}: {cuerpo}"));
    }

    respuesta
        .text()
        .await
        .map_err(|e| format!("No se pudo leer la respuesta de la API: {e}"))
}
