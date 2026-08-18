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
