import { crc32, deflateSync } from "node:zlib";

export function createClipboardTestImage(width = 256, height = 256): Buffer {
  const chunk = (type: string, payload: Buffer): Buffer => {
    const bytes = Buffer.alloc(payload.length + 12);
    bytes.writeUInt32BE(payload.length, 0);
    bytes.write(type, 4, "ascii");
    payload.copy(bytes, 8);
    bytes.writeUInt32BE(
      crc32(bytes.subarray(4, bytes.length - 4)),
      bytes.length - 4,
    );
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  let seed = 0x12345678;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      rows[y * (width * 4 + 1) + x + 1] = seed >>> 24;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
