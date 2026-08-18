import {
  getClientId, setClientId, getRedirectUri, login, logout,
  isLoggedIn, handleRedirect, getRefreshToken, hasBuiltInClientId, hasScope,
} from "./auth.js";
import {
  parsePlaylistId, parseSubmissionLine, fetchPlaylist, getCurrentUser, createPlaylist,
  getCurrentlyPlaying,
} from "./spotify.js";
import { buildAnswerKey, describeNowPlaying, nextPollDelay } from "./nowplaying.js";
import { createEntry, insertEntry, removeEntry, describeFreshness, formatDate } from "./mixes.js";
import { mix, formatDuration, toCsv } from "./mixer.js";
import { runDiagnostic, summarize } from "./diagnostic.js";
import { qrToSvg } from "./qr.js";
import { generateCode, submitPlaylist, fetchSubmissions } from "./session.js";

const SOURCES_KEY = "spm.sources";
const CODE_KEY = "spm.sessionCode";
const POLL_MS = 5000;
const PARTY_KEY = "spm.party";
const RETURN_KEY = "spm.return";
const MIXES_KEY = "spm.mixes";
const LIVE_SCOPE = "user-read-currently-playing";
const $ = (id) => document.getElementById(id);

/** @type {Array<{key:string,id:string,label:string,name:string,owner:string,image:string,url:string,tracks:Array,status:string,error?:string}>} */
let sources = [];
let currentMix = null;
let me = null;
let pollTimer = null;
let seenSubmissions = new Set();
/** @type {Array<object>} playlists créées sur Spotify, mémorisées d'une session à l'autre */
let mixes = [];
let liveEntry = null;
let answerKey = buildAnswerKey([]);
let liveTimer = null;
let liveTrackId = null;
let revealed = false;

/* ---------------------------------------------------------------- toasts */

let toastTimer;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), isError ? 7000 : 3500);
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("Copie refusée par le navigateur — sélectionne le texte à la main.", true);
  }
}

/* --------------------------------------------------------------- routeur */

const VIEWS = ["accueil", "organisateur", "soiree", "joueur"];

/** Découpe `#/joueur?jeu=Soirée` en nom de vue + paramètres. */
function parseRoute() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const name = VIEWS.includes(path) ? path : "accueil";
  return { name, params: new URLSearchParams(query || "") };
}

function showView() {
  const { name, params } = parseRoute();
  for (const view of VIEWS) $(`view-${view}`).classList.toggle("hidden", view !== name);
  $("auth-zone").classList.toggle("hidden", name !== "organisateur" && name !== "soiree");
  window.scrollTo(0, 0);

  if (name === "organisateur") {
    refreshInvite();
    renderMixes();
    startPolling();
  } else {
    stopPolling();
  }
  if (name === "soiree") {
    openLiveView(params.get("mix"));
  } else {
    stopLive();
  }
  if (name === "joueur") {
    const party = params.get("jeu");
    $("player-title").textContent = party ? `Ta playlist pour « ${party} »` : "Ta playlist pour la soirée";
  }
}

/* ------------------------------------------------------------ persistance */

function saveSources() {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(sources.map(({ id, label }) => ({ id, label }))));
}

function loadSavedSources() {
  try {
    return JSON.parse(localStorage.getItem(SOURCES_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveMixes() {
  localStorage.setItem(MIXES_KEY, JSON.stringify(mixes));
}

function loadMixes() {
  try {
    const stored = JSON.parse(localStorage.getItem(MIXES_KEY) || "[]");
    mixes = Array.isArray(stored) ? stored.filter((entry) => entry?.id && Array.isArray(entry.tracks)) : [];
  } catch {
    mixes = [];
  }
}

/* --------------------------------------------------------------- invitation */

function sessionCode() {
  let code = localStorage.getItem(CODE_KEY);
  if (!code) {
    code = generateCode();
    localStorage.setItem(CODE_KEY, code);
  }
  return code;
}

function playerUrl() {
  const party = $("invite-name").value.trim();
  const query = new URLSearchParams({ s: sessionCode() });
  if (party) query.set("jeu", party);
  return `${getRedirectUri()}#/joueur?${query}`;
}

function refreshInvite() {
  $("session-code").value = sessionCode();
  const url = playerUrl();
  $("invite-link").value = url;
  try {
    $("invite-qr").innerHTML = qrToSvg(url, { size: 200 });
  } catch (error) {
    $("invite-qr").textContent = error.message;
  }
}

/* ------------------------------------------------- réception des dépôts */

function setSessionStatus(message, kind = "") {
  const el = $("session-status");
  el.className = `feedback ${kind}`;
  el.textContent = message;
}

/** Interroge la session et ajoute les playlists reçues, sans doublon. */
async function pollSubmissions() {
  let submissions;
  try {
    submissions = await fetchSubmissions(sessionCode());
  } catch (error) {
    setSessionStatus(
      error.status === 503
        ? "Réception automatique indisponible : les joueurs peuvent envoyer leur lien à la main."
        : `Réception interrompue : ${error.message}`,
      "ko",
    );
    stopPolling();
    return;
  }

  const fresh = submissions.filter((s) => !seenSubmissions.has(`${s.name}:${s.playlistId}`));
  for (const submission of fresh) {
    seenSubmissions.add(`${submission.name}:${submission.playlistId}`);
    if (sources.some((source) => source.id === submission.playlistId)) continue;
    if (!isLoggedIn()) continue;
    await addPlaylistById(submission.playlistId, submission.name);
    toast(`Playlist de ${submission.name} reçue 🎉`);
  }

  const count = submissions.length;
  setSessionStatus(
    count === 0
      ? "En attente des joueurs — leurs playlists arriveront ici automatiquement."
      : `${count} playlist${count > 1 ? "s" : ""} reçue${count > 1 ? "s" : ""}.`
        + (isLoggedIn() ? "" : " Connecte-toi pour les charger."),
    count > 0 ? "ok" : "",
  );
}

function startPolling() {
  if (pollTimer) return;
  pollSubmissions();
  pollTimer = setInterval(pollSubmissions, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/* -------------------------------------------------------------- rendu UI */

function renderSources() {
  const list = $("sources");
  list.innerHTML = "";
  $("sources-empty").classList.toggle("hidden", sources.length > 0);

  for (const source of sources) {
    const li = document.createElement("li");
    li.className = `source ${source.status}`;

    const img = document.createElement("img");
    img.src = source.image || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    img.alt = "";
    li.append(img);

    const meta = document.createElement("div");
    meta.className = "meta";
    const label = document.createElement("input");
    label.type = "text";
    label.value = source.label;
    label.placeholder = "Nom du joueur";
    label.addEventListener("input", () => {
      source.label = label.value;
      saveSources();
    });
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent =
      source.status === "loading" ? "Chargement…"
      : source.status === "error" ? `⚠️ ${source.error}`
      : `${source.tracks.length} morceaux · playlist « ${source.name} »${source.owner ? ` de ${source.owner}` : ""}`;
    meta.append(label, sub);
    li.append(meta);

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.title = "Retirer";
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      sources = sources.filter((s) => s.key !== source.key);
      saveSources();
      renderSources();
      renderMixes();
      refreshMixButton();
    });
    li.append(remove);

    list.append(li);
  }
}

function renderMixes() {
  const list = $("mixes");
  list.innerHTML = "";
  $("mixes-empty").classList.toggle("hidden", mixes.length > 0);

  for (const entry of mixes) {
    const { upToDate, text } = describeFreshness(entry, readySources());
    const li = document.createElement("li");
    li.className = `mix ${upToDate ? "fresh" : "stale"}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("strong");
    title.textContent = entry.name;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${formatDate(entry.createdAt)} · ${text}`;
    meta.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "mix-actions";

    const live = document.createElement("a");
    live.className = "btn btn-primary";
    live.href = `#/soiree?mix=${entry.id}`;
    live.textContent = "Écran de soirée";

    const open = document.createElement("a");
    open.className = "btn btn-ghost";
    open.href = entry.url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Spotify";

    const remove = document.createElement("button");
    remove.className = "btn btn-ghost";
    remove.type = "button";
    remove.textContent = "Oublier";
    remove.addEventListener("click", () => {
      mixes = removeEntry(mixes, entry.id);
      saveMixes();
      renderMixes();
    });

    actions.append(live, open, remove);
    li.append(meta, actions);
    list.append(li);
  }
}

function readySources() {
  return sources.filter((s) => s.status === "ready" && s.tracks.length > 0);
}

function refreshMixButton() {
  $("mix-btn").disabled = readySources().length < 2 || !isLoggedIn();
}

function fillTrackTable(table, tracks) {
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  for (const track of tracks) {
    const tr = document.createElement("tr");
    const cells = [
      [track.position, ""],
      [track.name, "title"],
      [track.artists, "artist"],
      [formatDuration(track.durationMs), ""],
      [track.sourceLabel, "answer"],
    ];
    for (const [value, className] of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      if (className) td.className = className;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function renderResult(result) {
  fillTrackTable($("result-table"), result.tracks);
  $("result-card").classList.remove("hidden");

  const repartition = result.perSource.filter((s) => s.count > 0).map((s) => `${s.label} ${s.count}`).join(" · ");
  const shared = result.sharedCount > 0 ? ` · ${result.sharedCount} morceaux communs écartés` : "";
  $("mix-summary").textContent =
    `${result.tracks.length} morceaux · ${formatDuration(result.totalMs)} · ${repartition}${shared}`;
}

/* ------------------------------------------------------------- playlists */

async function addPlaylistById(id, savedLabel) {
  if (sources.some((s) => s.id === id)) {
    toast("Cette playlist est déjà dans la liste.");
    return;
  }
  const source = {
    key: `${id}-${Math.random().toString(36).slice(2, 8)}`,
    id, label: savedLabel || "", name: "", owner: "", image: "", url: "",
    tracks: [], status: "loading",
  };
  sources.push(source);
  renderSources();

  try {
    const playlist = await fetchPlaylist(id);
    Object.assign(source, {
      name: playlist.name, owner: playlist.owner, image: playlist.image,
      url: playlist.url, tracks: playlist.tracks, status: "ready",
    });
    if (!source.label) source.label = playlist.owner || playlist.name;
    saveSources();
  } catch (error) {
    source.status = "error";
    source.error = error.message;
  }
  renderSources();
  renderMixes();
  refreshMixButton();
}

async function handleAddPlaylists() {
  if (!isLoggedIn()) {
    toast("Connecte-toi à Spotify d'abord.", true);
    return;
  }
  const lines = $("playlist-input").value.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return;

  const submissions = [];
  for (const line of lines) {
    const parsed = parseSubmissionLine(line);
    if (parsed) submissions.push(parsed);
    else toast(`Lien non reconnu : ${line.slice(0, 60)}`, true);
  }
  $("playlist-input").value = "";
  for (const { id, label } of submissions) await addPlaylistById(id, label);
}

/* ------------------------------------------------------------------ mix */

function handleMix() {
  const ready = readySources();
  if (ready.length < 2) {
    toast("Ajoute au moins deux playlists.", true);
    return;
  }
  const mode = $("mode").value;
  const target = mode === "duration" ? Number($("target-duration").value) * 60_000 : Number($("target-count").value);
  if (!target || target <= 0) {
    toast("Indique une limite valide.", true);
    return;
  }

  currentMix = mix({
    sources: ready.map((s) => ({ key: s.key, label: s.label || s.name, tracks: s.tracks })),
    mode, target,
    balance: $("balance").value,
    dedupe: $("dedupe").checked,
    spread: $("spread").checked,
  });

  if (currentMix.tracks.length === 0) {
    toast("Aucun morceau retenu — vérifie les playlists.", true);
    return;
  }
  renderResult(currentMix);
  $("create-btn").classList.remove("hidden");
  $("playlist-link").classList.add("hidden");

  if (mode === "count" && currentMix.tracks.length < target) {
    toast(`Seulement ${currentMix.tracks.length} morceaux disponibles après filtrage.`);
  }
}

async function handleCreate() {
  if (!currentMix) return;
  const button = $("create-btn");
  button.disabled = true;
  button.textContent = "Création…";
  try {
    const name = $("playlist-name").value.trim() || `Blind test — ${new Date().toLocaleDateString("fr-FR")}`;
    const players = currentMix.perSource.filter((s) => s.count > 0).map((s) => s.label).join(", ");
    const playlist = await createPlaylist({
      name,
      description: `Mix généré avec Playlist Mixer — joueurs : ${players}. À qui appartient chaque morceau ?`,
      isPublic: $("public-playlist").checked,
      uris: currentMix.tracks.map((t) => t.uri),
    });
    const mixedIds = new Set(currentMix.perSource.filter((s) => s.count > 0).map((s) => s.key));
    mixes = insertEntry(mixes, createEntry({
      playlist,
      name,
      mix: currentMix,
      sources: readySources().filter((source) => mixedIds.has(source.key)),
      settings: {
        mode: $("mode").value,
        balance: $("balance").value,
        dedupe: $("dedupe").checked,
        spread: $("spread").checked,
      },
    }));
    saveMixes();
    renderMixes();

    const link = $("playlist-link");
    link.href = playlist.url;
    link.classList.remove("hidden");
    toast("Playlist créée et mémorisée 🎉 — retrouve-la sous les playlists reçues.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Créer la playlist sur Spotify";
  }
}

function downloadCsv(tracks, filename) {
  const blob = new Blob(["﻿" + toCsv(tracks)], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function handleDownloadCsv() {
  if (currentMix) downloadCsv(currentMix.tracks, "corrige-blind-test.csv");
}

/* ------------------------------------------------------------ diagnostic */

async function handleDiagnostic() {
  if (!isLoggedIn()) {
    toast("Connecte-toi à Spotify d'abord.", true);
    return;
  }
  const button = $("diag-run");
  const list = $("diag-results");
  const verdict = $("diag-verdict");
  button.disabled = true;
  button.textContent = "Test en cours…";
  list.innerHTML = "";
  verdict.classList.add("hidden");

  try {
    const results = await runDiagnostic(parsePlaylistId($("diag-foreign").value || ""));
    for (const result of results) {
      const li = document.createElement("li");
      li.className = result.ok ? "ok" : "ko";
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = result.ok ? "✅" : "❌";
      const text = document.createElement("span");
      text.append(result.label, " — ");
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = result.detail;
      text.append(detail);
      li.append(mark, text);
      list.append(li);
    }
    verdict.textContent = summarize(results);
    verdict.classList.remove("hidden");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Lancer le diagnostic";
  }
}

/* ------------------------------------------------------ lecture en direct */

/** Prépare l'écran de soirée : liste des playlists mémorisées, corrigé, suivi. */
function openLiveView(requestedId) {
  const select = $("live-mix");
  select.innerHTML = "";
  for (const entry of mixes) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${entry.name} — ${formatDate(entry.createdAt)}`;
    select.append(option);
  }

  const entry = mixes.find((item) => item.id === requestedId) || mixes[0] || null;
  if (!entry) {
    select.classList.add("hidden");
    setLiveStatus("Aucune playlist mémorisée : crée-en une depuis l'espace organisateur.", "ko");
    $("live-panel").classList.add("hidden");
    liveEntry = null;
    answerKey = buildAnswerKey([]);
    fillTrackTable($("live-table"), []);
    return;
  }
  select.classList.remove("hidden");
  select.value = entry.id;
  selectMix(entry);
}

function selectMix(entry) {
  stopLive();
  liveEntry = entry;
  answerKey = buildAnswerKey(entry.tracks);
  fillTrackTable($("live-table"), entry.tracks);
  $("live-open").href = entry.url;
  setLiveStatus(`« ${entry.name} » — ${entry.tracks.length} morceaux. Lance-la sur Spotify.`);
  if (isLoggedIn() && hasScope(LIVE_SCOPE)) startLive();
}

function setLiveStatus(message, kind = "") {
  const el = $("live-status");
  el.className = `feedback ${kind}`;
  el.textContent = message;
}

function setRevealed(value) {
  revealed = value;
  const owner = $("live-owner");
  owner.classList.toggle("masked", !value && !owner.classList.contains("unknown"));
  $("live-reveal").textContent = value ? "Masquer" : "Révéler";
}

function renderLive(now) {
  const panel = $("live-panel");
  if (now.state === "idle" || now.state === "other") {
    panel.classList.add("hidden");
    setLiveStatus(now.message);
    liveTrackId = null;
    return;
  }
  panel.classList.remove("hidden");

  // Nouveau morceau : on remasque la réponse, sauf si la révélation auto est cochée.
  if (now.id !== liveTrackId) {
    liveTrackId = now.id;
    setRevealed($("live-auto-reveal").checked);
  }

  $("live-title").textContent = now.title;
  $("live-artists").textContent = now.artists;
  $("live-position").textContent =
    now.known ? `morceau ${now.position} sur ${now.total}` : "hors du mix";

  const owner = $("live-owner");
  owner.classList.toggle("unknown", !now.known);
  owner.textContent = now.known ? now.owner || "sans étiquette" : "Ce titre n'est pas dans le corrigé.";
  $("live-reveal").classList.toggle("hidden", !now.known);
  if (!now.known) owner.classList.remove("masked");
  else setRevealed(revealed);

  const ratio = now.durationMs > 0 ? Math.min(1, now.progressMs / now.durationMs) : 0;
  $("live-progress").style.width = `${(ratio * 100).toFixed(1)}%`;
  setLiveStatus(
    now.state === "paused" ? "Lecture en pause." : "Suivi en cours — l'affichage se met à jour tout seul.",
    now.state === "paused" ? "" : "ok",
  );
}

async function liveTick() {
  let playback;
  try {
    playback = await getCurrentlyPlaying();
  } catch (error) {
    stopLive();
    setLiveStatus(`Suivi interrompu : ${error.message}`, "ko");
    return;
  }
  const now = describeNowPlaying(playback, answerKey);
  renderLive(now);
  liveTimer = setTimeout(liveTick, nextPollDelay(now));
}

function startLive() {
  if (liveTimer) return;
  if (!isLoggedIn()) {
    setLiveStatus("Connecte-toi à Spotify pour lire ce qui joue.", "ko");
    return;
  }
  if (!hasScope(LIVE_SCOPE)) {
    setLiveStatus(
      "Il manque l'autorisation « lecture en cours » : déconnecte-toi puis reconnecte-toi à Spotify.",
      "ko",
    );
    return;
  }
  if (answerKey.total === 0) {
    setLiveStatus("Choisis d'abord une playlist générée.", "ko");
    return;
  }
  liveTimer = setTimeout(liveTick, 0);
  $("live-toggle").textContent = "Arrêter le suivi";
  setLiveStatus("Recherche du morceau en cours…");
}

function stopLive() {
  if (!liveTimer) return;
  clearTimeout(liveTimer);
  liveTimer = null;
  liveTrackId = null;
  $("live-toggle").textContent = "Suivre la lecture";
  $("live-panel").classList.add("hidden");
  setLiveStatus("Suivi arrêté.");
}

/* ---------------------------------------------------------------- joueur */

function playerSubmission() {
  const name = $("player-name").value.trim();
  const link = $("player-playlist").value.trim();
  const id = parsePlaylistId(link);
  return { name, link, id };
}

function refreshPlayerFeedback() {
  const { name, link, id } = playerSubmission();
  const feedback = $("player-feedback");
  if (!link) {
    feedback.classList.add("hidden");
    return null;
  }
  if (!id) {
    feedback.className = "feedback ko";
    feedback.textContent = "Ce lien ne ressemble pas à une playlist Spotify. Copie-le depuis « Inviter des collaborateurs ».";
    return null;
  }
  feedback.className = "feedback ok";
  feedback.textContent = name ? `C'est bon, ${name} — ton lien est valide.` : "Lien valide. Ajoute ton prénom et c'est prêt.";
  return { name, link, id };
}

function playerMessage() {
  const submission = refreshPlayerFeedback();
  if (!submission) {
    toast("Renseigne d'abord un lien de playlist valide.", true);
    return null;
  }
  if (!submission.name) {
    toast("Ajoute ton prénom, sinon l'organisateur ne saura pas à qui est la playlist.", true);
    return null;
  }
  return `${submission.name} — ${submission.link}`;
}

/** Code de session transmis par le lien d'invitation. */
function currentSessionCode() {
  return parseRoute().params.get("s") || "";
}

async function handlePlayerSend() {
  const submission = refreshPlayerFeedback();
  const feedback = $("player-feedback");
  if (!submission) return toast("Renseigne d'abord un lien de playlist valide.", true);
  if (!submission.name) return toast("Ajoute ton prénom.", true);

  const code = currentSessionCode();
  if (!code) {
    toast("Ce lien ne contient pas de session — envoie ton message à l'organisateur.", true);
    return handlePlayerShare();
  }

  const button = $("player-send");
  button.disabled = true;
  button.textContent = "Envoi…";
  try {
    await submitPlaylist({ code, name: submission.name, playlist: submission.link });
    feedback.className = "feedback ok";
    feedback.textContent = `C'est envoyé, ${submission.name} — ta playlist est arrivée chez l'organisateur.`;
    button.textContent = "Envoyé ✓";
    return;
  } catch (error) {
    feedback.className = "feedback ko";
    feedback.textContent = `${error.message} Utilise « Copier le message » et envoie-le à l'organisateur.`;
    button.disabled = false;
    button.textContent = "Réessayer";
  }
}

async function handlePlayerShare() {
  const message = playerMessage();
  if (!message) return;
  $("player-message").textContent = message;
  $("player-message").classList.remove("hidden");

  if (navigator.share) {
    try {
      await navigator.share({ title: "Ma playlist", text: message });
      return;
    } catch {
      // partage annulé : on retombe sur la copie
    }
  }
  await copy(message, "Message copié — envoie-le à l'organisateur.");
}

/* ------------------------------------------------------------- démarrage */

async function refreshUser() {
  const badge = $("user-badge");
  const logged = isLoggedIn();
  $("login-btn").classList.toggle("hidden", logged);
  $("logout-btn").classList.toggle("hidden", !logged);
  badge.classList.toggle("hidden", !logged);
  refreshMixButton();
  if (!logged) return;
  try {
    me = await getCurrentUser();
    badge.textContent = `Connecté : ${me.display_name || me.id}`;
  } catch (error) {
    badge.textContent = "Session expirée";
    toast(error.message, true);
  }
}

function wireEvents() {
  window.addEventListener("hashchange", showView);

  $("client-id").addEventListener("change", (event) => {
    setClientId(event.target.value);
    toast("Client ID enregistré.");
  });
  $("client-id-override").addEventListener("click", () => {
    $("client-id-setup").hidden = false;
    $("client-id-ready").hidden = true;
    $("client-id").focus();
  });
  $("copy-redirect").addEventListener("click", () => copy(getRedirectUri(), "URL de redirection copiée."));
  $("login-btn").addEventListener("click", () => {
    sessionStorage.setItem(RETURN_KEY, location.hash || "#/organisateur");
    login().catch((error) => toast(error.message, true));
  });
  $("logout-btn").addEventListener("click", () => {
    logout();
    me = null;
    refreshUser();
    toast("Déconnecté.");
  });
  $("copy-refresh").addEventListener("click", () => {
    const token = getRefreshToken();
    if (!token) return toast("Connecte-toi d'abord.", true);
    copy(token, "Refresh token copié — traite-le comme un mot de passe.");
  });

  $("invite-name").addEventListener("input", () => {
    localStorage.setItem(PARTY_KEY, $("invite-name").value);
    refreshInvite();
  });
  $("invite-copy").addEventListener("click", () => copy(playerUrl(), "Lien d'invitation copié."));
  $("invite-share").addEventListener("click", async () => {
    try {
      await navigator.share({ title: "Playlist Mixer", text: "Prépare ta playlist pour la soirée :", url: playerUrl() });
    } catch { /* partage annulé */ }
  });
  $("invite-print").addEventListener("click", () => window.print());

  $("add-playlists").addEventListener("click", () => {
    handleAddPlaylists().catch((error) => toast(error.message, true));
  });
  $("mode").addEventListener("change", (event) => {
    const isDuration = event.target.value === "duration";
    $("duration-field").classList.toggle("hidden", !isDuration);
    $("count-field").classList.toggle("hidden", isDuration);
  });
  $("mix-btn").addEventListener("click", handleMix);
  $("create-btn").addEventListener("click", handleCreate);
  $("download-csv").addEventListener("click", handleDownloadCsv);
  $("diag-run").addEventListener("click", handleDiagnostic);
  $("live-mix").addEventListener("change", (event) => {
    const entry = mixes.find((item) => item.id === event.target.value);
    if (entry) selectMix(entry);
  });
  $("live-toggle").addEventListener("click", () => (liveTimer ? stopLive() : startLive()));
  $("live-toggle-answers").addEventListener("click", (event) => {
    const hidden = $("live-table").classList.toggle("answers-hidden");
    event.target.textContent = hidden ? "Afficher les réponses" : "Masquer les réponses";
  });
  $("live-csv").addEventListener("click", () => {
    if (liveEntry) downloadCsv(liveEntry.tracks, `corrige-${liveEntry.name}.csv`);
  });
  $("live-reveal").addEventListener("click", () => setRevealed(!revealed));
  $("live-auto-reveal").addEventListener("change", (event) => {
    if (event.target.checked) setRevealed(true);
  });
  $("toggle-answers").addEventListener("click", (event) => {
    const hidden = $("result-table").classList.toggle("answers-hidden");
    event.target.textContent = hidden ? "Afficher les réponses" : "Masquer les réponses";
  });

  for (const id of ["player-name", "player-playlist"]) {
    $(id).addEventListener("input", () => {
      refreshPlayerFeedback();
      const button = $("player-send");
      button.disabled = false;
      button.textContent = "Envoyer à l'organisateur";
    });
  }
  $("player-send").addEventListener("click", handlePlayerSend);
  $("player-share").addEventListener("click", handlePlayerShare);
  $("session-new").addEventListener("click", () => {
    localStorage.setItem(CODE_KEY, generateCode());
    seenSubmissions = new Set();
    refreshInvite();
    setSessionStatus("Nouvelle session : renvoie le lien ou le QR code aux joueurs.");
  });
  $("player-copy").addEventListener("click", () => {
    const message = playerMessage();
    if (message) {
      $("player-message").textContent = message;
      $("player-message").classList.remove("hidden");
      copy(message, "Message copié.");
    }
  });
}

async function start() {
  $("redirect-uri").value = getRedirectUri();
  $("client-id").value = getClientId();
  if (hasBuiltInClientId() && !localStorage.getItem("spm.clientId")) {
    $("client-id-setup").hidden = true;
    $("client-id-ready").hidden = false;
  }
  $("invite-name").value = localStorage.getItem(PARTY_KEY) || "";
  loadMixes();
  if (!navigator.share) $("invite-share").classList.add("hidden");
  else $("invite-share").classList.remove("hidden");
  wireEvents();

  try {
    if (await handleRedirect()) {
      location.hash = sessionStorage.getItem(RETURN_KEY) || "#/organisateur";
      sessionStorage.removeItem(RETURN_KEY);
      toast("Connexion réussie 👋");
    }
  } catch (error) {
    toast(error.message, true);
  }

  showView();
  await refreshUser();

  if (isLoggedIn()) {
    for (const saved of loadSavedSources()) await addPlaylistById(saved.id, saved.label);
  }
}

start();
