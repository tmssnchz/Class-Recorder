# ClassRecorder

Aplicación de escritorio para Windows que graba, organiza y transcribe clases
universitarias — 100% local, sin backend, sin servicios pagos y sin conexión
a internet salvo para descargar el motor de transcripción y sus modelos
(una sola vez).

Construida con **Tauri v2 + React + TypeScript**, con la lógica de archivos y
los procesos externos (ffmpeg, whisper.cpp, faster-whisper) manejados desde
un backend en **Rust**.

## Instalación

Desde [**GitHub Releases**](https://github.com/tmssnchz/Class-Recorder/releases) — no hace falta compilar nada:

1. Descarga `ClassRecorder_X.X.X_x64-setup.exe` (instalador NSIS) o el `.msi` de la
   última release. Cualquiera de los dos instala lo mismo; el `.exe` es más
   chico, el `.msi` es el formato estándar de Windows si tu organización lo
   prefiere para distribución.
2. Al ejecutarlo, Windows SmartScreen va a avisar **"Windows protegió su PC"**
   porque el instalador no está firmado digitalmente (ver [Estado](#estado)).
   Click en **"Más información"** → **"Ejecutar de todas formas"**.
3. Abre ClassRecorder desde el menú Inicio. La app funciona de entrada para
   grabar y organizar clases.
4. Para transcribir, entra en **Configuración → Motor y modelos** y descarga el
   motor (whisper.cpp, ~8 MB, o faster-whisper, ~84 MB) y al menos un modelo
   (desde 31 MB el más chico). Es la única parte que usa internet — una vez
   descargado, la transcripción funciona sin conexión.

El instalador **no incluye** el motor de transcripción ni los modelos: se
descargan la primera vez que los uses, desde Hugging Face / GitHub Releases
de cada proyecto, directamente desde la app.

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
- **Biblioteca** con vista de árbol (clase › unidad, con las grabaciones y los
  apuntes de esa unidad en dos columnas) y de calendario (mensual/semanal, con
  indicador de pendientes de transcribir), reproductor con marcas de tiempo,
  etiquetas y búsqueda de texto dentro de todas las transcripciones. Es donde
  se lee todo: una grabación se escucha y un apunte se mira, en la misma
  columna de detalle.
- **Apuntes escritos a mano**: se fotografía la hoja con el celular, la app
  detecta las cuatro esquinas (con o sin los marcadores de su plantilla
  imprimible), corrige la perspectiva, limpia sombras y reconoce el texto
  manuscrito con un modelo local. El texto queda editable y entra en la misma
  búsqueda que las transcripciones. Ese trabajo —recortar, ordenar, reconocer,
  corregir— vive en la pestaña **Digitalizar**; leer el resultado, en la
  Biblioteca.
- **Exportación** a PDF, Word y Markdown (pensado para pegar en un LLM o un
  centro de estudios).
- **Respaldo completo a .zip**, con o sin audio.
- **Reconciliación automática al arrancar**: cada grabación deja su propio
  `.json` al lado del audio, así que si el índice central alguna vez queda
  desincronizado (un cierre abrupto, por ejemplo), la app repara sola la
  biblioteca comparándola contra lo que hay en disco.

## Por qué existe

Lo hice para grabar mis propias clases y no depender de una app en la nube
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
| Visión (apuntes) | `image` + `imageproc` + `rqrr` + `qrcode` en Rust puro, sin OpenCV |
| Texto manuscrito | VLM de OCR en GGUF sobre `llama-mtmd-cli` (llama.cpp), como proceso externo |
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
- **[`src-tauri/src/escaneo.rs`](src-tauri/src/escaneo.rs)** — todo el pipeline
  de visión de los apuntes en Rust puro, sin OpenCV ni un servicio de Python
  aparte. La homografía se calcula desde los centros de los cuatro QR, que **no**
  forman un rectángulo simétrico: el margen de anillado corre dos de ellos hacia
  adentro, y ese es justo el caso que rompe cualquier implementación que asuma
  simetría. El test `de_la_foto_en_angulo_al_escaneo_derecho` arma una hoja
  sintética, la deforma como si estuviera fotografiada en ángulo y comprueba la
  vuelta completa, sin necesitar una foto real.
- **[`src/lib/hardware.ts`](src/lib/hardware.ts)** — recomienda el modelo más
  grande que entra en la RAM de la máquina. Está suelto y no dentro del catálogo
  de apuntes porque el problema es el mismo para los modelos de whisper.

## Apuntes escritos a mano

La tercera fuente de contenido, después del audio grabado y el importado.

**Por qué Rust puro y no OpenCV ni Python.** El instalador pesa pocos MB y no
depende de nada instalado en el sistema; meter OpenCV o un intérprete de Python
rompía las dos cosas. `imageproc` tiene Canny, contornos, Douglas-Peucker y
homografía por cuatro puntos de control, que es todo lo que hace falta, y `rqrr`
lee los QR devolviendo sus esquinas en coordenadas de la imagen.

**Por qué los QR miden 14 mm y no 10.** Un QR de versión 1 son 21 módulos más 4
de zona de silencio por lado: 29 módulos de ancho impreso. A 10 mm cada módulo
mide 0,34 mm y en la parte baja de una foto sacada en ángulo cae a ~2 píxeles;
ahí el lector encuentra el código pero la corrección de errores no alcanza y el
decodificado falla. Medido: con 10 mm se leían 2 de 4 marcadores. A 14 mm cada
módulo mide 0,48 mm y se leen los cuatro. El payload va todo en mayúsculas
(`CR1:176X250:L18:0:7`) para entrar en el modo alfanumérico del QR y no subir a
versión 2.

**Por qué la lectura de marcadores hace tres pasadas.** Con una sola pasada
sobre la foto cruda no alcanza, y está medido sobre una foto real: en una hoja
impresa en gris claro y con un gradiente de luz de un lado a otro, `rqrr`
encuentra las cuatro cuadrículas pero la corrección de errores falla en tres.
Se reintenta con la imagen normalizada (divide por el fondo y estira el
contraste) y después a media resolución (promedia la textura del papel). Si
aun así falta uno, se completa como la esquina opuesta del paralelogramo:
los cuatro centros forman un rectángulo en milímetros, así que bajo una
aproximación afín el cuarto es deducible — y la interfaz avisa que el recorte
puede estar corrido.

**Por qué marcadores ArUco y no QR en las esquinas.** Es todo tamaño de
detalle. En los mismos 10 mm impresos:

| | Celdas de lado | Por celda |
|---|---|---|
| QR versión 2 | 25 + zona de silencio | 0,40 mm |
| ArUco | 7 (5 de datos + marco) | **1,43 mm** |

Tres veces y media más grueso, y eso es lo que decide si una impresora que
entrega gris en vez de negro sirve o no. No se recupera afinando el QR: para
tener módulos de 1,4 mm el QR tendría que medir 35 mm. Está medido contra una
impresión simulada con tinta clara (55 sobre papel 200, más el desenfoque de una
foto de celular): el ArUco decodifica hasta con 3 píxeles por celda, donde el QR
ya fallaba.

En el camino se midió algo que va contra la intuición y quedó anotado en el
código: **la versión 1 del QR es la peor opción**, porque es la única del
estándar sin patrón de alineación. Sin él la cuadrícula de módulos se arma solo
con los tres cuadrados de esquina y cualquier desenfoque la corre. Buscando "el
QR más chico posible" se había elegido justo el más frágil.

Lo que un ArUco **no** puede llevar es el tamaño de papel: su contenido es un
número de diccionario, no texto. Por eso la plantilla imprime además un QR chico
abajo al centro con la geometría. Ese no participa de la homografía: si no se
lee, el escaneo usa el papel configurado y lo avisa.

**Por qué `aruco-rs` y no los crates más populares.** `apriltag` tiene millones
de descargas pero va por `apriltag-sys`, o sea ata el proyecto a una librería de
C que habría que instalar aparte para compilar — y con OpenCV, además, a repartir
50-100 MB de DLLs junto a un instalador que hoy pesa 7 MB. `aprilgrid`, el más
usado en Rust puro, arrastra **111 crates**, incluido un codificador de video AV1
completo: usa `image` con todas sus features y revierte por la puerta de atrás la
decisión de compilar solo JPEG y PNG. `aruco-rs` suma **2 crates**, es Rust puro
y trae su propio pipeline de visión con umbral adaptativo, que es exactamente lo
que hacía falta.

**Por qué el tamaño de papel se escribe a mano.** Varios recambios de binder se
venden como "B5" sin serlo. Hay tres medidas en circulación: B5 ISO
(176 × 250), B5 JIS (182 × 257) y el "universitario" de 173 × 250. Los tres
vienen como preset y además se puede escribir cualquier ancho y alto.

**Por qué GLM-OCR y no TrOCR.** TrOCR (`microsoft/trocr-*-handwritten`) está
entrenado sobre IAM, que es manuscrita en inglés, y no tiene soporte oficial de
español: no sirve como opción por defecto acá. Los VLM de OCR que aparecieron en
2026 sí son multilingües, vienen en GGUF y corren con el mismo patrón de
"ejecutable descargado aparte" que whisper.cpp. Se ofrecen tres, y la app
recomienda uno según la RAM de la máquina:

| Modelo | Disco | RAM | Minutos por hoja (CPU) | Para qué |
|---|---|---|---|---|
| LightOnOCR 1B | 1,0 GB | ~3 GB | ~1 | Tener el apunte buscable |
| GLM-OCR | 1,4 GB | ~4 GB | ~2 | Recomendado en español |
| dots.ocr 2B | 3,0 GB | ~8 GB | ~5 | El más preciso en alfabeto latino |

**Por qué la imagen se reduce antes de reconocerla.** Medido sobre la misma
hoja: a 1969 px de alto tarda 5 min 08 s, y a 1181 px tarda 1 min 21 s con el
mismo texto reconocido. El escaneo se guarda igual en alta resolución; la copia
reducida a 1400 px existe solo para el modelo y se borra al terminar.

**El reverso no es una copia del frente.** Los agujeros del anillado están en
el papel, no en la cara: al dar vuelta la hoja pasan al borde opuesto. Las
páginas pares se generan con el margen espejado (`caraReverso`), o los dos QR de
ese lado caerían encima de la perforación. El escaneo no necesita saber nada de
esto: cada cara lleva su propio lado de anillado codificado en sus QR.

**Qué no hace.** Los diagramas y las líneas de tiempo dibujadas a mano no se
transcriben. Reconocer formas dibujadas a mano es otro problema, y forzarlo
produce descripciones inventadas que después se toman por ciertas.

El prompt le pide al modelo que las marque como `[diagrama]`, pero conviene
saber que **GLM-OCR no lo hace**: está medido sobre hojas reales con tres
formulaciones distintas y las ignora todas, porque es un modelo especializado
en transcribir y las instrucciones de formato le resbalan. La marca queda
pedida por si otro motor la respeta; lo que funciona es la casilla "esta hoja
es sobre todo un diagrama" del editor, que marca la página a mano.

**Decisiones de producto que conviene saber:**

- El papel físico **no** se asume descartable. El escaneo es un respaldo digital
  y un índice buscable; nada en la app sugiere botar la hoja.
- La foto original se conserva por defecto (ocupa el doble) para poder volver a
  recortar si el encuadre salió mal. Se puede desactivar.
- Re-escanear una hoja no pisa la anterior: el apunte nuevo apunta al viejo con
  `reemplazaA` y solo el último se lista.
- Las fotos comparten la carpeta `ClassRecorder_Inbox` con los audios y se
  separan por extensión en Rust, así se configura una sola carpeta sincronizada
  y una foto nunca cae en la cola de audios.
- Los apuntes viven dentro de la carpeta de grabaciones
  (`{clase}/{unidad}/materiales/apuntes/{titulo}/`), así que entran solos en el
  respaldo .zip y viajan con el proyecto si se mueve de disco.

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
transcribir → exportar). Ver [CHANGELOG.md](CHANGELOG.md) por versión.

**No está firmado digitalmente ni notarizado.** Conseguir un certificado de
firma de código (Authenticode) tiene costo y un proceso de verificación de
identidad que todavía no hice — por eso Windows SmartScreen muestra la
advertencia al instalar. El código es público en este repo si quieres
auditarlo antes de confiar en el ejecutable.

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
