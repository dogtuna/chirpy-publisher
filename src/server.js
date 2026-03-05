const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const projectRoot = path.join(__dirname, '..');
const stageRoot = path.join(projectRoot, 'staged');
const runtimeRoot = path.join(projectRoot, 'runtime');
const app = express();
const PORT = 3020;
const presenceTopic = process.env.CHIRPY_PRESENCE_TOPIC || 'chirpy.users.v1';
const presenceHeartbeatMs = Number.parseInt(process.env.CHIRPY_PRESENCE_HEARTBEAT_MS || '30000', 10);
const presenceStaleMs = Number.parseInt(process.env.CHIRPY_PRESENCE_STALE_MS || '300000', 10);
const usersFile = path.join(runtimeRoot, 'users.json');
const instanceFile = path.join(runtimeRoot, 'instance.json');

const presenceState = {
    instanceId: null,
    peerId: null,
    nodeName: '',
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
            version: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' }
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

app.use(express.json({ limit: '1mb' }));
bootstrapPresence().catch((error) => {
    console.error(`[presence] bootstrap failed: ${error.message}`);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(projectRoot, 'public', 'index.html'));
});

app.get('/versions', (req, res) => {
    res.sendFile(path.join(projectRoot, 'versions.html'));
});

app.use('/v1', express.static(path.join(projectRoot, 'public-v1')));
app.use('/v2', express.static(path.join(projectRoot, 'public-v2')));
app.use('/v3', express.static(path.join(projectRoot, 'public-v3')));
app.use('/v4', express.static(path.join(projectRoot, 'public-v4')));
app.use('/v5', express.static(path.join(projectRoot, 'public-v5')));

app.use('/staged', express.static(stageRoot));
app.use(express.static(path.join(projectRoot, 'public')));

app.get('/api/stages', async (_req, res) => {
    try {
        const entries = await fs.readdir(stageRoot, { withFileTypes: true });
        const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        const stages = [];
        for (const stageId of directories) {
            const stage = await loadStageSummary(stageId);
            if (stage) stages.push(stage);
        }
        stages.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        res.json({ ok: true, stages });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message || 'failed to load stages' });
    }
});

app.get('/api/stages/:stageId', async (req, res) => {
    try {
        const stageId = safeStageId(req.params.stageId);
        if (!stageId) {
            res.status(400).json({ ok: false, error: 'invalid stage id' });
            return;
        }
        const manifest = await readJsonFile(path.join(stageRoot, stageId, 'manifest.json'));
        const post = await readJsonFile(path.join(stageRoot, stageId, 'post.json'));
        if (!manifest && !post) {
            res.status(404).json({ ok: false, error: 'stage not found' });
            return;
        }
        res.json({
            ok: true,
            stageId,
            manifest: manifest || {},
            post: post || {}
        });
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
    try {
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

app.get('/api/network-node', async (_req, res) => {
    res.json({
        ok: true,
        nodeName: presenceState.nodeName,
        instanceId: presenceState.instanceId,
        peerId: presenceState.peerId || ''
    });
});

app.get('/api/network-node/check-name', async (req, res) => {
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
    const available = isNodeNameAvailable(candidate);
    res.json({
        ok: true,
        available,
        name: candidate,
        reason: available ? '' : 'Name is already taken by an active node'
    });
});

app.post('/api/network-node', async (req, res) => {
    const candidate = normalizeNodeName(req.body?.name);
    if (!candidate) {
        res.status(400).json({
            ok: false,
            error: 'invalid name',
            reason: 'Use 3-40 chars: letters, numbers, spaces, . _ -'
        });
        return;
    }
    if (!isNodeNameAvailable(candidate)) {
        res.status(409).json({
            ok: false,
            error: 'name unavailable',
            reason: 'Name is already taken by an active node'
        });
        return;
    }
    presenceState.nodeName = candidate;
    await persistInstanceInfo();
    recordUser({
        id: presenceState.instanceId,
        peerId: presenceState.peerId,
        name: presenceState.nodeName,
        source: 'self',
        timestamp: new Date().toISOString()
    });
    if (presenceState.ipfsReady) {
        publishHeartbeat().catch(() => null);
    }
    res.json({ ok: true, nodeName: presenceState.nodeName });
});

app.get('/api/users', async (_req, res) => {
    const users = getOrderedUsers();
    res.json({
        ok: true,
        topic: presenceTopic,
        users
    });
});

app.get('/api/protocol/schemas', async (_req, res) => {
    const summary = Object.entries(protocolSchemas).map(([id, schema]) => ({
        id,
        constSchema: schema.properties?.schema?.const || '',
        required: schema.required || []
    }));
    res.json({
        ok: true,
        version: '1.0.0',
        schemas: summary
    });
});

app.post('/api/protocol/validate', async (req, res) => {
    const schemaId = String(req.body?.schemaId || '').trim();
    const payload = req.body?.payload;
    const result = validateProtocolPayload(schemaId, payload);
    res.status(result.valid ? 200 : 400).json({
        ok: result.valid,
        schemaId,
        valid: result.valid,
        errors: result.errors
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Chirpy Publisher server running at http://0.0.0.0:${PORT}`);
    console.log(`Publisher: http://0.0.0.0:${PORT}/`);
    console.log(`My ChirpSpace: http://0.0.0.0:${PORT}/chirpspace.html`);
    console.log(`Version Picker: http://0.0.0.0:${PORT}/versions`);
    console.log(`V1 (Focused Writer): http://0.0.0.0:${PORT}/v1`);
    console.log(`V2 (Split Studio): http://0.0.0.0:${PORT}/v2`);
    console.log(`V3 (Stacked Sections): http://0.0.0.0:${PORT}/v3`);
    console.log(`V4 (Dashboard Cards): http://0.0.0.0:${PORT}/v4`);
    console.log(`V5 (Sidebar Editor): http://0.0.0.0:${PORT}/v5`);
});

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

async function loadStageSummary(stageId) {
    const manifest = await readJsonFile(path.join(stageRoot, stageId, 'manifest.json'));
    const post = await readJsonFile(path.join(stageRoot, stageId, 'post.json'));
    if (!manifest && !post) return null;

    const manifestAssets = manifest?.assets || {};
    const postAssets = post?.assets || {};
    const photos = Array.isArray(manifestAssets.photos) ? manifestAssets.photos : Array.isArray(postAssets.photos) ? postAssets.photos : [];
    const videos = Array.isArray(manifestAssets.videos) ? manifestAssets.videos : Array.isArray(postAssets.videos) ? postAssets.videos : [];
    const links = Array.isArray(manifestAssets.links) ? manifestAssets.links : Array.isArray(postAssets.links) ? postAssets.links : [];
    const text = post?.text || manifest?.post?.text || '';
    const createdAt = manifest?.createdAt || post?.createdAt || null;

    return {
        stageId,
        createdAt,
        text,
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
        ? access.allowedDids.map((item) => String(item || '').trim()).filter(Boolean)
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
    const safeViewerDid = String(viewerDid || '').trim();
    if (!safeViewerDid) return false;
    if (viewerRole !== 'child') return true;
    if (post.userDid && post.userDid === safeViewerDid) return true;
    const allowedDids = Array.isArray(post.access?.allowedDids) ? post.access.allowedDids : [];
    return allowedDids.includes(safeViewerDid);
}

async function writeJsonFile(filePath, value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(filePath, text, 'utf8');
}

async function bootstrapPresence() {
    await fs.mkdir(runtimeRoot, { recursive: true });
    await hydrateUsers();
    const instanceInfo = await ensureInstanceInfo();
    presenceState.instanceId = instanceInfo.instanceId;
    presenceState.nodeName = process.env.CHIRPY_NODE_NAME || instanceInfo.nodeName || defaultNodeName(presenceState.instanceId);
    await persistInstanceInfo();
    presenceState.peerId = await loadPeerId();
    presenceState.ipfsReady = Boolean(presenceState.peerId);
    recordUser({
        id: presenceState.instanceId,
        peerId: presenceState.peerId,
        name: presenceState.nodeName,
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

async function hydrateUsers() {
    const raw = await readJsonFile(usersFile);
    const users = Array.isArray(raw?.users) ? raw.users : [];
    for (const item of users) {
        if (!item?.id) continue;
        presenceState.usersById.set(String(item.id), {
            id: String(item.id),
            peerId: item.peerId ? String(item.peerId) : '',
            name: item.name ? String(item.name) : '',
            source: item.source ? String(item.source) : 'pubsub',
            lastActivity: item.lastActivity ? String(item.lastActivity) : null
        });
    }
}

async function ensureInstanceId() {
    const info = await ensureInstanceInfo();
    return info.instanceId;
}

async function ensureInstanceInfo() {
    const existing = await readJsonFile(instanceFile);
    if (existing?.instanceId) {
        return {
            instanceId: String(existing.instanceId),
            nodeName: typeof existing.nodeName === 'string' ? existing.nodeName : ''
        };
    }
    const next = crypto.randomUUID();
    const created = {
        instanceId: next,
        nodeName: defaultNodeName(next),
        createdAt: new Date().toISOString()
    };
    await writeJsonFile(instanceFile, created);
    return created;
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

async function loadPeerId() {
    return new Promise((resolve) => {
        execFile('ipfs', ['id', '-f=<id>'], { timeout: 4000 }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const peerId = String(stdout || '').trim();
            resolve(peerId || null);
        });
    });
}

function startPresenceSubscriber() {
    if (presenceState.subscriber) return;
    const child = spawn('ipfs', ['pubsub', 'sub', presenceTopic], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
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
            source: 'pubsub',
            timestamp: payload.timestamp
        });
    });

    child.stderr.on('data', () => null);
    child.on('exit', () => {
        presenceState.subscriber = null;
        if (presenceState.ipfsReady) {
            setTimeout(startPresenceSubscriber, 5000);
        }
    });
}

async function publishHeartbeat() {
    const payload = JSON.stringify({
        schema: 'chirpy.presence/1.0.0',
        id: presenceState.instanceId,
        peerId: presenceState.peerId || '',
        name: presenceState.nodeName,
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
    await new Promise((resolve, reject) => {
        execFile('ipfs', ['pubsub', 'pub', presenceTopic, payload], { timeout: 4000 }, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
    recordUser({
        id: presenceState.instanceId,
        peerId: presenceState.peerId,
        name: presenceState.nodeName,
        source: 'self',
        timestamp: new Date().toISOString()
    });
}

function recordUser({ id, peerId, name, source, timestamp }) {
    const nowIso = toIsoTimestamp(timestamp);
    const existing = presenceState.usersById.get(id) || {};
    const next = {
        id,
        peerId: peerId || existing.peerId || '',
        name: name || existing.name || '',
        source: source || existing.source || 'pubsub',
        lastActivity: nowIso
    };
    presenceState.usersById.set(id, next);
    scheduleUsersSave();
}

function scheduleUsersSave() {
    if (presenceState.saveTimer) clearTimeout(presenceState.saveTimer);
    presenceState.saveTimer = setTimeout(() => {
        const users = getOrderedUsers();
        writeJsonFile(usersFile, { users, updatedAt: new Date().toISOString() }).catch(() => null);
    }, 300);
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
                source: user.source || 'pubsub',
                lastActivity: user.lastActivity || null,
                active: isActive
            };
        })
        .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
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

function isNodeNameAvailable(name) {
    const candidate = String(name || '').trim().toLowerCase();
    if (!candidate) return false;
    const now = Date.now();
    for (const user of presenceState.usersById.values()) {
        if (!user?.name) continue;
        if (String(user.name).trim().toLowerCase() !== candidate) continue;
        if (user.id === presenceState.instanceId) continue;
        const seen = Date.parse(String(user.lastActivity || ''));
        if (Number.isFinite(seen) && now - seen <= presenceStaleMs) {
            return false;
        }
    }
    return true;
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
