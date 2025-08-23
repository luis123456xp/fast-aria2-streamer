# Fast Aria2 Streamer

Extensión + servidor local para **descargar y reproducir videos en streaming con aria2c** directamente en tu navegador.

Permite:
- Reemplazar un `<video>` embebido en una página por una versión descargada localmente usando **aria2c**.
- Mostrar progreso en un panel flotante (bytes descargados y velocidad).
- Minimizar a un **punto flotante** discreto y restaurar con un clic.
- Conservar descargas activas al cerrar la pestaña (`Mantener al cerrar`).
- Reanudar o detectar descargas previas si visitas la misma URL otra vez.
- Abrir la carpeta local de descargas (`%TEMP%\aria2_streamer`).

---

## Requisitos

### 1. aria2c
Debes tener instalado **aria2** en tu sistema.

- **Windows**:  
  Descarga binarios desde: [https://aria2.github.io/](https://aria2.github.io/) o usa `choco install aria2` si tienes Chocolatey.  
  Asegúrate de que `aria2c.exe` esté en tu `PATH`.

- **Linux (Debian/Ubuntu)**:  
  ```bash
  sudo apt-get install aria2
  ```

- **macOS (Homebrew)**:  
  ```bash
  brew install aria2
  ```

Prueba que funciona ejecutando:
```bash
aria2c --version
```

### 2. Node.js
Requiere Node.js >= 16 (se recomienda la versión LTS más reciente).  
Verifica con:
```bash
node -v
```

---

## Instalación

1. Clona este repositorio o descarga el `.zip` del proyecto.
2. Entra en la carpeta `server/`:
   ```bash
   cd server
   npm install
   ```
   *(Actualmente no hay dependencias aparte de `express`, `helmet`.)*

3. Inicia el servidor local:
   ```bash
   node server.js
   ```
   Esto levantará un servicio en:  
   [http://127.0.0.1:7777](http://127.0.0.1:7777)

   Por defecto usará la carpeta:  
   - **Windows**: `%TEMP%\aria2_streamer`  
   - **Linux/macOS**: `/tmp/aria2_streamer`

4. Carga la extensión en Chrome/Edge/Brave:

   - Abre `chrome://extensions/`
   - Activa **Modo desarrollador**
   - Haz clic en **Cargar descomprimida**
   - Selecciona la carpeta `extension/`

---

## Uso

1. Abre una página con un `<video>` (por ejemplo un `.mp4` incrustado).
2. Verás un botón flotante en la esquina inferior derecha:  
   **“Descargar con aria2”**
3. Haz clic → el servidor local inicia la descarga con `aria2c`.
4. El video en la página se sustituye por la versión local tan pronto como la descarga termina.
5. El panel muestra:
   - Bytes descargados
   - Velocidad actual
   - Estado de la tarea
6. Botones disponibles en el panel:
   - **Minimizar** → se esconde la tarjeta, queda un punto flotante.  
   - **Abrir carpeta local** → abre `%TEMP%\aria2_streamer`.  
   - **Eliminar archivo** → cancela y borra la descarga.  
   - **Cerrar** → cierra el panel (si no marcaste “Mantener al cerrar”, también borra la descarga al cerrar pestaña).

### Precarga automática
- Si visitas la misma URL y ya existía un archivo descargado o en curso, la extensión detecta la descarga y:
  - Si estaba **completada**, reemplaza el `<video>` inmediatamente.  
  - Si estaba **en curso**, muestra el panel y reanuda el monitoreo.

---

## Endpoints del servidor

El servidor expone las siguientes rutas:

- `GET /start?url=...` → Inicia una descarga con aria2c.
- `GET /status?id=...` → Retorna estado: `downloaded`, `total`, `speedBps`, `done`.
- `GET /file?id=...` → Devuelve el archivo descargado.
- `GET /delete?id=...` → Cancela y elimina el archivo.
- `GET /open-folder` → Abre la carpeta local `%TEMP%\aria2_streamer`.
- `GET /find?url=...` → Verifica si ya existe una descarga para esa URL.

---

## Notas

- Los archivos se guardan en:  
  `%TEMP%\aria2_streamer` (Windows)  
  `/tmp/aria2_streamer` (Linux/macOS)
- Si cierras el navegador sin marcar **“Mantener al cerrar”**, la descarga se cancela automáticamente.
- El panel no muestra ETA ni barra de progreso, solo **velocidad** y **bytes descargados**.

---

## Ejemplo rápido

1. Inicia el servidor:
   ```bash
   node server.js
   ```
2. Abre un sitio con `<video>` incrustado.
3. Pulsa **Descargar con aria2**.
4. Espera a que finalice y disfruta de la reproducción local más fluida.

---

## Licencia
Uso personal / educativo. No garantizamos compatibilidad con todos los sitios.
