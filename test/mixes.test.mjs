import test from "node:test";
import assert from "node:assert/strict";
import { createEntry, insertEntry, removeEntry, compareSources, describeFreshness } from "../src/mixes.js";

const entry = createEntry({
  playlist: { id: "pl1", url: "https://open.spotify.com/playlist/pl1" },
  name: "Blind test du 12",
  mix: {
    totalMs: 400_000,
    tracks: [
      { id: "t1", name: "A", artists: "X", durationMs: 200_000, sourceLabel: "Alice", position: 1, uri: "spotify:track:t1" },
      { id: "t2", name: "B", artists: "Y", durationMs: 200_000, sourceLabel: "Bob", position: 2, uri: "spotify:track:t2" },
    ],
  },
  sources: [{ id: "s1", label: "Alice" }, { id: "s2", label: "Bob" }],
  settings: { mode: "count" },
  now: 1_700_000_000_000,
});

test("la fiche retient le corrigé, les sources et le lien", () => {
  assert.equal(entry.id, "pl1");
  assert.equal(entry.tracks.length, 2);
  assert.equal(entry.tracks[0].sourceLabel, "Alice");
  assert.deepEqual(entry.sources.map((s) => s.id), ["s1", "s2"]);
  // pas d'URI : le corrigé n'a pas besoin de rejouer les morceaux.
  assert.equal(entry.tracks[0].uri, undefined);
});

test("une nouvelle playlist reçue rend le mix dépassé", () => {
  const current = [{ id: "s1", label: "Alice" }, { id: "s2", label: "Bob" }, { id: "s3", label: "Chloé" }];
  const diff = compareSources(entry, current);
  assert.equal(diff.upToDate, false);
  assert.deepEqual(diff.added.map((s) => s.label), ["Chloé"]);

  const { text } = describeFreshness(entry, current);
  assert.match(text, /Chloé/);
  assert.match(text, /⚠️/);
});

test("mix à jour quand les sources n'ont pas bougé", () => {
  const current = [{ id: "s2", label: "Bob" }, { id: "s1", label: "Alice" }];
  assert.equal(compareSources(entry, current).upToDate, true);
  assert.match(describeFreshness(entry, current).text, /à jour$/);
});

test("une source retirée de l'écran ne périme pas le mix", () => {
  const diff = compareSources(entry, [{ id: "s1", label: "Alice" }]);
  assert.equal(diff.upToDate, true);
  assert.deepEqual(diff.removed.map((s) => s.id), ["s2"]);
});

test("historique : plus récent en tête, sans doublon, borné", () => {
  const other = { ...entry, id: "pl2" };
  let list = insertEntry([entry], other);
  assert.deepEqual(list.map((e) => e.id), ["pl2", "pl1"]);
  list = insertEntry(list, { ...entry, name: "rejoué" });
  assert.deepEqual(list.map((e) => e.id), ["pl1", "pl2"]);
  assert.equal(list[0].name, "rejoué");
  assert.equal(insertEntry(list, { ...entry, id: "pl3" }, 2).length, 2);
  assert.deepEqual(removeEntry(list, "pl1").map((e) => e.id), ["pl2"]);
});
