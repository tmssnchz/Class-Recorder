# ClassRecorder

Aplicación de escritorio para Windows que graba, organiza y transcribe clases
universitarias — 100% local, sin backend, sin servicios pagos y sin conexión
a internet salvo para descargar el motor de transcripción y sus modelos
(una sola vez).

Construida con **Tauri v2 + React + TypeScript**, con la lógica de archivos y
los procesos externos (ffmpeg, whisper.cpp, faster-whisper) manejados desde
un backend en **Rust**.

## Qué hace

- **Grabación** con autoguardado por chunks cada 5 segundos: si la app se
  cierra de golpe, lo grabado hasta ese punto se recupera solo al reabrir.
- **Reasignar la clase o unidad de una grabación sin cortarla**: el audio se
  mueve de carpeta en caliente, con el `rename` encolado detrás de los
  chunks que todavía se están escribiendo.
- **Transcripción local** con dos motores intercambiables — whisper.cpp y
  faster-whisper — corriendo como procesos externos para no bloquear la
  interfaz, con progreso en tiempo real leído directamente del stdout/stderr
  del proceso.
- **Biblioteca** con vista de árbol (clase › unidad › grabación) y de
  calendario (mensual/semanal, con indicador de pendientes de transcribir),
  reproductor con marcas de tiempo, etiquetas y búsqueda de texto dentro de
  todas las transcripciones.
- **Exportación** a PDF, Word y Markdown (pensado para pegar en un LLM o un
  centro de estudios).
- **Respaldo completo a .zip**, con o sin audio.
- **Reconciliación automática al arrancar**: cada grabación deja su propio
  `.json` al lado del audio, así que si el índice central alguna vez queda
  desincronizado (un cierre abrupto, por ejemplo), la app repara sola la
  biblioteca comparándola contra lo que hay en disco.

## Por qué existe

Lo armé para grabar mis propias clases y no depender de una app en la nube
que suba audio de alumnos a un servidor de terceros. La restricción de "100%
local" terminó siendo la parte más interesante del proyecto: coordinar tres
procesos externos (ffmpeg, whisper.cpp, faster-whisper) sin bloquear la UI,
mantener consistencia entre disco y estado en memoria cuando algo se
interrumpe a mitad de camino, y mover un archivo de audio que se está
escribiendo activamente sin perder ni un chunk.

## Stack técnico

| Capa | Tecnología |
|---|---|
| UI | React 19 + TypeScript, sin librería de estado externa (Context + hooks) |
| Escritorio | Tauri v2 (WebView2 + Rust) |
| Backend | Rust — filesystem, sidecars, descargas, permisos de micrófono |
| Audio | MediaRecorder API (navegador) → ffmpeg (sidecar) → MP3/WAV |
| Transcripción | whisper.cpp o faster-whisper, como procesos externos |
| Persistencia | JSON local (`datos.json` + `config.json`), sin base de datos |
| Exportación | jsPDF, `docx`, Markdown propio |

## Decisiones de arquitectura que vale la pena mirar

- **[`src/estado/grabador.tsx`](src/estado/grabador.tsx)** — el motor de
  grabación. La reasignación de clase en caliente usa una cola de promesas
  para serializar el `rename` del archivo contra los chunks que
  `MediaRecorder` sigue entregando, sin pausar la grabación.
- **[`src/lib/grabaciones.ts`](src/lib/grabaciones.ts)** — `reconciliarConDisco`
  reconstruye el índice a partir de los `.json` sueltos en la carpeta de
  grabaciones: la fuente de verdad es el disco, no la base JSON central.
- **[`src-tauri/src/transcripcion.rs`](src-tauri/src/transcripcion.rs)** — dos
  motores con formatos de progreso completamente distintos (whisper.cpp
  imprime `progress = NN%` por stderr con saltos de línea; faster-whisper
  imprime por **stdout** con `\r` sin salto de línea), unificados en el mismo
  evento hacia el frontend.
- **[`src-tauri/src/descargas.rs`](src-tauri/src/descargas.rs)** — descargas
  a una carpeta `.descargando`/`.parcial` que solo se publica al completarse,
  para que un corte de conexión no deje un modelo a medias que rompa la
  transcripción con un error críptico.

## Correr en local

Requisitos: Node 20+, Rust estable, [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
(componente "Desktop development with C++").

```bash
npm install
powershell -ExecutionPolicy Bypass -File scripts/setup-ffmpeg.ps1  # sidecar de audio, ~80 MB, no se versiona
npm run tauri dev
```

El motor de transcripción y los modelos (whisper.cpp o faster-whisper) se
instalan desde la propia app, en Configuración → Motor y modelos — no hace
falta nada más por fuera.

Para generar el instalador:

```bash
npm run tauri build
```

## Estructura

```
src/                    # React + TypeScript
  components/           # Paneles (Grabar, Biblioteca, Clases, Configuración)
  estado/                # Contexts: store (JSON), grabador, transcripciones
  lib/                   # Lógica sin UI: archivos, transcripción, exportación
src-tauri/src/          # Backend Rust
  transcripcion.rs       # Ejecuta whisper.cpp / faster-whisper como sidecar
  descargas.rs           # Descarga motores y modelos
  respaldo.rs             # Exportación a .zip
scripts/                # Setup del entorno de desarrollo (no de la app en sí)
```

## Estado

Proyecto personal en desarrollo activo. Funciona de punta a punta (grabar →
transcribir → exportar) pero todavía no está empaquetado como release
distribuible ni firmado digitalmente.

## Cómo se hizo

Este proyecto lo construí junto con [Claude Code](https://claude.com/claude-code):
yo definí los requisitos, tomé las decisiones de producto y de arquitectura
(qué motor de transcripción usar, cómo estructurar las carpetas, qué pasa si
la app se cierra a mitad de una grabación) y probé cada parte contra clases
reales; Claude escribió el código bajo esa dirección. Lo aclaro porque me
parece más honesto que dejarlo ambiguo: no programé esto a mano ni sé hacerlo
todavía, pero sí entiendo por qué está construido como está.

## Licencia

MIT — ver [LICENSE](LICENSE).
