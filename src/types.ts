// Modelo de datos de ClassRecorder.
// Todo se persiste en JSON local: no hay backend ni base de datos externa.

export type FormatoAudio = "mp3" | "wav";
export type MotorTranscripcion = "whisper.cpp" | "faster-whisper";

/**
 * Modelos GGML disponibles. Los que terminan en q5_0/q5_1 están cuantizados:
 * ocupan la mitad y andan más rápido, con una pérdida de calidad mínima.
 */
export type IdModelo =
  | "tiny-q5_1"
  | "tiny"
  | "base-q5_1"
  | "base"
  | "small-q5_1"
  | "small"
  | "medium-q5_0"
  | "medium"
  | "large-v3-turbo-q5_0";

/**
 * Modelos de faster-whisper. Son CTranslate2, no GGML: otra descarga y otro
 * catálogo, por eso cada motor guarda su modelo elegido por separado.
 * La cuantización acá no es parte del archivo sino del `--compute_type`
 * que se pasa al ejecutar (usamos int8).
 */
export type IdModeloFaster =
  | "fw-tiny"
  | "fw-base"
  | "fw-small"
  | "fw-medium"
  | "fw-large-v3";

export interface Unidad {
  id: string;
  nombre: string;
  creadaEn: string; // ISO
}

export interface Clase {
  id: string;
  nombre: string;
  color: string; // para diferenciarlas visualmente
  creadaEn: string; // ISO
  unidades: Unidad[];
}

/** Momento importante marcado durante la grabación. */
export interface Marca {
  id: string;
  segundo: number;
  nota: string;
}

/** Fragmento de transcripción con su posición exacta dentro del audio. */
export interface Segmento {
  desdeMs: number;
  hastaMs: number;
  texto: string;
}

export interface Transcripcion {
  archivo: string; // ruta absoluta del .txt
  /** .segmentos.json: los tiempos van aparte para no inflar datos.json. */
  archivoSegmentos: string;
  motor: MotorTranscripcion;
  /** Id del modelo con el que se generó: GGML o CTranslate2 según el motor. */
  modelo: IdModelo | IdModeloFaster;
  fechaISO: string;
  palabras: number;
  /** Cuánto tardó en transcribirse, para poder estimar las próximas. */
  duracionProcesoSeg: number;
}

/**
 * "convirtiendo": el audio existe como .webm y ffmpeg está trabajando.
 * "error-conversion": el .webm quedó en disco y se puede reproducir igual.
 */
export type EstadoGrabacion = "convirtiendo" | "listo" | "error-conversion";

export const SIN_CLASE = "Sin clasificar";
export const SIN_UNIDAD = "Sin unidad";

export interface Grabacion {
  id: string;
  /** null cuando se grabó sin elegir clase (va a la carpeta "Sin clasificar"). */
  claseId: string | null;
  unidadId: string | null;
  /** Nombres congelados al momento de grabar: la ruta en disco ya quedó escrita con estos. */
  claseNombre: string;
  unidadNombre: string;
  titulo: string;
  archivoAudio: string; // ruta absoluta
  carpeta: string; // ruta absoluta de la carpeta contenedora
  fechaISO: string;
  duracionSeg: number;
  formato: FormatoAudio | "webm";
  bytes: number;
  estado: EstadoGrabacion;
  errorConversion?: string | null;
  tags: string[];
  marcas: Marca[];
  transcripcion: Transcripcion | null;
}

/** Extensiones que se aceptan como material de estudio. */
export const EXTENSIONES_MATERIAL = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "md",
  "ppt",
  "pptx",
  "doc",
  "docx",
] as const;

/**
 * Archivo de estudio (apunte, presentación, foto del pizarrón) copiado dentro
 * de la carpeta de grabaciones para que el proyecto siga siendo portable.
 *
 * Cuelga de exactamente uno de los tres niveles: clase, unidad o grabación.
 * Los otros dos campos quedan en null — es lo que permite mostrar el material
 * de la clase y el de la unidad al abrir una grabación, sin mezclarlos.
 */
export interface Material {
  id: string;
  /** Nombre del archivo tal como quedó en disco (ya sin colisiones). */
  nombre: string;
  archivo: string; // ruta absoluta
  bytes: number;
  agregadoEn: string; // ISO
  claseId: string | null;
  unidadId: string | null;
  grabacionId: string | null;
}

export type NivelMaterial = "clase" | "unidad" | "grabacion";

export interface BaseDatos {
  version: number;
  clases: Clase[];
  grabaciones: Grabacion[];
  materiales: Material[];
}

export interface Atajos {
  grabar: string;
  pausar: string;
  detener: string;
  marcar: string;
}

export interface Config {
  formatoAudio: FormatoAudio;
  carpetaRaiz: string;
  microfonoId: string | null;
  motorTranscripcion: MotorTranscripcion;
  /** Modelo GGML, usado cuando el motor es whisper.cpp. */
  modelo: IdModelo;
  /** Modelo CTranslate2, usado cuando el motor es faster-whisper. */
  modeloFaster: IdModeloFaster;
  idiomaTranscripcion: string;
  /** Cuántas transcripciones corren a la vez. */
  transcripcionesSimultaneas: number;
  /** Hilos de CPU para whisper. null = decidir según la máquina. */
  hilosWhisper: number | null;
  atajos: Atajos;
  /** true = los atajos se registran a nivel sistema y funcionan con la app minimizada. */
  atajosGlobales: boolean;
  umbralDiscoGB: number;
  /**
   * Minutos de silencio seguidos que disparan el aviso de "¿micrófono
   * desconectado?". 0 lo desactiva. Nunca detiene la grabación: solo avisa.
   */
  minutosSilencioAviso: number;
  /**
   * Carpeta ClassRecorder_Inbox dentro del Drive sincronizado del usuario.
   * null = todavía no configuró la importación desde el celular.
   */
  carpetaInbox: string | null;
}

export const VERSION_BD = 1;

export const BASE_DATOS_VACIA: BaseDatos = {
  version: VERSION_BD,
  clases: [],
  grabaciones: [],
  materiales: [],
};

export const CONFIG_POR_DEFECTO: Config = {
  formatoAudio: "mp3",
  carpetaRaiz: "C:\\ClassRecorder\\grabaciones",
  microfonoId: null,
  motorTranscripcion: "whisper.cpp",
  modelo: "small-q5_1",
  modeloFaster: "fw-small",
  idiomaTranscripcion: "es",
  transcripcionesSimultaneas: 1,
  hilosWhisper: null,
  atajos: {
    grabar: "F9",
    pausar: "F10",
    detener: "F11",
    marcar: "F8",
  },
  atajosGlobales: true,
  umbralDiscoGB: 2,
  minutosSilencioAviso: 2,
  carpetaInbox: null,
};

/** Paleta para asignar color a las clases nuevas. */
export const COLORES_CLASE = [
  "#2f6fed",
  "#12a594",
  "#d4682a",
  "#8b5cf6",
  "#e0407a",
  "#3f8f3f",
  "#c9a227",
  "#5a6b7d",
];
