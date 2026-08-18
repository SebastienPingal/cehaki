import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaylistId, parseSubmissionLine } from "../src/spotify.js";

test("reconnaît les différentes formes de lien", () => {
  const id = "3bjzq4fIAW44vr4WnRDluh";
  assert.equal(parsePlaylistId(`https://open.spotify.com/playlist/${id}`), id);
  assert.equal(parsePlaylistId(`https://open.spotify.com/playlist/${id}?si=abc123`), id);
  assert.equal(parsePlaylistId(`spotify:playlist:${id}`), id);
  assert.equal(parsePlaylistId(id), id);
  assert.equal(parsePlaylistId("https://open.spotify.com/album/xyz"), null);
  assert.equal(parsePlaylistId(""), null);
});

test("un lien seul ne produit pas d'étiquette parasite", () => {
  const line = "https://open.spotify.com/playlist/3bjzq4fIAW44vr4WnRDluh";
  assert.deepEqual(parseSubmissionLine(line), { id: "3bjzq4fIAW44vr4WnRDluh", label: "" });
});

test("extrait le prénom des envois des joueurs", () => {
  const id = "3bjzq4fIAW44vr4WnRDluh";
  const link = `https://open.spotify.com/playlist/${id}`;
  for (const line of [`Alice — ${link}`, `Alice - ${link}`, `Alice : ${link}`, `Marie-Jo — ${link}`]) {
    const parsed = parseSubmissionLine(line);
    assert.equal(parsed.id, id, line);
    assert.match(parsed.label, /^(Alice|Marie-Jo)$/, line);
  }
});

test("accepte un URI Spotify précédé d'un prénom", () => {
  assert.deepEqual(parseSubmissionLine("Bob — spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"), {
    id: "37i9dQZF1DXcBWIGoYBM5M",
    label: "Bob",
  });
});

test("rejette ce qui ne contient aucune playlist", () => {
  assert.equal(parseSubmissionLine("Alice — coucou"), null);
  assert.equal(parseSubmissionLine("   "), null);
});
