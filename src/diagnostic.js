import { api } from "./spotify.js";

/**
 * Teste un par un les appels dont l'app a besoin et rapporte ce que Spotify
 * autorise réellement pour cette application. Chaque étape est indépendante :
 * un échec n'interrompt pas les suivantes.
 */
export async function runDiagnostic(foreignPlaylistId) {
  const results = [];
  const step = async (label, run) => {
    try {
      results.push({ label, ok: true, detail: (await run()) || "OK" });
    } catch (error) {
      results.push({ label, ok: false, detail: error.message });
    }
    return results[results.length - 1].ok;
  };

  let ownPlaylistId = null;
  let sampleUri = null;
  let createdId = null;

  await step("Identité du compte connecté", async () => {
    const me = await api("/me");
    return `${me.display_name || me.id} (${me.product || "produit inconnu"})`;
  });

  await step("Lister tes playlists", async () => {
    const page = await api("/me/playlists?limit=50");
    const mine = (page.items || []).find((p) => p.tracks?.total > 0) || page.items?.[0];
    if (!mine) throw new Error("Aucune playlist trouvée sur ce compte.");
    ownPlaylistId = mine.id;
    return `${page.items.length} playlist(s), test sur « ${mine.name} »`;
  });

  if (ownPlaylistId) {
    await step("Lire les morceaux d'une de TES playlists", async () => {
      const page = await api(`/playlists/${ownPlaylistId}/items?limit=1`);
      const entry = (page.items || [])[0];
      const track = entry?.item ?? entry?.track;
      sampleUri = track?.uri || null;
      return track ? `1er morceau : ${track.name}` : "Playlist vide, mais lecture autorisée";
    });
  }

  if (foreignPlaylistId) {
    await step("Lire les métadonnées d'une playlist d'AUTRUI", async () => {
      const meta = await api(`/playlists/${foreignPlaylistId}?fields=name,owner(display_name)`);
      return `« ${meta.name} » de ${meta.owner?.display_name || "?"}`;
    });

    await step("Lire les MORCEAUX d'une playlist d'AUTRUI ⭐", async () => {
      const page = await api(`/playlists/${foreignPlaylistId}/items?limit=1`);
      const entry = (page.items || [])[0];
      const track = entry?.item ?? entry?.track;
      if (!track) throw new Error("Réponse vide : morceaux non communiqués.");
      return `Autorisé — 1er morceau : ${track.name}`;
    });
  }

  await step("Créer une playlist sur ton compte", async () => {
    const created = await api("/me/playlists", {
      method: "POST",
      body: JSON.stringify({
        name: "Test Playlist Mixer (supprimable)",
        description: "Playlist de test créée par le diagnostic.",
        public: false,
      }),
    });
    createdId = created.id;
    return "Playlist de test créée";
  });

  if (createdId && sampleUri) {
    await step("Ajouter un morceau à une playlist", async () => {
      await api(`/playlists/${createdId}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: [sampleUri] }),
      });
      return "Ajout autorisé";
    });
  }

  if (createdId) {
    await step("Nettoyage (retrait de la playlist de test)", async () => {
      await api(`/playlists/${createdId}/followers`, { method: "DELETE" });
      return "Playlist de test retirée de ta bibliothèque";
    });
  }

  return results;
}

/** Verdict lisible à partir des résultats. */
export function summarize(results) {
  const foreign = results.find((r) => r.label.includes("AUTRUI ⭐"));
  if (!foreign) {
    return "Ajoute le lien d'une playlist publique d'un ami pour tester le point décisif.";
  }
  return foreign.ok
    ? "✅ Ton app lit les playlists des autres : colle directement leurs liens, aucune copie manuelle nécessaire."
    : "❌ Ton app ne lit que tes propres playlists : duplique celles des joueurs dans ton compte (Ctrl+A → Ajouter à la playlist → Nouvelle playlist).";
}
