# Notflix — Claude context

Sister project of **Kuro** (`~/Documents/seanime`). Both are forks of
[Seanime](https://github.com/5rahim/seanime), both have the Netflix-style
UX, both deploy the same way. The split :

| | Kuro | Notflix |
|---|---|---|
| Catalogue | AniList | TMDB |
| Streaming | JS extensions (anime-sama, french-anime…) | Vidsrc iframe embed |
| Cible | animes | films + séries live-action |
| Bind | `:43211` | `:43212` |

The user (Dylan) is French — **respond in French**.

---

## Status / Phases

**Phase 1 — fork + rebrand** (current commit) :
- Cloned Kuro source verbatim via `rsync` (excluding `.git`, build outputs, datadir).
- All `Kuro/kuro/KURO` brand strings → `Notflix/notflix/NOTFLIX` (sed across
  `.go`, `.ts`, `.tsx`, `.json`, `.yaml`, `.html`, `Makefile`, `Dockerfile`).
- Wire-protocol headers (`X-Seanime-Token`, `X-Seanime-Client-Id*`) kept
  intact — they're upstream Seanime identifiers and renaming them breaks
  every API call.
- Go module : `seanime` → `notflix` (in `go.mod` + 485 import sites).
- Frontend dir : `seanime-web` → `notflix-web`.
- Binary : `seanime` → `notflix` (in Makefile + Dockerfile).
- DB structs : `KuroProfile*` → `NotflixProfile*` (GORM table names derive : `notflix_profiles`).
- API routes : `/api/v1/kuro-profiles` → `/api/v1/notflix-profiles`.
- localStorage keys : `kuro-*` → `notflix-*`.
- k8s ns : `kuro` → `notflix`, image ref `kidnar/kuro` → `kidnar/notflix`.
- GitLab agent dir : `.gitlab/agents/kuro/` → `.gitlab/agents/notflix/`.

**Phase 2 — trim backend + TMDB proxy** (next) :
- Delete entire packages : `internal/manga`, `internal/onlinestream`,
  `internal/extension`, `internal/plugin` (Goja JS extensions),
  `internal/anilist`, `internal/torrent_clients`, `internal/torrentstream`,
  `internal/debrid`, `internal/nakama`, `internal/library/{scanner,autodownloader,…}`,
  `internal/library_explorer`.
- Strip wiring in `internal/core/app.go`.
- Add `internal/tmdb/client.go` (proxy + 30s cache).
- Add `internal/handlers/tmdb_proxy.go` for `/api/v1/tmdb/*`.
- Update profile schema : `TMDBID` + `MediaType` (`"movie" | "tv"`) +
  `Season` + `Episode` instead of `MediaId` + `EpisodeNumber`.

**Phase 3 — frontend swap** (after Phase 2) :
- Replace AniList types (`AL_BaseAnime`, …) with `TMDBMedia`.
- Swap data hooks (`useDiscoverTrendingAnime` etc.) for TMDB equivalents.
- Watch page : rip `OnlinestreamPage` (~750 lines of provider routing) and
  replace with a 20-line iframe wrapper to Vidsrc.
- Update UI copy : "anime" → "film/série", episode picker for TV series.

## Critical port note

Bind **MUST** be `43212` (not `43211` — that's Kuro). Update everywhere
if you change it : `Makefile`, `Dockerfile`, k8s manifest, frontend dev
proxy, `internal/core/config.go` default.

## How to run

```sh
make dev      # backend + vite in parallel
make build    # single binary with web embedded
make run      # build + launch
make clean    # nuke artifacts (datadir untouched)
```

Datadir : `~/.notflix-data`. Override : `make dev DATADIR=/tmp/notflix`.

## Wire-protocol identifiers — DO NOT RENAME

Preserved verbatim from upstream Seanime so the Go backend and React
client speak the same protocol :

- HTTP headers : `X-Seanime-Token`, `X-Seanime-Client-Id*`
- Discord rich-presence field : `richPresenceHideSeanimeRepositoryButton`

A blanket `s/seanime/notflix/g` across the codebase WILL break every API
call. Don't do it.

## What stays from Kuro (the polish carries over)

Files are verbatim sed-renamed copies, so all Kuro UX work transfers :

- **Profile picker** ("Qui regarde ?") + per-profile gate
- **Bottom tab bar** on mobile (5 items including the profile avatar)
- **Safe-area insets** (iPhone notch + home indicator)
- **Hero "Reprendre ÉP X"** when there's in-progress history (needs
  rewiring to TMDB in Phase 3)
- **Detail modal** with list-picker pill
- **Historique** by date buckets (Aujourd'hui / Hier / Cette semaine /
  Ce mois-ci / Plus ancien)
- **Genre chips** filter on /lists
- **Picture-in-Picture** on tab change
- **i18n FR-first**

## Conventions

- Same as Kuro : French chat, tight responses, no fluff. Commits use
  `Co-Authored-By: Claude Opus 4.7 (1M context)`.
- Once a phase compiles + runs locally, commit and push. User runs
  `make dev` and screenshots errors.
- Don't push to GitLab yet — user wants local validation first.

## Known traps inherited from Kuro

- Frontend `tsgo && rsbuild build` flags ~30 pre-existing TS errors in
  upstream Seanime that don't block dev. The Dockerfile bypasses tsgo
  with `npx --yes rsbuild build` direct — keep that.
- PVC mount shadows `config.toml`. The k8s `initContainer` rewrites the
  `[server]` block every start so the manifest is the source of truth.
- The runtime container is non-root (uid 999). InitContainer must
  `chown 999:999` and `chmod 0644` the config file or the binary boots
  with EACCES.
- Silent `git pull` failure : if untracked files conflict with new
  tracked files (this bit Kuro hard with `k8s/*.yaml`). Always check
  `git status --short` after a pull.

## Who is the user

Dylan (`encheres.nc@gmail.com`), French, JS/React background. Same
context as Kuro's CLAUDE.md. Self-hosts on a homelab k3s with public
DNS (`nc-maiz.org`) and Cloudflare Tunnel. Likes Netflix UX, hates
clutter, prefers simplicity over configurability.
