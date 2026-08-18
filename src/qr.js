// Générateur de QR code autonome — mode octet, correction d'erreur niveau M,
// versions 1 à 10. Aucune dépendance : la page interdit les scripts externes.

// [codewords de données, codewords de correction par bloc, [nb blocs × codewords] …]
const VERSIONS = {
  1: { data: 16, ec: 10, blocks: [[1, 16]] },
  2: { data: 28, ec: 16, blocks: [[1, 28]] },
  3: { data: 44, ec: 26, blocks: [[1, 44]] },
  4: { data: 64, ec: 18, blocks: [[2, 32]] },
  5: { data: 86, ec: 24, blocks: [[2, 43]] },
  6: { data: 108, ec: 16, blocks: [[4, 27]] },
  7: { data: 124, ec: 18, blocks: [[4, 31]] },
  8: { data: 154, ec: 22, blocks: [[2, 38], [2, 39]] },
  9: { data: 182, ec: 22, blocks: [[3, 36], [2, 37]] },
  10: { data: 216, ec: 26, blocks: [[4, 43], [1, 44]] },
};

const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* ---------------------------------------------------- arithmétique GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data, ecLength) {
  const generator = generatorPoly(ecLength);
  const remainder = new Array(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < generator.length - 1; i++) {
        remainder[i] ^= mul(generator[i + 1], factor);
      }
    }
  }
  return remainder;
}

/* ------------------------------------------------------- codes correcteurs */

function bchFormat(value) {
  let remainder = value << 10;
  for (let i = 14; i >= 10; i--) {
    if (remainder & (1 << i)) remainder ^= 0x537 << (i - 10);
  }
  return ((value << 10) | remainder) ^ 0x5412;
}

function bchVersion(version) {
  let remainder = version << 12;
  for (let i = 17; i >= 12; i--) {
    if (remainder & (1 << i)) remainder ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | remainder;
}

/* ------------------------------------------------------------- encodage */

function encodeData(bytes, version) {
  const { data: dataCodewords, ec: ecPerBlock, blocks } = VERSIONS[version];
  const lengthBits = version >= 10 ? 16 : 8;

  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // mode octet
  push(bytes.length, lengthBits);
  for (const byte of bytes) push(byte, 8);

  const capacity = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0); // terminateur
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  const padding = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCodewords; i++) codewords.push(padding[i % 2]);

  // Découpage en blocs, puis entrelacement données + correction.
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, size] of blocks) {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(errorCorrection(block, ecPerBlock));
    }
  }

  const result = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

/* -------------------------------------------------------------- matrice */

function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const place = (row, col, value) => {
    modules[row][col] = value;
    reserved[row][col] = true;
  };

  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        place(y, x, dark ? 1 : 0);
      }
    }
  };

  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const value = i % 2 === 0 ? 1 : 0;
    place(6, i, value);
    place(i, 6, value);
  }

  const centers = ALIGNMENT[version];
  const last = centers[centers.length - 1];
  for (const row of centers) {
    for (const col of centers) {
      // Seuls les trois coins occupés par les motifs de détection sont omis ;
      // ceux posés sur les lignes de synchronisation, eux, sont obligatoires.
      const onFinder = (row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6);
      if (onFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          place(row + r, col + c, dark ? 1 : 0);
        }
      }
    }
  }

  place(size - 8, 8, 1); // module toujours noir

  // Zones d'information réservées (remplies après le masquage).
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = true;
        reserved[size - 11 + j][i] = true;
      }
    }
  }

  // Parcours en zigzag depuis le coin bas-droit.
  const maskFn = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ][mask];

  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // la colonne 6 est celle du motif de synchronisation
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        modules[row][col] = maskFn(row, col) ? bit ^ 1 : bit;
      }
    }
    upward = !upward;
  }

  // Information de format (niveau M = 0b00) et de version.
  const format = bchFormat((0b00 << 3) | mask);
  const formatBit = (i) => (format >> (14 - i)) & 1; // bit 0 = poids fort
  for (let i = 0; i <= 5; i++) modules[8][i] = formatBit(i);
  modules[8][7] = formatBit(6);
  modules[8][8] = formatBit(7);
  modules[7][8] = formatBit(8);
  for (let i = 9; i <= 14; i++) modules[14 - i][8] = formatBit(i);
  for (let i = 0; i <= 6; i++) modules[size - 1 - i][8] = formatBit(i);
  for (let i = 7; i <= 14; i++) modules[8][size - 15 + i] = formatBit(i);
  modules[size - 8][8] = 1; // module toujours noir, jamais recouvert

  if (version >= 7) {
    const info = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      modules[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
      modules[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
    }
  }

  return modules;
}

/* --------------------------------------------------- choix du masque */

function penalty(modules) {
  const size = modules.length;
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) total += run - 2;
        run = 1;
      }
    }
    if (run >= 5) total += run - 2;
    return total;
  };

  for (let i = 0; i < size; i++) {
    score += runScore(modules[i]);
    score += runScore(modules.map((row) => row[i]));
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const sum = modules[r][c] + modules[r][c + 1] + modules[r + 1][c] + modules[r + 1][c + 1];
      if (sum === 0 || sum === 4) score += 3;
    }
  }

  const patterns = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  const scanLine = (line) => {
    for (let i = 0; i + 11 <= line.length; i++) {
      for (const pattern of patterns) {
        if (pattern.every((value, j) => line[i + j] === value)) score += 40;
      }
    }
  };
  for (let i = 0; i < size; i++) {
    scanLine(modules[i]);
    scanLine(modules.map((row) => row[i]));
  }

  const dark = modules.flat().reduce((sum, value) => sum + value, 0);
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/**
 * Matrice de modules (0/1) encodant `text`.
 * @returns {number[][]}
 */
export function encodeQr(text, { mask: forcedMask = null } = {}) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = Number(
    Object.keys(VERSIONS).find((v) => {
      const overhead = Number(v) >= 10 ? 20 : 12;
      return bytes.length * 8 + overhead <= VERSIONS[v].data * 8;
    }),
  );
  if (!version) throw new Error("Contenu trop long pour un QR code de version 10.");

  const codewords = encodeData(bytes, version);
  if (forcedMask !== null) return buildMatrix(version, codewords, forcedMask);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = buildMatrix(version, codewords, mask);
    const score = penalty(modules);
    if (!best || score < best.score) best = { modules, score };
  }
  return best.modules;
}

/** QR code en SVG autonome, `quiet` modules de marge blanche. */
export function qrToSvg(text, { size = 220, quiet = 4 } = {}) {
  const modules = encodeQr(text);
  const count = modules.length + quiet * 2;
  const path = [];
  for (let r = 0; r < modules.length; r++) {
    for (let c = 0; c < modules.length; c++) {
      if (modules[r][c]) path.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${count} ${count}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="${count}" height="${count}" fill="#ffffff"/>`
    + `<path d="${path.join("")}" fill="#000000"/></svg>`;
}
