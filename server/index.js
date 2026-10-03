import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { createHttpServer } from './http.js';

process.umask(0o077);
const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
// Exactly one scheduler may own a database. Fail closed on stale locks: automatic
// removal has a takeover race that can create two live schedulers.
const lockPath = `${config.dbPath}.lock`;
try {
  const lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid)); closeSync(lock);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const oldPid = Number(readFileSync(lockPath, 'utf8'));
  if (!Number.isSafeInteger(oldPid) || oldPid < 1) throw new Error('Database lock is invalid; inspect it before removing it');
  throw new Error(`Database lock exists (PID ${oldPid}). Verify that process is stopped, then remove ${lockPath} before restarting.`);
}
let store;
try { store = new Store(config.dbPath, config); } catch (error) { unlinkSync(lockPath); throw error; }
const engine = new Engine(store, config);
const server = createHttpServer(store, engine, config);
server.listen(config.port, config.host, () => { engine.start(); console.log(`Huddle is listening on ${config.publicOrigin || `http://${config.host}:${server.address().port}`}. Provider credentials are never logged.`); });
let closing = false;
async function close() { if (closing) return; closing = true; await engine.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); unlinkSync(lockPath); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close().then(() => process.exit(0)));
server.on('error', () => { console.error('Huddle could not listen. Check HOST, PORT, and whether another instance is running.'); close().then(() => process.exit(1)); });
