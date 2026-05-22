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

### Dev

```sh
make dev      # backend (43212) + frontend (43210), Ctrl+C stops both
make build    # bundles React → web/ → builds binary `./notflix`
make run      # build then launch
make clean    # nuke artifacts (datadir untouched)
```

The Makefile `backend` target auto-sources `.env` (gitignored) so the Go process gets `NOTFLIX_TMDB_API_KEY` / `NOTFLIX_TORBOX_API_KEY` / `NOTFLIX_PROWLARR_URL` / `NOTFLIX_PROWLARR_API_KEY` without polluting the user's shell.

### Container / k8s deploy — single-service (existing path)

```sh
make docker             # build image
make docker-push        # push to registry.gitlab.com/kidnar/notflix:latest
make deploy             # build + push + apply k8s/*.yaml + rollout restart
```

Manifests under `k8s/`. Namespace `notflix`. Single PVC `notflix-data` (30 Gi). User runs Prowlarr + FlareSolverr separately.

### Container / k8s deploy — all-in-one bundle (★ shipped)

```sh
make docker-bundle             # build the bundle image (Notflix + Prowlarr + FlareSolverr)
make docker-bundle-push        # push to registry.gitlab.com/kidnar/notflix-bundle:latest
make docker-bundle-run         # run locally for testing (ports 43212 + 9696)
make deploy-bundle             # build + push + apply k8s/bundle/*.yaml + rollout
make bundle-logs               # tail with prefixes [notflix]/[prowlarr]/[flaresolverr]
make bundle-prowlarr-ui        # port-forward Prowlarr → localhost:9696
```

Manifests under `k8s/bundle/`. Dedicated namespace `notflix-bundle` so it coexists with the single-service deploy during migration. One Pod with one container running a bash supervisor that forks Notflix + Prowlarr + FlareSolverr in parallel. `tini` is PID 1 for proper zombie reaping. See `docker/bundle/README.md` + `k8s/bundle/migrate.sh` for the migration script (k8s PVC → bundle PVC OR Docker volume → bundle PVC).

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
│   │   ├── app.go                         # DI container + tmdbCacheReaper goroutine
│   │   └── config.go                      # NOTFLIX_* env vars + defaults
│   ├── database/
│   │   ├── db/db.go                       # GORM AutoMigrate + CRUD + TMDB cache helpers
│   │   └── models/models.go               # Profile, ProfileWatchHistory, ProfileListEntry, TMDBCacheEntry
│   ├── handlers/
│   │   ├── routes.go                      # /api/v1/* wire-up
│   │   ├── tmdb_proxy.go                  # JSON proxy + path-driven SQLite cache (1h-30d TTL)
│   │   ├── tmdb_image.go                  # disk cache for image.tmdb.org
│   │   ├── torbox.go                      # cache/play/prefetch/list + ffprobe + speedTier scoring
│   │   ├── prowlarr.go                    # search + title-relevance + seeder-tier scoring + 1h cache + health endpoint
│   │   ├── stream.go                      # /stream/transmux (Matroska pipe, no-seek)
│   │   ├── hls.go                         # /stream/hls fMP4/CMAF chunks + RAM cache promotion
│   │   ├── hls_ram_cache.go               # ★ LRU bounded by chunk count, drop-by-session helper
│   │   ├── subtitle_translate.go          # raw + translated VTT caches + content-addressable variant
│   │   ├── profiles.go                    # CRUD profile + history + list + mark-series-watched
│   │   ├── backup.go                      # GET /admin/backup → JSON · POST /admin/backup/restore
│   │   └── admin_diagnostics.go           # POST /admin/test/:provider live-ping (tmdb/torbox/prowlarr/anthropic)
│   ├── anthropic/client.go                # /v1/messages + key + model hot-swap
│   ├── tmdb/client.go                     # 30s in-memory cache, fr-FR default
│   ├── torbox/client.go                   # Ping (+plan/cooldown/totalDownloaded) / CheckCached / Add* / RequestDownloadURL
│   └── prowlarr/client.go                 # REST + Torznab helpers + IndexerStats (health endpoint)
├── notflix-web/
│   ├── src/
│   │   ├── app/(main)/
│   │   │   ├── _features/netflix/         # ★ ALL Notflix-specific UI
│   │   │   │   ├── netflix-card.tsx       # 16:9 thumb + hover Prowlarr prefetch
│   │   │   │   ├── netflix-row.tsx        # horizontal scroller
│   │   │   │   ├── netflix-home.tsx       # hero + 8 rails (Trending, BecauseYouWatched, TopTen…)
│   │   │   │   ├── netflix-hero.tsx       # weekly trending slideshow
│   │   │   │   ├── netflix-top-ten.tsx    # ★ "Top 10 cette semaine" — TMDB trending/all/week + giant 1-10 numerals behind 2:3 posters
│   │   │   │   ├── netflix-detail-modal.tsx  # synopsis + episode list + Ma liste + prefs + CastCarousel + MarkSeriesWatched + speculative TorBox prefetch
│   │   │   │   ├── netflix-person-modal.tsx  # ★ opens on cast click — bio + combined_credits → clickable filmography
│   │   │   │   ├── netflix-categories.tsx    # genre tiles + infinite-scroll grid
│   │   │   │   ├── netflix-search.tsx        # multi search + infinite scroll
│   │   │   │   ├── netflix-lists.tsx         # Ma liste (multi-select + sort + filter) / Historique tabs
│   │   │   │   ├── netflix-continue-watching.tsx  # Reprendre rail with progress bars
│   │   │   │   ├── netflix-watch-history-saver.tsx  # poll 5s + pagehide
│   │   │   │   ├── netflix-profile-picker.tsx
│   │   │   │   ├── netflix-top-bar.tsx       # fixed nav + TorBoxBadge (plan + days + cooldown)
│   │   │   │   ├── netflix-bottom-tab.tsx    # mobile-only bottom nav
│   │   │   │   ├── netflix-settings.tsx      # config server + ProviderTestPanel + ProwlarrHealthPanel + BackupPanel
│   │   │   │   ├── use-slideshow.ts
│   │   │   │   └── netflix.constants.ts
│   │   │   ├── _features/layout/
│   │   │   │   ├── main-layout.tsx        # TopBar + Outlet + BottomTab + DetailModal + PersonModal + profile gate
│   │   │   │   └── offline-layout.tsx     # passthrough
│   │   │   ├── watch/page.tsx             # ★ TMDB → Prowlarr → TorBox → ffmpeg → <video>/hls.js + StatsOverlay (Ctrl+Alt+S) + SpeedBadge
│   │   │   ├── categories/page.tsx
│   │   │   ├── lists/page.tsx
│   │   │   ├── search/page.tsx
│   │   │   ├── settings/page.tsx
│   │   │   └── profiles/page.tsx
│   │   ├── lib/
│   │   │   ├── tmdb.ts                    # ★ useTrending/useDiscover/useTMDBDetail/useTMDBRecommendations/useTMDBPerson…
│   │   │   ├── notflix-api.ts             # useTorBoxPlay (+ speedTier), useSearchMovie/TV, prefetchSearchMovie/TV, releaseTorBoxPayload
│   │   │   ├── preferences.ts             # Quality/Audio prefs + feature-detect codecs + releaseNeedsTransmux
│   │   │   ├── profiles/profiles.ts       # CRUD profils + optimistic mutations + useMarkSeriesWatched
│   │   │   ├── navigation.ts              # useRouter / useSearchParams adapters over TanStack Router
│   │   │   └── i18n/                      # FR default, "notflix-lng" key
│   │   ├── components/shared/
│   │   │   ├── loading-overlay-with-logo.tsx  # ★ now renders only the spinner — big N retired
│   │   │   └── luffy-error.tsx                 # ★ N path replaced with BiErrorCircle
│   │   └── routes/                        # TanStack Router file-based
│   ├── public/notflix-logo.svg            # the N logo (red on dark) — top bar + login chrome only
│   ├── rsbuild.config.ts                  # proxy /api → :43212, port 43210
│   └── package.json                       # includes hls.js
├── Dockerfile                             # single-service runtime image
├── Dockerfile.bundle                      # ★ all-in-one: Notflix + Prowlarr + FlareSolverr + tini + Chromium
├── docker/bundle/
│   ├── entrypoint.sh                      # bash supervisor — starts the 3 services, propagates SIGTERM, exits on first child death
│   └── README.md                          # bundle docs + caveats
├── k8s/                                   # single-service manifests (namespace `notflix`)
│   ├── namespace.yaml · pvc.yaml · deployment.yaml · service.yaml · ingress.yaml
├── k8s/bundle/                            # ★ bundle manifests (namespace `notflix-bundle`)
│   ├── namespace.yaml · pvc.yaml · deployment.yaml · service.yaml · ingress.yaml
│   └── migrate.sh                         # k8s PVC OR Docker volume → bundle PVC, via `kubectl exec | tar`
├── Makefile                               # auto-loads .env in `backend` target; bundle targets included
├── .env                                   # ★ secrets, gitignored
├── .gitignore                             # excludes .env, node_modules, build outputs
└── README.md                              # user-facing setup doc
```

## Status / Phases

### Done

- **Phases 1-3 baseline** — backend greenfield, frontend trim (1000+ files → 310), CORS / proxy / Makefile fixes, watch page UX, auto-pick + auto-fallback, profile picker + history end-to-end, Catégories + infinite scroll, scoring with title-relevance, codec feature-detect.
- **Phase 4 — Streaming pipeline overhaul** (★ heavily reworked):
  - Pure-stream mode: removed the source-MKV disk cache, the full-encode background passes, and the multi-variant ABR ladder. Only the source variant remains, codec-copy.
  - fMP4 / CMAF chunks instead of MPEG-TS. Per-variant `init.mp4` referenced via `#EXT-X-MAP`. Enables HEVC playthrough on Safari + recent Chrome.
  - RAM cache LRU (128 chunks ≈ 500 MB max) in front of the disk cache — re-seeks inside the playback window are sub-ms.
  - Parallel prebake (4 ffmpeg workers) for the first 10 chunks at session open.
  - HTTP-demuxer tuning (`-multiple_requests 1 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -rw_timeout 30000000 -seekable 1`) on every ffmpeg call.
  - Direct-play widened: AC3 / EAC3 / FLAC codec strings handed to `canPlayType` so Safari + Edge can bypass HLS for those audio tracks too.
- **Phase 5 — Caching** :
  - Subtitle translation cache made **content-addressable** (sha256 of raw VTT + lang). Survives TorBox stream-URL rotation → Claude API called exactly ONCE per (subtitle, lang) across the install's lifetime.
  - TMDB **SQLite cache** with path-driven TTL (1h–30d). Background reaper purges expired rows hourly. Survives backend restarts. Pages load 3–5× faster on repeat visits.
- **Phase 6 — UI additions**:
  - "Parce que tu as regardé X" personalised home row (TMDB recommendations off the most recent watch entry).
  - "Top 10 cette semaine" row (TMDB `/trending/all/week`, top 10, giant 1-10 numerals behind 2:3 posters — Netflix-signature look).
  - **Cast carousel** + **NetflixPersonModal** with clickable filmography (Movie → Actor → Other Movie navigation).
  - Lists tab: **multi-select + bulk delete + sort (recent / A-Z) + filter (Films / Séries)**.
  - TV detail: **"Marquer toute la série vue"** — bulk-upserts every (season, episode) so the show drops out of Continue Watching.
  - Settings: **Prowlarr health panel** (per-indexer status dots from `/indexerstats`).
  - Settings: **Provider test buttons** (TMDB / TorBox / Prowlarr / Anthropic live ping with green/red dots + info text).
  - Settings: **Backup / Restore** — JSON download / upload covering profiles + history + lists + server keys.
  - Top bar: **TorBox status badge** (plan + days-until-expiry + cooldown indicator).
  - Watch page: **Stats overlay** (`Ctrl+Alt+S`) — codec / level / bandwidth EWMA / buffer / dropped frames.
- **Phase 7 — Source-picking improvements**:
  - Seeder-tier scoring for non-cached releases (<3 seeders = −200 disqualifier; 50+ = +30 bonus). Cached keeps the +1M kingmaker bonus.
  - **Speed badge** in the source picker (instant / fast / normal / slow / very_slow, with ⚡/🐢 + color).
  - **Speculative TorBox prefetch** — when the user dwells 5 s on a detail modal, the best non-cached fast/normal release is silently `AddMagnet`'d so it's already part-fetched by the time the user clicks Play.
- **Phase 8 — UX cleanups** :
  - Killed the big-N splash on auth refetch / route transitions (`LoadingOverlayWithLogo` now renders a spinner; `LuffyError`'s inlined N replaced with `BiErrorCircle`).
  - Removed the trailer feature entirely — YouTube embed kept failing on the user's network despite oEmbed pre-checks + youtube-nocookie.com fallback. Better no trailer than a broken trailer.
  - Removed scrub-bar thumbnails (was shipped briefly, then reverted by user request).
- **Phase 9 — Bundle deploy** (★ shipped):
  - `Dockerfile.bundle` + `docker/bundle/entrypoint.sh` — single image with Notflix + Prowlarr + FlareSolverr, supervised by a bash script under tini.
  - `k8s/bundle/*.yaml` — dedicated namespace, single Pod, two exposed ports (43212 + 9696), init-container chown.
  - `k8s/bundle/migrate.sh` — copies state from existing k8s PVC OR local Docker volume into the bundle PVC via `kubectl exec | tar` (no local round-trip).

### Pending

- **i18n cleanup** — residual `anime`/`épisode` strings in `en.json` / `fr.json` plus the orphan `modal.trailer*` keys left after the trailer removal.
- **Anthropic invoice safety** — current Claude calls are bounded but unbounded *per content cache miss*. Per-install hard cap would prevent runaway costs if the cache TTL changed.

## Streaming pipeline cheat-sheet

When a user clicks Lecture:

1. `/watch` mounts, calls Prowlarr search (or reuses the hover-prefetched cache, or skips entirely if the URL carries `releaseSource=` from the Reprendre rail).
2. Frontend `filteredReleases` applies user prefs (quality/audio) + the hard codec filter (`releaseHasIncompatibleAudio` via `canPlayType` feature-detect, which now reports "probably" for AC3/EAC3/FLAC on Safari + Edge).
3. Auto-pick the top, send to `POST /api/v1/torbox/play`. Backend resolves magnet vs `.torrent`, polls TorBox until ready, then **ffprobes the resulting stream URL** for `(container, audioCodec, videoCodec, durationSec, subtitles)`.
4. Frontend decides the playback mode via `canBrowserPlayDirect(container, videoCodec, audioCodec)`:
   - `probably` → direct stream URL, native `<video src>`. Full seek, no transcode, no server bandwidth doubling.
   - else → POST `/api/v1/stream/hls/start`. Backend's HLS handler:
     - Opens a session (sha256(URL)[:8] → in-memory map). Background prebake of 10 source chunks (parallel, 4 workers).
     - Builds the variant playlist on the fly from `sess.duration` (`#EXT-X-VERSION:7`, `#EXT-X-MAP:URI="init_source.mp4"`, then N `segment_source_NNNNN.m4s` entries). hls.js loads the init segment once, then fetches segments lazily.
     - Each `segment_source_NNNNN.m4s` request hits the three-tier cache: RAM → disk → bake (`ffmpeg -ss N*4 -t 4 -c copy -movflags +empty_moov+default_base_moof+frag_keyframe+omit_tfhd_offset+separate_moof -f mp4`). The bake populates both tiers.
5. Subtitle prep (when user wants a target language):
   - Raw VTT cached per-session at `<datadir>/cache/subtitles/<digest>.vtt`.
   - **Translated** VTT cached **content-addressable** at `<datadir>/cache/subtitles/by-content/<sha256(rawVTT)+lang>.vtt`. Re-watches never re-pay Claude.
6. `<NetflixWatchHistorySaver>` polls every 5 s + on pagehide, sending `{currentTime, duration, releaseName, releaseSource, releaseInfoHash, …}` so resume can re-pick the exact same source.
7. `<StatsOverlay>` (toggled with `Ctrl+Alt+S`) reads `hls.bandwidthEstimate` + `video.getVideoPlaybackQuality()` for live diagnostics.

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
- **Audio codec compatibility** : Chrome decodes AAC / MP3 / Opus / Vorbis natively. AC-3 / E-AC-3 (DDP) / DTS / TrueHD / Atmos require OS decoders (Safari + Chrome-on-macOS-recent have them — we now hand canPlayType the codec strings for those so direct-play kicks in when supported). Detection lives in `lib/preferences.ts` via `canPlayType`.
- **fMP4 / CMAF, not MPEG-TS** : `bakeOneHLSChunk` emits `-f mp4 -movflags +empty_moov+default_base_moof+frag_keyframe+omit_tfhd_offset+separate_moof`. The per-variant `init.mp4` is generated by a one-off pass through ffmpeg's HLS muxer in fmp4 mode (throwaway .m4s + .m3u8 are cleaned up; only `init.mp4` is kept). URL shape `init_<variant>.mp4` + `segment_<variant>_NNNNN.m4s` — the dispatch flattens path separators for traversal safety.
- **HLS chunk RAM cache** : process-wide LRU (`getHLSRAMCache()`), cap 128 entries. Bake path populates both RAM + disk; serve path reads RAM first, promotes disk hits into RAM on the way out. Reaper drops the matching prefix on session expiry. Surface via `X-Hls-Source: ram | cache | ffmpeg` response header.
- **HTTP demuxer flags** : `ffmpegHTTPInputFlags()` in `hls.go` returns the shared flag set (`-multiple_requests 1`, `-reconnect`, `-reconnect_streamed`, `-reconnect_delay_max`, `-rw_timeout 30000000`, `-seekable 1`). MUST appear BEFORE `-i URL` on the command line — they're input options. Three sites use them: `bakeOneHLSChunk`, `extractEmbeddedSubtitleWithProgress`, `extractExternalSubtitleVTT`.
- **TorBox CDN host variants** : `store-NNN.*.tb-cdn.io`, `nexus-NNN.*.tb-cdn.st`, `*.tb-cdn.com`, `torrents.torbox.app` — all whitelisted in `stream.go#isAllowedStreamHost`.
- **Prowlarr title relevance** : without `filterByTitleRelevance` we got "Le Réveil de la Momie" in Super Mario Galaxy results. The filter strips bad matches before scoring. For short titles (1-2 significant words) we require the full normalised phrase as a contiguous substring.
- **Seeder-tier scoring** : non-cached releases below 3 seeders get −200 (effectively disqualified). 50+ seeders get +30. Cached releases keep the +1M bonus and skip the seeder-tier path. See `scoreRelease()` in `prowlarr.go`.
- **Speculative TorBox prefetch dedupe** : `useTorBoxPrefetch` (front) + in-process `prefetchKeys` map (back) ensure each infoHash is `AddMagnet`'d at most once per session. 30-minute soft TTL on the back-end side so reopening the same modal hours later doesn't accidentally re-trigger.
- **Content-addressable subtitle translations** : the translated cache key is `sha256(rawVTT) + lang`, NOT sessionID. TorBox stream URLs are short-lived signed URLs → same MKV gets a fresh session ID on every launch. With sessionID-keyed caches we re-translated every time. Stored under `<datadir>/cache/subtitles/by-content/`.

### Frontend

- **Hero / navbar overlap** — `NetflixTopBar` is `position: fixed`. Pages get `pt-16 lg:pt-[68px]` from `_main.tsx`. `NetflixHome` opts out with `-mt-16 lg:-mt-[68px]`.
- **Card hover scale** — `hover:scale-[1.03]` clips into neighbours without vertical room. All Notflix grids use `gap-x-4 gap-y-6 py-2`.
- **TanStack Router state leak** — navigating `/watch?id=A → /watch?id=B` reuses the same component instance. A `useEffect` keyed on `[mediaId, typeParam, season, episode]` resets state.
- **Dead-looking code that's NOT dead** — `_atoms/server-status.atoms.ts`, `_hooks/use-server-status.ts`, `simple-auth-wrapper.tsx` etc. are STUBS the build needs. Grep before deleting anything in `_atoms`, `_hooks`, `components/shared/*` that looks unused.
- **CORS + `withCredentials`** — wildcard `Access-Control-Allow-Origin: *` is rejected by browsers when the request is credentialed. axios in `api/client/requests.ts` is set to `withCredentials: false`. Don't flip it back.
- **`/api/*` proxy in dev** — `rsbuild.config.ts` proxies `/api → 127.0.0.1:43212`. Without it, relative `fetch('/api/v1/...')` hits the SPA fallback (returns `index.html` with 200) and pages go blank.
- **`make dev` without `.env`** — the Makefile sources `.env` in the `backend` target. Missing keys → backend boots but `/api/v1/tmdb/*` returns 503. Check `.env` first when the home blanks.
- **Optimistic updates** — every profile mutation in `lib/profiles/profiles.ts` patches React Query cache BEFORE the network call. Rail / lists / modal all flip instantly. The invalidate after the network reconciles placeholder ids.
- **Don't resurrect the big-N splash** — `LoadingOverlayWithLogo` and `LuffyError` were intentionally gutted of the N logo because they flashed on every auth refetch / route transition. Their bodies render the small spinner / a `BiErrorCircle`. If you want a real branded boot splash later, build a NEW component — don't restore those two.
- **Person modal lives in main-layout** — `<NetflixPersonModal />` is mounted at layout level alongside `<NetflixDetailModal />` so they stack cleanly. Click on a cast member → opens the person modal (z-index 75). Click on a filmography card → closes person modal + opens detail modal for that title. `window.setTimeout(50)` between close + open avoids the focus-trap fighting.
- **Lists multi-select / sort / filter** — `MyListGrid` keeps a `Set<string>` of selected keys, a `sort` mode (`recent | alphabetical`), and a `filter` mode (`all | movie | tv`). The checkbox per card is hover-only outside selection mode, always-on once `selected.size > 0`. Single-card remove still works (hidden in selection mode to avoid conflicting affordances).
- **No trailer feature** — TMDB videos.results is no longer consumed. The button + modal + YouTube oEmbed pre-check were removed because the embed kept failing on the user's network. Translation keys `modal.trailer*` remain in the locale files (orphan, harmless).

### Backend

- **TorBox can't reach Prowlarr** — Prowlarr is on `127.0.0.1:9696`, TorBox in the cloud. When a release has only a `downloadUrl`, the backend fetches the `.torrent` itself (with a CheckRedirect hook for 30x→magnet redirects) and re-uploads via the multipart `file` field. See `handlers/torbox.go#fetchTorrentFromURL`.
- **Prowlarr local auth** — both `AuthenticationMethod = None` AND `AuthenticationRequired = DisabledForLocalAddresses` must be set, otherwise 401.
- **HLS session lifetime** — sessions live in memory (`hlsSessions` map) with a 15-min idle reaper. The reaper now drops RAM cache entries + sprite thumbnails dir (if extant) too. ffmpeg is NOT kept running.
- **Frontend build flakiness** — `package.json`'s `build` is `tsgo && rsbuild build`, but `tsgo` flags 30+ pre-existing TS errors that don't block dev. Use `npx --no-install rsbuild build` directly when smoke-testing.
- **`_test.go` suffix is a Go test file** — gotcha: naming a file `admin_test.go` makes Go exclude it from normal builds (`go build ./...` succeeds; the symbols simply aren't in the binary). The diagnostic endpoint lives in `admin_diagnostics.go` for this reason — early draft was `admin_test.go` and the build failed with `HandleTestProvider undefined`.
- **TMDB cache key excludes api_key** — the cache key is `sha256(path + sorted query params minus api_key)`. Rotating the TMDB key doesn't invalidate the cache — content doesn't depend on which key fetched it. Path-driven TTL: detail pages 7d, configuration 30d, trending/popular 6h, search 1h.
- **Bundle restart-as-a-unit** — `entrypoint.sh` exits on the first child death so docker/k8s restart the whole container. A dead Prowlarr starves Notflix anyway; restarting them together is the simplest correct behavior. Don't add per-service restart logic to the script.

## Quick command cheatsheet

```sh
# Boot end-to-end
make dev

# Verify the 3 external integrations
curl http://127.0.0.1:43212/api/v1/status
curl http://127.0.0.1:43212/api/v1/torbox/status
curl http://127.0.0.1:43212/api/v1/prowlarr/status

# Live-ping a provider (admin auth required)
curl -X POST http://127.0.0.1:43212/api/v1/admin/test/tmdb       # or torbox / prowlarr / anthropic

# Inspect Prowlarr ranking for a title
curl -s "http://127.0.0.1:43212/api/v1/prowlarr/search/movie?title=Tenet&year=2020" | jq '.data[:5]'

# Inspect Prowlarr health (per-indexer dots)
curl -s http://127.0.0.1:43212/api/v1/prowlarr/health | jq '.data.indexers[] | {name, status, failures, queries}'

# Backup everything to JSON
curl -O http://127.0.0.1:43212/api/v1/admin/backup

# Frontend bundle smoke test (no tsgo)
cd notflix-web && npx --no-install rsbuild build

# Backend smoke test (no run)
go build ./...

# Find broken imports after deleting a file
grep -rln "from \"@/path/to/deleted-thing" notflix-web/src --include="*.ts" --include="*.tsx"

# Recent commits
git log --oneline -20

# Inspect HLS state — chunks live under <datadir>/cache/hls-chunks/<sid>/source/*.m4s
# (init segment is init.mp4). Sessions reaped after 15 min idle.
ls "${NOTFLIX_DATA_DIR:-$HOME/.notflix-data}/cache/hls-chunks/"

# Bundle deploy (k8s)
make docker-bundle-push                 # build + push notflix-bundle image
make deploy-bundle                      # apply k8s/bundle/*.yaml + rollout
make bundle-logs                        # tail [notflix]/[prowlarr]/[flaresolverr]
make bundle-prowlarr-ui                 # port-forward Prowlarr → localhost:9696

# Bundle migration (k8s PVC → bundle PVC, or Docker volume → bundle PVC)
bash k8s/bundle/migrate.sh --prowlarr-pvc <name>      # k8s source
bash k8s/bundle/migrate.sh --prowlarr-volume <name>   # local Docker source
bash k8s/bundle/migrate.sh --skip-prowlarr            # Notflix only
```

## Who is the user

Dylan (`encheres.nc@gmail.com`). French. JS/React background — explain Go errors plainly and propose pragmatic fixes. Likes Netflix UX, hates clutter, prefers simplicity over configurability. Self-hosts on a homelab cluster (`nc-maiz.org` via Cloudflare Tunnel), but Notflix isn't deployed there yet — currently local-only validation.

## Roadmap notes for future Claude sessions

### Still pending

- **i18n cleanup**: residual `anime`/`épisode` strings + orphan `modal.trailer*` keys in `notflix-web/src/lib/i18n/locales/{en,fr}.json`.
- **TMDB image disk cache eviction**: currently grows unbounded under `<datadir>/cache/tmdb-img/`. Add an LRU or size-based reaper.
- **Bundle slim variant**: a `Dockerfile.bundle.slim` without Chromium/Python/Flaresolverr (~350 MB vs ~900 MB) for users who don't need Cloudflare bypass. Trigger by user's preference / their indexer mix.

### Nice-to-have UI

- **Next episode autoplay + countdown** at episode end.
- **Skip intro / Skip outro** — manual button initially, chromaprint auto-detect later.
- **Subtitle styling** — taille / police / position / couleur, configurable from settings with live preview.
- **Live search suggestions** as user types (top 5 with thumbnails).
- **Profile avatars from images** instead of emoji-only.
- **PIN parental** on child profiles.

### Operational

- **`air` for Go hot-reload** so the user stops having to Ctrl+C `make dev` after every backend edit.
- **GitLab CI mirroring** — push triggers a docker build + push to `registry.gitlab.com/kidnar/notflix*` automatically (Kuro has this; Notflix doesn't yet).
- **Public hostname** for the bundle — currently `notflix-bundle.maiz.local` (in-LAN only). Wire it through Cloudflare Tunnel + DNS CNAME for public access. Reuse the `kuro.nc-maiz.org` pattern.
