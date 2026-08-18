import { getAccessToken } from "./auth.js";

const API = "https://api.spotify.com/v1";

export async function api(path, options = {}, attempt = 0) {
  const token = await getAccessToken();
  const response = await fetch(path.startsWith("http") ? path : API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (response.status === 429 && attempt < 3) {
    const wait = (Number(response.headers.get("Retry-After")) || 2) * 1000;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return api(path, options, attempt + 1);
  }

  if (response.status === 204) return null;

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Depuis mars 2026, les apps en « Development Mode » ne peuvent lire le contenu
    // que des playlists dont l'utilisateur connecté est propriétaire ou collaborateur.
    if (response.status === 403) {
      throw new Error(
        data?.error?.message
          ? `Refusé par Spotify (403) : ${data.error.message}`
          : "Refusé par Spotify (403) — en mode développement, une app ne peut lire que les playlists dont tu es propriétaire ou collaborateur.",
      );
    }
    throw new Error(data?.error?.message || `Erreur Spotify (${response.status}).`);
  }
  return data;
}

/** Extrait l'ID d'une URL, d'un URI `spotify:playlist:…` ou d'un ID brut. */
export function parsePlaylistId(raw) {
  const value = raw.trim();
  if (!value) return null;
  const uri = value.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uri) return uri[1];
  const url = value.match(/playlist\/([A-Za-z0-9]+)/);
  if (url) return url[1];
  if (/^[A-Za-z0-9]{16,}$/.test(value)) return value;
  return null;
}

export function getCurrentUser() {
  return api("/me");
}

/** Métadonnées + tous les morceaux jouables d'une playlist publique. */
export async function fetchPlaylist(playlistId) {
  const meta = await api(`/playlists/${playlistId}?fields=id,name,owner(display_name),images,external_urls`);

  // `/items` (et `item` au lieu de `track`) depuis la migration Web API de février 2026 ;
  // `/tracks` renvoie désormais 403.
  const fields = [
    "next",
    "items(item(id,uri,name,duration_ms,is_local,type,is_playable,artists(name)))",
  ].join(",");
  let url = `${API}/playlists/${playlistId}/items?limit=100&fields=${encodeURIComponent(fields)}`;
  const tracks = [];

  while (url) {
    const page = await api(url);
    for (const entry of page.items || []) {
      const track = entry.item ?? entry.track;
      // On écarte les épisodes de podcast, les fichiers locaux et les pistes indisponibles.
      if (!track || track.is_local || track.type !== "track" || !track.uri || !track.id) continue;
      if (track.is_playable === false) continue;
      tracks.push({
        id: track.id,
        uri: track.uri,
        name: track.name,
        durationMs: track.duration_ms || 0,
        artists: (track.artists || []).map((a) => a.name).join(", "),
      });
    }
    url = page.next;
  }

  return {
    id: meta.id,
    name: meta.name,
    owner: meta.owner?.display_name || "",
    image: meta.images?.[0]?.url || "",
    url: meta.external_urls?.spotify || `https://open.spotify.com/playlist/${meta.id}`,
    tracks,
  };
}

/**
 * Crée la playlist dans le compte connecté et y pousse les morceaux par lots de 100.
 * `POST /users/{id}/playlists` a été retiré en février 2026 : on passe par `/me/playlists`.
 */
export async function createPlaylist({ name, description, isPublic, uris }) {
  const playlist = await api("/me/playlists", {
    method: "POST",
    body: JSON.stringify({ name, description, public: isPublic }),
  });

  for (let i = 0; i < uris.length; i += 100) {
    await api(`/playlists/${playlist.id}/items`, {
      method: "POST",
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
  }

  return {
    id: playlist.id,
    url: playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`,
  };
}
