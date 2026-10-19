// Register explorer. The ZT3 firmware exposes several speed/gear registers and the
// documentation does not say which one actually limits the vehicle, so the only reliable
// way to find it is to read them all, change the value in the Segway app, read them again
// and diff the two snapshots.

import { toHex } from './crypto.js';
import { readU16 } from './protocol.js';
import { BOARD, BOARD_NAMES, GEAR_FAMILY, REG } from './registers.js';

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** Candidate registers for "max speed per riding mode", from the ZT3 Pro command table. */
export const SPEED_PROBES = Object.freeze([
  { board: BOARD.VCU, reg: REG.BOOL, len: 2, name: 'rBool' },
  { board: BOARD.VCU, reg: REG.FUN_BOOL, len: 2, name: 'rFunBool' },
  { board: BOARD.VCU, reg: REG.FUN_BOOL2, len: 2, name: 'rFunBool2' },
  { board: BOARD.VCU, reg: REG.FUN_BOOL3, len: 2, name: 'rFunBool3' },
  { board: BOARD.VCU, reg: REG.FUN_BOOL4, len: 2, name: 'rFunBool4' },
  { board: BOARD.VCU, reg: REG.START_SPEED, len: 2, name: 'rStartSpeed' },
  { board: BOARD.VCU, reg: REG.GEAR_ED_MIN, len: 2, name: 'rGearEDMin' },
  { board: BOARD.VCU, reg: REG.GEAR_SR_MIN, len: 2, name: 'rGearSRMin' },
  { board: BOARD.VCU, reg: REG.GEAR_ED_MAX, len: 2, name: 'rGearEDMax' },
  { board: BOARD.VCU, reg: REG.GEAR_SR_MAX, len: 2, name: 'rGearSRMax' },
  { board: BOARD.VCU, reg: REG.GEAR_ED, len: 2, name: 'rGearED' },
  { board: BOARD.VCU, reg: REG.GEAR_SR, len: 2, name: 'rGearSR' },
  { board: BOARD.VCU, reg: REG.GEAR_MODE, len: 2, name: 'rGearMode' },
  { board: BOARD.VCU, reg: REG.DEC_MODE, len: 2, name: 'readDecMode' },
  { board: BOARD.VCU, reg: REG.S_GEAR_SPEED, len: 2, name: 'rSGear' },
  { board: BOARD.VCU, reg: REG.E_GEAR_SPEED, len: 2, name: 'rEGear' },
  { board: BOARD.VCU, reg: REG.D_GEAR_SPEED, len: 2, name: 'rDGear' },
  // Gear bank documented for the wider Ninebot family; may be absent on the ZT3.
  { board: BOARD.MCU, reg: 0x09, len: 2, name: 'rMCUMaxSpeed' },
  { board: BOARD.MCU, reg: 0x22, len: 32, name: 'rGearData1' },
  { board: BOARD.MCU, reg: 0x31, len: 2, name: 'GearTopSpeed' },
  { board: BOARD.MCU, reg: 0x3a, len: 32, name: 'rGearData2' },
  { board: BOARD.MCU, reg: 0x49, len: 2, name: 'GearTopSpeed2' },
  { board: BOARD.MCU, reg: 0x52, len: 2, name: 'rSpeedIntensity' },
  { board: BOARD.MCU, reg: 0x53, len: 2, name: 'rSpeedSafeLock' },
]);

const PROBE_NAMES = new Map(SPEED_PROBES.map((p) => [`${p.board}:${p.reg}`, p.name]));

export function probeKey(probe) {
  return `${probe.board}:${probe.reg}:${probe.len}`;
}

export function probeLabel({ board, reg, name }) {
  const where = `${BOARD_NAMES[board] ?? `0x${hex2(board)}`} 0x${hex2(reg)}`;
  const label = name || PROBE_NAMES.get(`${board}:${reg}`) || '';
  return `${where} ${label}`.trimEnd();
}

/**
 * Reads every probe once. Registers the vehicle does not implement simply stay silent and
 * are reported as "pas de réponse" instead of aborting the run.
 */
export async function readProbes(scooter, probes, { onProgress } = {}) {
  const rows = [];
  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i];
    onProgress?.(i + 1, probes.length, probe);
    let bytes = null;
    let error = null;
    try {
      bytes = await scooter.probeRegister(probe.board, probe.reg, probe.len);
    } catch (err) {
      if (err.code === 'DISCONNECTED' || err.code === 'NOT_CONNECTED') throw err;
      error = err.message;
    }
    rows.push({
      ...probe,
      bytes,
      error,
      value: bytes && bytes.length >= 2 ? readU16(bytes) : null,
    });
  }
  return { at: Date.now(), rows };
}

/** Reads a whole board address range, 2 bytes per register. */
export function sweepBoard(scooter, board, { from = 0x00, to = 0xff, len = 2, onProgress } = {}) {
  const probes = [];
  for (let reg = from; reg <= to; reg++) probes.push({ board, reg, len, name: '' });
  return readProbes(scooter, probes, { onProgress });
}

/** A max-speed setting is plausible as whole km/h in this window (walk mode excluded). */
const isPlausibleKmh = (v) => Number.isInteger(v) && v >= 5 && v <= 100;

/** Reads a gear family (current value + the min/max the firmware accepts). */
export async function readGearFamily(scooter, familyKey) {
  const family = GEAR_FAMILY[familyKey];
  if (!family) throw new Error(`Famille inconnue : ${familyKey}`);
  const read = async (reg) => {
    const bytes = await scooter.probeRegister(BOARD.VCU, reg, 2);
    return bytes && bytes.length >= 2 ? readU16(bytes) : null;
  };
  const [value, min, max] = [await read(family.reg), await read(family.minReg), await read(family.maxReg)];
  const usable = isPlausibleKmh(value) && isPlausibleKmh(min) && isPlausibleKmh(max)
    && min < max && value >= min && value <= max;
  return { ...family, value, min, max, usable };
}

export async function readAllGearFamilies(scooter) {
  const out = {};
  for (const key of Object.keys(GEAR_FAMILY)) {
    try {
      out[key] = await readGearFamily(scooter, key);
    } catch (err) {
      out[key] = { ...GEAR_FAMILY[key], error: err.message };
    }
  }
  return out;
}

function needleHits(row, needle) {
  if (!needle || !row.bytes?.length) return [];
  const hits = [];
  if (row.value === needle) hits.push(`= ${needle}`);
  if (row.value === needle * 10) hits.push(`= ${needle} x10`);
  row.bytes.forEach((b, i) => {
    if (b === needle) hits.push(`octet ${i} = ${needle}`);
  });
  return hits;
}

/** Renders a snapshot as a fixed-width table, one register per line. */
export function formatSnapshot(snapshot, { needle = null, skipSilent = false } = {}) {
  const lines = [];
  for (const row of snapshot.rows) {
    const label = probeLabel(row).padEnd(26);
    if (row.error) {
      lines.push(`${label} ERREUR ${row.error}`);
      continue;
    }
    if (!row.bytes?.length) {
      if (!skipSilent) lines.push(`${label} –`);
      continue;
    }
    let line = `${label} ${String(row.value ?? '?').padStart(6)}  [${toHex(row.bytes)}]`;
    const hits = needleHits(row, needle);
    if (hits.length) line += `  <<< ${hits.join(', ')}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/** Lists the registers whose content differs between two snapshots. */
export function diffSnapshots(before, after) {
  const index = new Map(before.rows.map((r) => [probeKey(r), r]));
  const lines = [];
  for (const row of after.rows) {
    const old = index.get(probeKey(row));
    if (!old) continue;
    const a = old.bytes?.length ? toHex(old.bytes) : '–';
    const b = row.bytes?.length ? toHex(row.bytes) : '–';
    if (a === b) continue;
    const va = old.value ?? '?';
    const vb = row.value ?? '?';
    lines.push(`${probeLabel(row).padEnd(26)} ${String(va).padStart(6)} -> ${String(vb).padStart(6)}  [${a}] -> [${b}]`);
  }
  return lines;
}
