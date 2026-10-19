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
 * Writable gear-speed "families". The ZT3 firmware exposes one speed register per gear
 * pair (E/D and S/R) together with the min/max it accepts, so a write can be clamped to
 * what the vehicle itself allows instead of being guessed.
 */
export const GEAR_FAMILY = Object.freeze({
  ED: { key: 'ED', label: 'Gear E/D', reg: REG.GEAR_ED, minReg: REG.GEAR_ED_MIN, maxReg: REG.GEAR_ED_MAX },
  SR: { key: 'SR', label: 'Gear S/R', reg: REG.GEAR_SR, minReg: REG.GEAR_SR_MIN, maxReg: REG.GEAR_SR_MAX },
});

// Riding modes whose max speed can be set over BLE.
export const SPEED_MODES = Object.freeze({
  E: { key: 'E', label: 'Mode E (Eco)', reg: REG.E_GEAR_SPEED, family: 'ED' },
  D: { key: 'D', label: 'Mode D (Standard)', reg: REG.D_GEAR_SPEED, family: 'ED' },
  S: { key: 'S', label: 'Mode S (Sport)', reg: REG.S_GEAR_SPEED, family: 'SR' },
});

// Legal limit for e-scooters on public roads in France / EU (and the EU firmware cap).
export const MAX_SPEED_KMH = 25;
export const MIN_SPEED_KMH = 6;
