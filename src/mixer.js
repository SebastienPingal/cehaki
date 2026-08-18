// Logique pure du mélange — aucun accès réseau, testable isolément.

export function shuffle(items, rng = Math.random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Prépare les réservoirs : doublons internes retirés, et si `dropShared`,
 * les morceaux présents dans plusieurs playlists sont écartés (indevinables).
 */
export function buildPools(sources, dropShared) {
  const ownersById = new Map();
  for (const source of sources) {
    for (const track of source.tracks) {
      if (!ownersById.has(track.id)) ownersById.set(track.id, new Set());
      ownersById.get(track.id).add(source.key);
    }
  }

  const shared = [];
  const pools = sources.map((source) => {
    const seen = new Set();
    const tracks = [];
    for (const track of source.tracks) {
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      if (dropShared && ownersById.get(track.id).size > 1) {
        shared.push(track.id);
        continue;
      }
      tracks.push({ ...track, sourceKey: source.key });
    }
    return { key: source.key, label: source.label, tracks };
  });

  return { pools, sharedCount: new Set(shared).size };
}

/**
 * Mélange les playlists en une seule séquence.
 * @param {object} options
 * @param {Array<{key:string,label:string,tracks:Array}>} options.sources
 * @param {"count"|"duration"} options.mode
 * @param {number} options.target nombre de morceaux, ou millisecondes
 * @param {"equal"|"proportional"} options.balance
 * @param {boolean} options.dedupe écarte les morceaux communs à plusieurs playlists
 * @param {boolean} options.spread évite deux morceaux de suite du même joueur
 */
export function mix({ sources, mode, target, balance, dedupe = true, spread = true, rng = Math.random }) {
  const { pools, sharedCount } = buildPools(sources, dedupe);
  const decks = pools
    .map((pool) => ({ ...pool, remaining: shuffle(pool.tracks, rng), taken: 0 }))
    .filter((deck) => deck.remaining.length > 0);

  const weights = new Map(
    decks.map((deck) => [deck.key, balance === "proportional" ? deck.remaining.length : 1]),
  );

  const picked = [];
  let totalMs = 0;
  let previousKey = null;

  const reached = () =>
    mode === "duration" ? totalMs >= target : picked.length >= target;

  while (!reached()) {
    const candidates = decks.filter((deck) => deck.remaining.length > 0);
    if (candidates.length === 0) break;

    // File d'attente pondérée (WFQ) : chaque deck annonce la « date » de son prochain
    // morceau, (déjà pris + 1) / poids ; le plus tôt passe. `spread` n'est qu'une
    // pénalité, il évite les répétitions sans casser les quotas.
    let best = candidates[0];
    let bestScore = Infinity;
    for (const deck of shuffle(candidates, rng)) {
      const penalty = spread && deck.key === previousKey ? 1 : 0;
      const score = (deck.taken + 1 + penalty) / weights.get(deck.key);
      if (score < bestScore) {
        bestScore = score;
        best = deck;
      }
    }

    const track = best.remaining.shift();
    best.taken += 1;
    previousKey = best.key;
    picked.push({ ...track, sourceLabel: best.label, position: picked.length + 1 });
    totalMs += track.durationMs || 0;
  }

  const perSource = decks.map((deck) => ({ key: deck.key, label: deck.label, count: deck.taken }));
  const available = decks.reduce((sum, deck) => sum + deck.taken + deck.remaining.length, 0);

  return { tracks: picked, totalMs, perSource, sharedCount, available };
}

export function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function toCsv(tracks) {
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [["#", "Titre", "Artiste", "Durée", "Joueur"]];
  for (const track of tracks) {
    rows.push([track.position, track.name, track.artists, formatDuration(track.durationMs), track.sourceLabel]);
  }
  return rows.map((row) => row.map(escape).join(",")).join("\r\n");
}
