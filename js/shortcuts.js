// Shortcuts: one-tap actions run against the connected scooter.

import { readGearPair } from './diagnostic.js';
import { BOARD, MAX_SPEED_KMH, MIN_SPEED_KMH, SPEED_MODES } from './registers.js';

const STORAGE_KEY = 'zt3:shortcuts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (v === null || v === undefined ? '–' : v);
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const pairText = (bytes) => (bytes ? `${bytes[0]} / ${bytes[1]}` : '–');

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

function describe(pair, byte) {
  return {
    kmh: pair.value?.[byte] ?? null,
    min: pair.min?.[byte] ?? null,
    max: pair.max?.[byte] ?? null,
    usable: pair.usable?.[byte] ?? false,
  };
}

export async function readModeSpeed(scooter, modeKey) {
  const mode = SPEED_MODES[modeKey];
  const pair = await readGearPair(scooter, mode.pair);
  return { mode: modeKey, byte: mode.byte, pair, ...describe(pair, mode.byte) };
}

/** Reads all three modes while reading each gear pair register only once. */
export async function readAllModeSpeeds(scooter) {
  const pairs = {};
  const result = {};
  for (const [key, mode] of Object.entries(SPEED_MODES)) {
    try {
      pairs[mode.pair] ??= await readGearPair(scooter, mode.pair);
      const pair = pairs[mode.pair];
      result[key] = { mode: key, byte: mode.byte, pair, ...describe(pair, mode.byte) };
    } catch (err) {
      result[key] = { mode: key, error: err.message };
    }
  }
  return result;
}

/**
 * Sets the max speed of a riding mode.
 * The two speeds of a pair share one register, so the other byte is read first and written
 * back untouched. The target is clamped to the min/max the firmware reports for that byte,
 * and the write is verified by reading the register again.
 */
export async function setModeSpeed(scooter, modeKey, kmh, log = () => {}) {
  if (!SPEED_MODES[modeKey]) throw new Error(`Mode inconnu : ${modeKey}`);
  if (!isValidSpeed(kmh)) throw new Error(`Vitesse hors limites (${MIN_SPEED_KMH}–${MAX_SPEED_KMH} km/h).`);
  const mode = SPEED_MODES[modeKey];
  const byte = mode.byte;

  const pair = await readGearPair(scooter, mode.pair);
  log('info', `${pair.label} 0x${hex(pair.reg)} = ${pairText(pair.value)}`
    + ` | min ${pairText(pair.min)} | max ${pairText(pair.max)}`);

  if (!pair.usable[byte]) {
    throw new Error(`${pair.label} octet ${byte} inexploitable (valeur ${fmt(pair.value?.[byte])}, `
      + `min ${fmt(pair.min?.[byte])}, max ${fmt(pair.max?.[byte])}). Rien n'a été écrit : fais un `
      + `instantané dans « Diagnostic vitesse » et envoie-le.`);
  }
  if (!mode.proven) {
    log('warn', `Mode ${modeKey} = octet ${byte} de 0x${hex(pair.reg)}, déduit des plafonds annoncés `
      + `(${pair.max[0]} / ${pair.max[1]} km/h) et pas encore vérifié en roulant.`);
  }

  const target = Math.min(Math.max(kmh, pair.min[byte]), pair.max[byte]);
  if (target !== kmh) {
    log('warn', `Ce mode accepte ${pair.min[byte]}–${pair.max[byte]} km/h : ${kmh} ramené à ${target}.`);
  }

  const from = pair.value[byte];
  if (from !== target) {
    const bytes = Uint8Array.from(pair.value);
    bytes[byte] = target;
    log('info', `Écriture 0x${hex(pair.reg)} : ${pairText(pair.value)} → ${pairText(bytes)}`);
    const acked = await scooter.writeRegister(BOARD.VCU, pair.reg, bytes);
    if (!acked) log('warn', `0x${hex(pair.reg)} : pas d'accusé de réception.`);
    await sleep(300);

    const after = await readGearPair(scooter, mode.pair);
    log('info', `${pair.label} relu = ${pairText(after.value)}`);
    if (after.value?.[byte] !== target) {
      throw new Error(`La trottinette a gardé ${fmt(after.value?.[byte])} km/h au lieu de ${target} km/h.`);
    }
  }

  // The Segway app keeps a plain-km/h copy of the Sport limit in 0x6E, and it was observed
  // going stale (0x48 said 25 while 0x6E still said 20). Realign it on every run.
  if (mode.mirrorReg !== null) {
    try {
      const mirror = await scooter.probeRegister(BOARD.VCU, mode.mirrorReg, 2);
      const current = mirror && mirror.length >= 2 ? mirror[0] | (mirror[1] << 8) : null;
      if (current !== target) {
        await scooter.writeU16(BOARD.VCU, mode.mirrorReg, target);
        await sleep(200);
        const back = await scooter.probeRegister(BOARD.VCU, mode.mirrorReg, 2);
        const read = back && back.length >= 2 ? back[0] | (back[1] << 8) : null;
        log('info', `Copie 0x${hex(mode.mirrorReg)} : ${fmt(current)} → ${fmt(read)}`);
      }
    } catch (err) {
      log('warn', `Copie 0x${hex(mode.mirrorReg)} impossible : ${err.message}`);
    }
  }

  return { changed: from !== target, from, kmh: target, via: `0x${hex(pair.reg)} octet ${byte}` };
}

export async function runShortcut(scooter, shortcut, log) {
  if (shortcut.type === 'speed') return setModeSpeed(scooter, shortcut.mode, shortcut.kmh, log);
  throw new Error(`Type de raccourci inconnu : ${shortcut.type}`);
}
