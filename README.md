# Fast Aria2 Streamer

Extension de navegador + servidor local para descargar videos con `aria2c`, evitar descargas duplicadas e incrustar una copia local del video cuando la descarga termina.

El flujo actual prioriza estabilidad:

1. Detecta el video de la pagina.
2. Verifica si ya existe una descarga local compatible.
3. Si ya existe, incrusta el reproductor local sin descargar otra vez.
4. Si no existe, descarga el archivo completo con `aria2c`.
5. Al terminar, incrusta el reproductor local y reproduce inmediatamente.
6. El reproductor local queda en loop.

## Caracteristicas principales

- Boton flotante minimizado por defecto.
- Selector de conexiones dentro del panel.
- Valor predeterminado de 16 conexiones.
- Descarga con `aria2c` en segundo plano.
- Progreso con porcentaje, velocidad y ETA.
- Deteccion de archivos ya descargados por alias, URL, fingerprint y metadata local.
- Calculo de MD5 al terminar la descarga.
- Incrustacion automatica del reproductor local al terminar.
- Reproduccion inmediata despues de descargar.
- Loop automatico en el reproductor local.
- Boton `Restaurar original` en la esquina superior derecha del video local.
- Boton `Volver a local` despues de restaurar el reproductor original.
- Soporte para paginas que cambian la URL con popup, modal, `pushState` o `replaceState`.

## Estructura del proyecto

```text
fast-aria2-streamer/
  extension/
    background.js
    content.js
    manifest.json
    ui.css
  server/
    package.json
    package-lock.json
    server.js
  install-dependencies.ps1
  start-server.bat
  README.md
  LICENSE
```

## Requisitos

- Windows 10/11.
- Node.js LTS instalado y disponible en `PATH`.
- npm disponible en `PATH`.
- aria2 instalado y `aria2c.exe` disponible en `PATH`.
- Chrome, Edge o Brave con modo desarrollador habilitado.

## Instalacion rapida en Windows

Desde PowerShell, entra a la carpeta raiz del proyecto y ejecuta:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-dependencies.ps1
```

El script valida:

- `node`
- `npm`
- `aria2c`

Si `aria2c` no existe, intenta instalarlo con `winget` o `choco` si alguno esta disponible. Despues ejecuta `npm install` dentro de la carpeta `server`.

## Ejecutar el servidor

Desde la carpeta raiz del proyecto, ejecuta:

```cmd
start-server.bat
```

Tambien puedes ejecutarlo manualmente:

```cmd
cd server
node .\server.js
```

El servidor local queda disponible en:

```text
http://127.0.0.1:7777
```

La carpeta local de descargas es:

```text
%TEMP%\aria2_streamer
```

## Cargar la extension

1. Abre `chrome://extensions/` o `edge://extensions/`.
2. Activa `Modo desarrollador`.
3. Selecciona `Cargar descomprimida`.
4. Elige la carpeta `extension` del proyecto.

## Uso

1. Inicia el servidor con `start-server.bat`.
2. Abre una pagina con video.
3. Presiona el boton flotante `aria2`.
4. Ajusta conexiones si lo necesitas. Por defecto usa 16.
5. Presiona descargar.
6. Cuando termine, el video local se incrusta automaticamente y comienza la reproduccion.
7. Al finalizar, el video vuelve a empezar por el atributo `loop`.

## Sistema anti-duplicados

El proyecto evita descargar el mismo video dos veces usando varias senales:

- URL directa del video.
- URL actual de la pagina.
- URL canonical.
- URL `og:url`.
- Alias guardados por descarga.
- Fingerprint de URL sin query string.
- Metadata persistida en disco.
- Tamano de archivo.
- MD5 calculado despues de completar la descarga.

El MD5 se calcula cuando el archivo ya esta completo. No se usa como validacion previa absoluta porque normalmente el servidor origen no publica el hash real del video antes de descargarlo.

## Endpoints locales

- `GET /start?url=...` inicia una descarga.
- `GET /status?id=...` obtiene estado, progreso, velocidad y ETA.
- `GET /file?id=...` sirve el archivo local.
- `GET /delete?id=...` cancela y elimina la descarga.
- `GET /open-folder` abre la carpeta local.
- `GET /find?url=...` busca una descarga existente.

## Archivos eliminados

Se eliminaron archivos generados durante iteraciones anteriores, como changelogs temporales y `node_modules`. Las dependencias se instalan de nuevo con `install-dependencies.ps1` o con `npm install` dentro de `server`.

## Notas tecnicas

- El metodo estable actual descarga primero y despues incrusta el reproductor local.
- Se mantiene fallback a menos conexiones cuando el servidor origen responde con errores como `403`.
- Algunos sitios generan URLs firmadas o temporales; por eso se guardan aliases y fingerprints adicionales.
- El reproductor local usa HTML5 `video`, `controls`, `autoplay` y `loop`.

## Licencia

Uso personal y educativo. La compatibilidad puede variar segun el sitio, el tipo de video y las restricciones del servidor origen.
