import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { AppError, assert, object } from './errors.js';
import { publicConfig, LIMITS, LOOPBACK } from './config.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.json': 'application/json' };
function secretMatches(a, b) { return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()); }
async function jsonBody(req) {
  assert((req.headers['content-type'] || '').split(';')[0] === 'application/json', 415, 'content_type', 'Use application/json');
  assert(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 415, 'content_encoding', 'Compressed request bodies are not supported');
  if (Number(req.headers['content-length']) > LIMITS.bodyBytes) throw new AppError(413, 'body_limit', 'Request body is too large');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; assert(size <= LIMITS.bodyBytes, 413, 'body_limit', 'Request body is too large'); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'invalid_json', 'Malformed JSON request'); }
  return object(body);
}
export function createHttpServer(store, engine, config) {
  const rates = new Map();
  function rate(req, category, maximum) {
    const key = `${req.socket.remoteAddress}:${category}`; const now = Date.now(); const entry = rates.get(key);
    if (!entry || now > entry.until) { rates.set(key, { until: now + 60000, count: 1 }); return; }
    assert(++entry.count <= maximum, 429, 'rate_limit', 'Too many requests. Wait a minute and try again.');
    if (rates.size > 10000) for (const [k, v] of rates) if (now > v.until) rates.delete(k);
  }
  function origins(req) {
    const actualPort = server.address()?.port || config.port;
    const result = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, `http://[::1]:${actualPort}`]);
    if (config.publicOrigin) result.add(config.publicOrigin);
    return result;
  }
  function ownerFor(req) { const token = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('huddle_session='))?.slice(15); return store.sessionOwner(token); }
  function newSession(res) { const token = randomBytes(32).toString('hex'); store.makeSession(token); res.setHeader('Set-Cookie', `huddle_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${config.secureCookie ? '; Secure' : ''}`); return 'operator'; }
  function send(res, status, body) { const data = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' }); res.end(data); }
  function changedSettings(owner) {
    for (const g of store.runnable().filter(g => g.owner === owner)) { store.transaction(() => { store.interruptRuns(g.id, 'Model or agent settings changed'); store.run('UPDATE criteria SET accepted=0 WHERE group_id=?', g.id); store.bump(g.id, ', epoch=epoch+1'); }); engine.interrupt(g.id); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const allowed = origins(req); const hosts = new Set([...allowed].map(v => new URL(v).host));
      assert(hosts.has(req.headers.host), 403, 'host_not_allowed', 'Host is not allowed');
      const url = new URL(req.url, 'http://huddle.local'); const path = url.pathname;
      if (path.startsWith('/api/')) {
        rate(req, 'api', 600);
        assert(req.headers['sec-fetch-site'] !== 'cross-site', 403, 'origin_not_allowed', 'Cross-site requests are not allowed');
        if (req.headers.origin) assert(allowed.has(req.headers.origin), 403, 'origin_not_allowed', 'Origin is not allowed');
        if (!['GET', 'HEAD'].includes(req.method)) assert(allowed.has(req.headers.origin), 403, 'origin_required', 'Mutating requests require the application’s Origin header');
        if (req.method === 'GET' && path === '/api/config') {
          let owner = ownerFor(req); if (!owner && !config.accessSecret) owner = newSession(res);
          const safe = publicConfig(config);
          if (owner) {
            const connections = store.registry.connections(owner);
            safe.providers = safe.providers.map(p => ({ ...p, available: connections.some(c => c.provider === p.id && c.configured) }));
            safe.providers.push({ id: 'compatible', label: 'Open-model endpoint', available: connections.some(c => c.provider === 'compatible' && c.configured), model: '', note: 'Operator-allowlisted endpoint. Verify its terms, costs, and data policy yourself.' });
            safe.connections = connections; safe.agents = store.registry.agents(owner);
          }
          return send(res, 200, { ...safe, authenticated: !!owner });
        }
        if (req.method === 'POST' && path === '/api/session') {
          rate(req, 'login', 10); const body = await jsonBody(req);
          assert(typeof body.accessSecret === 'string' && body.accessSecret.length <= 4096, 400, 'invalid_input', 'Provide the workspace access secret');
          assert(!config.accessSecret || secretMatches(body.accessSecret, config.accessSecret), 401, 'unauthorized', 'Incorrect workspace access secret');
          newSession(res); return send(res, 200, { authenticated: true });
        }
        const owner = ownerFor(req); assert(owner, 401, 'unauthorized', 'Unlock this workspace first');
        if (path === '/api/connections' && req.method === 'GET') return send(res, 200, { connections: store.registry.connections(owner) });
        if (path === '/api/agents' && req.method === 'GET') return send(res, 200, { agents: store.registry.agents(owner) });
        const registryPath = path.match(/^\/api\/(connections|agents)(?:\/([a-f0-9-]{36}))?$/);
        if (registryPath && ((req.method === 'POST' && !registryPath[2]) || (req.method === 'PATCH' && registryPath[2]))) {
          rate(req, 'settings', 60); const body = await jsonBody(req); const isConnection = registryPath[1] === 'connections';
          const value = isConnection ? store.registry.saveConnection(owner, body, registryPath[2]) : store.registry.saveAgent(owner, body, registryPath[2]);
          changedSettings(owner); return send(res, registryPath[2] ? 200 : 201, { [isConnection ? 'connection' : 'agent']: value });
        }
        if (path === '/api/groups' && req.method === 'GET') return send(res, 200, { groups: store.list(owner, url.searchParams.get('archived') === 'true') });
        if (path === '/api/groups' && req.method === 'POST') { rate(req, 'create', 30); return send(res, 201, { group: store.create(owner, await jsonBody(req)) }); }
        const route = path.match(/^\/api\/groups\/([a-f0-9-]{36})(?:\/(actions|messages|members|criteria)(?:\/([a-f0-9-]{36}))?)?$/);
        if (route) {
          const [, groupId, endpoint, criterionId] = route;
          if (req.method === 'GET' && !endpoint) return send(res, 200, { group: store.detail(groupId, owner) });
          if (req.method === 'POST') {
            const body = await jsonBody(req); let group;
            if (endpoint === 'actions' && !criterionId) group = store.control(groupId, owner, body);
            else if (endpoint === 'messages' && !criterionId) group = store.addHumanMessage(groupId, owner, body);
            else if (endpoint === 'members' && !criterionId) group = store.addMember(groupId, owner, body);
            else if (endpoint === 'criteria' && criterionId) group = store.setCriterion(groupId, owner, criterionId, body);
            else throw new AppError(404, 'not_found', 'API route not found');
            if (endpoint !== 'criteria') engine.interrupt(groupId);
            return send(res, 200, { group });
          }
        }
        throw new AppError(404, 'not_found', 'API route not found');
      }
      assert(['GET', 'HEAD'].includes(req.method), 405, 'method_not_allowed', 'Method not allowed');
      let decoded; try { decoded = decodeURIComponent(path); } catch { throw new AppError(400, 'invalid_path', 'Invalid path'); }
      assert(!decoded.includes('\0') && !decoded.split('/').includes('..'), 400, 'invalid_path', 'Invalid path');
      assert(!decoded.split('/').some(segment => segment.startsWith('.')), 404, 'not_found', 'File not found');
      const relative = decoded === '/' || !extname(decoded) ? '/index.html' : decoded;
      const target = resolve(config.publicPath, `.${relative}`); const root = await realpath(config.publicPath); const actual = await realpath(target).catch(() => null);
      assert(actual && actual.startsWith(root + sep), 404, 'not_found', 'File not found');
      const file = await stat(actual); assert(file.isFile() && file.size <= 5000000, 404, 'not_found', 'File not found');
      const content = await readFile(actual); res.writeHead(200, { 'Content-Type': MIME[extname(actual)] || 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const safe = error instanceof AppError ? error : new AppError(500, 'internal_error', 'The request could not be completed');
      send(res, safe.status, { error: { code: safe.code, message: safe.message } });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 64;
  return server;
}
