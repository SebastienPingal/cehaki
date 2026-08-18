import test from "node:test";
import assert from "node:assert/strict";
import { validateRound, validateVote } from "../lib/validate.js";

process.env.KV_REST_API_URL = "https://exemple.upstash.io";
process.env.KV_REST_API_TOKEN = "jeton-de-test";
const { default: party } = await import("../api/party.js");
const { default: vote } = await import("../api/vote.js");

/** Réponse minimale façon Vercel, qui retient ce qu'on lui a donné. */
function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

/** Redis simulé : chaînes et tables de hachage, alimentées par les commandes reçues. */
function fakeRedis() {
  const strings = new Map();
  const hashes = new Map();
  const hash = (key) => hashes.get(key) || hashes.set(key, new Map()).get(key);
  globalThis.fetch = async (_url, options) => {
    const [command, key, ...args] = JSON.parse(options.body);
    const reply = (result) => new Response(JSON.stringify({ result }), { status: 200 });
    if (command === "SET") { strings.set(key, args[0]); return reply("OK"); }
    if (command === "GET") return reply(strings.get(key) ?? null);
    if (command === "HSET") { hash(key).set(args[0], args[1]); return reply(1); }
    if (command === "HEXISTS") return reply(hash(key).has(args[0]) ? 1 : 0);
    if (command === "HLEN") return reply(hash(key).size);
    if (command === "HGETALL") return reply([...hash(key)].flat());
    return reply("OK");
  };
  return { strings, hashes };
}

const round = { id: "abc123-1", trackId: "abc123", title: "Blue Monday", artists: "New Order", position: 3, total: 40, players: ["Alice", "Bob"], revealed: false, answer: "Bob" };

test("la réponse ne part pas tant que le morceau n'est pas révélé", () => {
  const checked = validateRound({ code: "AB3CD", round });
  assert.equal(checked.ok, true);
  assert.equal(checked.value.answer, "");
  const revealed = validateRound({ code: "AB3CD", round: { ...round, revealed: true } });
  assert.equal(revealed.value.answer, "Bob");
});

test("un tour sans joueur ou sans identifiant est refusé", () => {
  assert.equal(validateRound({ code: "AB3CD", round: { ...round, players: [] } }).ok, false);
  assert.equal(validateRound({ code: "AB3CD", round: { ...round, id: "a b" } }).ok, false);
  assert.equal(validateRound({ code: "bof", round }).ok, false);
});

test("un vote demande un prénom et un choix", () => {
  assert.equal(validateVote({ code: "AB3CD", roundId: "abc-1", voter: "", guess: "Bob" }).ok, false);
  assert.equal(validateVote({ code: "AB3CD", roundId: "abc-1", voter: "Alice", guess: "" }).ok, false);
  assert.deepEqual(
    validateVote({ code: "AB3CD", roundId: "abc-1", voter: "  Alice  ", guess: " Bob " }).value,
    { roundId: "abc-1", voter: "Alice", guess: "Bob" },
  );
});

test("publication d'un tour, puis vote : l'organisateur voit les votants, pas les paris", async () => {
  fakeRedis();

  const published = fakeRes();
  await party({ method: "POST", query: { code: "AB3CD" }, body: { round } }, published);
  assert.equal(published.statusCode, 200);
  assert.deepEqual(published.body.voters, []);

  const voted = fakeRes();
  await vote({ method: "POST", query: { code: "AB3CD" }, body: { roundId: round.id, voter: "Alice", guess: "Bob" } }, voted);
  assert.equal(voted.statusCode, 201);
  assert.deepEqual(voted.body.voters.map((v) => v.name), ["Alice"]);

  const read = fakeRes();
  await party({ method: "GET", query: { code: "AB3CD" } }, read);
  assert.equal(read.body.round.id, round.id);
  assert.deepEqual(read.body.voters.map((v) => v.name), ["Alice"]);
  assert.equal(JSON.stringify(read.body.voters).includes("Bob"), false, "le pari ne doit pas ressortir");
});

test("un vote sur un tour dépassé ou révélé est refusé", async () => {
  fakeRedis();
  await party({ method: "POST", query: { code: "AB3CD" }, body: { round } }, fakeRes());

  const late = fakeRes();
  await vote({ method: "POST", query: { code: "AB3CD" }, body: { roundId: "abc123-0", voter: "Alice", guess: "Bob" } }, late);
  assert.equal(late.statusCode, 409);

  await party({ method: "POST", query: { code: "AB3CD" }, body: { round: { ...round, revealed: true } } }, fakeRes());
  const closed = fakeRes();
  await vote({ method: "POST", query: { code: "AB3CD" }, body: { roundId: round.id, voter: "Alice", guess: "Bob" } }, closed);
  assert.equal(closed.statusCode, 409);
});

test("sans tour publié, le vote n'a rien à quoi se rattacher", async () => {
  fakeRedis();
  const res = fakeRes();
  await vote({ method: "POST", query: { code: "AB3CD" }, body: { roundId: "abc123-1", voter: "Alice", guess: "Bob" } }, res);
  assert.equal(res.statusCode, 409);

  const empty = fakeRes();
  await party({ method: "GET", query: { code: "AB3CD" } }, empty);
  assert.deepEqual(empty.body, { code: "AB3CD", round: null, voters: [] });
});

test("un joueur peut changer d'avis sans compter deux fois", async () => {
  fakeRedis();
  await party({ method: "POST", query: { code: "AB3CD" }, body: { round } }, fakeRes());
  await vote({ method: "POST", query: { code: "AB3CD" }, body: { roundId: round.id, voter: "Alice", guess: "Bob" } }, fakeRes());
  const again = fakeRes();
  await vote({ method: "POST", query: { code: "AB3CD" }, body: { roundId: round.id, voter: "Alice", guess: "Alice" } }, again);
  assert.deepEqual(again.body.voters.map((v) => v.name), ["Alice"]);
});

test("méthodes et codes invalides", async () => {
  fakeRedis();
  const bad = fakeRes();
  await party({ method: "GET", query: { code: "!!" } }, bad);
  assert.equal(bad.statusCode, 400);

  const wrong = fakeRes();
  await vote({ method: "GET", query: { code: "AB3CD" } }, wrong);
  assert.equal(wrong.statusCode, 405);
  assert.equal(wrong.headers.Allow, "POST");
});
