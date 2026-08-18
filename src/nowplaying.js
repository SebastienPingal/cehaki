// Lecture en cours : logique pure (aucun accès réseau), testable isolément.

/**
 * Corrigé indexé par identifiant de morceau, pour retrouver le propriétaire
 * d'un titre en O(1) pendant la soirée.
 * @param {Array<{id:string,name:string,artists:string,sourceLabel:string,position:number}>} tracks
 */
export function buildAnswerKey(tracks) {
  const byId = new Map();
  for (const track of tracks) {
    if (!byId.has(track.id)) {
      byId.set(track.id, { owner: track.sourceLabel, position: track.position });
    }
  }
  return { byId, total: tracks.length };
}

/**
 * Traduit la réponse de `/me/player/currently-playing` en un état affichable.
 * @param {object|null} playback réponse Spotify (null si 204 : rien en cours)
 * @param {{byId:Map,total:number}} key corrigé du mix
 */
export function describeNowPlaying(playback, key) {
  if (!playback || !playback.item) {
    return { state: "idle", message: "Rien ne joue sur ton compte Spotify pour l'instant." };
  }
  const item = playback.item;
  if (playback.currently_playing_type && playback.currently_playing_type !== "track") {
    return { state: "other", message: "Ce n'est pas un morceau (podcast ou publicité)." };
  }

  const match = key.byId.get(item.id) || null;
  return {
    state: playback.is_playing === false ? "paused" : "playing",
    title: item.name || "",
    artists: (item.artists || []).map((artist) => artist.name).join(", "),
    id: item.id,
    owner: match ? match.owner : "",
    position: match ? match.position : 0,
    total: key.total,
    known: Boolean(match),
    progressMs: playback.progress_ms || 0,
    durationMs: item.duration_ms || 0,
  };
}

/** Délai avant le prochain sondage : on vise la fin du morceau, sans descendre trop bas. */
export function nextPollDelay(now, { min = 3000, max = 10_000 } = {}) {
  if (!now || (now.state !== "playing" && now.state !== "paused")) return max;
  if (now.state === "paused") return max;
  const remaining = now.durationMs - now.progressMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return min;
  return Math.min(max, Math.max(min, remaining + 500));
}
