<p align="center">
  <img src="notflix-web/public/notflix-logo.svg" alt="Notflix" width="96"/>
</p>

<h1 align="center">Notflix</h1>

<p align="center">
  Une app de streaming auto-hébergée façon Netflix — films &amp; séries (live-action).
  <br/>
  TMDB pour le catalogue · Prowlarr pour la recherche torrent · TorBox pour le débridage et la lecture directe.
</p>

<p align="center">
  <a href="https://github.com/dgadacha/notflix"><img alt="GitHub" src="https://img.shields.io/badge/github-dgadacha/notflix-181717?logo=github"/></a>
  <img alt="Go" src="https://img.shields.io/badge/go-1.23%2B-00ADD8?logo=go"/>
  <img alt="React" src="https://img.shields.io/badge/react-19-149ECA?logo=react"/>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue"/>
</p>

---

## Concept

Notflix est une UI Netflix-like (hero rotatif, rails de films, modale détail, profils
« Qui regarde ? », bottom tab mobile…) au-dessus d'un pipeline simple :

1. **TMDB** fournit le catalogue (films + séries, métadonnées, images, recommandations) — clé API gratuite, proxifiée côté backend.
2. **Prowlarr** est interrogé pour trouver des sources torrent quand on clique « Lecture ».
3. **TorBox** (debrid commercial) prend le magnet, le télécharge sur ses serveurs, et expose une URL HTTP directe que le `<video>` du navigateur peut lire.

Pas de plugin de streaming bricolé, pas de scraper anti-bot, pas de player custom : on s'appuie sur du natif HTML5 et des services qui font déjà bien leur boulot.

```
┌──────────┐    ┌──────────────────┐    ┌──────────────────────────┐
│ Browser  │ ←→ │ Notflix (Go+web) │ ←→ │ TMDB · TorBox            │
│ React UI │    │ /api/v1/* proxy  │    │ Prowlarr (Docker local)  │
└──────────┘    └──────────────────┘    └──────────────────────────┘
```

## Stack

| Couche | Tech |
|---|---|
| Backend | Go 1.23+, Echo, GORM/SQLite, binaire unique avec frontend embarqué via `//go:embed` |
| Frontend | React 19 + TanStack Router + Tailwind + Jotai + React Query, bundle Rsbuild |
| API externes | TMDB v3 · TorBox v1 · Prowlarr v1 |
| Recherche | Prowlarr meta-indexer (Torznab) + FlareSolverr (résolution Cloudflare) |
| Conteneurisation | Dockerfile multi-stage (Node → Go → Debian-slim) |

## État actuel

Phase 3d (UX 1-clic) livrée le 21 mai 2026. Ce qui marche :

- Home complète, alimentée par TMDB (`fr-FR`) : hero hebdo trending, 7 rails (films tendance/populaires/mieux notés/au cinéma/à venir, séries tendance/populaires)
- Modale détail (synopsis, genres, score, durée/saisons, CTA Lecture)
- Recherche `/search` multi (films + séries)
- Page `/watch` complète : Prowlarr → tri par cache TorBox / score / seeders → auto-pick → `<video>` natif
- Picture-in-Picture automatique quand on change d'onglet
- Profils SQLite (CRUD prêt côté API et picker, watch history à finir)

Ce qui reste (roadmap courte) :

- [ ] Modale détail enrichie (cast, recommandations, preview des sources Prowlarr)
- [ ] Per-profile watch history sur TMDB ids (saver auto toutes les 5 s sur `/watch`)
- [ ] Page `Mes listes` (favoris, en cours, vu) câblée à la DB profile
- [ ] Picker saison/épisode pour les séries TV
- [ ] Rebrand visuel (logo `K` → `N`, title HTML « anime streaming »)
- [ ] Déploiement k8s + Cloudflare Tunnel (manifests + Dockerfile à finaliser)

## Pré-requis locaux

| Dépendance | Pourquoi | Comment |
|---|---|---|
| Go 1.23+ | Backend | `brew install go` |
| Node 20+ + npm | Frontend dev | `brew install node` |
| Docker Desktop | Prowlarr + FlareSolverr | [docker.com](https://www.docker.com/products/docker-desktop/) |
| Compte TMDB | Clé API gratuite | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) |
| Compte TorBox | Debrid (payant, ~3 €/mois) | [torbox.app](https://torbox.app) |

## Setup

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
2. **Settings → Indexers** → ajouter des indexers (`1337x`, `EZTV`, `LimeTorrents`, `Torrent9`, `World-torrent`, `YTS`…). Le bonus Notflix : Prowlarr renvoie le `downloadUrl`, et le backend Notflix sait le résoudre côté serveur même quand l'indexer n'expose pas de magnet direct.
3. **Settings → Indexers → Indexer Proxies** → ajouter un proxy `FlareSolverr` pointant sur `http://host.docker.internal:8191` (depuis Prowlarr qui tourne dans Docker, `host.docker.internal` pointe sur la machine hôte). Sans ça, les indexers Cloudflare-gated (Torrent9 entre autres) sont injoignables.
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

Le binaire final embarque le frontend via `//go:embed all:web`. Une seule binaire, un seul port, déployable n'importe où.

## Architecture

```
.
├── main.go                              # Entrypoint Echo (16 lignes)
├── internal/
│   ├── core/                            # Config + DB + DI container
│   ├── handlers/                        # Routes /api/v1/* (Echo)
│   │   ├── routes.go                    # Mapping URL → handler
│   │   ├── tmdb_proxy.go                # Proxy transparent TMDB
│   │   ├── torbox.go                    # cache/play/list/delete
│   │   ├── prowlarr.go                  # search + scoring + cache annotation
│   │   └── profiles.go                  # CRUD profils + watch history
│   ├── tmdb/                            # Client HTTP + cache 30 s
│   ├── torbox/                          # Client TorBox (Add/Get/RequestDownloadURL…)
│   ├── prowlarr/                        # Client REST + helpers movie/tv
│   └── database/                        # GORM models + migrations
├── notflix-web/                         # React app
│   ├── src/
│   │   ├── app/(main)/                  # Pages : /, /lists, /search, /settings,
│   │   │   │                            #         /profiles, /watch
│   │   │   └── _features/netflix/       # Composants UI Netflix-style
│   │   ├── lib/
│   │   │   ├── tmdb.ts                  # Hooks React Query → /api/v1/tmdb/*
│   │   │   ├── notflix-api.ts           # Hooks TorBox + Prowlarr
│   │   │   └── profiles/                # CRUD profils côté client
│   │   └── routes/                      # TanStack Router file-based
│   └── rsbuild.config.ts                # Bundler + proxy /api → :43212
├── Makefile                             # make dev / build / run / clean
├── .env                                 # secrets locaux (gitignored)
└── CLAUDE.md                            # contexte pour les agents Claude Code
```

### Flow de lecture (`/watch?id=…&type=movie`)

1. Page mount → TMDB detail fetch en parallèle d'un search Prowlarr (`title` + `year`).
2. Le backend Prowlarr classe les résultats : `cached × 10000` + `seeders × 2` + bonus qualité (BluRay/1080p/HEVC) + bonus FR (multi/french/vff) + sweet-spot taille (1-5 GB). Les résultats sont annotés en une passe avec `cached: bool` (TorBox `/checkcached`).
3. Auto-pick de la #1 release (la mieux notée). Bouton « Changer de source » pour overrider.
4. POST `/api/v1/torbox/play` → backend :
   - Si la release a un `magnetUrl` → POST direct à TorBox.
   - Sinon → fetch le `.torrent` depuis Prowlarr (qui proxifie l'indexer) → upload binaire à TorBox.
   - Poll `mylist?id=…` jusqu'à `download_finished` (max 3 min).
   - Pick automatique du plus gros fichier vidéo dans le torrent.
   - Request `/torrents/requestdl?token=…&torrent_id=…&file_id=…` → URL HTTP signée.
5. Frontend mount `<video src={streamUrl} autoplay controls playsInline>`.

### Pourquoi un fetch serveur du `.torrent` ?

Les indexers français (Torrent9 entre autres) renvoient un `downloadUrl` Prowlarr-proxifié vers un fichier `.torrent` au lieu d'un magnet. TorBox tourne dans le cloud et ne peut pas joindre `http://127.0.0.1:9696`. Le backend Notflix joue le pont : il récupère le `.torrent` localement et le re-upload à TorBox via le champ multipart `file` (au lieu de `magnet`). C'est ce qui permet à 100 % des indexers Prowlarr de fonctionner uniformément, qu'ils exposent un magnet ou non.

## Endpoints backend

| Méthode | URL | Description |
|---|---|---|
| GET | `/api/v1/status` | Health + flag TMDB |
| GET | `/api/v1/tmdb/*` | Proxy transparent vers TMDB v3 (clé API ajoutée côté serveur) |
| GET | `/api/v1/torbox/status` | Compte TorBox (configured, email, plan, premium expiry) |
| POST | `/api/v1/torbox/cache` | `{hashes: [...]}` → `{hash: bool}` |
| POST | `/api/v1/torbox/play` | `{magnet?, downloadUrl?, fileId?}` → `{streamUrl, …}` |
| GET | `/api/v1/torbox/list` | Liste des torrents du compte |
| DELETE | `/api/v1/torbox/torrent/:id` | Supprime un torrent |
| GET | `/api/v1/prowlarr/status` | Health Prowlarr + nb d'indexers actifs |
| GET | `/api/v1/prowlarr/search/movie?title=&year=` | Top releases, triées et cache-annotées |
| GET | `/api/v1/prowlarr/search/tv?title=&season=&episode=` | Idem TV |
| GET POST | `/api/v1/profiles` | CRUD profils |
| PATCH DELETE | `/api/v1/profiles/:uid` | |
| GET PUT POST DELETE | `/api/v1/profiles/:uid/history` | Watch history |
| GET PUT DELETE | `/api/v1/profiles/:uid/list` | Listes (favoris, en cours, vu) |

## Variables d'environnement

| Clé | Défaut | Description |
|---|---|---|
| `NOTFLIX_SERVER_HOST` | `127.0.0.1` | Bind |
| `NOTFLIX_SERVER_PORT` | `43212` | Port HTTP |
| `NOTFLIX_DATA_DIR` | `~/.notflix-data` | SQLite + cache |
| `NOTFLIX_TMDB_API_KEY` | — | **Requis** pour le catalogue |
| `NOTFLIX_TORBOX_API_KEY` | — | Requis pour la lecture |
| `NOTFLIX_PROWLARR_URL` | `http://127.0.0.1:9696` | Base URL Prowlarr |
| `NOTFLIX_PROWLARR_API_KEY` | — | Requis pour la recherche |

## Crédits

- Catalogue : [The Movie Database (TMDB)](https://www.themoviedb.org/) — usage personnel non-commercial.
- Debrid : [TorBox](https://torbox.app/).
- Recherche : [Prowlarr](https://prowlarr.com/) + [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr).
- Icônes : [react-icons](https://react-icons.github.io/react-icons/) (Bi, Lu, Fi).

## License

MIT. Notflix est un projet personnel d'apprentissage et de self-hosting. Il ne propose aucun contenu — il interroge des APIs publiques, l'utilisateur reste seul responsable de ses choix de sources.
