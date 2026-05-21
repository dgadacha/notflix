# Notflix — Claude context

This is the **Notflix** project — a Netflix-style streaming app for **live-action films & TV series**. NOT to be confused with its sibling project [Kuro](https://github.com/dgadacha/kuro) (animes via AniList) which lives in `~/Documents/seanime`.

The user (Dylan) is French — **respond in French unless asked otherwise**.

---

## What Notflix is, in one diagram

```
Browser ──HTTP──▶ Notflix Go backend ──HTTP──▶ TMDB (catalogue, fr-FR)
                                       └──▶ TorBox (debrid + stream URL)
                                       └──▶ Prowlarr (search) + FlareSolverr
```

The Go binary serves both the React SPA (embedded via `//go:embed`) and the API. Three external APIs do the heavy lifting; Notflix is essentially a typed, French-speaking glue layer with a polished Netflix UI on top.

## Repo / git

- **Origin remote** = <https://github.com/dgadacha/notflix>.
- **Branch** = `main` only. No force-push.
- Commits use `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` per the harness convention.
- **Sibling project**: Kuro is at `~/Documents/seanime` with its own `CLAUDE.md` (anime fork, port 43211, GitLab CI auto-deploy). Don't conflate the two — they share architectural DNA but their backends, deploy pipelines and remotes are fully separate.
- HEREDOC pattern for commit messages:
  ```sh
  git commit -m "$(cat <<'EOF'
  Subject line

  Body.
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

## How to run

```sh
make dev      # backend (43212) + frontend (43210), Ctrl+C stops both
make build    # bundles React → web/ → builds binary `./notflix`
make run      # build then launch
make clean    # nuke artifacts (datadir untouched)
```

The Makefile `backend` target auto-sources `.env` (gitignored) so the Go process gets `NOTFLIX_TMDB_API_KEY` / `NOTFLIX_TORBOX_API_KEY` / `NOTFLIX_PROWLARR_URL` / `NOTFLIX_PROWLARR_API_KEY` without polluting the user's shell.

### Critical port note

**Backend MUST bind on `43212`.** `43211` is Kuro's; running both in parallel is supported and intentional. If you change this, update:
- `Makefile` (PORT)
- `internal/core/config.go` default
- `notflix-web/src/lib/server/config.ts` (`__DEV_SERVER_PORT`)
- `notflix-web/rsbuild.config.ts` proxy target

### Go has no hot-reload

`make dev` runs `go run main.go` which doesn't watch for changes. After editing backend Go files, the user must **Ctrl+C and relaunch `make dev`**. This bit us several times during Phase 3d — be explicit when telling the user to restart.

## Architecture

```
.
├── main.go                                # 16-line Echo entrypoint, embedded web FS
├── internal/
│   ├── core/
│   │   ├── app.go                         # DI container: Config + DB + TMDB + TorBox + Prowlarr clients
│   │   └── config.go                      # NOTFLIX_* env vars + defaults
│   ├── database/
│   │   ├── db/db.go                       # GORM AutoMigrate
│   │   ├── db/profile.go                  # CRUD profiles + history + list
│   │   └── models/models.go               # Profile, ProfileWatchHistory, ProfileListEntry
│   ├── handlers/
│   │   ├── routes.go                      # /api/v1/* wire-up
│   │   ├── tmdb_proxy.go                  # transparent proxy with 30s cache
│   │   ├── torbox.go                      # cache/play/list/delete + .torrent fallback
│   │   ├── prowlarr.go                    # search + composite scoring + cache annotation
│   │   └── profiles.go                    # CRUD profile + history + list
│   ├── tmdb/client.go                     # 30s in-memory cache, fr-FR default
│   ├── torbox/client.go                   # ~300 LOC: Ping/CheckCached/AddMagnet/
│   │                                      #   AddTorrentFile/GetTorrent/RequestDownloadURL
│   └── prowlarr/client.go                 # REST + Torznab category helpers
├── notflix-web/
│   ├── src/
│   │   ├── app/(main)/
│   │   │   ├── _features/netflix/         # ★ ALL Notflix-specific UI
│   │   │   │   ├── netflix-card.tsx       # 16:9 thumb, opens modal or /watch direct on Cmd-click
│   │   │   │   ├── netflix-row.tsx        # horizontal scroller (shared shell)
│   │   │   │   ├── netflix-home.tsx       # hero + 7 TMDB-fed rails
│   │   │   │   ├── netflix-hero.tsx       # weekly-trending slideshow, Play → /watch, More info → modal
│   │   │   │   ├── netflix-detail-modal.tsx     # synopsis + genres + score + Play → /watch
│   │   │   │   ├── netflix-search.tsx     # /search (TMDB multi)
│   │   │   │   ├── netflix-lists.tsx      # /lists (placeholder, Phase 3f)
│   │   │   │   ├── netflix-top-bar.tsx    # fixed nav, fades on scroll
│   │   │   │   ├── netflix-bottom-tab.tsx # mobile-only bottom nav
│   │   │   │   ├── netflix-profile-picker.tsx   # /profiles
│   │   │   │   ├── use-slideshow.ts       # paused on hover/hidden tab/reduced-motion
│   │   │   │   └── netflix.constants.ts   # HERO/ROW sizing
│   │   │   ├── _features/layout/
│   │   │   │   ├── main-layout.tsx        # TopBar + Outlet + BottomTab + DetailModal + profile gate
│   │   │   │   └── offline-layout.tsx     # passthrough (Notflix is server-backed)
│   │   │   ├── watch/page.tsx             # ★ TMDB → Prowlarr → TorBox → <video> state machine
│   │   │   ├── lists/page.tsx             # placeholder
│   │   │   ├── search/page.tsx
│   │   │   ├── settings/page.tsx          # placeholder
│   │   │   └── profiles/page.tsx
│   │   ├── lib/
│   │   │   ├── tmdb.ts                    # ★ TMDBMedia type, useTrending/useDiscover/useTMDBDetail/useTMDBSearch
│   │   │   ├── notflix-api.ts             # ★ useTorBoxPlay (accepts magnet OR downloadUrl), useSearchMovie/TV
│   │   │   ├── profiles/profiles.ts       # client-side profile state (Jotai + React Query)
│   │   │   ├── navigation.ts              # useRouter / useSearchParams adapters over TanStack Router
│   │   │   └── i18n/                      # FR default, kuro-lng → notflix-lng key
│   │   └── routes/                        # TanStack Router file-based
│   ├── public/notflix-logo.svg            # ★ the "N" logo (currently still a Kuro K!)
│   ├── rsbuild.config.ts                  # proxy /api → :43212, port 43210
│   └── package.json
├── Makefile                               # auto-loads .env in `backend` target
├── .env                                   # ★ secrets, gitignored
├── .gitignore                             # excludes .env, node_modules, build outputs
└── README.md                              # user-facing setup doc
```

## Status / Phases

- **Phase 1 — fork + rebrand** ✓ : copied Kuro source, sed Kuro → Notflix everywhere, bumped port 43211 → 43212.
- **Phase 2 — backend trim + greenfield** ✓ : threw away the entire Seanime `internal/*` tree (pivot from Plan X — incremental trim — to Plan Y — greenfield rewrite). New small focused backend: `internal/{core,tmdb,torbox,prowlarr,database,handlers}`.
- **Phase 3a-c — frontend trim + adapt** ✓ : 1000+ files → ~310. Removed `_features/anilist`, `_features/anime-library`, `_features/nakama`, `_features/onlinestream`, `_features/video-core`, `_features/plugin`, `_features/playlists`, etc. Rewrote `netflix-{card,row,home,hero,detail-modal,top-bar,search,lists}` for `TMDBMedia`. Stubbed every dead import (`types/constants`, `_atoms/server-status.atoms`, `_hooks/use-server-status`, `_electron/electron-padding`, `simple-auth-wrapper`, `directory-selector`, `media-exclusion-selector`, `websocket-provider`, `custom-background-image`).
- **Phase 3c.5 — runtime fixes** ✓ : 4 cascading bugs solved before the home rendered:
  1. CORS preflight rejected (custom `X-Seanime-*` headers blocked) → dropped them client-side.
  2. `withCredentials: true` incompatible with wildcard `Allow-Origin` → flipped to false.
  3. `fetch('/api/v1/...')` hit the dev server SPA fallback (no proxy) → added `proxy: { "/api": "http://127.0.0.1:43212" }` to `rsbuild.config.ts`.
  4. `make dev` launched Go without env vars → Makefile now sources `.env`.
- **Phase 3d — watch page** ✓ : full pipeline TMDB → Prowlarr → TorBox → `<video>` natif. Backend handles two release source modes (`magnet` direct, `downloadUrl` server-side .torrent fetch). 5-state machine on the frontend (`searching → picking → preparing → playing → error`).
- **Phase 3d.1 — UX 1-click** ✓ : modal Play → in-tab nav (no more `target="_blank"`), splash skipped, top release auto-picked. Manual picker still reachable via "Changer de source".
- **Next**: Phase 3e (detail modal enriched: cast/recos/prowlarr preview), Phase 3f (profile picker + watch history wiring), Phase 3g (rebrand logo K → N, fix title `<meta name="description">`), Phase 3h (i18n cleanup of inherited `anime` / `épisode` keys).

## Wire-protocol identifiers — DO NOT RENAME

Some upstream Seanime identifiers were preserved on the wire because removing them broke the API:

- HTTP headers: `X-Seanime-Token` etc. — actually now **removed from the client** as of Phase 3c.5 (the Notflix backend doesn't read them), but if any code path still sends them it must not be blanket-renamed `X-Notflix-*` (CORS preflight will fail without explicit `AllowHeaders` listing).
- Type names like `__isElectronDesktop__` are kept identical to Kuro's so the inherited components compile without sweeping edits.

A bulk `s/seanime/notflix/g` across the codebase **will break** things. Targeted renames only.

## What stays from Kuro (the polish carries over)

All the Netflix-style UX work that was done on Kuro is inherited verbatim:

- **Profile picker** ("Qui regarde ?") + per-profile gate in `MainLayout` (`useProfileGate`).
- **Bottom tab bar** on mobile with safe-area inset for iPhone home indicator.
- **Top bar** fade-on-scroll, dropdown profile menu, language switcher.
- **Detail modal** opens over the current page (preserves history grid behind).
- **Hero slideshow** with paused-on-hover / paused-on-tab-hidden / reduced-motion respect.
- **Card hover-zoom** with `transform-gpu` and ring-on-focus.
- **Picture-in-Picture** auto-pop on tab visibility loss (now on the native `<video>`).
- **i18n FR-first** with `react-i18next` + browser language detector. localStorage key: `notflix-lng`.

## Conventions / preferences

- **Language**: French in chat. UI strings: see `notflix-web/src/lib/i18n/locales/{fr,en}.json`.
- **Length**: tight responses, no fluff. Dylan gives short directives, expects brief acknowledgments + the actual change.
- **Commits**: incremental, one logical change per commit. Push after each meaningful milestone.
- **Verification**: no `go build` or `npm install` runs in the agent environment; the user runs `make dev` and screenshots. Run `npx --no-install rsbuild build` to smoke-test the frontend bundle without bothering the user, and `go build ./...` for the backend.
- **Permissions**: `Bash(rm …)` in the project is fine — everything is versioned. Never delete outside the repo, never `git reset --hard`.

## Known traps

- **Hero / navbar overlap**: `NetflixTopBar` is `position: fixed`. Pages get `pt-16 lg:pt-[68px]` from `_main.tsx`. `NetflixHome` opts out with `-mt-16 lg:-mt-[68px]` so the hero sits flush behind the transparent nav. Same on `/watch` and `/profiles`.
- **Card hover scale** vs. grid gaps: `hover:scale-[1.03]` will visually clip into the grid neighbor unless the grid has vertical breathing room. All Notflix grids use `gap-x-4 gap-y-6 py-2`. Stick to that.
- **TextInput leftIcon**: `pl-12` only at `size="lg"`. If you override with `px-N` you erase the left padding and the placeholder slides under the icon. See `netflix-search.tsx` for the right pattern (`size="lg"` + `!pl-14 !pr-6`).
- **Dead-looking code that's NOT dead**: `_features/anime-library/` was nuked but `_atoms/server-status.atoms.ts`, `_hooks/use-server-status.ts`, `simple-auth-wrapper.tsx` etc. are STUBS that the build needs — they exist so legacy imports compile. Grep before deleting anything in `_atoms`, `_hooks`, `components/shared/*` that looks unused.
- **CORS + `withCredentials`**: the wildcard `Access-Control-Allow-Origin: *` is rejected by browsers when the request is credentialed. axios in `api/client/requests.ts` is set to `withCredentials: false`. Don't flip it back.
- **`/api/*` proxy in dev**: `rsbuild.config.ts` proxies `/api → 127.0.0.1:43212`. Without it, relative `fetch('/api/v1/...')` in `tmdb.ts` and `notflix-api.ts` hit the SPA fallback (returns `index.html` with 200) and the home goes blank.
- **`make dev` without `.env`**: the Makefile sources `.env` in the `backend` target. If `.env` is missing or a key is empty, the backend boots fine but every `/api/v1/tmdb/*` returns 503 with `"TMDB API key not configured"`. Check `.env` first when the home blanks.
- **TorBox can't reach Prowlarr**: Prowlarr runs on `127.0.0.1:9696` (local), TorBox is in the cloud. When a release exposes only a `downloadUrl` (not a magnet), the backend MUST fetch the `.torrent` itself and re-upload to TorBox via the multipart `file` field. See `handlers/torbox.go#fetchTorrentFromURL`. The fetcher also intercepts `30x` → `magnet:?…` redirects (some indexers do that instead of streaming bytes).
- **Prowlarr local auth**: if Prowlarr returns 401 to the backend, check that **both** `AuthenticationMethod = None` and `AuthenticationRequired = DisabledForLocalAddresses` are set in `~/.notflix-data/prowlarr/config.xml`. Setting just one of them is not enough.
- **Frontend build flakiness**: `package.json`'s `build` script is `tsgo && rsbuild build`, but `tsgo` (`@typescript/native-preview`) flags 30+ pre-existing TS errors that don't block dev. Use `npx --no-install rsbuild build` directly when smoke-testing.

## Quick command cheatsheet

```sh
# Boot end-to-end
make dev

# Verify the 3 external integrations
curl http://127.0.0.1:43212/api/v1/status
curl http://127.0.0.1:43212/api/v1/torbox/status
curl http://127.0.0.1:43212/api/v1/prowlarr/status

# Inspect what Prowlarr returns for a film (top 5)
curl -s "http://127.0.0.1:43212/api/v1/prowlarr/search/movie?title=Tenet&year=2020" | jq '.data[:5]'

# Frontend bundle smoke test (no tsgo)
cd notflix-web && npx --no-install rsbuild build

# Backend smoke test (no run)
go build ./...

# Find broken imports after deleting a file
grep -rln "from \"@/path/to/deleted-thing" notflix-web/src --include="*.ts" --include="*.tsx"

# Recent commits
git log --oneline -20
```

## Who is the user

Dylan (`encheres.nc@gmail.com`). French. JS/React background — explain Go errors plainly and propose pragmatic fixes. Likes Netflix UX, hates clutter, prefers simplicity over configurability. Self-hosts on a homelab cluster (`nc-maiz.org` via Cloudflare Tunnel), but Notflix isn't deployed there yet — currently local-only validation.

## Roadmap notes for future Claude sessions

- **Phase 3e** — Detail modal: pull `append_to_response=credits,videos,recommendations` from TMDB (already in the `useTMDBDetail` hook), add a `<NetflixMoreLikeThis>` rail using `recommendations.results`, add a trailer button using the first `videos.results[?type='Trailer']`, and a Prowlarr preview chip ("12 sources disponibles · 4 en cache").
- **Phase 3f** — Profile picker is ready; need to wire `NetflixProfileHistorySaver` on `/watch` (poll the `<video>` every 5s + on `pagehide`/`beforeunload`, POST to `/api/v1/profiles/:uid/history`). Then surface a `NetflixContinueWatching` rail above `TrendingMoviesRow` reading the active profile's history.
- **Phase 3g** — Logo. The `K` is hardcoded in `notflix-web/public/notflix-logo.svg`. Replace with an `N` mark. Also fix `notflix-web/index.html` description meta (`"A Netflix-style anime streaming app."` → `"A Netflix-style self-hosted streaming app for films & series."`).
- **Phase 3h** — i18n. Inherited French/English keys still mention `anime` / `épisode` in places that don't apply to live-action. See `notflix-web/src/lib/i18n/locales/{en,fr}.json`. Replace `anime` → `film/série` contextually; for TV pickers keep `épisode` where it actually means an episode.
- **Phase 4** — Deploy. Kuro has a working Dockerfile + k8s manifests at `~/Documents/seanime`. Adapt: image name `kidnar/notflix`, ns `notflix`, port 43212, public hostname (e.g. `notflix.nc-maiz.org`). Add a GitLab CI pipeline mirroring Kuro's. Add a Cloudflare DNS CNAME.
- **Phase 5** — Quality of life. `air` for Go hot-reload (so the user stops having to Ctrl+C `make dev` after every backend edit). Prowlarr result cache (1h TTL on `(title, year)`) — the search is the slow part of the pipeline. Add an "Auto" picker preference (auto-fallback to #2 if TorBox times out on #1).
