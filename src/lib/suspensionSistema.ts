/** Instancia única del control de suspensión, conectada a Windows vía Tauri. */
import { invoke } from "@tauri-apps/api/core";

import { crearControlSuspension } from "./suspension.ts";

export const fijarSuspension = crearControlSuspension((evitar) => {
  void invoke(evitar ? "evitar_suspension" : "permitir_suspension");
});
