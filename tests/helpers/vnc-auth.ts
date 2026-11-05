/**
 * The RFB (VNC) client side of a handshake, for tests only: version, security type 2
 * (VNC authentication) and its DES challenge, then ClientInit and the server's name.
 *
 * VNC authentication answers a 16-byte challenge with the challenge encrypted by
 * single DES in ECB mode, the key being the password cut or padded to 8 bytes with
 * each byte's bits reversed (RFC 6143 section 7.2.2 and the long-standing
 * implementations it describes). Node's OpenSSL 3 keeps DES in its legacy provider,
 * so `createCipheriv("des-ecb")` throws ERR_OSSL_EVP_UNSUPPORTED; this is a plain
 * FIPS 46-3 DES, encryption only, small and slow, which is all a test needs.
 * Never use it for anything but talking to a test computer's x11vnc.
 */

// FIPS 46-3 tables, 1-based bit positions as the standard writes them.
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

type Bits = number[];

function toBits(bytes: Uint8Array): Bits {
  const bits: Bits = [];
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  return bits;
}

function fromBits(bits: Bits): Buffer {
  const out = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, i) => {
    if (bit) out[i >> 3]! |= 0x80 >> (i & 7);
  });
  return out;
}

const permute = (bits: Bits, table: readonly number[]): Bits => table.map((position) => bits[position - 1]!);
const rotateLeft = (bits: Bits, n: number): Bits => [...bits.slice(n), ...bits.slice(0, n)];

function subkeys(key: Uint8Array): Bits[] {
  const permuted = permute(toBits(key), PC1);
  let c = permuted.slice(0, 28);
  let d = permuted.slice(28);
  return SHIFTS.map((shift) => {
    c = rotateLeft(c, shift);
    d = rotateLeft(d, shift);
    return permute([...c, ...d], PC2);
  });
}

function feistel(right: Bits, subkey: Bits): Bits {
  const mixed = permute(right, E).map((bit, i) => bit ^ subkey[i]!);
  const out: Bits = [];
  for (let box = 0; box < 8; box++) {
    const six = mixed.slice(box * 6, box * 6 + 6);
    const row = (six[0]! << 1) | six[5]!;
    const column = (six[1]! << 3) | (six[2]! << 2) | (six[3]! << 1) | six[4]!;
    const value = S[box]![row * 16 + column]!;
    for (let i = 3; i >= 0; i--) out.push((value >> i) & 1);
  }
  return permute(out, P);
}

/** DES encryption of one 8-byte block under an 8-byte key (parity bits ignored, as DES does). */
export function desEncryptBlock(key: Uint8Array, block: Uint8Array): Buffer {
  if (key.length !== 8 || block.length !== 8) throw new Error("DES needs an 8-byte key and an 8-byte block");
  const keys = subkeys(key);
  const permuted = permute(toBits(block), IP);
  let left = permuted.slice(0, 32);
  let right = permuted.slice(32);
  for (const subkey of keys) {
    const next = feistel(right, subkey).map((bit, i) => bit ^ left[i]!);
    left = right;
    right = next;
  }
  return fromBits(permute([...right, ...left], FP));
}

function reverseBits(byte: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) out |= ((byte >> i) & 1) << (7 - i);
  return out;
}

/** The answer to a VNC authentication challenge: DES-ECB of the 16 bytes under the bit-reversed password. */
export function vncAuthResponse(password: string, challenge: Uint8Array): Buffer {
  if (challenge.length !== 16) throw new Error("a VNC challenge is 16 bytes");
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) key[i] = reverseBits(key[i]!);
  return Buffer.concat([desEncryptBlock(key, challenge.subarray(0, 8)), desEncryptBlock(key, challenge.subarray(8, 16))]);
}

/** A byte stream the handshake reads from and writes to (a relay WebSocket, a TCP socket, a tunnel). */
export interface RfbTransport {
  /** Resolves with exactly `n` more bytes, or rejects when the stream closes or `timeoutMs` passes first. */
  read(n: number, timeoutMs?: number): Promise<Buffer>;
  write(bytes: Buffer): void;
}

export type RfbHandshakeResult =
  | { ok: true; version: string; width: number; height: number; name: string }
  | { ok: false; version: string; stage: "security" | "auth"; reason: string };

/**
 * RFB 3.8 up to the server's name: the version, security type 2 (the only one this
 * expects a computer's x11vnc to offer), the challenge answered with `password`, the
 * SecurityResult, and, when it is OK, ClientInit (shared) and ServerInit.
 */
export async function rfbHandshake(transport: RfbTransport, password: string, timeoutMs = 15_000): Promise<RfbHandshakeResult> {
  const version = (await transport.read(12, timeoutMs)).toString("latin1");
  if (!/^RFB 003\.\d{3}\n$/.test(version)) throw new Error(`not an RFB server: ${JSON.stringify(version)}`);
  transport.write(Buffer.from("RFB 003.008\n", "latin1"));
  const count = (await transport.read(1, timeoutMs))[0]!;
  if (count === 0) {
    const length = (await transport.read(4, timeoutMs)).readUInt32BE(0);
    const reason = (await transport.read(length, timeoutMs)).toString("utf8");
    return { ok: false, version: version.trim(), stage: "security", reason };
  }
  const types = [...(await transport.read(count, timeoutMs))];
  if (!types.includes(2)) throw new Error(`the server does not offer VNC authentication: ${types.join(",")}`);
  transport.write(Buffer.from([2]));
  const challenge = await transport.read(16, timeoutMs);
  transport.write(vncAuthResponse(password, challenge));
  const result = (await transport.read(4, timeoutMs)).readUInt32BE(0);
  if (result !== 0) {
    // RFB 3.8 sends a reason after a failure; read it if it comes.
    let reason = `SecurityResult ${result}`;
    try {
      const length = (await transport.read(4, 3_000)).readUInt32BE(0);
      reason = (await transport.read(length, 3_000)).toString("utf8") || reason;
    } catch {
      // Some servers close without one.
    }
    return { ok: false, version: version.trim(), stage: "auth", reason };
  }
  transport.write(Buffer.from([1])); // ClientInit: share the desktop
  const init = await transport.read(24, timeoutMs);
  const width = init.readUInt16BE(0);
  const height = init.readUInt16BE(2);
  const nameLength = init.readUInt32BE(20);
  const name = (await transport.read(nameLength, timeoutMs)).toString("utf8");
  return { ok: true, version: version.trim(), width, height, name };
}

/** A buffered reader over anything that emits byte chunks and a close. */
export function chunkReader(): {
  push(chunk: Buffer): void;
  close(reason: string): void;
  read(n: number, timeoutMs?: number): Promise<Buffer>;
  closed(): string | null;
} {
  let buffered = Buffer.alloc(0);
  let closedReason: string | null = null;
  let waiter: (() => void) | null = null;
  const wake = () => {
    const next = waiter;
    waiter = null;
    next?.();
  };
  return {
    push(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      wake();
    },
    close(reason) {
      closedReason ??= reason;
      wake();
    },
    closed: () => closedReason,
    async read(n, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (buffered.length < n) {
        if (closedReason !== null) throw new Error(`closed (${closedReason}) after ${buffered.length} of ${n} bytes`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out waiting for ${n} bytes (have ${buffered.length})`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          waiter = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      const out = buffered.subarray(0, n);
      buffered = buffered.subarray(n);
      return Buffer.from(out);
    },
  };
}
