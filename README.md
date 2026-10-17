# Fast Aria2 Streamer

Extension de navegador + servidor local para descargar videos MP4 con `aria2c`, reproducirlos mientras se descargan, evitar duplicados y conservar una copia local.

El flujo actual prioriza estabilidad:

1. Detecta el video de la pagina.
2. Verifica si ya existe una descarga local compatible.
3. Si ya existe, incrusta el reproductor local sin descargar otra vez.
4. Si no existe, inicia una descarga segmentada y ordenada con `aria2c`.
5. Cuando hay metadatos MP4 y buffer suficiente, incrusta el reproductor local sin esperar al 100%.
6. Si la reproduccion alcanza la descarga, espera datos y continua automaticamente.
7. El reproductor local queda en loop y el archivo se conserva por defecto.

## Caracteristicas principales

- Descarga automatica de fuentes directas al detectar el video, sin pulsar el boton flotante.
- Menu en el icono de la extension para activar/desactivar la descarga automatica y guardar la preferencia de conservar o borrar al salir.
- Boton flotante minimizado por defecto para iniciar manualmente y ver el progreso.
- Seleccion automatica de la maxima calidad MP4 publicada por `rule34video.com`.
- Fallback a `video.currentSrc` en otros sitios con MP4 directo.
- Descarga ordenada de hasta 16 piezas simultaneas con `aria2c`.
- Seguimiento del `bitfield` RPC para servir solamente piezas completas consecutivas desde el inicio.
- Reproduccion durante la descarga mediante HTTP Range y un archivo local creciente.
- Deteccion de MP4 con indice `moov` al final para evitar intentos prematuros.
- Progreso con porcentaje, velocidad y ETA.
- Deteccion de archivos ya descargados por alias, URL, fingerprint y metadata local.
- Calculo de MD5 al terminar la descarga.
- Incrustacion automatica al alcanzar el buffer minimo o al terminar.
- Indicador de bytes continuos disponibles en el buffer.
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
3. La extension inicia automaticamente la descarga al detectar una fuente de video HTTP/HTTPS compatible. Si la fuente tarda en cargar, la espera.
4. Puedes desactivar el inicio automatico desde el icono de la extension y usar el boton flotante `aria2` > `Ver mientras descarga` para iniciar manualmente.
5. En `rule34video.com` se elige automaticamente la mayor resolucion MP4 disponible.
6. El reproductor local aparece cuando existe buffer suficiente y la descarga continua en segundo plano.
7. Si el buffer se agota, el reproductor espera y se reanuda al recibir mas datos.
8. Haz clic en el icono de la extension y selecciona `Dejar al cerrar` o `Borrar al salir`. La preferencia queda guardada para todas las paginas y proximas sesiones. Tambien puedes cambiarla desde `Mantener al cerrar` en el panel de progreso.
9. `Dejar al cerrar` conserva el archivo y permite terminar la descarga en segundo plano. `Borrar al salir` cancela y borra al navegar a otra pagina o cerrar la pestaña, incluso si la descarga ya termino. Si varias pestañas usan el mismo archivo, espera a que salga la ultima.

Despues de actualizar estos archivos, recarga la extension desde `chrome://extensions/` o `edge://extensions/` y recarga las paginas de video abiertas. El servidor local debe seguir iniciado: una extension de navegador no puede ejecutar `aria2c.exe` directamente. Las fuentes `blob:`, HLS (`.m3u8`) y DASH (`.mpd`) no se envian automaticamente a aria2.

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
- `GET /status?id=...` obtiene estado, progreso, velocidad, ETA, bytes continuos, objetivo de buffer y compatibilidad MP4.
- `GET /file?id=...` sirve el archivo local.
- `GET /delete?id=...` cancela y elimina la descarga.
- `GET /open-folder` abre la carpeta local.
- `GET /find?url=...` busca una descarga existente.

## Archivos eliminados

Se eliminaron archivos generados durante iteraciones anteriores, como changelogs temporales y `node_modules`. Las dependencias se instalan de nuevo con `install-dependencies.ps1` o con `npm install` dentro de `server`.

## Notas tecnicas

- El modo streaming usa hasta 16 conexiones y `stream-piece-selector=inorder` con piezas de 1 MiB.
- El servidor no confia en el tamano aparente del archivo disperso: calcula el prefijo seguro con `bitfield`, `pieceLength` y `numPieces` de aria2.
- Las URLs firmadas se envian inmediatamente con cookies, Referer, Origin y User-Agent de la pagina.
- Ante un `403`, la extension reintenta una vez con la fuente firmada disponible actualmente en la pagina.
- Un MP4 con `moov` al final puede necesitar completar la descarga antes de reproducirse.
- Algunos sitios generan URLs firmadas o temporales; por eso se guardan aliases y fingerprints adicionales.
- El reproductor local usa HTML5 `video`, `controls`, `autoplay` y `loop`.

## Pruebas

Desde `server`:

```cmd
npm test
```

Las pruebas cubren seleccion de calidad, deteccion de MP4 fast-start, `moov` al final, prefijo continuo a partir del bitfield y una respuesta HTTP Range que espera a que el archivo crezca.

Para comprobar el inicio automatico, las preferencias del popup y la limpieza al salir, desde la raiz del proyecto:

```cmd
node --test --test-isolation=none extension/extension.test.cjs
```

Estas pruebas simulan las APIs del navegador; la reproduccion real se comprueba cargando la extension con el servidor iniciado.

## Licencia

Uso personal y educativo. La compatibilidad puede variar segun el sitio, el tipo de video y las restricciones del servidor origen.
