import {
  getClientId, setClientId, getRedirectUri, login, logout,
  isLoggedIn, handleRedirect, getRefreshToken, hasBuiltInClientId, hasScope,
} from "./auth.js";
import {
  parsePlaylistId, parseSubmissionLine, fetchPlaylist, getCurrentUser, createPlaylist,
  getCurrentlyPlaying, getDevices, play, pause, nextTrack, previousTrack, stopPlayback,
} from "./spotify.js";
import { buildAnswerKey, describeNowPlaying, nextPollDelay } from "./nowplaying.js";
import { createEntry, insertEntry, removeEntry, describeFreshness, formatDate } from "./mixes.js";
import { mix, formatDuration, toCsv } from "./mixer.js";
import { runDiagnostic, summarize } from "./diagnostic.js";
import { qrToSvg } from "./qr.js";
import { generateCode, submitPlaylist, fetchSubmissions } from "./session.js";
import { buildRound, sameRound, describeVoters, scoreVotes, scoreRound, addRoundScores, rankBoard } from "./voting.js";
import { publishRound, fetchRound, castVote } from "./party.js";

const SOURCES_KEY = "spm.sources";
const CODE_KEY = "spm.sessionCode";
const POLL_MS = 5000;
const PARTY_KEY = "spm.party";
const RETURN_KEY = "spm.return";
const MIXES_KEY = "spm.mixes";
const LIVE_SCOPE = "user-read-currently-playing";
const CONTROL_SCOPE = "user-modify-playback-state";
const VOTERS_POLL_MS = 3000;
const VOTE_POLL_MS = 3000;
const VOTE_NAME_KEY = "spm.voteName";
const VOTE_HISTORY_KEY = "spm.voteHistory";
const SCORES_KEY = "spm.scores";
const SCORE_RULE_KEY = "spm.scoreRule";
const LIVE_STATE_KEY = "spm.liveRound";
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
/** Dernier état de lecture affiché : sert à republier le tour au moment de la révélation. */
let liveNow = null;
/** Compteur de morceaux joués : deux passages du même titre restent deux tours distincts. */
let liveSequence = 0;
let publishedRound = null;
let votersTimer = null;
/** Écran de vote (côté joueur). */
let voteTimer = null;
let voteRound = null;
let voteHistory = {};
/** Classement de la soirée en cours : { board: {nom: {points,right,votes}}, counted: [tours] }. */
let scores = { board: {}, counted: [] };
/** Classement publié par l'écran de soirée : c'est lui qui fait foi sur les téléphones. */
let publishedBoard = null;

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

const VIEWS = ["accueil", "organisateur", "soiree", "joueur", "vote"];

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
  if (name === "vote") {
    openVoteView(params);
  } else {
    stopVote();
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

/** Lien du vote : le code de session voyage dedans, comme pour l'invitation. */
function voteUrl(code = sessionCode(), name = "") {
  const party = localStorage.getItem(PARTY_KEY) || "";
  const query = new URLSearchParams({ s: code });
  if (party) query.set("jeu", party);
  if (name) query.set("n", name);
  return `${getRedirectUri()}#/vote?${query}`;
}

function refreshVoteInvite() {
  const url = voteUrl();
  $("vote-link").value = url;
  try {
    $("vote-qr").innerHTML = qrToSvg(url, { size: 200 });
  } catch (error) {
    $("vote-qr").textContent = error.message;
  }
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

  refreshVoteInvite();
  refreshDevices();

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
  loadScores(sessionCode());
  renderPartyBoard();
  liveEntry = entry;
  restoreLiveState(liveStateKey(entry));
  publishedRound = null;
  liveNow = null;
  renderVoters([], null);
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
  shareRound();
}

function renderLive(now) {
  const panel = $("live-panel");
  liveNow = now;
  setToggleLabel(now.state === "playing");
  if (now.state === "idle" || now.state === "other") {
    panel.classList.add("hidden");
    setLiveStatus(now.message);
    liveTrackId = null;
    return;
  }
  panel.classList.remove("hidden");

  // Nouveau morceau : on remasque la réponse, sauf si la révélation auto est cochée,
  // et on ouvre un tour de vote — deux passages du même titre restent distincts.
  if (now.id !== liveTrackId) {
    liveTrackId = now.id;
    liveSequence += 1;
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
  shareRound();
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
  startVotersPolling();
  $("live-toggle").textContent = "Arrêter le suivi";
  setLiveStatus("Recherche du morceau en cours…");
}

function stopLive() {
  stopVotersPolling();
  if (!liveTimer) return;
  clearTimeout(liveTimer);
  liveTimer = null;
  liveNow = null;
  $("live-toggle").textContent = "Suivre la lecture";
  $("live-panel").classList.add("hidden");
  setLiveStatus("Suivi arrêté.");
}

/* ------------------------------------------------------- télécommande */

function setCtlStatus(message, kind = "") {
  const el = $("ctl-status");
  el.className = `feedback ${kind}`;
  el.textContent = message;
}

function setToggleLabel(playing) {
  $("ctl-toggle").textContent = playing ? "⏸ Pause" : "▶︎ Lecture";
}

/** Appareil choisi dans la liste, ou l'appareil actif du compte si aucun n'est choisi. */
function currentDeviceId() {
  return $("live-device").value || undefined;
}

async function refreshDevices() {
  const select = $("live-device");
  if (!isLoggedIn() || !hasScope(CONTROL_SCOPE)) {
    select.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Appareil actif";
    select.append(option);
    return;
  }
  const previous = select.value;
  try {
    const devices = await getDevices();
    select.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = devices.length === 0 ? "Aucun appareil — ouvre Spotify quelque part" : "Appareil actif";
    select.append(auto);
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = `${device.name} (${device.type})${device.active ? " — actif" : ""}`;
      select.append(option);
    }
    select.value = devices.some((device) => device.id === previous) ? previous : "";
  } catch (error) {
    setCtlStatus(`Liste des appareils indisponible : ${error.message}`, "ko");
  }
}

/** Traduit les refus de Spotify les plus fréquents sur la télécommande. */
function controlMessage(error) {
  if (error.status === 404) {
    return "Aucun appareil actif : ouvre Spotify sur l'appareil de la soirée, lance n'importe quoi, puis « Rafraîchir ».";
  }
  if (error.status === 403) {
    return `Spotify refuse la commande — piloter la lecture demande un compte Premium. (${error.message})`;
  }
  return error.message;
}

/** Exécute une commande de lecture, puis rafraîchit l'affichage sans attendre le prochain sondage. */
async function control(run, done) {
  if (!isLoggedIn()) return setCtlStatus("Connecte-toi à Spotify d'abord.", "ko");
  if (!hasScope(CONTROL_SCOPE)) {
    return setCtlStatus(
      "Il manque l'autorisation de pilotage : déconnecte-toi puis reconnecte-toi à Spotify.",
      "ko",
    );
  }
  try {
    await run({ deviceId: currentDeviceId() });
    setCtlStatus(done, "ok");
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(liveTick, 700);
    }
  } catch (error) {
    setCtlStatus(controlMessage(error), "ko");
  }
}

function wireControls() {
  $("device-refresh").addEventListener("click", refreshDevices);
  $("ctl-start").addEventListener("click", () => {
    if (!liveEntry) return setCtlStatus("Choisis d'abord une playlist générée.", "ko");
    control(
      (options) => play({ ...options, playlistId: liveEntry.id, offset: 0 }),
      `« ${liveEntry.name} » démarre au premier morceau.`,
    );
  });
  $("ctl-toggle").addEventListener("click", () => {
    const playing = liveNow?.state === "playing";
    if (playing) control(pause, "En pause.");
    else control(play, "Lecture reprise.");
    setToggleLabel(!playing);
  });
  $("ctl-prev").addEventListener("click", () => control(previousTrack, "Morceau précédent."));
  $("ctl-next").addEventListener("click", () => control(nextTrack, "Morceau suivant."));
  $("ctl-stop").addEventListener("click", () => control(stopPlayback, "Arrêté, morceau remis à son début."));
}

/* ---------------------------------------------------- tour en cours, gardé */

/**
 * Le tour en cours survit à un rafraîchissement de l'écran de soirée : sans ça,
 * la page rouvrirait le morceau joué sous un nouvel identifiant, les votes déjà
 * déposés seraient perdus et le morceau pourrait être compté deux fois.
 */
const liveStateKey = (entry) => `${sessionCode()}:${entry?.id || ""}`;

function saveLiveState(code) {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(LIVE_STATE_KEY) || "{}") || {};
  } catch { /* stockage illisible : on repart dessus */ }
  stored[code] = { sequence: liveSequence, trackId: liveTrackId, revealed };
  localStorage.setItem(LIVE_STATE_KEY, JSON.stringify(stored));
}

function restoreLiveState(code) {
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(LIVE_STATE_KEY) || "{}")?.[code] || null;
  } catch { /* stockage illisible */ }
  liveSequence = Number(state?.sequence) || 0;
  liveTrackId = state?.trackId || null;
  revealed = Boolean(state?.revealed);
}

/* ------------------------------------------------------------ classement */

/** Le classement est rangé par session : une nouvelle soirée repart de zéro. */
function loadScores(code) {
  try {
    const stored = JSON.parse(localStorage.getItem(SCORES_KEY) || "{}");
    const own = stored?.[code];
    scores = own && typeof own.board === "object"
      ? { board: own.board, counted: Array.isArray(own.counted) ? own.counted : [] }
      : { board: {}, counted: [] };
  } catch {
    scores = { board: {}, counted: [] };
  }
}

function saveScores(code) {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SCORES_KEY) || "{}") || {};
  } catch { /* stockage illisible : on repart dessus */ }
  stored[code] = scores;
  localStorage.setItem(SCORES_KEY, JSON.stringify(stored));
}

/**
 * Compte les points d'un tour révélé, une seule fois. Les paris n'arrivent
 * qu'après la révélation : avant, il n'y a rien à compter.
 */
function countRound(code, round, votes) {
  if (!round?.revealed || !round.answer || !votes) return false;
  if (scores.counted.includes(round.id)) return false;
  scores = {
    board: addRoundScores(scores.board, scoreRound(votes, round.answer, { bonus: round.bonus !== false })),
    counted: [...scores.counted, round.id],
  };
  saveScores(code);
  return true;
}

const MEDALS = ["🥇", "🥈", "🥉"];

/** Dessine le classement dans une liste donnée. `highlight` met un joueur en avant. */
function renderBoard(list, highlight = "", board = scores.board) {
  const rows = rankBoard(board);
  list.innerHTML = "";
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = `board-row${highlight && row.name.toLowerCase() === highlight.toLowerCase() ? " me" : ""}`;

    const rank = document.createElement("span");
    rank.className = "board-rank";
    rank.textContent = row.rank <= 3 ? MEDALS[row.rank - 1] : `${row.rank}.`;

    const name = document.createElement("span");
    name.className = "board-name";
    name.textContent = row.name;

    const points = document.createElement("strong");
    points.className = "board-points";
    points.textContent = `${row.points} pt${row.points > 1 ? "s" : ""}`;

    const detail = document.createElement("span");
    detail.className = "board-detail";
    detail.textContent = `${row.right}/${row.votes}`;

    li.append(rank, name, points, detail);
    list.append(li);
  }
  return rows.length;
}

function renderPartyBoard() {
  const count = renderBoard($("score-board"));
  $("score-empty").classList.toggle("hidden", count > 0);
}

/* ------------------------------------------------------------ les votes */

function setVoteProgress(message, kind = "") {
  const el = $("vote-progress");
  el.className = `feedback ${kind}`;
  el.textContent = message;
}

/** Affiche qui a voté — et seulement cela : les paris ne quittent jamais le serveur. */
function renderVoters(voters, round) {
  const list = $("vote-voters");
  list.innerHTML = "";
  if (!round) {
    setVoteProgress("En attente du premier morceau.");
    return;
  }
  const status = describeVoters(voters, round.players);
  for (const player of round.players) {
    const li = document.createElement("li");
    const done = !status.waiting.includes(player);
    li.className = `voter ${done ? "done" : "waiting"}`;
    li.textContent = `${done ? "✅" : "…"} ${player}`;
    list.append(li);
  }
  for (const name of status.extra) {
    const li = document.createElement("li");
    li.className = "voter done extra";
    li.textContent = `✅ ${name} (hors liste)`;
    list.append(li);
  }
  setVoteProgress(
    status.complete ? `${status.text} — tout le monde a voté 🎉` : `${status.text} — on attend encore.`,
    status.complete ? "ok" : "",
  );
}

/**
 * Publie le morceau en cours pour les téléphones des joueurs. Sans effet tant que
 * rien n'a changé : le même tour n'est jamais republié deux fois.
 */
async function shareRound() {
  if (!liveEntry || !liveNow || !liveNow.known) return;
  const round = buildRound({
    entry: liveEntry, now: liveNow, sequence: liveSequence, revealed,
    bonus: $("score-rule").value !== "simple",
    board: scores.board,
  });
  if (sameRound(round, publishedRound)) return;
  publishedRound = round;
  saveLiveState(liveStateKey(liveEntry));
  try {
    const data = await publishRound(sessionCode(), round);
    renderVoters(data.voters, round);
    if (round.revealed) pollVoters();
  } catch (error) {
    publishedRound = null;
    setVoteProgress(
      error.status === 503
        ? "Vote en ligne indisponible : le stockage n'est pas configuré."
        : `Publication du tour impossible : ${error.message}`,
      "ko",
    );
  }
}

/**
 * Renvoie le tour en cours enrichi du classement : l'écran de soirée est le seul
 * à voir tous les morceaux, c'est donc lui qui fait foi sur les téléphones.
 */
async function shareBoard() {
  if (!publishedRound) return;
  const round = { ...publishedRound, board: scores.board };
  try {
    const data = await publishRound(sessionCode(), round);
    publishedRound = round;
    renderVoters(data.voters, round);
  } catch { /* le prochain tour republiera */ }
}

async function pollVoters() {
  if (!publishedRound) return;
  const code = sessionCode();
  try {
    const data = await fetchRound(code);
    if (!data.round || data.round.id !== publishedRound.id) return;
    renderVoters(data.voters, publishedRound);
    if (countRound(code, data.round, data.votes)) {
      renderPartyBoard();
      shareBoard();
    }
  } catch {
    // Sondage silencieux : l'échec de publication a déjà son message.
  }
}

function startVotersPolling() {
  if (votersTimer) return;
  votersTimer = setInterval(pollVoters, VOTERS_POLL_MS);
}

function stopVotersPolling() {
  clearInterval(votersTimer);
  votersTimer = null;
}

/* ------------------------------------------------------- écran de vote */

function loadVoteHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(VOTE_HISTORY_KEY) || "{}");
    voteHistory = stored && typeof stored === "object" ? stored : {};
  } catch {
    voteHistory = {};
  }
}

function saveVoteHistory() {
  localStorage.setItem(VOTE_HISTORY_KEY, JSON.stringify(voteHistory));
}

function setVoteFeedback(message, kind = "") {
  const el = $("vote-feedback");
  el.className = `feedback ${kind}`;
  el.textContent = message;
}

function renderVoteScore() {
  const { right, judged } = scoreVotes(Object.values(voteHistory));
  $("vote-score").className = "feedback";
  $("vote-score").textContent = judged === 0
    ? "Aucun morceau révélé pour l'instant."
    : `${right} bonne${right > 1 ? "s" : ""} réponse${right > 1 ? "s" : ""} sur ${judged} morceau${judged > 1 ? "x" : ""} révélé${judged > 1 ? "s" : ""}.`;
}

/** Boutons de vote : un par joueur, celui déjà choisi reste en évidence. */
function renderVoteChoices(round) {
  const box = $("vote-choices");
  box.innerHTML = "";
  const mine = voteHistory[round.id]?.guess || "";
  for (const player of round.players) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `choice-btn${mine === player ? " picked" : ""}`;
    button.textContent = player;
    button.disabled = round.revealed;
    button.addEventListener("click", () => sendVote(round, player));
    box.append(button);
  }
}

function renderVoteRound(round) {
  $("vote-track-title").textContent = round.title || "Morceau en cours";
  $("vote-track-artists").textContent = round.artists || "";
  $("vote-track-position").textContent = round.total ? `morceau ${round.position} sur ${round.total}` : "";
  renderVoteChoices(round);

  const answer = $("vote-answer");
  const mine = voteHistory[round.id]?.guess || "";
  if (round.revealed && round.answer) {
    const right = mine && mine.toLowerCase() === round.answer.toLowerCase();
    answer.className = `vote-answer ${mine ? (right ? "right" : "wrong") : ""}`;
    answer.textContent = mine
      ? `C'était ${round.answer} — ${right ? "bien vu 🎉" : `tu avais dit ${mine}.`}`
      : `C'était ${round.answer}. Tu n'avais pas voté.`;
    answer.classList.remove("hidden");
    if (voteHistory[round.id] && voteHistory[round.id].answer !== round.answer) {
      voteHistory[round.id].answer = round.answer;
      saveVoteHistory();
    }
    renderVoteScore();
  } else {
    answer.classList.add("hidden");
    if (mine) setVoteFeedback(`Vote enregistré : ${mine}. Tu peux encore changer d'avis.`, "ok");
    else setVoteFeedback("À toi : à qui appartient ce morceau ?");
  }
}

async function sendVote(round, guess) {
  const name = $("vote-name").value.trim();
  if (!name) return setVoteFeedback("Mets ton prénom d'abord, sinon l'organisateur ne saura pas que tu as voté.", "ko");
  localStorage.setItem(VOTE_NAME_KEY, name);
  setVoteFeedback("Envoi…");
  try {
    await castVote(voteSessionCode(), { roundId: round.id, voter: name, guess });
    voteHistory[round.id] = { guess, title: round.title, answer: voteHistory[round.id]?.answer || "" };
    saveVoteHistory();
    renderVoteChoices(round);
    setVoteFeedback(`Vote enregistré : ${guess}. Tu peux encore changer d'avis.`, "ok");
  } catch (error) {
    setVoteFeedback(error.message, "ko");
  }
}

function voteSessionCode() {
  return (parseRoute().params.get("s") || "").toUpperCase();
}

async function pollVote() {
  const code = voteSessionCode();
  if (!code) {
    setVoteFeedback("Ce lien ne contient pas de session — demande le lien de vote à l'organisateur.", "ko");
    return;
  }
  try {
    const data = await fetchRound(code);
    voteRound = data.round;
    if (!voteRound) {
      $("vote-track-title").textContent = "En attente du premier morceau…";
      $("vote-track-artists").textContent = "";
      $("vote-track-position").textContent = "";
      $("vote-choices").innerHTML = "";
      $("vote-answer").classList.add("hidden");
      setVoteFeedback("L'organisateur n'a pas encore lancé la playlist.");
      return;
    }
    renderVoteRound(voteRound);
    // Le classement de l'organisateur fait foi ; à défaut, on compte ce qu'on a vu passer.
    const shared = voteRound.board && Object.keys(voteRound.board).length > 0 ? voteRound.board : null;
    const counted = countRound(code, voteRound, data.votes);
    if (shared || counted) {
      publishedBoard = shared;
      renderVoteBoard();
    }
  } catch (error) {
    setVoteFeedback(
      error.status === 503
        ? "Vote en ligne indisponible : l'organisateur n'a pas configuré le stockage."
        : `Connexion perdue : ${error.message}`,
      "ko",
    );
  }
}

function renderVoteBoard() {
  renderBoard($("vote-board"), $("vote-name").value.trim(), publishedBoard || scores.board);
}

function openVoteView(params) {
  const party = params.get("jeu");
  $("vote-title-party").textContent = party
    ? `« ${party} » — à qui appartient ce morceau ?`
    : "À qui appartient ce morceau ?";
  const known = params.get("n") || localStorage.getItem(VOTE_NAME_KEY) || "";
  if (known) $("vote-name").value = known;
  loadVoteHistory();
  loadScores(voteSessionCode());
  renderVoteScore();
  renderVoteBoard();
  startVotePolling();
}

function startVotePolling() {
  if (voteTimer) return;
  pollVote();
  voteTimer = setInterval(pollVote, VOTE_POLL_MS);
}

function stopVote() {
  clearInterval(voteTimer);
  voteTimer = null;
  voteRound = null;
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
    const voteLink = $("player-vote-link");
    voteLink.href = voteUrl(code, submission.name);
    voteLink.classList.remove("hidden");
    localStorage.setItem(VOTE_NAME_KEY, submission.name);
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
  refreshDevices();
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
  wireControls();
  $("vote-copy").addEventListener("click", () => copy(voteUrl(), "Lien de vote copié."));
  $("vote-share").addEventListener("click", async () => {
    try {
      await navigator.share({ title: "Playlist Mixer", text: "Vote à chaque morceau :", url: voteUrl() });
    } catch { /* partage annulé */ }
  });
  $("vote-name").addEventListener("input", (event) => {
    localStorage.setItem(VOTE_NAME_KEY, event.target.value.trim());
    renderVoteBoard();
  });
  $("vote-reset").addEventListener("click", () => {
    voteHistory = {};
    saveVoteHistory();
    scores = { board: {}, counted: [] };
    saveScores(voteSessionCode());
    renderVoteScore();
    renderVoteBoard();
    if (voteRound) renderVoteRound(voteRound);
    toast("Tes paris et le classement affiché sont effacés.");
  });
  $("score-rule").addEventListener("change", (event) => {
    localStorage.setItem(SCORE_RULE_KEY, event.target.value);
    toast("Barème appliqué à partir du prochain morceau révélé.");
  });
  $("score-reset").addEventListener("click", () => {
    scores = { board: {}, counted: [] };
    saveScores(sessionCode());
    renderPartyBoard();
    toast("Classement remis à zéro.");
  });
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
  for (const id of ["invite-share", "vote-share"]) {
    $(id).classList.toggle("hidden", !navigator.share);
  }
  loadVoteHistory();
  $("score-rule").value = localStorage.getItem(SCORE_RULE_KEY) || "bonus";
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
