// Modelo de datos de ClassRecorder.
// Todo se persiste en JSON local: no hay backend ni base de datos externa.

export type FormatoAudio = "mp3" | "wav";
export type MotorTranscripcion = "whisper.cpp" | "faster-whisper" | "api";

/** Proveedores de transcripción por API compatibles con el formato OpenAI. */
export type ProveedorApi = "groq" | "openai" | "personalizado";

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
  /**
   * Id del modelo con el que se generó: GGML o CTranslate2 según el motor
   * local, o el nombre del `PerfilApi` usado cuando `motor === "api"`.
   */
  modelo: IdModelo | IdModeloFaster | string;
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
  /** Qué se conversó en la clase, escrita al detener o después desde el detalle. */
  notaClase: string;
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

// ------------------------------------------------- apuntes escaneados

/**
 * Motor de reconocimiento de texto manuscrito.
 *
 * Los tres locales son VLM en GGUF que corren con `llama-mtmd-cli.exe`, el
 * mismo patrón de "ejecutable descargado aparte" que whisper.cpp. "api" manda
 * la imagen a un proveedor externo, con las mismas claves que ya se usan para
 * la transcripción de audio.
 */
export type MotorHtr = "glm-ocr" | "dots-ocr" | "lighton-ocr" | "api";

export type IdModeloHtr = "glm-ocr" | "dots-ocr" | "lighton-ocr";

/** Lado del cuaderno donde va el anillado: ahí no se imprime nada. */
export type LadoAnillado = "izquierda" | "derecha" | "arriba";

export type ModoEscaneo = "color" | "gris" | "original";

/**
 * Geometría de una hoja de la plantilla imprimible. Nada de esto está fijo en
 * el código: viaja dentro del propio QR, así que agregar un tamaño de papel es
 * agregar una entrada al catálogo y nada más.
 */
export interface GeometriaPlantilla {
  anchoMm: number;
  altoMm: number;
  margenAnilladoMm: number;
  ladoAnillado: LadoAnillado;
}

/** Una hoja digitalizada dentro de un apunte. */
export interface PaginaApunte {
  id: string;
  /** Ruta absoluta del JPEG ya rectificado y limpio. */
  archivo: string;
  /** Foto original archivada, o null si el usuario eligió no conservarla. */
  original: string | null;
  /** Orden dentro del apunte, empezando en 1. */
  numero: number;
  ancho: number;
  alto: number;
  bytes: number;
  /** Texto reconocido. Editable: es lo que se indexa para la búsqueda. */
  texto: string;
  /** Motor con el que se reconoció. null = todavía sin reconocer. */
  motorHtr: MotorHtr | null;
  /** true si el usuario lo corrigió a mano: un re-reconocimiento no lo pisa. */
  textoEditado: boolean;
  /**
   * true cuando la hoja es sobre todo un diagrama o un esquema. Se marca en
   * vez de forzar un texto reconocido que sería inventado.
   */
  soloVisual: boolean;
  /** Avisos del análisis de la foto (movida, oscura, sin marcadores…). */
  advertencias: string[];
}

/**
 * Apunte de papel digitalizado. Cuelga de exactamente uno de los tres niveles
 * (clase, unidad o grabación), igual que un `Material`, pero es su propia
 * entidad porque tiene páginas ordenadas y texto reconocido editable, que no
 * entran en el modelo de un archivo suelto.
 */
export interface Apunte {
  id: string;
  titulo: string;
  claseId: string | null;
  unidadId: string | null;
  grabacionId: string | null;
  claseNombre: string;
  unidadNombre: string;
  carpeta: string;
  fechaISO: string;
  paginas: PaginaApunte[];
  /** Idioma que se le declara al motor de reconocimiento. */
  idioma: string;
  /** .txt con el texto de todas las páginas, para la búsqueda de la biblioteca. */
  archivoTexto: string;
  tags: string[];
  /**
   * Id del apunte que este reemplaza cuando se vuelve a escanear la misma
   * hoja. El viejo no se borra: queda como versión anterior.
   */
  reemplazaA: string | null;
}

/**
 * Un bloque del horario semanal. `dia` va de 1 (lunes) a 7 (domingo), como
 * ISO-8601, para poder ordenar y comparar sin depender del nombre escrito.
 */
export interface BloqueHorario {
  id: string;
  dia: number;
  /** "HH:mm" en 24 horas. */
  inicio: string;
  fin: string;
  claseId: string;
}

export const DIAS_SEMANA = [
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
  "domingo",
] as const;

export interface BaseDatos {
  version: number;
  clases: Clase[];
  grabaciones: Grabacion[];
  materiales: Material[];
  apuntes: Apunte[];
  horario: BloqueHorario[];
}

export interface Atajos {
  grabar: string;
  pausar: string;
  detener: string;
  marcar: string;
}

/**
 * Dónde vive la carpeta de grabaciones. Google Drive nunca queda en modo
 * ahorro de espacio: siempre mantiene una copia completa en disco.
 */
export type ModoAlmacenamiento = "local" | "onedrive" | "googledrive";

export interface Config {
  formatoAudio: FormatoAudio;
  modoAlmacenamiento: ModoAlmacenamiento;
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
  /**
   * true = mientras la clase se graba, el motor local va transcribiendo el
   * audio ya escrito en ventanas de pocos minutos, así al detener queda poco o
   * nada pendiente. Cuesta CPU durante toda la clase y solo usa el motor local
   * (las APIs siguen transcribiendo después de grabar).
   */
  transcripcionParalela: boolean;
  /** Hilos de CPU para whisper. null = decidir según la máquina. */
  hilosWhisper: number | null;
  atajos: Atajos;
  /** true = los atajos se registran a nivel sistema y funcionan con la app minimizada. */
  atajosGlobales: boolean;
  /** false = ningún atajo se registra. Útil en teclados compactos con muchos choques. */
  atajosActivos: boolean;
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
  /** Plantilla editable del prompt para importar el horario con una IA externa. */
  plantillaPromptHorario: string;
  /**
   * Con qué se graban los audios que se importan. Se pregunta una sola vez, la
   * primera vez que un nombre de archivo no trae fecha reconocible.
   * null = todavía no se preguntó.
   */
  origenGrabaciones: "iphone" | "android" | "otro" | null;
  /**
   * true = el usuario aceptó usar la hora de subida cuando no hay mejor señal.
   * null = todavía no se preguntó.
   */
  usarHoraDeSubida: boolean | null;
  /** Transcripción vía API externa (Groq/OpenAI/personalizado), con la propia key del usuario. */
  apiTranscripcion: ConfigApiTranscripcion;
  /** Digitalización de apuntes escritos a mano. */
  apuntes: ConfigApuntes;
}

export interface ConfigApuntes {
  /** Motor de reconocimiento que se usa sin preguntar. */
  motor: MotorHtr;
  /** Modelo local elegido, aunque el motor esté puesto en "api". */
  modelo: IdModeloHtr;
  /** Idioma del texto manuscrito, igual que `idiomaTranscripcion` para el audio. */
  idioma: string;
  /** Resolución del escaneo guardado. 200 dpi alcanza para leer manuscrita. */
  dpiEscaneo: number;
  /** Calidad JPEG del escaneo guardado. */
  calidadEscaneo: number;
  /**
   * Cómo se guarda el escaneo:
   *   "color"    limpia sombras y conserva la tinta (resaltador, rojo)
   *   "gris"     limpia sombras y va a escala de grises: archivo más liviano
   *   "original" sin limpieza, la foto rectificada tal cual
   */
  modoEscaneo: ModoEscaneo;
  /**
   * true = la foto original queda archivada junto al escaneo. Ocupa el doble,
   * pero permite volver a recortar si el encuadre salió mal.
   */
  conservarOriginal: boolean;
  /** Papel de la plantilla imprimible que usa este usuario. */
  plantilla: GeometriaPlantilla;
  /**
   * true = cuando se leen los cuatro marcadores y no hay avisos, la hoja se
   * confirma sola y se pasa a la siguiente. Las que dan problema quedan
   * pendientes al final, para resolverlas juntas.
   */
  confirmacionAutomatica: boolean;
  /** Imprimir el número de página abajo de cada hoja. */
  numeroDePagina: boolean;
  /**
   * Cuál de las dos caras sale primero al reimprimir el reverso. Se calibra
   * una vez con la hoja de prueba, porque depende de la impresora.
   */
  reversoEnOrdenInverso: boolean;
}

/** Una clave de API guardada, con un nombre propio para distinguirla de otras. */
export interface PerfilApi {
  id: string;
  /** Nombre que le puso el usuario, ej. "Groq personal". */
  nombre: string;
  proveedor: ProveedorApi;
  /** Solo se usa cuando proveedor === "personalizado". */
  urlPersonalizada: string;
  /**
   * Clave cifrada con DPAPI (ligada al usuario de Windows), en hexadecimal.
   * Nunca se guarda ni se transmite en texto plano. null = no configurada.
   */
  claveCifrada: string | null;
}

/**
 * Motor que se usa sin preguntar, salvo que se elija otro al transcribir.
 * "multiapi" prueba los perfiles en orden y rota al siguiente si uno se
 * queda sin cupo (pensado para dejar la cola corriendo de noche).
 */
export type MotorPredeterminado =
  | { tipo: "local" }
  | { tipo: "api"; perfilId: string }
  | { tipo: "multiapi" };

export interface ConfigApiTranscripcion {
  habilitada: boolean;
  perfiles: PerfilApi[];
  predeterminado: MotorPredeterminado;
}

export const VERSION_BD = 1;

export const BASE_DATOS_VACIA: BaseDatos = {
  version: VERSION_BD,
  clases: [],
  grabaciones: [],
  materiales: [],
  apuntes: [],
  horario: [],
};

export const CONFIG_POR_DEFECTO: Config = {
  formatoAudio: "mp3",
  modoAlmacenamiento: "local",
  carpetaRaiz: "C:\\ClassRecorder\\grabaciones",
  microfonoId: null,
  motorTranscripcion: "whisper.cpp",
  modelo: "small-q5_1",
  modeloFaster: "fw-small",
  idiomaTranscripcion: "es",
  transcripcionesSimultaneas: 1,
  transcripcionParalela: false,
  hilosWhisper: null,
  atajos: {
    grabar: "F9",
    pausar: "F10",
    detener: "F11",
    marcar: "F8",
  },
  atajosGlobales: true,
  atajosActivos: true,
  umbralDiscoGB: 2,
  minutosSilencioAviso: 2,
  carpetaInbox: null,
  // Se completa al cargar la config: la plantilla vive en lib/horario.ts para
  // no tener el texto largo dando vueltas en el modelo de datos.
  plantillaPromptHorario: "",
  origenGrabaciones: null,
  usarHoraDeSubida: null,
  apiTranscripcion: {
    habilitada: false,
    perfiles: [],
    predeterminado: { tipo: "local" },
  },
  apuntes: {
    motor: "glm-ocr",
    modelo: "glm-ocr",
    idioma: "es",
    dpiEscaneo: 200,
    calidadEscaneo: 82,
    modoEscaneo: "color",
    confirmacionAutomatica: true,
    numeroDePagina: true,
    conservarOriginal: true,
    // B5 con anillado a la izquierda: el cuaderno tipo binder más común.
    plantilla: {
      anchoMm: 176,
      altoMm: 250,
      margenAnilladoMm: 18,
      ladoAnillado: "izquierda",
    },
    reversoEnOrdenInverso: true,
  },
};

/** Paleta para asignar color a las clases nuevas. */
/**
 * Paleta por defecto. Diez tonos elegidos para distinguirse entre sí también
 * como puntos chicos en el calendario, donde solo se ve el color.
 */
export const COLORES_CLASE = [
  "#2f6fed", // azul
  "#12a594", // verde azulado
  "#d4682a", // naranja
  "#8b5cf6", // violeta
  "#e0407a", // rosa
  "#3f8f3f", // verde
  "#c9a227", // mostaza
  "#0891b2", // celeste
  "#b4413c", // rojo ladrillo
  "#5a6b7d", // gris azulado
];
