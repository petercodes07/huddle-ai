import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { ProviderError, callProvider, makeRequest, parseReply } from '../server/providers.js';
import { createHttpServer } from '../server/http.js';

const cfg = extras => ({ ...loadConfig({}), tickMs: 5, demoDelayMs: 1, retryBaseMs: 1, ...extras });
const data = extras => ({ title: 'Launch room', goal: 'Prepare a practical launch plan', criteria: ['Provide a concrete plan', 'State limitations'], provider: 'demo', ...extras });
const reply = extras => ({ content: 'Useful draft response', join: true, review: false, artifact: null, evidence: [], nominations: [], ...extras });
const waitFor = async (predicate, timeout = 2000) => { const deadline = Date.now() + timeout; while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for state'); await new Promise(r => setTimeout(r, 5)); } };
const action = (s, id, command, owner = 'alice') => s.control(id, owner, { action: command, expectedVersion: s.detail(id, owner).version });

async function setupHttp(options = {}) {
  const config = cfg(options); const store = new Store(':memory:', config); const engine = new Engine(store, config); const server = createHttpServer(store, engine, config);
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (path, method = 'GET', body, overrides = {}) => {
    const headers = { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }), ...overrides };
    const res = await fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, body: await res.json(), cookie };
  };
  return { store, engine, server, origin, request, async close() { await engine.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); } };
}

test('demo self-nomination, shared-model personas, artifact, and human-only completion', async () => {
  const s = new Store(':memory:', cfg()); const e = new Engine(s, cfg()); e.start();
  try {
    const g = s.create('alice', data()); action(s, g.id, 'start');
    await waitFor(() => s.detail(g.id, 'alice').status === 'review');
    let result = s.detail(g.id, 'alice');
    assert.equal(result.members.length, 4); assert.equal(result.runs.filter(r => r.kind === 'nomination').length, 3);
    assert.ok(result.messages.some(m => m.kind === 'nomination' && m.content.includes('Scripted demo')));
    assert.equal(result.artifacts.length, 1); assert.equal(result.criteria.every(c => !c.accepted), true);
    assert.throws(() => action(s, g.id, 'accept'), /Human acceptance/);
    for (const c of result.criteria) result = s.setCriterion(g.id, 'alice', c.id, { accepted: true, expectedVersion: result.version });
    result = action(s, g.id, 'accept'); assert.equal(result.status, 'completed');
    assert.throws(() => action(s, g.id, 'resume'), /Cannot resume/);
    assert.equal(new Set(result.messages.filter(m => m.role === 'agent').map(m => m.turn)).size, result.turnsUsed);
  } finally { await e.stop(); s.close(); }
});

test('pause fences even a provider that ignores abort and resolves late', async () => {
  const s = new Store(':memory:', cfg()); let resolveProvider;
  const e = new Engine(s, cfg(), { provider: () => new Promise(r => { resolveProvider = r; }) }); e.start();
  const g = s.create('alice', data()); action(s, g.id, 'start');
  await waitFor(() => !!resolveProvider); action(s, g.id, 'pause'); e.interrupt(g.id);
  resolveProvider(reply({ artifact: { title: 'Stale', content: 'Must never commit' }, review: true }));
  await waitFor(() => e.active.size === 0);
  const paused = s.detail(g.id, 'alice'); assert.equal(paused.status, 'paused'); assert.equal(paused.turnsUsed, 0); assert.equal(paused.artifacts.length, 0); assert.equal(paused.runs[0].status, 'interrupted');
  await e.stop(); s.close();
});

test('new human context fences late responses and clears earlier acceptance', () => {
  const s = new Store(':memory:', cfg()); const g = s.create('alice', data()); action(s, g.id, 'start');
  const member = s.detail(g.id, 'alice').members[0]; const run = s.claim(g.id, member, 100);
  const before = s.detail(g.id, 'alice'); s.addHumanMessage(g.id, 'alice', { content: 'Change the plan focus to accessibility.', expectedVersion: before.version });
  assert.equal(s.commit(run, reply()), false); assert.equal(s.detail(g.id, 'alice').turnsUsed, 0); s.close();
});

test('persistent restart recovers orphan run with no duplicate committed turns', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'huddle-restart-')); const path = join(folder, 'huddle.sqlite'); const config = cfg();
  let s = new Store(path, config); const g = s.create('alice', data()); action(s, g.id, 'start');
  const run = s.claim(g.id, s.detail(g.id, 'alice').members[0], 100); s.commit(run, reply());
  const orphan = s.claim(g.id, s.detail(g.id, 'alice').members[0], 100); s.close();
  s = new Store(path, config); const e = new Engine(s, config); e.start();
  try {
    await waitFor(() => s.detail(g.id, 'alice').status === 'review'); const restored = s.detail(g.id, 'alice');
    assert.equal(restored.runs.find(r => r.id === orphan.id).status, 'interrupted');
    assert.equal(restored.messages.filter(m => m.role === 'agent' && m.turn === 1).length, 1);
    assert.equal(new Set(restored.messages.filter(m => m.role === 'agent').map(m => m.turn)).size, restored.turnsUsed);
    assert.ok(restored.messages.some(m => m.kind === 'recovered'));
  } finally { await e.stop(); s.close(); }
});

test('ownership and optimistic version checks protect every group mutation', () => {
  const s = new Store(':memory:', cfg()); const g = s.create('alice', data());
  assert.throws(() => s.detail(g.id, 'bob'), /Group not found/);
  assert.throws(() => s.control(g.id, 'bob', { action: 'start', expectedVersion: g.version }), /Group not found/);
  assert.throws(() => s.setCriterion(g.id, 'bob', g.criteria[0].id, { accepted: true, expectedVersion: g.version }), /Group not found/);
  action(s, g.id, 'start');
  assert.throws(() => s.addHumanMessage(g.id, 'alice', { content: 'stale', expectedVersion: g.version }), /group changed/);
  assert.throws(() => s.control(g.id, 'alice', { action: 'pause' }), /expectedVersion/);
  s.close();
});

test('input bounds, bad transitions, nomination scope, budget hard stop', () => {
  const s = new Store(':memory:', cfg());
  assert.throws(() => s.create('alice', data({ title: 'x'.repeat(101) })), /Title/);
  assert.throws(() => s.create('alice', data({ criteria: [] })), /acceptance criteria/);
  assert.throws(() => s.create('alice', data({ maxTurns: 999 })), /maxTurns/);
  assert.throws(() => s.create('alice', data({ initialAgentIds: ['someone-else'] })), /Agent not found/);
  const g = s.create('alice', data({ maxTokens: 2048, maxTurns: 4 })); action(s, g.id, 'start');
  s.join(g.id, 'not-selected-id', 'untrusted nomination'); assert.equal(s.detail(g.id, 'alice').members.length, 1);
  assert.equal(s.claim(g.id, s.detail(g.id, 'alice').members[0], 2049), null);
  assert.equal(s.detail(g.id, 'alice').status, 'budget_exhausted'); assert.equal(s.detail(g.id, 'alice').tokensUsed, 0);
  assert.throws(() => action(s, g.id, 'accept'), /Cannot accept/); s.close();
});

test('resume clears acceptance; archive is reversible and never resumes work', async () => {
  const s = new Store(':memory:', cfg()); const e = new Engine(s, cfg()); e.start(); const g = s.create('alice', data()); action(s, g.id, 'start');
  await waitFor(() => s.detail(g.id, 'alice').status === 'review');
  let current = s.detail(g.id, 'alice'); s.setCriterion(g.id, 'alice', current.criteria[0].id, { accepted: true, expectedVersion: current.version });
  action(s, g.id, 'resume'); assert.ok(s.detail(g.id, 'alice').criteria.every(c => !c.accepted)); action(s, g.id, 'pause');
  current = action(s, g.id, 'archive'); assert.equal(s.list('alice').length, 0); assert.equal(s.list('alice', true).length, 1);
  current = action(s, g.id, 'restore'); assert.equal(current.status, 'paused'); assert.equal(current.archived, false);
  await e.stop(); s.close();
});

test('bounded retries reserve budget for every provider attempt and stop safely', async () => {
  const s = new Store(':memory:', cfg()); let calls = 0;
  const e = new Engine(s, cfg(), { provider: async () => { calls++; throw new ProviderError('rate_limited', 'Provider is rate limited', { retryable: true }); } }); e.start();
  const g = s.create('alice', data()); action(s, g.id, 'start');
  await waitFor(() => s.detail(g.id, 'alice').status === 'error'); const result = s.detail(g.id, 'alice');
  assert.equal(calls, 3); assert.equal(result.tokensUsed, 300); assert.equal(result.attemptsUsed, 3); assert.equal(result.runs[0].attempts, 3);
  assert.equal(result.turnsUsed, 0); assert.equal(result.provider, 'demo');
  await e.stop(); s.close();
});

test('provider handles mocked 429, timeouts, invalid JSON and no silent fallback', async () => {
  const args = { connection: { provider: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'model' }, apiKey: 'test-only-secret', agent: { reasoningEffort: 'default' }, request: { messages: [], maxOutput: 10 }, config: cfg({ timeoutMs: 100 }), signal: new AbortController().signal };
  await assert.rejects(callProvider({ ...args, fetchImpl: async () => new Response('never echo this secret', { status: 429, headers: { 'retry-after': '2' } }) }), error => error.code === 'rate_limited' && error.retryAfterMs === 2000 && !error.message.includes('secret'));
  await assert.rejects(callProvider({ ...args, fetchImpl: async (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('abort')))) }), error => error.code === 'timeout');
  await assert.rejects(callProvider({ ...args, fetchImpl: async () => new Response('{bad json') }), error => error.code === 'invalid_reply');
  await assert.rejects(callProvider({ ...args, fetchImpl: async () => new Response('{}', { status: 401 }) }), error => error.code === 'authentication_failed');
  const result = await callProvider({ ...args, fetchImpl: async (_, options) => { assert.equal(JSON.parse(options.body).reasoning_effort, undefined); return Response.json({ choices: [{ message: { content: JSON.stringify(reply()), reasoning_content: 'must not expose' } }] }); } });
  assert.equal(result.content, 'Useful draft response'); assert.equal(result.reasoning_content, undefined);
});

test('connection secrets encrypted, write-only, scoped and configurable without leaked env', () => {
  const folder = mkdtempSync(join(tmpdir(), 'huddle-secrets-')); const path = join(folder, 'db.sqlite'); const s = new Store(path, cfg());
  const c = s.registry.saveConnection('alice', { name: 'Test endpoint', provider: 'nvidia', model: 'meta/test', apiKey: 'FAKE_TEST_CREDENTIAL_123' });
  assert.equal(c.hasApiKey, true); assert.equal(c.apiKey, undefined); assert.equal(c.encryptedKey, undefined);
  const raw = s.registry.rawConnection('alice', c.id); assert.ok(!raw.encryptedKey.includes('FAKE_TEST')); assert.equal(s.registry.keyFor(raw), 'FAKE_TEST_CREDENTIAL_123');
  assert.throws(() => s.registry.rawConnection('bob', c.id), /Connection not found/);
  assert.equal(statSync(join(folder, '.huddle-keyring')).mode & 0o777, 0o600);
  assert.throws(() => s.registry.saveConnection('alice', { name: 'Bad', provider: 'nvidia', model: 'test', apiKeyEnv: 'HUDDLE_ACCESS_SECRET' }), /environment variable/);
  assert.throws(() => s.registry.saveConnection('alice', { name: 'Bad', provider: 'compatible', model: 'test', baseUrl: 'http://169.254.169.254/latest' }), /HTTPS/);
  s.close(); assert.equal(readFileSync(path).includes('FAKE_TEST_CREDENTIAL_123'), false);
});

test('multiple profiles share a connection while custom reasoning is capability checked', () => {
  const s = new Store(':memory:', cfg()); s.registry.defaults('alice'); const c = s.registry.connections('alice').find(c => c.provider === 'demo');
  const a = s.registry.saveAgent('alice', { name: 'Designer', role: 'builder', instructions: 'Focus on accessibility', connectionId: c.id });
  const b = s.registry.saveAgent('alice', { name: 'Engineer', role: 'builder', instructions: 'Focus on implementation constraints', connectionId: c.id });
  assert.notEqual(a.id, b.id); assert.equal(a.connectionId, b.connectionId);
  assert.throws(() => s.registry.saveAgent('alice', { name: 'Reasoner', role: 'critic', instructions: 'Review', connectionId: c.id, reasoningEffort: 'high' }), /reasoning effort/);
  const g = s.create('alice', data({ initialAgentIds: [a.id, b.id], maxAgents: 2 })); action(s, g.id, 'start'); s.addMember(g.id, 'alice', { agentId: b.id, expectedVersion: s.detail(g.id, 'alice').version });
  assert.equal(s.detail(g.id, 'alice').members.length, 2); s.close();
});

test('Ollama operator disable and non-local cloud models are enforced', async () => {
  const s = new Store(':memory:', cfg()); const ollama = s.registry.connections('alice').find(c => c.provider === 'ollama'); assert.equal(ollama.configured, false);
  assert.throws(() => s.create('alice', data({ provider: 'ollama' })), /configured model/);
  assert.throws(() => s.registry.saveConnection('alice', { name: 'Cloud', provider: 'ollama', model: 'gpt-oss:120b-cloud' }), /locally installed/);
  let calls = 0;
  await assert.rejects(callProvider({ connection: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, agent: {}, request: {}, config: cfg(), signal: new AbortController().signal, fetchImpl: async () => { calls++; } }), e => e.code === 'ollama_disabled');
  assert.equal(calls, 0); s.close();
});

test('HTTP session auth, strict origin/Host, safe errors and body bounds', async () => {
  const h = await setupHttp();
  try {
    assert.equal((await h.request('/api/groups')).status, 401);
    const config = await h.request('/api/config'); assert.equal(config.body.authenticated, true); assert.ok(config.cookie.startsWith('huddle_session='));
    let res = await h.request('/api/groups', 'POST', data()); assert.equal(res.status, 201); const g = res.body.group;
    res = await h.request('/api/groups', 'POST', data(), { origin: 'https://evil.example' }); assert.equal(res.status, 403);
    const hostileHostStatus = await new Promise((resolve, reject) => { const request = http.get(`${h.origin}/api/config`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); }); assert.equal(hostileHostStatus, 403);
    res = await h.request('/api/groups', 'POST', '{malformed'); assert.equal(res.status, 400);
    res = await h.request('/api/groups', 'POST', { ...data(), goal: 'x'.repeat(40000) }); assert.equal(res.status, 413);
    res = await h.request(`/api/groups/${g.id}/actions`, 'POST', { action: 'start', expectedVersion: g.version }); assert.equal(res.status, 200); assert.equal(res.body.group.status, 'running');
    assert.equal(JSON.stringify(config.body).includes('secretEnv'), false);
  } finally { await h.close(); }
});

test('remote workspace unlock is required and secrets are never echoed', async () => {
  assert.throws(() => loadConfig({ HUDDLE_PUBLIC_ORIGIN: 'https://huddle.example.com' }), /requires HUDDLE_ACCESS_SECRET/);
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /requires HUDDLE_ACCESS_SECRET/);
  assert.throws(() => loadConfig({ OLLAMA_BASE_URL: 'http://10.0.0.1:11434' }), /loopback/);
  const h = await setupHttp({ accessSecret: 'test-workspace-secret-at-least-24-chars' });
  try {
    assert.equal((await h.request('/api/config')).body.authenticated, false);
    assert.equal((await h.request('/api/session', 'POST', { accessSecret: 'incorrect' })).status, 401);
    assert.equal((await h.request('/api/session', 'POST', { accessSecret: 'test-workspace-secret-at-least-24-chars' })).status, 200);
    assert.equal((await h.request('/api/groups')).status, 200);
  } finally { await h.close(); }
});

test('model cannot self-certify acceptance, arbitrary completion fields ignored', () => {
  const result = parseReply(JSON.stringify({ content: 'Done', completed: true, accepted: true, status: 'completed', review: true }));
  assert.equal(result.completed, undefined); assert.equal(result.accepted, undefined);
  const s = new Store(':memory:', cfg()); const g = s.create('alice', data()); action(s, g.id, 'start');
  const run = s.claim(g.id, s.detail(g.id, 'alice').members[0], 100); s.commit(run, result);
  assert.equal(s.detail(g.id, 'alice').status, 'running'); assert.ok(s.detail(g.id, 'alice').criteria.every(c => !c.accepted)); s.close();
});

test('allowlist revocation disables persisted endpoints and prevents any network request', async () => {
  const config = cfg({ allowedOrigins: ['https://local-model.example'] }); const s = new Store(':memory:', config);
  const c = s.registry.saveConnection('alice', { name: 'Compatible', provider: 'compatible', model: 'open-model', baseUrl: 'https://local-model.example/v1' });
  assert.equal(c.configured, true); config.allowedOrigins = [];
  assert.equal(s.registry.connections('alice')[0].configured, false);
  let calls = 0;
  await assert.rejects(callProvider({ connection: s.registry.rawConnection('alice', c.id), agent: {}, request: {}, config, signal: new AbortController().signal, fetchImpl: async () => { calls++; } }), e => e.code === 'endpoint_not_allowed');
  assert.equal(calls, 0); s.close();
});

test('sample/live isolation also survives profile and connection edits', () => {
  const s = new Store(':memory:', cfg()); s.registry.defaults('alice'); const connections = s.registry.connections('alice'); const demo = connections.find(c => c.provider === 'demo');
  const live = s.registry.saveConnection('alice', { name: 'Live', provider: 'nvidia', model: 'llama', apiKey: 'fake-test-key' });
  const a = s.registry.agents('alice').find(a => a.connectionId === demo.id); const b = s.registry.saveAgent('alice', { name: 'Live agent', role: 'builder', instructions: 'Build', connectionId: live.id });
  assert.throws(() => s.create('alice', data({ initialAgentIds: [a.id, b.id] })), /cannot share/);
  const g = s.create('alice', data({ initialAgentIds: [a.id] }));
  assert.throws(() => s.addMember(g.id, 'alice', { agentId: b.id, expectedVersion: g.version }), /cannot share/);
  assert.throws(() => s.registry.saveAgent('alice', { connectionId: live.id }, a.id), /cannot switch/);
  assert.throws(() => s.registry.saveConnection('alice', { provider: 'nvidia' }, demo.id), /new connection/); s.close();
});

test('a running group durably errors after its compatible origin is revoked', async () => {
  const config = cfg({ allowedOrigins: ['https://models.example'] }); const s = new Store(':memory:', config);
  const c = s.registry.saveConnection('alice', { name: 'Compatible', provider: 'compatible', model: 'model', baseUrl: 'https://models.example/v1' });
  const a = s.registry.saveAgent('alice', { name: 'Planner', role: 'coordinator', instructions: 'Plan carefully', connectionId: c.id });
  const g = s.create('alice', data({ initialAgentIds: [a.id] })); action(s, g.id, 'start'); config.allowedOrigins = [];
  let calls = 0; const e = new Engine(s, config, { provider: async () => { calls++; return reply(); } }); e.start();
  await waitFor(() => s.detail(g.id, 'alice').status === 'error'); assert.equal(calls, 0); assert.match(s.detail(g.id, 'alice').lastError, /disabled|no longer allowed/);
  await e.stop(); s.close();
});

test('cancellation fences a pending provider and cannot be resumed', async () => {
  const s = new Store(':memory:', cfg()); let done; const e = new Engine(s, cfg(), { provider: () => new Promise(r => { done = r; }) }); e.start();
  const g = s.create('alice', data()); action(s, g.id, 'start'); await waitFor(() => !!done);
  action(s, g.id, 'cancel'); e.interrupt(g.id); done(reply()); await waitFor(() => !e.active.size);
  assert.equal(s.detail(g.id, 'alice').status, 'cancelled'); assert.equal(s.detail(g.id, 'alice').turnsUsed, 0); assert.throws(() => action(s, g.id, 'resume'), /Cannot resume/);
  await e.stop(); s.close();
});

test('endpoint changes never silently transfer saved credentials or environment references', () => {
  const config = cfg({ allowedOrigins: ['https://one.example', 'https://two.example'], secretEnv: { HUDDLE_API_KEY_OLD: 'fake-old-env', HUDDLE_API_KEY_NEW: 'fake-new-env' } });
  const s = new Store(':memory:', config);
  const c = s.registry.saveConnection('alice', { name: 'Endpoint', provider: 'compatible', model: 'model', baseUrl: 'https://one.example/v1', apiKey: 'fake-original-key', apiKeyEnv: 'HUDDLE_API_KEY_OLD' });
  const reject = patch => assert.throws(() => s.registry.saveConnection('alice', patch, c.id), e => e.code === 'destination_reauthorization');
  reject({ baseUrl: 'https://two.example/v1' });
  reject({ baseUrl: 'https://one.example/new-path' });
  reject({ baseUrl: 'https://two.example/v1', apiKeyEnv: 'HUDDLE_API_KEY_OLD' });
  reject({ baseUrl: 'https://two.example/v1', apiKey: '' });
  assert.equal(s.registry.rawConnection('alice', c.id).baseUrl, 'https://one.example/v1');
  s.registry.saveConnection('alice', { baseUrl: 'https://two.example/v1', apiKey: 'fake-explicit-new-key', apiKeyEnv: 'HUDDLE_API_KEY_OLD' }, c.id);
  let raw = s.registry.rawConnection('alice', c.id); assert.equal(raw.apiKeyEnv, ''); assert.equal(s.registry.keyFor(raw), 'fake-explicit-new-key');
  s.registry.saveConnection('alice', { baseUrl: 'https://one.example/v1', apiKeyEnv: 'HUDDLE_API_KEY_NEW' }, c.id);
  raw = s.registry.rawConnection('alice', c.id); assert.equal(raw.encryptedKey, ''); assert.equal(s.registry.keyFor(raw), 'fake-new-env');
  s.registry.saveConnection('alice', { baseUrl: 'https://two.example/v1', apiKey: '', apiKeyEnv: '' }, c.id);
  raw = s.registry.rawConnection('alice', c.id); assert.equal(raw.encryptedKey, ''); assert.equal(raw.apiKeyEnv, ''); assert.equal(s.registry.keyFor(raw), '');
  s.close();
});
