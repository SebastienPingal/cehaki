import test from "node:test";
import assert from "node:assert/strict";
import { buildAnswerKey, describeNowPlaying, nextPollDelay } from "../src/nowplaying.js";

const key = buildAnswerKey([
  { id: "t1", sourceLabel: "Alice", position: 1 },
  { id: "t2", sourceLabel: "Bob", position: 2 },
]);

const playback = (over = {}) => ({
  is_playing: true,
  progress_ms: 30_000,
  currently_playing_type: "track",
  item: { id: "t2", name: "Blue Monday", duration_ms: 200_000, artists: [{ name: "New Order" }] },
  ...over,
});

test("rien en cours", () => {
  assert.equal(describeNowPlaying(null, key).state, "idle");
  assert.equal(describeNowPlaying({ item: null }, key).state, "idle");
});

test("podcast ou publicité", () => {
  assert.equal(describeNowPlaying(playback({ currently_playing_type: "episode" }), key).state, "other");
});

test("morceau du mix : propriétaire et position", () => {
  const now = describeNowPlaying(playback(), key);
  assert.equal(now.state, "playing");
  assert.equal(now.owner, "Bob");
  assert.equal(now.position, 2);
  assert.equal(now.total, 2);
  assert.equal(now.artists, "New Order");
  assert.ok(now.known);
});

test("morceau hors du mix", () => {
  const now = describeNowPlaying(playback({ item: { id: "zz", name: "X", artists: [] } }), key);
  assert.equal(now.known, false);
  assert.equal(now.owner, "");
});

test("lecture en pause", () => {
  assert.equal(describeNowPlaying(playback({ is_playing: false }), key).state, "paused");
});

test("le sondage vise la fin du morceau, borné", () => {
  assert.equal(nextPollDelay(describeNowPlaying(playback(), key)), 10_000);
  const almostDone = describeNowPlaying(playback({ progress_ms: 199_000 }), key);
  assert.equal(nextPollDelay(almostDone), 3000);
  assert.equal(nextPollDelay(describeNowPlaying(null, key)), 10_000);
});
