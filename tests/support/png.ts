import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. Shaped like `ImageData`. */
  data: Uint8ClampedArray;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Minimal PNG decoder for the checked-in fixtures: 8-bit, non-interlaced, color types 0, 2, 4 and 6.
 * Avoids a runtime image dependency so unit tests stay deterministic and offline.
 */
export function decodePng(file: string): RasterImage {
  const bytes = readFileSync(file);
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file}: not a PNG`);
  let width = 0;
  let height = 0;
  let colorType = -1;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8 || body[12] !== 0) throw new Error(`${file}: only 8-bit non-interlaced PNG supported`);
    } else if (type === 'IDAT') {
      chunks.push(body);
    }
    offset += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`${file}: unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? rows[(y - 1) * stride + x - channels] : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      if (predictor === undefined) throw new Error(`${file}: bad PNG filter ${filter}`);
      rows[y * stride + x] = (source[x] + predictor) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  const grayscale = colorType === 0 || colorType === 4;
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    data[i * 4] = rows[p];
    data[i * 4 + 1] = grayscale ? rows[p] : rows[p + 1];
    data[i * 4 + 2] = grayscale ? rows[p] : rows[p + 2];
    data[i * 4 + 3] = colorType === 6 ? rows[p + 3] : colorType === 4 ? rows[p + 1] : 255;
  }
  return { width, height, data };
}
