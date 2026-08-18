#!/usr/bin/env node
/**
 * Vérifie si un token d'application (flow Client Credentials, sans utilisateur
 * connecté) permet de lire le contenu d'une playlist publique dont on n'est pas
 * propriétaire — ce que le flow utilisateur refuse depuis la migration 2026.
 *
 *   SPOTIFY_CLIENT_ID=… SPOTIFY_CLIENT_SECRET=… \
 *     node scripts/check-client-credentials.mjs <lien-playlist-d-un-ami>
 */

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const rawUrl = process.argv[2];

if (!clientId || !clientSecret || !rawUrl) {
  console.error(`Usage :
  SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy \\
    node scripts/check-client-credentials.mjs https://open.spotify.com/playlist/…

Le client secret se trouve dans les réglages de ton app sur developer.spotify.com.
Choisis la playlist publique de QUELQU'UN D'AUTRE — c'est tout l'enjeu du test.`);
  process.exit(2);
}

const playlistId = rawUrl.match(/playlist[:/]([A-Za-z0-9]+)/)?.[1];
if (!playlistId) {
  console.error(`Lien de playlist non reconnu : ${rawUrl}`);
  process.exit(2);
}

if (playlistId.startsWith("37i9")) {
  console.warn("⚠️  Playlist éditoriale Spotify (37i9…) : elle renvoie 404 aux apps récentes.");
  console.warn("   Prends plutôt la playlist d'une vraie personne.\n");
}

const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
const tokenData = await tokenResponse.json();
if (!tokenResponse.ok) {
  console.error(`❌ Token refusé (${tokenResponse.status}) :`, tokenData.error_description || tokenData.error);
  process.exit(1);
}
console.log("✅ Token d'application obtenu\n");

const headers = { Authorization: `Bearer ${tokenData.access_token}` };

async function probe(label, path) {
  const response = await fetch(`https://api.spotify.com/v1${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.log(`❌ ${label} → ${response.status} ${body?.error?.message || ""}`);
    return null;
  }
  console.log(`✅ ${label} → 200`);
  return body;
}

const meta = await probe("Métadonnées de la playlist", `/playlists/${playlistId}?fields=name,owner(display_name)`);
if (meta) console.log(`   « ${meta.name} » de ${meta.owner?.display_name || "?"}`);

const items = await probe("Morceaux via /items  ⭐", `/playlists/${playlistId}/items?limit=3`);
const legacy = await probe("Morceaux via /tracks (déprécié)", `/playlists/${playlistId}/tracks?limit=3`);

const page = items || legacy;
const sample = (page?.items || []).map((entry) => (entry.item ?? entry.track)?.name).filter(Boolean);
if (sample.length) console.log(`   Extrait : ${sample.join(", ")}`);

console.log("\n" + "─".repeat(64));
if (sample.length) {
  console.log("🎉 Un token d'application LIT les playlists publiques des autres.");
  console.log("   → on peut ajouter un petit backend et supprimer toute copie manuelle.");
} else {
  console.log("🚫 Un token d'application ne lit pas non plus le contenu des playlists d'autrui.");
  console.log("   → la restriction ne dépend pas du flow ; il faut posséder les playlists.");
}
