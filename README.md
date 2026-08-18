# 🎧 Playlist Mixer

Une page unique, sans serveur, qui **mélange plusieurs playlists Spotify publiques** en une seule
playlist créée dans ton compte.

Le jeu : chaque joueur fait une playlist publique de son top 100. On mixe tout, on lance la playlist,
et on devine **à qui appartient chaque morceau**. L'app garde le corrigé de son côté.

## Ce que ça fait

- Ajout de playlists par lien (`open.spotify.com/playlist/…` ou `spotify:playlist:…`), plusieurs d'un coup.
- Chaque playlist est étiquetée avec un **nom de joueur** modifiable.
- Limite au choix : **nombre de morceaux** ou **durée totale**.
- Répartition **équitable** (autant de morceaux par joueur, même si les playlists ont des tailles différentes)
  ou **proportionnelle** à la taille des playlists.
- Les morceaux présents dans **plusieurs** playlists sont écartés par défaut : ils sont indevinables.
- Deux morceaux du même joueur ne se suivent pas (dans la mesure où les quotas le permettent).
- Création de la playlist dans ton compte Spotify, publique ou privée.
- **Corrigé** consultable, masquable et exportable en CSV.

## Mise en route (5 minutes)

1. Va sur le [dashboard développeur Spotify](https://developer.spotify.com/dashboard) → *Create app*.
   Un compte Spotify gratuit suffit.
2. Dans les réglages de l'app, ajoute la **Redirect URI** correspondant à l'endroit où tu ouvres la page :
   - GitHub Pages : `https://sebastienpingal.github.io/cehaki/`
   - en local : `http://127.0.0.1:4173/`

   Coche *Web API* comme API utilisée.
3. Copie le **Client ID** de l'app et colle-le dans le champ prévu sur la page. Il est stocké dans
   ton navigateur uniquement.
4. Clique sur **Se connecter à Spotify**, puis ajoute les playlists.

## ⚠️ Les limites du mode développement Spotify (depuis 2026)

Une app Spotify neuve démarre en **Development Mode**, et Spotify l'a nettement restreint en 2026 :

- le propriétaire de l'app doit avoir un abonnement **Premium actif** ;
- **5 utilisateurs** maximum, à déclarer un par un dans *User Management* ;
- surtout : le contenu d'une playlist n'est lisible que si l'utilisateur connecté en est
  **propriétaire ou collaborateur**. La doc de [Get Playlist][doc] le dit noir sur blanc à propos du
  champ `items` : *« This field is only available for playlists owned by the current user or playlists
  the user is a collaborator of. »* Le statut public/privé n'y change rien — c'est un réglage de
  visibilité dans l'appli, pas une permission d'API. Les playlists des autres ne renvoient que leurs
  métadonnées (nom, propriétaire, pochette).

[doc]: https://developer.spotify.com/documentation/web-api/reference/get-playlist

Le *Extended Quota Mode*, qui lève tout ça, n'est plus accordé qu'à des entités commerciales
enregistrées d'au moins 250 000 utilisateurs mensuels — hors de portée d'un projet perso.

La page inclut un **diagnostic** (section 0, « qu'est-ce que mon app a le droit de faire ? ») qui teste
ces limites sur ton propre compte : lecture de tes playlists, lecture d'une playlist d'autrui, création,
ajout de morceaux. En dix secondes tu sais si tu dois passer par une copie manuelle ou non.

### Tester la piste « token d'application »

Le flow **Client Credentials** (client ID + secret, sans utilisateur connecté) est une autre porte
d'entrée : sans « current user », la restriction ci-dessus n'a plus de sujet. C'est ainsi que
fonctionne [GuessSong](https://github.com/Waynting/GuessSong), qui importe des playlists publiques
sans jamais faire signer les joueurs. Reste à savoir si ça tient pour une app récente en mode
développement — ce script le dit :

```bash
SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy \
  npm run check:credentials -- https://open.spotify.com/playlist/…   # playlist d'un ami
```

Si les morceaux remontent, un petit backend (fonction serverless gardant le secret) supprime toute
copie manuelle : lecture des playlists par token d'application, création de la playlist finale par
ton login utilisateur. Sinon, la contrainte est structurelle et il faut posséder les playlists.

**Conséquence pratique** : ne demande pas aux joueurs le lien de leur playlist. Crée à la place une
playlist **collaborative** par joueur depuis ton propre compte, envoie-leur le lien, et laisse-les y
déposer leurs morceaux. Les playlists t'appartiennent, l'app peut donc les lire, et les joueurs n'ont
ni compte développeur ni connexion à faire.

### En local

```bash
npm run dev     # sert la page sur http://127.0.0.1:4173/
npm test        # tests de la logique de mélange
```

Aucune dépendance, aucun build : du HTML/CSS/JS modules servis tels quels.

### Publier sur GitHub Pages

*Settings → Pages → Source : GitHub Actions*. Le workflow `.github/workflows/pages.yml` déploie à
chaque push sur `main`. Pense à ajouter l'URL publiée comme Redirect URI dans le dashboard Spotify.

## Comment se déroule une partie

1. Depuis ton compte, crée une playlist **collaborative** par joueur (« Top 100 — Alice », …) et
   envoie à chacun son lien d'invitation. Chacun y dépose ses morceaux depuis son appli Spotify.
2. Tu colles ces liens dans l'app et tu nommes chaque source avec le prénom du joueur.
3. Tu choisis 60 morceaux (ou 90 minutes), répartition équitable, et tu mixes.
4. Tu crées la playlist, tu la lances **sans lecture aléatoire** (l'ordre est déjà mélangé, et le
   corrigé suit cet ordre).
5. À chaque morceau, chacun écrit son pari. Le corrigé CSV sert de feuille de score.

Variante : 1 point par bonne réponse, 2 points si personne d'autre ne trouve.

## Sous le capot

| Fichier | Rôle |
|---|---|
| `index.html` | la page entière |
| `src/auth.js` | OAuth Spotify en **Authorization Code + PKCE** (aucun secret, tout dans le navigateur) |
| `src/spotify.js` | appels Web API (endpoints `/items` et `/me/playlists` post-migration 2026) : lecture paginée, création, ajout par lots de 100 |
| `src/mixer.js` | logique pure du mélange (quotas pondérés, anti-répétition, doublons) |
| `src/diagnostic.js` | teste une à une les permissions réelles de l'app Spotify |
| `src/app.js` | glue UI |
| `test/mixer.test.mjs` | tests de `mixer.js` (`node --test`) |

Le mélange utilise une file d'attente pondérée : chaque joueur annonce la « date » de son prochain
morceau — `(déjà pris + 1) / poids` — et le plus tôt passe. Les quotas sont donc respectés à tout
moment de la playlist, pas seulement à la fin, ce qui permet de couper où on veut.

## Vie privée

Aucun serveur, aucune donnée envoyée ailleurs que chez Spotify. Le Client ID, les jetons et la liste
des playlists restent dans le `localStorage` de ton navigateur.

## Licence

MIT
