# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Este proyecto todavía no sigue versionado semántico estricto (está en `0.x`,
así que cualquier versión puede traer cambios incompatibles).

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
