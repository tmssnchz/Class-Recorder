//! Evita que Windows suspenda el equipo mientras hay transcripciones en cola.
//!
//! El frontend (`transcripciones.tsx`) es el que sabe cuándo la cola pasa de
//! vacía a no vacía y viceversa; estos comandos solo tocan el estado de
//! ejecución del hilo. `SetThreadExecutionState` no es persistente: si la app
//! se cierra de golpe, Windows lo limpia solo al terminar el proceso.

#[cfg(target_os = "windows")]
use windows::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
};

#[tauri::command]
pub fn evitar_suspension() {
    #[cfg(target_os = "windows")]
    unsafe {
        SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    }
}

#[tauri::command]
pub fn permitir_suspension() {
    #[cfg(target_os = "windows")]
    unsafe {
        SetThreadExecutionState(ES_CONTINUOUS);
    }
}
