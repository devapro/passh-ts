// QR code encoder (ISO/IEC 18004), for the print page (print.md §6.8: the recovery key at
// level M) and the terminal dialog (print.md §6.9: the URL at level L).
//
// Segments as described at makeSegments, the smallest version that fits, and the mask with
// the lowest penalty. print.md leaves the module pattern, modes, version and mask to the
// encoder; these choices reproduce the reference's codes (checked against its output).

export type EccLevel = "L" | "M" | "Q" | "H";

/** A QR code: `size` × `size` modules, `true` = dark. */
export interface QrCode {
  version: number;
  size: number;
  ecc: EccLevel;
  mask: number;
  /** Row-major modules: modules[y][x]. */
  modules: boolean[][];
}

const ECC_ORDINAL: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
// Format bits of each level (ISO 18004 table 12): L=01, M=00, Q=11, H=10.
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Error correction codewords per block, by level and version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// Number of error correction blocks, by level and version (index 0 unused).
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const ALPHANUMERIC_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

type Mode = { bits: number; ccBits: [number, number, number] };
const NUMERIC: Mode = { bits: 0x1, ccBits: [10, 12, 14] };
const ALPHANUMERIC: Mode = { bits: 0x2, ccBits: [9, 11, 13] };
const BYTE: Mode = { bits: 0x4, ccBits: [8, 16, 16] };

function charCountBits(mode: Mode, version: number): number {
  return mode.ccBits[Math.floor((version + 7) / 17)]!;
}

/** Number of data bits a version can hold, all codewords included (function modules excluded). */
export function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Number of 8-bit data codewords (error correction excluded) of a version and level. */
export function numDataCodewords(ver: number, ecc: EccLevel): number {
  const e = ECC_ORDINAL[ecc];
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
}

class BitBuffer {
  bits: number[] = [];
  append(val: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  }
}

// Segments. The text is split into runs of the narrowest mode for each character, then
// adjacent runs are merged from left to right while one segment in the first run's mode
// is shorter than the two separately (a run of a wider mode is never merged into a
// narrower one); if one segment in the widest mode needed is no longer, it is used
// instead. This is the reference's choice (print.md §6.8 leaves it to the encoder): the
// URL `https://172.21.0.1:8443/p/…` becomes byte `https://`, numeric `172`,
// alphanumeric `.21.0.1:8443/` and byte `p/…`.

const MODES = [NUMERIC, ALPHANUMERIC, BYTE];
const modeRank = (m: Mode) => MODES.indexOf(m);

interface Segment {
  mode: Mode;
  bytes: Uint8Array;
}

function charMode(b: number): Mode {
  if (b >= 0x30 && b <= 0x39) return NUMERIC;
  if (b === 0x20 || b === 0x24 || b === 0x25 || b === 0x2a || b === 0x2b || b === 0x2d || b === 0x2e || b === 0x2f || b === 0x3a || (b >= 0x41 && b <= 0x5a)) return ALPHANUMERIC;
  return BYTE;
}

/** The encoded length in bits of n characters in a mode (header included), or -1 if n is too many. */
function encodedLength(mode: Mode, n: number, ccBits: number): number {
  if (n > (1 << ccBits) - 1) return -1;
  let len = 4 + ccBits;
  if (mode === NUMERIC) len += 10 * Math.floor(n / 3) + (n % 3 !== 0 ? 1 + 3 * (n % 3) : 0);
  else if (mode === ALPHANUMERIC) len += 11 * Math.floor(n / 2) + 6 * (n % 2);
  else len += 8 * n;
  return len;
}

/** The segments for one range of versions (the char count field widths of `ver`). */
function makeSegments(data: Uint8Array, ver: number): { segments: Segment[]; bits: number } | undefined {
  const cc = (m: Mode) => charCountBits(m, ver);
  const runs: Segment[] = [];
  let start = 0;
  let mode: Mode | undefined;
  let widest = NUMERIC;
  for (let i = 0; i < data.length; i++) {
    const m = charMode(data[i]!);
    if (m !== mode) {
      if (i > 0) runs.push({ mode: mode!, bytes: data.subarray(start, i) });
      start = i;
      mode = m;
    }
    if (modeRank(m) > modeRank(widest)) widest = m;
  }
  runs.push({ mode: mode ?? BYTE, bytes: data.subarray(start) });

  const merged: Segment[] = [];
  for (let i = 0; i < runs.length; ) {
    const m = runs[i]!.mode;
    let n = runs[i]!.bytes.length;
    let j = i + 1;
    while (j < runs.length) {
      const next = runs[j]!;
      if (modeRank(next.mode) > modeRank(m)) break;
      const together = encodedLength(m, n + next.bytes.length, cc(m));
      const first = encodedLength(m, n, cc(m));
      const second = encodedLength(next.mode, next.bytes.length, cc(next.mode));
      if (together < 0 || first < 0 || second < 0) return undefined;
      if (together < first + second) {
        n += next.bytes.length;
        j++;
      } else break;
    }
    const startOff = runs[i]!.bytes.byteOffset - data.byteOffset;
    merged.push({ mode: m, bytes: data.subarray(startOff, startOff + n) });
    i = j;
  }
  let bits = 0;
  for (const s of merged) {
    const l = encodedLength(s.mode, s.bytes.length, cc(s.mode));
    if (l < 0) return undefined;
    bits += l;
  }
  const single = encodedLength(widest, data.length, cc(widest));
  if (single < 0) return undefined;
  if (single <= bits) return { segments: [{ mode: widest, bytes: data }], bits: single };
  return { segments: merged, bits };
}

function appendSegment(bb: BitBuffer, seg: Segment, ver: number): void {
  bb.append(seg.mode.bits, 4);
  bb.append(seg.bytes.length, charCountBits(seg.mode, ver));
  const text = String.fromCharCode(...seg.bytes);
  if (seg.mode === NUMERIC) {
    for (let i = 0; i < text.length; ) {
      const n = Math.min(text.length - i, 3);
      bb.append(parseInt(text.substring(i, i + n), 10), n * 3 + 1);
      i += n;
    }
  } else if (seg.mode === ALPHANUMERIC) {
    let i: number;
    for (i = 0; i + 2 <= text.length; i += 2) {
      bb.append(ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)) * 45 + ALPHANUMERIC_CHARSET.indexOf(text.charAt(i + 1)), 11);
    }
    if (i < text.length) bb.append(ALPHANUMERIC_CHARSET.indexOf(text.charAt(i)), 6);
  } else {
    for (const b of seg.bytes) bb.append(b, 8);
  }
}

/** Encodes text (UTF-8) as a QR code of the given level; throws if it is too long for version 40. */
export function encodeText(text: string, ecc: EccLevel, forceMask?: number): QrCode {
  return encodeBytes(new TextEncoder().encode(text), ecc, forceMask);
}

/** Encodes bytes; `forceMask` (0–7) skips the mask choice (for tests). */
export function encodeBytes(data: Uint8Array, ecc: EccLevel, forceMask?: number): QrCode {
  if (data.length === 0) throw new Error("qr: no data to encode");
  // The three ranges of char count field widths: versions 1–9, 10–26, 27–40.
  for (const [lo, hi] of [[1, 9], [10, 26], [27, 40]] as const) {
    const segs = makeSegments(data, lo);
    if (!segs) continue;
    for (let version = lo; version <= hi; version++) {
      const capacity = numDataCodewords(version, ecc) * 8;
      if (segs.bits > capacity) continue;
      const bb = new BitBuffer();
      for (const s of segs.segments) appendSegment(bb, s, version);
      bb.append(0, Math.min(4, capacity - bb.bits.length));
      bb.append(0, (8 - (bb.bits.length % 8)) % 8);
      for (let pad = 0xec; bb.bits.length < capacity; pad ^= 0xec ^ 0x11) bb.append(pad, 8);
      const codewords: number[] = new Array(bb.bits.length / 8).fill(0);
      bb.bits.forEach((b, i) => {
        codewords[i >>> 3]! |= b << (7 - (i & 7));
      });
      return build(version, ecc, codewords, forceMask);
    }
  }
  throw new Error("qr: data too long");
}

// ---------------------------------------------------------------------------
// Reed–Solomon over GF(2^8) with the polynomial 0x11D.

function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i]! ^= rsMultiply(coef, factor)));
  }
  return result;
}

function addEccAndInterleave(version: number, ecc: EccLevel, data: number[]): number[] {
  const e = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e]![version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Module placement.

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const pos = this.alignmentPositions();
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.drawAlignment(pos[i]!, pos[j]!);
      }
    }
    this.drawFormatBits("L", 0); // placeholder, overwritten after masking
    this.drawVersion();
  }

  drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  drawFormatBits(ecc: EccLevel, mask: number): void {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true); // the dark module
  }

  drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawCodewords(data: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.isFunction[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  // The mask penalty (ISO 18004 §7.8.3, as the reference scores it): runs of 6 or more
  // modules of one colour in a row or column score 4 + 1 per further module; each 2×2 block
  // of one colour 3; each 1:1:3:1:1 pattern with 4 light modules before or after it (the
  // edge counting as light) 40; and 10 per full 5 % that dark modules deviate from half.
  penalty(): number {
    const size = this.size;
    const get = (x: number, y: number) => this.modules[y]![x]!;
    let p1 = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let last = pass === 0 ? get(a, 0) : get(0, a);
        let count = 1;
        for (let b = 1; b < size; b++) {
          const v = pass === 0 ? get(a, b) : get(b, a);
          if (v !== last) {
            count = 1;
            last = v;
          } else {
            count++;
            if (count === 6) p1 += 3 + 1;
            else if (count > 6) p1++;
          }
        }
      }
    }
    let p2 = 0;
    for (let y = 1; y < size; y++) {
      for (let x = 1; x < size; x++) {
        const c = get(x, y);
        if (c === get(x - 1, y) && c === get(x, y - 1) && c === get(x - 1, y - 1)) p2 += 3;
      }
    }
    let p3 = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let buf = 0;
        for (let b = 0; b < size; b++) {
          buf = (buf << 1) & 0xffff;
          if (pass === 0 ? get(b, a) : get(a, b)) buf |= 1;
          const w = buf & 0x7ff;
          if (w === 0x05d || w === 0x5d0) {
            p3 += 40;
            buf = 0xff;
          } else if (b === size - 1 && (buf & 0x7f) === 0x5d) {
            p3 += 40;
            buf = 0xff;
          }
        }
      }
    }
    const total = size * size;
    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const dev = Math.abs(Math.floor(total / 2) - dark);
    const p4 = 10 * Math.floor(dev / Math.floor(total / 20));
    return p1 + p2 + p3 + p4;
  }
}

function build(version: number, ecc: EccLevel, dataCodewords: number[], forceMask?: number): QrCode {
  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(addEccAndInterleave(version, ecc, dataCodewords));
  let best = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    if (forceMask !== undefined) {
      best = forceMask;
      break;
    }
    grid.applyMask(m);
    grid.drawFormatBits(ecc, m);
    const p = grid.penalty();
    if (p < bestPenalty) {
      best = m;
      bestPenalty = p;
    }
    grid.applyMask(m); // undo (XOR)
  }
  grid.applyMask(best);
  grid.drawFormatBits(ecc, best);
  return { version, size: grid.size, ecc, mask: best, modules: grid.modules };
}
