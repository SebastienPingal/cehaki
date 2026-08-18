// Dialogue avec l'API de session : les dépôts des joueurs remontent à l'organisateur.
import { validateSubmission } from "../lib/validate.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans I, O, 0, 1 : dictés à l'oral

export function generateCode(length = 5) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

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

/** Dépose la playlist d'un joueur dans la session. */
export function submitPlaylist({ code, name, playlist }) {
  const checked = validateSubmission({ code, name, playlist });
  if (!checked.ok) return Promise.reject(new Error(checked.error));
  return call(`/api/session?code=${encodeURIComponent(code)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, playlist }),
  });
}

/** Dépôts reçus, du plus ancien au plus récent. */
export async function fetchSubmissions(code) {
  const data = await call(`/api/session?code=${encodeURIComponent(code)}`);
  return data.submissions || [];
}
