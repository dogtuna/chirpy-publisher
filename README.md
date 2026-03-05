# Chirpy Publisher

Chirpy Publisher is a self-hosted, sovereign social publishing app.

It lets you:

- create rich-media posts locally
- stage/publish posts to IPFS/IPNS
- run identity profiles with local keys
- maintain family/private visibility via encryption
- discover other nodes through lightweight PubSub presence
- run as a desktop app with bundled sidecars (IPFS + Ollama)

No central backend is required for private keys.

## What Chirpy Is

Chirpy is designed as a network of independent sites using shared protocol rules:

- each node owns its own keys
- public metadata is shared over open channels
- private content is encrypted for recipients
- no single host has everyone’s private data

Protocol docs: [docs/network-protocol.md](docs/network-protocol.md)

## Security Model

- Private keys stay local (browser storage + local IPFS repo)
- `ipfs-data/` is ignored by git
- `staged/` is ignored by git
- `runtime/` is ignored by git
- this repo can be public without exposing your private posts or local keys, as long as ignored paths are not force-added

## Requirements

- Node.js 20+
- `ffmpeg` in `PATH`
- For desktop builds: platform binaries in `resources/bin` (IPFS + Ollama)

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Default URL: `http://localhost:3020`

- Publisher UI: `http://localhost:3020/`
- My ChirpSpace: `http://localhost:3020/chirpspace.html`
- UI versions page: `http://localhost:3020/versions`

## Desktop (Electron)

Run desktop shell in development:

```bash
npm run desktop
```

Build installers:

```bash
npm run build:desktop
```

### Sidecar Binaries

Add binaries before packaging:

- `resources/bin/darwin-arm64/ipfs`
- `resources/bin/darwin-arm64/ollama`
- `resources/bin/darwin-x64/ipfs`
- `resources/bin/darwin-x64/ollama`
- `resources/bin/linux-x64/ipfs`
- `resources/bin/linux-x64/ollama`
- `resources/bin/win32-x64/ipfs.exe`
- `resources/bin/win32-x64/ollama.exe`

On app start, Chirpy will:

1. start bundled IPFS if no daemon is active
2. initialize `IPFS_PATH` on first run and enable pubsub
3. start bundled Ollama if not already active
4. pull `nomic-embed-text` model in background
5. launch ChirpSpace dashboard

## First-Time Setup

On first run, Chirpy automatically opens the Identity panel and requires setup before staging posts.

It walks through:

1. Node Name (network-visible, uniqueness checked against active nodes)
2. Profile Name (must be unique on your local node only)
3. DID generation
4. IPNS key discovery/creation
5. Encryption key generation

## Basic Usage

1. Build a post with blocks (`text`, `title`, `image`, `video`, `link`)
2. Add media files
3. Style the card/frame
4. Stage post
5. Optionally publish to IPFS/IPNS
6. View history and ChirpSpace feed

## Key APIs

- `GET /api/network-node`
- `GET /api/network-node/check-name?name=...`
- `POST /api/network-node`
- `POST /api/network-node/profile` (announce active DID/IPNS for discovery)
- `GET /api/users` (presence users ordered by last activity)
- `GET /api/protocol/schemas`
- `POST /api/protocol/validate` with `{ schemaId, payload }`
- `GET /api/link-preview?url=...`
- `POST /stage` (multipart, media pipeline with image/video processing)
- `GET /api/stages`
- `GET /api/stages/:stageId`
- `GET /api/chirpspace?...`
- `POST /api/chirpspace/:stageId/make-public`
- `GET /staged/:stageId/...`

## Protocol Validation

You can test payload compatibility:

```bash
curl -X POST http://localhost:3020/api/protocol/validate \
  -H "content-type: application/json" \
  -d '{
    "schemaId":"chirpy.presence.v1",
    "payload":{
      "schema":"chirpy.presence/1.0.0",
      "id":"node-12345678",
      "name":"node-alpha",
      "timestamp":"2026-03-05T12:00:00.000Z"
    }
  }'
```

## Environment Variables

- `PORT` (default `3020`)
- `CHIRPY_NODE_NAME` (optional fixed node name)
- `CHIRPY_PRESENCE_TOPIC` (default `chirpy.users.v1`)
- `CHIRPY_PRESENCE_HEARTBEAT_MS` (default `30000`)
- `CHIRPY_PRESENCE_STALE_MS` (default `300000`)
- `CHIRPY_PUBSUB_TOPIC` (default `chirpy.new-post`)
- `REQUIRE_IPFS` (default `false`)
- `OLLAMA_HOST` (default `http://127.0.0.1:11434`)
- `OLLAMA_MODEL` (default `llama3.2:3b`)

## Notes

- If `ipfs` is unavailable, the app still works locally, but cross-node presence/publish features are limited.
- In desktop mode, if sidecar binaries are missing, the UI still opens but runtime status shows missing engines.
- Do not force-add ignored paths when committing (`ipfs-data`, `staged`, `runtime`).
