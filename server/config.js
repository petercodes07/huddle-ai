import { resolve } from 'node:path';

export const ROLES = [
  { id: 'coordinator', name: 'Atlas', description: 'Coordinates the plan and invites relevant specialists', color: '#7588f5' },
  { id: 'researcher', name: 'Sage', description: 'Examines assumptions, context, and evidence gaps', color: '#e5b766' },
  { id: 'builder', name: 'Nova', description: 'Creates concrete drafts and deliverables', color: '#6ebca2' },
  { id: 'critic', name: 'Quinn', description: 'Tests the work against the human’s acceptance criteria', color: '#d88fad' },
];
export const LIMITS = Object.freeze({ maxGroups: 100, maxMessages: 1000, title: 100, goal: 6000, criteria: 12, criterion: 500, message: 8000, maxTurns: 40, maxTokens: 200000, bodyBytes: 32768, artifact: 16000 });
export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 4310);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
  const accessSecret = env.HUDDLE_ACCESS_SECRET || '';
  if (accessSecret && accessSecret.length < 24) throw new Error('HUDDLE_ACCESS_SECRET must have at least 24 characters');
  if (!LOOPBACK.has(host) && !accessSecret) throw new Error('Non-loopback binding requires HUDDLE_ACCESS_SECRET');
  const ollama = new URL(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  if (ollama.protocol !== 'http:' || !LOOPBACK.has(ollama.hostname) || ollama.username || ollama.password || ollama.pathname !== '/' || ollama.search || ollama.hash) throw new Error('OLLAMA_BASE_URL must be an HTTP loopback origin');
  const publicOrigin = env.HUDDLE_PUBLIC_ORIGIN || '';
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.origin !== publicOrigin || !['http:', 'https:'].includes(url.protocol)) throw new Error('HUDDLE_PUBLIC_ORIGIN must be an exact HTTP(S) origin');
    if (!LOOPBACK.has(url.hostname) && !accessSecret) throw new Error('A non-loopback public origin requires HUDDLE_ACCESS_SECRET');
    if (!LOOPBACK.has(url.hostname) && url.protocol !== 'https:') throw new Error('A remote public origin must use HTTPS');
  }
  const timeoutMs = Number(env.PROVIDER_TIMEOUT_MS || 60000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180000) throw new Error('PROVIDER_TIMEOUT_MS must be 100..180000');
  return {
    host, port, accessSecret, publicOrigin, secureCookie: env.HUDDLE_SECURE_COOKIE === 'true' || publicOrigin.startsWith('https:'),
    allowedOrigins: (env.HUDDLE_ALLOWED_API_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), secretEnv: env,
    keyPath: env.HUDDLE_SECRET_KEY_FILE ? resolve(env.HUDDLE_SECRET_KEY_FILE) : null,
    dbPath: resolve(env.HUDDLE_DB || './data/huddle.sqlite'), publicPath: resolve('./public'),
    nvidiaKey: env.NVIDIA_API_KEY || '', nvidiaModel: env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
    ollamaEnabled: env.OLLAMA_ENABLED === 'true', ollamaBase: ollama.origin, ollamaModel: env.OLLAMA_MODEL || 'llama3.2',
    timeoutMs, tickMs: 400, demoDelayMs: 850, maxRetries: 2, retryBaseMs: 1000,
  };
}
export function publicConfig(config) {
  return {
    version: '0.1.0', roles: ROLES, limits: LIMITS, authRequired: !!config.accessSecret,
    providers: [
      { id: 'demo', label: 'Demo · deterministic', available: true, model: 'scripted-demo', note: 'Scripted demonstration. No AI inference or external execution. Never used as a fallback.' },
      { id: 'nvidia', label: 'NVIDIA Build', available: !!config.nvidiaKey, model: config.nvidiaModel, note: 'Developer access depends on NVIDIA account limits and terms. No guarantee of unlimited or production-free usage.' },
      { id: 'ollama', label: 'Local Ollama', available: config.ollamaEnabled, model: config.ollamaModel, note: 'Runs on your own machine. Local compute and electricity still have costs.' },
    ],
  };
}
