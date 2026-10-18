// Segway ZT3 Pro register map (hardware id 256).
// Sources:
//  - https://nootnooot.codeberg.page/segway-ninebot-ble/ (device config "Segway ZT3 Pro")
//  - https://gist.github.com/djensenius/48d6aef55a4ad403775cc5ff5fe92f53 (GT3 Pro, same "x3" platform)

export const BOARD = Object.freeze({
  MCU: 0x02,
  BLE: 0x04, // handshake target
  BMS2: 0x06,
  BMS1: 0x07,
  VCU: 0x16, // vehicle control unit: settings + telemetry
  TFT: 0x23,
});

export const REG = Object.freeze({
  SN: 0x10, // 14 bytes ASCII
  CTRL_VERSION: 0x17,
  BATTERY: 0x55, // %
  SPEED: 0x57, // km/h x10
  ERROR_CODE: 0x58,
  GEAR_MODE: 0x5a, // current riding mode (raw)
  MILEAGE: 0x62, // u32, km x100
  BODY_TEMP: 0x6b, // degC x10
  S_GEAR_SPEED: 0x6e, // setSGear / rSGear
  E_GEAR_SPEED: 0x79, // setEGear / rEGear
  D_GEAR_SPEED: 0x7a, // setDGear / rDGear
});

// Riding modes whose max speed can be set over BLE.
export const SPEED_MODES = Object.freeze({
  E: { key: 'E', label: 'Mode E (Eco)', reg: REG.E_GEAR_SPEED },
  D: { key: 'D', label: 'Mode D (Standard)', reg: REG.D_GEAR_SPEED },
  S: { key: 'S', label: 'Mode S (Sport)', reg: REG.S_GEAR_SPEED },
});

// Legal limit for e-scooters on public roads in France / EU (and the EU firmware cap).
export const MAX_SPEED_KMH = 25;
export const MIN_SPEED_KMH = 6;
