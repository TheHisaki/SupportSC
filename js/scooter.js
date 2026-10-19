// Web Bluetooth connection + Ninebot Encryption2 handshake for the Segway ZT3 Pro.
// Works in Bluefy (iOS) and Chrome (Android / desktop). Requires HTTPS.

import { NbCrypto, FW_DATA, bytesEqual, fromHex, randomBytes, toHex } from './crypto.js';
import { CMD, FrameAssembler, buildFrame, parseFrame, readU16, u16le } from './protocol.js';

const NB_SERVICE = '6e400001-0000-0000-006e-696e65626f74';
const NB_WRITE = '6e400002-0000-0000-006e-696e65626f74';
const NB_NOTIFY = '6e400004-0000-0000-006e-696e65626f74';
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

// Pairing flow ported from the official Segway app logic for "x3" scooters (G3, GT3, ZT3), see
// https://github.com/HeckerHeckt/Ninebot-Max-G3-Firmware-Flasher (ninebot_ble.py):
//  - frames go over the Nordic UART characteristics,
//  - pairing target is the BLE board 0x04 for names starting with "1CG", else 0x21,
//  - the message counter follows the scooter, SET_PWD / AUTH are resent every 0.5 s.
const SYNC2 = 0xa5;
const BLE_BOARD_NEW = 0x04;
const BLE_BOARD_LEGACY = 0x21;
const RESEND_MS = 500;

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
    this.channels = [];
    this.notifyChars = [];
    this.peer = BLE_BOARD_LEGACY;
    this._assemblers = null;
    this._gattLost = false;
    this._t0 = 0;
    this._step = 'inactif';
    this._lastRx = null;
    this.crypto = null;
    this.sync2 = SYNC2;
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

    this.log('info', `Navigateur : ${navigator.userAgent}`);

    // Official app: pairing targets BLE board 0x04 for "1CG…" names, else 0x21. Try the other as fallback.
    const is1CG = this.btName.toUpperCase().startsWith('1CG');
    const boards = is1CG ? [BLE_BOARD_NEW, BLE_BOARD_LEGACY] : [BLE_BOARD_LEGACY, BLE_BOARD_NEW];

    // Find the board that answers PRE_COMM.
    let board = null;
    let lastError = new ScooterError('TIMEOUT', 'Aucune carte ne répond.');
    for (const candidate of boards) {
      try {
        await this._openGatt({ toggleCccd: false });
        const pre = await this._freshHandshakeStart(candidate);
        board = candidate;
        // If this site already paired here, authenticate straight away (no button).
        if (await this._tryStoredAuth(pre)) {
          this._finishConnected();
          return;
        }
        break;
      } catch (rawErr) {
        lastError = this._normalizeError(rawErr);
        this.log('warn', `Carte 0x${candidate.toString(16)} : ${lastError.message}`);
        await this._closeGatt();
        await sleep(600);
      }
    }
    if (board === null) {
      await this._closeGatt();
      throw new ScooterError('TIMEOUT',
        "La trottinette ne répond pas à la demande d'appairage. Ferme complètement ScooterHacking Utility et l'appli " +
        "Segway, éteins puis rallume la trottinette, puis réessaie.");
    }

    // New pairing: loop the full PRE_COMM→SET_PWD→AUTH on the working board while the user
    // keeps tapping Power. Reconnecting each cycle keeps the crypto counter clean. The scooter
    // only commits the new key when Power is pressed, so we retry until AUTH is accepted.
    this._progress('Appuie sur Power…');
    this.dispatchEvent(new Event('pairing-request'));
    const deadline = Date.now() + PAIRING_TIMEOUT_MS;
    let cycle = 0;
    try {
      while (Date.now() < deadline) {
        cycle++;
        try {
          if (cycle > 1) {
            await this._closeGatt();
            await sleep(400);
            await this._openGatt({ toggleCccd: false });
            await this._freshHandshakeStart(board);
          }
          this.log('info', `[${this._elapsed()}] appairage, cycle ${cycle} — appuie sur Power`);
          if (await this._tryPair()) {
            this._finishConnected();
            return;
          }
        } catch (rawErr) {
          lastError = this._normalizeError(rawErr);
          this.log('warn', `Cycle ${cycle} (étape « ${this._step} ») : ${lastError.message}`);
          if (lastError instanceof ScooterError && !['ECHO', 'TIMEOUT', 'DISCONNECTED'].includes(lastError.code)) break;
        }
      }
    } finally {
      this.dispatchEvent(new Event('pairing-done'));
    }

    await this._closeGatt();
    throw new ScooterError('AUTH',
      "Appairage non confirmé. Au moment où l'écran « Appuie sur Power » est affiché, fais des appuis courts répétés " +
      "sur le bouton Power de la trottinette. Si rien ne se passe, la trottinette est peut-être verrouillée par une " +
      "autre appli : connecte-toi une fois avec ScooterHacking puis ferme-le complètement, et réessaie ici.");
  }

  _finishConnected() {
    storage.set('zt3:last-name', this.btName);
    this.connected = true;
    this._step = 'connecté';
    this.dispatchEvent(new Event('connected'));
  }

  /** PRE_COMM on `board`; stores auth/serial and returns the response frame. */
  async _freshHandshakeStart(board) {
    this.crypto = new NbCrypto(FW_DATA, { followPeer: true });
    this.sync2 = SYNC2;
    this.pairBoard = board;
    const pre = await this._preComm(board);
    this.peer = pre.source;
    this._auth = pre.data.slice(0, 16);
    this._sn = pre.data.slice(16, 30);
    this.serial = ascii(this._sn);
    this.crypto.setAuthParam(this._auth);
    this._mark(`PRE_COMM OK — carte 0x${this.peer.toString(16)}, n° ${this.serial}${pre.index ? ' (déjà appairée ailleurs)' : ''}`);
    return pre;
  }

  /** Fast path: authenticate with the password this site stored for this scooter. */
  async _tryStoredAuth() {
    const stored = storage.get(`zt3:pwd:${this.serial}`);
    if (!stored) return false;
    this.crypto.setKey(fromHex(stored), this._auth);
    this._mark('AUTH avec l\'appairage enregistré');
    try {
      await this._repeatUntil(buildFrame(SYNC2, this.peer, CMD.AUTH, 0x00, this._sn),
        (f) => f.cmd === CMD.AUTH && f.index === 1, { timeoutMs: 3500 });
      this._mark('authentifié');
      return true;
    } catch (err) {
      if (err.code !== 'TIMEOUT') throw err;
      storage.remove(`zt3:pwd:${this.serial}`);
      this.log('warn', 'Appairage enregistré refusé, nouvel appairage.');
      return false;
    }
  }

  /** One pairing cycle: SET_PWD then AUTH with short waits. Returns true on success. */
  async _tryPair() {
    const name = utf8(this.btName);
    const password = randomBytes(16);

    this.crypto.setKey(name, this._auth);
    this._mark('SET_PWD');
    let setOk = false;
    try {
      await this._repeatUntil(buildFrame(SYNC2, this.peer, CMD.SET_PWD, 0x00, password),
        (f) => f.cmd === CMD.SET_PWD && f.index === 1, { timeoutMs: 3500 });
      setOk = true;
    } catch (err) {
      if (err.code !== 'TIMEOUT') throw err;
    }
    if (!setOk) return false;

    this.crypto.setKey(password, this._auth);
    this._mark('AUTH');
    try {
      await this._repeatUntil(buildFrame(SYNC2, this.peer, CMD.AUTH, 0x00, this._sn),
        (f) => f.cmd === CMD.AUTH && f.index === 1, { timeoutMs: 3500 });
    } catch (err) {
      if (err.code !== 'TIMEOUT') throw err;
      return false;
    }
    storage.set(`zt3:pwd:${this.serial}`, toHex(password, ''));
    this._mark('authentifié');
    return true;
  }

  /** Maps browser Bluetooth errors (e.g. "GATT Server is disconnected") to ScooterError codes. */
  _normalizeError(err) {
    if (err instanceof ScooterError) return err;
    const msg = String(err?.message ?? err);
    if (this._gattLost || err?.name === 'NetworkError' || /disconnect|not connected|déconnect/i.test(msg)) {
      return new ScooterError('DISCONNECTED', `Connexion coupée par la trottinette (${msg}).`);
    }
    return err;
  }

  async disconnect() {
    await this._closeGatt();
    this.connected = false;
    this.dispatchEvent(new Event('disconnected'));
  }

  _elapsed() {
    return `${((performance.now() - this._t0) / 1000).toFixed(2)} s`;
  }

  _mark(step) {
    this._step = step;
    this.log('info', `[${this._elapsed()}] ${step}`);
  }

  async _openGatt({ toggleCccd = false } = {}) {
    this._expectDisconnect = false;
    this._gattLost = false;
    this._t0 = performance.now();
    this._rxQueue = [];
    this._lastRx = null;
    this._mark('connexion GATT');
    const server = await this.device.gatt.connect();
    this._mark('GATT connecté, recherche du service');

    // The official app talks to x3 scooters over Nordic UART; the Ninebot service is a backup channel.
    const channels = [];
    for (const [label, svcUuid, writeUuid, notifyUuid] of [
      ['Nordic', NORDIC_SERVICE, NORDIC_WRITE, NORDIC_NOTIFY],
      ['Ninebot', NB_SERVICE, NB_WRITE, NB_NOTIFY],
    ]) {
      try {
        const svc = await server.getPrimaryService(svcUuid);
        channels.push({
          label,
          write: await svc.getCharacteristic(writeUuid),
          notify: await svc.getCharacteristic(notifyUuid),
        });
      } catch (err) {
        if (this._gattLost) throw err;
        this.log('debug', `Service ${label} absent (${err.message}).`);
      }
    }
    if (!channels.length) throw new ScooterError('PROTOCOL', 'Aucun service Bluetooth Segway trouvé sur cet appareil.');
    this.channels = channels;
    this.writeChar = channels[0].write;
    const notifyChars = channels.map((c) => c.notify);
    this._mark(`canaux trouvés : ${channels.map((c) => c.label).join(' + ')}`);

    for (const ch of this.notifyChars ?? []) ch.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.notifyChars = notifyChars;
    this._assemblers = new Map(notifyChars.map((ch) => [ch, new FrameAssembler((f) => this._onFrame(f))]));
    for (const ch of notifyChars) {
      ch.addEventListener('characteristicvaluechanged', this._onNotify);
      // Bluefy has been reported to deliver notifications only through the on* handler.
      try { ch.oncharacteristicvaluechanged = this._onNotify; } catch { /* read-only in some engines */ }
      await ch.startNotifications();
      if (toggleCccd) {
        // iOS keeps CCCD state between connections: toggle it to get a clean subscription.
        try {
          await ch.stopNotifications();
          await sleep(150);
          await ch.startNotifications();
        } catch (err) {
          if (this._gattLost) throw err;
          this.log('debug', `Toggle notifications ignoré : ${err.message}`);
        }
      }
    }
    await sleep(toggleCccd ? 200 : 50); // drain stale notifications from a previous session
    this._rxQueue = [];
    this._mark('notifications actives');
  }

  async _closeGatt() {
    this._expectDisconnect = true;
    for (const ch of this.notifyChars ?? []) {
      try { await ch.stopNotifications(); } catch { /* already disconnected */ }
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.connected = false;
  }

  _onDisconnected() {
    const wasConnected = this.connected;
    this.connected = false;
    this._gattLost = true;
    if (!this._expectDisconnect && this._t0) {
      this.log('warn', `[${this._elapsed()}] La trottinette a coupé la connexion (étape « ${this._step} »).`);
    }
    if (this._rxWaiter) this._rxWaiter.reject(new ScooterError('DISCONNECTED', 'Connexion Bluetooth perdue.'));
    if (!this._expectDisconnect && wasConnected) {
      this.dispatchEvent(new Event('disconnected'));
    }
  }

  // ---------------------------------------------------------------- transport

  _onNotify(event) {
    const ch = event.target;
    const v = ch.value;
    if (!v) return;
    const chunk = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
    // Some browsers fire both the listener and the on* handler: ignore the duplicate delivery.
    const now = performance.now();
    const last = this._lastChunk?.get(ch);
    if (last && now - last.at < 15 && bytesEqual(last.bytes, chunk)) return;
    (this._lastChunk ??= new Map()).set(ch, { bytes: chunk, at: now });
    this.log('debug', `notif ${ch.uuid?.slice(4, 8) ?? '?'} ${toHex(chunk)}`);
    (this._assemblers?.get(ch) ?? this._assembler).push(chunk);
  }

  _onFrame(frame) {
    // The same frame may arrive on both notify channels: keep only one copy.
    const now = performance.now();
    if (this._lastRx && now - this._lastRx.at < 500 && bytesEqual(this._lastRx.frame, frame)) return;
    this._lastRx = { frame, at: now };
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
    if (this._gattLost) return Promise.reject(new ScooterError('DISCONNECTED', 'Connexion Bluetooth perdue.'));
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
    if (this._gattLost) throw new ScooterError('DISCONNECTED', 'Connexion Bluetooth perdue.');
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

  /**
   * Sends `plainFrame` (re-encrypted each time) every `intervalMs` until a response matches,
   * like the official app does for SET_PWD / AUTH. `burst` copies are sent on the first round.
   */
  async _repeatUntil(plainFrame, match, { timeoutMs, intervalMs = RESEND_MS, burst = 1 }) {
    this._rxQueue = [];
    const deadline = Date.now() + timeoutMs;
    let nextSend = 0;
    for (;;) {
      if (Date.now() >= deadline) throw new ScooterError('TIMEOUT', 'Pas de réponse de la trottinette.');
      if (Date.now() >= nextSend) {
        for (let i = 0; i < burst; i++) await this._write(await this.crypto.encrypt(plainFrame));
        burst = 1;
        nextSend = Date.now() + intervalMs;
      }
      let raw;
      try {
        raw = await this._nextFrame(Math.max(5, Math.min(nextSend, deadline) - Date.now()));
      } catch (err) {
        if (err.code === 'TIMEOUT') continue;
        throw err;
      }
      const { plain, ok } = await this.crypto.decrypt(raw);
      const frame = parseFrame(plain);
      if (frame && match(frame)) {
        if (!ok) this.log('debug', 'Réponse acceptée malgré un contrôle d\'intégrité invalide.');
        return frame;
      }
      this.log('debug', `Trame ignorée : ${toHex(plain)}`);
    }
  }

  /** PRE_COMM on a fixed board, trying each notify channel until the scooter answers. */
  async _preComm(board) {
    for (const channel of this.channels) {
      this.writeChar = channel.write;
      this.crypto.resetSn();
      this.crypto.setKey(utf8(this.btName), FW_DATA);
      this._mark(`PRE_COMM → carte 0x${board.toString(16)} via ${channel.label}`);
      try {
        return await this._transact(
          buildFrame(SYNC2, board, CMD.PRE_COMM, 0x00),
          (f) => f.cmd === CMD.PRE_COMM && f.data.length >= 30,
          2500,
        );
      } catch (err) {
        if (err.code !== 'TIMEOUT' && err.code !== 'ECHO') throw err;
        this.log('info', `[${this._elapsed()}] pas de réponse (${err.code === 'ECHO' ? 'écho' : 'silence'})`);
      }
    }
    throw new ScooterError('TIMEOUT', `Carte 0x${board.toString(16)} ne répond pas à PRE_COMM.`);
  }

  // ---------------------------------------------------------------- registers

  _ensureConnected() {
    if (!this.connected) throw new ScooterError('NOT_CONNECTED', 'Trottinette non connectée.');
  }

  /** Reads `len` bytes from a register. Retries once on timeout. */
  readRegister(board, reg, len = 2) {
    return this._exclusive(async () => {
      this._ensureConnected();
      // The official app sends the length as a little-endian u16 (e.g. 02 00).
      const frame = buildFrame(this.sync2, board, CMD.READ, reg, u16le(len));
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
