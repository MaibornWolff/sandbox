import { crc32, inflateSync } from "node:zlib";

const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 16 * 1024 * 1024;

function invalid(): never {
  throw new Error("Invalid PNG.");
}

function pngRows(
  width: number,
  height: number,
  bits: number,
  interlace: number,
): number[] {
  if (interlace === 0)
    return Array.from({ length: height }, () => Math.ceil((width * bits) / 8));
  const rows: number[] = [];
  for (const [x, y, dx, dy] of [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const) {
    const w = Math.max(0, Math.ceil((width - x) / dx));
    const h = Math.max(0, Math.ceil((height - y) / dy));
    if (w > 0)
      for (let row = 0; row < h; row += 1) rows.push(Math.ceil((w * bits) / 8));
  }
  return rows;
}

function pngHeader(bytes: Buffer): {
  width: number;
  height: number;
  bits: number;
  color: number;
  interlace: number;
} {
  if (
    bytes.length < 57 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    invalid();
  if (
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    invalid();
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    invalid();
  const depth = bytes[24] ?? 0,
    color = bytes[25] ?? -1;
  const depths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  const channels: Readonly<Record<number, number>> = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
  };
  if (
    !depths[color]?.includes(depth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    (bytes[28] !== 0 && bytes[28] !== 1)
  )
    invalid();
  return {
    width,
    height,
    bits: depth * (channels[color] ?? 0),
    color,
    interlace: bytes[28] ?? 0,
  };
}

interface PngState {
  compressed: Buffer[];
  palette: boolean;
  dataEnded: boolean;
}
function acceptChunk(
  state: PngState,
  type: string,
  data: Buffer,
  color: number,
): void {
  if (type === "PLTE") {
    if (
      state.compressed.length ||
      state.palette ||
      !data.length ||
      data.length % 3 ||
      data.length > 768
    )
      invalid();
    state.palette = true;
  }
  if (type === "IDAT") {
    if (state.dataEnded || (color === 3 && !state.palette)) invalid();
    state.compressed.push(data);
  } else if (state.compressed.length) state.dataEnded = true;
  if (
    !["IHDR", "PLTE", "IDAT", "IEND"].includes(type) &&
    type[0] === type[0]?.toUpperCase()
  )
    invalid();
}

function pngData(bytes: Buffer, color: number): Buffer[] {
  const state: PngState = { compressed: [], palette: false, dataEnded: false };
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset),
      end = offset + 12 + size;
    if (end > bytes.length) invalid();
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      invalid();
    if (type === "IHDR" && offset !== 8) invalid();
    acceptChunk(state, type, bytes.subarray(offset + 8, end - 4), color);
    if (type === "IEND") {
      if (size || !state.compressed.length || end !== bytes.length) invalid();
      return state.compressed;
    }
    offset = end;
  }
  return invalid();
}

export function validatePng(bytes: Buffer): void {
  const { width, height, bits, color, interlace } = pngHeader(bytes);
  const compressed = pngData(bytes, color);
  const rows = pngRows(width, height, bits, interlace);
  const expected = rows.reduce((sum, row) => sum + row + 1, 0);
  const inflated = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expected,
  });
  if (inflated.length !== expected) invalid();
  let cursor = 0;
  for (const row of rows) {
    if ((inflated[cursor] ?? 255) > 4) invalid();
    cursor += row + 1;
  }
}
