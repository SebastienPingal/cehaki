import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { validateSubmission, playlistIdOf } from "../lib/validate.js";

process.env.KV_REST_API_URL = "https://exemple.upstash.io";
process.env.KV_REST_API_TOKEN = "jeton-de-test";
const { default: handler } = await import("../api/session.js");

const ID = "3bjzq4fIAW44vr4WnRDluh";

/** Réponse minimale façon Vercel, qui retient ce qu'on lui a donné. */
function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

/** Redis simulé : une liste par clé, alimentée par les commandes reçues. */
function fakeRedis() {
  const lists = new Map();
  globalThis.fetch = async (_url, options) => {
    const [command, key, ...args] = JSON.parse(options.body);
    const list = lists.get(key) || [];
    if (command === "RPUSH") {
      list.push(args[0]);
      lists.set(key, list);
      return new Response(JSON.stringify({ result: list.length }), { status: 200 });
    }
    if (command === "LRANGE") return new Response(JSON.stringify({ result: list }), { status: 200 });
    return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
  };
  return lists;
}

test("valide les dépôts corrects", () => {
  const checked = validateSubmission({ code: "AB3CD", name: "  Alice   Martin ", playlist: `https://open.spotify.com/playlist/${ID}?si=x` });
  assert.deepEqual(checked, { ok: true, value: { name: "Alice Martin", playlistId: ID } });
});

test("rejette code, prénom ou lien manquants", () => {
  assert.match(validateSubmission({ code: "ab", name: "Alice", playlist: ID }).error, /session invalide/);
  assert.match(validateSubmission({ code: "AB3CD", name: "  ", playlist: ID }).error, /prénom/);
  assert.match(validateSubmission({ code: "AB3CD", name: "Alice", playlist: "coucou" }).error, /playlist Spotify/);
});

test("tronque un prénom trop long au lieu de le refuser", () => {
  const checked = validateSubmission({ code: "AB3CD", name: "x".repeat(120), playlist: ID });
  assert.equal(checked.value.name.length, 40);
});

test("extrait l'identifiant de toutes les formes de lien", () => {
  assert.equal(playlistIdOf(`spotify:playlist:${ID}`), ID);
  assert.equal(playlistIdOf(`https://open.spotify.com/playlist/${ID}?si=abc`), ID);
  assert.equal(playlistIdOf("https://open.spotify.com/album/xyz"), null);
});

test("un dépôt POST est enregistré puis relu par GET", async () => {
  fakeRedis();
  const post = fakeRes();
  await handler({ method: "POST", query: { code: "ab3cd" }, body: { name: "Alice", playlist: `https://open.spotify.com/playlist/${ID}` } }, post);
  assert.equal(post.statusCode, 201);

  const get = fakeRes();
  await handler({ method: "GET", query: { code: "AB3CD" } }, get);
  assert.equal(get.statusCode, 200);
  assert.equal(get.body.submissions.length, 1);
  assert.equal(get.body.submissions[0].name, "Alice");
  assert.equal(get.body.submissions[0].playlistId, ID);
});

test("le corps JSON transmis en texte est accepté", async () => {
  fakeRedis();
  const res = fakeRes();
  await handler({ method: "POST", query: { code: "AB3CD" }, body: JSON.stringify({ name: "Bob", playlist: ID }) }, res);
  assert.equal(res.statusCode, 201);
});

test("refuse un code de session mal formé", async () => {
  fakeRedis();
  const res = fakeRes();
  await handler({ method: "GET", query: { code: "a" } }, res);
  assert.equal(res.statusCode, 400);
});

test("refuse les méthodes non prévues", async () => {
  fakeRedis();
  const res = fakeRes();
  await handler({ method: "DELETE", query: { code: "AB3CD" } }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET, POST");
});

test("signale clairement l'absence de stockage", () => {
  // Environnement vierge : le module lit ses variables au chargement, il faut
  // donc un processus séparé pour observer ce cas.
  const script = `
    const { default: handler } = await import("./api/session.js");
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ method: "GET", query: { code: "AB3CD" } }, res);
    console.log(JSON.stringify({ status: res.code, error: res.body.error }));
  `;
  const env = { ...process.env };
  delete env.KV_REST_API_URL;
  delete env.KV_REST_API_TOKEN;
  delete env.UPSTASH_REDIS_REST_URL;
  delete env.UPSTASH_REDIS_REST_TOKEN;

  const out = execFileSync("node", ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  const result = JSON.parse(out);
  assert.equal(result.status, 503);
  assert.match(result.error, /Upstash/);
});
