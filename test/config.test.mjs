import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = () => join(mkdtempSync(join(tmpdir(), "spm-")), "config.js");
const run = (env, target) =>
  execFileSync("node", ["scripts/build-config.mjs", target], { env: { ...process.env, ...env }, encoding: "utf8" });

test("injecte le Client ID de l'environnement", () => {
  const target = out();
  run({ SPOTIFY_CLIENT_ID: "18b07d61bcb74c41b0516031e79790c3" }, target);
  const written = readFileSync(target, "utf8");
  assert.match(written, /export const CLIENT_ID = "18b07d61bcb74c41b0516031e79790c3";/);
});

test("produit un module valide quand la variable est absente", () => {
  const target = out();
  run({ SPOTIFY_CLIENT_ID: "" }, target);
  assert.match(readFileSync(target, "utf8"), /export const CLIENT_ID = "";/);
});

test("refuse une valeur douteuse plutôt que de l'écrire", () => {
  assert.throws(() => run({ SPOTIFY_CLIENT_ID: 'abc"; alert(1); //' }, out()), /Command failed/);
});
