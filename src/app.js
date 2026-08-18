import {
  getClientId, setClientId, getRedirectUri, login, logout,
  isLoggedIn, handleRedirect,
} from "./auth.js";
import { parsePlaylistId, fetchPlaylist, getCurrentUser, createPlaylist } from "./spotify.js";
import { mix, formatDuration, toCsv } from "./mixer.js";
import { runDiagnostic, summarize } from "./diagnostic.js";

const SOURCES_KEY = "spm.sources";
const $ = (id) => document.getElementById(id);

/** @type {Array<{key:string,id:string,label:string,owner:string,image:string,url:string,tracks:Array,status:string,error?:string}>} */
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

/* ------------------------------------------------------------ persistance */

function saveSources() {
  const light = sources.map(({ id, label }) => ({ id, label }));
  localStorage.setItem(SOURCES_KEY, JSON.stringify(light));
}

function loadSavedSources() {
  try {
    return JSON.parse(localStorage.getItem(SOURCES_KEY) || "[]");
  } catch {
    return [];
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

  const repartition = result.perSource
    .filter((s) => s.count > 0)
    .map((s) => `${s.label} ${s.count}`)
    .join(" · ");
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
    id,
    label: savedLabel || "",
    name: "",
    owner: "",
    image: "",
    url: "",
    tracks: [],
    status: "loading",
  };
  sources.push(source);
  renderSources();

  try {
    const playlist = await fetchPlaylist(id);
    Object.assign(source, {
      name: playlist.name,
      owner: playlist.owner,
      image: playlist.image,
      url: playlist.url,
      tracks: playlist.tracks,
      status: "ready",
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
  const lines = $("playlist-input").value.split(/[\s,]+/).filter(Boolean);
  if (lines.length === 0) return;

  const ids = [];
  for (const line of lines) {
    const id = parsePlaylistId(line);
    if (id) ids.push(id);
    else toast(`Lien non reconnu : ${line}`, true);
  }
  $("playlist-input").value = "";
  for (const id of ids) await addPlaylistById(id);
}

/* ------------------------------------------------------------------ mix */

function handleMix() {
  const ready = readySources();
  if (ready.length < 2) {
    toast("Ajoute au moins deux playlists.", true);
    return;
  }
  const mode = $("mode").value;
  const target = mode === "duration"
    ? Number($("target-duration").value) * 60_000
    : Number($("target-count").value);

  if (!target || target <= 0) {
    toast("Indique une limite valide.", true);
    return;
  }

  currentMix = mix({
    sources: ready.map((s) => ({ key: s.key, label: s.label || s.name, tracks: s.tracks })),
    mode,
    target,
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

  const wanted = mode === "count" ? target : null;
  if (wanted && currentMix.tracks.length < wanted) {
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
    const foreignId = parsePlaylistId($("diag-foreign").value || "");
    const results = await runDiagnostic(foreignId);
    for (const result of results) {
      const li = document.createElement("li");
      li.className = result.ok ? "ok" : "ko";
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = result.ok ? "✅" : "❌";
      const text = document.createElement("span");
      text.innerHTML = "";
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
  $("client-id").addEventListener("change", (event) => {
    setClientId(event.target.value);
    toast("Client ID enregistré.");
  });
  $("copy-redirect").addEventListener("click", async () => {
    await navigator.clipboard.writeText(getRedirectUri());
    toast("URL de redirection copiée.");
  });
  $("login-btn").addEventListener("click", () => {
    login().catch((error) => toast(error.message, true));
  });
  $("logout-btn").addEventListener("click", () => {
    logout();
    me = null;
    refreshUser();
    toast("Déconnecté.");
  });
  $("add-playlists").addEventListener("click", () => {
    handleAddPlaylists().catch((error) => toast(error.message, true));
  });
  $("mode").addEventListener("change", (event) => {
    const isDuration = event.target.value === "duration";
    $("duration-field").classList.toggle("hidden", !isDuration);
    $("count-field").classList.toggle("hidden", isDuration);
  });
  $("diag-run").addEventListener("click", handleDiagnostic);
  $("mix-btn").addEventListener("click", handleMix);
  $("create-btn").addEventListener("click", handleCreate);
  $("download-csv").addEventListener("click", handleDownloadCsv);
  $("toggle-answers").addEventListener("click", (event) => {
    const table = $("result-table");
    const hidden = table.classList.toggle("answers-hidden");
    event.target.textContent = hidden ? "Afficher les réponses" : "Masquer les réponses";
  });
}

async function start() {
  $("redirect-uri").value = getRedirectUri();
  $("client-id").value = getClientId();
  wireEvents();

  try {
    if (await handleRedirect()) toast("Connexion réussie 👋");
  } catch (error) {
    toast(error.message, true);
  }

  await refreshUser();

  if (isLoggedIn()) {
    for (const saved of loadSavedSources()) await addPlaylistById(saved.id, saved.label);
  }
}

start();
