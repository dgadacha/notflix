<p align="center">
  <img src="notflix-web/public/notflix-logo.svg" alt="Notflix" width="96"/>
</p>

<h1 align="center">Notflix</h1>

<p align="center">
  Une app de streaming auto-hébergée façon Netflix — films &amp; séries (live-action).
  <br/>
  <em>Fork de <a href="https://github.com/dgadacha/kuro">Kuro</a>, lui-même fork de <a href="https://github.com/5rahim/seanime">Seanime</a>.</em>
</p>

---

## Pourquoi ce fork

[Kuro](https://github.com/dgadacha/kuro) couvre les animes via AniList +
extensions de streaming JS. Notflix garde **toute l'UX polished** de Kuro
(picker "Qui regarde ?", historique par profil, bottom tab mobile, hero
"Reprendre", modale Mes listes, etc.) mais swap la couche catalogue :

| | Kuro | Notflix |
|---|---|---|
| Catalogue | AniList | **TMDB** (films + séries live-action) |
| Streaming | extensions JS (anime-sama, french-anime…) | **Vidsrc iframe** (multi-hôtes failover) |
| Cible | animes | films + séries (Marvel, Nolan, HBO…) |
| Bind | `:43211` | `:43212` (cohabite avec Kuro) |
| Datadir | `~/.seanime-data` | `~/.notflix-data` |

Architecture identique : Go + React, profils-aware, deploy container/k8s,
GitLab Agent + auto-deploy, etc.

## État du fork

**Phase 1 — fork + rebrand** ✓ (ce commit) : la base Kuro est copiée et
toutes les références `Kuro/kuro` ont été swap vers `Notflix/notflix`.
Le module Go est `notflix`, le binaire produit est `notflix`, le frontend
dir est `notflix-web`, le ns k8s est `notflix`. À ce stade ça compile et
tourne comme Kuro, juste rebrand.

**Phase 2 — trim backend + TMDB** (à venir) : virer les packages anime
(`internal/manga`, `internal/onlinestream`, `internal/extension`,
`internal/anilist`, `internal/torrent_clients`, etc.) et brancher un
proxy TMDB à la place.

**Phase 3 — frontend → TMDB** (à venir) : swap `AL_BaseAnime` → `TMDBMedia`
partout, remplacer la watch page par une iframe Vidsrc, garder profils +
historique + Mes listes + bottom tab + safe-area iPhone.

## Stack

- **Backend** : Go 1.26 — Echo, GORM/SQLite. Binaire unique avec React embarqué via `//go:embed`.
- **Frontend** : React + TanStack Router + Tailwind, bundle via Rsbuild. State Jotai + React Query.
- **Catalogue** (Phase 2+) : TMDB (gratuit, clé requise).
- **Streaming** (Phase 2+) : Vidsrc.xyz / .to / .cc (iframe embed).
- **Déploiement** : Dockerfile multi-stage + manifests k8s.

## Setup local

```sh
make dev      # backend (43212) + frontend (43210)
make build    # binaire avec UI embarquée
make run      # build + lance
```

## Crédits

- Fork de [dgadacha/kuro](https://github.com/dgadacha/kuro), lui-même fork de [5rahim/seanime](https://github.com/5rahim/seanime).
- Catalogue : [The Movie Database (TMDB)](https://www.themoviedb.org/) — usage personnel non-commercial.
- Streaming : Vidsrc.xyz / Vidsrc.to / Vidsrc.cc.
