import { isConfigured, getRound, castVote, listVoters, MAX_VOTERS } from "../lib/store.js";
import { validateVote, CODE_PATTERN } from "../lib/validate.js";

const send = (res, status, body) => res.status(status).json(body);

/**
 * Le pari d'un joueur sur le morceau en cours. Il n'est renvoyé à personne :
 * seule la liste des prénoms ayant voté ressort d'ici.
 */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!isConfigured()) {
    return send(res, 503, { error: "Stockage non configuré : les votes en ligne sont indisponibles." });
  }

  const code = String(req.query.code || "").toUpperCase();
  if (!CODE_PATTERN.test(code)) return send(res, 400, { error: "Code de session invalide." });

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Méthode non autorisée." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const checked = validateVote({ code, roundId: body.roundId, voter: body.voter, guess: body.guess });
    if (!checked.ok) return send(res, 400, { error: checked.error });

    const round = await getRound(code);
    if (!round) return send(res, 409, { error: "Aucun morceau en cours — attends le prochain titre." });
    if (round.id !== checked.value.roundId) {
      return send(res, 409, { error: "Le morceau a changé : ton vote portait sur le précédent." });
    }
    if (round.revealed) return send(res, 409, { error: "Ce morceau est déjà révélé." });

    const accepted = await castVote(code, round.id, { ...checked.value, at: Date.now() });
    if (!accepted) return send(res, 409, { error: `Trop de votants (${MAX_VOTERS}).` });

    return send(res, 201, { ok: true, voters: await listVoters(code, round.id) });
  } catch (error) {
    console.error("vote:", error);
    return send(res, 500, { error: "Le stockage des sessions est indisponible." });
  }
}
