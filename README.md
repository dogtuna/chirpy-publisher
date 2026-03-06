# Chirpy Publisher

Chirpy Publisher is a self-hosted social publishing app with a local-first identity model, IPFS publishing, LAN discovery, and AI-assisted tagging.

Chirpy has two main surfaces:
- `Publisher` (`/`): create, stage, and publish posts.
- `My ChirpSpace` (`/chirpspace.html`): browse feeds, discovered Chirpers, and topic-filtered views.

## Core Principles

- Local-first identity: profiles, DIDs, IPNS selection, and encryption keys are managed on your node.
- Sovereign runtime: no central backend required for your keys or staged content.
- Inter-node discovery: Chirpers discover each other via pubsub + LAN presence.
- Audience-centric tagging: AI tags try to route posts to interested audiences, not just extract words.

## Current Feature Set

### Publisher
- Block-based composer (`text`, `title`, `image`, `video`, `link`).
- Rich media processing:
  - Images: framing/border/background controls + WebP output.
  - Videos: ffmpeg processing + HLS/gif preview when available.
- Per-block frame overrides for image border/frame background.
- Staging history and lens preview.
- Optional publish to IPFS/IPNS.

### Identity / Setup
- Identity menu with profile management (`new`, `rename`, `delete`).
- First-time walkthrough to complete required setup.
- DID generation, encryption key generation, IPNS key creation/selection.
- Node label (local label only; not global identity).
- Desktop Chirper profile (nickname + interests).

### Preferences Manager (Identity Menu)
- Search/add topic preferences.
- Topic bank management:
  - Auto-populated from current post tags.
  - Supports custom topics not yet seen in posts.
- Hidden topic controls:
  - Unhide globally hidden topics.
  - Unhide per-user hidden topics.

### ChirpSpace
- Chirpers radar with activity ordering.
- Click Chirper name to load that Chirper's public feed.
- Click topic tags for menu actions:
  - View: all posts on topic / this user on topic.
  - Hide: all posts on topic / this user on topic.
- Synergy ordering: shared topics with your local profile history are prioritized.
- Cross-node public feed loading via local proxy endpoint.

### Discovery / Presence
- Presence topic: `chirpy.users.v1`.
- Pubsub presence + LAN UDP heartbeat + LAN HTTP peer scan fallback.
- Users ordered by last activity.
- Presence payload includes tag summaries and reachable HTTP base metadata.

### AI Tagging
- Ollama-backed semantic routing + niche inference.
- Topic-bank-aware prompting and tag alignment:
  - known topics are provided as hints,
  - tags are aligned to existing known topics when semantically appropriate,
  - new topics still allowed when genuinely new.

## Security and Data Boundaries

Chirpy is designed so publishing this repo does not expose your private keys/content by default:

- Local runtime/state paths are git-ignored:
  - `ipfs-data/`
  - `runtime/`
  - `staged/`
- Sidecar binaries are bundled intentionally under `resources/bin/*` (public executable artifacts, not secrets).
- Identity and encryption materials are generated locally per node/profile.

Important: do not force-add ignored runtime directories.

## Requirements

- Node.js `>=20`
- `npm`
- `ffmpeg` in `PATH` (for full video processing)
- Electron runtime deps (installed via `npm install`)

## Install

```bash
npm install
```

## Run (Web Server Mode)

```bash
npm start
```

Default:
- Publisher: `http://localhost:3020/`
- My ChirpSpace: `http://localhost:3020/chirpspace.html`

## Run (Desktop / Electron)

```bash
npm run desktop
```

## Build Desktop Installers

```bash
npm run build:desktop
```

## Sidecar Binaries Layout

Place binaries under `resources/bin`:

- `resources/bin/darwin-arm64/ipfs`
- `resources/bin/darwin-arm64/ollama`
- `resources/bin/darwin-x64/ipfs`
- `resources/bin/darwin-x64/ollama`
- `resources/bin/linux-x64/ipfs`
- `resources/bin/linux-x64/ollama`
- `resources/bin/win32-x64/ipfs.exe`
- `resources/bin/win32-x64/ollama.exe`

Notes:
- Ollama binary must be daemon-capable (`serve` style supported by the launcher flow in this repo).
- Current repo includes active work around sidecar startup compatibility across macOS variants.

## First Run Flow (Expected)

1. Open Identity menu.
2. Run first-time setup.
3. Ensure profile has DID, encryption keys, and non-`self` IPNS key.
4. Save Chirper nickname + interests.
5. Confirm runtime status (`IPFS`, `Ollama`, model readiness).
6. Stage/publish first post.

## Key API Endpoints

### Setup / Identity
- `GET /api/setup`
- `GET /api/network-node`
- `POST /api/network-node`
- `GET /api/network-node/check-name?name=...`
- `POST /api/network-node/profile`
- `POST /api/identity/create`
- `POST /api/identity/encryption-keys`
- `GET /api/ipfs/keys`
- `POST /api/ipfs/keys`

### Posts / Feeds
- `POST /stage`
- `GET /api/stages`
- `GET /api/stages/:stageId`
- `GET /api/chirpspace`
- `GET /api/chirpspace/remote`
- `POST /api/chirpspace/:stageId/make-public`

### Discovery / Protocol
- `GET /api/users`
- `GET /api/presence/self`
- `GET /api/protocol/schemas`
- `POST /api/protocol/validate`

### Topic Bank
- `GET /api/topic-bank`
- `PUT /api/topic-bank`

## Environment Variables

- `PORT` (default `3020`)
- `CHIRPY_BIND_HOST` (default `0.0.0.0`)
- `CHIRPY_IPFS_BIN` (default `ipfs`)
- `CHIRPY_IPFS_API` (default `http://127.0.0.1:5001`)
- `CHIRPY_PRESENCE_TOPIC` (default `chirpy.users.v1`)
- `CHIRPY_PUBSUB_TOPIC` (default `chirpy.new-post`)
- `CHIRPY_PRESENCE_HEARTBEAT_MS` (default `30000`)
- `CHIRPY_PRESENCE_STALE_MS` (default `300000`)
- `CHIRPY_LAN_PRESENCE_PORT` (default `47777`)
- `CHIRPY_LAN_PRESENCE_ADDR` (default `255.255.255.255`)
- `CHIRPY_LAN_SCAN_ENABLED` (default `true`)
- `CHIRPY_LAN_SCAN_TIMEOUT_MS` (default `900`)
- `CHIRPY_OLLAMA_TIMEOUT_MS` (default `7000`)
- `OLLAMA_HOST` (default `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` (default `llama3.2:3b`)
- `OLLAMA_EMBED_MODEL` (default `nomic-embed-text`)
- `REQUIRE_IPFS` (default `false`)

## Development Notes

- `npm run check` performs syntax checks for core runtime files.
- Presence and radar behavior are eventually consistent by design; allow a heartbeat cycle before validating peer visibility.
- Some settings (topic hides) are currently client-local (`localStorage`) by design.
