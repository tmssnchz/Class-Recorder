//! Marcadores ArUco de las esquinas de la plantilla.
//!
//! Reemplazan a los QR que había en las esquinas, y la razón es puramente de
//! tamaño de detalle. En los mismos 10 mm impresos:
//!
//!   QR versión 2   25 módulos + zona de silencio  ->  0,40 mm por módulo
//!   ArUco          7 celdas (5 de datos + marco)  ->  1,43 mm por celda
//!
//! Tres veces y media más grueso. Eso es lo que decide si una impresora que
//! entrega gris en vez de negro sirve o no, y no se recupera afinando el QR:
//! para tener módulos de 1,4 mm el QR tendría que medir 35 mm. Medido contra
//! una impresión simulada con tinta clara, el ArUco decodifica hasta con 3
//! píxeles por celda, donde el QR ya fallaba.
//!
//! Lo que un ArUco **no** puede llevar es el tamaño de papel: su contenido es
//! un número de diccionario, no texto. Por eso la plantilla sigue imprimiendo
//! un QR chico abajo al centro con la geometría; ese no participa de la
//! homografía, así que si falla se cae a la configurada y se avisa.

use image::{GrayImage, ImageBuffer, Luma};

use aruco_rs::core::detector::Detector;
use aruco_rs::core::dictionary::{Dictionary, DICTIONARY_ARUCO};
use aruco_rs::cv::scalar::ScalarCV;

/// Celdas de lado del marcador, marco incluido. Sale de `Dictionary::mark_size`
/// para el diccionario ArUco original: 5 de datos más una de marco por lado.
pub const CELDAS: usize = 7;

/// Lado del cuadrado impreso. A 10 mm cada celda mide 1,43 mm.
pub const LADO_MM: f32 = 10.0;

/// Cuántas páginas distintas entran en el diccionario.
///
/// Son 1023 códigos y cada hoja gasta cuatro, uno por esquina.
pub const PAGINAS_MAXIMAS: u32 = 1023 / 4;

/// Id de diccionario que le toca a una esquina de una página.
///
/// Las cuatro esquinas de la misma hoja quedan en ids consecutivos, así que del
/// id se recupera todo con una división: no hace falta ninguna tabla.
pub fn id_de(pagina: u32, esquina: usize) -> u32 {
    pagina * 4 + esquina as u32
}

/// Inverso de `id_de`.
pub fn desde_id(id: u32) -> (u32, usize) {
    (id / 4, (id % 4) as usize)
}

/// Bits del código, en el orden que espera `Dictionary::parse_code`: el primero
/// es el más significativo.
fn bits_de(dict: &Dictionary, id: u32) -> Option<Vec<u8>> {
    let codigo = *DICTIONARY_ARUCO.code_list.get(id as usize)?;
    Some(
        (0..dict.n_bits)
            .map(|i| ((codigo >> (dict.n_bits - 1 - i)) & 1) as u8)
            .collect(),
    )
}

/// Dibuja el marcador en escala de grises, sin margen: el papel blanco de la
/// plantilla ya hace de zona de silencio.
///
/// `px` es el lado deseado; el real se redondea hacia abajo a un múltiplo de
/// `CELDAS` para que ninguna celda quede con un píxel de más y el borde salga
/// recto al imprimir.
pub fn imagen_marcador(id: u32, px: u32) -> Result<GrayImage, String> {
    let dict = Dictionary::new(&DICTIONARY_ARUCO);
    let bits = bits_de(&dict, id).ok_or_else(|| format!("El marcador {id} no existe."))?;

    let lado_celda = (px as usize / CELDAS).max(1);
    let lado = (CELDAS * lado_celda) as u32;
    let mut img: GrayImage = ImageBuffer::from_pixel(lado, lado, Luma([255u8]));

    for fila in 0..CELDAS {
        for col in 0..CELDAS {
            let marco = fila == 0 || col == 0 || fila == CELDAS - 1 || col == CELDAS - 1;
            // Dentro del marco, un bit en 1 es celda blanca.
            let oscura = marco || bits[(fila - 1) * (CELDAS - 2) + (col - 1)] == 0;
            if !oscura {
                continue;
            }
            for y in 0..lado_celda {
                for x in 0..lado_celda {
                    img.put_pixel(
                        (col * lado_celda + x) as u32,
                        (fila * lado_celda + y) as u32,
                        Luma([0u8]),
                    );
                }
            }
        }
    }
    Ok(img)
}

#[derive(Clone, Copy, Debug)]
pub struct MarcadorLeido {
    pub pagina: u32,
    pub esquina: usize,
    /// Centro en píxeles de la imagen analizada.
    pub centro: (f32, f32),
}

/// Lee los marcadores de una foto ya en escala de grises.
///
/// Una sola pasada, a diferencia de lo que hacía falta con los QR: el detector
/// de ArUco ya binariza con umbral adaptativo por su cuenta, que es justo la
/// técnica que había que agregarle a mano al lector de QR.
pub fn leer_marcadores(gris: &GrayImage) -> Vec<MarcadorLeido> {
    // El detector espera RGBA. Es una copia de más, pero evita mantener un
    // camino aparte solo para escala de grises.
    let mut rgba = Vec::with_capacity((gris.width() as usize) * (gris.height() as usize) * 4);
    for p in gris.pixels() {
        rgba.extend_from_slice(&[p[0], p[0], p[0], 255]);
    }

    let dict = Dictionary::new(&DICTIONARY_ARUCO);
    let detector = Detector::new(&dict, ScalarCV);
    let encontrados = detector.detect(&aruco_rs::ImageBuffer {
        data: &rgba,
        width: gris.width(),
        height: gris.height(),
    });

    encontrados
        .into_iter()
        .filter(|m| m.id >= 0)
        .map(|m| {
            let (pagina, esquina) = desde_id(m.id as u32);
            let cx = m.corners.iter().map(|p| p.x).sum::<f32>() / 4.0;
            let cy = m.corners.iter().map(|p| p.y).sum::<f32>() / 4.0;
            MarcadorLeido {
                pagina,
                esquina,
                centro: (cx, cy),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_id_codifica_pagina_y_esquina() {
        for pagina in [0u32, 1, 7, 100] {
            for esquina in 0..4 {
                assert_eq!(desde_id(id_de(pagina, esquina)), (pagina, esquina));
            }
        }
        // Las cuatro esquinas de una hoja son ids consecutivos.
        assert_eq!(id_de(3, 0) + 3, id_de(3, 3));
        // Y la última página que entra sigue dentro del diccionario.
        assert!((id_de(PAGINAS_MAXIMAS - 1, 3) as usize) < DICTIONARY_ARUCO.code_list.len());
    }

    /// El generado se vuelve a leer. Si el orden de bits o la polaridad se
    /// dieran vuelta, esto lo agarra antes de que salga impreso en cuarenta
    /// hojas.
    #[test]
    fn el_marcador_generado_se_vuelve_a_leer() {
        for id in [0u32, 5, 42, 400] {
            let marcador = imagen_marcador(id, 140).expect("se genera");
            // Con margen de papel alrededor: el detector busca el contorno del
            // marco negro y necesita fondo claro, igual que en la hoja.
            let margen = 30u32;
            let lado = marcador.width() + margen * 2;
            let mut hoja: GrayImage = ImageBuffer::from_pixel(lado, lado, Luma([250u8]));
            image::imageops::overlay(&mut hoja, &marcador, margen as i64, margen as i64);

            let leidos = leer_marcadores(&hoja);
            assert_eq!(leidos.len(), 1, "debería verse un marcador para el id {id}");
            let (pagina, esquina) = desde_id(id);
            assert_eq!((leidos[0].pagina, leidos[0].esquina), (pagina, esquina));

            // Y el centro cae donde se lo dibujó.
            let esperado = margen as f32 + marcador.width() as f32 / 2.0;
            assert!(
                (leidos[0].centro.0 - esperado).abs() < 3.0
                    && (leidos[0].centro.1 - esperado).abs() < 3.0,
                "centro {:?} lejos de ({esperado}, {esperado})",
                leidos[0].centro
            );
        }
    }

    /// La prueba que motivó la migración: una impresión que entrega gris en vez
    /// de negro, con el desenfoque de una foto de celular.
    #[test]
    fn se_lee_con_impresion_clara_y_foto_movida() {
        let id = id_de(3, 2);
        let marcador = imagen_marcador(id, 70).expect("se genera"); // 10 px por celda
        let margen = 24u32;
        let lado = marcador.width() + margen * 2;

        // Tinta 55 y papel 200: lo medido en una hoja impresa en modo borrador.
        let mut hoja: GrayImage = ImageBuffer::from_pixel(lado, lado, Luma([200u8]));
        for (x, y, p) in marcador.enumerate_pixels() {
            if p[0] == 0 {
                hoja.put_pixel(x + margen, y + margen, Luma([55u8]));
            }
        }
        let hoja = imageproc::filter::gaussian_blur_f32(&hoja, 0.8);

        let leidos = leer_marcadores(&hoja);
        assert_eq!(leidos.len(), 1, "con tinta clara igual tiene que leerse");
        assert_eq!((leidos[0].pagina, leidos[0].esquina), (3, 2));
    }
}
