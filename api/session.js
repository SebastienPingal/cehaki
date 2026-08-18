import { isConfigured, addSubmission, listSubmissions, MAX_SUBMISSIONS } from "../lib/store.js";
import { validateSubmission, CODE_PATTERN } from "../lib/validate.js";

const send = (res, status, body) => res.status(status).json(body);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!isConfigured()) {
    return send(res, 503, {
      error: "Stockage non configuré : ajoute l'intégration Upstash Redis au projet Vercel. "
        + "En attendant, les joueurs peuvent envoyer leur lien à la main.",
    });
  }

  const code = String(req.query.code || "").toUpperCase();
  if (!CODE_PATTERN.test(code)) return send(res, 400, { error: "Code de session invalide." });

  try {
    if (req.method === "GET") {
      return send(res, 200, { code, submissions: await listSubmissions(code) });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const checked = validateSubmission({ code, name: body.name, playlist: body.playlist });
      if (!checked.ok) return send(res, 400, { error: checked.error });

      const accepted = await addSubmission(code, { ...checked.value, at: Date.now() });
      if (!accepted) {
        return send(res, 409, { error: `Cette session est pleine (${MAX_SUBMISSIONS} playlists).` });
      }
      return send(res, 201, { ok: true });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Méthode non autorisée." });
  } catch (error) {
    console.error("session:", error);
    return send(res, 500, { error: "Le stockage des sessions est indisponible." });
  }
}
