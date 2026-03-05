const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const multer = require('multer');
const sharp = require('sharp');

const projectRoot = path.join(__dirname, '..');
const stageRoot = path.resolve(projectRoot, process.env.STAGE_OUTPUT_DIR || 'staged');
const runtimeRoot = path.join(projectRoot, 'runtime');
const uploadRoot = path.join(runtimeRoot, 'uploads');

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3020', 10);
const BIND_HOST = String(process.env.CHIRPY_BIND_HOST || '0.0.0.0').trim() || '0.0.0.0';
const IPFS_CMD = String(process.env.CHIRPY_IPFS_BIN || 'ipfs').trim() || 'ipfs';

const presenceTopic = process.env.CHIRPY_PRESENCE_TOPIC || 'chirpy.users.v1';
const publishTopic = process.env.CHIRPY_PUBSUB_TOPIC || 'chirpy.new-post';
const presenceHeartbeatMs = Number.parseInt(process.env.CHIRPY_PRESENCE_HEARTBEAT_MS || '30000', 10);
const presenceStaleMs = Number.parseInt(process.env.CHIRPY_PRESENCE_STALE_MS || '300000', 10);
const usersFile = path.join(runtimeRoot, 'users.json');
const instanceFile = path.join(runtimeRoot, 'instance.json');

const upload = multer({
  dest: uploadRoot,
  limits: {
    fileSize: 1024 * 1024 * 1024,
    files: 50
  }
});

const presenceState = {
  instanceId: null,
  peerId: null,
  nodeName: '',
  profileDid: '',
  profileIpnsKey: '',
  usersById: new Map(),
  subscriber: null,
  heartbeatTimer: null,
  saveTimer: null,
  ipfsReady: false
};

const protocolSchemas = {
  'chirpy.public-profile.v1': {
    type: 'object',
    required: ['schema', 'did', 'displayName', 'encryptionPublicJwk', 'updatedAt'],
    properties: {
      schema: { const: 'chirpy.public-profile/1.0.0' },
      did: { type: 'string', minLength: 8 },
      displayName: { type: 'string', minLength: 1, maxLength: 80 },
      nodeName: { type: 'string', minLength: 3, maxLength: 40 },
      ipnsKey: { type: 'string' },
      encryptionPublicJwk: {
        type: 'object',
        required: ['kty'],
        properties: {
          kty: { type: 'string' },
          n: { type: 'string' },
          e: { type: 'string' },
          alg: { type: 'string' },
          kid: { type: 'string' }
        },
        additionalProperties: true
      },
      capabilities: {
        type: 'object',
        properties: {
          canPublish: { type: 'boolean' },
          canModerateFamily: { type: 'boolean' }
        },
        additionalProperties: false
      },
      updatedAt: { type: 'string', format: 'date-time' }
    },
    additionalProperties: false
  },
  'chirpy.presence.v1': {
    type: 'object',
    required: ['schema', 'id', 'name', 'timestamp'],
    properties: {
      schema: { const: 'chirpy.presence/1.0.0' },
      id: { type: 'string', minLength: 8 },
      peerId: { type: 'string' },
      name: { type: 'string', minLength: 3, maxLength: 40 },
      profileDid: { type: 'string' },
      profileIpnsKey: { type: 'string' },
      version: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' }
    },
    additionalProperties: false
  },
  'chirpy.link-card.v1': {
    type: 'object',
    required: ['schema', 'url', 'title', 'interactive'],
    properties: {
      schema: { const: 'chirpy.link-card/1.0.0' },
      url: { type: 'string', minLength: 8 },
      title: { type: 'string', minLength: 1, maxLength: 300 },
      description: { type: 'string' },
      image: { type: 'string' },
      siteName: { type: 'string' },
      publisher: { type: 'string' },
      type: { type: 'string', enum: ['website', 'article', 'video'] },
      interactive: {
        type: 'object',
        required: ['provider', 'playable'],
        properties: {
          provider: { type: 'string' },
          embedUrl: { type: 'string' },
          playable: { type: 'boolean' }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  },
  'chirpy.encrypted-post-manifest.v1': {
    type: 'object',
    required: ['schema', 'post', 'assets', 'encryption'],
    properties: {
      schema: { const: 'chirpy.sovereign-post/1.0.0' },
      post: {
        type: 'object',
        required: ['id', 'createdAt', 'userDid', 'visibility'],
        properties: {
          id: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          userDid: { type: 'string' },
          authorRole: { type: 'string', enum: ['adult', 'child'] },
          visibility: { type: 'string', enum: ['public', 'family'] },
          text: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: true
      },
      assets: {
        type: 'object',
        required: ['photos', 'videos', 'links'],
        properties: {
          photos: { type: 'array', items: { type: 'object', additionalProperties: true } },
          videos: { type: 'array', items: { type: 'object', additionalProperties: true } },
          links: { type: 'array', items: { type: 'object', additionalProperties: true } }
        },
        additionalProperties: false
      },
      encryption: {
        type: 'object',
        required: ['enabled', 'algorithm', 'recipients', 'files'],
        properties: {
          enabled: { type: 'boolean' },
          algorithm: { type: 'string', enum: ['AES-GCM+RSA-OAEP-256'] },
          recipients: {
            type: 'array',
            items: {
              type: 'object',
              required: ['did', 'wrappedDek'],
              properties: {
                did: { type: 'string' },
                wrappedDek: { type: 'string' }
              },
              additionalProperties: false
            }
          },
          files: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              required: ['encPath', 'iv', 'tag', 'aad'],
              properties: {
                encPath: { type: 'string' },
                mime: { type: 'string' },
                iv: { type: 'string' },
                tag: { type: 'string' },
                aad: { type: 'string' }
              },
              additionalProperties: false
            }
          }
        },
        additionalProperties: false
      }
    },
    additionalProperties: true
  }
};

app.use(express.json({ limit: '2mb' }));

bootstrap().catch((error) => {
  console.error(`[boot] ${error.message}`);
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(projectRoot, 'public', 'index.html'));
});

app.get('/versions', (_req, res) => {
  res.sendFile(path.join(projectRoot, 'versions.html'));
});

app.use('/v1', express.static(path.join(projectRoot, 'public-v1')));
app.use('/v2', express.static(path.join(projectRoot, 'public-v2')));
app.use('/v3', express.static(path.join(projectRoot, 'public-v3')));
app.use('/v4', express.static(path.join(projectRoot, 'public-v4')));
app.use('/v5', express.static(path.join(projectRoot, 'public-v5')));
app.use('/staged', express.static(stageRoot));
app.use(express.static(path.join(projectRoot, 'public')));

app.get('/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'chirpy-publisher',
    ipfsReady: presenceState.ipfsReady,
    nodeName: presenceState.nodeName,
    now: new Date().toISOString()
  });
});

app.get('/api/setup', async (_req, res) => {
  const keys = await listIpfsKeysSafe();
  res.json({
    ok: true,
    ipfs: {
      available: keys.available,
      keys: keys.keys
    },
    identity: {
      nodeName: presenceState.nodeName,
      instanceId: presenceState.instanceId,
      peerId: presenceState.peerId || ''
    }
  });
});

app.get('/api/ipfs/keys', async (_req, res) => {
  const data = await listIpfsKeysSafe();
  if (!data.available) {
    res.json({ ok: true, available: false, keys: [] });
    return;
  }
  res.json({ ok: true, available: true, keys: data.keys });
});

app.post('/api/ipfs/keys', async (req, res) => {
  const rawName = String(req.body?.name || '').trim();
  const safeName = sanitizeIpnsKeyName(rawName);
  if (!safeName) {
    res.status(400).json({ ok: false, error: 'invalid key name' });
    return;
  }

  if (!presenceState.ipfsReady) {
    res.status(503).json({ ok: false, error: 'ipfs unavailable' });
    return;
  }

  try {
    await runExec(IPFS_CMD, ['key', 'gen', safeName, '--type=rsa', '--size=2048'], 15000);
    const listed = await listIpfsKeysSafe();
    res.json({ ok: true, generatedName: safeName, keys: listed.keys || [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'failed to create ipfs key' });
  }
});

app.post('/api/identity/create', async (_req, res) => {
  try {
    const keys = await generateEncryptionJwkPair();
    const did = generateDid();
    res.json({
      ok: true,
      identity: {
        did,
        encryptionPublicJwk: keys.publicJwk,
        encryptionPrivateJwk: keys.privateJwk
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'identity generation failed' });
  }
});

app.post('/api/identity/encryption-keys', async (_req, res) => {
  try {
    const keys = await generateEncryptionJwkPair();
    res.json({ ok: true, keys: { encryptionPublicJwk: keys.publicJwk, encryptionPrivateJwk: keys.privateJwk } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'encryption key generation failed' });
  }
});

app.get('/api/link-preview', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  if (!isLikelyUrl(raw)) {
    res.status(400).json({ ok: false, error: 'invalid url' });
    return;
  }
  try {
    const card = await buildLinkCard(raw);
    const valid = validateProtocolPayload('chirpy.link-card.v1', card);
    if (!valid.valid) {
      res.status(500).json({ ok: false, error: `link card validation failed: ${valid.errors.join('; ')}` });
      return;
    }
    res.json({ ok: true, preview: card });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'link preview failed' });
  }
});

app.post('/stage', upload.array('media', 50), async (req, res) => {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  const cleanup = async () => {
    await Promise.all(uploadedFiles.map((file) => fs.unlink(file.path).catch(() => null)));
  };

  try {
    const stageId = crypto.randomUUID();
    const stageDir = path.join(stageRoot, stageId);
    const photosDir = path.join(stageDir, 'photos');
    const videosDir = path.join(stageDir, 'videos');
    const linksDir = path.join(stageDir, 'links');

    await fs.mkdir(photosDir, { recursive: true });
    await fs.mkdir(videosDir, { recursive: true });
    await fs.mkdir(linksDir, { recursive: true });

    const mediaOptions = parseJsonField(req.body.mediaOptions, {});
    const postStyle = parseJsonField(req.body.postStyle, {});
    const blocks = normalizeBlocks(parseJsonField(req.body.blocks, []));

    const tags = parseTags(req.body.tags);
    const autoTagEnabled = String(req.body.autoTag || 'true') !== 'false';
    const visibility = req.body.visibility === 'family' ? 'family' : 'public';
    const authorRole = req.body.authorRole === 'child' ? 'child' : 'adult';
    const userDid = String(req.body.userDid || 'did:chirpy:anonymous').trim() || 'did:chirpy:anonymous';
    const ipnsKey = String(req.body.ipnsKey || 'self').trim() || 'self';
    const text = String(req.body.text || '').trim();

    const fileOverrides = buildFileFrameOverrideMap(blocks);
    const photos = [];
    const videos = [];

    for (let i = 0; i < uploadedFiles.length; i += 1) {
      const file = uploadedFiles[i];
      if (!file?.path) continue;
      if (String(file.mimetype || '').startsWith('image/')) {
        const photo = await processImageFile({
          inputPath: file.path,
          outputDir: photosDir,
          fileIndex: i,
          originalName: file.originalname,
          mediaOptions,
          frameOverrides: fileOverrides.get(i) || null
        });
        photos.push(photo);
        continue;
      }
      if (String(file.mimetype || '').startsWith('video/')) {
        const video = await processVideoFile({
          inputPath: file.path,
          outputDir: videosDir,
          fileIndex: i,
          originalName: file.originalname,
          mediaOptions
        });
        videos.push(video);
      }
    }

    const urls = collectUrls(blocks, req.body.url);
    const links = [];
    for (const url of urls) {
      const card = await buildLinkCard(url);
      const result = validateProtocolPayload('chirpy.link-card.v1', card);
      if (!result.valid) continue;
      links.push(card);
    }

    const semanticTags = await buildSemanticTags({
      autoTagEnabled,
      existingTags: tags,
      text,
      blocks,
      links
    });
    const finalTags = normalizeTagList([...tags, ...semanticTags]).slice(0, 12);

    const createdAt = new Date().toISOString();
    const postJson = {
      text,
      tags: finalTags,
      semanticTags,
      links,
      blocks,
      visibility,
      authorRole,
      userDid,
      mediaOptions,
      postStyle,
      createdAt
    };

    const manifest = {
      schema: 'chirpy.sovereign-post/1.0.0',
      post: {
        id: stageId,
        createdAt,
        userDid,
        authorRole,
        visibility,
        text,
        tags: finalTags,
        semanticTags,
        blocks,
        mediaOptions,
        postStyle
      },
      assets: {
        photos,
        videos,
        links
      },
      bundle: {
        rootCid: null,
        ipnsKey,
        ipnsPublishResult: null
      },
      pubsub: {
        topic: publishTopic,
        published: false
      }
    };

    await writeJsonFile(path.join(stageDir, 'post.json'), postJson);
    await writeJsonFile(path.join(stageDir, 'manifest.json'), manifest);

    const publishRequested = String(req.body.publish || 'true') !== 'false';
    if (publishRequested) {
      const publishResult = await maybePublishStage(stageDir, stageId, userDid, ipnsKey);
      if (!publishResult.ok && String(process.env.REQUIRE_IPFS || 'false') === 'true') {
        throw new Error(`ipfs publish required but failed: ${publishResult.error}`);
      }
      manifest.bundle.rootCid = publishResult.rootCid || null;
      manifest.bundle.ipnsPublishResult = publishResult.ipnsPublishResult || null;
      manifest.pubsub.published = Boolean(publishResult.pubsubPublished);
      await writeJsonFile(path.join(stageDir, 'manifest.json'), manifest);
    }

    await cleanup();

    res.json({
      ok: true,
      stageId,
      manifest,
      paths: {
        manifest: `/staged/${stageId}/manifest.json`,
        post: `/staged/${stageId}/post.json`
      }
    });
  } catch (error) {
    await cleanup();
    res.status(500).json({ ok: false, error: error.message || 'stage failed' });
  }
});

app.get('/api/stages', async (_req, res) => {
  try {
    const entries = await fs.readdir(stageRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const stages = [];
    for (const stageId of directories) {
      const summary = await loadStageSummary(stageId);
      if (summary) stages.push(summary);
    }
    stages.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ ok: true, stages });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'failed to load stages' });
  }
});

app.get('/api/stages/:stageId', async (req, res) => {
  const stageId = safeStageId(req.params.stageId);
  if (!stageId) {
    res.status(400).json({ ok: false, error: 'invalid stage id' });
    return;
  }
  try {
    const manifest = await readJsonFile(path.join(stageRoot, stageId, 'manifest.json'));
    const post = await readJsonFile(path.join(stageRoot, stageId, 'post.json'));
    if (!manifest && !post) {
      res.status(404).json({ ok: false, error: 'stage not found' });
      return;
    }
    res.json({ ok: true, stageId, manifest: manifest || {}, post: post || {} });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'failed to load stage' });
  }
});

app.get('/api/chirpspace', async (req, res) => {
  try {
    const entries = await fs.readdir(stageRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const viewerDid = String(req.query.viewerDid || '').trim();
    const viewerRole = String(req.query.viewerRole || 'adult').trim() === 'child' ? 'child' : 'adult';
    const authorDid = String(req.query.authorDid || '').trim();
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || '100'), 10) || 100, 1), 500);

    const posts = [];
    for (const stageId of directories) {
      const record = await loadChirpSpacePost(stageId);
      if (!record) continue;
      if (authorDid && record.userDid && record.userDid !== authorDid) continue;
      if (!canViewerSeePost(record, viewerDid, viewerRole)) continue;
      posts.push(record);
    }

    posts.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.json({ ok: true, posts: posts.slice(0, limit) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'failed to load chirpspace' });
  }
});

app.post('/api/chirpspace/:stageId/make-public', async (req, res) => {
  const stageId = safeStageId(req.params.stageId);
  if (!stageId) {
    res.status(400).json({ ok: false, error: 'invalid stage id' });
    return;
  }

  const moderatorRole = String(req.body?.moderatorRole || 'child').trim();
  if (moderatorRole === 'child') {
    res.status(403).json({ ok: false, error: 'child profiles cannot promote posts' });
    return;
  }

  try {
    const postPath = path.join(stageRoot, stageId, 'post.json');
    const manifestPath = path.join(stageRoot, stageId, 'manifest.json');
    const post = await readJsonFile(postPath);
    const manifest = await readJsonFile(manifestPath);
    if (!post && !manifest) {
      res.status(404).json({ ok: false, error: 'stage not found' });
      return;
    }

    const nextPost = post || {};
    nextPost.visibility = 'public';
    if (nextPost.access) delete nextPost.access;
    nextPost.promotedAt = new Date().toISOString();

    const nextManifest = manifest || {};
    nextManifest.post = nextManifest.post || {};
    nextManifest.post.visibility = 'public';
    if (nextManifest.access) delete nextManifest.access;

    await writeJsonFile(postPath, nextPost);
    await writeJsonFile(manifestPath, nextManifest);
    res.json({ ok: true, stageId, visibility: 'public' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'failed to promote post' });
  }
});

app.get('/api/network-node', (_req, res) => {
  res.json({
    ok: true,
    nodeName: presenceState.nodeName,
    instanceId: presenceState.instanceId,
    peerId: presenceState.peerId || '',
    profileDid: presenceState.profileDid,
    profileIpnsKey: presenceState.profileIpnsKey
  });
});

app.get('/api/network-node/check-name', (req, res) => {
  const candidate = normalizeNodeName(req.query.name);
  if (!candidate) {
    res.status(400).json({
      ok: false,
      available: false,
      error: 'invalid name',
      reason: 'Use 3-40 chars: letters, numbers, spaces, . _ -'
    });
    return;
  }
  res.json({ ok: true, available: true, name: candidate, reason: '' });
});

app.post('/api/network-node', async (req, res) => {
  const candidate = normalizeNodeName(req.body?.name);
  if (!candidate) {
    res.status(400).json({ ok: false, error: 'invalid name', reason: 'Use 3-40 chars: letters, numbers, spaces, . _ -' });
    return;
  }

  presenceState.nodeName = candidate;
  await persistInstanceInfo();
  recordUser({
    id: presenceState.instanceId,
    peerId: presenceState.peerId,
    name: presenceState.nodeName,
    profileDid: presenceState.profileDid,
    profileIpnsKey: presenceState.profileIpnsKey,
    source: 'self',
    timestamp: new Date().toISOString()
  });

  if (presenceState.ipfsReady) publishHeartbeat().catch(() => null);
  res.json({ ok: true, nodeName: presenceState.nodeName });
});

app.post('/api/network-node/profile', async (req, res) => {
  const did = String(req.body?.did || '').trim();
  const ipnsKey = String(req.body?.ipnsKey || '').trim();
  presenceState.profileDid = did;
  presenceState.profileIpnsKey = ipnsKey;

  recordUser({
    id: presenceState.instanceId,
    peerId: presenceState.peerId,
    name: presenceState.nodeName,
    profileDid: presenceState.profileDid,
    profileIpnsKey: presenceState.profileIpnsKey,
    source: 'self',
    timestamp: new Date().toISOString()
  });

  if (presenceState.ipfsReady) publishHeartbeat().catch(() => null);
  res.json({ ok: true, profileDid: presenceState.profileDid, profileIpnsKey: presenceState.profileIpnsKey });
});

app.get('/api/users', (_req, res) => {
  res.json({ ok: true, topic: presenceTopic, users: getOrderedUsers() });
});

app.get('/api/protocol/schemas', (_req, res) => {
  const summary = Object.entries(protocolSchemas).map(([id, schema]) => ({
    id,
    constSchema: schema.properties?.schema?.const || '',
    required: schema.required || []
  }));
  res.json({ ok: true, version: '1.0.0', schemas: summary });
});

app.post('/api/protocol/validate', (req, res) => {
  const schemaId = String(req.body?.schemaId || '').trim();
  const payload = req.body?.payload;
  const result = validateProtocolPayload(schemaId, payload);
  res.status(result.valid ? 200 : 400).json({ ok: result.valid, schemaId, valid: result.valid, errors: result.errors });
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`Chirpy Publisher server running at http://${BIND_HOST}:${PORT}`);
  console.log(`Publisher: http://${BIND_HOST}:${PORT}/`);
  console.log(`My ChirpSpace: http://${BIND_HOST}:${PORT}/chirpspace.html`);
  console.log(`Version Picker: http://${BIND_HOST}:${PORT}/versions`);
  console.log(`V1 (Focused Writer): http://${BIND_HOST}:${PORT}/v1`);
  console.log(`V2 (Split Studio): http://${BIND_HOST}:${PORT}/v2`);
  console.log(`V3 (Stacked Sections): http://${BIND_HOST}:${PORT}/v3`);
  console.log(`V4 (Dashboard Cards): http://${BIND_HOST}:${PORT}/v4`);
  console.log(`V5 (Sidebar Editor): http://${BIND_HOST}:${PORT}/v5`);
});

async function bootstrap() {
  await fs.mkdir(stageRoot, { recursive: true });
  await fs.mkdir(runtimeRoot, { recursive: true });
  await fs.mkdir(uploadRoot, { recursive: true });
  await bootstrapPresence();
}

async function bootstrapPresence() {
  await hydrateUsers();
  const info = await ensureInstanceInfo();
  presenceState.instanceId = info.instanceId;
  presenceState.nodeName = process.env.CHIRPY_NODE_NAME || info.nodeName || defaultNodeName(info.instanceId);
  await persistInstanceInfo();

  presenceState.peerId = await loadPeerId();
  presenceState.ipfsReady = Boolean(presenceState.peerId);

  recordUser({
    id: presenceState.instanceId,
    peerId: presenceState.peerId,
    name: presenceState.nodeName,
    profileDid: presenceState.profileDid,
    profileIpnsKey: presenceState.profileIpnsKey,
    source: 'self',
    timestamp: new Date().toISOString()
  });

  if (!presenceState.ipfsReady) {
    console.warn('[presence] ipfs not available; user list will only include local node');
    return;
  }

  startPresenceSubscriber();
  publishHeartbeat().catch(() => null);
  presenceState.heartbeatTimer = setInterval(() => {
    publishHeartbeat().catch(() => null);
  }, Math.max(5000, presenceHeartbeatMs));
}

async function maybePublishStage(stageDir, stageId, userDid, ipnsKey) {
  if (!presenceState.ipfsReady) {
    return { ok: false, error: 'ipfs unavailable', rootCid: null, ipnsPublishResult: null, pubsubPublished: false };
  }

  try {
    const rootCid = (await runExec(IPFS_CMD, ['add', '-Qr', stageDir], 45000)).trim();
    const ipnsPublishResult = (await runExec(IPFS_CMD, ['name', 'publish', '--key', ipnsKey, `/ipfs/${rootCid}`], 45000)).trim();
    const pubPayload = JSON.stringify({
      schema: 'chirpy.publish/1.0.0',
      stageId,
      userDid,
      ipnsKey,
      rootCid,
      timestamp: new Date().toISOString()
    });

    let pubsubPublished = false;
    try {
      await runExec(IPFS_CMD, ['pubsub', 'pub', publishTopic, pubPayload], 10000);
      pubsubPublished = true;
    } catch (_error) {
      pubsubPublished = false;
    }

    return { ok: true, rootCid, ipnsPublishResult, pubsubPublished };
  } catch (error) {
    return { ok: false, error: error.message || 'ipfs publish failed', rootCid: null, ipnsPublishResult: null, pubsubPublished: false };
  }
}

async function listIpfsKeysSafe() {
  if (!presenceState.ipfsReady) {
    return { available: false, keys: [] };
  }
  try {
    const output = await runExec(IPFS_CMD, ['key', 'list', '-l'], 12000);
    const keys = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        if (parts.length < 2) return null;
        return { id: parts[0], name: parts.slice(1).join(' ') };
      })
      .filter(Boolean);
    return { available: true, keys };
  } catch (_error) {
    return { available: false, keys: [] };
  }
}

async function loadPeerId() {
  try {
    const id = (await runExec(IPFS_CMD, ['id', '-f=<id>'], 4000)).trim();
    return id || null;
  } catch (_error) {
    return null;
  }
}

function startPresenceSubscriber() {
  if (presenceState.subscriber) return;
  const child = spawn(IPFS_CMD, ['pubsub', 'sub', presenceTopic], { stdio: ['ignore', 'pipe', 'pipe'] });
  presenceState.subscriber = child;

  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const payload = safeJsonParse(line);
    const validation = validateProtocolPayload('chirpy.presence.v1', payload);
    if (!validation.valid) return;
    recordUser({
      id: String(payload.id),
      peerId: payload.peerId ? String(payload.peerId) : '',
      name: payload.name ? String(payload.name) : '',
      profileDid: payload.profileDid ? String(payload.profileDid) : '',
      profileIpnsKey: payload.profileIpnsKey ? String(payload.profileIpnsKey) : '',
      source: 'pubsub',
      timestamp: payload.timestamp
    });
  });

  child.stderr.on('data', () => null);
  child.on('exit', () => {
    presenceState.subscriber = null;
    if (presenceState.ipfsReady) setTimeout(startPresenceSubscriber, 5000);
  });
}

async function publishHeartbeat() {
  const payload = JSON.stringify({
    schema: 'chirpy.presence/1.0.0',
    id: presenceState.instanceId,
    peerId: presenceState.peerId || '',
    name: presenceState.nodeName,
    profileDid: presenceState.profileDid || '',
    profileIpnsKey: presenceState.profileIpnsKey || '',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });

  await runExec(IPFS_CMD, ['pubsub', 'pub', presenceTopic, payload], 10000);

  recordUser({
    id: presenceState.instanceId,
    peerId: presenceState.peerId,
    name: presenceState.nodeName,
    profileDid: presenceState.profileDid,
    profileIpnsKey: presenceState.profileIpnsKey,
    source: 'self',
    timestamp: new Date().toISOString()
  });
}

function recordUser({ id, peerId, name, profileDid, profileIpnsKey, source, timestamp }) {
  const safeId = String(id || '').trim();
  if (!safeId) return;

  const nowIso = toIsoTimestamp(timestamp);
  const existing = presenceState.usersById.get(safeId) || {};
  const next = {
    id: safeId,
    peerId: String(peerId || existing.peerId || '').trim(),
    name: String(name || existing.name || '').trim(),
    profileDid: String(profileDid || existing.profileDid || '').trim(),
    profileIpnsKey: String(profileIpnsKey || existing.profileIpnsKey || '').trim(),
    source: String(source || existing.source || 'pubsub'),
    lastActivity: nowIso
  };
  presenceState.usersById.set(safeId, next);
  scheduleUsersSave();
}

function scheduleUsersSave() {
  if (presenceState.saveTimer) clearTimeout(presenceState.saveTimer);
  presenceState.saveTimer = setTimeout(() => {
    const users = getOrderedUsers();
    writeJsonFile(usersFile, { users, updatedAt: new Date().toISOString() }).catch(() => null);
  }, 250);
}

function getOrderedUsers() {
  const now = Date.now();
  return Array.from(presenceState.usersById.values())
    .map((user) => {
      const lastTs = Date.parse(user.lastActivity || '');
      const isActive = Number.isFinite(lastTs) ? now - lastTs <= presenceStaleMs : false;
      return {
        id: user.id,
        peerId: user.peerId || '',
        name: user.name || '',
        profileDid: user.profileDid || '',
        profileIpnsKey: user.profileIpnsKey || '',
        source: user.source || 'pubsub',
        lastActivity: user.lastActivity || null,
        active: isActive
      };
    })
    .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
}

async function hydrateUsers() {
  const saved = await readJsonFile(usersFile);
  const users = Array.isArray(saved?.users) ? saved.users : [];
  for (const user of users) {
    if (!user?.id) continue;
    presenceState.usersById.set(String(user.id), {
      id: String(user.id),
      peerId: String(user.peerId || ''),
      name: String(user.name || ''),
      profileDid: String(user.profileDid || ''),
      profileIpnsKey: String(user.profileIpnsKey || ''),
      source: String(user.source || 'pubsub'),
      lastActivity: String(user.lastActivity || '')
    });
  }
}

async function ensureInstanceInfo() {
  const existing = await readJsonFile(instanceFile);
  if (existing?.instanceId) {
    return {
      instanceId: String(existing.instanceId),
      nodeName: typeof existing.nodeName === 'string' ? existing.nodeName : defaultNodeName(existing.instanceId)
    };
  }

  const created = {
    instanceId: crypto.randomUUID(),
    nodeName: defaultNodeName(),
    createdAt: new Date().toISOString()
  };
  await writeJsonFile(instanceFile, created);
  return { instanceId: created.instanceId, nodeName: created.nodeName };
}

async function persistInstanceInfo() {
  if (!presenceState.instanceId) return;
  const existing = await readJsonFile(instanceFile);
  const next = {
    instanceId: presenceState.instanceId,
    nodeName: presenceState.nodeName || defaultNodeName(presenceState.instanceId),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await writeJsonFile(instanceFile, next);
}

async function processImageFile({ inputPath, outputDir, fileIndex, originalName, mediaOptions, frameOverrides }) {
  const id = `${fileIndex}-${safeBaseName(originalName)}`;
  const framedFile = `${id}.framed.webp`;
  const thumbFile = `${id}.thumb.webp`;
  const sourceExt = path.extname(originalName || '').toLowerCase() || '.bin';
  const sourceFile = `${id}.source${sourceExt}`;

  const sourceOut = path.join(outputDir, sourceFile);
  const framedOut = path.join(outputDir, framedFile);
  const thumbOut = path.join(outputDir, thumbFile);

  await fs.copyFile(inputPath, sourceOut);

  const baseImage = sharp(inputPath, { failOn: 'none' }).rotate();
  const metadata = await baseImage.metadata();

  const quality = clampNumber(mediaOptions.imageQuality, 86, 40, 100);
  const borderSize = clampNumber(frameOverrides?.imageBorder ?? mediaOptions.imageBorder, 3, 0, 120);
  const paddingSize = clampNumber(mediaOptions.imagePadding, 24, 0, 400);
  const frameBg = isHexColor(frameOverrides?.imageBg) ? frameOverrides.imageBg : isHexColor(mediaOptions.imageBg) ? mediaOptions.imageBg : '#faf7f2';
  const borderColor = isHexColor(mediaOptions.imageBorderColor) ? mediaOptions.imageBorderColor : '#1d1d1d';
  const frameEnabled = mediaOptions.frameEnabled !== false;

  if (frameEnabled) {
    const first = await baseImage
      .extend({
        top: paddingSize,
        bottom: paddingSize,
        left: paddingSize,
        right: paddingSize,
        background: frameBg
      })
      .extend({
        top: borderSize,
        bottom: borderSize,
        left: borderSize,
        right: borderSize,
        background: borderColor
      })
      .webp({ quality })
      .toFile(framedOut);

    await sharp(framedOut)
      .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: clampNumber(quality - 10, 76, 40, 95) })
      .toFile(thumbOut);

    return {
      source: `photos/${sourceFile}`,
      framed: `photos/${framedFile}`,
      thumb: `photos/${thumbFile}`,
      width: first.width || metadata.width || null,
      height: first.height || metadata.height || null,
      mime: 'image/webp'
    };
  }

  const out = await baseImage.webp({ quality }).toFile(framedOut);
  await sharp(framedOut)
    .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: clampNumber(quality - 10, 76, 40, 95) })
    .toFile(thumbOut);

  return {
    source: `photos/${sourceFile}`,
    framed: `photos/${framedFile}`,
    thumb: `photos/${thumbFile}`,
    width: out.width || metadata.width || null,
    height: out.height || metadata.height || null,
    mime: 'image/webp'
  };
}

async function processVideoFile({ inputPath, outputDir, fileIndex, originalName, mediaOptions }) {
  const id = `${fileIndex}-${safeBaseName(originalName)}`;
  const videoDir = path.join(outputDir, id);
  await fs.mkdir(videoDir, { recursive: true });

  const sourceExt = path.extname(originalName || '').toLowerCase() || '.mp4';
  const sourceFile = `source${sourceExt}`;
  const sourceOut = path.join(videoDir, sourceFile);
  await fs.copyFile(inputPath, sourceOut);

  const hlsFile = 'stream.m3u8';
  const hlsOut = path.join(videoDir, hlsFile);
  const previewGif = 'preview.gif';
  const previewOut = path.join(videoDir, previewGif);

  const hasFfmpeg = await commandAvailable('ffmpeg');
  if (hasFfmpeg) {
    const startSec = clampNumber(mediaOptions.previewStartSec, 0, 0, 3600);
    const durationSec = clampNumber(mediaOptions.previewDurationSec, 5, 1, 30);
    const segmentSec = clampNumber(mediaOptions.hlsSegmentSec, 4, 2, 12);

    await runExec('ffmpeg', [
      '-y',
      '-i', sourceOut,
      '-codec:v', 'libx264',
      '-codec:a', 'aac',
      '-hls_time', String(segmentSec),
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(videoDir, 'segment_%03d.ts'),
      hlsOut
    ], 120000);

    await runExec('ffmpeg', [
      '-y',
      '-ss', String(startSec),
      '-t', String(durationSec),
      '-i', sourceOut,
      '-vf', 'fps=12,scale=640:-1:flags=lanczos',
      previewOut
    ], 120000);
  }

  const hlsExists = await fileExists(hlsOut);
  const gifExists = await fileExists(previewOut);

  return {
    source: `videos/${id}/${sourceFile}`,
    hls: hlsExists ? `videos/${id}/${hlsFile}` : null,
    previewGif: gifExists ? `videos/${id}/${previewGif}` : null,
    mime: guessMimeFromExt(sourceExt)
  };
}

function normalizeBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      type: String(item.type || '').trim(),
      content: String(item.content || ''),
      html: String(item.html || ''),
      url: String(item.url || '').trim(),
      mediaIndex: Number.isFinite(item.mediaIndex) ? item.mediaIndex : -1,
      frameOverrides: item.frameOverrides && typeof item.frameOverrides === 'object' ? {
        imageBorder: Number.isFinite(item.frameOverrides.imageBorder) ? item.frameOverrides.imageBorder : undefined,
        imageBg: typeof item.frameOverrides.imageBg === 'string' ? item.frameOverrides.imageBg : undefined
      } : null
    }));
}

function buildFileFrameOverrideMap(blocks) {
  const out = new Map();
  for (const block of blocks) {
    if (!Number.isFinite(block.mediaIndex) || block.mediaIndex < 0) continue;
    if (!block.frameOverrides) continue;
    const current = out.get(block.mediaIndex) || {};
    const next = {
      imageBorder: Number.isFinite(block.frameOverrides.imageBorder) ? block.frameOverrides.imageBorder : current.imageBorder,
      imageBg: block.frameOverrides.imageBg || current.imageBg
    };
    out.set(block.mediaIndex, next);
  }
  return out;
}

function collectUrls(blocks, fieldUrl) {
  const fromBlocks = blocks
    .filter((block) => block.type === 'link' && isLikelyUrl(block.url))
    .map((block) => block.url);
  const fromField = String(fieldUrl || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => isLikelyUrl(x));
  return Array.from(new Set([...fromBlocks, ...fromField]));
}

async function buildLinkCard(rawUrl) {
  const url = normalizeUrl(rawUrl);
  let html = '';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    html = await response.text();
  } catch (_error) {
    html = '';
  }

  const title =
    extractMetaContent(html, 'property', 'og:title') ||
    extractMetaContent(html, 'name', 'twitter:title') ||
    extractTitleTag(html) ||
    url;

  const description =
    extractMetaContent(html, 'property', 'og:description') ||
    extractMetaContent(html, 'name', 'description') ||
    '';

  const image =
    extractMetaContent(html, 'property', 'og:image') ||
    extractMetaContent(html, 'name', 'twitter:image') ||
    '';

  const siteName = extractMetaContent(html, 'property', 'og:site_name') || hostFromUrl(url);
  const interactive = inferInteractive(url);

  const card = {
    schema: 'chirpy.link-card/1.0.0',
    url,
    title: sanitizeText(title, 300) || url,
    description: sanitizeText(description, 800),
    image: image || '',
    siteName: sanitizeText(siteName, 120),
    publisher: sanitizeText(siteName, 120),
    type: interactive.playable ? 'video' : 'website',
    interactive
  };

  return card;
}

function inferInteractive(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      const id = host.includes('youtu.be') ? parsed.pathname.replace('/', '') : parsed.searchParams.get('v') || '';
      const embedUrl = id ? `https://www.youtube.com/embed/${id}` : '';
      return { provider: 'youtube', embedUrl, playable: Boolean(embedUrl) };
    }
    if (host.includes('vimeo.com')) {
      const id = parsed.pathname.split('/').filter(Boolean)[0] || '';
      const embedUrl = id ? `https://player.vimeo.com/video/${id}` : '';
      return { provider: 'vimeo', embedUrl, playable: Boolean(embedUrl) };
    }
  } catch (_error) {
    // ignore
  }
  return { provider: 'web', embedUrl: '', playable: false };
}

async function loadStageSummary(stageId) {
  const manifest = await readJsonFile(path.join(stageRoot, stageId, 'manifest.json'));
  const post = await readJsonFile(path.join(stageRoot, stageId, 'post.json'));
  if (!manifest && !post) return null;

  const assets = manifest?.assets || post?.assets || {};
  const photos = Array.isArray(assets.photos) ? assets.photos : [];
  const videos = Array.isArray(assets.videos) ? assets.videos : [];
  const links = Array.isArray(assets.links) ? assets.links : [];

  return {
    stageId,
    createdAt: manifest?.post?.createdAt || post?.createdAt || null,
    text: post?.text || manifest?.post?.text || '',
    counts: {
      photos: photos.length,
      videos: videos.length,
      links: links.length
    }
  };
}

async function loadChirpSpacePost(stageId) {
  const manifest = await readJsonFile(path.join(stageRoot, stageId, 'manifest.json'));
  const post = await readJsonFile(path.join(stageRoot, stageId, 'post.json'));
  if (!manifest && !post) return null;

  const manifestPost = manifest?.post || {};
  const assets = manifest?.assets || post?.assets || { photos: [], videos: [], links: [] };
  const access = manifest?.access || post?.access || {};
  const allowedDids = Array.isArray(access.allowedDids)
    ? access.allowedDids.map((x) => String(x || '').trim()).filter(Boolean)
    : [];

  return {
    stageId,
    createdAt: manifestPost.createdAt || post?.createdAt || null,
    userDid: manifestPost.userDid || post?.userDid || '',
    authorRole: manifestPost.authorRole || post?.authorRole || 'adult',
    visibility: manifestPost.visibility || post?.visibility || 'public',
    text: post?.text || manifestPost.text || '',
    tags: post?.tags || manifestPost.tags || [],
    assets,
    access: {
      circleId: access.circleId || null,
      allowedDids
    },
    encryption: manifestPost.encryption || post?.encryption || null
  };
}

function canViewerSeePost(post, viewerDid, viewerRole) {
  if (post.visibility !== 'family') return true;
  const did = String(viewerDid || '').trim();
  if (!did) return false;
  if (viewerRole !== 'child') return true;
  if (post.userDid && post.userDid === did) return true;
  const allowedDids = Array.isArray(post.access?.allowedDids) ? post.access.allowedDids : [];
  return allowedDids.includes(did);
}

function parseJsonField(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(String(raw));
  } catch (_error) {
    return fallback;
  }
}

function parseTags(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 40);
}

async function buildSemanticTags({ autoTagEnabled, existingTags, text, blocks, links }) {
  const manual = normalizeTagList(existingTags);
  if (!autoTagEnabled) return manual;

  const corpus = buildTagCorpus(text, blocks, links);
  const semantic = await analyzePostSemantics(corpus);
  const namedPhrases = extractNamedPhraseTags(corpus).slice(0, 5);
  const bucketTags = semantic.buckets.length ? semantic.buckets : await inferBucketTags(corpus, namedPhrases);
  const subtopicTags = semantic.subtopics || [];
  const entityTags = semantic.entities || [];
  const ollamaTags = semantic.usedModel ? [] : await generateTagsWithOllama(corpus, manual);
  const fallbackTags = extractKeywordTags(corpus, [...manual, ...namedPhrases, ...bucketTags, ...subtopicTags, ...entityTags]);
  const merged = normalizeTagList([
    ...manual,
    ...namedPhrases,
    ...entityTags,
    ...bucketTags,
    ...subtopicTags,
    ...ollamaTags,
    ...fallbackTags
  ]).slice(0, 14);
  const compact = dropSubsumedTags(merged);
  return filterNamedPhraseFragments(compact, namedPhrases).slice(0, 10);
}

async function analyzePostSemantics(corpus) {
  const allowedBuckets = [
    'sports',
    'entertainment',
    'technology',
    'business',
    'finance',
    'politics',
    'science',
    'health',
    'education',
    'gaming',
    'food',
    'travel',
    'lifestyle',
    'family',
    'news',
    'music',
    'movies',
    'tv',
    'general'
  ];
  const text = String(corpus || '').trim();
  if (!text || text.length < 6) {
    return { usedModel: false, buckets: ['general'], subtopics: [], entities: [] };
  }

  const host = String(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim();
  const model = String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim();
  const prompt = [
    'Analyze this social post semantically.',
    'Return strict JSON only with keys: buckets, subtopics, entities.',
    `buckets: array with 1-3 items from this fixed list: ${allowedBuckets.join(', ')}`,
    'subtopics: array of 0-5 concise inferred topics (1-4 words each), can use world knowledge and context.',
    'entities: array of 0-5 notable names/titles/teams/products in the post.',
    'No markdown. No explanation. JSON object only.',
    'Post:',
    text.slice(0, 2800)
  ].join('\n');

  try {
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.1 }
      })
    });
    if (!response.ok) {
      return { usedModel: false, buckets: [], subtopics: [], entities: [] };
    }
    const data = await response.json();
    const raw = String(data?.response || '').trim();
    const parsed = parseLooseJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { usedModel: false, buckets: [], subtopics: [], entities: [] };
    }

    const allowed = new Set(allowedBuckets);
    const buckets = normalizeTagList(Array.isArray(parsed.buckets) ? parsed.buckets : [])
      .filter((x) => allowed.has(x))
      .slice(0, 3);
    const subtopics = normalizeTagList(Array.isArray(parsed.subtopics) ? parsed.subtopics : []).slice(0, 5);
    const entities = normalizeTagList(Array.isArray(parsed.entities) ? parsed.entities : []).slice(0, 5);
    return { usedModel: true, buckets, subtopics, entities };
  } catch (_error) {
    return { usedModel: false, buckets: [], subtopics: [], entities: [] };
  }
}

function parseLooseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    // continue
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch (_error) {
    return null;
  }
}

function buildTagCorpus(text, blocks, links) {
  const parts = [String(text || '')];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    parts.push(String(block?.content || ''));
    parts.push(String(block?.url || ''));
  }
  for (const link of Array.isArray(links) ? links : []) {
    parts.push(String(link?.title || ''));
    parts.push(String(link?.description || ''));
    parts.push(String(link?.siteName || ''));
  }
  return parts.join('\n').trim();
}

async function generateTagsWithOllama(corpus, existingTags) {
  if (!corpus || corpus.length < 8) return [];
  const host = String(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim();
  const model = String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim();
  const prompt = [
    'Generate up to 8 concise content tags as comma-separated words/phrases.',
    'Use lowercase. No hashtags. No numbering. No explanation.',
    'Avoid filler or mood words like: almost, here, fired up, excited, awesome, great, cool.',
    'Include one or two broad bucket tags when clear (examples: sports, entertainment, technology, business, lifestyle).',
    `Existing tags: ${existingTags.join(', ') || '(none)'}`,
    'Content:',
    corpus.slice(0, 3000)
  ].join('\n');

  try {
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.2 }
      })
    });
    if (!response.ok) return [];
    const data = await response.json();
    const raw = String(data?.response || '').trim();
    return normalizeTagList(raw.split(',').map((x) => x.trim())).slice(0, 8);
  } catch (_error) {
    return [];
  }
}

function extractKeywordTags(corpus, existingTags) {
  const segments = String(corpus || '')
    .split(/\n+/)
    .map((line) =>
      String(line || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9\s-]/g, ' ')
        .trim()
    )
    .filter(Boolean);
  const stop = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'have', 'just', 'your', 'about', 'also', 'were',
    'been', 'will', 'would', 'there', 'their', 'they', 'them', 'then', 'than', 'what', 'when', 'where', 'while',
    'how', 'why', 'you', 'our', 'out', 'too', 'can', 'not', 'are', 'was', 'but', 'its', 'it', 'on', 'of', 'to',
    'in', 'a', 'an', 'or', 'at', 'by', 'as', 'is', 'im', 'ive', 'we', 'us', 'me', 'my', 'any', 'fans'
  ]);
  const weak = new Set([
    'almost', 'here', 'there', 'fired', 'up', 'down', 'good', 'great', 'nice', 'cool', 'awesome', 'amazing',
    'excited', 'today', 'tomorrow', 'yesterday', 'soon', 'really', 'very', 'much', 'more', 'less', 'thing', 'stuff',
    'post', 'season', 'question', 'take', 'takes', 'see', 'soon'
  ]);
  const weakBigramParts = new Set([
    'take', 'takes', 'see', 'watch', 'wanna', 'want', 'going', 'go', 'make', 'made', 'have', 'has', 'had', 'soon',
    'new', 'upcoming', 'any', 'anyone'
  ]);
  const boosted = new Set([
    'baseball', 'mlb', 'nfl', 'nba', 'nhl', 'soccer', 'football', 'basketball', 'hockey', 'playoffs', 'opening day',
    'ai', 'coding', 'music', 'gardening', '3d printing', 'ipfs', 'chirpy'
  ]);

  const unigramCounts = new Map();
  const bigramCounts = new Map();

  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!isUsableTagToken(token, stop, weak)) continue;
      unigramCounts.set(token, (unigramCounts.get(token) || 0) + 1);

      const next = tokens[i + 1];
      if (!isUsableTagToken(next, stop, weak)) continue;
      if (weakBigramParts.has(token) || weakBigramParts.has(next)) continue;
      const pair = `${token} ${next}`;
      bigramCounts.set(pair, (bigramCounts.get(pair) || 0) + 1);
    }
  }

  const existing = new Set(normalizeTagList(existingTags));
  const scored = [];
  for (const [term, count] of bigramCounts.entries()) {
    const score = count * 2 + (boosted.has(term) ? 2 : 0);
    if (score < 2) continue;
    scored.push([term, score]);
  }
  for (const [term, count] of unigramCounts.entries()) {
    const score = count + (boosted.has(term) ? 2 : 0);
    if (count < 2 && !boosted.has(term)) continue;
    scored.push([term, score]);
  }

  return scored
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term)
    .filter((term) => !existing.has(term))
    .slice(0, 6);
}

function normalizeTagList(values) {
  const raw = Array.isArray(values)
    ? values
    : String(values || '')
        .split(',')
        .map((x) => x.trim());
  const set = new Set();
  for (const value of raw) {
    const clean = String(value || '')
      .toLowerCase()
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    if (!clean || clean.length < 2) continue;
    if (isWeakTag(clean)) continue;
    set.add(clean);
  }
  return Array.from(set);
}

function extractNamedPhraseTags(corpus) {
  const text = String(corpus || '');
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const pattern = /\b([A-Z][a-z0-9]+(?:\s+(?:and|of|the|&)\s+[A-Z][a-z0-9]+|\s+[A-Z][a-z0-9]+){1,5})\b/g;
  let match;
  while ((match = pattern.exec(text))) {
    const phrase = String(match[1] || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!phrase || phrase.length < 5) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

async function inferBucketTags(corpus, namedPhrases) {
  const text = String(corpus || '').toLowerCase();
  const allowedBuckets = [
    'sports',
    'entertainment',
    'technology',
    'business',
    'finance',
    'politics',
    'science',
    'health',
    'education',
    'gaming',
    'food',
    'travel',
    'lifestyle',
    'family',
    'news',
    'music',
    'movies',
    'tv',
    'general'
  ];

  const fromModel = await inferBucketsWithOllama(text, allowedBuckets);
  if (fromModel.length) return fromModel.slice(0, 3);

  const keywordMap = {
    sports: ['baseball', 'mlb', 'nfl', 'nba', 'nhl', 'soccer', 'football', 'playoffs', 'opening day', 'team', 'season'],
    entertainment: ['show', 'series', 'episode', 'streaming', 'celebrity', 'fandom'],
    technology: ['software', 'app', 'code', 'coding', 'developer', 'ai', 'ipfs', 'electron', 'api', 'javascript', 'node'],
    business: ['startup', 'company', 'market', 'product', 'sales', 'strategy', 'customer'],
    finance: ['stocks', 'investing', 'crypto', 'budget', 'money', 'revenue', 'pricing'],
    politics: ['election', 'policy', 'government', 'senate', 'congress', 'president'],
    science: ['research', 'study', 'experiment', 'discovery', 'scientist'],
    health: ['health', 'wellness', 'fitness', 'nutrition', 'doctor', 'mental health'],
    education: ['learn', 'teaching', 'school', 'course', 'study', 'student'],
    gaming: ['game', 'gaming', 'xbox', 'playstation', 'nintendo', 'steam'],
    food: ['recipe', 'cooking', 'restaurant', 'meal', 'kitchen'],
    travel: ['travel', 'trip', 'flight', 'hotel', 'vacation', 'road trip'],
    lifestyle: ['daily', 'routine', 'home', 'hobby', 'life'],
    family: ['family', 'kids', 'parent', 'child'],
    news: ['breaking', 'update', 'headline', 'report'],
    music: ['song', 'album', 'playlist', 'artist', 'band'],
    movies: ['movie', 'film', 'cinema', 'box office', 'director'],
    tv: ['tv', 'series', 'episode', 'season', 'netflix', 'hulu', 'hbo']
  };

  const scored = [];
  for (const [bucket, hints] of Object.entries(keywordMap)) {
    const score = hints.reduce((acc, hint) => (text.includes(hint) ? acc + 1 : acc), 0);
    if (score > 0) scored.push([bucket, score]);
  }

  // If user mentions named media-like titles and no clear bucket, bias toward entertainment.
  if (!scored.length && Array.isArray(namedPhrases) && namedPhrases.length > 0 && /\bfans of\b/.test(text)) {
    return ['entertainment', 'tv'];
  }

  if (!scored.length) return ['general'];
  return scored.sort((a, b) => b[1] - a[1]).map(([bucket]) => bucket).slice(0, 3);
}

async function inferBucketsWithOllama(text, allowedBuckets) {
  if (!text || text.length < 6) return [];
  const host = String(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').trim();
  const model = String(process.env.OLLAMA_MODEL || 'llama3.2:3b').trim();
  const prompt = [
    'Classify this post into 1-3 buckets from this exact list only:',
    allowedBuckets.join(', '),
    'Return comma-separated bucket names only. No explanation.',
    'Post:',
    text.slice(0, 2200)
  ].join('\n');

  try {
    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.1 }
      })
    });
    if (!response.ok) return [];
    const data = await response.json();
    const raw = String(data?.response || '');
    const normalized = normalizeTagList(raw.split(',').map((x) => x.trim()));
    const allowed = new Set(allowedBuckets);
    return normalized.filter((x) => allowed.has(x)).slice(0, 3);
  } catch (_error) {
    return [];
  }
}

function dropSubsumedTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const sorted = [...list].sort((a, b) => b.length - a.length);
  const kept = [];

  for (const tag of sorted) {
    const lower = String(tag || '').trim().toLowerCase();
    if (!lower) continue;
    const isSubsumed = kept.some((k) => {
      const bigger = String(k || '').toLowerCase();
      if (!bigger.includes(lower)) return false;
      if (bigger === lower) return true;
      const lowWords = lower.split(/\s+/).filter(Boolean);
      const bigWords = bigger.split(/\s+/).filter(Boolean);
      if (lowWords.length <= 1 && bigWords.length >= 2) return true;
      if (lowWords.length <= 2 && bigWords.length >= lowWords.length + 2) return true;
      return false;
    });
    if (!isSubsumed) kept.push(lower);
  }

  const originalOrder = [];
  for (const tag of list) {
    const lower = String(tag || '').trim().toLowerCase();
    if (!lower) continue;
    if (kept.includes(lower) && !originalOrder.includes(lower)) originalOrder.push(lower);
  }
  return originalOrder;
}

function filterNamedPhraseFragments(tags, namedPhrases) {
  const list = Array.isArray(tags) ? tags : [];
  const titles = normalizeTagList(namedPhrases || []);
  if (!titles.length) return list;

  const titleTokens = titles.map((t) => t.split(/\s+/).filter(Boolean));
  const mediumWords = new Set(['movie', 'movies', 'film', 'show', 'series', 'episode', 'season', 'new', 'upcoming']);

  return list.filter((tag) => {
    const clean = String(tag || '').trim().toLowerCase();
    if (!clean) return false;
    if (titles.includes(clean)) return true;

    const words = clean.split(/\s+/).filter(Boolean);
    return !titleTokens.some((tokens) => {
      const overlap = words.filter((w) => tokens.includes(w));
      if (!overlap.length) return false;

      // Remove partial title fragments when full title exists.
      const isStrictSubset = words.every((w) => tokens.includes(w)) && words.length < tokens.length;
      if (isStrictSubset) return true;

      // Remove mixed fragments like "blinders movie" when a named title is present.
      const hasMediumWord = words.some((w) => mediumWords.has(w));
      if (hasMediumWord && overlap.length >= 1 && words.length <= 3) return true;

      return false;
    });
  });
}

function isUsableTagToken(token, stop, weak) {
  if (!token) return false;
  if (token.length < 3 || token.length > 28) return false;
  if (/^\d+$/.test(token)) return false;
  if (stop.has(token)) return false;
  if (weak.has(token)) return false;
  return true;
}

function isWeakTag(tag) {
  const weakTerms = new Set([
    'almost', 'here', 'there', 'fired', 'fired up', 'up', 'down', 'good', 'great', 'nice', 'cool', 'awesome',
    'amazing', 'excited', 'today', 'tomorrow', 'yesterday', 'soon', 'really', 'very', 'much', 'more', 'less',
    'thing', 'stuff', 'post', 'any fans', 'fire any', 'anyone', 'upcoming'
  ]);
  const cleaned = String(tag || '').trim().toLowerCase();
  if (!cleaned) return true;
  if (weakTerms.has(cleaned)) return true;
  const words = cleaned.split(/\s+/);
  if (words.length === 1 && words[0].length <= 3 && !['mlb', 'nfl', 'nba', 'nhl', 'ai'].includes(words[0])) return true;
  if (words.every((w) => weakTerms.has(w))) return true;
  return false;
}

function sanitizeIpnsKeyName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^[a-zA-Z0-9._-]{2,80}$/.test(raw)) return '';
  return raw;
}

function sanitizeText(value, maxLen) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function isLikelyUrl(value) {
  try {
    const parsed = new URL(normalizeUrl(value));
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch (_error) {
    return false;
  }
}

function safeStageId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) return null;
  return raw;
}

async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (_error) {
    return null;
  }
}

async function writeJsonFile(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, text, 'utf8');
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function commandAvailable(name) {
  try {
    await runExec('command', ['-v', name], 2000);
    return true;
  } catch (_error) {
    return false;
  }
}

function runExec(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || '').trim();
        reject(new Error(detail || `${cmd} failed`));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function generateEncryptionJwkPair() {
  const subtle = crypto.webcrypto.subtle;
  const keyPair = await subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['encrypt', 'decrypt']
  );

  const publicJwk = await subtle.exportKey('jwk', keyPair.publicKey);
  const privateJwk = await subtle.exportKey('jwk', keyPair.privateKey);
  return { publicJwk, privateJwk };
}

function generateDid() {
  const token = crypto.randomBytes(32).toString('base64url');
  return `did:key:z${token}`;
}

function defaultNodeName(instanceId) {
  const seed = String(instanceId || crypto.randomUUID()).replaceAll('-', '').slice(0, 8);
  return `node-${seed}`;
}

function normalizeNodeName(value) {
  const raw = String(value || '').trim().replace(/\s+/g, ' ');
  if (raw.length < 3 || raw.length > 40) return '';
  if (!/^[a-zA-Z0-9._ -]+$/.test(raw)) return '';
  return raw;
}

function toIsoTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch (_error) {
    return null;
  }
}

function validateProtocolPayload(schemaId, payload) {
  const schema = protocolSchemas[schemaId];
  if (!schema) {
    return { valid: false, errors: [`unknown schema: ${schemaId}`] };
  }
  const errors = [];
  validateValueAgainstSchema(schema, payload, '$', errors);
  return { valid: errors.length === 0, errors };
}

function validateValueAgainstSchema(schema, value, pathRef, errors) {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pathRef}: expected const "${schema.const}"`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathRef}: expected one of [${schema.enum.join(', ')}]`);
    return;
  }

  if (schema.type === 'object') {
    if (!isPlainObject(value)) {
      errors.push(`${pathRef}: expected object`);
      return;
    }

    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) errors.push(`${pathRef}.${key}: required`);
    }

    const props = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(props)) {
      if (key in value) validateValueAgainstSchema(childSchema, value[key], `${pathRef}.${key}`, errors);
    }

    const additional = schema.additionalProperties;
    if (additional === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${pathRef}.${key}: additional property not allowed`);
      }
    } else if (isPlainObject(additional)) {
      for (const key of Object.keys(value)) {
        if (key in props) continue;
        validateValueAgainstSchema(additional, value[key], `${pathRef}.${key}`, errors);
      }
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${pathRef}: expected array`);
      return;
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i += 1) {
        validateValueAgainstSchema(schema.items, value[i], `${pathRef}[${i}]`, errors);
      }
    }
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`${pathRef}: expected string`);
      return;
    }
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${pathRef}: minLength ${schema.minLength}`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${pathRef}: maxLength ${schema.maxLength}`);
    }
    if (schema.format === 'date-time') {
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) errors.push(`${pathRef}: invalid date-time`);
    }
    return;
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${pathRef}: expected boolean`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

function safeBaseName(name) {
  return String(name || 'asset')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'asset';
}

function guessMimeFromExt(ext) {
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.mkv': return 'video/x-matroska';
    case '.webm': return 'video/webm';
    default: return 'application/octet-stream';
  }
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch (_error) {
    return '';
  }
}

function extractTitleTag(html) {
  const text = String(html || '');
  const match = text.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? decodeHtml(match[1]) : '';
}

function extractMetaContent(html, attr, attrValue) {
  const text = String(html || '');
  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<meta[^>]*${attr}=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
  const reverseRegex = new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${escaped}["'][^>]*>`, 'i');
  const match = text.match(regex) || text.match(reverseRegex);
  return match ? decodeHtml(match[1]) : '';
}

function decodeHtml(value) {
  return String(value || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim();
}
