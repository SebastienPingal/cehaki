#!/usr/bin/env node
/**
 * Écrit `src/config.js` à partir de l'environnement, pour que la page connaisse
 * le Client ID sans qu'on ait à le saisir. Un Client ID n'est pas un secret : il
 * transite en clair dans l'URL d'autorisation. Le client SECRET, lui, ne doit
 * jamais arriver ici — la page n'en a pas besoin (flow PKCE).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const clientId = (process.env.SPOTIFY_CLIENT_ID || "").trim();
if (/[^A-Za-z0-9]/.test(clientId)) {
  console.error("SPOTIFY_CLIENT_ID contient des caractères inattendus — abandon.");
  process.exit(1);
}

const target = process.argv[2]
  || join(dirname(fileURLToPath(import.meta.url)), "..", "src", "config.js");
writeFileSync(target, `// Généré par scripts/build-config.mjs — ne pas modifier à la main.
export const CLIENT_ID = ${JSON.stringify(clientId)};
`);

console.log(clientId
  ? `Client ID injecté (${clientId.slice(0, 6)}…), la page se connectera sans saisie.`
  : "Aucun SPOTIFY_CLIENT_ID dans l'environnement : la page demandera le Client ID à l'utilisateur.");
