/**
 * Stockage des sessions, sur Redis Upstash via son API REST.
 * Les variables sont injectées par l'intégration Vercel ; les deux jeux de noms
 * (Vercel KV historique et Upstash) sont acceptés.
 */
const URL_VAR = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN_VAR = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const isConfigured = () => Boolean(URL_VAR && TOKEN_VAR);

const TTL_SECONDS = 14 * 24 * 3600;
export const MAX_SUBMISSIONS = 40;

async function command(...args) {
  const response = await fetch(URL_VAR, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN_VAR}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(`Redis: ${data.error || response.status}`);
  }
  return data.result;
}

const key = (code) => `session:${code}`;

/** Dépôt d'un joueur. Renvoie false si la session est pleine. */
export async function addSubmission(code, submission) {
  const length = await command("RPUSH", key(code), JSON.stringify(submission));
  await command("EXPIRE", key(code), String(TTL_SECONDS));
  if (length > MAX_SUBMISSIONS) {
    await command("LTRIM", key(code), "0", String(MAX_SUBMISSIONS - 1));
    return false;
  }
  return true;
}

/** Dépôts d'une session, du plus ancien au plus récent. */
export async function listSubmissions(code) {
  const rows = (await command("LRANGE", key(code), "0", "-1")) || [];
  return rows
    .map((row) => {
      try {
        return JSON.parse(row);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* --------------------------------------------- tour en cours et votes ---- */

export const MAX_VOTERS = 40;

const roundKey = (code) => `round:${code}`;
const votesKey = (code, roundId) => `votes:${code}:${roundId}`;

/** Publie le morceau en cours : c'est lui qui pilote l'écran de vote des joueurs. */
export async function setRound(code, round) {
  await command("SET", roundKey(code), JSON.stringify(round), "EX", String(TTL_SECONDS));
  return round;
}

/** Tour en cours, ou null si la soirée n'a rien publié. */
export async function getRound(code) {
  const raw = await command("GET", roundKey(code));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/** Enregistre — ou remplace — le pari d'un joueur. Faux si le tour est complet. */
export async function castVote(code, roundId, { voter, guess, at }) {
  const key = votesKey(code, roundId);
  const known = await command("HEXISTS", key, voter);
  if (!Number(known) && Number(await command("HLEN", key)) >= MAX_VOTERS) return false;
  await command("HSET", key, voter, JSON.stringify({ guess, at }));
  await command("EXPIRE", key, String(TTL_SECONDS));
  return true;
}

/**
 * Votants d'un tour, sans leur pari : l'écran de soirée montre qui a voté,
 * jamais ce qu'il a voté.
 */
export async function listVoters(code, roundId) {
  const raw = (await command("HGETALL", votesKey(code, roundId))) || [];
  // Upstash renvoie soit un objet, soit une liste plate champ/valeur selon la version.
  const entries = Array.isArray(raw)
    ? Array.from({ length: raw.length / 2 }, (_, i) => [raw[i * 2], raw[i * 2 + 1]])
    : Object.entries(raw);
  return entries
    .map(([voter, value]) => {
      let at = 0;
      try {
        at = JSON.parse(value)?.at || 0;
      } catch { /* valeur illisible : le nom suffit */ }
      return { name: voter, at };
    })
    .sort((a, b) => a.at - b.at);
}
