// Shortcuts: one-tap actions run against the connected scooter.

import { readGearFamily } from './diagnostic.js';
import { BOARD, MAX_SPEED_KMH, MIN_SPEED_KMH, SPEED_MODES } from './registers.js';

const STORAGE_KEY = 'zt3:shortcuts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (v === null || v === undefined ? '–' : v);

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
 * The unit of the gear registers is not documented for the ZT3 Pro, so it is inferred from
 * the current value: whole km/h (e.g. 25) or tenths of km/h (e.g. 250). A max speed below
 * 5 km/h makes no sense, so such a value means the register holds something else (a gear
 * index, a flag…) and must not be overwritten with km/h.
 */
export function inferScale(raw) {
  if (raw >= 5 && raw <= 60) return 1;
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

/**
 * Sets the max speed of a riding mode, then reads it back to confirm.
 * Prefers the gear-speed register of the mode's family (E/D or S/R), because that one comes
 * with the min/max the firmware accepts, so the write can be clamped instead of guessed.
 * Falls back to the per-mode register only when it already holds a value that looks like a
 * speed — writing km/h into a register that holds something else is worse than failing.
 */
export async function setModeSpeed(scooter, modeKey, kmh, log = () => {}) {
  if (!SPEED_MODES[modeKey]) throw new Error(`Mode inconnu : ${modeKey}`);
  if (!isValidSpeed(kmh)) throw new Error(`Vitesse hors limites (${MIN_SPEED_KMH}–${MAX_SPEED_KMH} km/h).`);
  const mode = SPEED_MODES[modeKey];

  const family = await readGearFamily(scooter, mode.family);
  log('info', `${family.label} (0x${family.reg.toString(16)}) = ${fmt(family.value)} `
    + `(min ${fmt(family.min)}, max ${fmt(family.max)})`);

  if (family.usable) {
    const target = Math.min(Math.max(kmh, family.min), family.max);
    if (target !== kmh) {
      log('warn', `La trottinette n'accepte que ${family.min}–${family.max} km/h : ${kmh} ramené à ${target}.`);
    }
    if (family.value === target) return { changed: false, kmh: target, via: family.label };
    const acked = await scooter.writeU16(BOARD.VCU, family.reg, target);
    if (!acked) log('warn', `${family.label} : écriture sans accusé de réception.`);
    await sleep(300);
    const after = await scooter.readU16(BOARD.VCU, family.reg);
    log('info', `${family.label} : relu ${after} (attendu ${target})`);
    if (after !== target) {
      throw new Error(`La trottinette a gardé ${after} km/h au lieu de ${target} km/h.`);
    }
    return { changed: true, from: family.value, kmh: target, via: family.label };
  }

  const before = await readModeSpeed(scooter, modeKey);
  log('info', `Mode ${modeKey} : registre 0x${mode.reg.toString(16)} = ${before.raw}`);
  if (!before.scale) {
    throw new Error(`Aucun registre de vitesse exploitable pour le mode ${modeKey} : ${family.label} = `
      + `${fmt(family.value)} et 0x${mode.reg.toString(16)} = ${before.raw}, ce ne sont pas des km/h. `
      + `Ouvre « Diagnostic vitesse », fais un instantané et envoie-le : rien n'a été écrit.`);
  }

  const target = kmh * before.scale;
  if (before.raw === target) return { changed: false, kmh, via: `registre 0x${mode.reg.toString(16)}` };

  await scooter.writeU16(BOARD.VCU, mode.reg, target);
  await sleep(300);

  const after = await scooter.readU16(BOARD.VCU, mode.reg);
  log('info', `Mode ${modeKey} : relu ${after} (attendu ${target})`);
  if (after !== target) {
    throw new Error(`La trottinette a gardé ${after / before.scale} km/h au lieu de ${kmh} km/h.`);
  }
  return { changed: true, from: before.kmh, kmh, via: `registre 0x${mode.reg.toString(16)}` };
}

export async function runShortcut(scooter, shortcut, log) {
  if (shortcut.type === 'speed') return setModeSpeed(scooter, shortcut.mode, shortcut.kmh, log);
  throw new Error(`Type de raccourci inconnu : ${shortcut.type}`);
}
