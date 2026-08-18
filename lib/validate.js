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

export const ROUND_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PLAYERS = 40;

const cleanText = (raw, max) => String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/**
 * Nettoie le tour publié par l'écran de soirée : le morceau en cours et les
 * joueurs entre lesquels on peut voter. La réponse n'est présente qu'une fois
 * le morceau révélé — avant, elle ne doit pas quitter l'écran de l'organisateur.
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateRound({ code, round }) {
  if (!CODE_PATTERN.test(String(code || "").toUpperCase())) {
    return { ok: false, error: "Code de session invalide." };
  }
  const source = round || {};
  if (!ROUND_PATTERN.test(String(source.id || ""))) {
    return { ok: false, error: "Identifiant de tour invalide." };
  }
  const players = (Array.isArray(source.players) ? source.players : [])
    .map((player) => cleanText(player, 40))
    .filter(Boolean)
    .slice(0, MAX_PLAYERS);
  if (players.length === 0) {
    return { ok: false, error: "Aucun joueur à départager." };
  }
  const revealed = Boolean(source.revealed);
  return {
    ok: true,
    value: {
      id: String(source.id),
      trackId: cleanText(source.trackId, 40),
      title: cleanText(source.title, 200),
      artists: cleanText(source.artists, 200),
      position: Number(source.position) || 0,
      total: Number(source.total) || 0,
      players,
      revealed,
      answer: revealed ? cleanText(source.answer, 40) : "",
    },
  };
}

/**
 * Nettoie le vote d'un joueur. Le pari lui-même n'est jamais renvoyé aux autres :
 * l'écran de soirée ne voit que le nom des votants.
 * @returns {{ok: true, value: {roundId: string, voter: string, guess: string}} | {ok: false, error: string}}
 */
export function validateVote({ code, roundId, voter, guess }) {
  if (!CODE_PATTERN.test(String(code || "").toUpperCase())) {
    return { ok: false, error: "Code de session invalide." };
  }
  if (!ROUND_PATTERN.test(String(roundId || ""))) {
    return { ok: false, error: "Identifiant de tour invalide." };
  }
  const cleanVoter = cleanText(voter, 40);
  if (!cleanVoter) return { ok: false, error: "Indique ton prénom." };
  const cleanGuess = cleanText(guess, 40);
  if (!cleanGuess) return { ok: false, error: "Choisis un joueur." };
  return { ok: true, value: { roundId: String(roundId), voter: cleanVoter, guess: cleanGuess } };
}
