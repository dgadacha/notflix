<p align="center">
  <img src="notflix-web/public/notflix-logo.svg" alt="Notflix" width="96"/>
</p>

<h1 align="center">Notflix</h1>

<p align="center">
  Une app de streaming auto-hébergée façon Netflix — films &amp; séries (live-action).
  <br/>
  TMDB pour le catalogue · Prowlarr pour la recherche torrent · TorBox pour le débridage et la lecture directe · ffmpeg pour le HLS transmux à la demande.
</p>

<p align="center">
  <a href="https://github.com/dgadacha/notflix"><img alt="GitHub" src="https://img.shields.io/badge/github-dgadacha/notflix-181717?logo=github"/></a>
  <img alt="Go" src="https://img.shields.io/badge/go-1.23%2B-00ADD8?logo=go"/>
  <img alt="React" src="https://img.shields.io/badge/react-19-149ECA?logo=react"/>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue"/>
</p>

---

## Concept

Notflix est une UI Netflix-like (hero rotatif, rails de films, modale détail,
liste d'épisodes par saison, profils « Qui regarde ? », bottom tab mobile, rail
« Reprendre la lecture »…) au-dessus d'un pipeline simple :

1. **TMDB** fournit le catalogue (films + séries, métadonnées, images, recommandations) — clé API gratuite, proxifiée côté backend.
2. **Prowlarr** est interrogé pour trouver des sources torrent quand on clique « Lecture ». Le backend filtre par titre, score par qualité/langue/seeders/cache TorBox.
3. **TorBox** (debrid commercial) prend le magnet, le télécharge sur ses serveurs, et expose une URL HTTP directe.
4. **ffmpeg + HLS** côté backend transcode à la volée pour les codecs audio que le navigateur ne sait pas décoder (DDP / DTS / TrueHD). Chunks générés à la demande → seek arbitraire, durée totale connue immédiatement.

Pas de plugin de streaming bricolé, pas de scraper anti-bot, pas de player custom : du natif HTML5 + hls.js + des services qui font déjà bien leur boulot.

```
┌──────────┐    ┌──────────────────────┐    ┌───────────────────────────┐
│ Browser  │ ←→ │ Notflix (Go+web)     │ ←→ │ TMDB · TorBox             │
│ React UI │    │ /api/v1/* proxy      │    │ Prowlarr (Docker local)   │
│ + hls.js │    │ ffmpeg HLS transmux  │    │ ffmpeg, ffprobe           │
└──────────┘    └──────────────────────┘    └───────────────────────────┘
```

## Stack

| Couche | Tech |
|---|---|
| Backend | Go 1.23+, Echo, GORM/SQLite, binaire unique avec frontend embarqué via `//go:embed` |
| Frontend | React 19 + TanStack Router + Tailwind + Jotai + React Query + hls.js, bundle Rsbuild |
| API externes | TMDB v3 · TorBox v1 · Prowlarr v1 |
| Recherche | Prowlarr meta-indexer (Torznab) + FlareSolverr (résolution Cloudflare) |
| Transcoding | ffmpeg + ffprobe (en `$PATH` côté backend, marche sur n'importe quel OS) |
| Conteneurisation | Dockerfile multi-stage (Node → Go → Debian-slim) |

## Fonctionnalités

**Browse**
- Home : hero rotatif (films trending hebdo), 7 rails TMDB (films & séries, plusieurs catégories) + rail « Reprendre la lecture » en tête si le profil actif a des entries en cours
- `/categories` : grille des genres TMDB avec tuiles gradient, switch Films ↔ Séries, **infinite scroll** sur la grille d'un genre
- `/search` : recherche multi (films + séries), **infinite scroll**
- `/lists` : onglets *Ma liste* / *Historique*, optimistic updates partout

**Modale détail**
- Banner, synopsis, genres, score, année, durée (films) ou nombre de saisons (séries)
- Bouton **Lecture** (skip le modal pour les hero CTA)
- Pour les séries : liste d'épisodes façon Netflix (thumbnails TMDB `still_path`, titre, durée, synopsis), dropdown saison
- Bouton **+ / ✓ Ma liste** (toggle, optimistic update)
- Sélecteurs **Qualité** (Auto/4K/1080p/720p/SD) et **Langue** (Auto/FR/VO), persistés en localStorage

**Lecture (`/watch`)**
- Pipeline : Prowlarr search → filter pertinence titre → score (cache TorBox × 10 000 + seeders + bonus codec/langue/qualité) → auto-pick #1 → TorBox /play → ffprobe codec + durée → `<video>` natif (AAC) ou HLS via hls.js (codec exotique)
- Auto-fallback 3× sur la release suivante si TorBox refuse (BOZO_TORRENT, etc.)
- Bouton « Changer de source » pour overrider à la main
- Picture-in-Picture automatique au changement d'onglet
- Resume avec la **même release** que la session précédente (release persistée dans le history)

**Profils**
- Picker « Qui regarde ? » à l'arrivée, jusqu'à 6 profils (emoji + couleur)
- Gate dans le layout : redirect vers `/profiles` si profile-having user n'en a pas sélectionné
- Watch history per-profile : poll `<video>` toutes les 5 s + sur `pagehide`/`beforeunload`
- Liste per-profile (Ma liste)
- Tout est en base SQLite côté backend, survit aux changements de device

**Performance**
- Cache disque pour les images TMDB (`~/.notflix-data/cache/tmdb-img/`), `Cache-Control: immutable`
- Cache mémoire pour les searches Prowlarr (TTL 1 h)
- Pre-fetch Prowlarr au hover des cards (300 ms threshold)
- ffprobe unifié : un seul appel pour codec + durée, le résultat est partagé entre `/torbox/play` et `/stream/hls/start`

## État actuel

Tout ce qui est listé ci-dessus est livré. Ce qui reste à faire :

- [ ] i18n cleanup — quelques chaînes héritées (`anime`, `épisode`) à corriger dans `en.json` / `fr.json`
- [ ] Déploiement k8s + Cloudflare Tunnel (Dockerfile + manifests à finaliser)

## Pré-requis locaux

| Dépendance | Pourquoi | Comment |
|---|---|---|
| Go 1.23+ | Backend | `brew install go` |
| Node 20+ + npm | Frontend dev | `brew install node` |
| ffmpeg + ffprobe | Transcoding audio + sondage codec/durée | `brew install ffmpeg` |
| Docker Desktop | Prowlarr + FlareSolverr | [docker.com](https://www.docker.com/products/docker-desktop/) |
| Compte TMDB | Clé API gratuite | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) |
| Compte TorBox | Debrid (payant, ~3 €/mois) | [torbox.app](https://torbox.app) |

## Setup

Deux chemins selon ton goût d'ops :

- **Setup A — bundle** : une seule image Docker qui contient Notflix + Prowlarr + FlareSolverr. `docker run` unique, un seul container à monitorer. Voir [Quick start avec le bundle](#quick-start-avec-le-bundle).
- **Setup B — manuel** : trois containers séparés (Notflix + Prowlarr + FlareSolverr), plus de flexibilité mais 3× le tooling. Voir [Setup manuel](#setup-manuel) plus bas.

---

## Quick start avec le bundle

Le bundle empaquette Notflix + Prowlarr + FlareSolverr dans une seule image (~700-900 MB compressée, ~400 MB RAM idle). Idéal pour homelab.

### Build + run en local

```sh
git clone https://github.com/dgadacha/notflix.git
cd notflix

make docker-bundle           # build l'image (5-8 min cold, à cause de Chromium)
make docker-bundle-run       # lance avec ports 43212 + 9696 exposés
```

Une fois `[bundle] children: …` dans les logs, ouvre :

- **Notflix**  → http://localhost:43212
- **Prowlarr** → http://localhost:9696

Au premier boot Prowlarr te demande un mot de passe. Ensuite :

1. Récupère l'API key Prowlarr (Settings → General → API Key)
2. Va dans Prowlarr → Settings → Indexers → "+" → **FlareSolverr** → URL `http://127.0.0.1:8191` → Apply
3. Va dans Notflix → /settings → colle l'API key Prowlarr + tes clés TMDB + TorBox
4. Bouton "Tester les connexions" → tout doit être vert

### Déploiement k8s

Le bundle a ses propres manifests dans `k8s/bundle/`. Namespace dédié `notflix-bundle` pour cohabiter avec un éventuel déploiement single-service existant.

```sh
make deploy-bundle           # build + push + apply manifests + rollout
make bundle-logs             # logs en live avec préfixes [notflix]/[prowlarr]/[flaresolverr]
make bundle-prowlarr-ui      # port-forward Prowlarr sur localhost:9696
```

### Migration depuis un setup existant

Si tu as déjà Notflix + Prowlarr en containers séparés (k8s ou Docker), le script `k8s/bundle/migrate.sh` copie tes données dans le PVC du bundle :

```sh
# k8s → k8s
bash k8s/bundle/migrate.sh \
  --prowlarr-pvc prowlarr-config \
  --prowlarr-ns media

# Docker volume → k8s
bash k8s/bundle/migrate.sh \
  --prowlarr-volume prowlarr_config

# Skip Prowlarr (juste migrer Notflix)
bash k8s/bundle/migrate.sh --skip-prowlarr
```

Le script scale down l'ancien deployment, spin des pods "tar pump" temporaires dans chaque namespace, et stream les données via `kubectl exec | tar`. Aucune copie locale, aucun snapshot à manager.

Détails : voir `docker/bundle/README.md`.

---

## Setup manuel

### 1. Cloner

```sh
git clone https://github.com/dgadacha/notflix.git
cd notflix
```

### 2. Lancer Prowlarr + FlareSolverr (Docker local)

```sh
docker run -d --name flaresolverr \
  --restart=unless-stopped \
  -p 8191:8191 \
  ghcr.io/flaresolverr/flaresolverr:latest

docker run -d --name prowlarr \
  --restart=unless-stopped \
  -p 9696:9696 \
  -v $HOME/.notflix-data/prowlarr:/config \
  lscr.io/linuxserver/prowlarr:latest
```

Une fois Prowlarr lancé sur <http://127.0.0.1:9696> :

1. **Settings → General → Authentication** = `Disabled (for local addresses)` et **Authentication Required** = `Disabled for local addresses` (sinon le backend Go n'arrive plus à appeler l'API).
2. **Settings → Indexers** → ajouter des indexers (`1337x`, `EZTV`, `LimeTorrents`, `Torrent9`, `World-torrent`, `YTS`…). Notflix fetche le `.torrent` côté serveur quand l'indexer n'expose pas de magnet direct.
3. **Settings → Indexers → Indexer Proxies** → ajouter un proxy `FlareSolverr` pointant sur `http://host.docker.internal:8191`. Sans ça, les indexers Cloudflare-gated (Torrent9 entre autres) sont injoignables.
4. **Settings → General → API Key** → copier la valeur (UUID 32 char), elle ira dans `.env`.

### 3. Créer le fichier `.env`

À la racine du projet :

```env
NOTFLIX_TMDB_API_KEY=<votre clé v3 TMDB>
NOTFLIX_TORBOX_API_KEY=<votre clé TorBox>
NOTFLIX_PROWLARR_URL=http://127.0.0.1:9696
NOTFLIX_PROWLARR_API_KEY=<votre API key Prowlarr>
```

`.env` est gitignored. Le `Makefile` le source automatiquement quand vous lancez `make dev`.

### 4. Lancer

```sh
make dev
```

- Frontend  → <http://127.0.0.1:43210> (Rsbuild dev server, hot reload)
- Backend   → <http://127.0.0.1:43212>

Le frontend proxifie `/api/*` vers le backend, donc tout passe par `:43210` en dev.

### 5. Vérifier que tout est branché

```sh
curl http://127.0.0.1:43212/api/v1/status            # { app, tmdbKeySet }
curl http://127.0.0.1:43212/api/v1/torbox/status     # { configured, email, plan, … }
curl http://127.0.0.1:43212/api/v1/prowlarr/status   # { configured, version, enabledIndexers }
```

Les trois doivent renvoyer `configured: true` ou la clé correspondante non vide.

## Build production

```sh
make build      # bundle React → web/ → binaire Go `./notflix`
make run        # idem + lance
make clean      # vide les artefacts (`web/`, `notflix`, `notflix-web/out`)
```

Le binaire final embarque le frontend via `//go:embed all:web`. Une seule binaire, un seul port, déployable n'importe où. ffmpeg + ffprobe doivent rester accessibles dans le `$PATH` du serveur.

## Architecture

```
.
├── main.go                              # Entrypoint Echo (16 lignes)
├── internal/
│   ├── core/                            # Config + DB + DI container
│   ├── handlers/                        # Routes /api/v1/* (Echo)
│   │   ├── routes.go                    # Mapping URL → handler
│   │   ├── tmdb_proxy.go                # Proxy transparent JSON TMDB
│   │   ├── tmdb_image.go                # Cache disque des images TMDB
│   │   ├── torbox.go                    # cache/play/list/delete + ffprobe codec
│   │   ├── prowlarr.go                  # search + scoring + title-relevance + cache 1h
│   │   ├── stream.go                    # /stream/transmux (Matroska pipe)
│   │   ├── hls.go                       # /stream/hls (on-demand chunk transcoding)
│   │   └── profiles.go                  # CRUD profils + watch history + list
│   ├── tmdb/                            # Client HTTP + cache 30 s
│   ├── torbox/                          # Client TorBox
│   ├── prowlarr/                        # Client REST + helpers movie/tv
│   └── database/                        # GORM models + migrations
├── notflix-web/                         # React app
│   ├── src/
│   │   ├── app/(main)/
│   │   │   ├── _features/netflix/       # Composants UI Netflix-style
│   │   │   │   ├── netflix-home.tsx
│   │   │   │   ├── netflix-hero.tsx
│   │   │   │   ├── netflix-card.tsx     # + hover-prefetch Prowlarr
│   │   │   │   ├── netflix-row.tsx
│   │   │   │   ├── netflix-detail-modal.tsx  # synopsis, Ma liste, ep list, prefs
│   │   │   │   ├── netflix-categories.tsx    # grille de genres + infinite scroll
│   │   │   │   ├── netflix-search.tsx        # multi + infinite scroll
│   │   │   │   ├── netflix-lists.tsx         # Ma liste + Historique
│   │   │   │   ├── netflix-continue-watching.tsx  # rail "Reprendre"
│   │   │   │   ├── netflix-watch-history-saver.tsx # poll 5s → backend
│   │   │   │   ├── netflix-profile-picker.tsx
│   │   │   │   ├── netflix-top-bar.tsx
│   │   │   │   ├── netflix-bottom-tab.tsx
│   │   │   │   └── …
│   │   │   ├── categories/page.tsx
│   │   │   ├── lists/page.tsx
│   │   │   ├── search/page.tsx
│   │   │   ├── profiles/page.tsx
│   │   │   ├── settings/page.tsx
│   │   │   └── watch/page.tsx           # state machine + HLS / direct stream
│   │   ├── lib/
│   │   │   ├── tmdb.ts                  # Hooks React Query, useInfiniteDiscover…
│   │   │   ├── notflix-api.ts           # Hooks TorBox + Prowlarr + prefetch
│   │   │   ├── preferences.ts           # Quality / Audio / feature-detect codecs
│   │   │   └── profiles/                # CRUD profils côté client (optimistic)
│   │   └── routes/                      # TanStack Router file-based
│   └── rsbuild.config.ts                # Bundler + proxy /api → :43212
├── Makefile                             # make dev / build / run / clean
├── .env                                 # secrets locaux (gitignored)
└── CLAUDE.md                            # contexte pour les agents Claude Code
```

### Flow de lecture (`/watch?id=…&type=movie`)

1. **Search** — Prowlarr est interrogé pour `(title, year)`. Filtre côté backend : `filterByTitleRelevance` drop les résultats hors-sujet (phrase match strict pour les titres courts). Cache 1 h en mémoire.
2. **Scoring** — chaque release est annotée avec son état de cache TorBox (`/checkcached`) puis scorée : `cached × 10000 + seeders × 2 + bonus qualité/langue/codec` (AAC +50, DDP/DTS/TrueHD −100, multi/french/vff +40, etc.).
3. **Auto-pick** — la #1 est lancée automatiquement. Auto-fallback sur la #2 / #3 si TorBox refuse.
4. **TorBox /play** — backend choisit entre `AddMagnet` (si magnet valide) ou `AddTorrentFile` (fetch le `.torrent` côté serveur puis upload binaire). Poll jusqu'à `download_finished` (max 3 min).
5. **ffprobe** — backend lit le **vrai** codec audio + la durée du flux TorBox. Renvoyés au frontend.
6. **Frontend** — décide selon le codec :
   - `aac` → URL TorBox directe → `<video src>` natif → seek complet, qualité originale
   - autre → POST `/api/v1/stream/hls/start` → backend génère une playlist VOD complète (durée connue) → hls.js lit la playlist, chaque chunk est transcodé à la demande (`ffmpeg -ss N -t 4 -c:v copy -c:a aac`)

### Pourquoi un fetch serveur du `.torrent` ?

Beaucoup d'indexers (Torrent9, ezTV…) renvoient un `downloadUrl` Prowlarr-proxifié vers un fichier `.torrent` au lieu d'un magnet. TorBox est dans le cloud et ne peut pas joindre `http://127.0.0.1:9696`. Le backend Notflix joue le pont : il récupère le `.torrent` localement et le re-upload à TorBox via le champ multipart `file`.

### Pourquoi HLS plutôt qu'un pipe Matroska ?

Le pipe one-way ne permet pas le seek backward (le serveur ne peut pas répondre aux range requests sur un flux qu'il n'a pas en mémoire). Avec HLS, chaque chunk est un fichier indépendant fetchable séparément → seek arbitraire. ffprobe nous donne la durée totale dès le départ → barre de progression complète, pas de « durée qui grandit pendant la lecture ».

## Endpoints backend

| Méthode | URL | Description |
|---|---|---|
| GET | `/api/v1/status` | Health + flag TMDB |
| GET | `/api/v1/tmdb/*` | Proxy transparent vers TMDB v3 (clé API ajoutée côté serveur) |
| GET | `/api/v1/tmdb/img/:size/*` | Proxy + cache disque pour les images TMDB |
| GET | `/api/v1/torbox/status` | Compte TorBox (configured, email, plan, premium expiry) |
| POST | `/api/v1/torbox/cache` | `{hashes: [...]}` → `{hash: bool}` |
| POST | `/api/v1/torbox/play` | `{magnet?, downloadUrl?}` → `{streamUrl, audioCodec, durationSec, …}` |
| GET | `/api/v1/torbox/list` | Liste des torrents du compte |
| DELETE | `/api/v1/torbox/torrent/:id` | Supprime un torrent |
| GET | `/api/v1/prowlarr/status` | Health Prowlarr + nb d'indexers actifs |
| GET | `/api/v1/prowlarr/search/movie?title=&year=` | Top releases, filtrées, triées, cache-annotées |
| GET | `/api/v1/prowlarr/search/tv?title=&season=&episode=` | Idem TV |
| GET | `/api/v1/stream/transmux?url=` | ffmpeg pipe Matroska (legacy, no-seek) |
| POST | `/api/v1/stream/hls/start` | Démarre une session HLS (m3u8 VOD + chunks on-demand) |
| GET | `/api/v1/stream/hls/:sessionId/*` | Sert la playlist ou un chunk `.ts` |
| GET POST | `/api/v1/profiles` | CRUD profils |
| PATCH DELETE | `/api/v1/profiles/:uid` | |
| GET PUT POST | `/api/v1/profiles/:uid/history` | Watch history (5 s polling) |
| DELETE | `/api/v1/profiles/:uid/history/:mediaType/:tmdbId` | |
| DELETE | `/api/v1/profiles/:uid/history` | Clear all |
| GET PUT | `/api/v1/profiles/:uid/list` | Ma liste |
| DELETE | `/api/v1/profiles/:uid/list/:mediaType/:tmdbId` | |

## Variables d'environnement

| Clé | Défaut | Description |
|---|---|---|
| `NOTFLIX_SERVER_HOST` | `127.0.0.1` | Bind |
| `NOTFLIX_SERVER_PORT` | `43212` | Port HTTP |
| `NOTFLIX_DATA_DIR` | `~/.notflix-data` | SQLite + caches |
| `NOTFLIX_TMDB_API_KEY` | — | **Requis** pour le catalogue |
| `NOTFLIX_TORBOX_API_KEY` | — | Requis pour la lecture |
| `NOTFLIX_PROWLARR_URL` | `http://127.0.0.1:9696` | Base URL Prowlarr |
| `NOTFLIX_PROWLARR_API_KEY` | — | Requis pour la recherche |

## Crédits

- Catalogue : [The Movie Database (TMDB)](https://www.themoviedb.org/) — usage personnel non-commercial.
- Debrid : [TorBox](https://torbox.app/).
- Recherche : [Prowlarr](https://prowlarr.com/) + [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr).
- Transcoding : [ffmpeg](https://ffmpeg.org/).
- HLS player : [hls.js](https://github.com/video-dev/hls.js).
- Icônes : [react-icons](https://react-icons.github.io/react-icons/) (Bi, Lu, Fi, Hi).

## License

MIT. Notflix est un projet personnel d'apprentissage et de self-hosting. Il ne propose aucun contenu — il interroge des APIs publiques, l'utilisateur reste seul responsable de ses choix de sources.
