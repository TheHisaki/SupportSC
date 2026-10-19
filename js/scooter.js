// Web Bluetooth connection + Ninebot Encryption2 handshake for the Segway ZT3 Pro.
// Works in Bluefy (iOS) and Chrome (Android / desktop). Requires HTTPS.

import { NbCrypto, FW_DATA, bytesEqual, fromHex, generatePairingPassword, toHex } from './crypto.js';
import { CMD, FrameAssembler, buildFrame, parseFrame, readU16, u16le } from './protocol.js';

const NB_SERVICE = '6e400001-0000-0000-006e-696e65626f74';
const NB_WRITE = '6e400002-0000-0000-006e-696e65626f74';
const NB_NOTIFY = '6e400004-0000-0000-006e-696e65626f74';
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NORDIC_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const NB_AUTH_WRITE = '6e400005-0000-0000-006e-696e65626f74';
const NB_AUTH_NOTIFY = '6e400006-0000-0000-006e-696e65626f74';

// Pairing flow of the iOS GT3 Pro companion app, verified on a real x3 scooter with packet captures
// (https://github.com/djensenius/gt3pro, ScooterConnectionManager.swift / NinebotAuth.swift),
// cross-checked with https://nootnooot.codeberg.page/segway-ninebot-ble/authentication/ :
//  1. toggle the CCCD of 006E-0004 (off, 300 ms, on, 200 ms drain),
//  2. plain PRE_COMM "wakeup" (target 0x21, with checksum) written to 006E-0005,
//  3. encrypted PRE_COMM (target 0x04) written to B5A3-0002, answer on B5A3-0003,
//  4. SN mode ON (counter = 1), SET_PWD encrypted with key (name, auth). The scooter answers
//     index 0 while it waits for the Power button, index 1 once pressed. Resent every 2 s.
//  5. AUTH (serial number) with key (password, auth) -> index 1 = authenticated.
// Logs from a real ZT3 showed that SET_PWD sent in non-SN mode (counter 0, previous versions)
// is answered "1" without any button press, then the scooter drops the link on AUTH.
// That older encoding is kept as a fallback ("legacy") in case the SN one gets no answer.
const SYNC2 = 0xa5;
const BOARD_AUTH = 0x04; // x3 auth target: the only board that answered PRE_COMM on a real ZT3
const BOARD_BLE = 0x21;
const SET_PWD_RESEND_MS = { sn: 2000, legacy: 500 };
const SET_PWD_SILENT_MS = 6500; // no SET_PWD answer at all after ~3 sends -> wrong encoding
const AUTH_RESEND_MS = 2000;
const AUTH_TRIES = 3;
const MAX_RECONNECTS = 3; // only when the scooter drops the link or stays silent (1 s, 2 s, 3 s backoff)
const otherVariant = (v) => (v === 'sn' ? 'legacy' : 'sn');

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
    this.peer = BOARD_AUTH;
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

    // SET_PWD encoding: "sn" (official app / docs) unless "legacy" already worked on this scooter.
    const variantKey = `zt3:variant:${this.btName}`;
    let variant = storage.get(variantKey) === 'legacy' ? 'legacy' : 'sn';
    this._workingBoard = null;

    const ctx = {
      deadline: null, // starts at the first SET_PWD, so connection retries don't eat the 60 s
      prompted: false,
      prompt: () => {
        if (ctx.prompted) return;
        ctx.prompted = true;
        this._progress('Appuie sur Power…');
        this.dispatchEvent(new Event('pairing-request'));
      },
    };
    let reconnects = 0;

    try {
      for (;;) {
        try {
          const pre = await this._openAndPreComm();
          await this._authenticate(pre, variant, ctx);
          storage.set(variantKey, variant);
          this._finishConnected();
          return;
        } catch (rawErr) {
          const err = this._normalizeError(rawErr);
          if (err.code === 'TIMEOUT' && this._step.startsWith('SET_PWD')) throw this._notConfirmedError();
          const retryable = ['DISCONNECTED', 'ECHO', 'SILENT', 'AUTH_REFUSED'].includes(err.code);
          if (!retryable || reconnects >= MAX_RECONNECTS || (ctx.deadline && Date.now() >= ctx.deadline)) {
            throw err.code === 'AUTH_REFUSED'
              ? new ScooterError('AUTH', "La trottinette refuse l'authentification. Éteins-la, rallume-la et réessaie.")
              : err;
          }
          reconnects++;
          // The scooter said "waiting for Power" with this encoding: it is the right one, keep it.
          // Otherwise (silence, immediate "OK" then drop on AUTH) try the other encoding.
          if (!this._sawWaiting && err.code !== 'ECHO') {
            variant = otherVariant(variant);
            this.log('info', `Essai suivant avec l'encodage SET_PWD « ${variant} ».`);
          }
          this.log('warn', `${err.message} Reconnexion ${reconnects}/${MAX_RECONNECTS} dans ${reconnects} s…`);
          await this._closeGatt();
          await sleep(1000 * reconnects);
        }
      }
    } catch (err) {
      await this._closeGatt();
      throw err;
    } finally {
      if (ctx.prompted) this.dispatchEvent(new Event('pairing-done'));
    }
  }

  _notConfirmedError() {
    return new ScooterError('AUTH',
      "Appairage non confirmé en 60 s. Quand l'écran « Confirme sur la trottinette » s'affiche, fais un appui court " +
      "sur le bouton Power (refais-le après quelques secondes si rien ne se passe). Vérifie aussi que l'appli Segway " +
      "et ScooterHacking sont complètement fermées : une seule appli peut être connectée à la fois.");
  }

  /** Opens GATT and runs PRE_COMM (board 0x04 first, 0x21 as fallback). Leaves the connection open. */
  async _openAndPreComm() {
    const boards = this._workingBoard ? [this._workingBoard] : [BOARD_AUTH, BOARD_BLE];
    let lastErr = null;
    for (const board of boards) {
      try {
        await this._openGatt({ toggleCccd: true });
        const pre = await this._freshHandshakeStart(board);
        this._workingBoard = board;
        return pre;
      } catch (rawErr) {
        lastErr = this._normalizeError(rawErr);
        this.log('warn', `Carte 0x${board.toString(16)} : ${lastErr.message}`);
        await this._closeGatt();
        await sleep(1000);
      }
    }
    if (lastErr?.code === 'DISCONNECTED' || lastErr?.code === 'ECHO') throw lastErr;
    throw new ScooterError('NO_PRECOMM',
      "La trottinette ne répond pas à la demande d'appairage. Ferme complètement ScooterHacking Utility et l'appli " +
      "Segway, éteins puis rallume la trottinette, puis réessaie.");
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
    await this._sendWakeup();
    const pre = await this._preComm(board);
    this.peer = pre.source;
    this._auth = pre.data.slice(0, 16);
    this._sn = pre.data.slice(16, 30);
    this.serial = ascii(this._sn);
    this.crypto.setAuthParam(this._auth);
    this._mark(`PRE_COMM OK — carte 0x${this.peer.toString(16)}, n° ${this.serial}${pre.index ? ' (déjà appairée ailleurs)' : ''}`);
    return pre;
  }

  /** Plain PRE_COMM to the BLE board on 006E-0005, sent by the official app before the real one. */
  async _sendWakeup() {
    if (!this.authWriteChar) return;
    const frame = buildFrame(SYNC2, BOARD_BLE, CMD.PRE_COMM, 0x00);
    let sum = 0;
    for (const b of frame.subarray(2)) sum += b;
    const chk = ~sum & 0xffff;
    const out = Uint8Array.of(...frame, chk & 0xff, chk >> 8);
    this.log('debug', `TX (réveil, 0005) ${toHex(out)}`);
    try {
      if (this.authWriteChar.writeValueWithResponse) await this.authWriteChar.writeValueWithResponse(out);
      else await this.authWriteChar.writeValue(out);
    } catch (err) {
      if (this._gattLost) throw err;
      this.log('debug', `Réveil 0005 ignoré : ${err.message}`);
    }
  }

  /**
   * Handshake after PRE_COMM, on the current connection:
   * stored password -> AUTH directly; otherwise SET_PWD (waits for Power) then AUTH.
   * `variant` = "sn" (SET_PWD in SN mode, counter 2) or "legacy" (SET_PWD in non-SN mode).
   * Throws DISCONNECTED / SILENT / AUTH_REFUSED (retryable) or TIMEOUT at step SET_PWD.
   */
  async _authenticate(pre, variant, ctx) {
    this._sawWaiting = false;
    if (variant === 'sn') this.crypto.startSn();

    const stored = storage.get(`zt3:pwd:${this.serial}`);
    if (stored && pre.index !== 0) {
      this.crypto.setKey(fromHex(stored), this._auth);
      if (await this._sendAuth('AUTH avec le mot de passe enregistré (sans bouton)')) return;
      storage.remove(`zt3:pwd:${this.serial}`);
      this.log('warn', 'Mot de passe enregistré refusé, nouvel appairage.');
    }

    // X3/ZT3 firmware derives the password from auth + current time using
    // the Java-compatible generator used by the public reference clients.
    const password = await generatePairingPassword(this._auth);
    this.crypto.setKey(utf8(this.btName), this._auth);
    ctx.deadline ??= Date.now() + PAIRING_TIMEOUT_MS;
    ctx.prompt();
    this._mark(`SET_PWD (encodage ${variant}) — appuie sur Power`);
    const frame = buildFrame(SYNC2, BOARD_AUTH, CMD.SET_PWD, 0x00, password);
    let answered = false;
    const match = (f) => {
      if (f.cmd !== CMD.SET_PWD && f.cmd !== CMD.READ_ACK) return false;
      answered = true;
      if (f.index === 1) return true;
      if (!this._sawWaiting) {
        this._sawWaiting = true;
        this.log('info', `[${this._elapsed()}] la trottinette attend l'appui sur Power (réponse 0)`);
      }
      return false;
    };
    for (;;) {
      const remaining = ctx.deadline - Date.now();
      if (remaining <= 0) throw new ScooterError('TIMEOUT', 'Power non confirmé.');
      try {
        await this._repeatUntil(frame, match, {
          timeoutMs: answered ? remaining : Math.min(remaining, SET_PWD_SILENT_MS),
          intervalMs: SET_PWD_RESEND_MS[variant],
        });
        break;
      } catch (err) {
        if (err.code !== 'TIMEOUT') throw err;
        if (!answered) throw new ScooterError('SILENT', `Pas de réponse à SET_PWD (encodage ${variant}).`);
      }
    }
    this._mark(this._sawWaiting ? 'SET_PWD accepté (Power confirmé)' : 'SET_PWD accepté tout de suite');
    // A few older ZT3 firmwares accept SET_PWD in non-SN mode but switch
    // their response/auth channel back to SN immediately afterwards.
    if (variant === 'legacy' && this.crypto.counter === 0) this.crypto.startSn();

    this.crypto.setKey(password, this._auth);
    if (!(await this._sendAuth('AUTH'))) {
      throw new ScooterError('AUTH_REFUSED', 'AUTH refusée par la trottinette.');
    }
    storage.set(`zt3:pwd:${this.serial}`, toHex(password, ''));
  }

  /** Sends AUTH (serial number) with the current key. Returns true if the scooter answers index 1. */
  async _sendAuth(label) {
    this._mark(label);
    let res;
    try {
      res = await this._repeatUntil(buildFrame(SYNC2, BOARD_AUTH, CMD.AUTH, 0x00, this._sn),
        (f) => f.cmd === CMD.AUTH || f.cmd === CMD.READ_ACK, { timeoutMs: AUTH_RESEND_MS * AUTH_TRIES, intervalMs: AUTH_RESEND_MS });
    } catch (err) {
      if (err.code !== 'TIMEOUT') throw err;
      return false;
    }
    if (res.index !== 1) {
      this.log('warn', `[${this._elapsed()}] AUTH : réponse ${res.index}`);
      return false;
    }
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
    this.authWriteChar = null;
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
        const write = await svc.getCharacteristic(writeUuid);
        const notify = await svc.getCharacteristic(notifyUuid);
        let authNotify = null;
        if (svcUuid === NB_SERVICE) {
          this.authWriteChar = await svc.getCharacteristic(NB_AUTH_WRITE).catch((e) => {
            this.log('debug', `Caractéristique 0005 absente (${e.message}).`);
            return null;
          });
          authNotify = await svc.getCharacteristic(NB_AUTH_NOTIFY).catch((e) => {
            this.log('debug', `Caractéristique 0006 absente (${e.message}).`);
            return null;
          });
        }
        channels.push({ label, write, notify, authNotify });
      } catch (err) {
        if (this._gattLost) throw err;
        this.log('debug', `Service ${label} absent (${err.message}).`);
      }
    }
    if (!channels.length) throw new ScooterError('PROTOCOL', 'Aucun service Bluetooth Segway trouvé sur cet appareil.');
    this.channels = channels;
    this.writeChar = channels[0].write;
    const notifyChars = [...new Set(channels.flatMap((c) => [c.notify, c.authNotify].filter(Boolean)))];
    this._mark(`canaux trouvés : ${channels.map((c) => c.label).join(' + ')}`);

    for (const ch of this.notifyChars ?? []) ch.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.notifyChars = notifyChars;
    this._assemblers = new Map(notifyChars.map((ch) => [ch, new FrameAssembler((f) => this._onFrame(f))]));
    for (const ch of notifyChars) {
      ch.addEventListener('characteristicvaluechanged', this._onNotify);
      // Bluefy has been reported to deliver notifications only through the on* handler.
      try { ch.oncharacteristicvaluechanged = this._onNotify; } catch { /* read-only in some engines */ }
      await ch.startNotifications();
      // Official app: only 006E-0004 is toggled; B5A3-0003 is just subscribed.
      if (toggleCccd && ch.uuid === NB_NOTIFY) {
        // iOS keeps CCCD state between connections: toggle it to get a clean subscription.
        try {
          await ch.stopNotifications();
          await sleep(300); // value from the community docs (iOS stale CCCD workaround)
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
    // The event is queued asynchronously: a late one from a previous connection must not
    // kill the connection that was just reopened.
    if (this.device?.gatt?.connected) {
      this.log('debug', 'Événement de déconnexion périmé ignoré.');
      return;
    }
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
      if (!ok) {
        this.log('debug', `Contrôle d'intégrité invalide sur ${toHex(plain)}`);
        continue;
      }
      const frame = parseFrame(plain);
      if (frame && match(frame)) return frame;
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
  async _repeatUntil(plainFrame, match, { timeoutMs, intervalMs = 500, burst = 1 }) {
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
      if (!ok) {
        this.log('debug', `Contrôle d'intégrité invalide sur ${toHex(plain)}`);
        continue;
      }
      const frame = parseFrame(plain);
      if (frame && match(frame)) return frame;
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
          (f) => (f.cmd === CMD.PRE_COMM || f.cmd === CMD.READ_ACK) && f.data.length >= 30,
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
