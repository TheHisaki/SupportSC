import { Scooter } from './scooter.js';
import { BOARD, REG, MAX_SPEED_KMH, MIN_SPEED_KMH } from './registers.js';
import { readU32 } from './protocol.js';
import {
  isValidSpeed, loadShortcuts, readAllModeSpeeds, runShortcut, saveCustomShortcuts, shortcutLabel,
} from './shortcuts.js';

// Bumped on every deploy so you can check the phone shows the latest version.
const APP_VERSION = '1.1.0';

const $ = (id) => document.getElementById(id);

const ui = {
  status: $('status'),
  unsupported: $('unsupported'),
  connect: $('btn-connect'),
  disconnect: $('btn-disconnect'),
  forget: $('btn-forget'),
  nameOverride: $('name-override'),
  showAll: $('show-all'),
  dashboard: $('dashboard'),
  refresh: $('btn-refresh'),
  battery: $('stat-battery'),
  mileage: $('stat-mileage'),
  gear: $('stat-gear'),
  serial: $('stat-serial'),
  shortcutList: $('shortcut-list'),
  shortcutForm: $('shortcut-form'),
  scMode: $('sc-mode'),
  scSpeed: $('sc-speed'),
  log: $('log'),
  logDebug: $('log-debug'),
  copyLog: $('btn-copy-log'),
  clearLog: $('btn-clear-log'),
  pairing: $('pairing'),
  toast: $('toast'),
};

// ------------------------------------------------------------------ log

const logLines = [];

function log(level, message) {
  const time = new Date().toLocaleTimeString('fr-FR');
  logLines.push({ level, text: `[${time}] ${level.toUpperCase()} ${message}` });
  if (logLines.length > 600) logLines.shift();
  if (level === 'debug' && !ui.logDebug.checked) return;
  appendLogLine(logLines[logLines.length - 1]);
}

function appendLogLine({ level, text }) {
  const line = document.createElement('div');
  line.className = level;
  line.textContent = text;
  ui.log.appendChild(line);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function renderLog() {
  ui.log.replaceChildren();
  logLines.filter((l) => l.level !== 'debug' || ui.logDebug.checked).forEach(appendLogLine);
}

// ------------------------------------------------------------------ helpers

let toastTimer = null;
function toast(message, kind = 'ok') {
  ui.toast.textContent = message;
  ui.toast.className = `toast ${kind}`;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 4000);
}

function setStatus(state, text) {
  ui.status.className = `pill pill-${state}`;
  ui.status.textContent = text;
}

let busy = false;
async function withBusy(button, fn) {
  if (busy) return;
  busy = true;
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  const original = button?.textContent;
  if (button) button.textContent = '…';
  try {
    await fn();
  } catch (err) {
    log('error', err.message);
    toast(err.message, 'error');
  } finally {
    if (button) button.textContent = original;
    buttons.forEach((b) => { b.disabled = false; });
    busy = false;
    updateConnectionUi();
  }
}

// ------------------------------------------------------------------ scooter

const scooter = new Scooter({ log });

scooter.addEventListener('progress', (e) => { setStatus('busy', e.detail); log('info', e.detail); });
scooter.addEventListener('pairing-request', () => { ui.pairing.hidden = false; });
scooter.addEventListener('pairing-done', () => { ui.pairing.hidden = true; });
scooter.addEventListener('disconnected', () => {
  updateConnectionUi();
  toast('Trottinette déconnectée', 'error');
});

function updateConnectionUi() {
  const on = scooter.connected;
  setStatus(on ? 'on' : 'off', on ? 'Connectée' : 'Déconnectée');
  ui.connect.hidden = on;
  ui.connect.disabled = busy || !Scooter.isSupported();
  ui.disconnect.hidden = !on;
  ui.dashboard.hidden = !on;
  document.querySelectorAll('.shortcut .run').forEach((b) => { b.disabled = !on || busy; });
}

async function refreshDashboard() {
  ui.serial.textContent = scooter.serial || '–';

  const battery = await scooter.readU16(BOARD.VCU, REG.BATTERY).catch(() => null);
  ui.battery.textContent = battery === null ? '?' : `${battery} %`;

  const mileage = await scooter.readRegister(BOARD.VCU, REG.MILEAGE, 4).then(readU32).catch(() => null);
  ui.mileage.textContent = mileage === null ? '?' : `${(mileage / 100).toFixed(1)} km`;

  const gear = await scooter.readU16(BOARD.VCU, REG.GEAR_MODE).catch(() => null);
  ui.gear.textContent = gear === null ? '?' : `brut ${gear}`;

  const speeds = await readAllModeSpeeds(scooter);
  for (const [key, s] of Object.entries(speeds)) {
    const el = $(`speed-${key}`);
    if (s.error) el.textContent = '?';
    else if (s.kmh !== null) el.textContent = `${s.kmh} km/h`;
    else el.textContent = `brut ${s.raw}`;
    log('info', s.error ? `Mode ${key} : ${s.error}` : `Mode ${key} : brut ${s.raw}${s.scale ? ` → ${s.kmh} km/h` : ''}`);
  }
}

ui.connect.addEventListener('click', () => withBusy(ui.connect, async () => {
  try {
    await scooter.connect({ nameOverride: ui.nameOverride.value, showAll: ui.showAll.checked });
  } catch (err) {
    if (err.name === 'NotFoundError') { // picker closed or no device chosen
      log('info', 'Aucune trottinette choisie.');
      if (!ui.showAll.checked) {
        toast("Trottinette introuvable ? Coche « Afficher tous les appareils » dans les options avancées.", 'error');
      }
      return;
    }
    if (err.name === 'SecurityError') {
      throw new Error('Le Bluetooth web exige une page en HTTPS. Ouvre le lien https:// donné par le serveur.');
    }
    throw err;
  }
  toast('Trottinette connectée');
  updateConnectionUi();
  await refreshDashboard();
}));

ui.disconnect.addEventListener('click', () => withBusy(ui.disconnect, () => scooter.disconnect()));
ui.refresh.addEventListener('click', () => withBusy(ui.refresh, refreshDashboard));

ui.forget.addEventListener('click', () => {
  Object.keys(localStorage)
    .filter((k) => k.startsWith('zt3:pwd:') || k.startsWith('zt3:variant:'))
    .forEach((k) => localStorage.removeItem(k));
  log('info', 'Appairage enregistré oublié.');
  toast('Appairage oublié');
});

// ------------------------------------------------------------------ shortcuts

let shortcuts = loadShortcuts();

function renderShortcuts() {
  ui.shortcutList.replaceChildren();
  for (const sc of shortcuts) {
    const li = document.createElement('li');
    li.className = 'shortcut';

    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'btn btn-primary run';
    run.textContent = shortcutLabel(sc);
    run.addEventListener('click', () => withBusy(run, async () => {
      log('info', `Raccourci : ${shortcutLabel(sc)}`);
      const result = await runShortcut(scooter, sc, log);
      const msg = result.changed
        ? `Mode ${sc.mode} réglé à ${result.kmh} km/h`
        : `Mode ${sc.mode} déjà à ${result.kmh} km/h`;
      toast(msg);
      log('info', msg);
      $(`speed-${sc.mode}`).textContent = `${result.kmh} km/h`;
    }));
    li.appendChild(run);

    if (!sc.builtin) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn del';
      del.textContent = 'Suppr.';
      del.setAttribute('aria-label', `Supprimer le raccourci ${shortcutLabel(sc)}`);
      del.addEventListener('click', () => {
        shortcuts = shortcuts.filter((s) => s.id !== sc.id);
        saveCustomShortcuts(shortcuts);
        renderShortcuts();
      });
      li.appendChild(del);
    }
    ui.shortcutList.appendChild(li);
  }
  updateConnectionUi();
}

ui.shortcutForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const kmh = Number(ui.scSpeed.value);
  if (!isValidSpeed(kmh)) {
    toast(`Vitesse entre ${MIN_SPEED_KMH} et ${MAX_SPEED_KMH} km/h`, 'error');
    return;
  }
  const mode = ui.scMode.value;
  if (shortcuts.some((s) => s.mode === mode && s.kmh === kmh)) {
    toast('Ce raccourci existe déjà', 'error');
    return;
  }
  shortcuts.push({ id: `custom-${Date.now()}`, type: 'speed', mode, kmh });
  saveCustomShortcuts(shortcuts);
  renderShortcuts();
  toast('Raccourci ajouté');
});

// ------------------------------------------------------------------ log controls

ui.logDebug.addEventListener('change', renderLog);
ui.clearLog.addEventListener('click', () => { logLines.length = 0; renderLog(); });
ui.copyLog.addEventListener('click', async () => {
  const text = logLines.map((l) => l.text).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Journal copié');
  } catch {
    toast('Copie impossible, sélectionne le texte à la main', 'error');
  }
});

// ------------------------------------------------------------------ init

ui.scSpeed.min = String(MIN_SPEED_KMH);
ui.scSpeed.max = String(MAX_SPEED_KMH);

if (!window.isSecureContext) {
  ui.unsupported.querySelector('p').textContent =
    "Cette page n'est pas en HTTPS, donc le Bluetooth est bloqué. Ouvre le lien https:// affiché par le serveur (pas le lien http://).";
}
if (!Scooter.isSupported()) {
  ui.unsupported.hidden = false;
  ui.connect.disabled = true;
  log('warn', 'Web Bluetooth non disponible dans ce navigateur.');
}

$('app-version').textContent = APP_VERSION;
renderShortcuts();
log('info', `Prêt (version ${APP_VERSION}).`);
