import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assert, text, object } from './errors.js';
import { ROLES, LOOPBACK } from './config.js';

export class Registry {
  constructor(store, path, config) {
    this.store = store; this.config = config;
    if (path === ':memory:') this.key = randomBytes(32);
    else {
      const keyPath = config.keyPath || join(dirname(path), '.huddle-keyring');
      mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
      try { this.key = readFileSync(keyPath); } catch (e) { if (e.code !== 'ENOENT') throw e; this.key = randomBytes(32); writeFileSync(keyPath, this.key, { flag: 'wx', mode: 0o600 }); }
      assert(this.key.length === 32, 500, 'keyring_invalid', 'The local keyring is invalid'); chmodSync(keyPath, 0o600);
    }
    store.db.exec(`CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,base_url TEXT NOT NULL,supports_reasoning INTEGER NOT NULL DEFAULT 0,api_key_env TEXT NOT NULL DEFAULT '',encrypted_key TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,instructions TEXT NOT NULL,connection_id TEXT NOT NULL REFERENCES connections(id),reasoning_effort TEXT NOT NULL DEFAULT 'default',color TEXT NOT NULL,created_at TEXT NOT NULL);`);
  }
  encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); const encoded = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), encoded].map(b => b.toString('base64')).join('.'); }
  decrypt(value) { if (!value) return ''; const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64')); const decipher = createDecipheriv('aes-256-gcm', this.key, iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'); }
  keyFor(c) { return c.encryptedKey ? this.decrypt(c.encryptedKey) : this.config.secretEnv?.[c.apiKeyEnv] || (c.apiKeyEnv === 'NVIDIA_API_KEY' ? this.config.nvidiaKey : '') || ''; }
  defaults(owner) {
    if (this.store.one('SELECT id FROM connections WHERE owner=?', owner)) return;
    const seeds = [
      { name: 'Sample room', provider: 'demo', model: 'scripted-demo' },
      { name: 'NVIDIA Build', provider: 'nvidia', model: this.config.nvidiaModel, apiKeyEnv: 'NVIDIA_API_KEY' },
      { name: 'Local Ollama', provider: 'ollama', model: this.config.ollamaModel },
    ];
    for (const seed of seeds) {
      const connection = this.saveConnection(owner, seed);
      for (const role of ROLES) this.saveAgent(owner, { name: role.name, role: role.id, instructions: role.description, connectionId: connection.id, color: role.color });
    }
  }
  rawConnection(owner, connectionId) { const c = this.store.one('SELECT * FROM connections WHERE id=? AND owner=?', connectionId, owner); assert(c, 404, 'not_found', 'Connection not found'); return c; }
  safeConnection(c) {
    const { owner, encryptedKey, ...safe } = c;
    let endpointAllowed = true; try { this.validateEndpoint(c.provider, c.baseUrl); } catch { endpointAllowed = false; }
    return { ...safe, supportsReasoning: !!c.supportsReasoning, reasoningEfforts: c.supportsReasoning ? ['low', 'medium', 'high'] : [], hasApiKey: !!this.keyFor(c), configured: endpointAllowed && (c.provider === 'demo' || (c.provider === 'ollama' && this.config.ollamaEnabled) || c.provider === 'compatible' || (c.provider === 'nvidia' && !!this.keyFor(c))) };
  }
  connections(owner) { this.defaults(owner); return this.store.query('SELECT * FROM connections WHERE owner=? ORDER BY rowid', owner).map(c => this.safeConnection(c)); }
  validateEndpoint(provider, supplied) {
    if (provider === 'demo') return '';
    if (provider === 'nvidia') { assert(!supplied || supplied === 'https://integrate.api.nvidia.com/v1', 400, 'invalid_endpoint', 'NVIDIA uses its fixed official endpoint'); return 'https://integrate.api.nvidia.com/v1'; }
    if (provider === 'ollama') {
      const expected = `${this.config.ollamaBase}/v1`;
      const base = supplied || expected; let url; try { url = new URL(base); } catch { assert(false, 400, 'invalid_endpoint', 'Invalid endpoint URL'); }
      assert(url.origin === this.config.ollamaBase && LOOPBACK.has(url.hostname) && ['/v1', '/v1/'].includes(url.pathname) && !url.username && !url.password && !url.search && !url.hash, 400, 'invalid_endpoint', 'Ollama must use the operator-configured loopback endpoint'); return `${url.origin}/v1`;
    }
    let url; try { url = new URL(supplied); } catch { assert(false, 400, 'invalid_endpoint', 'A compatible endpoint URL is required'); }
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && this.config.allowedOrigins?.includes(url.origin), 400, 'endpoint_not_allowed', 'Compatible endpoint must use HTTPS and its exact origin must be in server HUDDLE_ALLOWED_API_ORIGINS');
    assert(/^\/[a-zA-Z0-9/_-]*$/.test(url.pathname), 400, 'invalid_endpoint', 'Endpoint path is invalid'); return url.href.replace(/\/$/, '');
  }
  saveConnection(owner, body, connectionId = null) {
    object(body); const prev = connectionId ? this.rawConnection(owner, connectionId) : {};
    const provider = body.provider ?? prev.provider;
    assert(!connectionId || prev.provider === provider, 400, 'provider_immutable', 'Create a new connection to change provider type');
    assert(['demo', 'nvidia', 'ollama', 'compatible'].includes(provider), 400, 'invalid_input', 'Unsupported provider');
    const name = text(body.name ?? prev.name, 'Connection name', 80);
    const model = provider === 'demo' ? 'scripted-demo' : text(body.model ?? prev.model, 'Model', 150);
    assert(/^[a-zA-Z0-9_./:@+-]+$/.test(model), 400, 'invalid_input', 'Model identifier has unsupported characters');
    assert(provider !== 'ollama' || !/(?:[:\-]cloud)(?:$|[:\-])/i.test(model), 400, 'cloud_model_disabled', 'Only locally installed Ollama models are supported');
    const baseUrl = this.validateEndpoint(provider, body.baseUrl ?? (prev.provider === provider ? prev.baseUrl : undefined));
    const supportsReasoning = body.supportsReasoning ?? !!prev.supportsReasoning;
    assert(typeof supportsReasoning === 'boolean', 400, 'invalid_input', 'supportsReasoning must be a boolean');
    let apiKeyEnv = body.apiKeyEnv ?? prev.apiKeyEnv ?? '';
    assert(typeof apiKeyEnv === 'string' && (apiKeyEnv === '' || apiKeyEnv === 'NVIDIA_API_KEY' || /^HUDDLE_API_KEY_[A-Z0-9_]{1,80}$/.test(apiKeyEnv)), 400, 'invalid_input', 'Use NVIDIA_API_KEY or a HUDDLE_API_KEY_* environment variable');
    let encryptedKey = prev.encryptedKey || '';
    if (body.apiKey !== undefined) { assert(typeof body.apiKey === 'string' && body.apiKey.length <= 4096 && !/[\r\n]/.test(body.apiKey), 400, 'invalid_input', 'API key is invalid'); encryptedKey = body.apiKey ? this.encrypt(body.apiKey) : ''; }
    if (connectionId && baseUrl !== prev.baseUrl && (prev.encryptedKey || prev.apiKeyEnv)) {
      // A destination edit must never silently move an old credential to a new
      // origin or path. Mere form resubmission of the existing env name is not consent.
      const freshKey = typeof body.apiKey === 'string' && body.apiKey.length > 0;
      const freshEnv = typeof body.apiKeyEnv === 'string' && body.apiKeyEnv !== '' && body.apiKeyEnv !== prev.apiKeyEnv;
      const explicitlyCleared = body.apiKey === '' && body.apiKeyEnv === '';
      assert(freshKey || freshEnv || explicitlyCleared, 409, 'destination_reauthorization', 'Changing the endpoint requires re-entering an API key or selecting a different server secret reference. To remove credentials, explicitly clear both the API key and environment reference.');
      if (freshKey) apiKeyEnv = freshEnv ? apiKeyEnv : '';
      else if (freshEnv) encryptedKey = '';
      else { encryptedKey = ''; apiKeyEnv = ''; }
    }
    const count = this.store.one('SELECT COUNT(*) AS count FROM connections WHERE owner=?', owner).count;
    assert(connectionId || count < 30, 400, 'connection_limit', 'Maximum 30 model connections');
    const key = connectionId || randomUUID();
    if (connectionId) this.store.run('UPDATE connections SET name=?,provider=?,model=?,base_url=?,supports_reasoning=?,api_key_env=?,encrypted_key=? WHERE id=? AND owner=?', name, provider, model, baseUrl, supportsReasoning ? 1 : 0, apiKeyEnv, encryptedKey, key, owner);
    else this.store.run('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?)', key, owner, name, provider, model, baseUrl, supportsReasoning ? 1 : 0, apiKeyEnv, encryptedKey, new Date().toISOString());
    return this.safeConnection(this.rawConnection(owner, key));
  }
  rawAgent(owner, agentId) { const a = this.store.one('SELECT * FROM agents WHERE id=? AND owner=?', agentId, owner); assert(a, 404, 'not_found', 'Agent not found'); return a; }
  agents(owner) { this.defaults(owner); return this.store.query('SELECT * FROM agents WHERE owner=? ORDER BY rowid', owner).map(({ owner: _, ...a }) => a); }
  saveAgent(owner, body, agentId = null) {
    object(body); const prev = agentId ? this.rawAgent(owner, agentId) : {};
    const name = text(body.name ?? prev.name, 'Agent name', 60);
    const role = body.role ?? prev.role; assert(ROLES.some(r => r.id === role), 400, 'invalid_input', 'Choose a supported role');
    const instructions = text(body.instructions ?? prev.instructions, 'Agent instructions', 3000);
    const connectionId = body.connectionId ?? prev.connectionId; const c = this.rawConnection(owner, connectionId);
    if (agentId && prev.connectionId !== connectionId) {
      const old = this.rawConnection(owner, prev.connectionId);
      const used = this.store.query('SELECT candidate_agent_ids FROM groups WHERE owner=?', owner).some(g => JSON.parse(g.candidateAgentIds).includes(agentId));
      assert(!used || (old.provider === 'demo') === (c.provider === 'demo'), 400, 'mixed_demo_live', 'An agent used in a group cannot switch between sample and live models. Create a new agent instead.');
    }
    const effort = body.reasoningEffort ?? prev.reasoningEffort ?? 'default';
    assert(['default', 'low', 'medium', 'high'].includes(effort) && (effort === 'default' || c.supportsReasoning), 400, 'unsupported_reasoning', 'This connection does not declare support for the selected reasoning effort');
    const color = body.color ?? prev.color ?? ROLES.find(r => r.id === role).color;
    assert(typeof color === 'string' && /^#[a-fA-F0-9]{6}$/.test(color), 400, 'invalid_input', 'Color must be a six-digit hex color');
    assert(agentId || this.store.one('SELECT COUNT(*) AS count FROM agents WHERE owner=?', owner).count < 100, 400, 'agent_limit', 'Maximum 100 agents');
    const key = agentId || randomUUID();
    if (agentId) this.store.run('UPDATE agents SET name=?,role=?,instructions=?,connection_id=?,reasoning_effort=?,color=? WHERE id=? AND owner=?', name, role, instructions, connectionId, effort, color, key, owner);
    else this.store.run('INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?)', key, owner, name, role, instructions, connectionId, effort, color, new Date().toISOString());
    const { owner: _, ...a } = this.rawAgent(owner, key); return a;
  }
}
