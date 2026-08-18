// Dialogue avec l'API de soirée : le tour en cours descend vers les joueurs,
// leurs votes remontent — sans jamais redescendre.

async function call(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Erreur ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/** Publie le morceau en cours. Renvoie les votants déjà enregistrés. */
export function publishRound(code, round) {
  return call(`/api/party?code=${encodeURIComponent(code)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ round }),
  });
}

/** Tour en cours et liste des votants (prénoms seuls). */
export function fetchRound(code) {
  return call(`/api/party?code=${encodeURIComponent(code)}`);
}

/** Dépose le pari d'un joueur sur le tour en cours. */
export function castVote(code, { roundId, voter, guess }) {
  return call(`/api/vote?code=${encodeURIComponent(code)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roundId, voter, guess }),
  });
}
