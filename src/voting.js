// Votes de la soirée : logique pure (aucun accès réseau), testable isolément.

const normalize = (name) => String(name || "").trim().toLowerCase();

/**
 * Tour à publier pour les joueurs, à partir du morceau en cours.
 * La réponse n'est jointe que si le morceau est révélé : tant qu'il ne l'est
 * pas, elle ne quitte pas l'écran de l'organisateur.
 * @param {object} options
 * @param {{sources:Array<{label:string}>}} options.entry playlist générée
 * @param {{id:string,title:string,artists:string,owner:string,position:number,total:number}} options.now morceau en cours
 * @param {number} options.sequence compteur de morceaux joués, pour distinguer deux passages du même titre
 */
export function buildRound({ entry, now, sequence = 0, revealed = false }) {
  const players = [];
  for (const source of entry?.sources || []) {
    const label = String(source.label || "").trim();
    if (label && !players.some((player) => normalize(player) === normalize(label))) players.push(label);
  }
  return {
    id: `${now.id}-${sequence}`,
    trackId: now.id,
    title: now.title || "",
    artists: now.artists || "",
    position: now.position || 0,
    total: now.total || 0,
    players,
    revealed,
    answer: revealed ? now.owner || "" : "",
  };
}

/** Deux tours sont le même s'ils portent le même identifiant et le même état de révélation. */
export function sameRound(a, b) {
  if (!a || !b) return false;
  return a.id === b.id && Boolean(a.revealed) === Boolean(b.revealed);
}

/**
 * Qui a voté, qui manque — sans jamais toucher au contenu des votes.
 * @param {Array<{name:string}>} voters votants renvoyés par l'API
 * @param {Array<string>} players joueurs attendus
 */
export function describeVoters(voters, players) {
  const votedNames = (voters || []).map((voter) => voter.name);
  const voted = new Set(votedNames.map(normalize));
  const attendus = players || [];
  const waiting = attendus.filter((player) => !voted.has(normalize(player)));
  const extra = votedNames.filter((name) => !attendus.some((player) => normalize(player) === normalize(name)));
  const done = attendus.length - waiting.length;
  return {
    voted: votedNames,
    waiting,
    extra,
    complete: attendus.length > 0 && waiting.length === 0,
    text: attendus.length === 0
      ? `${votedNames.length} vote${votedNames.length > 1 ? "s" : ""}`
      : `${done} vote${done > 1 ? "s" : ""} sur ${attendus.length}`,
  };
}

/**
 * Score d'un joueur à partir de ses paris, une fois les morceaux révélés.
 * @param {Array<{guess:string, answer?:string}>} history
 */
export function scoreVotes(history) {
  const judged = (history || []).filter((vote) => vote && vote.answer);
  const right = judged.filter((vote) => normalize(vote.guess) === normalize(vote.answer)).length;
  return { right, judged: judged.length, total: (history || []).length };
}
