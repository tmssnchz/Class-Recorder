# Descarga ffmpeg.exe (build estatica) y lo deja donde Tauri espera el
# sidecar (src-tauri/binaries/), con el sufijo de target-triple que exige
# el bundler.
#
# No se versiona en el repo: son unos 230 MB y se puede volver a descargar
# en cualquier momento con este script. Se corre una sola vez por clon.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-ffmpeg.ps1

$ErrorActionPreference = "Stop"

$raiz = Split-Path -Parent $PSScriptRoot
$destinoDir = Join-Path $raiz "src-tauri\binaries"
$destino = Join-Path $destinoDir "ffmpeg-x86_64-pc-windows-msvc.exe"

if (Test-Path $destino) {
    Write-Host "Ya existe $destino, no se vuelve a descargar."
    exit 0
}

New-Item -ItemType Directory -Force $destinoDir | Out-Null

$zip = Join-Path $env:TEMP "ffmpeg-essentials.zip"
$extraido = Join-Path $env:TEMP "ffmpeg-essentials-extraido"

Write-Host "Descargando ffmpeg (build estatica de gyan.dev, unos 80 MB)..."
Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip

Write-Host "Extrayendo..."
if (Test-Path $extraido) { Remove-Item -Recurse -Force $extraido }
Expand-Archive -Path $zip -DestinationPath $extraido -Force

$exe = Get-ChildItem -Path $extraido -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $exe) {
    throw "El zip descargado no contiene ffmpeg.exe. Puede que haya cambiado el formato del build en gyan.dev."
}
Copy-Item $exe.FullName $destino -Force

Remove-Item $zip -Force
Remove-Item -Recurse -Force $extraido

Write-Host "Listo: $destino"
