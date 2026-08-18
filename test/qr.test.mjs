import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeQr, qrToSvg } from "../src/qr.js";

const digest = (text) =>
  createHash("sha256").update(encodeQr(text).map((row) => row.join("")).join("\n")).digest("hex").slice(0, 16);

// Empreintes relevées après comparaison module par module avec la bibliothèque
// de référence `qrcode` (Python) et relecture par un décodeur (OpenCV).
const GOLDEN = {
  "hello world": ["851bd1031e2539fc", 21],
  "https://open.spotify.com/playlist/3bjzq4fIAW44vr4WnRDluh": ["4fddf4579483e82a", 33],
  "https://sebastienpingal.github.io/cehaki/#/joueur": ["fdf2e14c5d6ce528", 33],
};

test("matrices conformes aux empreintes de référence", () => {
  for (const [text, [hash, size]] of Object.entries(GOLDEN)) {
    assert.equal(encodeQr(text).length, size, `taille pour ${text}`);
    assert.equal(digest(text), hash, `empreinte pour ${text}`);
  }
});

test("la version grandit avec la charge utile", () => {
  const sizes = [10, 100, 200].map((n) => encodeQr("x".repeat(n)).length);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
  assert.equal(new Set(sizes).size, 3);
});

test("motifs de détection présents aux trois coins", () => {
  const modules = encodeQr("https://example.org/test");
  const size = modules.length;
  for (const [row, col] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(modules[row][col], 1, "coin extérieur noir");
    assert.equal(modules[row + 1][col + 1], 0, "anneau blanc");
    assert.equal(modules[row + 3][col + 3], 1, "centre noir");
  }
});

test("ligne de synchronisation alternée", () => {
  const modules = encodeQr("timing");
  for (let i = 8; i < modules.length - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0);
  }
});

test("module noir permanent jamais recouvert", () => {
  const modules = encodeQr("dark module");
  assert.equal(modules[modules.length - 8][8], 1);
});

test("au-delà de la version 10, on refuse plutôt que de produire un QR invalide", () => {
  assert.throws(() => encodeQr("z".repeat(300)), /trop long/);
});

test("SVG autonome, sans ressource externe", () => {
  const svg = qrToSvg("https://example.org", { size: 200 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="200"/);
  assert.match(svg, /<path d="M/);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/);
});
