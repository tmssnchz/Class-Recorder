//! Digitalización de apuntes escritos a mano: detección de la hoja dentro de
//! la foto, corrección de perspectiva y limpieza tipo "escaneado".
//!
//! Todo se hace con crates de Rust puro (`image`, `imageproc`, `rqrr`,
//! `qrcode`), sin OpenCV ni un servicio de Python aparte. La razón es la misma
//! por la que whisper.cpp se distribuye como .exe descargable y no como una
//! instalación de Python: el instalador tiene que seguir pesando pocos MB y la
//! app tiene que funcionar sin dependencias externas del sistema.
//!
//! Hay dos modos de detección:
//!   - Con los cuatro QR de la plantilla imprimible: se leen sus centros y se
//!     sabe de antemano en qué milímetro de la hoja está cada uno, así que la
//!     homografía sale exacta aunque los QR no formen un rectángulo simétrico
//!     (el margen de anillado corre dos de ellos hacia adentro).
//!   - Sin QR: por contraste hoja/fondo. Es más frágil, y por eso la interfaz
//!     siempre deja corregir las cuatro esquinas a mano.

use std::path::Path;

use image::{DynamicImage, GrayImage, ImageBuffer, Luma, Rgb, RgbImage};
use imageproc::contours::{find_contours, BorderType};
use imageproc::distance_transform::Norm;
use imageproc::geometric_transformations::{warp_into, Border, Interpolation, Projection};
use imageproc::geometry::{approximate_polygon_dp, arc_length, convex_hull};
use imageproc::point::Point;
use serde::{Deserialize, Serialize};

use crate::marcadores::{self, MarcadorLeido};

/// Lado del cuaderno donde va el anillado. Ahí no se imprime nada.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LadoAnillado {
    Izquierda,
    Derecha,
    Arriba,
}

/// Geometría de una plantilla imprimible. Los tamaños de papel no están
/// hardcodeados en ningún lado: viajan dentro del propio QR, así que agregar
/// A5 o cualquier otro formato no toca este archivo.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometriaPlantilla {
    pub ancho_mm: f32,
    pub alto_mm: f32,
    pub margen_anillado_mm: f32,
    pub lado_anillado: LadoAnillado,
}

/// Lado del cuadrado impreso de cada QR, zona de silencio incluida.
///
/// Son 14 mm y no 10 por una razón medida: un QR de versión 1 son 21 módulos
/// más 4 de zona de silencio por lado, o sea 29 módulos de ancho impreso. A
/// 10 mm cada módulo mide 0,34 mm, y en la parte baja de una foto sacada en
/// ángulo esos módulos caen a ~2 píxeles: el lector encuentra el código pero
/// la corrección de errores no alcanza y falla el decodificado. A 14 mm cada
/// módulo mide 0,48 mm y sobra margen incluso en la esquina más escorzada.
///
/// ponytail: si alguna vez hay que achicarlo, la salida no es bajar este
/// número sino sacar la zona de silencio del PNG y apoyarse en el papel
/// blanco de alrededor.
pub const LADO_QR_MM: f32 = 14.0;
/// Separación entre el borde del papel y el borde del QR.
pub const MARGEN_BORDE_MM: f32 = 8.0;

/// Lado del cuadrado de tinta que se imprime de verdad.
///
/// Es menor que `LADO_QR_MM` porque la zona de silencio no se imprime: el papel
/// de alrededor ya es blanco y cumple exactamente esa función. Los 21 módulos
/// de datos en 10 mm miden 0,476 mm cada uno, prácticamente lo mismo que los 29
/// módulos (datos + silencio) en 14 mm. O sea: el marcador se ve un 29% más
/// chico sin perder nada de legibilidad.
///
/// `LADO_QR_MM` sigue siendo 14 a propósito: es el espacio que la plantilla
/// reserva, y de él salen los centros. Separarlo del tamaño impreso permite
/// achicar la tinta sin mover ni un milímetro la geometría, así que las hojas
/// ya impresas se siguen leyendo igual.
// Lo consume el generador de la plantilla desde TypeScript, no el backend.
#[allow(dead_code)]
pub const LADO_QR_IMPRESO_MM: f32 = 10.0;

impl GeometriaPlantilla {
    /// Centro de cada QR en milímetros, en el orden fijo que usa toda la app:
    /// 0 = superior izquierda, 1 = superior derecha, 2 = inferior derecha,
    /// 3 = inferior izquierda.
    ///
    /// El margen de anillado se suma solo del lado que corresponde, así que
    /// los cuatro centros no forman un rectángulo centrado. Es a propósito.
    pub fn centros_qr_mm(&self) -> [(f32, f32); 4] {
        let c = MARGEN_BORDE_MM + LADO_QR_MM / 2.0;
        let anillado = self.margen_anillado_mm;

        let izq = c + if self.lado_anillado == LadoAnillado::Izquierda { anillado } else { 0.0 };
        let der = self.ancho_mm
            - c
            - if self.lado_anillado == LadoAnillado::Derecha { anillado } else { 0.0 };
        let arr = c + if self.lado_anillado == LadoAnillado::Arriba { anillado } else { 0.0 };
        let aba = self.alto_mm - c;

        [(izq, arr), (der, arr), (der, aba), (izq, aba)]
    }
}

// ------------------------------------------------------------- payload QR

/// Contenido de cada QR de la plantilla. Corto a propósito: a 10 mm impresos,
/// un QR de versión baja se lee desde mucho más lejos y con peor foco.
///
/// Formato: `CR1:176X250:L18:0:7`
///   CR1      versión del formato
///   176X250  ancho x alto del papel en mm
///   L18      lado del anillado (L/R/T) y su margen en mm
///   0        índice de esquina (0..3)
///   7        número de página impreso en la hoja
///
/// Todo en mayúsculas y sin caracteres raros a propósito: así entra en el modo
/// alfanumérico del QR, que es el más compacto para este contenido.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MarcaQr {
    pub geometria: GeometriaPlantilla,
    pub esquina: usize,
    pub pagina: u32,
}

/// Nombre de cada esquina en el orden fijo 0..3, para poder decir cuál falló
/// en vez de un "3 de 4" que no ayuda a mover la foto ni la luz.
pub const NOMBRES_ESQUINA: [&str; 4] = [
    "superior izquierda",
    "superior derecha",
    "inferior derecha",
    "inferior izquierda",
];

fn letra_lado(lado: LadoAnillado) -> char {
    match lado {
        LadoAnillado::Izquierda => 'L',
        LadoAnillado::Derecha => 'R',
        LadoAnillado::Arriba => 'T',
    }
}

pub fn formatear_marca(m: &MarcaQr) -> String {
    let g = m.geometria;
    format!(
        "CR1:{}X{}:{}{}:{}:{}",
        redondear(g.ancho_mm),
        redondear(g.alto_mm),
        letra_lado(g.lado_anillado),
        redondear(g.margen_anillado_mm),
        m.esquina,
        m.pagina
    )
}

/// Sin decimales cuando son enteros: `176` en vez de `176.0`, para que el QR
/// quede lo más corto posible.
fn redondear(v: f32) -> String {
    if (v - v.round()).abs() < 0.05 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.1}")
    }
}

pub fn parsear_marca(texto: &str) -> Option<MarcaQr> {
    let mut partes = texto.split(':');
    if partes.next()? != "CR1" {
        return None;
    }
    let (ancho, alto) = partes.next()?.split_once('X')?;
    let anillado = partes.next()?;
    let esquina: usize = partes.next()?.parse().ok()?;
    let pagina: u32 = partes.next()?.parse().ok()?;
    if esquina > 3 {
        return None;
    }

    let lado = match anillado.chars().next()? {
        'L' => LadoAnillado::Izquierda,
        'R' => LadoAnillado::Derecha,
        'T' => LadoAnillado::Arriba,
        _ => return None,
    };

    Some(MarcaQr {
        geometria: GeometriaPlantilla {
            ancho_mm: ancho.parse().ok()?,
            alto_mm: alto.parse().ok()?,
            margen_anillado_mm: anillado[1..].parse().ok()?,
            lado_anillado: lado,
        },
        esquina,
        pagina,
    })
}

// -------------------------------------------------------------- análisis

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Esquina {
    pub x: f32,
    pub y: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalisisFoto {
    pub ancho: u32,
    pub alto: u32,
    /// JPEG temporal con la orientación EXIF ya aplicada y reducido para la
    /// pantalla.
    ///
    /// La interfaz muestra esto y no el archivo original a propósito: las
    /// esquinas se calculan sobre la imagen ya orientada, y si el webview
    /// aplicara el EXIF de otra forma —o no lo aplicara— la foto se vería
    /// girada y los tiradores quedarían sobre otro sistema de coordenadas.
    /// Mostrando los mismos píxeles que se midieron, no hay forma de que se
    /// desincronicen.
    pub vista_previa: String,
    /// Esquinas de la hoja en píxeles de la foto, en orden TL, TR, BR, BL.
    pub esquinas: Vec<Esquina>,
    /// Cómo se encontraron las esquinas:
    ///   "marcadores" los cuatro ArUco de la plantilla — recorte exacto
    ///   "contraste"  el borde del papel, sin plantilla — aproximado
    ///   "ninguna"    no se encontró nada; las esquinas van a mano
    pub fuente: String,
    /// Geometría leída de los QR. null cuando se detectó por contraste: ahí
    /// el tamaño de papel lo tiene que elegir el usuario.
    pub geometria: Option<GeometriaPlantilla>,
    pub pagina: Option<u32>,
    /// Varianza del laplaciano: bajo = foto movida o desenfocada.
    pub nitidez: f32,
    /// Brillo medio 0-255, para avisar de fotos muy oscuras o quemadas.
    pub brillo: f32,
    /// Cuántas hojas distintas se vieron. >1 = fotografió dos páginas juntas.
    pub hojas_detectadas: usize,
    /// Textos listos para mostrar: nunca se procesa en silencio una foto mala.
    pub advertencias: Vec<String>,
}

/// Debajo de esto la foto está movida y el reconocimiento va a dar basura.
pub const NITIDEZ_MINIMA: f32 = 60.0;

fn abrir_con_orientacion(ruta: &Path) -> Result<DynamicImage, String> {
    let lector = image::ImageReader::open(ruta)
        .map_err(|e| format!("No se pudo abrir {}: {e}", ruta.display()))?
        .with_guessed_format()
        .map_err(|e| format!("No se reconoció el formato de {}: {e}", ruta.display()))?;

    let mut decoder = lector
        .into_decoder()
        .map_err(|e| format!("No se pudo leer {}: {e}", ruta.display()))?;
    // El celular no rota el archivo: deja la orientación en el EXIF. Aplicarla
    // acá evita que una foto vertical entre acostada al resto de la tubería.
    let orientacion = image::ImageDecoder::orientation(&mut decoder)
        .unwrap_or(image::metadata::Orientation::NoTransforms);

    let mut img = DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("No se pudo decodificar {}: {e}", ruta.display()))?;
    img.apply_orientation(orientacion);
    Ok(img)
}

/// Varianza del laplaciano, la medida clásica de desenfoque.
fn nitidez_de(gris: &GrayImage) -> f32 {
    let lap = imageproc::filter::laplacian_filter(gris);
    let n = (lap.width() * lap.height()) as f64;
    if n == 0.0 {
        return 0.0;
    }
    let mut suma = 0.0f64;
    let mut suma2 = 0.0f64;
    for p in lap.pixels() {
        let v = p[0] as f64;
        suma += v;
        suma2 += v * v;
    }
    let media = suma / n;
    ((suma2 / n) - media * media).max(0.0) as f32
}

fn brillo_de(gris: &GrayImage) -> f32 {
    let n = (gris.width() * gris.height()) as f64;
    if n == 0.0 {
        return 0.0;
    }
    let suma: f64 = gris.pixels().map(|p| p[0] as f64).sum();
    (suma / n) as f32
}

// ----------------------------------------------------- detección con QR

struct QrLeido {
    marca: MarcaQr,
    centro: (f32, f32),
}

/// Una sola pasada del lector sobre la imagen que se le dé.
///
/// `escala` es cuánto se encogió esa imagen respecto de la foto original: los
/// centros se devuelven siempre en coordenadas de la foto, no de la copia.
fn detectar_qrs(gris: &GrayImage, escala: f32) -> Vec<QrLeido> {
    let mut preparada = rqrr::PreparedImage::prepare(gris.clone());
    let mut salida = Vec::new();
    for grid in preparada.detect_grids() {
        let Ok((_, texto)) = grid.decode() else { continue };
        let Some(marca) = parsear_marca(&texto) else { continue };
        // El centroide de las cuatro esquinas no depende de en qué rotación
        // rqrr haya devuelto los bounds, que es justo lo que necesitamos.
        let cx = grid.bounds.iter().map(|p| p.x as f32).sum::<f32>() / 4.0;
        let cy = grid.bounds.iter().map(|p| p.y as f32).sum::<f32>() / 4.0;
        salida.push(QrLeido {
            marca,
            centro: (cx / escala, cy / escala),
        });
    }
    salida
}

/// Lee los marcadores probando varias versiones de la imagen hasta juntar los
/// cuatro.
///
/// Con una sola pasada sobre la foto cruda no alcanza, y está medido: en una
/// hoja impresa en gris claro y con un gradiente de luz de un lado a otro,
/// rqrr encuentra las cuatro cuadrículas pero la corrección de errores falla
/// en tres de ellas. Las dos pasadas extra atacan cada causa por separado:
///
///   1. cruda       — lo más rápido, y suele bastar con buena luz
///   2. binarizada  — umbral adaptativo con ventana chica. Es la que salva las
///                    impresiones claras: decide blanco/negro comparando cada
///                    píxel con sus vecinos inmediatos, así que no le importa
///                    que la tinta sea gris mientras haya contraste local
///   3. normalizada — divide por el fondo con un radio grande; arregla la
///                    iluminación despareja a escala de hoja
///   4. a media     — promedia la textura del papel, que a resolución completa
///      resolución    mete ruido dentro de cada módulo
///
/// Se corta apenas hay cuatro: cada pasada extra solo se paga cuando hace falta.
///
/// El orden importa y está medido. La normalización por división de fondo usa
/// un radio proporcional a la hoja (~150 px en una foto de 12 MP), parecido al
/// tamaño del propio marcador: el fondo se estima con el QR adentro y termina
/// aplanándolo. Por eso el umbral adaptativo, que trabaja con una ventana
/// mucho más chica, va antes.
fn leer_qrs(gris: &GrayImage) -> Vec<QrLeido> {
    // Por índice de esquina: el primero que se lea gana. Todas las pasadas
    // miran la misma hoja, así que da igual cuál lo encontró.
    let mut por_esquina: [Option<QrLeido>; 4] = [None, None, None, None];

    let mut juntar = |leidos: Vec<QrLeido>| {
        for qr in leidos {
            let i = qr.marca.esquina;
            if i < 4 && por_esquina[i].is_none() {
                por_esquina[i] = Some(qr);
            }
        }
        por_esquina.iter().filter(|e| e.is_some()).count()
    };

    if juntar(detectar_qrs(gris, 1.0)) == 4 {
        return por_esquina.into_iter().flatten().collect();
    }

    // El umbral adaptativo va sobre la mitad de resolución: a tamaño completo
    // son 12 millones de píxeles y tarda minutos, mientras que un marcador de
    // ~140 px sigue teniendo 3 píxeles por módulo a la mitad — de sobra para
    // decodificar, y de paso se promedia el ruido del papel.
    let media = image::imageops::resize(
        gris,
        gris.width() / 2,
        gris.height() / 2,
        image::imageops::FilterType::Triangle,
    );
    // Ventana chica, del orden de dos módulos impresos: lo bastante local como
    // para que un QR gris sobre papel blanco quede en blanco y negro limpio.
    // delta 6 deja el ruido del papel del lado del blanco.
    let radio = (media.width().max(media.height()) / 160).clamp(6, 24);
    let binarizada = imageproc::contrast::adaptive_threshold(&media, radio, 6);
    if juntar(detectar_qrs(&binarizada, 0.5)) == 4 {
        return por_esquina.into_iter().flatten().collect();
    }

    let normalizada = limpiar_escaneo(gris.clone());
    if juntar(detectar_qrs(&normalizada, 1.0)) < 4 {
        let media = image::imageops::resize(
            &normalizada,
            gris.width() / 2,
            gris.height() / 2,
            image::imageops::FilterType::Triangle,
        );
        juntar(detectar_qrs(&media, 0.5));
    }

    por_esquina.into_iter().flatten().collect()
}

/// Completa el cuarto marcador cuando solo se leyeron tres.
///
/// Los cuatro centros forman un rectángulo en milímetros — el margen de
/// anillado corre un lado entero, no una esquina suelta — así que bajo una
/// aproximación afín el que falta es la esquina opuesta del paralelogramo.
///
/// ponytail: es afín, no proyectivo. Con la foto sacada de frente el error es
/// de pocos píxeles; con la cámara muy inclinada se nota, y por eso quien lo
/// usa avisa en la interfaz y deja las esquinas para corregir a mano. La
/// alternativa (resolver la homografía con tres puntos) no existe: hacen falta
/// cuatro.
fn completar_cuarto(por_esquina: &mut [Option<QrLeido>; 4]) -> Option<usize> {
    let faltante = por_esquina.iter().position(|e| e.is_none())?;
    if por_esquina.iter().filter(|e| e.is_some()).count() != 3 {
        return None;
    }

    // En orden cíclico TL, TR, BR, BL: el opuesto es la suma de los vecinos
    // menos el de enfrente.
    let vecino_a = por_esquina[(faltante + 1) % 4].as_ref().unwrap();
    let opuesto = por_esquina[(faltante + 2) % 4].as_ref().unwrap();
    let vecino_b = por_esquina[(faltante + 3) % 4].as_ref().unwrap();

    let centro = (
        vecino_a.centro.0 + vecino_b.centro.0 - opuesto.centro.0,
        vecino_a.centro.1 + vecino_b.centro.1 - opuesto.centro.1,
    );
    let marca = MarcaQr {
        esquina: faltante,
        ..vecino_a.marca
    };
    por_esquina[faltante] = Some(QrLeido { marca, centro });
    Some(faltante)
}

/// Contraste local de los marcadores que se ven en la foto, aunque no se hayan
/// podido decodificar.
///
/// Es la única forma de distinguir dos fallas que en pantalla se ven igual: "no
/// hay marcadores en la foto" y "los marcadores están ahí pero la impresión
/// salió tan clara que no se leen". La segunda tiene arreglo del lado del
/// usuario, así que vale la pena medirla y decirla.
///
/// Nota: se mide contraste, no brillo. El color del papel no importa —
/// amarillento, reciclado o blanco puro desplazan la tinta y el papel juntos.
/// Lo que decide es cuánto se despega la tinta de lo que tiene al lado.
fn contraste_de_marcadores(gris: &GrayImage) -> Option<(usize, u8)> {
    let mut preparada = rqrr::PreparedImage::prepare(gris.clone());
    let cuadriculas = preparada.detect_grids();
    if cuadriculas.is_empty() {
        return None;
    }

    let mut contrastes = Vec::new();
    for g in &cuadriculas {
        let xs: Vec<i32> = g.bounds.iter().map(|p| p.x).collect();
        let ys: Vec<i32> = g.bounds.iter().map(|p| p.y).collect();
        let (x0, x1) = (*xs.iter().min()? as u32, *xs.iter().max()? as u32);
        let (y0, y1) = (*ys.iter().min()? as u32, *ys.iter().max()? as u32);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }

        let mut valores: Vec<u8> = Vec::new();
        for y in y0..y1.min(gris.height()) {
            for x in x0..x1.min(gris.width()) {
                valores.push(gris.get_pixel(x, y)[0]);
            }
        }
        if valores.len() < 100 {
            continue;
        }
        valores.sort_unstable();
        // Percentil 10 = la tinta, percentil 90 = el papel de alrededor.
        let tinta = valores[valores.len() / 10] as i32;
        let papel = valores[valores.len() * 9 / 10] as i32;
        contrastes.push((papel - tinta).max(0) as u32);
    }

    if contrastes.is_empty() {
        return None;
    }
    let medio = (contrastes.iter().sum::<u32>() / contrastes.len() as u32) as u8;
    Some((cuadriculas.len(), medio))
}

/// Debajo de este contraste la impresión está demasiado clara y la corrección
/// de errores del QR deja de dar. Medido sobre hojas reales: una impresión sana
/// da 150-220, y a 125-155 ya falla la mitad de los marcadores.
pub const CONTRASTE_MINIMO: u8 = 150;

/// Igual que `agrupar_por_pagina` pero para los marcadores ArUco de las
/// esquinas, que son la fuente principal desde que se migró.
///
/// Devuelve los cuatro centros en orden de esquina, qué esquina se estimó (si
/// alguna) y el número de página.
fn agrupar_marcadores(
    leidos: &[MarcadorLeido],
) -> Option<([(f32, f32); 4], Option<usize>, u32)> {
    let mut paginas: Vec<u32> = leidos.iter().map(|m| m.pagina).collect();
    paginas.sort_unstable();
    paginas.dedup();

    for pagina in paginas {
        let mut por_esquina: [Option<(f32, f32)>; 4] = [None; 4];
        for m in leidos.iter().filter(|m| m.pagina == pagina) {
            if m.esquina < 4 {
                por_esquina[m.esquina] = Some(m.centro);
            }
        }

        // Mismo truco que con los QR: los cuatro centros forman un rectángulo
        // en milímetros, así que el que falta es la esquina opuesta del
        // paralelogramo. Ver `completar_cuarto`.
        let faltante = por_esquina.iter().position(|e| e.is_none());
        let estimado = match faltante {
            Some(i) if por_esquina.iter().filter(|e| e.is_some()).count() == 3 => {
                let a = por_esquina[(i + 1) % 4].unwrap();
                let o = por_esquina[(i + 2) % 4].unwrap();
                let b = por_esquina[(i + 3) % 4].unwrap();
                por_esquina[i] = Some((a.0 + b.0 - o.0, a.1 + b.1 - o.1));
                Some(i)
            }
            Some(_) => continue,
            None => None,
        };

        let centros = [
            por_esquina[0]?,
            por_esquina[1]?,
            por_esquina[2]?,
            por_esquina[3]?,
        ];
        return Some((centros, estimado, pagina));
    }
    None
}

/// Esquinas del papel a partir de los centros de los marcadores, que están en
/// las mismas posiciones en milímetros que ocupaban los QR.
fn esquinas_desde_centros(
    centros: &[(f32, f32); 4],
    geometria: GeometriaPlantilla,
) -> Option<[Esquina; 4]> {
    let mm_a_px = Projection::from_control_points(geometria.centros_qr_mm(), *centros)?;
    let (w, h) = (geometria.ancho_mm, geometria.alto_mm);
    let mut esquinas = [Esquina { x: 0.0, y: 0.0 }; 4];
    for (i, v) in [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)].iter().enumerate() {
        let (x, y) = mm_a_px * *v;
        esquinas[i] = Esquina { x, y };
    }
    Some(esquinas)
}

/// Reduce los QR leídos a los de una sola página y los ordena por esquina.
///
/// Devuelve también cuál marcador se estimó en vez de leerse (si alguno), y
/// cuántas páginas distintas se vieron — para poder avisar cuando el usuario
/// fotografió el cuaderno abierto en dos hojas.
fn agrupar_por_pagina(qrs: Vec<QrLeido>) -> (Option<([QrLeido; 4], Option<usize>)>, usize) {
    let mut paginas: Vec<u32> = qrs.iter().map(|q| q.marca.pagina).collect();
    paginas.sort_unstable();
    paginas.dedup();
    let cantidad = paginas.len();

    // Se queda con la página que tenga las cuatro esquinas; si hay varias
    // completas, la primera por número.
    for pagina in &paginas {
        let mut por_esquina: [Option<QrLeido>; 4] = [None, None, None, None];
        for q in qrs.iter() {
            if q.marca.pagina == *pagina {
                por_esquina[q.marca.esquina] = Some(QrLeido {
                    marca: q.marca,
                    centro: q.centro,
                });
            }
        }
        let estimado = completar_cuarto(&mut por_esquina);
        if por_esquina.iter().all(|e| e.is_some()) {
            let [a, b, c, d] = por_esquina;
            return (
                Some((
                    [a.unwrap(), b.unwrap(), c.unwrap(), d.unwrap()],
                    estimado,
                )),
                cantidad,
            );
        }
    }
    (None, cantidad)
}

/// Esquinas del papel a partir de los centros de los QR: se extiende la
/// homografía mm → píxeles a los cuatro vértices reales de la hoja.
fn esquinas_desde_qrs(qrs: &[QrLeido; 4]) -> Option<([Esquina; 4], GeometriaPlantilla, u32)> {
    let geometria = qrs[0].marca.geometria;
    let centros_mm = geometria.centros_qr_mm();
    let centros_px = [qrs[0].centro, qrs[1].centro, qrs[2].centro, qrs[3].centro];

    let mm_a_px = Projection::from_control_points(centros_mm, centros_px)?;
    let (w, h) = (geometria.ancho_mm, geometria.alto_mm);
    let vertices = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)];

    let mut esquinas = [Esquina { x: 0.0, y: 0.0 }; 4];
    for (i, v) in vertices.iter().enumerate() {
        let (x, y) = mm_a_px * *v;
        esquinas[i] = Esquina { x, y };
    }
    Some((esquinas, geometria, qrs[0].marca.pagina))
}

// ------------------------------------------------ detección por contraste

/// Trabajar en miniatura: los bordes de una hoja se ven igual de bien y el
/// Canny sobre 12 megapíxeles tarda segundos por foto.
const LADO_ANALISIS: u32 = 900;

/// Busca el contorno más grande y convexo de la imagen y lo reduce a cuatro
/// puntos. Funciona cuando la hoja ocupa buena parte del encuadre y contrasta
/// con el fondo, que es el caso normal de una foto de apunte sobre un
/// escritorio.
///
/// ponytail: Canny con umbrales fijos; si falla mucho en fondos claros,
/// el próximo paso es calcular el umbral con Otsu sobre el gradiente.
fn esquinas_por_contraste(gris: &GrayImage) -> Option<[Esquina; 4]> {
    let (ancho, alto) = (gris.width(), gris.height());
    let escala = (LADO_ANALISIS as f32 / ancho.max(alto) as f32).min(1.0);
    let chico = image::imageops::resize(
        gris,
        (ancho as f32 * escala).round().max(1.0) as u32,
        (alto as f32 * escala).round().max(1.0) as u32,
        image::imageops::FilterType::Triangle,
    );

    let suave = imageproc::filter::gaussian_blur_f32(&chico, 2.0);
    let bordes = imageproc::edges::canny(&suave, 40.0, 120.0);
    // Los bordes de una hoja salen cortados por sombras y por el propio
    // pliegue: engrosarlos los une antes de buscar contornos.
    let bordes = imageproc::morphology::dilate(&bordes, Norm::LInf, 2);

    let area_total = (chico.width() * chico.height()) as f64;
    let contornos = find_contours::<i32>(&bordes);

    let mut mejor: Option<(f64, Vec<Point<i32>>)> = None;
    for c in contornos {
        if c.border_type != BorderType::Outer || c.points.len() < 4 {
            continue;
        }
        let casco = convex_hull(&*c.points);
        let area = area_poligono(&casco);
        // Menos del 15% del encuadre no es la hoja, es un objeto del fondo.
        if area < area_total * 0.15 {
            continue;
        }
        if mejor.as_ref().map_or(true, |(a, _)| area > *a) {
            mejor = Some((area, casco));
        }
    }

    let (_, casco) = mejor?;
    let perimetro = arc_length(&casco, true);
    let aprox = approximate_polygon_dp(&casco, 0.02 * perimetro, true);
    // Douglas-Peucker no siempre deja exactamente cuatro vértices (una esquina
    // redondeada o un pliegue agregan uno). Cuando no, se cae a los extremos
    // del casco convexo, que para un cuadrilátero convexo da lo mismo.
    let puntos = if aprox.len() == 4 { aprox } else { casco };
    let ordenadas = extremos(&puntos)?;

    Some(ordenadas.map(|p| Esquina {
        x: p.0 / escala,
        y: p.1 / escala,
    }))
}

fn area_poligono(p: &[Point<i32>]) -> f64 {
    if p.len() < 3 {
        return 0.0;
    }
    let mut s = 0i64;
    for i in 0..p.len() {
        let a = p[i];
        let b = p[(i + 1) % p.len()];
        s += a.x as i64 * b.y as i64 - b.x as i64 * a.y as i64;
    }
    (s as f64 / 2.0).abs()
}

/// TL = mínimo de (x+y), BR = máximo de (x+y), TR = máximo de (x−y),
/// BL = mínimo de (x−y). Es el truco estándar para ordenar las esquinas de un
/// cuadrilátero convexo sin resolver nada.
///
/// ponytail: asume que la hoja está a menos de 45° de la horizontal. Más
/// inclinada que eso, el usuario corrige a mano (o rota la foto).
fn extremos(p: &[Point<i32>]) -> Option<[(f32, f32); 4]> {
    if p.len() < 4 {
        return None;
    }
    let suma = |q: &Point<i32>| q.x + q.y;
    let resta = |q: &Point<i32>| q.x - q.y;
    let tl = p.iter().min_by_key(|q| suma(q))?;
    let br = p.iter().max_by_key(|q| suma(q))?;
    let tr = p.iter().max_by_key(|q| resta(q))?;
    let bl = p.iter().min_by_key(|q| resta(q))?;
    Some([
        (tl.x as f32, tl.y as f32),
        (tr.x as f32, tr.y as f32),
        (br.x as f32, br.y as f32),
        (bl.x as f32, bl.y as f32),
    ])
}

// ---------------------------------------------------------- comando: análisis

/// `geometria_defecto` es el papel configurado en la app. Se usa solo cuando la
/// hoja trae marcadores pero no se pudo leer el QR con su geometría: sin algún
/// tamaño de papel no hay forma de extrapolar de los centros de los marcadores
/// a las esquinas del papel.
#[tauri::command]
pub async fn analizar_foto(
    ruta: String,
    geometria_defecto: GeometriaPlantilla,
) -> Result<AnalisisFoto, String> {
    tauri::async_runtime::spawn_blocking(move || analizar(&ruta, geometria_defecto))
        .await
        .map_err(|e| format!("El análisis se interrumpió: {e}"))?
}

/// Lado largo de la vista previa. Alcanza para ver la hoja y ubicar las
/// esquinas sin mandarle 12 megapíxeles al webview por cada foto.
const LADO_VISTA_PX: u32 = 1600;

/// Escribe la vista previa orientada en el temporal del sistema y devuelve su
/// ruta. El nombre sale de la ruta de origen, así que reprocesar la misma foto
/// reusa el archivo en vez de acumular basura.
fn guardar_vista_previa(img: &DynamicImage, ruta_origen: &str) -> Result<String, String> {
    let mut hash: u64 = 1469598103934665603;
    for b in ruta_origen.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    let dir = std::env::temp_dir().join("classrecorder-vistas");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
    let destino = dir.join(format!("{hash:016x}.jpg"));

    let (w, h) = (img.width(), img.height());
    let reducida = if w.max(h) > LADO_VISTA_PX {
        let escala = LADO_VISTA_PX as f32 / w.max(h) as f32;
        img.resize(
            (w as f32 * escala).round() as u32,
            (h as f32 * escala).round() as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img.clone()
    };

    let ruta = destino.to_string_lossy().to_string();
    guardar_jpeg(&reducida, &ruta, 85)?;
    Ok(ruta)
}

fn analizar(ruta: &str, geometria_defecto: GeometriaPlantilla) -> Result<AnalisisFoto, String> {
    let img = abrir_con_orientacion(Path::new(ruta))?;
    let gris = img.to_luma8();
    let (ancho, alto) = (gris.width(), gris.height());
    let vista_previa = guardar_vista_previa(&img, ruta)?;

    let nitidez = nitidez_de(&gris);
    let brillo = brillo_de(&gris);
    let mut advertencias = Vec::new();

    if nitidez < NITIDEZ_MINIMA {
        advertencias.push(
            "La foto está movida o desenfocada. El texto reconocido va a salir mal: conviene repetirla."
                .to_string(),
        );
    }
    if brillo < 60.0 {
        advertencias.push("La foto está muy oscura. Busca más luz y repítela.".to_string());
    } else if brillo > 225.0 {
        advertencias.push(
            "La foto está quemada de luz y se pierde el trazo del lápiz. Evita el flash directo."
                .to_string(),
        );
    }

    // Los marcadores ArUco de las esquinas son la fuente principal. El QR ya no
    // va en las esquinas: queda uno solo, abajo al centro, con la geometría del
    // papel, que un id de diccionario no puede transportar.
    let marcadores = marcadores::leer_marcadores(&gris);
    let grupo_aruco = agrupar_marcadores(&marcadores);

    // Los QR solo se leen si hacen falta: para la geometría siempre, y como
    // respaldo de las esquinas en las hojas impresas antes de la migración.
    // La lectura multipasada cuesta segundos, así que no se paga de más.
    let leidos = leer_qrs(&gris);
    // Copia para poder decir después cuáles esquinas faltaron: `leidos` se
    // consume al agrupar por página.
    let copias: Vec<QrLeido> = leidos
        .iter()
        .map(|q| QrLeido { marca: q.marca, centro: q.centro })
        .collect();
    // Aunque no estén los cuatro, con uno solo ya se sabe el tamaño de papel y
    // el número de página: se aprovecha para no preguntárselos al usuario.
    let parcial = leidos.first().map(|q| (q.marca.geometria, q.marca.pagina));
    let cuantos = leidos.len();

    let (grupo, hojas) = agrupar_por_pagina(leidos);
    if hojas > 1 {
        advertencias.push(format!(
            "Se ven {hojas} hojas distintas en la misma foto. Se va a procesar una sola: para las dos, fotografíalas por separado."
        ));
    }

    if let Some((centros, estimado, pagina_aruco)) = grupo_aruco {
        // La geometría del papel sale del QR de abajo. Si no se pudo leer se
        // usa la configurada y se avisa: el recorte va a salir bien igual salvo
        // que el usuario haya cambiado de papel sin actualizar la config.
        let leida = parcial.map(|(g, _)| g);
        if leida.is_none() {
            advertencias.push(
                "Se leyeron las esquinas pero no el código con el tamaño de papel. Se usó el papel configurado: revisa que el recorte tenga la proporción correcta."
                    .to_string(),
            );
        }
        let g = leida.unwrap_or(geometria_defecto);
        {
            if let Some(esquinas) = esquinas_desde_centros(&centros, g) {
                if let Some(i) = estimado {
                    advertencias.push(format!(
                        "No se pudo leer el marcador de la esquina {}. Se estimó a partir de los otros tres, así que el recorte puede estar unos milímetros corrido: revísalo antes de confirmar.",
                        NOMBRES_ESQUINA[i]
                    ));
                }
                return Ok(AnalisisFoto {
                    ancho,
                    alto,
                    vista_previa,
                    esquinas: esquinas.to_vec(),
                    fuente: "marcadores".into(),
                    geometria: Some(g),
                    pagina: Some(pagina_aruco),
                    nitidez,
                    brillo,
                    hojas_detectadas: hojas.max(1),
                    advertencias,
                });
            }
        }
    }

    if let Some((qrs, estimado)) = grupo {
        if let Some((esquinas, geometria, pagina)) = esquinas_desde_qrs(&qrs) {
            if let Some(i) = estimado {
                advertencias.push(format!(
                    "No se pudo leer el marcador de la esquina {}. Se estimó a partir de los otros tres, así que el recorte puede estar unos milímetros corrido: revísalo antes de confirmar. Suele pasar cuando esa esquina quedó con sombra, curvada por el anillado, o impresa muy clara.",
                    NOMBRES_ESQUINA[i]
                ));
            }
            return Ok(AnalisisFoto {
                ancho,
                alto,
                vista_previa,
                esquinas: esquinas.to_vec(),
                fuente: "marcadores".into(),
                geometria: Some(geometria),
                pagina: Some(pagina),
                nitidez,
                brillo,
                hojas_detectadas: hojas.max(1),
                advertencias,
            });
        }
    }

    if let Some((vistos, contraste)) = contraste_de_marcadores(&gris) {
        if vistos > cuantos && contraste < CONTRASTE_MINIMO {
            advertencias.push(format!(
                "Se ven {vistos} marcadores en la foto pero solo se pudieron leer {cuantos}: la impresión salió demasiado clara (contraste medido {contraste} sobre 255; una impresión sana da más de {CONTRASTE_MINIMO}). Reimprime la plantilla con la impresora en calidad normal, sin modo borrador ni ahorro de tinta. El color del papel no influye: lo que falta es que la tinta se despegue del papel que tiene al lado."
            ));
        }
    }

    if cuantos > 0 {
        let mut vistas = [false; 4];
        for q in &copias {
            vistas[q.marca.esquina] = true;
        }
        let faltantes: Vec<&str> = (0..4)
            .filter(|i| !vistas[*i])
            .map(|i| NOMBRES_ESQUINA[i])
            .collect();
        advertencias.push(format!(
            "Solo se leyeron {cuantos} de los 4 marcadores: faltaron los de la esquina {}. El recorte se hizo por el borde del papel, así que revísalo antes de guardar.",
            faltantes.join(" y la ")
        ));
    }

    match esquinas_por_contraste(&gris) {
        Some(esquinas) => Ok(AnalisisFoto {
            ancho,
            alto,
            vista_previa,
            esquinas: esquinas.to_vec(),
            fuente: "contraste".into(),
            geometria: parcial.map(|(g, _)| g),
            pagina: parcial.map(|(_, p)| p),
            nitidez,
            brillo,
            hojas_detectadas: hojas.max(1),
            advertencias,
        }),
        None => {
            advertencias.push(
                "No se pudo encontrar el borde de la hoja. Marca las cuatro esquinas a mano."
                    .to_string(),
            );
            Ok(AnalisisFoto {
                ancho,
                alto,
                vista_previa,
                // Encuadre completo: es el punto de partida para arrastrarlas.
                esquinas: vec![
                    Esquina { x: 0.0, y: 0.0 },
                    Esquina { x: ancho as f32, y: 0.0 },
                    Esquina { x: ancho as f32, y: alto as f32 },
                    Esquina { x: 0.0, y: alto as f32 },
                ],
                fuente: "ninguna".into(),
                geometria: parcial.map(|(g, _)| g),
                pagina: parcial.map(|(_, p)| p),
                nitidez,
                brillo,
                hojas_detectadas: hojas.max(1),
                advertencias,
            })
        }
    }
}

// ------------------------------------------------------- comando: rectificar

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PedidoRectificar {
    pub ruta: String,
    pub salida: String,
    /// TL, TR, BR, BL en píxeles de la foto original (ya con EXIF aplicado).
    pub esquinas: Vec<Esquina>,
    pub geometria: GeometriaPlantilla,
    /// Puntos por pulgada del escaneo final. 200 alcanza para leer manuscrita
    /// y deja el archivo en pocos cientos de KB.
    pub dpi: u32,
    /// Calidad JPEG 1-100.
    pub calidad: u8,
    /// "color" | "gris" | "original". Ver `limpiar_color` y `limpiar_escaneo`.
    pub modo: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RectificadoInfo {
    pub archivo: String,
    pub ancho: u32,
    pub alto: u32,
    pub bytes: u64,
}

#[tauri::command]
pub async fn rectificar_foto(pedido: PedidoRectificar) -> Result<RectificadoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || rectificar(pedido))
        .await
        .map_err(|e| format!("La rectificación se interrumpió: {e}"))?
}

fn rectificar(p: PedidoRectificar) -> Result<RectificadoInfo, String> {
    if p.esquinas.len() != 4 {
        return Err("Hacen falta exactamente cuatro esquinas.".into());
    }
    let img = abrir_con_orientacion(Path::new(&p.ruta))?;

    let px_por_mm = p.dpi as f32 / 25.4;
    let ancho = (p.geometria.ancho_mm * px_por_mm).round().max(1.0) as u32;
    let alto = (p.geometria.alto_mm * px_por_mm).round().max(1.0) as u32;

    let desde = [
        (p.esquinas[0].x, p.esquinas[0].y),
        (p.esquinas[1].x, p.esquinas[1].y),
        (p.esquinas[2].x, p.esquinas[2].y),
        (p.esquinas[3].x, p.esquinas[3].y),
    ];
    let hacia = [
        (0.0, 0.0),
        (ancho as f32, 0.0),
        (ancho as f32, alto as f32),
        (0.0, alto as f32),
    ];
    let proyeccion = Projection::from_control_points(desde, hacia)
        .ok_or("Las cuatro esquinas están alineadas o repetidas: no forman una hoja.")?;

    let salida: DynamicImage = if p.modo == "gris" {
        let mut destino: GrayImage = ImageBuffer::new(ancho, alto);
        warp_into(
            &img.to_luma8(),
            proyeccion,
            Interpolation::Bilinear,
            Border::Constant(Luma([255u8])),
            &mut destino,
        );
        DynamicImage::ImageLuma8(limpiar_escaneo(destino))
    } else if p.modo == "color" {
        let mut destino: RgbImage = ImageBuffer::new(ancho, alto);
        warp_into(
            &img.to_rgb8(),
            proyeccion,
            Interpolation::Bilinear,
            Border::Constant(Rgb([255u8, 255, 255])),
            &mut destino,
        );
        DynamicImage::ImageRgb8(limpiar_color(destino))
    } else {
        let mut destino: RgbImage = ImageBuffer::new(ancho, alto);
        warp_into(
            &img.to_rgb8(),
            proyeccion,
            Interpolation::Bilinear,
            Border::Constant(Rgb([255u8, 255, 255])),
            &mut destino,
        );
        DynamicImage::ImageRgb8(destino)
    };

    guardar_jpeg(&salida, &p.salida, p.calidad)?;
    let bytes = std::fs::metadata(&p.salida).map(|m| m.len()).unwrap_or(0);

    Ok(RectificadoInfo {
        archivo: p.salida,
        ancho,
        alto,
        bytes,
    })
}

fn guardar_jpeg(img: &DynamicImage, ruta: &str, calidad: u8) -> Result<(), String> {
    if let Some(padre) = Path::new(ruta).parent() {
        std::fs::create_dir_all(padre)
            .map_err(|e| format!("No se pudo crear {}: {e}", padre.display()))?;
    }
    let archivo =
        std::fs::File::create(ruta).map_err(|e| format!("No se pudo crear {ruta}: {e}"))?;
    let mut escritor = std::io::BufWriter::new(archivo);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut escritor, calidad.clamp(1, 100))
        .encode_image(img)
        .map_err(|e| format!("No se pudo guardar {ruta}: {e}"))
}

/// Efecto "escaneado": divide la imagen por una estimación del fondo para
/// borrar sombras e iluminación despareja, y después estira el contraste.
///
/// Se queda en escala de grises y no binariza a propósito: un diagrama o una
/// línea de tiempo a lápiz se pierde entero si se lleva todo a blanco y negro.
/// Radio de la ventana con la que se estima el fondo, relativo al lado corto.
///
/// Es un equilibrio entre dos errores opuestos y conviene tenerlo escrito:
/// **muy grande** y la estimación se aplana, deja de seguir la sombra y la
/// sombra sobrevive; **muy chico** y empieza a seguir el propio trazo, que
/// entonces se cancela contra sí mismo y desaparece. Un cuarentavo del lado
/// corto son ~35 px en una hoja a 200 dpi: unas nueve veces el grosor de un
/// trazo de lapicera, y bastante más apretado que la sombra de una mano o un
/// teléfono, que es lo que hay que borrar.
const DIVISOR_RADIO_FONDO: u32 = 40;

fn limpiar_escaneo(gris: GrayImage) -> GrayImage {
    let (w, h) = (gris.width(), gris.height());
    let radio = (w.min(h) / DIVISOR_RADIO_FONDO).max(8);
    let fondo = imageproc::filter::box_filter(&gris, radio, radio);

    let mut normalizada: GrayImage = ImageBuffer::new(w, h);
    for (x, y, p) in gris.enumerate_pixels() {
        let f = fondo.get_pixel(x, y)[0].max(1) as f32;
        let v = (p[0] as f32 / f * 255.0).clamp(0.0, 255.0);
        normalizada.put_pixel(x, y, Luma([v as u8]));
    }

    // Punto de negro data-driven: el percentil 2 es la tinta más oscura que
    // hay de verdad en la hoja, no un píxel de ruido suelto.
    //
    // El tope importa: en una hoja casi vacía la normalización deja todo cerca
    // de 255, el percentil 2 sube por encima del punto de blanco y el estirado
    // sale invertido — la página entera se iba a negro. Se le deja siempre un
    // rango mínimo de 40 niveles.
    let blanco = 245.0f32;
    let negro = (percentil(&normalizada, 0.02) as f32).min(blanco - 40.0);
    let rango = blanco - negro;

    for p in normalizada.pixels_mut() {
        let v = ((p[0] as f32 - negro) * 255.0 / rango).clamp(0.0, 255.0);
        p[0] = v as u8;
    }
    normalizada
}

/// Lo mismo que `limpiar_escaneo` pero conservando el color de la tinta.
///
/// El fondo se estima una sola vez sobre la luminancia y se divide cada canal
/// por él. Estimarlo por canal teñiría el resultado: donde hay tinta roja el
/// canal rojo casi no baja y el azul sí, así que cada canal deduciría un
/// "papel" distinto.
///
/// La parte delicada es el realce, y acá está la lección que costó una
/// impresión: **nunca restarle un punto de negro a los canales por separado**.
/// Esa era la versión anterior, y aplastaba los colores oscuros. Una lapicera
/// azul tiene luminancia ~66 contra ~80 de una roja y ~250 del papel, así que
/// el punto de negro calculado por percentil caía justo encima del azul: al
/// restarlo, los tres canales se iban a cero recortados y el trazo salía negro.
/// El rojo zafaba solo porque su canal R queda alto.
///
/// Lo que se hace en cambio: se calcula el realce **sobre la luminancia** y se
/// escalan los tres canales por el mismo factor. Al ser una multiplicación y no
/// una resta, la proporción entre canales —o sea el tono— se conserva exacta,
/// para cualquier color y no solo para los que casualmente sobrevivían.
fn limpiar_color(rgb: RgbImage) -> RgbImage {
    let (w, h) = (rgb.width(), rgb.height());
    let mut luz: GrayImage = ImageBuffer::new(w, h);
    for (x, y, p) in rgb.enumerate_pixels() {
        luz.put_pixel(x, y, Luma([luminancia(p) as u8]));
    }

    let radio = (w.min(h) / DIVISOR_RADIO_FONDO).max(8);
    let fondo = imageproc::filter::box_filter(&luz, radio, radio);

    let mut salida: RgbImage = ImageBuffer::new(w, h);
    for (x, y, p) in rgb.enumerate_pixels() {
        let f = fondo.get_pixel(x, y)[0].max(1) as f32;

        // 1. Dividir por el papel: la sombra se va y el fondo queda blanco.
        let v = [
            (p[0] as f32 / f * 255.0).clamp(0.0, 255.0),
            (p[1] as f32 / f * 255.0).clamp(0.0, 255.0),
            (p[2] as f32 / f * 255.0).clamp(0.0, 255.0),
        ];
        let l = luminancia(&Rgb([v[0] as u8, v[1] as u8, v[2] as u8]));

        // 2. Realzar solo el brillo, con una gamma suave. Sin punto de negro:
        //    lo que oscurece de más es justamente lo que borra el color.
        let l2 = 255.0 * (l / 255.0).clamp(0.0, 1.0).powf(GAMMA_REALCE);
        let factor = if l > 1.0 { l2 / l } else { 1.0 };

        // 3. Y un toque de saturación alrededor de ese brillo, para compensar
        //    el lavado que deja la división. Es una separación del gris, así
        //    que un píxel sin color (papel, lápiz) no se inventa ninguno.
        let mut canales = [0u8; 3];
        for c in 0..3 {
            let escalado = v[c] * factor;
            canales[c] = (l2 + (escalado - l2) * SATURACION).clamp(0.0, 255.0) as u8;
        }
        salida.put_pixel(x, y, Rgb(canales));
    }
    salida
}

fn luminancia(p: &Rgb<u8>) -> f32 {
    0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32
}

/// Cuánto se oscurece la tinta. Por encima de 1,4 el azul y el verde empiezan
/// a irse a negro, que es el problema que esto vino a resolver.
const GAMMA_REALCE: f32 = 1.2;
/// Separación del gris. Compensa el lavado de la división por el fondo sin
/// llegar a los colores chillones de un filtro.
const SATURACION: f32 = 1.3;

fn percentil(img: &GrayImage, fraccion: f32) -> u8 {
    let mut histograma = [0u32; 256];
    for p in img.pixels() {
        histograma[p[0] as usize] += 1;
    }
    let objetivo = ((img.width() * img.height()) as f32 * fraccion) as u32;
    let mut acumulado = 0u32;
    for (v, c) in histograma.iter().enumerate() {
        acumulado += c;
        if acumulado >= objetivo {
            return v as u8;
        }
    }
    0
}

// ------------------------------------------------------- comando: generar QR

/// Devuelve el PNG del QR de una esquina, en base64, listo para incrustarlo en
/// el PDF de la plantilla desde el frontend.
#[tauri::command]
pub fn generar_qr_png(
    geometria: GeometriaPlantilla,
    esquina: usize,
    pagina: u32,
    px: u32,
) -> Result<String, String> {
    // Sin zona de silencio: la hoja blanca de alrededor ya la provee.
    let img = imagen_qr(geometria, esquina, pagina, px, 0)?;
    let mut png = Vec::new();
    DynamicImage::ImageLuma8(img)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("No se pudo codificar el QR: {e}"))?;
    Ok(base64(&png))
}

/// `borde` son los módulos de zona de silencio que se dibujan dentro del PNG.
/// Cero para imprimir (el papel la aporta), cuatro para incrustarlo sobre algo
/// que no sea blanco.
/// PNG en base64 del marcador ArUco de una esquina, para la plantilla.
#[tauri::command]
pub fn generar_marcador_png(pagina: u32, esquina: usize, px: u32) -> Result<String, String> {
    if esquina > 3 {
        return Err("La esquina tiene que ir de 0 a 3.".into());
    }
    if pagina >= marcadores::PAGINAS_MAXIMAS {
        return Err(format!(
            "El diccionario de marcadores llega hasta la página {}.",
            marcadores::PAGINAS_MAXIMAS - 1
        ));
    }
    let img = marcadores::imagen_marcador(marcadores::id_de(pagina, esquina), px)?;
    let mut png = Vec::new();
    DynamicImage::ImageLuma8(img)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("No se pudo codificar el marcador: {e}"))?;
    Ok(base64(&png))
}

fn imagen_qr(
    geometria: GeometriaPlantilla,
    esquina: usize,
    pagina: u32,
    px: u32,
    borde: u32,
) -> Result<GrayImage, String> {
    let texto = formatear_marca(&MarcaQr {
        geometria,
        esquina,
        pagina,
    });
    // Nivel Q (25% de corrección), no M, y eso fuerza una versión 2 de 25
    // módulos en vez de una versión 1 de 21. Suena peor y es al revés: está
    // medido en `experimento_ecc_contra_impresion_clara`.
    //
    // La razón es que la versión 1 es la única que **no tiene patrón de
    // alineación**. Sin él, el lector arma la cuadrícula de módulos apoyándose
    // solo en los tres patrones de esquina, y cualquier desenfoque de cámara o
    // perspectiva la corre: los bits salen mal y falla la corrección de
    // errores. En la simulación, la versión 1 no decodifica ni con impresión
    // sana a 6 píxeles por módulo, mientras que la versión 2 con Q decodifica
    // en todos los casos, incluso con tinta clara a 3 píxeles por módulo.
    //
    // O sea: el marcador "más simple" era justamente el más frágil. Cuatro
    // módulos más y un patrón de alineación cuestan 0 mm de papel — el
    // cuadrado impreso sigue midiendo `LADO_QR_IMPRESO_MM`.
    let codigo = qrcode::QrCode::with_error_correction_level(&texto, qrcode::EcLevel::Q)
        .map_err(|e| format!("No se pudo generar el QR: {e}"))?;

    let modulos = codigo.width() as u32;
    let colores = codigo.to_colors();
    let total = modulos + borde * 2;
    let escala = (px / total).max(1);
    let lado = total * escala;

    let mut img: GrayImage = ImageBuffer::from_pixel(lado, lado, Luma([255u8]));
    for (i, color) in colores.iter().enumerate() {
        if *color != qrcode::Color::Dark {
            continue;
        }
        let mx = (i as u32 % modulos + borde) * escala;
        let my = (i as u32 / modulos + borde) * escala;
        for y in my..my + escala {
            for x in mx..mx + escala {
                img.put_pixel(x, y, Luma([0u8]));
            }
        }
    }

    Ok(img)
}

/// Base64 estándar. Son veinte líneas contra una dependencia más: ni el PNG de
/// un QR ni la imagen que se manda a la API justifican sumar un crate al árbol
/// de compilación.
pub(crate) fn base64(datos: &[u8]) -> String {
    const ALFABETO: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut salida = String::with_capacity(datos.len().div_ceil(3) * 4);
    for trozo in datos.chunks(3) {
        let b = [
            trozo[0],
            *trozo.get(1).unwrap_or(&0),
            *trozo.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        salida.push(ALFABETO[(n >> 18) as usize & 63] as char);
        salida.push(ALFABETO[(n >> 12) as usize & 63] as char);
        salida.push(if trozo.len() > 1 {
            ALFABETO[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        salida.push(if trozo.len() > 2 {
            ALFABETO[n as usize & 63] as char
        } else {
            '='
        });
    }
    salida
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    const B5: GeometriaPlantilla = GeometriaPlantilla {
        ancho_mm: 176.0,
        alto_mm: 250.0,
        margen_anillado_mm: 18.0,
        lado_anillado: LadoAnillado::Izquierda,
    };

    #[test]
    fn el_anillado_corre_solo_las_esquinas_de_su_lado() {
        let c = B5.centros_qr_mm();
        // Izquierda desplazada por el anillado, derecha no.
        assert_eq!(c[0].0, MARGEN_BORDE_MM + LADO_QR_MM / 2.0 + 18.0);
        assert_eq!(c[3].0, c[0].0);
        assert_eq!(c[1].0, 176.0 - (MARGEN_BORDE_MM + LADO_QR_MM / 2.0));
        for (x, y) in c {
            assert!(x > 0.0 && x < 176.0 && y > 0.0 && y < 250.0);
        }
        // No es simétrico: es justo lo que la homografía tiene que respetar.
        assert_ne!(c[0].0, 176.0 - c[1].0);
    }

    #[test]
    fn el_payload_del_qr_va_y_vuelve() {
        let m = MarcaQr { geometria: B5, esquina: 2, pagina: 7 };
        let texto = formatear_marca(&m);
        assert_eq!(texto, "CR1:176X250:L18:2:7");
        assert_eq!(parsear_marca(&texto), Some(m));
        assert_eq!(parsear_marca("basura"), None);
        assert_eq!(parsear_marca("CR1:176X250:L18:9:7"), None);
    }

    /// La prueba que importa: se toma una hoja ideal, se la deforma como si
    /// fuera una foto sacada en ángulo, y se comprueba que la homografía
    /// calculada desde los centros de los QR devuelve las esquinas del papel.
    #[test]
    fn la_homografia_recupera_las_esquinas_de_una_foto_en_angulo() {
        let centros_mm = B5.centros_qr_mm();
        let falsa_camara = Projection::from_control_points(
            [(0.0, 0.0), (176.0, 0.0), (176.0, 250.0), (0.0, 250.0)],
            [(120.0, 90.0), (1480.0, 210.0), (1390.0, 1850.0), (240.0, 1700.0)],
        )
        .expect("los cuatro puntos forman un cuadrilátero");

        let qrs: [QrLeido; 4] = std::array::from_fn(|i| QrLeido {
            marca: MarcaQr { geometria: B5, esquina: i, pagina: 3 },
            centro: falsa_camara * centros_mm[i],
        });

        let (esquinas, geometria, pagina) =
            esquinas_desde_qrs(&qrs).expect("se puede resolver la homografía");
        assert_eq!(geometria, B5);
        assert_eq!(pagina, 3);

        let esperadas = [(120.0, 90.0), (1480.0, 210.0), (1390.0, 1850.0), (240.0, 1700.0)];
        for (e, (ex, ey)) in esquinas.iter().zip(esperadas) {
            assert!(
                (e.x - ex).abs() < 1.0 && (e.y - ey).abs() < 1.0,
                "esquina ({}, {}) debería ser ({ex}, {ey})",
                e.x,
                e.y
            );
        }
    }

    #[test]
    fn la_limpieza_borra_una_sombra_sin_comerse_el_trazo() {
        // Papel blanco con un degradado de sombra y un renglón de "lápiz" de
        // cuatro píxeles. El tamaño importa: a 1200 px el radio del fondo son
        // 30, o sea unas ocho veces el grosor del trazo, que es la proporción
        // real de una hoja a 200 dpi. Con una imagen chica el radio queda del
        // orden del trazo y la prueba dejaría de representar nada.
        let lado = 1200u32;
        let mut img: GrayImage = ImageBuffer::new(lado, lado);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let sombra = 255.0 - (x as f32 / lado as f32) * 110.0;
            let trazo = if (598..602).contains(&y) { 90.0 } else { 0.0 };
            p[0] = (sombra - trazo).clamp(0.0, 255.0) as u8;
        }
        let limpia = limpiar_escaneo(img);

        // El fondo queda parejo a los dos lados pese a la sombra.
        let izq = limpia.get_pixel(120, 120)[0] as i32;
        let der = limpia.get_pixel(1080, 120)[0] as i32;
        assert!((izq - der).abs() < 25, "fondo desparejo: {izq} vs {der}");
        assert!(izq > 200, "el fondo debería quedar casi blanco, quedó en {izq}");
        // Y el trazo sigue siendo claramente más oscuro que el papel.
        let trazo = limpia.get_pixel(600, 600)[0] as i32;
        assert!(trazo < izq - 60, "el trazo se perdió: {trazo} vs fondo {izq}");
    }

    /// Una hoja sin escribir tiene que salir blanca, no negra. Parece obvio y
    /// no lo era: sin tinta, el punto de negro calculado se subía por encima
    /// del de blanco y el estirado invertía la página entera.
    #[test]
    fn una_hoja_en_blanco_no_sale_negra() {
        let img: GrayImage = ImageBuffer::from_pixel(800, 800, Luma([238u8]));
        let limpia = limpiar_escaneo(img);
        let v = limpia.get_pixel(400, 400)[0];
        assert!(v > 200, "una hoja vacía salió en {v}");

        let color: RgbImage = ImageBuffer::from_pixel(600, 600, Rgb([240u8, 238, 235]));
        let limpio = limpiar_color(color);
        let p = limpio.get_pixel(300, 300);
        assert!(p[0] > 200 && p[1] > 200 && p[2] > 200, "en color salió {p:?}");
    }

    /// La sombra de una mano o un teléfono sobre la hoja es una mancha grande y
    /// de borde difuso, no un degradado suave: es el caso real que se ve en las
    /// fotos y el que decide el radio del fondo.
    #[test]
    fn la_limpieza_borra_la_sombra_de_un_objeto() {
        let (w, h) = (800u32, 800u32);
        let mut img: GrayImage = ImageBuffer::from_pixel(w, h, Luma([245u8]));

        // Sombra: un bloque oscuro que tapa media hoja, con el borde difuminado.
        for (x, y, p) in img.enumerate_pixels_mut() {
            if (200..650).contains(&x) && (150..600).contains(&y) {
                p[0] = 120;
            }
            // Renglones de "lapicera" de 4 px que cruzan dentro y fuera.
            if (0..12).any(|i| (100 + i * 55..104 + i * 55).contains(&y)) && (60..740).contains(&x) {
                p[0] = p[0].saturating_sub(85);
            }
        }
        let img = imageproc::filter::gaussian_blur_f32(&img, 12.0);
        let limpia = limpiar_escaneo(img.clone());

        // El fondo queda parejo dentro y fuera de la sombra.
        let fuera = limpia.get_pixel(60, 700)[0] as i32;
        let dentro = limpia.get_pixel(400, 400)[0] as i32;
        assert!(
            (fuera - dentro).abs() < 30,
            "la sombra sobrevivió: fuera {fuera}, dentro {dentro}"
        );
        assert!(dentro > 190, "dentro de la sombra debería quedar casi blanco, quedó {dentro}");

        // Y antes de limpiar la diferencia era enorme: si esto no se cumple, el
        // caso de prueba dejó de representar una sombra.
        let antes_fuera = img.get_pixel(60, 700)[0] as i32;
        let antes_dentro = img.get_pixel(400, 400)[0] as i32;
        assert!(
            (antes_fuera - antes_dentro).abs() > 90,
            "la foto de partida debería tener una sombra marcada"
        );
    }

    /// El modo en color tiene que sobrevivir a **cualquier** tinta, no solo a
    /// la que casualmente aguantaba. La versión anterior restaba un punto de
    /// negro por canal y el azul salía negro: la lapicera azul tiene luminancia
    /// ~66 y el punto de negro caía justo encima.
    #[test]
    fn el_modo_en_color_conserva_todas_las_tintas() {
        // (nombre, color de la tinta, canal que debe dominar)
        let tintas: [(&str, [u8; 3], usize); 4] = [
            ("azul", [40, 60, 130], 2),
            ("rojo", [190, 25, 30], 0),
            ("verde", [30, 130, 60], 1),
            ("violeta", [110, 40, 140], 2),
        ];

        let (w, h) = (900u32, 900u32);
        // Sombra difusa primero, como en una foto real.
        let mut sombra: RgbImage = ImageBuffer::from_pixel(w, h, Rgb([243u8, 242, 238]));
        for (x, y, p) in sombra.enumerate_pixels_mut() {
            if (200..760).contains(&x) && (140..740).contains(&y) {
                for c in 0..3 {
                    p[c] = (p[c] as f32 * 0.5) as u8;
                }
            }
        }
        let mut img = imageproc::filter::gaussian_blur_f32(&sombra, 14.0);

        // Un renglón por tinta, nítido y dentro de la sombra.
        for (i, (_, color, _)) in tintas.iter().enumerate() {
            let y0 = 260 + i as u32 * 110;
            for y in y0..y0 + 12 {
                for x in 260..700 {
                    let f = img.get_pixel(x, y)[0] as f32 / 243.0;
                    img.put_pixel(
                        x,
                        y,
                        Rgb([
                            (color[0] as f32 * f) as u8,
                            (color[1] as f32 * f) as u8,
                            (color[2] as f32 * f) as u8,
                        ]),
                    );
                }
            }
        }

        let limpia = limpiar_color(img);

        // El papel queda parejo dentro y fuera de la sombra.
        let fuera = limpia.get_pixel(90, 850);
        let dentro = limpia.get_pixel(500, 180);
        assert!(
            (fuera[0] as i32 - dentro[0] as i32).abs() < 35,
            "la sombra sobrevivió: {fuera:?} vs {dentro:?}"
        );
        assert!(fuera[0] > 200, "el papel debería quedar casi blanco: {fuera:?}");

        // Y cada tinta conserva su tono: el canal que la define sigue dominando
        // con holgura, y el trazo no se fue a negro.
        for (i, (nombre, _, dominante)) in tintas.iter().enumerate() {
            let y = 260 + i as u32 * 110 + 6;
            let t = limpia.get_pixel(480, y);
            let otros: Vec<i32> = (0..3)
                .filter(|c| c != dominante)
                .map(|c| t[c] as i32)
                .collect();
            let maximo_otro = *otros.iter().max().unwrap();
            assert!(
                t[*dominante] as i32 > maximo_otro + 40,
                "el trazo {nombre} perdió el tono: {t:?}"
            );
            assert!(
                t[*dominante] > 60,
                "el trazo {nombre} se fue a negro: {t:?}"
            );
        }
    }

    /// Cierra el círculo del QR: se genera el PNG de una esquina, se decodifica
    /// y se comprueba que rqrr vuelve a leer exactamente el mismo payload.
    #[test]
    fn el_qr_generado_se_puede_volver_a_leer() {
        // Con zona de silencio: acá el PNG se decodifica suelto, sin papel alrededor.
        let img = imagen_qr(B5, 1, 12, 400, 4).expect("se genera el QR");
        let mut png = Vec::new();
        DynamicImage::ImageLuma8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("se codifica");
        let b64 = base64(&png);
        let bytes = decodificar_base64(&b64);
        let img = image::load_from_memory(&bytes).expect("es un PNG válido");

        let mut preparada = rqrr::PreparedImage::prepare(img.to_luma8());
        let grids = preparada.detect_grids();
        assert_eq!(grids.len(), 1, "debería verse un solo QR");
        let (_, texto) = grids[0].decode().expect("se decodifica");
        assert_eq!(texto, "CR1:176X250:L18:1:12");
    }

    /// Prototipo de la tubería completa, sin necesitar una foto real: se arma
    /// una hoja B5 con sus cuatro QR en los milímetros que les tocan, se la
    /// deforma como si estuviera fotografiada en ángulo sobre un escritorio
    /// oscuro, se guarda como JPEG y se corre el mismo camino que corre la app.
    #[test]
    fn de_la_foto_en_angulo_al_escaneo_derecho() {
        // La hoja se "imprime" a 300 dpi para que cada módulo del QR caiga en un
        // número entero de píxeles: reescalarlo después deforma la cuadrícula y
        // el lector deja de encontrarla.
        let dpi = 300.0f32;
        let px_mm = dpi / 25.4;
        // Se redondea igual que `rectificar`, para poder comparar tamaños después.
        let (pw, ph) = (
            (B5.ancho_mm * px_mm).round() as u32,
            (B5.alto_mm * px_mm).round() as u32,
        );

        // 1. La hoja impresa: papel blanco, cuatro QR y unos renglones.
        let mut hoja: GrayImage = ImageBuffer::from_pixel(pw, ph, Luma([250u8]));
        // Cuatro marcadores ArUco en las esquinas, como la plantilla real.
        let lado_marcador = (marcadores::LADO_MM * px_mm) as u32;
        for (i, (cx, cy)) in B5.centros_qr_mm().iter().enumerate() {
            let m = marcadores::imagen_marcador(marcadores::id_de(5, i), lado_marcador)
                .expect("se genera el marcador");
            let x0 = (cx * px_mm) as i64 - m.width() as i64 / 2;
            let y0 = (cy * px_mm) as i64 - m.height() as i64 / 2;
            image::imageops::overlay(&mut hoja, &m, x0, y0);
        }
        // Y el QR de geometría abajo al centro.
        let lado_qr = (12.0 * px_mm) as u32;
        let qr = imagen_qr(B5, 0, 5, lado_qr, 4).expect("se genera el QR");
        image::imageops::overlay(
            &mut hoja,
            &qr,
            ((B5.ancho_mm / 2.0) * px_mm) as i64 - qr.width() as i64 / 2,
            ((B5.alto_mm - MARGEN_BORDE_MM - 12.0 - 4.0) * px_mm) as i64,
        );

        // La hoja recién impresa tiene que ser legible antes de fotografiarla:
        // si esto falla, el problema es la plantilla y no la cámara.
        assert_eq!(
            marcadores::leer_marcadores(&hoja).len(),
            4,
            "los marcadores de la plantilla no se leen"
        );
        assert_eq!(leer_qrs(&hoja).len(), 1, "el QR de geometría no se lee");
        for renglon in 0..12 {
            let y = ph / 4 + renglon * 40;
            for x in pw / 5..pw * 4 / 5 {
                for dy in 0..4 {
                    hoja.put_pixel(x, y + dy, Luma([40u8]));
                }
            }
        }

        // 2. La "foto": la hoja en ángulo sobre un fondo oscuro.
        // Resolución de una foto de celular real (12 MP): con menos, los QR de
        // 10 mm no llegan a tener suficientes píxeles por módulo.
        let (fw, fh) = (4000u32, 3000u32);
        let esquinas_reales = [
            (600.0f32, 240.0f32),
            (3400.0, 520.0),
            (3240.0, 2760.0),
            (480.0, 2480.0),
        ];
        let a_camara = Projection::from_control_points(
            [(0.0, 0.0), (pw as f32, 0.0), (pw as f32, ph as f32), (0.0, ph as f32)],
            esquinas_reales,
        )
        .expect("la cámara falsa es una homografía válida");

        let mut foto: GrayImage = ImageBuffer::from_pixel(fw, fh, Luma([70u8]));
        warp_into(
            &hoja,
            a_camara,
            Interpolation::Bilinear,
            Border::Constant(Luma([70u8])),
            &mut foto,
        );

        let dir = std::env::temp_dir().join("classrecorder-test-escaneo");
        std::fs::create_dir_all(&dir).expect("se crea el temporal");
        let entrada = dir.join("foto.jpg");
        let salida = dir.join("escaneo.jpg");
        guardar_jpeg(
            &DynamicImage::ImageLuma8(foto),
            entrada.to_str().unwrap(),
            92,
        )
        .expect("se guarda la foto de prueba");

        // 3. El camino real de la app: analizar…
        let analisis = analizar(entrada.to_str().unwrap(), B5).expect("se analiza la foto");
        assert_eq!(analisis.fuente, "marcadores", "debería detectarse por los marcadores");
        assert_eq!(analisis.geometria, Some(B5));
        assert_eq!(analisis.pagina, Some(5));
        assert_eq!(analisis.hojas_detectadas, 1);
        for (e, (ex, ey)) in analisis.esquinas.iter().zip(esquinas_reales) {
            let error = ((e.x - ex).powi(2) + (e.y - ey).powi(2)).sqrt();
            assert!(error < 20.0, "esquina desviada {error:.1} px de ({ex}, {ey})");
        }

        // 4. …y rectificar. Primero sin limpiar, para poder comprobar la
        // geometría contra los propios QR de la hoja.
        let crudo = dir.join("escaneo-crudo.jpg");
        let info = rectificar(PedidoRectificar {
            ruta: entrada.to_string_lossy().to_string(),
            salida: crudo.to_string_lossy().to_string(),
            esquinas: analisis.esquinas.clone(),
            geometria: B5,
            dpi: 300,
            calidad: 90,
            modo: "original".into(),
        })
        .expect("se rectifica");

        assert_eq!((info.ancho, info.alto), (pw, ph));
        assert!(info.bytes > 0, "el JPEG quedó vacío");

        // El escaneo tiene que salir derecho: los QR se vuelven a leer y ahora
        // caen en los milímetros exactos donde se los imprimió.
        let escaneada = image::open(&crudo).expect("se abre el escaneo").to_luma8();
        // Los marcadores se releen sobre el escaneo y ahora caen en los
        // milímetros exactos donde se los imprimió. Es la comprobación de que
        // la hoja quedó derecha y a escala.
        let leidos = marcadores::leer_marcadores(&escaneada);
        assert_eq!(leidos.len(), 4, "los cuatro marcadores deberían releerse");
        for m in &leidos {
            let (cx, cy) = B5.centros_qr_mm()[m.esquina];
            let error =
                ((m.centro.0 - cx * px_mm).powi(2) + (m.centro.1 - cy * px_mm).powi(2)).sqrt();
            assert!(error < 12.0, "marcador {} desviado {error:.1} px", m.esquina);
        }

        // Y la variante limpia, que es la que se guarda de verdad, sale del
        // mismo tamaño y bastante más liviana.
        let limpio = rectificar(PedidoRectificar {
            ruta: entrada.to_string_lossy().to_string(),
            salida: salida.to_string_lossy().to_string(),
            esquinas: analisis.esquinas.clone(),
            geometria: B5,
            dpi: 300,
            calidad: 80,
            modo: "gris".into(),
        })
        .expect("se rectifica en limpio");
        assert_eq!((limpio.ancho, limpio.alto), (pw, ph));
        assert!(limpio.bytes > 0, "el JPEG limpio quedó vacío");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Diagnóstico contra una foto de verdad. No corre en el suite normal;
    /// se le pasa la ruta por la variable de entorno FOTO y se lanza con
    /// `cargo test diagnostico -- --ignored --nocapture`.
    ///
    /// Existe porque los fallos de detección casi nunca se reproducen con una
    /// hoja sintética: dependen del papel, la luz y el encuadre reales.
    #[test]
    #[ignore]
    fn diagnostico_de_una_foto_real() {
        let ruta = std::env::var("FOTO").expect("define FOTO con la ruta de la foto");
        let img = abrir_con_orientacion(Path::new(&ruta)).expect("se abre la foto");
        let gris = img.to_luma8();
        println!("imagen ya orientada: {}x{}", gris.width(), gris.height());
        println!("nitidez {:.1} (minimo {NITIDEZ_MINIMA})", nitidez_de(&gris));
        println!("brillo  {:.1}", brillo_de(&gris));

        let mut preparada = rqrr::PreparedImage::prepare(gris.clone());
        let grids = preparada.detect_grids();
        println!("cuadriculas QR encontradas: {}", grids.len());
        for g in &grids {
            let lado = ((g.bounds[1].x - g.bounds[0].x) as f32)
                .hypot((g.bounds[1].y - g.bounds[0].y) as f32);
            print!(
                "  lado ~{lado:.0} px  centro ({:.0}, {:.0})  ",
                g.bounds.iter().map(|p| p.x as f32).sum::<f32>() / 4.0,
                g.bounds.iter().map(|p| p.y as f32).sum::<f32>() / 4.0
            );
            match g.decode() {
                Ok((_, texto)) => println!("-> {texto:?}"),
                Err(e) => println!("-> NO DECODIFICA: {e:?}"),
            }
        }

        let leidos = leer_qrs(&gris);
        println!(
            "tras las tres pasadas se leyeron las esquinas: {:?}",
            leidos.iter().map(|q| NOMBRES_ESQUINA[q.marca.esquina]).collect::<Vec<_>>()
        );

        let analisis = analizar(&ruta, B5).expect("se analiza");
        println!("fuente: {}", analisis.fuente);
        println!("geometria: {:?}", analisis.geometria);
        println!("pagina: {:?}", analisis.pagina);
        println!("esquinas: {:?}", analisis.esquinas);
        for a in &analisis.advertencias {
            println!("aviso: {a}");
        }
    }

    /// Experimento: ¿qué combinación de payload y corrección de errores
    /// sobrevive a una impresión clara como la que salió de la impresora real?
    ///
    /// Se simula lo medido en las fotos de verdad: tinta ~55 y papel ~200 (en
    /// vez de 15 y 240), desenfoque de cámara, y distintos píxeles por módulo.
    /// Correr con:
    ///   cargo test experimento_ecc -- --ignored --nocapture
    #[test]
    #[ignore]
    fn experimento_ecc_contra_impresion_clara() {
        use qrcode::{EcLevel, QrCode};

        // Igual de largo que los payloads reales, sin depender del formateador.
        let largo = "CR1:173X250:L18:0:3"; // 19 caracteres: geometría completa
        let corto = "CR1:0:3"; //             7 caracteres: solo esquina y página

        println!("payload            ECC  ver  modulos  px/mod  contraste  decodifica");
        for (nombre, texto) in [("largo(19)", largo), ("corto(7) ", corto)] {
            for (ecc, en) in [
                (EcLevel::L, "L"),
                (EcLevel::M, "M"),
                (EcLevel::Q, "Q"),
                (EcLevel::H, "H"),
            ] {
                let Ok(codigo) = QrCode::with_error_correction_level(texto, ecc) else {
                    println!("{nombre}          {en}   -    no entra");
                    continue;
                };
                let modulos = codigo.width() as u32;
                let colores = codigo.to_colors();

                for px_mod in [3u32, 4, 5, 6] {
                    for (tinta, papel, etiqueta) in
                        [(55u8, 200u8, "malo(145)"), (15u8, 240u8, "sano(225)")]
                    {
                        let borde = 4u32;
                        let lado = (modulos + borde * 2) * px_mod;
                        let mut img: GrayImage = ImageBuffer::from_pixel(lado, lado, Luma([papel]));
                        for (i, c) in colores.iter().enumerate() {
                            if *c != qrcode::Color::Dark {
                                continue;
                            }
                            let mx = (i as u32 % modulos + borde) * px_mod;
                            let my = (i as u32 / modulos + borde) * px_mod;
                            for y in my..my + px_mod {
                                for x in mx..mx + px_mod {
                                    img.put_pixel(x, y, Luma([tinta]));
                                }
                            }
                        }
                        // Desenfoque de cámara: es lo que come los bordes de
                        // cada módulo y convierte poco contraste en bits malos.
                        let img = imageproc::filter::gaussian_blur_f32(&img, 0.8);

                        let mut prep = rqrr::PreparedImage::prepare(img);
                        let ok = prep
                            .detect_grids()
                            .iter()
                            .any(|g| g.decode().map(|(_, t)| t == texto).unwrap_or(false));
                        let version = (modulos - 17) / 4;
                        println!(
                            "{nombre}          {en}   {version}    {modulos:>2}      {px_mod}      {etiqueta}   {}",
                            if ok { "SI" } else { "no" }
                        );
                    }
                }
            }
        }
    }

    /// Herramienta de banco: toma una foto real y deja el escaneo rectificado en
    /// disco, para poder probar el reconocimiento sobre exactamente la misma
    /// imagen que ve la app.
    ///
    ///   FOTO=... SALIDA=... cargo test producir_escaneo -- --ignored --nocapture
    #[test]
    #[ignore]
    fn producir_escaneo_de_una_foto_real() {
        let ruta = std::env::var("FOTO").expect("define FOTO");
        let salida = std::env::var("SALIDA").expect("define SALIDA");
        let modo = std::env::var("MODO").unwrap_or_else(|_| "color".into());

        let a = analizar(&ruta, B5).expect("se analiza");
        println!("fuente {} · geometria {:?}", a.fuente, a.geometria);
        let info = rectificar(PedidoRectificar {
            ruta,
            salida,
            esquinas: a.esquinas.clone(),
            geometria: a.geometria.unwrap_or(B5),
            dpi: 200,
            calidad: 88,
            modo,
        })
        .expect("se rectifica");
        println!("escaneo {}x{} en {}", info.ancho, info.alto, info.archivo);
    }

    fn decodificar_base64(s: &str) -> Vec<u8> {
        const ALFABETO: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let valores: Vec<u8> = s
            .bytes()
            .filter(|b| *b != b'=')
            .map(|b| ALFABETO.iter().position(|a| *a == b).unwrap() as u8)
            .collect();
        let mut salida = Vec::new();
        for grupo in valores.chunks(4) {
            let mut n = 0u32;
            for (i, v) in grupo.iter().enumerate() {
                n |= (*v as u32) << (18 - 6 * i);
            }
            salida.push((n >> 16) as u8);
            if grupo.len() > 2 {
                salida.push((n >> 8) as u8);
            }
            if grupo.len() > 3 {
                salida.push(n as u8);
            }
        }
        salida
    }
}
