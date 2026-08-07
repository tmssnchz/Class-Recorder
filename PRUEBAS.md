# Prueba manual: reasignación en vivo + autoguardado + transcripción en cola

Valida las tres cosas más frágiles de la app funcionando **al mismo tiempo**.
Toma unos 15 minutos. No hace falta hablar: alcanza con dejar el micrófono
abierto y hacer ruido de vez en cuando (contar en voz alta sirve).

**Requisitos previos**

- La app **instalada** (menú Inicio), no `npm run tauri dev`.
- Motor whisper.cpp y un modelo ya descargados (Configuración › Motor y modelos).
  Con `Tiny (cuantizado)` la prueba es mucho más rápida.
- Al menos una grabación vieja ya guardada, para transcribirla durante la prueba.
- Dos ventanas del Explorador abiertas en `C:\ClassRecorder\grabaciones`, para
  mirar los archivos en tiempo real.

---

## Preparación

- [ ] **P1.** Abrir la app. Anotar cuántas clases y grabaciones muestra el pie de
      la barra lateral: `____ clases · ____ grabaciones`.
- [ ] **P2.** Crear una clase de prueba llamada `ZZ Prueba` con una unidad `U1`.
- [ ] **P3.** En Configuración, dejar el modelo en `Tiny (cuantizado)` y
      `Transcripciones a la vez: 1`.

## Bloque A — Arrancar la transcripción de fondo

- [ ] **A1.** Biblioteca › elegir una grabación vieja › botón **Transcribir**.
- [ ] **A2.** Verificar que en la barra lateral aparece el testigo
      `1 transcripción · en proceso`.
- [ ] **A3.** Ir a la pestaña **Grabar** sin esperar a que termine.
      → *La transcripción debe seguir corriendo (el testigo sigue visible).*

## Bloque B — Grabar con reasignaciones en vivo

- [ ] **B1.** Con clase `Sin clasificar` (sin elegir nada), presionar **Grabar**.
      Hablar unos 20 segundos.
      → *Debe aparecer `C:\ClassRecorder\grabaciones\Sin clasificar\Sin unidad\…webm.part`
      y crecer cada 5 segundos.*
- [ ] **B2.** Sin detener, cambiar el selector **Clase** a `ZZ Prueba`.
      → *El `.part` desaparece de `Sin clasificar` y aparece en `ZZ Prueba\Sin unidad`.
      El cronómetro NO se reinicia. El texto de abajo muestra la ruta nueva.*
- [ ] **B3.** Esperar 20 segundos más y cambiar **Unidad** a `U1`.
      → *El `.part` se mueve a `ZZ Prueba\U1` y sigue creciendo desde el tamaño
      que ya tenía (no vuelve a cero).*
- [ ] **B4.** Presionar **Marcar momento** dos veces, con unos segundos de
      diferencia, y escribir una nota en una de las marcas.
- [ ] **B5.** Crear una clase nueva desde el propio selector: botón **+** junto a
      Clase › nombre `ZZ Prueba 2` › confirmar.
      → *Se crea, queda seleccionada, y el `.part` se muda a `ZZ Prueba 2\Sin unidad`.*
- [ ] **B6.** Volver a cambiar a `ZZ Prueba` › `U1`.
- [ ] **B7.** **Pausar**, esperar 10 segundos, **Reanudar**.
      → *El cronómetro se congela en pausa y sigue desde donde estaba.*
- [ ] **B8.** Cambiar de clase **estando en pausa**.
      → *El movimiento debe funcionar igual que grabando.*

## Bloque C — Cierre y verificación

- [ ] **C1.** **Detener y guardar**. Anotar la duración que marcaba el
      cronómetro: `____:____`.
- [ ] **C2.** Esperar a que termine la conversión (la barra "Convirtiendo").
- [ ] **C3.** Ir a Biblioteca y abrir la grabación nueva.

**Criterios de aceptación — el audio:**

- [ ] **C4.** El `.mp3` está **solo** en `ZZ Prueba\U1`, con su `.json` al lado.
- [ ] **C5.** No quedó ningún `.part` ni `.parcial.json` suelto en **ninguna**
      carpeta (revisar `Sin clasificar`, `ZZ Prueba\Sin unidad`, `ZZ Prueba 2`).
- [ ] **C6.** La duración en la Biblioteca coincide con la de C1 (±2 s).
- [ ] **C7.** Reproducir de punta a punta: **se escucha todo lo hablado, incluido
      lo de antes de cada cambio de clase.** Este es el punto más importante de
      toda la prueba.
- [ ] **C8.** Las dos marcas aparecen sobre la barra de progreso, en el segundo
      correcto, y la nota se conservó.

**Criterios de aceptación — la transcripción de fondo:**

- [ ] **C9.** La transcripción del Bloque A terminó y su texto se ve en la
      grabación vieja.
- [ ] **C10.** Su `.txt` y `.segmentos.json` están en la carpeta de **esa**
      grabación, no en la de la grabación nueva.

## Bloque D — Corte abrupto (autoguardado)

- [ ] **D1.** Empezar una grabación nueva en `ZZ Prueba` › `U1`. Hablar 30 s.
- [ ] **D2.** Cambiar de clase a `ZZ Prueba 2` a mitad de camino.
- [ ] **D3.** Matar la app **sin detener la grabación**: Administrador de tareas
      › `ClassRecorder.exe` › Finalizar tarea. (Cerrar con la X no sirve: la app
      pregunta y guarda bien, que es justo lo que acá NO queremos probar.)
- [ ] **D4.** Volver a abrir la app.
      → *En Grabar debe aparecer el cartel "Hay una grabación interrumpida", con
      el tamaño y los minutos grabados.*
- [ ] **D5.** Presionar **Recuperar**.
- [ ] **D6.** Reproducirla.
      → *Debe escucharse hasta unos segundos antes del corte, y quedar en la
      carpeta de `ZZ Prueba 2` (la última clase elegida antes de matar la app).*

## Bloque E — Reconciliación automática

- [ ] **E1.** Cerrar la app.
- [ ] **E2.** Abrir `%APPDATA%\com.tomas.classrecorder\datos.json` en el Bloc de
      notas y borrar a mano el objeto de la grabación del Bloque C dentro de
      `"grabaciones"` (dejando el JSON válido). Guardar.
- [ ] **E3.** Abrir la app › Biblioteca.
      → *La grabación tiene que reaparecer sola, con su clase, unidad y
      transcripción. Eso es la reconciliación contra el disco.*

## Bloque F — faster-whisper

- [ ] **F1.** Configuración › Transcripción › Motor: elegir **faster-whisper**.
      → *La tabla de abajo tiene que cambiar a los modelos de faster-whisper
      (Tiny a Large v3), con "Motor faster-whisper · 84 MB".*
- [ ] **F2.** Instalar el motor y descargar el modelo **Tiny** (74 MB, rápido
      para probar).
- [ ] **F3.** Transcribir una grabación corta.
      → *La barra de progreso tiene que avanzar de a poco, no saltar de 0 a 100
      al final.* Este es el punto que más conviene mirar: el progreso de
      faster-whisper se lee distinto que el de whisper.cpp.
- [ ] **F4.** Al terminar, el encabezado de la transcripción debe decir
      "Tiny · faster-whisper".
- [ ] **F5.** Volver el motor a whisper.cpp y comprobar que la tabla y el
      modelo en uso vuelven a los de antes, sin perder nada.

## Bloque G — Respaldo

- [ ] **G1.** Configuración › Respaldo. Comprobar que el número de archivos y
      el tamaño coinciden con lo que hay en `C:\ClassRecorder\grabaciones`.
- [ ] **G2.** Cambiar a **Solo datos**.
      → *El tamaño tiene que bajar muchísimo (sin los MP3).*
- [ ] **G3.** Exportar con **Todo** a una carpeta cualquiera.
- [ ] **G4.** Abrir el .zip: debe traer `datos/datos.json`, `datos/config.json`
      y `grabaciones/<clase>/<unidad>/…` con los audios y los .txt.
- [ ] **G5.** Confirmar que **no** entró ningún `.webm.part` ni `.parcial.json`.

## Bloque H — Silencio y pendientes

- [ ] **H1.** Configuración: dejar "Avisar si no se oye nada durante" en **1**
      minuto (para no esperar dos).
- [ ] **H2.** Empezar a grabar y silenciar el micrófono (o desenchufarlo) más
      de un minuto.
      → *Tiene que aparecer el aviso "Hace X que no se detecta sonido", y la
      grabación tiene que seguir corriendo igual.*
- [ ] **H3.** Volver a hablar. → *El aviso desaparece solo.*
- [ ] **H4.** Biblioteca › **Pendientes**: la pestaña muestra el número de
      grabaciones sin transcribir y las lista con su tiempo estimado.
- [ ] **H5.** "Transcribir todas" muestra el total estimado antes de encolar.
      Cancelar sin confirmar y comprobar que no encoló nada.

## Bloque I — Calendario

- [ ] **I1.** Biblioteca › Calendario. Alternar **Mes** y **Semana**.
- [ ] **I2.** Los días con grabaciones sin transcribir llevan una línea ámbar
      abajo; los que están todos transcritos, no.
- [ ] **I3.** Clic en un día → lista con hora, clase, unidad y duración.
      Clic en una de esas filas → se abre en el panel de la derecha.
- [ ] **I4.** Clic en una clase de la leyenda → sus puntos desaparecen del
      calendario. Volver a hacer clic los devuelve.
- [ ] **I5.** Botón **Hoy** vuelve al día actual desde cualquier mes.

## Bloque J — Markdown

- [ ] **J1.** Abrir una grabación transcrita › **Exportar Markdown**.
- [ ] **J2.** Abrir el .md: encabezado con clase, unidad, fecha y duración, y
      el cuerpo partido en secciones `### mm:ss` cada 5 minutos.

## Limpieza

- [ ] **L1.** Borrar las grabaciones de prueba desde la Biblioteca (con
      "Borrar también los archivos").
- [ ] **L2.** Borrar las clases `ZZ Prueba` y `ZZ Prueba 2` desde Clases.
- [ ] **L3.** Comprobar que el pie de la barra lateral volvió a los números de P1.

---

## Cómo reportar un fallo

Anotar el número del paso, qué se esperaba y qué pasó. Si es un problema de
archivos, adjuntar la salida de este comando en PowerShell:

```bash
Get-ChildItem -Recurse "C:\ClassRecorder\grabaciones" | Select-Object FullName, Length, LastWriteTime
```
