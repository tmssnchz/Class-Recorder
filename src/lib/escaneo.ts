/**
 * Digitalización de una foto de apunte: análisis, recorte y guardado.
 *
 * El trabajo pesado (detección de esquinas, homografía, limpieza) vive en Rust
 * — ver `src-tauri/src/escaneo.rs`. Acá está la parte que decide dónde va cada
 * archivo y cómo queda armada la entrada del índice.
 *
 * Los apuntes se guardan al lado del material de estudio, dentro de la misma
 * carpeta de grabaciones, para que el proyecto siga siendo portable:
 *   carpeta_raiz/{clase}/{unidad}/materiales/apuntes/{titulo}/pagina-01.jpg
 */
import { invoke } from "@tauri-apps/api/core";
import { copyFile, exists, mkdir, remove } from "@tauri-apps/plugin-fs";

// Extensiones explícitas: el test corre con `node --experimental-strip-types`,
// sin el resolver de Vite.
import { carpetaMateriales } from "./materiales.ts";
import { nombreArchivo, sanitizarNombre, unir } from "./paths.ts";
import type {
  Apunte,
  Config,
  GeometriaPlantilla,
  ModoEscaneo,
  PaginaApunte,
} from "../types.ts";

export interface Esquina {
  x: number;
  y: number;
}

export interface AnalisisFoto {
  ancho: number;
  alto: number;
  /**
   * JPEG temporal con la orientación EXIF ya aplicada, que es lo que hay que
   * mostrar. El archivo original no sirve: las esquinas se calculan sobre la
   * imagen orientada, y si el webview aplicara el EXIF de otra forma la foto se
   * vería girada respecto de los tiradores.
   */
  vistaPrevia: string;
  /** TL, TR, BR, BL en píxeles de la foto. */
  esquinas: Esquina[];
  /**
   * Cómo se encontraron las esquinas: por tres o cuatro marcadores ArUco de la
   * plantilla (recorte exacto), por solo dos (bien ubicado y a escala, pero sin
   * corregir la inclinación de la cámara), por el borde del papel (aproximado),
   * o nada.
   */
  fuente: "marcadores" | "marcadores-parciales" | "contraste" | "ninguna";
  /**
   * Geometría con la que se calculó el recorte: la del papel configurado en
   * Ajustes, con la cara que le toca al número de página. La hoja no lleva la
   * suya. null solo cuando no se leyó ningún marcador, porque ahí no se sabe ni
   * si es una hoja de la plantilla ni por qué cara va.
   */
  geometria: GeometriaPlantilla | null;
  pagina: number | null;
  nitidez: number;
  brillo: number;
  hojasDetectadas: number;
  advertencias: string[];
}

/**
 * `geometriaDefecto` es el papel configurado, y es la única fuente del tamaño de
 * hoja: los marcadores solo dicen página y esquina, así que sin él no hay cómo
 * extrapolar de sus centros a las esquinas del papel.
 */
export const analizarFoto = (ruta: string, geometriaDefecto: GeometriaPlantilla) =>
  invoke<AnalisisFoto>("analizar_foto", { ruta, geometriaDefecto });

export interface RectificadoInfo {
  archivo: string;
  ancho: number;
  alto: number;
  bytes: number;
}

interface PedidoRectificar {
  ruta: string;
  salida: string;
  esquinas: Esquina[];
  geometria: GeometriaPlantilla;
  dpi: number;
  calidad: number;
  modo: ModoEscaneo;
  /**
   * Cuartos de vuelta horarios a aplicarle al recorte. Solo hacen falta cuando
   * las esquinas no vinieron de los marcadores: ahí la homografía ya deja la
   * hoja de pie sola. Ver `giroAutomatico` en `organizar.ts`.
   */
  cuartos: number;
}

export const rectificarFoto = (pedido: PedidoRectificar) =>
  invoke<RectificadoInfo>("rectificar_foto", { pedido });

/**
 * PNG del marcador ArUco de una esquina. Reemplazó al QR en las esquinas: en
 * los mismos 10 mm impresos cada celda mide 1,43 mm contra 0,40 mm de un módulo
 * de QR, que es lo que decide si una impresora que entrega gris sirve o no.
 */
export const generarMarcadorPng = (pagina: number, esquina: number, px: number) =>
  invoke<string>("generar_marcador_png", { pagina, esquina, px });

/**
 * Por debajo de esto la foto está movida. El mismo número que usa el backend;
 * acá se repite para poder avisar en la interfaz sin volver a llamar a Rust.
 */
export const NITIDEZ_MINIMA = 60;

export function fotoUtilizable(a: AnalisisFoto): boolean {
  return a.nitidez >= NITIDEZ_MINIMA && a.brillo >= 60 && a.brillo <= 225;
}

// ------------------------------------------------------------------ rutas

/** Carpeta propia de un apunte, dentro del material de su nivel. */
export function carpetaApunte(
  carpetaRaiz: string,
  claseNombre: string,
  unidadNombre: string | null,
  titulo: string,
): string {
  return unir(
    carpetaMateriales(carpetaRaiz, claseNombre, unidadNombre),
    "apuntes",
    sanitizarNombre(titulo),
  );
}

/** Nombre libre para la carpeta de un apunte (agrega _2, _3… si ya existe). */
export async function carpetaLibre(base: string): Promise<string> {
  let ruta = base;
  let intento = 2;
  while (await exists(ruta)) {
    ruta = `${base}_${intento++}`;
  }
  return ruta;
}

export function nombrePagina(numero: number): string {
  return `pagina-${numero.toString().padStart(2, "0")}.jpg`;
}

// -------------------------------------------------------------- pipeline

export interface DestinoApunte {
  carpeta: string;
  /** Número que va a tener la página dentro del apunte. */
  numero: number;
}

/**
 * Convierte una foto en una página lista para el índice: la rectifica al
 * tamaño de papel indicado, la guarda dentro de la carpeta del apunte y
 * opcionalmente archiva la foto original al lado.
 *
 * No toca el archivo de origen: archivarlo en el Inbox (o no) lo decide quien
 * llama, igual que en la importación de audio.
 */
export async function digitalizarFoto(
  rutaOrigen: string,
  analisis: AnalisisFoto,
  esquinas: Esquina[],
  geometria: GeometriaPlantilla,
  destino: DestinoApunte,
  config: Config,
  cuartos = 0,
): Promise<PaginaApunte> {
  const opciones = config.apuntes;
  if (!(await exists(destino.carpeta))) {
    await mkdir(destino.carpeta, { recursive: true });
  }

  const salida = unir(destino.carpeta, nombrePagina(destino.numero));
  const info = await rectificarFoto({
    ruta: rutaOrigen,
    salida,
    esquinas,
    geometria,
    dpi: opciones.dpiEscaneo,
    calidad: opciones.calidadEscaneo,
    modo: opciones.modoEscaneo,
    cuartos,
  });

  if (info.bytes === 0) {
    // Un JPEG vacío se ve como una página válida en el índice y después no
    // abre: mejor fallar acá que dejar el apunte roto.
    if (await exists(salida)) await remove(salida);
    throw new Error(`No se pudo digitalizar ${nombreArchivo(rutaOrigen)}: el recorte quedó vacío.`);
  }

  let original: string | null = null;
  if (opciones.conservarOriginal) {
    const carpetaOriginales = unir(destino.carpeta, "originales");
    if (!(await exists(carpetaOriginales))) {
      await mkdir(carpetaOriginales, { recursive: true });
    }
    original = unir(
      carpetaOriginales,
      `${destino.numero.toString().padStart(2, "0")}-${nombreArchivo(rutaOrigen)}`,
    );
    await copyFile(rutaOrigen, original);
  }

  return {
    id: crypto.randomUUID(),
    archivo: info.archivo,
    original,
    numero: destino.numero,
    ancho: info.ancho,
    alto: info.alto,
    bytes: info.bytes,
    texto: "",
    motorHtr: null,
    textoEditado: false,
    soloVisual: false,
    advertencias: analisis.advertencias,
  };
}

/**
 * Renumera las páginas después de reordenarlas o borrar una. Solo toca el
 * número: los archivos no se renombran, porque hacerlo obligaría a rehacer las
 * rutas del índice cada vez que se arrastra una página en la lista.
 */
export function renumerar(paginas: PaginaApunte[]): PaginaApunte[] {
  return paginas.map((p, i) => ({ ...p, numero: i + 1 }));
}

/**
 * Ordena por el número de página que traían los marcadores de la hoja. Las que
 * no traen ninguno quedan al final, en el orden en que se escanearon, para que
 * el usuario las acomode a mano.
 */
export function ordenarPorMarcador(
  paginas: PaginaApunte[],
  numerosPagina: Map<string, number | null>,
): PaginaApunte[] {
  const conNumero = paginas.filter((p) => numerosPagina.get(p.id) != null);
  const sinNumero = paginas.filter((p) => numerosPagina.get(p.id) == null);
  conNumero.sort((a, b) => (numerosPagina.get(a.id) ?? 0) - (numerosPagina.get(b.id) ?? 0));
  return renumerar([...conNumero, ...sinNumero]);
}

/**
 * Marca que el motor de reconocimiento *debería* dejar donde había un dibujo.
 *
 * Medido sobre hojas reales con GLM-OCR y tres formulaciones distintas del
 * prompt: **no la emite nunca**. Es un modelo especializado en transcribir, y
 * las instrucciones de formato las ignora en buena parte. Se deja pedida en el
 * prompt porque no cuesta nada y otros motores podrían respetarla, pero no hay
 * que contar con ella: lo que funciona de verdad es la casilla "esta hoja es
 * sobre todo un diagrama" del editor, que marca la página a mano.
 */
export const MARCA_DIAGRAMA = "[diagrama]";

/** true si lo reconocido es sobre todo un dibujo y casi nada de texto. */
export function esSoloVisual(texto: string): boolean {
  // split/join y no replaceAll: el target del proyecto es ES2020.
  const sinMarcas = texto.split(MARCA_DIAGRAMA).join("").split("[?]").join("").trim();
  return texto.includes(MARCA_DIAGRAMA) && sinMarcas.length < 40;
}

/** Todo el texto reconocido de un apunte, en orden de página. */
export function textoDe(apunte: Apunte): string {
  return apunte.paginas
    .slice()
    .sort((a, b) => a.numero - b.numero)
    .map((p) => (p.soloVisual && !p.texto ? `[página ${p.numero}: contenido visual]` : p.texto))
    .filter(Boolean)
    .join("\n\n");
}
