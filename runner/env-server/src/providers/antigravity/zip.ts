/**
 * The smallest zip reader the Antigravity install needs: read the central
 * directory, describe each entry, and stream one entry (stored or deflated)
 * to a file with its size and CRC-32 checked. No dependency, no shell-out to
 * `unzip`, and nothing is ever written from a name the caller did not accept.
 */
import fs from "node:fs";
import { createInflateRaw, crc32 } from "node:zlib";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttributes: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 64;

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buffer, read, length - read, position + read);
    if (n === 0) throw new ZipError("The archive is truncated.");
    read += n;
  }
  return buffer;
}

/** Lists the entries of the archive at `file`. */
export function readZipEntries(file: string): ZipEntry[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLength = Math.min(size, 65_557);
    const tail = readAt(fd, size - tailLength, tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new ZipError("The archive has no central directory.");
    let total = tail.readUInt16LE(at + 10);
    let cdSize = tail.readUInt32LE(at + 12);
    let cdOffset = tail.readUInt32LE(at + 16);
    if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locator = at - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new ZipError("The archive's zip64 directory is missing.");
      const z64 = Number(tail.readBigUInt64LE(locator + 8));
      const record = readAt(fd, z64, 56);
      if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new ZipError("The archive's zip64 directory is invalid.");
      total = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }
    if (total > MAX_ENTRIES) throw new ZipError("The archive has too many entries.");
    if (cdOffset + cdSize > size) throw new ZipError("The archive's directory points past its end.");
    const cd = readAt(fd, cdOffset, cdSize);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < total; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) throw new ZipError("The archive's directory is corrupt.");
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const externalAttributes = cd.readUInt32LE(p + 38);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLength).toString("utf8");
      const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) (uncompressedSize = Number(extra.readBigUInt64LE(q))), (q += 8);
          if (compressedSize === 0xffffffff) (compressedSize = Number(extra.readBigUInt64LE(q))), (q += 8);
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(extra.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      entries.push({ name, method, flags, crc32: crc, compressedSize, uncompressedSize, externalAttributes, localHeaderOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/** Counts bytes and the CRC as they pass, failing past `limit`. */
class Meter extends Transform {
  bytes = 0;
  crc = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      done(new ZipError("An archive member is larger than expected."));
      return;
    }
    this.crc = crc32(chunk, this.crc);
    done(null, chunk);
  }
}

/** Streams one entry into `destination` (created exclusively, mode `mode`), checking size and CRC-32. */
export async function extractZipEntry(file: string, entry: ZipEntry, destination: string, mode = 0o700, signal?: AbortSignal): Promise<void> {
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError("An archive member uses an unsupported compression method.");
  if (entry.flags & 1) throw new ZipError("An archive member is encrypted.");
  const fd = fs.openSync(file, "r");
  let dataOffset: number;
  try {
    const header = readAt(fd, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL) throw new ZipError("An archive member's header is corrupt.");
    dataOffset = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
  const source = fs.createReadStream(file, { start: dataOffset, end: dataOffset + entry.compressedSize - 1 });
  const meter = new Meter(entry.uncompressedSize);
  const sink = fs.createWriteStream(destination, { flags: "wx", mode });
  const stages = entry.method === 8 ? [source, createInflateRaw(), meter, sink] : [source, meter, sink];
  await (pipeline as (...streams: unknown[]) => Promise<void>)(...stages, ...(signal ? [{ signal }] : []));
  if (meter.bytes !== entry.uncompressedSize) throw new ZipError("An archive member was truncated.");
  if (meter.crc >>> 0 !== entry.crc32 >>> 0) throw new ZipError("An archive member failed its checksum.");
}
