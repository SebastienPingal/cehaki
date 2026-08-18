// Authorization Code + PKCE : tout se passe dans le navigateur, aucun client secret.
const TOKEN_KEY = "spm.token";
const VERIFIER_KEY = "spm.verifier";
const STATE_KEY = "spm.state";
const CLIENT_KEY = "spm.clientId";

import { CLIENT_ID as BUILT_IN_CLIENT_ID } from "./config.js";

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SCOPES = [
  "playlist-modify-public",
  "playlist-modify-private",
  // Pour afficher, pendant la soirée, le morceau en cours et son propriétaire.
  "user-read-currently-playing",
];

export function getRedirectUri() {
  return location.origin + location.pathname;
}

/** Client ID injecté au déploiement, sauf si l'utilisateur en a saisi un autre. */
export function getClientId() {
  return localStorage.getItem(CLIENT_KEY) || BUILT_IN_CLIENT_ID;
}

/** Vrai si le déploiement fournit déjà un Client ID : inutile de le demander. */
export function hasBuiltInClientId() {
  return Boolean(BUILT_IN_CLIENT_ID);
}

export function setClientId(id) {
  localStorage.setItem(CLIENT_KEY, id.trim());
}

function randomString(length) {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => charset[b % charset.length]).join("");
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function challengeFrom(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

function readToken() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
  } catch {
    return null;
  }
}

function writeToken(data) {
  const stored = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || readToken()?.refresh_token,
    scope: data.scope || readToken()?.scope || "",
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 - 30_000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(stored));
  return stored;
}

/** Jeton de rafraîchissement brut — pour déboguer en ligne de commande. */
export function getRefreshToken() {
  return readToken()?.refresh_token || null;
}

/** Vrai si le jeton courant porte ce droit — un jeton d'avant l'ajout d'un scope ne l'a pas. */
export function hasScope(scope) {
  const granted = readToken()?.scope;
  if (!granted) return false;
  return granted.split(" ").includes(scope);
}

export function isLoggedIn() {
  const token = readToken();
  return Boolean(token?.access_token);
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new Error("Renseigne d'abord ton Client ID Spotify.");

  const verifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: getRedirectUri(),
    state,
    scope: SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: await challengeFrom(verifier),
  });
  location.assign(`${AUTH_URL}?${params}`);
}

async function requestToken(body) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Échec de l'authentification Spotify.");
  }
  return writeToken(data);
}

/**
 * À appeler au chargement : consomme le `?code=` du retour Spotify.
 * @returns {Promise<boolean>} true si une connexion vient d'aboutir.
 */
export async function handleRedirect() {
  const url = new URL(location.href);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (!error && !code) return false;

  const state = url.searchParams.get("state");
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  history.replaceState({}, "", getRedirectUri());

  if (error) throw new Error(`Spotify a refusé la connexion : ${error}`);
  if (!state || state !== expectedState) throw new Error("État OAuth invalide, reconnecte-toi.");
  if (!verifier) throw new Error("Vérificateur PKCE manquant, reconnecte-toi.");

  await requestToken({
    client_id: getClientId(),
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  });
  return true;
}

/** Jeton d'accès valide, rafraîchi à la volée si besoin. */
export async function getAccessToken() {
  const token = readToken();
  if (!token?.access_token) throw new Error("Connecte-toi à Spotify d'abord.");
  if (Date.now() < token.expires_at) return token.access_token;

  if (!token.refresh_token) {
    logout();
    throw new Error("Session expirée, reconnecte-toi.");
  }
  const refreshed = await requestToken({
    client_id: getClientId(),
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
  }).catch((err) => {
    logout();
    throw err;
  });
  return refreshed.access_token;
}
