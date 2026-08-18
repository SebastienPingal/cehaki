import { test } from "node:test";
import assert from "node:assert/strict";
import { mix, buildPools, toCsv, formatDuration } from "../src/mixer.js";

const player = (key, count, offset = 0) => ({
  key,
  label: key,
  tracks: Array.from({ length: count }, (_, i) => ({
    id: `${key}-${i + offset}`,
    uri: `spotify:track:${key}-${i + offset}`,
    name: `Titre ${i}`,
    artists: "Artiste",
    durationMs: 180_000,
  })),
});

test("respecte le nombre de morceaux demandé", () => {
  const result = mix({
    sources: [player("a", 50), player("b", 50), player("c", 50)],
    mode: "count",
    target: 30,
    balance: "equal",
  });
  assert.equal(result.tracks.length, 30);
});

test("répartition équitable entre joueurs de tailles différentes", () => {
  const result = mix({
    sources: [player("a", 100), player("b", 20), player("c", 40)],
    mode: "count",
    target: 30,
    balance: "equal",
  });
  for (const source of result.perSource) assert.equal(source.count, 10);
});

test("répartition proportionnelle suit la taille des playlists", () => {
  const result = mix({
    sources: [player("a", 80), player("b", 20)],
    mode: "count",
    target: 20,
    balance: "proportional",
  });
  const counts = Object.fromEntries(result.perSource.map((s) => [s.key, s.count]));
  assert.equal(counts.a, 16);
  assert.equal(counts.b, 4);
});

test("s'arrête à la durée demandée", () => {
  const result = mix({
    sources: [player("a", 50), player("b", 50)],
    mode: "duration",
    target: 30 * 60_000,
    balance: "equal",
  });
  assert.equal(result.tracks.length, 10);
  assert.equal(result.totalMs, 30 * 60_000);
});

test("ne dépasse jamais le stock disponible", () => {
  const result = mix({
    sources: [player("a", 3), player("b", 2)],
    mode: "count",
    target: 100,
    balance: "equal",
  });
  assert.equal(result.tracks.length, 5);
});

test("écarte les morceaux présents dans plusieurs playlists", () => {
  const a = player("a", 5);
  const b = player("b", 5);
  b.tracks[0] = { ...a.tracks[0] }; // morceau commun
  const { pools, sharedCount } = buildPools([a, b], true);
  assert.equal(sharedCount, 1);
  assert.equal(pools[0].tracks.length, 4);
  assert.equal(pools[1].tracks.length, 4);
});

test("évite deux morceaux de suite du même joueur", () => {
  const result = mix({
    sources: [player("a", 30), player("b", 30), player("c", 30)],
    mode: "count",
    target: 30,
    balance: "equal",
    spread: true,
  });
  for (let i = 1; i < result.tracks.length; i++) {
    assert.notEqual(result.tracks[i].sourceKey, result.tracks[i - 1].sourceKey);
  }
});

test("chaque morceau n'apparaît qu'une fois", () => {
  const result = mix({
    sources: [player("a", 40), player("b", 40)],
    mode: "count",
    target: 60,
    balance: "equal",
  });
  assert.equal(new Set(result.tracks.map((t) => t.id)).size, result.tracks.length);
});

test("CSV et durée formatés", () => {
  assert.equal(formatDuration(185_000), "3:05");
  assert.equal(formatDuration(3_900_000), "1 h 05");
  const csv = toCsv([{ position: 1, name: 'Le "vrai" titre', artists: "X", durationMs: 60_000, sourceLabel: "Alice" }]);
  assert.match(csv, /"Le ""vrai"" titre"/);
  assert.match(csv, /"Alice"/);
});
