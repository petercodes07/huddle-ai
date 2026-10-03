import { setTimeout as delay } from 'node:timers/promises';
import { makeRequest, callProvider, ProviderError } from './providers.js';

export class Engine {
  constructor(store, config, { provider = callProvider } = {}) { this.store = store; this.config = config; this.provider = provider; this.active = new Map(); this.closed = false; }
  start() { this.store.recover(); this.timer = setInterval(() => this.tick(), this.config.tickMs); this.timer.unref(); this.tick(); }
  interrupt(groupId) { this.active.get(groupId)?.controller.abort(); }
  async stop() { this.closed = true; clearInterval(this.timer); for (const job of this.active.values()) job.controller.abort(); await Promise.all([...this.active.values()].map(job => job.promise)); }
  tick() {
    if (this.closed) return;
    for (const group of this.store.runnable()) {
      if (this.active.size >= 3) break; // Bound provider concurrency across groups.
      if (this.active.has(group.id)) continue;
      const controller = new AbortController();
      const promise = this.work(group, controller.signal).catch(() => { /* Errors are recorded with safe messages by work(). */ }).finally(() => this.active.delete(group.id));
      this.active.set(group.id, { controller, promise });
    }
  }
  select(group, raw) {
    const nominations = this.store.query("SELECT agent_id FROM runs WHERE group_id=? AND kind='nomination' AND status='succeeded'", group.id).map(r => r.agentId);
    const pendingId = group.candidateAgentIds.find(agentId => !group.members.some(m => m.agentId === agentId) && !nominations.includes(agentId));
    if (pendingId) {
      const agent = this.store.registry.rawAgent(raw.owner, pendingId);
      return { agent: { ...agent, agentId: agent.id }, kind: 'nomination' };
    }
    const workTurns = this.store.one("SELECT COUNT(*) AS count FROM runs WHERE group_id=? AND kind='work' AND status='succeeded'", group.id).count;
    return { agent: group.members[workTurns % group.members.length], kind: 'work' };
  }
  async work(raw, signal) {
    let run;
    try {
      const group = this.store.detail(raw.id, raw.owner);
      const { agent, kind } = this.select(group, raw);
      if (!agent) throw new ProviderError('no_agents', 'No active agent is available for this group');
      const connection = this.store.registry.rawConnection(raw.owner, agent.connectionId);
      const request = makeRequest(group, agent, kind);
      const reservation = connection.provider === 'demo' ? 100 : request.reservation;
      run = this.store.claim(raw.id, agent, reservation, kind);
      if (!run) return;
      if (!this.store.registry.safeConnection(connection).configured) throw new ProviderError('connection_disabled', 'This model connection is disabled or no longer allowed by server policy.');
      this.store.registry.validateEndpoint(connection.provider, connection.baseUrl);
      const apiKey = this.store.registry.keyFor(connection);
      if (connection.provider === 'nvidia' && !apiKey) throw new ProviderError('missing_key', 'Configure a NVIDIA credential for this model connection first');
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        try {
          const result = await this.provider({ connection, apiKey, agent, group, kind, request, config: this.config, signal });
          if (!signal.aborted) this.store.commit(run, result);
          return;
        } catch (error) {
          if (signal.aborted || !this.store.current(run)) return;
          if (!(error instanceof ProviderError) || !error.retryable || attempt >= this.config.maxRetries) throw error;
          await delay(Math.max(error.retryAfterMs || 0, Math.min(this.config.retryBaseMs * (2 ** attempt), 30000)), undefined, { signal });
          if (!this.store.reserveRetry(run, reservation)) return;
        }
      }
    } catch (error) {
      if (signal.aborted || !run) return;
      const safe = error instanceof ProviderError ? error.message : 'The turn failed safely. Check the configured model and retry with the remaining budget.';
      this.store.fail(run, safe);
    }
  }
}
