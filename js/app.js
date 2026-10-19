import { Scooter } from './scooter.js';
import {
  BOARD, BOARD_NAMES, REG, LEGAL_SPEED_KMH, MAX_SPEED_KMH, MIN_SPEED_KMH,
} from './registers.js';
import { readU32 } from './protocol.js';
import {
  isValidSpeed, loadShortcuts, readAllModeSpeeds, runShortcut, saveCustomShortcuts,
  shortcutDescription, shortcutLabel,
} from './shortcuts.js';
import {
  SPEED_PROBES, clearSnapshots, diffSnapshots, formatSnapshot, loadSnapshot, readProbes,
  saveSnapshot, sweepBoard,
} from './diagnostic.js';

// Bumped on every deploy so you can check the phone shows the latest version.
const APP_VERSION = '1.17.0';

const $ = (id) => document.getElementById(id);
const fmt = (v) => (v === null || v === undefined ? '–' : v);
const pairText = (bytes) => (bytes ? `${bytes[0]} / ${bytes[1]}` : '–');

const ui = {
  status: $('status'),
  unsupported: $('unsupported'),
  connectCard: $('connect-card'),
  connect: $('btn-connect'),
  disconnect: $('btn-disconnect'),
  forget: $('btn-forget'),
  nameOverride: $('name-override'),
  lastNameHint: $('last-name-hint'),
  dashboard: $('dashboard'),
  refresh: $('btn-refresh'),
  battery: $('stat-battery'),
  mileage: $('stat-mileage'),
  gearRaw: $('stat-gear-raw'),
  serial: $('stat-serial'),
  gearED: $('gear-ED'),
  gearSR: $('gear-SR'),
  shortcutList: $('shortcut-list'),
  shortcutForm: $('shortcut-form'),
  scMode: $('sc-mode'),
  scSpeed: $('sc-speed'),
  diagNeedle: $('diag-needle'),
  diagState: $('diag-state'),
  diagA: $('btn-diag-a'),
  diagB: $('btn-diag-b'),
  diagDiff: $('btn-diag-diff'),
  diagReset: $('btn-diag-reset'),
  diagSweep: $('btn-diag-sweep'),
  diagCopy: $('btn-diag-copy'),
  diagOut: $('diag-out'),
  wBoard: $('w-board'),
  wReg: $('w-reg'),
  wValue: $('w-value'),
  wNoReply: $('w-nr'),
  writeReg: $('btn-write-reg'),
  log: $('log'),
  logDebug: $('log-debug'),
  copyLog: $('btn-copy-log'),
  clearLog: $('btn-clear-log'),
  pairing: $('pairing'),
  pairingArmed: $('pairing-armed'),
  toast: $('toast'),
  debug: $('debug'),
  debugToggle: $('btn-debug'),
};

// ------------------------------------------------------------------ iOS shake to undo

// "Shake to Undo" is an iOS system feature that no web page can switch off. Its dialog only
// shows up when WebKit is holding a text-editing undo stack, which is why the speed fields
// are pickers rather than text inputs. This guard neutralises an undo that gets through
// anyway, so a shake can never silently change a value in the debug fields.
document.addEventListener('beforeinput', (event) => {
  if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
    event.preventDefault();
  }
}, { capture: true });

// ------------------------------------------------------------------ log

const logLines = [];

function log(level, message) {
  const time = new Date().toLocaleTimeString('fr-FR');
  logLines.push({ level, text: `[${time}] ${level.toUpperCase()} ${message}` });
  if (logLines.length > 2000) logLines.shift();
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
scooter.addEventListener('pairing-request', () => {
  ui.pairing.hidden = false;
  ui.pairingArmed.hidden = true;
});
// The scooter confirmed it is waiting for the button: from here one short press is enough.
scooter.addEventListener('pairing-armed', () => { ui.pairingArmed.hidden = false; });
scooter.addEventListener('pairing-done', () => { ui.pairing.hidden = true; });
scooter.addEventListener('disconnected', () => {
  updateConnectionUi();
  toast('Trottinette déconnectée', 'error');
});

function updateConnectionUi() {
  const on = scooter.connected;
  setStatus(on ? 'on' : 'off', on ? 'Connectée' : 'Déconnectée');
  ui.connectCard.hidden = on;
  ui.connect.disabled = busy || !Scooter.isSupported();
  ui.dashboard.hidden = !on;
  document.querySelectorAll('.shortcut .run').forEach((b) => { b.disabled = !on || busy; });
  [ui.diagA, ui.diagB, ui.diagSweep, ui.writeReg].forEach((b) => { b.disabled = !on || busy; });
}

async function refreshDashboard() {
  ui.serial.textContent = scooter.serial || '–';

  const battery = await scooter.readU16(BOARD.VCU, REG.BATTERY).catch(() => null);
  ui.battery.textContent = battery === null ? '?' : `${battery} %`;

  const mileage = await scooter.readRegister(BOARD.VCU, REG.MILEAGE, 4).then(readU32).catch(() => null);
  ui.mileage.textContent = mileage === null ? '?' : `${(mileage / 100).toFixed(1)} km`;

  const gear = await scooter.readU16(BOARD.VCU, REG.GEAR_MODE).catch(() => null);
  ui.gearRaw.textContent = fmt(gear);

  const speeds = await readAllModeSpeeds(scooter);
  const pairs = {};
  for (const [key, s] of Object.entries(speeds)) {
    const el = $(`speed-${key}`);
    if (s.error) {
      el.textContent = '?';
      log('warn', `Mode ${key} : ${s.error}`);
      continue;
    }
    pairs[s.pair.key] = s.pair;
    el.textContent = s.kmh === null ? '–' : `${s.kmh} km/h`;
    log('info', `Mode ${key} = ${fmt(s.kmh)} km/h (0x${s.pair.reg.toString(16)} octet ${s.byte}, `
      + `plage ${fmt(s.min)}–${fmt(s.max)})`);
  }

  for (const [key, p] of Object.entries(pairs)) {
    const el = $(`gear-${key}`);
    if (!el) continue;
    el.textContent = pairText(p.value);
    log('info', `${p.label} 0x${p.reg.toString(16)} = ${pairText(p.value)}`
      + ` | min ${pairText(p.min)} | max ${pairText(p.max)}`);
  }
}

ui.connect.addEventListener('click', () => withBusy(ui.connect, async () => {
  try {
    await scooter.connect({ nameOverride: ui.nameOverride.value });
  } catch (err) {
    if (err.name === 'NotFoundError') { // picker closed or no device chosen
      log('info', 'Aucune trottinette choisie.');
      toast("Pas dans la liste ? Ferme les autres applis de trottinette, rallume-la et réessaie.", 'error');
      return;
    }
    if (err.name === 'SecurityError') {
      throw new Error('Le Bluetooth web exige une page en HTTPS. Ouvre le lien https:// donné par le serveur.');
    }
    throw err;
  }
  toast('Trottinette connectée');
  showLastNameHint();
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
    run.setAttribute('aria-label', `Régler le ${shortcutDescription(sc)}`);
    run.addEventListener('click', () => withBusy(run, async () => {
      log('info', `Raccourci : ${shortcutDescription(sc)}`);
      const result = await runShortcut(scooter, sc, log);
      const msg = result.refused
        ? `Mode ${sc.mode} : ${result.requested} km/h refusé, la trottinette garde ${fmt(result.kmh)} km/h`
        : result.changed
          ? `Mode ${sc.mode} réglé à ${result.kmh} km/h`
          : `Mode ${sc.mode} déjà à ${result.kmh} km/h`;
      toast(msg, result.refused ? 'error' : 'ok');
      log(result.refused ? 'warn' : 'info', `${msg} (via ${result.via})`);
      await refreshDashboard();
    }));
    li.appendChild(run);

    if (!sc.builtin) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn del';
      del.textContent = '✕';
      del.setAttribute('aria-label', `Supprimer le raccourci ${shortcutDescription(sc)}`);
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

// ------------------------------------------------------------------ diagnostic

// Snapshots are kept in localStorage: going to the Segway app and back reloads the page
// in Bluefy, which used to wipe snapshot A before it could be compared.
const snapshots = { A: loadSnapshot('A'), B: loadSnapshot('B') };

function setDiag(text) {
  ui.diagOut.textContent = text;
}

function snapshotSummary() {
  return ['A', 'B']
    .map((slot) => `${slot} : ${snapshots[slot] ? new Date(snapshots[slot].at).toLocaleTimeString('fr-FR') : '–'}`)
    .join('   ');
}

function showSnapshotSummary() {
  ui.diagState.textContent = `Instantanés en mémoire — ${snapshotSummary()}`;
}

/** Also pushed to the journal line by line, so "Copier le journal" carries the dump. */
function reportDiag(title, body) {
  const text = `${title}\n${body}`;
  setDiag(text);
  log('info', title);
  body.split('\n').filter(Boolean).forEach((line) => log('info', line));
}

function diagNeedle() {
  const v = Number(ui.diagNeedle.value);
  return Number.isInteger(v) && v > 0 ? v : null;
}

async function takeSnapshot(slot) {
  setDiag(`Lecture des registres (instantané ${slot})…`);
  const snap = await readProbes(scooter, SPEED_PROBES, {
    onProgress: (done, total) => setStatus('busy', `Lecture ${done}/${total}`),
  });
  snapshots[slot] = snap;
  saveSnapshot(slot, snap);
  showSnapshotSummary();
  const needle = diagNeedle();
  reportDiag(
    `Instantané ${slot} — ${new Date(snap.at).toLocaleTimeString('fr-FR')}`
    + (needle ? ` — recherche de ${needle} et ${needle * 10}` : ''),
    formatSnapshot(snap, { needle }),
  );
}

ui.diagA.addEventListener('click', () => withBusy(ui.diagA, () => takeSnapshot('A')));
ui.diagB.addEventListener('click', () => withBusy(ui.diagB, () => takeSnapshot('B')));

ui.diagReset.addEventListener('click', () => {
  snapshots.A = null;
  snapshots.B = null;
  clearSnapshots();
  showSnapshotSummary();
  setDiag('');
  toast('Instantanés effacés');
});

ui.diagDiff.addEventListener('click', () => {
  if (!snapshots.A || !snapshots.B) {
    toast(`Instantané manquant — ${snapshotSummary()}`, 'error');
    return;
  }
  const lines = diffSnapshots(snapshots.A, snapshots.B);
  reportDiag(
    'Différences A → B',
    lines.length ? lines.join('\n') : 'Aucun registre lu n\'a changé : le réglage est ailleurs, lance un scan complet.',
  );
});

ui.diagSweep.addEventListener('click', () => withBusy(ui.diagSweep, async () => {
  setDiag('Scan complet du VCU (0x00 à 0xFF)… ça peut prendre une à deux minutes.');
  const snap = await sweepBoard(scooter, BOARD.VCU, {
    onProgress: (done, total) => setStatus('busy', `Scan ${done}/${total}`),
  });
  snapshots.sweep = snap;
  const needle = diagNeedle();
  reportDiag(
    `Scan VCU — ${new Date(snap.at).toLocaleTimeString('fr-FR')}`
    + (needle ? ` — recherche de ${needle} et ${needle * 10}` : ''),
    formatSnapshot(snap, { needle, skipSilent: true }),
  );
}));

ui.diagCopy.addEventListener('click', async () => {
  const text = ui.diagOut.textContent;
  if (!text.trim()) {
    toast('Rien à copier', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Résultat copié');
  } catch {
    toast('Copie impossible, sélectionne le texte à la main', 'error');
  }
});

ui.writeReg.addEventListener('click', () => withBusy(ui.writeReg, async () => {
  const board = Number(ui.wBoard.value);
  const reg = parseInt(ui.wReg.value.replace(/[^0-9a-f]/gi, ''), 16);
  const value = Number(ui.wValue.value);
  if (!Number.isInteger(reg) || reg < 0 || reg > 0xff) throw new Error('Registre invalide (2 chiffres hexa, ex. 48).');
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error('Valeur invalide (0 à 65535).');

  const noReply = ui.wNoReply.checked;
  const where = `${BOARD_NAMES[board] ?? board} 0x${reg.toString(16).toUpperCase().padStart(2, '0')}`;
  if (!window.confirm(`Écrire ${value} dans ${where}${noReply ? ' (sans accusé)' : ''} ?`)) return;

  const acked = await scooter.writeU16(board, reg, value, { noReply });
  log('info', `Écriture ${where} = ${value}${acked ? '' : ' (pas d\'accusé)'}`);
  const back = await scooter.probeRegister(board, reg, 2);
  const read = back && back.length >= 2 ? back[0] | (back[1] << 8) : null;
  reportDiag(`Écriture manuelle ${where} = ${value}`, `relecture : ${fmt(read)}`);
  toast(read === value ? `${where} = ${value}` : `${where} relu à ${fmt(read)}`, read === value ? 'ok' : 'error');
}));

// ------------------------------------------------------------------ debug mode

const DEBUG_KEY = 'zt3:debug';

function setDebugMode(on) {
  ui.debug.hidden = !on;
  ui.debugToggle.setAttribute('aria-pressed', String(on));
  ui.debugToggle.textContent = on ? 'Masquer le débogage' : 'Débogage';
  try {
    if (on) localStorage.setItem(DEBUG_KEY, '1');
    else localStorage.removeItem(DEBUG_KEY);
  } catch { /* private mode */ }
}

ui.debugToggle.addEventListener('click', () => {
  const on = ui.debug.hidden;
  setDebugMode(on);
  if (on) ui.debug.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

/** Fills a <select> with whole numbers. Pickers avoid the keyboard, and the keyboard is
 *  what builds the iOS undo stack behind the "Undo Typing" shake dialog. */
function fillNumberPicker(select, { min, max, selected = null, blankLabel = null }) {
  const options = document.createDocumentFragment();
  if (blankLabel !== null) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankLabel;
    options.appendChild(blank);
  }
  for (let value = min; value <= max; value++) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = String(value);
    option.selected = value === selected;
    options.appendChild(option);
  }
  select.replaceChildren(options);
}

fillNumberPicker(ui.scSpeed, { min: MIN_SPEED_KMH, max: MAX_SPEED_KMH, selected: LEGAL_SPEED_KMH });
fillNumberPicker(ui.diagNeedle, { min: 1, max: 100, blankLabel: '—' });

if (!window.isSecureContext) {
  ui.unsupported.querySelector('p').textContent =
    "Cette page n'est pas en HTTPS, donc le Bluetooth est bloqué. Ouvre le lien https:// affiché par le serveur (pas le lien http://).";
}
if (!Scooter.isSupported()) {
  ui.unsupported.hidden = false;
  ui.connect.disabled = true;
  log('warn', 'Web Bluetooth non disponible dans ce navigateur.');
}

function showLastNameHint() {
  const name = Scooter.lastScooterName();
  ui.lastNameHint.textContent = name ? ` — la tienne : ${name}` : '';
}

$('app-version').textContent = APP_VERSION;
showLastNameHint();
showSnapshotSummary();
try {
  setDebugMode(localStorage.getItem(DEBUG_KEY) === '1');
} catch {
  setDebugMode(false);
}
renderShortcuts();
log('info', `Prêt (version ${APP_VERSION}).`);
