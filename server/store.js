import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError, assert, text, integer, object } from './errors.js';
import { Registry } from './registry.js';
import { LIMITS, ROLES, publicConfig } from './config.js';

const now = () => new Date().toISOString();
const id = () => randomUUID();
const camel = row => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));
export class Store {
  constructor(path, config) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.config = config;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
        provider TEXT NOT NULL, model TEXT NOT NULL, candidate_agent_ids TEXT NOT NULL DEFAULT '[]', max_agents INTEGER NOT NULL DEFAULT 4, max_turns INTEGER NOT NULL, max_tokens INTEGER NOT NULL,
        turns_used INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0, attempts_used INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1, epoch INTEGER NOT NULL DEFAULT 0, last_error TEXT, archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS criteria (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), text TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), role TEXT NOT NULL, name TEXT NOT NULL, agent_id TEXT NOT NULL, reason TEXT NOT NULL, joined_at TEXT NOT NULL, UNIQUE(group_id, agent_id));
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), role TEXT NOT NULL, agent_role TEXT, agent_id TEXT, agent_name TEXT, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message', turn INTEGER, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS unique_agent_turn ON messages(group_id, turn) WHERE role='agent';
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), epoch INTEGER NOT NULL, status TEXT NOT NULL, agent_role TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'work', turn INTEGER NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 1, started_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), title TEXT NOT NULL, content TEXT NOT NULL, agent_role TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, secret_tag TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS owner_groups ON groups(owner, updated_at);
      CREATE INDEX IF NOT EXISTS group_messages ON messages(group_id, created_at);
    `);
    this.registry = new Registry(this, path, config);
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  query(sql, ...args) { return this.db.prepare(sql).all(...args).map(camel); }
  one(sql, ...args) { return camel(this.db.prepare(sql).get(...args)); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  owned(groupId, owner) { const g = this.one('SELECT * FROM groups WHERE id=? AND owner=?', groupId, owner); assert(g, 404, 'not_found', 'Group not found'); return g; }
  requireVersion(g, version) { assert(Number.isSafeInteger(version), 400, 'version_required', 'expectedVersion is required'); assert(g.version === version, 409, 'stale_version', 'The group changed. Refresh and try again.'); }
  bump(groupId, extra = '') { this.run(`UPDATE groups SET version=version+1, updated_at=?${extra} WHERE id=?`, now(), groupId); }
  message(groupId, role, content, kind = 'message', agentRole = null, turn = null) { this.run('INSERT INTO messages(id,group_id,role,agent_role,content,kind,turn,created_at) VALUES(?,?,?,?,?,?,?,?)', id(), groupId, role, agentRole, content, kind, turn, now()); }
  list(owner, archived = false) { return this.query('SELECT * FROM groups WHERE owner=? AND archived=? ORDER BY updated_at DESC', owner, archived ? 1 : 0).map(g => this.summary(g)); }
  summary(g) { const { owner, epoch, candidateAgentIds, ...safe } = g; return { ...safe, candidateAgentIds: JSON.parse(candidateAgentIds), archived: !!safe.archived, memberCount: this.one('SELECT COUNT(*) AS count FROM members WHERE group_id=?', g.id).count }; }
  detail(groupId, owner) {
    const g = this.owned(groupId, owner);
    return { ...this.summary(g),
      criteria: this.query('SELECT id,text,accepted,evidence FROM criteria WHERE group_id=? ORDER BY position', groupId).map(c => ({ ...c, accepted: !!c.accepted })),
      members: this.members(groupId, owner),
      messages: this.query('SELECT id,role,agent_role,agent_id,agent_name,content,kind,turn,created_at FROM messages WHERE group_id=? ORDER BY rowid', groupId),
      runs: this.query('SELECT id,status,agent_role,agent_id,kind,turn,error,attempts,started_at,finished_at FROM runs WHERE group_id=? ORDER BY rowid', groupId),
      artifacts: this.query('SELECT id,title,content,agent_role,created_at FROM artifacts WHERE group_id=? ORDER BY rowid', groupId),
    };
  }
  create(owner, body) {
    object(body);
    const title = text(body.title, 'Title', LIMITS.title);
    const goal = text(body.goal, 'Goal', LIMITS.goal);
    assert(Array.isArray(body.criteria) && body.criteria.length >= 1 && body.criteria.length <= LIMITS.criteria, 400, 'invalid_input', `Provide 1–${LIMITS.criteria} acceptance criteria`);
    const criteria = [...new Set(body.criteria.map(value => text(value, 'Criterion', LIMITS.criterion)))];
    this.registry.defaults(owner);
    let candidates = body.initialAgentIds;
    if (candidates === undefined) {
      const providerId = body.provider || 'demo';
      const connection = this.registry.connections(owner).find(c => c.provider === providerId);
      assert(connection, 400, 'provider_unavailable', 'Choose a configured connection or agents');
      candidates = this.registry.agents(owner).filter(a => a.connectionId === connection.id).map(a => a.id);
    }
    assert(Array.isArray(candidates) && candidates.length >= 1 && candidates.length <= 12 && candidates.every(v => typeof v === 'string'), 400, 'invalid_input', 'Select 1–12 agent profiles');
    candidates = [...new Set(candidates)];
    const selected = candidates.map(agentId => this.registry.rawAgent(owner, agentId));
    const maxAgents = integer(body.maxAgents, 'maxAgents', 1, 12, Math.max(4, candidates.length));
    assert(candidates.length <= maxAgents, 400, 'agent_limit', 'Selected agents exceed maxAgents');
    const connection = this.registry.rawConnection(owner, selected[0].connectionId);
    for (const a of selected) assert(this.registry.safeConnection(this.registry.rawConnection(owner, a.connectionId)).configured, 400, 'provider_unavailable', 'Every selected agent needs a configured model connection');
    const selectedConnections = selected.map(a => this.registry.rawConnection(owner, a.connectionId));
    assert(selectedConnections.every(c => c.provider === 'demo') || selectedConnections.every(c => c.provider !== 'demo'), 400, 'mixed_demo_live', 'Sample-mode and live-model agents cannot share a group. Create a separate live group.');
    const provider = { id: connection.provider };
    const model = connection.model;
    const maxTurns = integer(body.maxTurns, 'maxTurns', 4, LIMITS.maxTurns, 16);
    const maxTokens = integer(body.maxTokens, 'maxTokens', 2048, LIMITS.maxTokens, 100000);
    const groupId = id();
    this.transaction(() => {
      assert(this.one('SELECT COUNT(*) AS count FROM groups WHERE owner=?', owner).count < LIMITS.maxGroups, 400, 'group_limit', 'Group limit reached');
      this.run('INSERT INTO groups(id,owner,title,goal,provider,model,candidate_agent_ids,max_agents,max_turns,max_tokens,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', groupId, owner, title, goal, provider.id, model, JSON.stringify(candidates), maxAgents, maxTurns, maxTokens, now(), now());
      criteria.forEach((criterion, position) => this.run('INSERT INTO criteria(id,group_id,text,position) VALUES(?,?,?,?)', id(), groupId, criterion, position));
      this.message(groupId, 'system', provider.id === 'demo' ? 'Deterministic demo workspace. Scripted agents demonstrate the workflow; no model inference, browsing, or external execution occurs.' : 'Agents collaborate using the selected model through distinct role prompts. They can draft text and propose evidence; they cannot browse, execute code, or verify external outcomes.', 'created');
    });
    return this.detail(groupId, owner);
  }
  interruptRuns(groupId, reason) { this.run("UPDATE runs SET status='interrupted',error=?,finished_at=? WHERE group_id=? AND status='running'", reason, now(), groupId); }
  control(groupId, owner, body) {
    object(body);
    this.transaction(() => {
      const g = this.owned(groupId, owner); this.requireVersion(g, body.expectedVersion);
      assert(body.action !== 'restore' || g.archived, 409, 'not_archived', 'This group is not archived');
      assert(!g.archived || body.action === 'restore', 409, 'archived', 'Archived groups are read-only');
      const transitions = { start: ['draft'], pause: ['running'], resume: ['paused', 'review'], cancel: ['draft', 'running', 'paused', 'review', 'error', 'budget_exhausted'], retry: ['error'], accept: ['review'], restore: ['draft', 'paused', 'review', 'completed', 'cancelled', 'error', 'budget_exhausted'], archive: ['draft', 'paused', 'review', 'completed', 'cancelled', 'error', 'budget_exhausted'] };
      assert(transitions[body.action]?.includes(g.status), 409, 'invalid_transition', `Cannot ${String(body.action).slice(0, 30)} a ${g.status} group`);
      if (['start', 'resume', 'retry'].includes(body.action)) {
        assert(g.turnsUsed < g.maxTurns && g.tokensUsed < g.maxTokens && g.attemptsUsed < g.maxTurns * 3, 409, 'budget_exhausted', 'Budget is exhausted. Create a new group with a revised scope.');
        for (const agentId of JSON.parse(g.candidateAgentIds)) { const a = this.registry.rawAgent(owner, agentId); assert(this.registry.safeConnection(this.registry.rawConnection(owner, a.connectionId)).configured, 409, 'provider_unavailable', 'A selected model connection is no longer configured'); }
        this.run("UPDATE groups SET status='running',last_error=NULL WHERE id=?", groupId);
        this.run('UPDATE criteria SET accepted=0 WHERE group_id=?', groupId);
        if (!this.one('SELECT id FROM members WHERE group_id=?', groupId)) this.join(groupId, this.firstAgent(g, owner), 'Assigned to coordinate the goal and invite specialists');
      } else if (body.action === 'accept') {
        assert(this.one('SELECT COUNT(*) AS count FROM criteria WHERE group_id=? AND accepted=0', groupId).count === 0, 409, 'criteria_not_accepted', 'Human acceptance of every criterion is required');
        assert(this.one('SELECT id FROM artifacts WHERE group_id=?', groupId), 409, 'artifact_required', 'An artifact must be available for review');
        this.run("UPDATE groups SET status='completed' WHERE id=?", groupId);
      } else if (body.action === 'restore') this.run('UPDATE groups SET archived=0 WHERE id=?', groupId);
      else if (body.action === 'archive') this.run('UPDATE groups SET archived=1 WHERE id=?', groupId);
      else this.run('UPDATE groups SET status=? WHERE id=?', body.action === 'pause' ? 'paused' : 'cancelled', groupId);
      this.interruptRuns(groupId, `Human action: ${body.action}`);
      this.bump(groupId, ', epoch=epoch+1');
      const descriptions = { start: 'Goal started. Selected candidates will assess whether they can contribute and join the group.', pause: 'Paused by the human. In-flight responses will be discarded.', resume: 'The human asked the group to continue working.', cancel: 'Cancelled by the human.', retry: 'The human requested another attempt with the remaining budget.', accept: 'The human accepted every criterion and marked this goal complete.', archive: 'Archived by the human.', restore: 'Restored by the human.' };
      this.message(groupId, 'system', descriptions[body.action], body.action);
    });
    return this.detail(groupId, owner);
  }
  setCriterion(groupId, owner, criterionId, body) {
    object(body); assert(typeof body.accepted === 'boolean', 400, 'invalid_input', 'accepted must be a boolean');
    this.transaction(() => {
      const g = this.owned(groupId, owner); this.requireVersion(g, body.expectedVersion);
      assert(!g.archived && g.status === 'review', 409, 'review_required', 'Criteria can be accepted only during human review');
      assert(this.one('SELECT id FROM criteria WHERE id=? AND group_id=?', criterionId, groupId), 404, 'not_found', 'Criterion not found');
      this.run('UPDATE criteria SET accepted=? WHERE id=? AND group_id=?', body.accepted ? 1 : 0, criterionId, groupId); this.bump(groupId);
    });
    return this.detail(groupId, owner);
  }
  addHumanMessage(groupId, owner, body) {
    object(body); const content = text(body.content, 'Message', LIMITS.message);
    this.transaction(() => {
      const g = this.owned(groupId, owner); this.requireVersion(g, body.expectedVersion);
      assert(!g.archived && !['completed', 'cancelled'].includes(g.status), 409, 'read_only', 'This group is read-only');
      assert(this.one('SELECT COUNT(*) AS count FROM messages WHERE group_id=?', groupId).count < LIMITS.maxMessages, 400, 'message_limit', 'Message limit reached');
      this.message(groupId, 'human', content);
      this.run('UPDATE criteria SET accepted=0 WHERE group_id=?', groupId);
      this.interruptRuns(groupId, 'New human message superseded in-flight context'); this.bump(groupId, ', epoch=epoch+1');
    });
    return this.detail(groupId, owner);
  }
  firstAgent(g, owner) {
    const agents = JSON.parse(g.candidateAgentIds).map(agentId => this.registry.rawAgent(owner, agentId));
    return (agents.find(a => a.role === 'coordinator') || agents[0]).id;
  }
  members(groupId, owner) {
    return this.query('SELECT id,role,name,agent_id,reason,joined_at FROM members WHERE group_id=? ORDER BY joined_at,rowid', groupId).map(member => {
      const a = this.registry.rawAgent(owner, member.agentId); const c = this.registry.rawConnection(owner, a.connectionId);
      return { ...member, name: a.name, role: a.role, instructions: a.instructions, connectionId: c.id, model: c.model, provider: c.provider, reasoningEffort: a.reasoningEffort, color: a.color };
    });
  }
  addMember(groupId, owner, body) {
    object(body);
    this.transaction(() => {
      const g = this.owned(groupId, owner); this.requireVersion(g, body.expectedVersion);
      assert(!g.archived && !['completed', 'cancelled'].includes(g.status), 409, 'read_only', 'This group is read-only');
      const a = this.registry.rawAgent(owner, body.agentId);
      assert((g.provider === 'demo') === (this.registry.rawConnection(owner, a.connectionId).provider === 'demo'), 400, 'mixed_demo_live', 'Sample-mode and live-model agents cannot share a group');
      assert(this.registry.safeConnection(this.registry.rawConnection(owner, a.connectionId)).configured, 400, 'provider_unavailable', 'Configure this agent’s model connection first');
      const candidates = JSON.parse(g.candidateAgentIds);
      if (!candidates.includes(a.id)) { assert(candidates.length < g.maxAgents, 400, 'agent_limit', 'Group membership cap reached'); candidates.push(a.id); this.run('UPDATE groups SET candidate_agent_ids=? WHERE id=?', JSON.stringify(candidates), groupId); }
      this.join(groupId, a.id, 'Invited by the human'); this.run('UPDATE criteria SET accepted=0 WHERE group_id=?', groupId); this.interruptRuns(groupId, 'Group membership changed'); this.bump(groupId, ', epoch=epoch+1');
    }); return this.detail(groupId, owner);
  }
  join(groupId, agentId, reason) {
    const g = this.one('SELECT * FROM groups WHERE id=?', groupId);
    if (!JSON.parse(g.candidateAgentIds).includes(agentId)) return;
    const a = this.registry.rawAgent(g.owner, agentId);
    if (this.one('SELECT COUNT(*) AS count FROM members WHERE group_id=?', groupId).count >= g.maxAgents) return;
    const result = this.run('INSERT OR IGNORE INTO members(id,group_id,role,name,agent_id,reason,joined_at) VALUES(?,?,?,?,?,?,?)', id(), groupId, a.role, a.name, a.id, reason.slice(0, 300), now());
    if (result.changes) this.message(groupId, 'system', `${a.name} joined as ${a.role}. ${reason.slice(0, 300)}`, 'joined', a.role);
  }
  runnable() { return this.query("SELECT * FROM groups WHERE status='running' AND archived=0 ORDER BY updated_at"); }
  recover() {
    return this.transaction(() => {
      const groups = this.query("SELECT * FROM groups WHERE status='running'");
      for (const g of groups) {
        this.interruptRuns(g.id, 'Server restarted before this response committed');
        this.bump(g.id, ', epoch=epoch+1');
        this.message(g.id, 'system', 'Server resumed this group after a restart. Uncommitted responses were discarded; previous messages remain intact.', 'recovered');
      }
      return groups.length;
    });
  }
  claim(groupId, agent, reservation, kind = 'work') {
    return this.transaction(() => {
      const g = this.one('SELECT * FROM groups WHERE id=?', groupId);
      if (!g || g.status !== 'running' || g.archived || this.one("SELECT id FROM runs WHERE group_id=? AND status='running'", groupId)) return null;
      if (g.turnsUsed >= g.maxTurns || g.tokensUsed + reservation > g.maxTokens || g.attemptsUsed >= g.maxTurns * 3) { this.exhaust(groupId); return null; }
      const runId = id();
      this.run("INSERT INTO runs(id,group_id,epoch,status,agent_role,agent_id,kind,turn,started_at) VALUES(?,?,?,'running',?,?,?,?,?)", runId, groupId, g.epoch, agent.role, agent.agentId, kind, g.turnsUsed + 1, now());
      this.run('UPDATE groups SET tokens_used=tokens_used+?,attempts_used=attempts_used+1 WHERE id=?', reservation, groupId); this.bump(groupId);
      return this.one('SELECT * FROM runs WHERE id=?', runId);
    });
  }
  current(run) { return !!this.one("SELECT r.id FROM runs r JOIN groups g ON g.id=r.group_id WHERE r.id=? AND r.status='running' AND g.status='running' AND g.epoch=r.epoch AND g.archived=0", run.id); }
  reserveRetry(run, reservation) {
    return this.transaction(() => {
      if (!this.current(run)) return false;
      const g = this.one('SELECT * FROM groups WHERE id=?', run.groupId);
      if (g.tokensUsed + reservation > g.maxTokens || g.attemptsUsed >= g.maxTurns * 3) { this.exhaust(g.id); return false; }
      this.run('UPDATE groups SET tokens_used=tokens_used+?,attempts_used=attempts_used+1 WHERE id=?', reservation, g.id);
      this.run('UPDATE runs SET attempts=attempts+1 WHERE id=?', run.id); this.bump(g.id); return true;
    });
  }
  exhaust(groupId) { this.run("UPDATE groups SET status='budget_exhausted',epoch=epoch+1,last_error='A hard turn, attempt, or conservative token budget was reached.' WHERE id=?", groupId); this.interruptRuns(groupId, 'Budget exhausted'); this.bump(groupId); this.message(groupId, 'system', 'Hard budget reached. Review the existing work or create a new group with a narrower goal or larger budget.', 'budget'); }
  commit(run, result) {
    return this.transaction(() => {
      if (!this.current(run)) return false;
      this.message(run.groupId, 'agent', result.content, run.kind === 'nomination' ? 'nomination' : result.review ? 'review' : 'message', run.agentRole, run.turn);
      this.run('UPDATE messages SET agent_id=?,agent_name=? WHERE group_id=? AND role=\'agent\' AND turn=?', run.agentId, this.registry.rawAgent(this.one('SELECT owner FROM groups WHERE id=?', run.groupId).owner, run.agentId).name, run.groupId, run.turn);
      if (run.kind === 'nomination' && result.join) this.join(run.groupId, run.agentId, 'Self-nominated after evaluating the goal against its instructions');
      if (run.kind === 'work' && result.artifact) this.run('INSERT INTO artifacts(id,group_id,run_id,title,content,agent_role,created_at) VALUES(?,?,?,?,?,?,?)', id(), run.groupId, run.id, result.artifact.title, result.artifact.content, run.agentRole, now());
      for (const evidence of result.evidence) this.run('UPDATE criteria SET evidence=? WHERE id=? AND group_id=?', evidence.summary, evidence.criterionId, run.groupId);
      this.run("UPDATE runs SET status='succeeded',finished_at=? WHERE id=?", now(), run.id);
      this.run('UPDATE groups SET turns_used=turns_used+1,last_error=NULL WHERE id=?', run.groupId);
      // The model can request human review, never set accepted or completed.
      const hasArtifact = this.one('SELECT id FROM artifacts WHERE group_id=?', run.groupId);
      if (run.kind === 'work' && result.review && hasArtifact) { this.run("UPDATE groups SET status='review' WHERE id=?", run.groupId); this.message(run.groupId, 'system', 'The group proposed its work for human review. Check the artifact and explicitly accept each criterion before marking the goal complete.', 'review'); }
      else {
        const g = this.one('SELECT * FROM groups WHERE id=?', run.groupId);
        if (g.turnsUsed >= g.maxTurns || g.tokensUsed >= g.maxTokens) this.exhaust(g.id);
      }
      this.bump(run.groupId); return true;
    });
  }
  fail(run, safeMessage) {
    return this.transaction(() => {
      if (!this.current(run)) return false;
      this.run("UPDATE runs SET status='failed',error=?,finished_at=? WHERE id=?", safeMessage, now(), run.id);
      this.run("UPDATE groups SET status='error',last_error=? WHERE id=?", safeMessage, run.groupId); this.bump(run.groupId);
      this.message(run.groupId, 'system', safeMessage, 'error'); return true;
    });
  }
  makeSession(token) {
    const hash = createHash('sha256').update(token).digest('hex');
    const tag = createHash('sha256').update(this.config.accessSecret).digest('hex');
    this.run('DELETE FROM sessions WHERE expires<?', Date.now());
    this.run('INSERT INTO sessions(hash,owner,secret_tag,expires) VALUES(?,?,?,?)', hash, 'operator', tag, Date.now() + 30 * 86400000);
  }
  sessionOwner(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const hash = createHash('sha256').update(token).digest('hex'); const tag = createHash('sha256').update(this.config.accessSecret).digest('hex');
    return this.one('SELECT owner FROM sessions WHERE hash=? AND secret_tag=? AND expires>?', hash, tag, Date.now())?.owner || null;
  }
}
