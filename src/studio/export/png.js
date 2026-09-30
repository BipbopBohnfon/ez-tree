// Raw-byte PNG codec for texture-set packing. 8-bit RGBA, straight
// (non-premultiplied) alpha: bytes go into the file exactly as given, with no
// canvas round trip (a 2D canvas premultiplies and would destroy the colour
// bled under transparent texels). Uses CompressionStream('deflate') (zlib
// framing, as PNG's IDAT wants), so it runs in browsers and Node >= 18.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Filters every scanline with the PNG filter (0..4) whose output has the
 * smallest sum of absolute signed bytes (the libpng heuristic).
 */
function filterRows(data, width, height) {
  const stride = width * 4;
  const out = new Uint8Array(height * (stride + 1));
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y ? data.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = candidates[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0, b = up[i], cc = i >= 4 ? up[i - 4] : 0;
        const x = row[i];
        const v = (f === 0 ? x : f === 1 ? x - a : f === 2 ? x - b : f === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, cc)) & 0xff;
        c[i] = v;
        score += v < 128 ? v : 256 - v;
        if (score >= bestScore) break;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    // A filter's loop is cut short only once it has lost, so the winner's
    // buffer is complete.
    out[y * (stride + 1)] = best;
    out.set(candidates[best], y * (stride + 1) + 1);
  }
  return out;
}

function chunk(type, payload) {
  const bytes = new Uint8Array(12 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(bytes, 4, 8 + payload.length));
  return bytes;
}

/**
 * Encodes a top-down RGBA image as an 8-bit RGBA PNG.
 * @param {{data: Uint8Array|Uint8ClampedArray, width: number, height: number}} image
 * @returns {Promise<Uint8Array>}
 */
export async function encodePNG({ data, width, height }) {
  if (data.length !== width * height * 4) throw new RangeError('PNG: data is not width*height*4 bytes');
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const pixels = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length);
  const idat = await pipe(filterRows(pixels, width, height), new CompressionStream('deflate'));
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/**
 * Decodes an 8-bit RGBA, non-interlaced PNG (what encodePNG writes).
 * @param {Uint8Array} bytes
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>}
 */
export async function decodePNG(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) throw new Error('PNG: bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes, offset + 4, offset + 8 + length) !== view.getUint32(offset + 8 + length)) throw new Error(`PNG: bad CRC in ${type}`);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (payload[8] !== 8 || payload[9] !== 6 || payload[12] !== 0) throw new Error('PNG: only 8-bit RGBA non-interlaced');
    } else if (type === 'IDAT') idat.push(payload);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const joined = new Uint8Array(idat.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of idat) { joined.set(p, o); o += p.length; }
  const raw = await pipe(joined, new DecompressionStream('deflate'));
  const stride = width * 4;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y ? data.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0, b = up[i], c = i >= 4 ? up[i - 4] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      row[i] = (src[i] + pred) & 0xff;
    }
  }
  return { data, width, height };
}
