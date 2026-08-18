/** Validation partagée par l'API et la page — aucune dépendance. */

export const CODE_PATTERN = /^[A-Z0-9]{4,10}$/;
const ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;

/** Identifiant de playlist à partir d'une URL, d'un URI ou d'un ID brut. */
export function playlistIdOf(raw) {
  const value = String(raw || "").trim();
  const uri = value.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];
  const url = value.match(/playlist\/([A-Za-z0-9]+)/);
  if (url) return url[1];
  return ID_PATTERN.test(value) ? value : null;
}

/**
 * Nettoie un dépôt de joueur.
 * @returns {{ok: true, value: {name: string, playlistId: string}} | {ok: false, error: string}}
 */
export function validateSubmission({ code, name, playlist }) {
  if (!CODE_PATTERN.test(String(code || "").toUpperCase())) {
    return { ok: false, error: "Code de session invalide." };
  }
  const cleanName = String(name || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (cleanName.length < 1) {
    return { ok: false, error: "Indique ton prénom." };
  }
  const playlistId = playlistIdOf(playlist);
  if (!playlistId) {
    return { ok: false, error: "Ce lien ne ressemble pas à une playlist Spotify." };
  }
  return { ok: true, value: { name: cleanName, playlistId } };
}
