import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRound, sameRound, describeVoters, scoreVotes, scoreRound, addRoundScores, rankBoard,
} from "../src/voting.js";

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

test("un seul joueur trouve : deux points, les autres zéro", () => {
  const votes = [{ name: "Alice", guess: "Bob" }, { name: "Carole", guess: "Alice" }];
  assert.deepEqual(scoreRound(votes, "bob"), [
    { name: "Alice", right: true, points: 2 },
    { name: "Carole", right: false, points: 0 },
  ]);
});

test("plusieurs trouvent : un point chacun", () => {
  const votes = [{ name: "Alice", guess: "Bob" }, { name: "Carole", guess: "Bob" }];
  assert.deepEqual(scoreRound(votes, "Bob").map((s) => s.points), [1, 1]);
});

test("barème simple : jamais de bonus", () => {
  const votes = [{ name: "Alice", guess: "Bob" }, { name: "Carole", guess: "Alice" }];
  assert.deepEqual(scoreRound(votes, "Bob", { bonus: false }).map((s) => s.points), [1, 0]);
});

test("un tour sans bonne réponse ne rapporte rien", () => {
  const scores = scoreRound([{ name: "Alice", guess: "Carole" }], "Bob");
  assert.deepEqual(scores, [{ name: "Alice", right: false, points: 0 }]);
});

test("les points s'accumulent d'un tour à l'autre", () => {
  let board = addRoundScores({}, scoreRound([{ name: "Alice", guess: "Bob" }, { name: "Carole", guess: "Alice" }], "Bob"));
  board = addRoundScores(board, scoreRound([{ name: "Alice", guess: "Bob" }, { name: "Carole", guess: "Bob" }], "Bob"));
  assert.deepEqual(board, {
    Alice: { points: 3, right: 2, votes: 2 },
    Carole: { points: 1, right: 1, votes: 2 },
  });
});

test("classement : points, puis bonnes réponses, puis alphabétique ; égalité partagée", () => {
  const board = {
    Bob: { points: 3, right: 2, votes: 4 },
    Alice: { points: 5, right: 3, votes: 4 },
    Chloé: { points: 3, right: 2, votes: 4 },
    Dan: { points: 0, right: 0, votes: 2 },
  };
  assert.deepEqual(rankBoard(board).map((row) => [row.rank, row.name]), [
    [1, "Alice"], [2, "Bob"], [2, "Chloé"], [4, "Dan"],
  ]);
});
