import { isConfigured, setRound, getRound, listVoters, listVotes } from "../lib/store.js";
import { validateRound, CODE_PATTERN } from "../lib/validate.js";

const send = (res, status, body) => res.status(status).json(body);

/**
 * Le tour en cours d'une soirée : l'écran de soirée le publie (POST), les
 * téléphones des joueurs le lisent (GET). La réponse n'est jointe qu'une fois
 * le morceau révélé ; la liste des votants ne contient que des prénoms.
 */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!isConfigured()) {
    return send(res, 503, {
      error: "Stockage non configuré : ajoute l'intégration Upstash Redis au projet Vercel. "
        + "En attendant, les joueurs votent sur papier.",
    });
  }

  const code = String(req.query.code || "").toUpperCase();
  if (!CODE_PATTERN.test(code)) return send(res, 400, { error: "Code de session invalide." });

  try {
    if (req.method === "GET") {
      const round = await getRound(code);
      if (!round) return send(res, 200, { code, round: null, voters: [] });
      // Les paris ne sortent qu'une fois le morceau révélé : la réponse est alors
      // publique, il n'y a plus rien à protéger — et l'écran de soirée peut compter.
      if (round.revealed) {
        const votes = await listVotes(code, round.id);
        return send(res, 200, { code, round, voters: votes.map(({ name, at }) => ({ name, at })), votes });
      }
      return send(res, 200, { code, round, voters: await listVoters(code, round.id) });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const checked = validateRound({ code, round: body.round });
      if (!checked.ok) return send(res, 400, { error: checked.error });

      await setRound(code, { ...checked.value, at: Date.now() });
      return send(res, 200, { ok: true, round: checked.value, voters: await listVoters(code, checked.value.id) });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Méthode non autorisée." });
  } catch (error) {
    console.error("party:", error);
    return send(res, 500, { error: "Le stockage des sessions est indisponible." });
  }
}
