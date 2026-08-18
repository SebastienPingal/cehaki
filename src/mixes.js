// Playlists générées et mémorisées : logique pure, aucun accès au stockage ni au réseau.

export const MAX_MIXES = 10;

/**
 * Fiche d'une playlist créée sur Spotify : de quoi rejouer la soirée sans remélanger.
 * @param {object} options
 * @param {{id:string,url:string}} options.playlist playlist créée sur Spotify
 * @param {{tracks:Array,totalMs:number}} options.mix résultat du mélange
 * @param {Array<{id:string,label:string,name:string}>} options.sources playlists mélangées
 */
export function createEntry({ playlist, name, mix, sources, settings, now = Date.now() }) {
  return {
    id: playlist.id,
    url: playlist.url,
    name,
    createdAt: now,
    totalMs: mix.totalMs,
    settings: settings || {},
    sources: sources.map((source) => ({
      id: source.id,
      label: source.label || source.name || "",
    })),
    tracks: mix.tracks.map(({ id, name: title, artists, durationMs, sourceLabel, position }) => ({
      id, name: title, artists, durationMs, sourceLabel, position,
    })),
  };
}

/** Ajoute la fiche en tête, sans doublon d'identifiant, et borne l'historique. */
export function insertEntry(list, entry, max = MAX_MIXES) {
  return [entry, ...list.filter((item) => item.id !== entry.id)].slice(0, max);
}

export function removeEntry(list, id) {
  return list.filter((item) => item.id !== id);
}

/**
 * Compare les sources d'une playlist générée à celles chargées maintenant :
 * une playlist reçue après coup rend le mix incomplet.
 * @returns {{upToDate:boolean, added:Array<{id:string,label:string}>, removed:Array}}
 */
export function compareSources(entry, currentSources) {
  const mixed = new Set((entry.sources || []).map((source) => source.id));
  const present = new Set(currentSources.map((source) => source.id));
  const added = currentSources
    .filter((source) => !mixed.has(source.id))
    .map((source) => ({ id: source.id, label: source.label || source.name || "" }));
  const removed = (entry.sources || []).filter((source) => !present.has(source.id));
  return { upToDate: added.length === 0, added, removed };
}

const namesOf = (list) => list.map((source) => source.label || "sans nom").join(", ");

/** Phrase affichée sous une playlist générée : à jour, ou ce qui lui manque. */
export function describeFreshness(entry, currentSources) {
  const { upToDate, added } = compareSources(entry, currentSources);
  const players = (entry.sources || []).length;
  const base = `${entry.tracks.length} morceaux · ${players} joueur${players > 1 ? "s" : ""}`;
  if (upToDate) return { upToDate, text: `${base} · à jour` };
  return {
    upToDate,
    text: `${base} · ⚠️ ${added.length} playlist${added.length > 1 ? "s" : ""} reçue${added.length > 1 ? "s" : ""} depuis (${namesOf(added)}) — remélange pour l'inclure${added.length > 1 ? "s" : ""}`,
  };
}

export function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString("fr-FR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
