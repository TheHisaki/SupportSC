// Web Bluetooth connection + Ninebot Encryption2 handshake for the Segway ZT3 Pro.
// Works in Bluefy (iOS) and Chrome (Android / desktop). Requires HTTPS.

import { NbCrypto, FW_DATA, bytesEqual, fromHex, randomBytes, toHex } from './crypto.js';
import { CMD, FrameAssembler, buildFrame, parseFrame, readU16, u16le } from './protocol.js';
import { BOARD } from './registers.js';

const NB_SERVICE = '6e400001-0000-0000-006e-696e65626f74';
const NB_WRITE = '6e400002-0000-0000-006e-696e65626f74';
const NB_NOTIFY = '6e400004-0000-0000-006e-696e65626f74';
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// Gen2 is the variant verified against a GT3 Pro capture (same "x3" platform as the ZT3 Pro).
const VARIANTS = {
  gen2: { id: 'gen2', sync2: 0xa5, key2: FW_DATA, ecb: FW_DATA },
  gen3: { id: 'gen3', sync2: 0xb5, key2: null, ecb: null },
};

// Ninebot/Segway company ids found in BLE advertisements (both byte orders are seen in the wild).
const NINEBOT_COMPANY_IDS = [0x4e42, 0x4e43, 0x424e, 0x434e];

const CHUNK_SIZE = 20; // safe ATT payload without MTU negotiation (Web Bluetooth can't negotiate MTU)
const PAIRING_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utf8 = (s) => new TextEncoder().encode(s);
const ascii = (bytes) => new TextDecoder('ascii').decode(bytes).replace(/\0+$/, '');

export class ScooterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  },
};

export class Scooter extends EventTarget {
  constructor({ log } = {}) {
    super();
    this.log = log ?? (() => {});
    this.device = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.crypto = null;
    this.sync2 = 0xa5;
    this.btName = '';
    this.serial = '';
    this.connected = false;
    this._rxQueue = [];
    this._rxWaiter = null;
    this._lock = Promise.resolve();
    this._expectDisconnect = false;
    this._assembler = new FrameAssembler((frame) => this._onFrame(frame));
    this._onNotify = this._onNotify.bind(this);
    this._onDisconnected = this._onDisconnected.bind(this);
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  // ---------------------------------------------------------------- connection

  _progress(text) {
    this.dispatchEvent(new CustomEvent('progress', { detail: text }));
  }

  /**
   * Opens the browser's Bluetooth picker with every nearby device.
   * Segway "x3" scooters (ZT3, GT3, G3, F3) advertise only their serial number as name
   * (e.g. "1K1UA2532P0220"), without the Ninebot service UUID, so service filters hide them.
   */
  async _pickDevice() {
    return navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [NB_SERVICE, NORDIC_SERVICE],
      optionalManufacturerData: NINEBOT_COMPANY_IDS,
    }).catch((err) => {
      // Older engines reject the unknown optionalManufacturerData option.
      if (err.name !== 'TypeError') throw err;
      return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [NB_SERVICE, NORDIC_SERVICE] });
    });
  }

  /** Name of the last scooter that authenticated successfully (shown as a hint in the UI). */
  static lastScooterName() {
    return storage.get('zt3:last-name') ?? '';
  }

  /** Opens the device picker, connects and authenticates. Must be called from a user gesture. */
  async connect({ nameOverride = '' } = {}) {
    this._progress('Recherche…');
    const device = await this._pickDevice();
    if (this.device) {
      await this._closeGatt();
      this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
    }
    this.device = device;
    device.addEventListener('gattserverdisconnected', this._onDisconnected);

    this.btName = (nameOverride || device.name || '').trim();
    if (!this.btName) {
      throw new ScooterError('NO_NAME', "Le nom Bluetooth de la trottinette est inconnu. Renseigne-le dans les options avancées (c'est le numéro de série).");
    }
    this.log('info', `Appareil choisi : ${device.name ?? '(sans nom)'} — clé utilisée : "${this.btName}"`);

    const preferred = storage.get(`zt3:variant:${this.btName}`);
    const plan = preferred === 'gen3'
      ? [VARIANTS.gen3, VARIANTS.gen3, VARIANTS.gen2]
      : [VARIANTS.gen2, VARIANTS.gen2, VARIANTS.gen3];

    let lastError = null;
    for (let attempt = 0; attempt < plan.length; attempt++) {
      const variant = plan[attempt];
      try {
        if (attempt > 0) {
          await this._closeGatt();
          await sleep(1000 * attempt);
        }
        this._progress('Connexion…');
        await this._openGatt();
        this._progress('Sécurisation…');
        await this._handshake(variant);
        storage.set(`zt3:variant:${this.btName}`, variant.id);
        storage.set('zt3:last-name', this.btName);
        this.connected = true;
        this.dispatchEvent(new Event('connected'));
        return;
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ScooterError && (err.code === 'ECHO' || err.code === 'TIMEOUT');
        this.log('warn', `Tentative ${attempt + 1}/${plan.length} (${variant.id}) : ${err.message}`);
        if (!retryable) break;
      }
    }

    await this._closeGatt();
    if (lastError instanceof ScooterError && (lastError.code === 'ECHO' || lastError.code === 'TIMEOUT')) {
      throw new ScooterError(lastError.code,
        "La trottinette n'a pas accepté la connexion. Vérifie que l'appli Segway est complètement fermée, " +
        "que la trottinette est allumée, et que le nom Bluetooth correspond au numéro de série.");
    }
    throw lastError;
  }

  async disconnect() {
    await this._closeGatt();
    this.connected = false;
    this.dispatchEvent(new Event('disconnected'));
  }

  async _openGatt() {
    this._expectDisconnect = false;
    const server = await this.device.gatt.connect();

    let service;
    let writeUuid = NB_WRITE;
    let notifyUuid = NB_NOTIFY;
    try {
      service = await server.getPrimaryService(NB_SERVICE);
    } catch {
      service = await server.getPrimaryService(NORDIC_SERVICE);
      writeUuid = NORDIC_WRITE;
      notifyUuid = NORDIC_NOTIFY;
      this.log('warn', 'Service Ninebot introuvable, utilisation du service Nordic UART.');
    }

    this.writeChar = await service.getCharacteristic(writeUuid);
    if (this.notifyChar) this.notifyChar.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.notifyChar = await service.getCharacteristic(notifyUuid);
    this.notifyChar.addEventListener('characteristicvaluechanged', this._onNotify);
    await this.notifyChar.startNotifications();

    // iOS keeps CCCD state between connections: toggle it, then drain stale notifications.
    try {
      await this.notifyChar.stopNotifications();
      await sleep(300);
      await this.notifyChar.startNotifications();
    } catch (err) {
      this.log('debug', `Toggle notifications ignoré : ${err.message}`);
    }
    await sleep(200);
    this._assembler.reset();
    this._rxQueue = [];
    this.log('debug', 'GATT connecté, notifications actives.');
  }

  async _closeGatt() {
    this._expectDisconnect = true;
    try {
      if (this.notifyChar) await this.notifyChar.stopNotifications();
    } catch { /* already disconnected */ }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.connected = false;
  }

  _onDisconnected() {
    const wasConnected = this.connected;
    this.connected = false;
    if (this._rxWaiter) this._rxWaiter.reject(new ScooterError('DISCONNECTED', 'Connexion Bluetooth perdue.'));
    if (!this._expectDisconnect && wasConnected) {
      this.log('warn', 'La trottinette s\'est déconnectée.');
      this.dispatchEvent(new Event('disconnected'));
    }
  }

  // ---------------------------------------------------------------- transport

  _onNotify(event) {
    const v = event.target.value;
    this._assembler.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice());
  }

  _onFrame(frame) {
    this.log('debug', `RX ${toHex(frame)}`);
    if (this._rxWaiter) {
      const { resolve } = this._rxWaiter;
      this._rxWaiter = null;
      resolve(frame);
    } else {
      this._rxQueue.push(frame);
    }
  }

  _nextFrame(timeoutMs) {
    if (this._rxQueue.length) return Promise.resolve(this._rxQueue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._rxWaiter = null;
        reject(new ScooterError('TIMEOUT', 'Pas de réponse de la trottinette.'));
      }, timeoutMs);
      this._rxWaiter = {
        resolve: (f) => { clearTimeout(timer); resolve(f); },
        reject: (e) => { clearTimeout(timer); this._rxWaiter = null; reject(e); },
      };
    });
  }

  async _write(bytes) {
    this.log('debug', `TX ${toHex(bytes)}`);
    const ch = this.writeChar;
    for (let off = 0; off < bytes.length; off += CHUNK_SIZE) {
      const chunk = bytes.slice(off, off + CHUNK_SIZE);
      if (ch.properties?.writeWithoutResponse && ch.writeValueWithoutResponse) {
        await ch.writeValueWithoutResponse(chunk);
      } else if (ch.writeValueWithResponse) {
        await ch.writeValueWithResponse(chunk);
      } else {
        await ch.writeValue(chunk);
      }
      if (off + CHUNK_SIZE < bytes.length) await sleep(10);
    }
  }

  /** Waits for a decrypted response matching `match`, ignoring unrelated frames. */
  async _awaitResponse(match, timeoutMs, sentBytes = null) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ScooterError('TIMEOUT', 'Pas de réponse de la trottinette.');
      const raw = await this._nextFrame(remaining);
      if (sentBytes && bytesEqual(raw, sentBytes)) {
        throw new ScooterError('ECHO', 'La trottinette renvoie la requête telle quelle (écho).');
      }
      const { plain, ok } = await this.crypto.decrypt(raw);
      const frame = parseFrame(plain);
      if (!ok) this.log('debug', `Contrôle d'intégrité invalide sur ${toHex(plain)}`);
      if (frame && match(frame)) {
        if (!ok) this.log('warn', 'Réponse acceptée malgré un contrôle d\'intégrité invalide.');
        return frame;
      }
      this.log('debug', `Trame ignorée : ${toHex(plain)}`);
    }
  }

  async _transact(plainFrame, match, timeoutMs) {
    this._rxQueue = [];
    const encrypted = await this.crypto.encrypt(plainFrame);
    await this._write(encrypted);
    return this._awaitResponse(match, timeoutMs, encrypted);
  }

  _exclusive(fn) {
    const run = this._lock.then(fn);
    this._lock = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- handshake

  async _handshake(variant) {
    const crypto = new NbCrypto(variant.ecb);
    this.crypto = crypto;
    this.sync2 = variant.sync2;
    const name = utf8(this.btName);

    // Phase 1: PRE_COMM (non-SN mode)
    this.log('info', `Handshake ${variant.id} : PRE_COMM…`);
    crypto.resetSn();
    crypto.setKey(name, variant.key2);
    const pre = await this._transact(
      buildFrame(this.sync2, BOARD.BLE, CMD.PRE_COMM, 0x00),
      (f) => f.cmd === CMD.PRE_COMM,
      5000,
    );
    if (pre.data.length < 30) throw new ScooterError('PROTOCOL', `Réponse PRE_COMM trop courte (${pre.data.length} octets).`);

    const auth = pre.data.slice(0, 16);
    const sn = pre.data.slice(16, 30);
    this.serial = ascii(sn);
    this.log('info', `Numéro de série : ${this.serial}`);
    crypto.setAuthParam(auth);
    crypto.startSn();

    // Phase 3 directly if we already paired with this scooter
    const pwdKey = `zt3:pwd:${this.serial}`;
    const stored = storage.get(pwdKey);
    if (stored) {
      this.log('info', 'Mot de passe de session connu, authentification…');
      if (await this._auth(fromHex(stored), auth, sn)) return;
      this.log('warn', 'Mot de passe enregistré refusé, nouvel appairage.');
      storage.remove(pwdKey);
    }

    // Phase 2: SET_PWD (may need a button press on the scooter)
    const password = await this._setPassword(name, auth);

    // Phase 3: AUTH
    if (!(await this._auth(password, auth, sn))) {
      throw new ScooterError('AUTH', 'Authentification refusée par la trottinette.');
    }
    storage.set(pwdKey, toHex(password, ''));
  }

  async _setPassword(name, auth) {
    this.log('info', 'SET_PWD : envoi d\'un nouveau mot de passe de session…');
    this.crypto.setKey(name, auth);
    const password = randomBytes(16);
    const frame = buildFrame(this.sync2, BOARD.BLE, CMD.SET_PWD, 0x00, password);
    const isSetPwd = (f) => f.cmd === CMD.SET_PWD;

    let resp = await this._transact(frame, isSetPwd, 5000);
    if (resp.index === 1) return password;

    this.log('info', 'La trottinette attend une confirmation physique.');
    this._progress('Appuie sur Power…');
    this.dispatchEvent(new Event('pairing-request'));
    try {
      const deadline = Date.now() + PAIRING_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          resp = await this._awaitResponse(isSetPwd, 2000);
        } catch (err) {
          if (err.code !== 'TIMEOUT') throw err;
          resp = await this._transact(frame, isSetPwd, 2000).catch((e) => {
            if (e.code === 'TIMEOUT') return null;
            throw e;
          });
        }
        if (resp?.index === 1) return password;
      }
    } finally {
      this.dispatchEvent(new Event('pairing-done'));
    }
    throw new ScooterError('PAIRING', 'Appairage non confirmé à temps sur la trottinette.');
  }

  async _auth(password, auth, sn) {
    this.crypto.setKey(password, auth);
    const resp = await this._transact(
      buildFrame(this.sync2, BOARD.BLE, CMD.AUTH, 0x00, sn),
      (f) => f.cmd === CMD.AUTH,
      5000,
    );
    if (resp.index === 1) this.log('info', 'Authentifié.');
    return resp.index === 1;
  }

  // ---------------------------------------------------------------- registers

  _ensureConnected() {
    if (!this.connected) throw new ScooterError('NOT_CONNECTED', 'Trottinette non connectée.');
  }

  /** Reads `len` bytes from a register. Retries once on timeout. */
  readRegister(board, reg, len = 2) {
    return this._exclusive(async () => {
      this._ensureConnected();
      const frame = buildFrame(this.sync2, board, CMD.READ, reg, Uint8Array.of(len));
      const match = (f) => f.cmd === CMD.READ_ACK && f.index === reg;
      for (let attempt = 0; ; attempt++) {
        try {
          return (await this._transact(frame, match, 2500)).data;
        } catch (err) {
          if (err.code !== 'TIMEOUT' || attempt >= 1) throw err;
        }
      }
    });
  }

  async readU16(board, reg) {
    const data = await this.readRegister(board, reg, 2);
    const value = readU16(data);
    if (value === null) throw new ScooterError('PROTOCOL', `Réponse vide pour le registre 0x${reg.toString(16)}.`);
    return value;
  }

  /** Writes a u16 value (cmd WRITE, waits for the ACK). Returns true if the scooter acknowledged. */
  writeU16(board, reg, value) {
    return this._exclusive(async () => {
      this._ensureConnected();
      const frame = buildFrame(this.sync2, board, CMD.WRITE, reg, u16le(value));
      try {
        await this._transact(frame, (f) => f.cmd === CMD.WRITE_ACK && f.index === reg, 2500);
        return true;
      } catch (err) {
        if (err.code === 'TIMEOUT') {
          this.log('warn', `Pas d'accusé de réception pour l'écriture 0x${reg.toString(16)}.`);
          return false;
        }
        throw err;
      }
    });
  }
}
