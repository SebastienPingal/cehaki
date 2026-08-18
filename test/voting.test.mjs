import test from "node:test";
import assert from "node:assert/strict";
import { buildRound, sameRound, describeVoters, scoreVotes } from "../src/voting.js";

const entry = { sources: [{ label: "Alice" }, { label: "Bob" }, { label: "alice" }, { label: "" }] };
const now = { id: "t7", title: "Blue Monday", artists: "New Order", owner: "Bob", position: 3, total: 40, known: true };

test("le tour cache la réponse tant que le morceau n'est pas révélé", () => {
  const round = buildRound({ entry, now, sequence: 2 });
  assert.equal(round.id, "t7-2");
  assert.equal(round.answer, "");
  assert.equal(round.revealed, false);
  assert.deepEqual(round.players, ["Alice", "Bob"]); // doublons et étiquettes vides écartés
});

test("le tour porte la réponse une fois révélé", () => {
  const round = buildRound({ entry, now, sequence: 2, revealed: true });
  assert.equal(round.answer, "Bob");
  assert.equal(round.revealed, true);
});

test("deux passages du même titre sont deux tours distincts", () => {
  assert.notEqual(buildRound({ entry, now, sequence: 1 }).id, buildRound({ entry, now, sequence: 2 }).id);
});

test("un tour révélé n'est plus le même tour", () => {
  const round = buildRound({ entry, now, sequence: 1 });
  assert.ok(sameRound(round, buildRound({ entry, now, sequence: 1 })));
  assert.ok(!sameRound(round, buildRound({ entry, now, sequence: 1, revealed: true })));
  assert.ok(!sameRound(round, null));
});

test("qui a voté, qui manque", () => {
  const status = describeVoters([{ name: "alice" }, { name: "Carole" }], ["Alice", "Bob"]);
  assert.deepEqual(status.waiting, ["Bob"]);
  assert.deepEqual(status.extra, ["Carole"]);
  assert.equal(status.complete, false);
  assert.equal(status.text, "1 vote sur 2");
});

test("tout le monde a voté", () => {
  const status = describeVoters([{ name: "Alice" }, { name: "Bob " }], ["Alice", "Bob"]);
  assert.equal(status.complete, true);
  assert.equal(status.text, "2 votes sur 2");
});

test("score : seuls les morceaux révélés comptent", () => {
  const score = scoreVotes([
    { guess: "Alice", answer: "alice" },
    { guess: "Bob", answer: "Alice" },
    { guess: "Bob", answer: "" },
  ]);
  assert.deepEqual(score, { right: 1, judged: 2, total: 3 });
});
