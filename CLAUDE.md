# Notflix — Claude context

Netflix-style streaming app for **live-action films & TV series**. NOT to be confused with its sibling project [Kuro](https://github.com/dgadacha/kuro) (animes via AniList) which lives in `~/Documents/seanime`.

The user (Dylan) is French — **respond in French unless asked otherwise**.

---

## What Notflix is, in one diagram

```
Browser ──HTTP──▶ Notflix Go backend ──HTTP──▶ TMDB (catalogue, fr-FR)
                                       └──▶ TorBox (debrid + stream URL)
                                       └──▶ Prowlarr (search) + FlareSolverr
                                       └──▶ ffmpeg / ffprobe (HLS transmux)
```

The Go binary serves both the React SPA (embedded via `//go:embed`) and the API. Three external APIs do the heavy lifting; ffmpeg fills the gap when the browser can't decode the source audio. Notflix is a typed, French-speaking glue layer with a polished Netflix UI on top.

## Repo / git

- **Origin remote** = <https://github.com/dgadacha/notflix>.
- **Branch** = `main` only. No force-push.
- Commits use `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
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

`make dev` runs `go run main.go` which doesn't watch for changes. After editing backend Go files, the user must **Ctrl+C and relaunch `make dev`**. Pure-frontend changes hot-reload through rsbuild. Be explicit when telling the user to restart.

### External tools required

- `ffmpeg` + `ffprobe` in `$PATH` (used by `/stream/hls` + `/torbox/play` for codec/duration probing). On macOS: `brew install ffmpeg`.
- Prowlarr + FlareSolverr running locally in Docker (see README for the docker-run commands and auth toggles).
- TorBox account (paid).

## Architecture

```
.
├── main.go                                # 16-line Echo entrypoint, embedded web FS
├── internal/
│   ├── core/
│   │   ├── app.go                         # DI container: Config + DB + TMDB + TorBox + Prowlarr clients
│   │   └── config.go                      # NOTFLIX_* env vars + defaults
│   ├── database/
│   │   ├── db/db.go                       # GORM AutoMigrate + CRUD
│   │   └── models/models.go               # Profile, ProfileWatchHistory, ProfileListEntry
│   ├── handlers/
│   │   ├── routes.go                      # /api/v1/* wire-up
│   │   ├── tmdb_proxy.go                  # transparent JSON proxy
│   │   ├── tmdb_image.go                  # disk cache for image.tmdb.org
│   │   ├── torbox.go                      # cache/play/list + ffprobe (codec + duration)
│   │   ├── prowlarr.go                    # search + title-relevance filter + scoring + 1h cache
│   │   ├── stream.go                      # /stream/transmux (Matroska pipe, no-seek)
│   │   ├── hls.go                         # /stream/hls (on-demand chunk transcoding, full seek)
│   │   └── profiles.go                    # CRUD profile + history + list
│   ├── tmdb/client.go                     # 30s in-memory cache, fr-FR default
│   ├── torbox/client.go                   # Ping/CheckCached/AddMagnet/AddTorrentFile/GetTorrent/RequestDownloadURL
│   └── prowlarr/client.go                 # REST + Torznab category helpers
├── notflix-web/
│   ├── src/
│   │   ├── app/(main)/
│   │   │   ├── _features/netflix/         # ★ ALL Notflix-specific UI
│   │   │   │   ├── netflix-card.tsx       # 16:9 thumb + hover Prowlarr prefetch
│   │   │   │   ├── netflix-row.tsx        # horizontal scroller
│   │   │   │   ├── netflix-home.tsx       # hero + 7 TMDB rails + Continue Watching
│   │   │   │   ├── netflix-hero.tsx       # weekly trending slideshow
│   │   │   │   ├── netflix-detail-modal.tsx  # synopsis + episode list + Ma liste + prefs
│   │   │   │   ├── netflix-categories.tsx    # genre tiles + infinite-scroll grid
│   │   │   │   ├── netflix-search.tsx        # multi search + infinite scroll
│   │   │   │   ├── netflix-lists.tsx         # Ma liste / Historique tabs
│   │   │   │   ├── netflix-continue-watching.tsx  # Reprendre rail
│   │   │   │   ├── netflix-watch-history-saver.tsx  # poll 5s + pagehide
│   │   │   │   ├── netflix-profile-picker.tsx
│   │   │   │   ├── netflix-top-bar.tsx       # fixed nav, fades on scroll
│   │   │   │   ├── netflix-bottom-tab.tsx    # mobile-only bottom nav
│   │   │   │   ├── use-slideshow.ts
│   │   │   │   └── netflix.constants.ts
│   │   │   ├── _features/layout/
│   │   │   │   ├── main-layout.tsx        # TopBar + Outlet + BottomTab + DetailModal + profile gate
│   │   │   │   └── offline-layout.tsx     # passthrough
│   │   │   ├── watch/page.tsx             # ★ TMDB → Prowlarr → TorBox → ffmpeg → <video>/hls.js
│   │   │   ├── categories/page.tsx
│   │   │   ├── lists/page.tsx
│   │   │   ├── search/page.tsx
│   │   │   ├── settings/page.tsx          # placeholder
│   │   │   └── profiles/page.tsx
│   │   ├── lib/
│   │   │   ├── tmdb.ts                    # ★ useTrending/useDiscover/useInfiniteDiscover/useTMDBSearch/useInfiniteTMDBSearch/useTMDBDetail/useTMDBSeason/useTMDBGenres
│   │   │   ├── notflix-api.ts             # ★ useTorBoxPlay (+ audioCodec, durationSec), useSearchMovie/TV, prefetchSearchMovie/TV, releaseTorBoxPayload
│   │   │   ├── preferences.ts             # Quality/Audio prefs + feature-detect codecs + releaseNeedsTransmux
│   │   │   ├── profiles/profiles.ts       # CRUD profils + optimistic React Query mutations
│   │   │   ├── navigation.ts              # useRouter / useSearchParams adapters over TanStack Router
│   │   │   └── i18n/                      # FR default, "notflix-lng" key
│   │   └── routes/                        # TanStack Router file-based
│   ├── public/notflix-logo.svg            # the N logo (red on dark, hash-positioned strokes)
│   ├── rsbuild.config.ts                  # proxy /api → :43212, port 43210
│   └── package.json                       # includes hls.js
├── Makefile                               # auto-loads .env in `backend` target
├── .env                                   # ★ secrets, gitignored
├── .gitignore                             # excludes .env, node_modules, build outputs
└── README.md                              # user-facing setup doc
```

## Status / Phases (final, all green)

- **Phase 1 + 2** — backend greenfield (TMDB proxy, TorBox + Prowlarr clients, SQLite profile schema). ✓
- **Phase 3a-c** — frontend trim (1000+ files → 310), TMDB types + hooks, layout cleanup, stub broken Seanime imports. ✓
- **Phase 3c.5** — runtime fixes: CORS preflight (drop X-Seanime-* headers, withCredentials: false), `/api` proxy in rsbuild, Makefile `.env` auto-load. ✓
- **Phase 3d** — watch page state machine + UX 1-clic (skip splash, auto-pick, auto-fallback 3×) + Prowlarr `.torrent` fetch fallback when no magnet. ✓
- **Phase 3e** — modal détail: quality/audio prefs (localStorage), Netflix-style episode list with TMDB stills. ✓
- **Phase 3f** — scoring with title-relevance filter, codec malus/bonus (AAC +50, DDP/DTS/TrueHD penalties), feature-detect via canPlayType. ✓
- **Phase 3g** — visual rebrand: SVG N logo, lang fr, fixed HTML description, Luffy mascot retired (replaced with N panel). ✓
- **Phase 4** — streaming pipeline: ffmpeg transmux endpoint, ffprobe smart-skip (direct stream when audio is already AAC), HLS on-demand chunks (full seek + proper duration), disk cache for TMDB images, hover-prefetch Prowlarr, server-side 1h Prowlarr cache. ✓
- **Phase 3h** — profile picker + watch history wired end-to-end: poll-every-5s saver, Reprendre la lecture rail with progress bars, /lists page (Ma liste + Historique tabs), Ma liste button in modal, **resume reuses the same release** (release fields persisted in history → /watch skips Prowlarr search on resume). All mutations optimistic. ✓
- **Phase 3h.5/.6** — Catégories tab in nav (TMDB genres + filtered grid), infinite scroll on /categories and /search. ✓
- **Phase 3i** — i18n cleanup (residual `anime`/`épisode` strings in en.json/fr.json). ⏳ pending
- **Phase 4** (future) — k8s + Cloudflare Tunnel deploy. Dockerfile + manifests not yet adapted from Kuro. ⏳ pending

## Streaming pipeline cheat-sheet

When a user clicks Lecture:

1. `/watch` mounts, calls Prowlarr search (or reuses the hover-prefetched cache, or skips entirely if the URL carries `releaseSource=` from the Reprendre rail).
2. Frontend `filteredReleases` applies user prefs (quality/audio) + the hard codec filter (`releaseHasIncompatibleAudio` via canPlayType feature-detect).
3. Auto-pick the top, send to `POST /api/v1/torbox/play`. Backend resolves magnet vs `.torrent`, polls TorBox until ready, then **ffprobes the resulting stream URL** for `(audioCodec, durationSec)`.
4. Frontend decides the playback mode:
   - `audioCodec` starts with `aac` → direct stream URL, native `<video src>`. Full seek, no transcode, no server bandwidth doubling.
   - Anything else → POST `/api/v1/stream/hls/start` (passing the already-known audioCodec + durationSec so the HLS handler skips re-probing). Backend generates a VOD playlist immediately (full duration known from ffprobe), each `segment_NNNNN.ts` is transcoded on demand (`ffmpeg -ss N*4 -t 4 -c:v copy -c:a aac`). hls.js plays it.
5. `<NetflixWatchHistorySaver>` polls every 5s + on pagehide, sending `{currentTime, duration, releaseName, releaseSource, releaseInfoHash, …}` so resume can re-pick the exact same source.

## Wire-protocol identifiers — DO NOT RENAME

Some upstream Seanime identifiers were preserved on the wire because removing them broke the API:

- HTTP headers (`X-Seanime-Token`, `X-Seanime-Client-Id*`, `X-Seanime-Client-Platform`) — actually **removed from the client** as of Phase 3c.5 since the Notflix backend doesn't read them. If any code path still sends them it must not be blanket-renamed `X-Notflix-*` (CORS preflight will fail without explicit `AllowHeaders` listing).
- Type names like `__isElectronDesktop__` are kept identical to Kuro's so the inherited components compile without sweeping edits.

A bulk `s/seanime/notflix/g` across the codebase **will break** things. Targeted renames only.

## Conventions / preferences

- **Language**: French in chat. UI strings: see `notflix-web/src/lib/i18n/locales/{fr,en}.json`.
- **Length**: tight responses, no fluff. Dylan gives short directives, expects brief acknowledgments + the actual change.
- **Commits**: incremental, one logical change per commit. Push after each meaningful milestone.
- **Verification**: no `go build` or `npm install` runs in the agent environment as a long-running concern; the user runs `make dev` and screenshots. `npx --no-install rsbuild build` to smoke-test the frontend bundle without bothering the user, `go build ./...` for the backend.
- **Permissions**: `Bash(rm …)` in the project is fine — everything is versioned. Never delete outside the repo, never `git reset --hard`.

## Known traps

### Streaming / playback

- **TorBox file_id sentinel** : `pickBestVideoFile` returns -1 when no playable video file is found. 0 is a valid file ID — if the gate was `if fileID > 0` we'd request a `?zip_link=true` URL the browser can't play. See `internal/torbox/client.go` and `handlers/torbox.go`.
- **Magnet vs downloadUrl** : Prowlarr sometimes stuffs an HTTP proxy URL into the `magnetUrl` field (not a real `magnet:?…`). The frontend helper `releaseTorBoxPayload` picks the right field by priority (real magnet → infoHash-built magnet → downloadUrl). Naively sending `magnetUrl` to TorBox triggers BOZO_TORRENT.
- **Audio codec compatibility** : Chrome decodes AAC / MP3 / Opus / Vorbis natively. AC-3 / E-AC-3 (DDP) / DTS / TrueHD / Atmos require OS decoders (only Safari + Chrome-on-macOS-recent have them). Detection lives in `lib/preferences.ts` via `canPlayType`. The decision is made by `releaseNeedsTransmux` in the Player — defaults to "transmux" unless the title explicitly says AAC; the backend's ffprobe gives the actual codec, which overrides the title heuristic.
- **HLS on-demand chunks > linear ffmpeg** : a one-way ffmpeg pipe (Matroska to response) can't seek. The HLS endpoint pre-builds the VOD playlist from `ffprobe duration` (full length known immediately) and spawns a fresh ffmpeg per chunk request (`-ss N*4 -t 4 -c:v copy -c:a aac`). Each chunk pays ~0.5-1s of startup but the browser pre-fetches in parallel so sequential playback is invisible.
- **TorBox CDN host variants** : `store-NNN.*.tb-cdn.io`, `nexus-NNN.*.tb-cdn.st`, `*.tb-cdn.com`, `torrents.torbox.app` — all whitelisted in `stream.go#isAllowedStreamHost`.
- **Prowlarr title relevance** : without `filterByTitleRelevance` we got "Le Réveil de la Momie" in Super Mario Galaxy results (same year + cached on TorBox = +10 000 score wins). The filter strips bad matches before scoring. For short titles (1-2 significant words) we require the full normalised phrase as a contiguous substring, otherwise "boys" alone would match "The Gray Boys Plan…".

### Frontend

- **Hero / navbar overlap** — `NetflixTopBar` is `position: fixed`. Pages get `pt-16 lg:pt-[68px]` from `_main.tsx`. `NetflixHome` opts out with `-mt-16 lg:-mt-[68px]`.
- **Card hover scale** — `hover:scale-[1.03]` clips into neighbours without vertical room. All Notflix grids use `gap-x-4 gap-y-6 py-2`.
- **TanStack Router state leak** — navigating `/watch?id=A → /watch?id=B` reuses the same component instance. A `useEffect` keyed on `[mediaId, typeParam, season, episode]` resets state.
- **Dead-looking code that's NOT dead** — `_atoms/server-status.atoms.ts`, `_hooks/use-server-status.ts`, `simple-auth-wrapper.tsx` etc. are STUBS the build needs. Grep before deleting anything in `_atoms`, `_hooks`, `components/shared/*` that looks unused.
- **CORS + `withCredentials`** — wildcard `Access-Control-Allow-Origin: *` is rejected by browsers when the request is credentialed. axios in `api/client/requests.ts` is set to `withCredentials: false`. Don't flip it back.
- **`/api/*` proxy in dev** — `rsbuild.config.ts` proxies `/api → 127.0.0.1:43212`. Without it, relative `fetch('/api/v1/...')` hits the SPA fallback (returns `index.html` with 200) and pages go blank.
- **`make dev` without `.env`** — the Makefile sources `.env` in the `backend` target. Missing keys → backend boots but `/api/v1/tmdb/*` returns 503. Check `.env` first when the home blanks.
- **Optimistic updates** — every profile mutation in `lib/profiles/profiles.ts` patches React Query cache BEFORE the network call. Rail / lists / modal all flip instantly. The invalidate after the network reconciles placeholder ids.

### Backend

- **TorBox can't reach Prowlarr** — Prowlarr is on `127.0.0.1:9696`, TorBox in the cloud. When a release has only a `downloadUrl`, the backend fetches the `.torrent` itself (with a CheckRedirect hook for 30x→magnet redirects) and re-uploads via the multipart `file` field. See `handlers/torbox.go#fetchTorrentFromURL`.
- **Prowlarr local auth** — both `AuthenticationMethod = None` AND `AuthenticationRequired = DisabledForLocalAddresses` must be set, otherwise 401.
- **HLS session lifetime** — sessions live in memory (`hlsSessions` map) with a 15-min idle reaper. ffmpeg is NOT kept running — chunks are transcoded per-request — so closing the player doesn't leave a process behind.
- **Frontend build flakiness** — `package.json`'s `build` is `tsgo && rsbuild build`, but `tsgo` flags 30+ pre-existing TS errors that don't block dev. Use `npx --no-install rsbuild build` directly when smoke-testing.

## Quick command cheatsheet

```sh
# Boot end-to-end
make dev

# Verify the 3 external integrations
curl http://127.0.0.1:43212/api/v1/status
curl http://127.0.0.1:43212/api/v1/torbox/status
curl http://127.0.0.1:43212/api/v1/prowlarr/status

# Inspect Prowlarr ranking for a title
curl -s "http://127.0.0.1:43212/api/v1/prowlarr/search/movie?title=Tenet&year=2020" | jq '.data[:5]'

# Frontend bundle smoke test (no tsgo)
cd notflix-web && npx --no-install rsbuild build

# Backend smoke test (no run)
go build ./...

# Find broken imports after deleting a file
grep -rln "from \"@/path/to/deleted-thing" notflix-web/src --include="*.ts" --include="*.tsx"

# Recent commits
git log --oneline -20

# Inspect HLS chunk transcoding live (during a session)
ls /tmp/notflix-hls/  # session dirs are removed when idle for 15 min
```

## Who is the user

Dylan (`encheres.nc@gmail.com`). French. JS/React background — explain Go errors plainly and propose pragmatic fixes. Likes Netflix UX, hates clutter, prefers simplicity over configurability. Self-hosts on a homelab cluster (`nc-maiz.org` via Cloudflare Tunnel), but Notflix isn't deployed there yet — currently local-only validation.

## Roadmap notes for future Claude sessions

- **Phase 3i — i18n cleanup**: residual `anime`/`épisode` keys in `notflix-web/src/lib/i18n/locales/{en,fr}.json` from the Kuro lineage. Targeted edits to align with Notflix's live-action vocabulary.
- **Phase 5 — Deploy to k8s**: adapt Kuro's Dockerfile + k8s manifests for `kidnar/notflix` image, ns `notflix`, port 43212, public hostname (e.g. `notflix.nc-maiz.org`). Add a GitLab CI pipeline mirroring Kuro's. Add a Cloudflare DNS CNAME. ffmpeg + ffprobe must be installed in the runtime image — adjust the Debian-slim final stage accordingly.
- **Quality of life**:
  - `air` for Go hot-reload (so the user stops having to Ctrl+C `make dev` after every backend edit).
  - LRU eviction on the TMDB image disk cache once it goes past a budget.
  - Better Prowlarr result freshness — currently 1h TTL is a hardcoded constant.
  - Hero "Reprendre la lecture" mode when the active profile has a recent entry (replace the slideshow with a single resume card for the most recent in-progress title).
  - Sort selector on `/categories` (currently popularity desc only).
  - Skip-intro detection (would need an external API or per-episode timestamps).
