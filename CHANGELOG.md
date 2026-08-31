# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Este proyecto todavía no sigue versionado semántico estricto (está en `0.x`,
así que cualquier versión puede traer cambios incompatibles).

## [0.4.0] - 2026-08-31

### Agregado

- **Apuntes escritos a mano** — tercera fuente de contenido, junto a la
  grabación de audio y la importación desde el celular. Se fotografía la hoja,
  la foto llega por la misma carpeta de Drive que ya se usa para los audios, y
  la app recorta la hoja, corrige la perspectiva, la limpia y reconoce el
  texto.
- **Detección de la hoja con y sin marcadores**. Con la plantilla imprimible se
  leen cuatro marcadores ArUco de 10 mm en las esquinas y el recorte sale
  exacto; sin ella se detecta el borde del papel por contraste. En los dos casos
  se pueden arrastrar las cuatro esquinas a mano, que es el plan B obligatorio
  cuando la detección falla.
- **Marcadores ArUco en vez de QR en las esquinas**, para tolerar impresoras
  que entregan gris en vez de negro. En los mismos 10 mm impresos, cada celda
  de un ArUco mide 1,43 mm contra 0,40 mm de un módulo de QR: tres veces y media
  más grueso. Medido contra una impresión clara simulada, el ArUco decodifica
  con 3 píxeles por celda donde el QR fallaba. El tamaño de papel, que un id de
  diccionario no puede transportar, viaja en un QR chico abajo al centro.
- **Plantilla imprimible parametrizada** por tamaño de papel (B5, A4, Carta,
  A5) y lado del anillado, con flujo de impresión a doble cara para
  impresoras sin dúplex automático: dos tandas, volteo en el medio y una hoja
  de calibración "A/B" para saber si esa impresora invierte el orden. El
  reverso se genera con el margen del anillado espejado: los agujeros están en
  el papel y no en la cara, así que al dar vuelta la hoja cambian de borde.
- **Lectura de marcadores tolerante a fotos reales.** Sobre una hoja impresa
  en gris claro y con luz despareja, una sola pasada del lector encontraba las
  cuatro cuadrículas pero solo decodificaba una. Ahora se reintenta con la
  imagen normalizada y a media resolución, y si aun así falta un marcador se
  estima como la esquina opuesta del paralelogramo — avisando que el recorte
  es aproximado. Medido sobre una foto real: de 1 marcador leído a los 4.
- **Reconocimiento de texto manuscrito (HTR)** con tres modelos locales
  descargables (LightOnOCR 1B, GLM-OCR, dots.ocr 2B) corriendo sobre
  `llama-mtmd-cli.exe` de llama.cpp, o vía API externa reusando los mismos
  perfiles y claves que ya existían para la transcripción de audio.
- **Recomendación de modelo según la máquina**: mira la RAM y los núcleos y
  propone el mejor modelo que entra. El cálculo vive en `lib/hardware.ts`,
  suelto, para poder aplicarlo también a los modelos de whisper.
- **Editor de apunte** con la hoja escaneada al lado del texto reconocido,
  editable, reordenamiento de páginas y marcado de hojas que son sobre todo un
  diagrama.
- **Aviso de fotos inservibles antes de procesarlas**: se mide el desenfoque y
  la exposición y se avisa en vez de generar un escaneo o un texto basura en
  silencio. También se detecta cuando hay dos hojas en la misma foto.
- **Búsqueda dentro de los apuntes** desde la biblioteca, junto a las
  transcripciones, y exportación del apunte a PDF (hoja + texto) o Markdown.
- **Importar archivos desde el computador**, tanto audios como fotos de
  apuntes. Antes la única entrada era la carpeta sincronizada con Drive, así
  que sin configurarla no había forma de meter nada.
- **Tamaño de papel a medida** en la plantilla: ancho, alto y margen de
  anillado se escriben en milímetros, centímetros o pulgadas. Varios recambios
  de binder que se venden como "B5" no lo son — 173 × 250 mm es de los más
  comunes y viene como preset propio, junto al B5 ISO y al B5 JIS. La unidad
  es solo de entrada: adentro y dentro del QR todo son milímetros.

### Cambiado

- `datos.json` gana la lista `apuntes` y `config.json` la sección del mismo
  nombre. Un archivo anterior sigue siendo válido: los campos nuevos se
  rellenan con los valores por defecto al cargar.

### Arreglado

- **Los colores de la tinta se perdían al limpiar el escaneo.** La versión
  inicial le restaba un punto de negro a cada canal por separado, y eso destruye
  el tono de cualquier tinta oscura: una lapicera azul tiene luminancia ~66 y el
  punto de negro caía justo encima, así que salía negra. El rojo sobrevivía por
  casualidad. Ahora el realce se calcula sobre la luminancia y los tres canales
  se escalan por el mismo factor: al ser una multiplicación y no una resta, el
  tono se conserva exacto para cualquier color.
- **La sombra de la mano o del teléfono sobrevivía al escaneo.** El radio con el
  que se estima el papel estaba en 1/20 del lado corto; tan grande que la
  estimación se aplanaba y dejaba de seguir la sombra. Bajado a 1/40.
- **Una hoja casi sin escribir salía toda negra.** Sin tinta, el punto de negro
  calculado se subía por encima del de blanco y el estirado invertía la página
  entera. Ahora hay un rango mínimo garantizado.
- **El PDF de la plantilla no se podía abrir** ("Not allowed to open path"): el
  plugin `opener` tenía el comando habilitado pero su scope de rutas vacío. Y si
  falla al abrirlo, ahora se avisa como nota con la ruta en vez de como error,
  porque el archivo ya está en disco.
- **Los grupos de botones eran invisibles** en la cabecera de Grabar, Apuntes y
  el editor: usaban la clase de las filas de lista, que se esconde con `opacity`
  hasta pasar el mouse por su `.item` contenedor.
- **La foto se veía girada** respecto de los tiradores de las esquinas: el
  análisis trabaja sobre la imagen con la orientación EXIF ya aplicada y la
  interfaz mostraba el archivo crudo. Ahora el backend devuelve una vista previa
  ya orientada y es esa la que se muestra.
- **Volvió el botón "Sincronizar desde el celular"**, que había quedado
  reemplazado en vez de acompañado por el de importar archivos.

## [0.3.2] - 2026-08-26

### Arreglado

- **Los atajos de teclado nunca se registraban**: el permiso
  `global-shortcut:default` del plugin no habilita ningún comando (lo dice su
  propia definición), así que cada `register()` era rechazado por el ACL y
  F8–F11 no funcionaban nunca. Encima la app lo reportaba como "ya está en uso
  por otro programa", que era un mensaje equivocado: no había ningún otro
  programa. Se agregaron `allow-register` y `allow-unregister`.
- **Una sola instancia a la vez**: dos ventanas abiertas se pisaban
  `config.json` y `datos.json` entre sí, porque cada una guarda su copia en
  memoria y la última en escribir gana. Ahora la segunda trae al frente la que
  ya estaba abierta.
- **Aviso falso de OneDrive**: "No encontré OneDrive instalado en esta
  máquina" aparecía al entrar a Configuración mientras la detección seguía en
  curso, y desaparecía solo al llegar la respuesta.
- **Fallo de guardado silencioso**: si escribir `config.json` fallaba, la
  interfaz seguía mostrando el cambio como guardado. Ahora el error se ve.
- **Transcripciones fallidas invisibles**: en Pendientes, una tarea en error se
  seguía viendo como "transcribiendo" para siempre, sin forma de reintentarla y
  fuera del lote de "Transcribir todas". Ahora muestra "falló" con el motivo y
  un botón para reintentar.

### Cambiado

- **El motor predeterminado se respeta sin preguntar**: si hay un perfil de API
  (o Multi-API) como predeterminado, "Transcribir" y "Transcribir todas" lo
  usan directamente. El modal de elección queda solo para cuando el
  predeterminado es el motor local y además hay perfiles de API configurados.
- **La confirmación de "Transcribir todas" ya no promete el motor local**:
  ahora dice con qué motor se va a transcribir de verdad, y el aviso de horas
  de CPU sale solo cuando el trabajo va a correr en local.

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
