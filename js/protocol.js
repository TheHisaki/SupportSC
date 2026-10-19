// Ninebot frame format (Encryption2, "Protocol 2" framing).
// Plain request : [5A, SYNC2, LEN, 3E, target, cmd, index, data(LEN)...]
// Plain response: [5A, SYNC2, LEN, source, 3E, cmd, index, data(LEN)...]
// On the wire every frame is LEN + 13 bytes (7 header bytes + data + 4 MAC + 2 counter).

export const SYNC1 = 0x5a;
export const VALID_SYNC2 = [0xa5, 0xb5];
export const BT_ID = 0x3e;

export const CMD = Object.freeze({
  READ: 0x01,
  WRITE: 0x02, // write with ACK (cmd 0x05)
  WRITE_NR: 0x03, // write, no response
  READ_ACK: 0x04,
  WRITE_ACK: 0x05,
  PRE_COMM: 0x5b,
  SET_PWD: 0x5c,
  AUTH: 0x5d,
});

/** Builds a plaintext request frame. */
export function buildFrame(sync2, target, cmd, index, data = new Uint8Array(0)) {
  const frame = new Uint8Array(7 + data.length);
  frame.set([SYNC1, sync2, data.length, BT_ID, target, cmd, index], 0);
  frame.set(data, 7);
  return frame;
}

/** Parses a decrypted response frame. Returns null if it is not a valid response. */
export function parseFrame(plain) {
  if (plain.length < 7) return null;
  if (plain[0] !== SYNC1 || !VALID_SYNC2.includes(plain[1])) return null;
  if (plain[4] !== BT_ID) return null;

  const len = plain[2];
  // X3 firmware uses LEN=data length (7+LEN bytes). Keep support for the
  // older format where LEN includes source/target/cmd/index (3+LEN bytes).
  const isNewFormat = plain.length === 7 + len;
  const isOldFormat = len >= 4 && plain.length === 3 + len;
  if (!isNewFormat && !isOldFormat) return null;

  const dataLength = isNewFormat ? len : len - 4;
  return {
    source: plain[3],
    cmd: plain[5],
    index: plain[6],
    data: plain.slice(7, 7 + dataLength),
  };
}

export function u16le(value) {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
}

export function readU16(data) {
  return data.length >= 2 ? data[0] | (data[1] << 8) : null;
}

export function readU32(data) {
  return data.length >= 4 ? (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0 : null;
}

/**
 * Reassembles encrypted frames from BLE notification chunks.
 * Scans for 5A A5/B5, reads LEN and emits LEN + 13 bytes.
 */
export class FrameAssembler {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = new Uint8Array(0);
  }

  reset() {
    this.buffer = new Uint8Array(0);
  }

  push(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    let buf = merged;

    for (;;) {
      let start = -1;
      for (let i = 0; i + 1 < buf.length; i++) {
        if (buf[i] === SYNC1 && VALID_SYNC2.includes(buf[i + 1])) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        // Keep a trailing 0x5A in case the sync pair is split across chunks.
        buf = buf.length && buf[buf.length - 1] === SYNC1 ? buf.slice(-1) : new Uint8Array(0);
        break;
      }
      if (start > 0) buf = buf.slice(start);
      if (buf.length < 3) break;

      const total = buf[2] + 13;
      if (buf.length < total) break;

      this.onFrame(buf.slice(0, total));
      buf = buf.slice(total);
    }
    this.buffer = buf;
  }
}
