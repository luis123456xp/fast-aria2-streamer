const autoStart = document.getElementById('auto-start');
const modes = document.querySelectorAll('input[name="close-mode"]');
const status = document.getElementById('status');
autoStart.disabled = true;
modes.forEach((mode) => { mode.disabled = true; });

async function saveSettings() {
  try {
    await chrome.storage.local.set({
      autoStart: autoStart.checked,
      keepOnClose: document.querySelector('input[name="close-mode"]:checked').value === 'keep'
    });
    status.textContent = 'Preferencias guardadas.';
  } catch (error) {
    status.textContent = `No se pudo guardar: ${error.message}`;
  }
}

chrome.storage.local.get({ autoStart: true, keepOnClose: true }).then((settings) => {
  autoStart.checked = settings.autoStart;
  modes.forEach((mode) => {
    mode.checked = mode.value === (settings.keepOnClose ? 'keep' : 'delete');
    mode.disabled = false;
    mode.addEventListener('change', saveSettings);
  });
  autoStart.disabled = false;
  autoStart.addEventListener('change', saveSettings);
  status.textContent = 'Estos ajustes se conservan al reiniciar el navegador.';
}).catch((error) => { status.textContent = `No se pudieron cargar las preferencias: ${error.message}`; });
