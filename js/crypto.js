// Ninebot "Encryption2" crypto (AES-128, CTR-like + CBC-MAC), implemented with WebCrypto.
// Reference: https://nootnooot.codeberg.page/segway-ninebot-ble/encryption/
// WebCrypto has no raw AES-ECB, so a single ECB block is computed as AES-CBC with a zero IV
// (the first output block of CBC with IV=0 equals ECB of that block).

const subtle = globalThis.crypto.subtle;

// Fixed protocol constant (Gen2 non-SN keystream input and initial key2). Not a secret.
export const FW_DATA = Uint8Array.from([
  0x97, 0xcf, 0xb8, 0x02, 0x84, 0x41, 0x43, 0xde,
  0x56, 0x00, 0x2b, 0x3b, 0x34, 0x78, 0x0a, 0x5d,
]);

const ZERO_IV = new Uint8Array(16);

export function pad16(bytes) {
  const out = new Uint8Array(16);
  if (bytes) out.set(bytes.subarray(0, 16));
  return out;
}

export function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(bytes, sep = ' ') {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

export function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 !== 0) throw new Error('Hex invalide');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// The X3/ZT3 pairing password is produced by the Java-compatible generator
// used by the public Ninebot BLE clients, not by random bytes. The scooter
// accepts SET_PWD only when this value matches its current-time seed.
const JAVA_MASK = (1n << 48n) - 1n;
const JAVA_MULTIPLIER = 0x5deece66dn;
const JAVA_ADDEND = 0xBn;

function javaSigned32(value) {
  const unsigned = value >>> 0;
  return unsigned >= 0x80000000 ? unsigned - 0x100000000 : unsigned;
}

function pairingSeedOffset(authParam) {
  let offset = 0n;
  for (let i = 0; i < authParam.length; i++) {
    // Java's source uses a signed byte and 32-bit shift semantics. Bitwise
    // operators in JavaScript provide the required 32-bit shift behavior.
    const signedByte = authParam[i] < 0x80 ? authParam[i] : authParam[i] - 0x100;
    const shift = ((i % 8) * 8) & 31;
    const value = javaSigned32(signedByte << shift);
    offset = BigInt.asIntN(64, offset + BigInt(value));
  }
  return offset;
}

/** Generates the 16-byte SET_PWD password used by the ZT3/X3 firmware. */
export async function generatePairingPassword(authParam, timestampMs = Date.now()) {
  const timestamp = BigInt(Math.trunc(timestampMs));
  const seed = BigInt.asIntN(64, timestamp + pairingSeedOffset(authParam));
  let state = (seed ^ JAVA_MULTIPLIER) & JAVA_MASK;
  const random = new Uint8Array(16);

  for (let offset = 0; offset < random.length; offset += 4) {
    state = (state * JAVA_MULTIPLIER + JAVA_ADDEND) & JAVA_MASK;
    const nextInt = Number(state >> 16n) >>> 0;
    for (let i = 0; i < 4 && offset + i < random.length; i++) {
      random[offset + i] = (nextInt >>> (i * 8)) & 0xff;
    }
  }

  const digest = await subtle.digest('SHA-256', random);
  return new Uint8Array(digest, 0, 16).slice();
}

const aesKeyCache = new Map();

async function importAesKey(rawKey) {
  const id = toHex(rawKey, '');
  let key = aesKeyCache.get(id);
  if (!key) {
    key = await subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt']);
    aesKeyCache.set(id, key);
  }
  return key;
}

/** Single-block AES-128-ECB encryption. */
export async function aesEncryptBlock(rawKey, block16) {
  const key = await importAesKey(rawKey);
  const out = await subtle.encrypt({ name: 'AES-CBC', iv: ZERO_IV }, key, block16);
  return new Uint8Array(out, 0, 16).slice();
}

/** AES key = SHA-1(pad16(key1) || pad16(key2 or zeros))[0:16] */
export async function deriveKey(key1, key2) {
  const buf = new Uint8Array(32);
  buf.set(pad16(key1), 0);
  if (key2) buf.set(pad16(key2), 16);
  const hash = new Uint8Array(await subtle.digest('SHA-1', buf));
  return hash.slice(0, 16);
}

function buildNonce(counter, auth) {
  const nonce = new Uint8Array(13);
  nonce[0] = (counter >>> 24) & 0xff;
  nonce[1] = (counter >>> 16) & 0xff;
  nonce[2] = (counter >>> 8) & 0xff;
  nonce[3] = counter & 0xff;
  nonce.set(auth.subarray(0, 8), 4);
  return nonce;
}

function ctrBlock(nonce, i) {
  const b = new Uint8Array(16);
  b[0] = 0x01;
  b.set(nonce, 1);
  b[15] = i & 0xff;
  return b;
}

function macBlock(nonce, payloadLen) {
  const b = new Uint8Array(16);
  b[0] = 0x59;
  b.set(nonce, 1);
  b[15] = payloadLen & 0xff;
  return b;
}

function xor16(a, b) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
  return out;
}

async function cbcMac(key, plain, nonce) {
  let x = await aesEncryptBlock(key, macBlock(nonce, plain.length - 3));
  x = await aesEncryptBlock(key, xor16(x, pad16(plain.subarray(0, 3))));
  const payload = plain.subarray(3);
  for (let off = 0; off < payload.length; off += 16) {
    x = await aesEncryptBlock(key, xor16(x, pad16(payload.subarray(off, off + 16))));
  }
  return x.slice(0, 4);
}

async function ctrXor(key, data, nonce) {
  const out = new Uint8Array(data.length);
  for (let off = 0, i = 1; off < data.length; off += 16, i++) {
    const ks = await aesEncryptBlock(key, ctrBlock(nonce, i));
    for (let j = 0; j < 16 && off + j < data.length; j++) out[off + j] = data[off + j] ^ ks[j];
  }
  return out;
}

function checksum16(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return ~sum & 0xffff;
}

/**
 * Stateful crypto context (mirrors libnbcrypto's crypto_param_t).
 * counter == 0 -> non-SN mode (static keystream + checksum), used only for PRE_COMM.
 * counter  > 0 -> SN mode (CTR + CBC-MAC).
 * State (key, auth, counter) is captured synchronously at call time so callers can
 * change keys right after sending without racing in-flight operations.
 */
export class NbCrypto {
  constructor(ecbInput = null, { followPeer = false } = {}) {
    this.ecbInput = pad16(ecbInput);
    this.auth = new Uint8Array(16);
    this.counter = 0;
    // Official Segway app behaviour on "x3" scooters (G3/GT3/ZT3): the message counter is shared,
    // every received SN frame sets it, and the next sent frame uses received + 1.
    this.followPeer = followPeer;
    this._keyPromise = deriveKey(new Uint8Array(0), null);
  }

  setKey(key1, key2) {
    this._keyPromise = deriveKey(key1, key2 ?? null);
  }

  setAuthParam(auth) {
    this.auth = pad16(auth);
  }

  startSn() {
    this.counter = 1;
  }

  resetSn() {
    this.counter = 0;
  }

  async encrypt(plain) {
    const keyPromise = this._keyPromise;
    const auth = this.auth;
    const header = plain.slice(0, 3);
    const payload = plain.subarray(3);

    if (this.counter > 0) {
      const counter = ++this.counter;
      const key = await keyPromise;
      const nonce = buildNonce(counter, auth);
      const tag = await cbcMac(key, plain, nonce);
      const cipher = await ctrXor(key, payload, nonce);
      const a0 = await aesEncryptBlock(key, ctrBlock(nonce, 0));
      const encTag = tag.map((b, i) => b ^ a0[i]);
      return concatBytes(header, cipher, encTag, Uint8Array.of((counter >> 8) & 0xff, counter & 0xff));
    }

    const key = await keyPromise;
    const ks = await aesEncryptBlock(key, this.ecbInput);
    const cipher = payload.map((b, i) => b ^ ks[i % 16]);
    const sum = checksum16(payload);
    return concatBytes(header, cipher, Uint8Array.of(0, 0, sum & 0xff, sum >> 8, 0, 0));
  }

  /** Returns { plain, ok } where ok=false means MAC/checksum mismatch. */
  async decrypt(frame) {
    const keyPromise = this._keyPromise;
    const auth = this.auth;
    const ecbInput = this.ecbInput;
    if (frame.length < 9) return { plain: frame.slice(), ok: false };

    const header = frame.slice(0, 3);
    const body = frame.subarray(3, frame.length - 6);
    const tail = frame.subarray(frame.length - 6);
    const recv16 = (tail[4] << 8) | tail[5];
    const key = await keyPromise;

    // Rebuild the full counter from the 16-bit wire value (handles wrap-around).
    let base = this.counter;
    if ((base & 0x8000) && !(recv16 & 0x8000)) base += 0x10000;
    const counter = recv16 === 0 ? 0 : ((base & ~0xffff) | recv16) >>> 0;
    if (counter > 0 && this.followPeer) this.counter = counter;

    if (counter > 0) {
      const nonce = buildNonce(counter, auth);
      const plain = concatBytes(header, await ctrXor(key, body, nonce));
      const a0 = await aesEncryptBlock(key, ctrBlock(nonce, 0));
      const recvTag = tail.subarray(0, 4).map((b, i) => b ^ a0[i]);
      const expected = await cbcMac(key, plain, nonce);
      const ok = bytesEqual(recvTag, expected);
      // A delayed/invalid notification must never rewind the send counter.
      // Rewinding makes the next retry reuse a counter the scooter already saw.
      if (ok && this.followPeer && counter > this.counter) this.counter = counter;
      return { plain, ok };
    }

    const ks = await aesEncryptBlock(key, ecbInput);
    const payload = body.map((b, i) => b ^ ks[i % 16]);
    const plain = concatBytes(header, payload);
    const recvSum = tail[2] | (tail[3] << 8);
    return { plain, ok: recvSum === checksum16(payload) };
  }
}
