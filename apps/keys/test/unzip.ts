// Read a zip of stored (uncompressed) files, as the key page makes them (`src/zip.ts`).
import { crc32 } from '../src/zip';

export function unzip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out: Record<string, string> = {};
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    if (view.getUint16(at + 8, true) !== 0) throw new Error('compressed');
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra;
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`bad crc for ${name}`);
    out[name] = decoder.decode(data);
    at = start + size;
  }
  if (view.getUint32(at, true) !== 0x02014b50) throw new Error('no central directory');
  return out;
}
