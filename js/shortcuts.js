// Shortcuts: one-tap actions run against the connected scooter.

import { BOARD, MAX_SPEED_KMH, MIN_SPEED_KMH, SPEED_MODES } from './registers.js';

const STORAGE_KEY = 'zt3:shortcuts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_SHORTCUTS = [
  { id: 'builtin-s25', type: 'speed', mode: 'S', kmh: 25, builtin: true },
];

export function loadShortcuts() {
  let custom = [];
  try {
    custom = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    custom = [];
  }
  const valid = custom.filter((s) => s?.type === 'speed' && SPEED_MODES[s.mode] && isValidSpeed(s.kmh));
  return [...DEFAULT_SHORTCUTS, ...valid];
}

export function saveCustomShortcuts(shortcuts) {
  const custom = shortcuts.filter((s) => !s.builtin);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
  } catch { /* private mode */ }
}

export function isValidSpeed(kmh) {
  return Number.isInteger(kmh) && kmh >= MIN_SPEED_KMH && kmh <= MAX_SPEED_KMH;
}

export function shortcutLabel(s) {
  return `Mode ${s.mode} → ${s.kmh} km/h`;
}

/**
 * The unit of the gear-speed registers is not documented for the ZT3 Pro, so it is inferred
 * from the current value: whole km/h (e.g. 25) or tenths of km/h (e.g. 250).
 * Returns null when the value is ambiguous, in which case nothing is written.
 */
export function inferScale(raw) {
  if (raw >= 1 && raw <= 60) return 1;
  if (raw >= 100 && raw <= 600) return 10;
  return null;
}

export async function readModeSpeed(scooter, modeKey) {
  const mode = SPEED_MODES[modeKey];
  const raw = await scooter.readU16(BOARD.VCU, mode.reg);
  const scale = inferScale(raw);
  return { mode: modeKey, raw, scale, kmh: scale ? raw / scale : null };
}

export async function readAllModeSpeeds(scooter) {
  const result = {};
  for (const key of Object.keys(SPEED_MODES)) {
    try {
      result[key] = await readModeSpeed(scooter, key);
    } catch (err) {
      result[key] = { mode: key, error: err.message };
    }
  }
  return result;
}

/** Sets the max speed of a riding mode, then reads it back to confirm. */
export async function setModeSpeed(scooter, modeKey, kmh, log = () => {}) {
  if (!SPEED_MODES[modeKey]) throw new Error(`Mode inconnu : ${modeKey}`);
  if (!isValidSpeed(kmh)) throw new Error(`Vitesse hors limites (${MIN_SPEED_KMH}–${MAX_SPEED_KMH} km/h).`);
  const { reg } = SPEED_MODES[modeKey];

  const before = await readModeSpeed(scooter, modeKey);
  log('info', `Mode ${modeKey} : valeur actuelle brute = ${before.raw}`);
  if (!before.scale) {
    throw new Error(`Valeur actuelle du mode ${modeKey} non reconnue (${before.raw}). Écriture annulée par sécurité.`);
  }

  const target = kmh * before.scale;
  if (before.raw === target) return { changed: false, kmh };

  await scooter.writeU16(BOARD.VCU, reg, target);
  await sleep(300);

  const after = await scooter.readU16(BOARD.VCU, reg);
  log('info', `Mode ${modeKey} : relu ${after} (attendu ${target})`);
  if (after !== target) {
    throw new Error(`La trottinette a gardé ${after / before.scale} km/h au lieu de ${kmh} km/h.`);
  }
  return { changed: true, from: before.kmh, kmh };
}

export async function runShortcut(scooter, shortcut, log) {
  if (shortcut.type === 'speed') return setModeSpeed(scooter, shortcut.mode, shortcut.kmh, log);
  throw new Error(`Type de raccourci inconnu : ${shortcut.type}`);
}
