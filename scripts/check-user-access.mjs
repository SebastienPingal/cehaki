#!/usr/bin/env node
/**
 * Teste ce qu'un jeton UTILISATEUR autorise réellement, en particulier la
 * question qui décide de tout : être collaborateur d'une playlist suffit-il
 * à en lire le contenu ?
 *
 *   SPOTIFY_CLIENT_ID=… SPOTIFY_REFRESH_TOKEN=… \
 *   SPOTIFY_TEST_PLAYLIST_COLLAB=… SPOTIFY_TEST_PLAYLIST_FOREIGN=… \
 *     node scripts/check-user-access.mjs
 *
 * Le refresh token s'obtient depuis la page : espace organisateur → Diagnostic
 * → « Copier mon refresh token ». Le flow PKCE n'exige aucun client secret.
 */

const clientId = process.env.SPOTIFY_CLIENT_ID;
const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

if (!clientId || !refreshToken) {
  console.error(`Variables manquantes.

  SPOTIFY_CLIENT_ID           obligatoire
  SPOTIFY_REFRESH_TOKEN       obligatoire (page → Diagnostic → Copier mon refresh token)
  SPOTIFY_TEST_PLAYLIST_MINE      facultatif — une playlist à toi
  SPOTIFY_TEST_PLAYLIST_COLLAB    ⭐ une playlist dont tu es collaborateur
  SPOTIFY_TEST_PLAYLIST_FOREIGN   une playlist de quelqu'un d'autre, sans invitation`);
  process.exit(2);
}

const playlistId = (value) => value?.match(/playlist[:/]([A-Za-z0-9]+)/)?.[1] ?? null;

async function json(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    console.error(`❌ ${new URL(url).host} injoignable (${error.cause?.code || error.message}).`);
    console.error("   Réseau filtré ? Le fetch de Node ignore HTTP(S)_PROXY par défaut.");
    process.exit(1);
  }
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: { raw: text.slice(0, 160) } };
  }
}

const token = await json("https://accounts.spotify.com/api/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
});
if (token.status !== 200) {
  console.error(`❌ Rafraîchissement refusé (${token.status}) :`, token.body.error_description || token.body.error || token.body.raw);
  console.error("   Le refresh token a peut-être expiré : reconnecte-toi et copie-en un nouveau.");
  process.exit(1);
}
const headers = { Authorization: `Bearer ${token.body.access_token}` };
console.log("✅ Jeton utilisateur obtenu\n");

const me = await json("https://api.spotify.com/v1/me", { headers });
console.log(`Compte : ${me.body.display_name || me.body.id} (${me.body.product || "?"})\n`);

/** Lit métadonnées puis contenu, et rapporte lequel des deux passe. */
async function inspect(label, id) {
  if (!id) {
    console.log(`— ${label} : non renseignée`);
    return;
  }
  const meta = await json(`https://api.spotify.com/v1/playlists/${id}?fields=name,owner(display_name,id),collaborative,public`, { headers });
  if (meta.status !== 200) {
    console.log(`❌ ${label} : métadonnées refusées (${meta.status})`);
    return;
  }
  const { name, owner, collaborative, public: isPublic } = meta.body;
  const mine = owner?.id === me.body.id;
  console.log(`— ${label} : « ${name} » de ${owner?.display_name}`);
  console.log(`  propriétaire : ${mine ? "toi" : "quelqu'un d'autre"} · collaborative : ${collaborative} · publique : ${isPublic}`);

  const items = await json(`https://api.spotify.com/v1/playlists/${id}/items?limit=3`, { headers });
  if (items.status === 200 && (items.body.items || []).length > 0) {
    const first = items.body.items[0].item ?? items.body.items[0].track;
    console.log(`  ✅ contenu LISIBLE — 1er morceau : ${first?.name}`);
  } else {
    console.log(`  ❌ contenu refusé (${items.status}) : ${items.body?.error?.message || "réponse vide"}`);
  }
}

await inspect("Playlist à toi", playlistId(process.env.SPOTIFY_TEST_PLAYLIST_MINE));
await inspect("Playlist où tu es COLLABORATEUR ⭐", playlistId(process.env.SPOTIFY_TEST_PLAYLIST_COLLAB));
await inspect("Playlist d'autrui, sans invitation", playlistId(process.env.SPOTIFY_TEST_PLAYLIST_FOREIGN));

console.log("\n" + "─".repeat(66));
console.log("Si la ligne ⭐ est lisible, l'invitation collaborative règle tout :");
console.log("les joueurs envoient un lien, l'organisateur ne copie plus rien.");
