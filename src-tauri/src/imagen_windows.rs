//! Decodificación de formatos de imagen que el crate `image` no conoce,
//! delegando en el componente de imágenes de Windows (WIC).
//!
//! El caso concreto es HEIC, que es lo que sale de un iPhone con los ajustes de
//! fábrica. No hay forma de leerlo con `image`: no tiene decodificador de HEIF
//! en ninguna versión ni con ninguna feature.
//!
//! Las tres alternativas y por qué se eligió esta:
//!
//!   - `libheif-rs` ata la compilación a una librería de C. Rompe el principio
//!     que sostiene todo el backend de apuntes —Rust puro, quien compila no
//!     instala nada, el instalador sigue pesando pocos MB— igual que se rechazó
//!     `apriltag` en su momento.
//!   - Los decodificadores de HEIC en Rust puro que existen (`heic` de imazen,
//!     `heic-decoder` de ente) son los dos AGPL-3.0, y ClassRecorder es MIT.
//!     Usarlos obligaría a relicenciar la app entera.
//!   - WIC ya está en la máquina y el crate `windows` ya es dependencia. Cero
//!     peso agregado y la licencia queda intacta.
//!
//! El precio es que depende de las "Extensiones de imagen HEIF" de Windows.
//! Vienen instaladas en la mayoría de los Windows 11 y son gratis, pero no
//! siempre están: de ahí que el error diga exactamente qué instalar en vez de
//! un "no se reconoció el formato" que no le sirve a nadie.

use std::path::Path;

use image::{DynamicImage, RgbImage};
use windows::core::{Interface, HSTRING};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat24bppBGR, IWICBitmapSource, IWICImagingFactory,
    WICConvertBitmapSource, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};

/// Extensiones que se le delegan a Windows en vez de a `image`.
pub const EXTENSIONES_WIC: [&str; 2] = ["heic", "heif"];

pub fn es_de_windows(ruta: &Path) -> bool {
    ruta.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONES_WIC.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Abre una imagen con WIC y la devuelve como RGB de 8 bits.
///
/// **La imagen sale ya orientada y no hay que aplicarle el EXIF encima.** WIC
/// resuelve por su cuenta las transformaciones `irot`/`imir` del contenedor
/// HEIF, pero deja el campo de orientación EXIF con su valor original: una foto
/// vertical de iPhone se decodifica derecha y aun así declara "orientación 6".
/// Quien llame a esto no puede pasar el resultado por `apply_orientation` —las
/// hojas saldrían rotadas 90° y el recorte no encontraría nada—. Comprobado
/// contra una foto real de iPhone: decodifica 3024×4032 en vertical, legible,
/// con el EXIF diciendo 6.
pub fn abrir(ruta: &Path) -> Result<DynamicImage, String> {
    unsafe {
        // Cada análisis corre en un hilo distinto del pool de bloqueo, así que
        // hay que inicializar COM en cada uno. Si el hilo ya estaba en otro
        // modo de apartamento, WIC funciona igual: es un error que se ignora a
        // propósito, no un descuido.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let fabrica: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("No se pudo iniciar el decodificador de imágenes de Windows: {e}"))?;

        let decodificador = fabrica
            .CreateDecoderFromFilename(
                &HSTRING::from(ruta.as_os_str()),
                None,
                windows::Win32::Foundation::GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
            .map_err(|e| formato_no_soportado(ruta, e))?;

        let cuadro = decodificador
            .GetFrame(0)
            .map_err(|e| format!("No se pudo leer la imagen de {}: {e}", ruta.display()))?;

        // A BGR de 8 bits por canal: es lo que espera `RgbImage` una vez dados
        // vuelta los canales, y evita arrastrar un alfa que una foto no tiene.
        let fuente: IWICBitmapSource = cuadro
            .cast()
            .map_err(|e| format!("No se pudo leer los píxeles de {}: {e}", ruta.display()))?;
        let convertido = WICConvertBitmapSource(&GUID_WICPixelFormat24bppBGR, &fuente)
            .map_err(|e| format!("No se pudo convertir {}: {e}", ruta.display()))?;

        let (mut ancho, mut alto) = (0u32, 0u32);
        convertido
            .GetSize(&mut ancho, &mut alto)
            .map_err(|e| format!("No se pudo medir {}: {e}", ruta.display()))?;
        if ancho == 0 || alto == 0 {
            return Err(format!("{} no tiene píxeles.", ruta.display()));
        }

        let paso = ancho
            .checked_mul(3)
            .ok_or_else(|| format!("{} es demasiado ancha.", ruta.display()))?;
        let total = (paso as usize)
            .checked_mul(alto as usize)
            .ok_or_else(|| format!("{} es demasiado grande para abrirla.", ruta.display()))?;

        let mut pixeles = vec![0u8; total];
        convertido
            .CopyPixels(std::ptr::null(), paso, &mut pixeles)
            .map_err(|e| format!("No se pudo copiar {}: {e}", ruta.display()))?;

        // WIC entrega BGR y `image` espera RGB.
        for p in pixeles.chunks_exact_mut(3) {
            p.swap(0, 2);
        }

        let buffer = RgbImage::from_raw(ancho, alto, pixeles)
            .ok_or_else(|| format!("Los píxeles de {} no cuadran.", ruta.display()))?;
        Ok(DynamicImage::ImageRgb8(buffer))
    }
}

/// El fallo más probable no es un archivo roto: es que falte el códec.
///
/// Windows no distingue un caso del otro en el error que devuelve, así que el
/// mensaje nombra las dos posibilidades y, sobre todo, dice qué instalar. Un
/// "no se reconoció el formato" acá dejaría al usuario sin ningún próximo paso.
fn formato_no_soportado(ruta: &Path, e: windows::core::Error) -> String {
    format!(
        "Windows no pudo abrir {}. Si es una foto HEIC de iPhone, instala las \
         \"Extensiones de imagen HEIF\" (gratis, desde Microsoft Store) y vuelve a \
         intentar. También puedes configurar el iPhone en Ajustes > Cámara > \
         Formatos > \"Más compatible\" para que saque las fotos en JPEG. ({e})",
        ruta.display()
    )
}
