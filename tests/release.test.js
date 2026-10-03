import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { createHttpServer } from '../server/http.js';

test('release HTTP flow serves real UI and completes an explicitly labelled sample through APIs', async () => {
  const config = { ...loadConfig({}), publicPath: resolve('public'), tickMs: 5, demoDelayMs: 1 };
  const store = new Store(':memory:', config);
  const engine = new Engine(store, config);
  const server = createHttpServer(store, engine, config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: {cookie, origin, 'content-type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };
  try {
    for (const path of ['/', '/app.js', '/ui.js', '/styles.css', '/favicon.svg']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.ok((await response.text()).length > 100, path);
    }
    assert.equal((await fetch(origin + '/.env')).status, 404);
    const settings = await api('/config');
    assert.equal(settings.authenticated, true);
    const connection = settings.connections.find(c => c.provider === 'demo');
    const {agent} = await api('/agents', 'POST', {name:'Release reviewer',role:'critic',instructions:'Check the provided result against each criterion.',connectionId:connection.id});
    let {group} = await api('/groups','POST',{title:'Release smoke test',goal:'Create a review worksheet for a small team launch.',criteria:['Include a plan','State limitations'],initialAgentIds:[...settings.agents.filter(a=>a.connectionId===connection.id).map(a=>a.id),agent.id],maxTurns:20});
    const id = group.id;
    ({group} = await api(`/groups/${id}/actions`,'POST',{action:'start',expectedVersion:group.version}));
    engine.start();
    const deadline = Date.now()+5000;
    while (group.status === 'running' && Date.now() < deadline) { await new Promise(r=>setTimeout(r,15)); ({group}=await api(`/groups/${id}`)); }
    assert.equal(group.status,'review');
    assert.ok(group.messages.some(m=>m.content.includes('Scripted demo')));
    assert.equal(group.members.length,5);
    assert.equal(group.artifacts.length,1);
    assert.ok(group.artifacts[0].content.includes('deterministic demo'));
    for (const c of group.criteria) ({group}=await api(`/groups/${id}/criteria/${c.id}`,'POST',{accepted:true,expectedVersion:group.version}));
    ({group}=await api(`/groups/${id}/actions`,'POST',{action:'accept',expectedVersion:group.version}));
    assert.equal(group.status,'completed');
    ({group}=await api(`/groups/${id}/actions`,'POST',{action:'archive',expectedVersion:group.version}));
    assert.equal(group.archived,true);
    assert.equal((await api('/groups')).groups.length,0);
    assert.equal((await api('/groups?archived=true')).groups.length,1);
    ({group}=await api(`/groups/${id}/actions`,'POST',{action:'restore',expectedVersion:group.version}));
    assert.equal(group.status,'completed');
    assert.equal((await api('/groups')).groups.length,1);
  } finally { await engine.stop(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); store.close(); }
});
