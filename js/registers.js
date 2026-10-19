// Segway ZT3 Pro register map (hardware id 256).
// Sources:
//  - https://nootnooot.codeberg.page/segway-ninebot-ble/ (device page "Segway ZT3 Pro", 191 commands)
//  - https://gist.github.com/djensenius/48d6aef55a4ad403775cc5ff5fe92f53 (GT3 Pro, same "x3" platform)

export const BOARD = Object.freeze({
  MCU: 0x02,
  BLE: 0x04, // handshake target on "1CG…" scooters (0x21 on the others, see scooter.js)
  BMS2: 0x06,
  BMS1: 0x07,
  VCU: 0x16, // vehicle control unit: settings + telemetry
  TFT: 0x23,
});

export const BOARD_NAMES = Object.freeze({
  [BOARD.MCU]: 'MCU',
  [BOARD.BLE]: 'BLE',
  [BOARD.BMS2]: 'BMS2',
  [BOARD.BMS1]: 'BMS1',
  [BOARD.VCU]: 'VCU',
  [BOARD.TFT]: 'TFT',
});

export const REG = Object.freeze({
  SN: 0x10, // 14 bytes ASCII
  CTRL_VERSION: 0x17,
  BOOL: 0x1c, // rBool: bit 0 = powered on, bit 5 = standby
  FUN_BOOL: 0x1d,
  FUN_BOOL2: 0x1e,
  FUN_BOOL3: 0x1f,
  FUN_BOOL4: 0x2f,
  START_SPEED: 0x42, // rStartSpeed / wStartSpeed
  GEAR_ED_MIN: 0x43, // rGearEDMin
  GEAR_SR_MIN: 0x44, // rGearSRMin
  GEAR_ED_MAX: 0x45, // rGearEDMax
  GEAR_SR_MAX: 0x46, // rGearSRMax, same index as setMaxSpeed (writeNR)
  GEAR_ED: 0x47, // rGearED / setGearED (write + ACK)
  GEAR_SR: 0x48, // rGearSR / setGearSR (write + ACK)
  BATTERY: 0x55, // %
  SPEED: 0x57, // km/h x10
  ERROR_CODE: 0x58,
  GEAR_MODE: 0x5a, // current riding mode (raw)
  MILEAGE: 0x62, // u32, km x100
  BODY_TEMP: 0x6b, // degC x10
  DEC_MODE: 0x70, // readDecMode / setDecMode
  S_GEAR_SPEED: 0x6e, // setSGear / rSGear
  E_GEAR_SPEED: 0x79, // setEGear / rEGear
  D_GEAR_SPEED: 0x7a, // setDGear / rDGear
});

/**
 * Gear-speed pairs. Each register packs TWO gear speeds as whole km/h, one per byte, and
 * comes with min/max registers packed the same way. Confirmed on a real ZT3 Pro by changing
 * the Sport limit in the Segway app and diffing the registers:
 *   0x48 rGearSR  [28 14] -> [28 19]  (Segway app 20 km/h -> 25 km/h, high byte follows)
 *   0x46 rGearSRMax  [28 28]          (both bytes capped at 40 km/h)
 *   0x47 rGearED  [0F 19] = 15 / 25, equal to 0x45 rGearEDMax: E and D sit at their cap.
 */
export const GEAR_PAIR = Object.freeze({
  ED: { key: 'ED', label: 'Gear E/D', reg: REG.GEAR_ED, minReg: REG.GEAR_ED_MIN, maxReg: REG.GEAR_ED_MAX },
  SR: { key: 'SR', label: 'Gear S/R', reg: REG.GEAR_SR, minReg: REG.GEAR_SR_MIN, maxReg: REG.GEAR_SR_MAX },
});

/**
 * Riding modes whose max speed can be set over BLE.
 * `byte` is the index inside the pair register. Byte 1 of 0x48 is proven (see above);
 * the E/D split is deduced from the caps (byte 0 maxes at 15, byte 1 at 25 km/h).
 * `mirrorReg` is the plain-km/h copy the Segway app also writes, when there is one.
 */
export const SPEED_MODES = Object.freeze({
  E: { key: 'E', label: 'Mode E (Eco)', pair: 'ED', byte: 0, mirrorReg: null, proven: false },
  D: { key: 'D', label: 'Mode D (Standard)', pair: 'ED', byte: 1, mirrorReg: null, proven: false },
  S: { key: 'S', label: 'Mode S (Sport)', pair: 'SR', byte: 1, mirrorReg: REG.S_GEAR_SPEED, proven: true },
});

// Legal limit for e-scooters on public roads in France / EU (and the EU firmware cap).
export const MAX_SPEED_KMH = 25;
export const MIN_SPEED_KMH = 6;
