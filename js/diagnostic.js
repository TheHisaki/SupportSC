// Register explorer. The ZT3 packs two gear speeds per register (one per byte), so the
// diff between two snapshots is reported byte by byte: that is what pinned down 0x48 as
// the register driving the Sport limit.

import { fromHex, toHex } from './crypto.js';
import { readU16 } from './protocol.js';
import { BOARD, BOARD_NAMES, GEAR_PAIR, REG } from './registers.js';

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
  // Gear bank documented for the wider Ninebot family; answers all zeroes on the ZT3.
  { board: BOARD.MCU, reg: 0x09, len: 2, name: 'rMCUMaxSpeed' },
  { board: BOARD.MCU, reg: 0x31, len: 2, name: 'GearTopSpeed' },
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

// ---------------------------------------------------------------- snapshot storage

// Snapshots survive a page reload, because switching to the Segway app and back reloads
// the page in Bluefy and used to lose snapshot A.

const slotKey = (slot) => `zt3:diag:${slot}`;

export function saveSnapshot(slot, snapshot) {
  const payload = {
    at: snapshot.at,
    rows: snapshot.rows.map(({ board, reg, len, name, bytes, error }) => ({
      board, reg, len, name, error: error ?? null, hex: bytes ? toHex(bytes, '') : null,
    })),
  };
  try {
    localStorage.setItem(slotKey(slot), JSON.stringify(payload));
  } catch { /* private mode or quota */ }
}

export function loadSnapshot(slot) {
  let payload = null;
  try {
    payload = JSON.parse(localStorage.getItem(slotKey(slot)) ?? 'null');
  } catch {
    return null;
  }
  if (!payload?.rows?.length) return null;
  return {
    at: payload.at,
    rows: payload.rows.map((r) => {
      const bytes = r.hex ? fromHex(r.hex) : null;
      return { ...r, bytes, value: bytes && bytes.length >= 2 ? readU16(bytes) : null };
    }),
  };
}

export function clearSnapshots() {
  for (const slot of ['A', 'B']) {
    try { localStorage.removeItem(slotKey(slot)); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- gear pairs

/** A gear speed is plausible as whole km/h in this window (walk mode excluded). */
const isPlausibleKmh = (v) => Number.isInteger(v) && v >= 1 && v <= 100;

/**
 * Reads a gear pair: the two packed speeds plus the two packed min/max bounds.
 * `usable` means the three registers answered and form a coherent km/h range.
 */
export async function readGearPair(scooter, pairKey) {
  const pair = GEAR_PAIR[pairKey];
  if (!pair) throw new Error(`Paire inconnue : ${pairKey}`);
  const read = async (reg) => {
    const bytes = await scooter.probeRegister(BOARD.VCU, reg, 2);
    return bytes && bytes.length >= 2 ? [bytes[0], bytes[1]] : null;
  };
  const value = await read(pair.reg);
  const min = await read(pair.minReg);
  const max = await read(pair.maxReg);
  const coherent = (i) => isPlausibleKmh(min?.[i]) && isPlausibleKmh(max?.[i])
    && min[i] < max[i] && value?.[i] >= min[i] && value[i] <= max[i];
  return {
    ...pair,
    value,
    min,
    max,
    usable: [0, 1].map(coherent),
  };
}

export async function readAllGearPairs(scooter) {
  const out = {};
  for (const key of Object.keys(GEAR_PAIR)) {
    try {
      out[key] = await readGearPair(scooter, key);
    } catch (err) {
      out[key] = { ...GEAR_PAIR[key], error: err.message };
    }
  }
  return out;
}

// ---------------------------------------------------------------- formatting

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
    // Two-byte registers are shown as "o0 / o1" because the gear registers pack one
    // speed per byte; the u16 value alone is meaningless there.
    const packed = row.bytes.length === 2 ? `  ${row.bytes[0]} / ${row.bytes[1]}` : '';
    let line = `${label} [${toHex(row.bytes)}]${packed}`;
    const hits = needleHits(row, needle);
    if (hits.length) line += `  <<< ${hits.join(', ')}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/** Lists what changed between two snapshots, byte by byte for packed registers. */
export function diffSnapshots(before, after) {
  const index = new Map(before.rows.map((r) => [probeKey(r), r]));
  const lines = [];
  for (const row of after.rows) {
    const old = index.get(probeKey(row));
    if (!old) continue;
    const a = old.bytes?.length ? toHex(old.bytes) : null;
    const b = row.bytes?.length ? toHex(row.bytes) : null;
    if (a === b) continue;
    let line = `${probeLabel(row).padEnd(26)} [${a ?? '–'}] -> [${b ?? '–'}]`;
    if (old.bytes?.length === row.bytes?.length) {
      const changed = [];
      for (let i = 0; i < row.bytes.length; i++) {
        if (old.bytes[i] !== row.bytes[i]) changed.push(`octet ${i} : ${old.bytes[i]} -> ${row.bytes[i]}`);
      }
      if (changed.length) line += `  (${changed.join(', ')})`;
    }
    lines.push(line);
  }
  return lines;
}
