# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Este proyecto todavía no sigue versionado semántico estricto (está en `0.x`,
así que cualquier versión puede traer cambios incompatibles).

## [0.3.1] - 2026-08-26

### Arreglado

- **Transcripción por API**: el audio se mandaba sin extensión en el nombre
  de archivo del multipart, y Groq/OpenAI deducen el formato por ahí (no
  solo por el `Content-Type`). Rechazaban todo con 400 Bad Request. Ahora
  manda `audio.mp3`/`audio.wav` según corresponda.

## [0.3.0] - 2026-08-26

### Agregado

- **Transcripción por API externa**: además del motor local, se puede
  transcribir con Groq, OpenAI o cualquier endpoint compatible con el
  formato `audio/transcriptions`, usando la propia clave del usuario. 100%
  opcional y desactivado por defecto: si no se configura nada, la app sigue
  transcribiendo local exactamente igual que antes.
- **Varios perfiles de API guardados**: se puede registrar más de una clave
  (por ejemplo, dos cuentas de Groq) y elegir entre ellas al transcribir.
  Cada clave se guarda cifrada con DPAPI, ligada al usuario de Windows del
  equipo: nunca en texto plano, nunca logueada.
- **Motor predeterminado y elección por transcripción**: al transcribir (una
  grabación o "Transcribir todas" desde Pendientes) se pregunta si usar el
  motor predeterminado o elegir otro para esa vez, con la opción de dejarlo
  como nuevo predeterminado.
- **Modo Multi-API**: prueba los perfiles guardados en orden y rota al
  siguiente automáticamente si uno llega al límite de uso (HTTP 429), en vez
  de frenar la cola. Pensado para dejar muchas clases transcribiéndose de
  noche repartidas entre varias claves.
- **Audio largo por API**: se parte en tramos de 90 minutos y se manda por
  partes (con los tiempos reajustados al pegar los segmentos), así no choca
  con el límite de tamaño por archivo del proveedor (25 MB en Groq/OpenAI).
  Si el audio no entra igual, cae automáticamente al motor local.

## [0.2.0] - 2026-08-21

### Agregado

- **Ubicación de las grabaciones**: elegir entre carpeta local, OneDrive o
  Google Drive desde Configuración. Para OneDrive y Drive, crear la carpeta
  sola dentro de la raíz sincronizada (detectando cuentas de OneDrive vía el
  registro) o elegir una ya existente a mano.
- **Archivos bajo demanda de OneDrive**: si un audio quedó en modo ahorro de
  espacio, se detecta antes de reproducirlo, recortarlo o transcribirlo y se
  pide confirmar la descarga, con progreso real. Google Drive siempre
  mantiene una copia completa en disco.
- **Cambio de ubicación con grabaciones existentes**: mover todo a la carpeta
  nueva (verificando espacio libre antes, sin borrar el original hasta
  confirmar que la copia terminó bien) o dejarlas donde están, sin partir
  ninguna clase entre dos carpetas.
- **Biblioteca colapsada por defecto**: el árbol de clase › unidad arranca
  cerrado, con botones para expandir o colapsar todo de una vez.
- **Nota post-grabación**: al detener, un modal opcional pregunta qué se
  conversó en la clase. Se puede editar después desde el detalle de la
  grabación, y entra en el buscador (rápido y de texto, con fragmento) igual
  que las transcripciones.

## [0.1.0] - 2026-08-07

Primera versión distribuible. Grabación, transcripción y biblioteca
funcionando de punta a punta.

### Agregado

- **Grabación**: MediaRecorder + autoguardado por chunks cada 5 segundos,
  atajos de teclado configurables (globales o solo con foco en la ventana),
  marcado de momentos importantes, aviso de espacio en disco y de silencio
  prolongado (posible micrófono desconectado).
- **Reasignar clase o unidad en caliente**: mover una grabación en curso a
  otra clase/unidad sin cortar la grabación.
- **Recorte de audio por rango horario**: cortar desde un punto o quitar un
  intervalo intermedio, usando hora de reloj o minuto de la grabación
  indistintamente. Sin recodificar (`ffmpeg -c copy`).
- **Transcripción local** con whisper.cpp o faster-whisper, elegible por
  motor y por tamaño de modelo, con descarga gestionada desde la app.
- **Biblioteca**: vista de árbol y de calendario (mensual/semanal), buscador
  de texto dentro de todas las transcripciones, etiquetas, pestaña de
  pendientes de transcribir.
- **Exportación** de transcripciones a PDF, Word y Markdown.
- **Respaldo completo a `.zip`**, con o sin audio.
- **Reconciliación automática** del índice contra lo que hay en disco al
  arrancar la app, y recuperación de grabaciones interrumpidas por un cierre
  abrupto.

### Conocido

- No firmado digitalmente: Windows SmartScreen va a advertir al instalar.
- `faster-whisper` no soporta aceleración por GPU en esta build (solo CPU).
- El instalador no incluye el motor de transcripción ni los modelos: se
  descargan la primera vez que se usan, desde la propia app.
