import {
  getClientId, setClientId, getRedirectUri, login, logout,
  isLoggedIn, handleRedirect, getRefreshToken, hasBuiltInClientId,
} from "./auth.js";
import { parsePlaylistId, parseSubmissionLine, fetchPlaylist, getCurrentUser, createPlaylist } from "./spotify.js";
import { mix, formatDuration, toCsv } from "./mixer.js";
import { runDiagnostic, summarize } from "./diagnostic.js";
import { qrToSvg } from "./qr.js";

const SOURCES_KEY = "spm.sources";
const PARTY_KEY = "spm.party";
const RETURN_KEY = "spm.return";
const $ = (id) => document.getElementById(id);

/** @type {Array<{key:string,id:string,label:string,name:string,owner:string,image:string,url:string,tracks:Array,status:string,error?:string}>} */
let sources = [];
let currentMix = null;
let me = null;

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

const VIEWS = ["accueil", "organisateur", "joueur"];

/** Découpe `#/joueur?jeu=Soirée` en nom de vue + paramètres. */
function parseRoute() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const name = VIEWS.includes(path) ? path : "accueil";
  return { name, params: new URLSearchParams(query || "") };
}

function showView() {
  const { name, params } = parseRoute();
  for (const view of VIEWS) $(`view-${view}`).classList.toggle("hidden", view !== name);
  $("auth-zone").classList.toggle("hidden", name !== "organisateur");
  window.scrollTo(0, 0);

  if (name === "organisateur") refreshInvite();
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

/* --------------------------------------------------------------- invitation */

function playerUrl() {
  const party = $("invite-name").value.trim();
  const query = party ? `?jeu=${encodeURIComponent(party)}` : "";
  return `${getRedirectUri()}#/joueur${query}`;
}

function refreshInvite() {
  const url = playerUrl();
  $("invite-link").value = url;
  try {
    $("invite-qr").innerHTML = qrToSvg(url, { size: 200 });
  } catch (error) {
    $("invite-qr").textContent = error.message;
  }
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
      refreshMixButton();
    });
    li.append(remove);

    list.append(li);
  }
}

function readySources() {
  return sources.filter((s) => s.status === "ready" && s.tracks.length > 0);
}

function refreshMixButton() {
  $("mix-btn").disabled = readySources().length < 2 || !isLoggedIn();
}

function renderResult(result) {
  const tbody = $("result-table").querySelector("tbody");
  tbody.innerHTML = "";
  for (const track of result.tracks) {
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
    const link = $("playlist-link");
    link.href = playlist.url;
    link.classList.remove("hidden");
    toast("Playlist créée sur ton compte Spotify 🎉");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Créer la playlist sur Spotify";
  }
}

function handleDownloadCsv() {
  if (!currentMix) return;
  const blob = new Blob(["﻿" + toCsv(currentMix.tracks)], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "corrige-blind-test.csv";
  link.click();
  URL.revokeObjectURL(link.href);
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
  $("toggle-answers").addEventListener("click", (event) => {
    const hidden = $("result-table").classList.toggle("answers-hidden");
    event.target.textContent = hidden ? "Afficher les réponses" : "Masquer les réponses";
  });

  for (const id of ["player-name", "player-playlist"]) {
    $(id).addEventListener("input", refreshPlayerFeedback);
  }
  $("player-share").addEventListener("click", handlePlayerShare);
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
