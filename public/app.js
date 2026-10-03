import { escapeHtml as e, initials, colorIndex, avatar, statusLabel, relativeTime, clockTime, parseCriteria, markdown, groupExport } from './ui.js';
const $ = id => document.getElementById(id);
const state = {config:null,connections:[],agents:[],groups:[],group:null,selected:null,archived:false,search:'',polling:false,busy:false,registryTab:'models',registryEditor:null,renderedVersion:null,lastMessageCount:0,dialogOpener:null};
let pollTimer, toastTimer;
const ROLE_NAMES = {coordinator:'Coordinator',researcher:'Researcher',builder:'Builder',critic:'Reviewer'};
const templates = {
  launch: {name:'The next product launch',task:'Develop a practical launch plan for a new productivity app for small creative teams. Assume a four-week timeline, a small team, and a limited marketing budget. Compare channels and focus on an achievable first release.',criteria:'Define the target audience and positioning\nCreate a four-week launch timeline with owners\nCompare at least three marketing channels\nRecommend success metrics and identify key risks'},
  decision: {name:'A decision worth exploring',task:'Help me make a thoughtful decision. Compare three ways a small remote team could organize its weekly planning: one team meeting, asynchronous written updates, or a hybrid approach. Explain the trade-offs and recommend a practical experiment.',criteria:'Compare all three approaches fairly\nSurface assumptions and potential drawbacks\nMake a clear recommendation\nOutline a two-week experiment and success measures'}
};
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {credentials:'same-origin',headers:{'Content-Type':'application/json'},...options,body:options.body === undefined ? undefined : JSON.stringify(options.body)});
  let data; try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
  if (!response.ok) { const error = new Error(data.error?.message || data.message || 'Something went wrong.'); error.status = response.status; error.code = data.error?.code; throw error; }
  return data;
}
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function closeMenu() { $('group-menu').hidden = true; $('group-menu-button').setAttribute('aria-expanded','false'); }
function showDialog(id) { state.dialogOpener = document.activeElement; closeMenu(); $(id).showModal(); }
function closeDialog(dialog) { dialog.close(); state.dialogOpener?.focus?.(); }
function sidebar(open) { $('app').classList.toggle('sidebar-open',open); $('sidebar-backdrop').hidden = !open; if(open) $('group-search').focus(); }
function setDetails(open) { $('group-workspace').classList.toggle('mobile-details',open); $('group-workspace').classList.toggle('details-open',open); $('chat-tab').classList.toggle('active',!open); $('details-tab').classList.toggle('active',open); $('chat-tab').setAttribute('aria-selected',String(!open)); $('details-tab').setAttribute('aria-selected',String(open)); }
function setConnected(connected, message='') { $('connection-banner').hidden = connected; $('connection-banner').textContent = message || 'Connection interrupted. Reconnecting automatically; your group is saved on the server.'; }
function providerLabel(provider) { return ({demo:'Sample mode',nvidia:'NVIDIA Build',ollama:'Ollama',compatible:'Open-model endpoint'})[provider] || provider; }
function groupProviders(group=state.group) {
  const providers=new Set((group?.members||[]).map(member=>member.provider).filter(Boolean));
  for(const id of group?.candidateAgentIds||[]) {const agent=state.agents.find(agent=>agent.id===id);const connection=state.connections.find(connection=>connection.id===agent?.connectionId);if(connection)providers.add(connection.provider);}
  if(!providers.size&&group?.provider)providers.add(group.provider);return providers;
}
function isDemo(group=state.group) {const providers=groupProviders(group);return providers.size===1&&providers.has('demo');}
function modeText(group=state.group) {const providers=groupProviders(group);return isDemo(group)?'SAMPLE':providers.has('demo')?'MIXED MODELS':'LIVE MODELS';}
function renderProvider() {
  const available = state.connections.filter(connection => connection.provider !== 'demo' && connection.configured);
  const live = available.length > 0;
  $('provider-summary').innerHTML = `<span class="provider-led ${live?'live':''}"></span><span><strong>${live ? `${available.length} model connection${available.length===1?'':'s'}` : 'Sample workspace'}</strong><small>${live ? 'Models & agent settings' : 'Connect a model to go live'}</small></span><span class="chevron">›</span>`;
}
function renderGroups() {
  const filtered = state.groups.filter(group => `${group.title} ${group.goal || ''}`.toLowerCase().includes(state.search.toLowerCase()));
  $('group-count').textContent = state.groups.length;
  $('group-list').innerHTML = filtered.length ? filtered.map(group => `<button class="group-item ${state.selected === group.id ? 'active' : ''}" data-group-id="${e(group.id)}" ${state.selected===group.id?'aria-current="true"':''}><span class="group-symbol" aria-hidden="true">#</span><span class="group-item-copy"><span class="group-item-title"><span>${e(group.title)}</span></span><span class="group-item-description">${e(group.lastMessage || group.goal || 'A new conversation')}</span><span class="group-item-meta"><span class="group-dot ${e(group.status)}"></span>${e(statusLabel(group.status))}<span class="group-updated">${e(relativeTime(group.updatedAt))}</span></span></span></button>`).join('') : `<p class="sidebar-empty">${state.search?'No groups match your search.':state.archived?'No archived groups. Archived work can always be restored.':'Your next collaboration starts here. Create a group to get going.'}</p>`;
}
async function loadGroups() { const data = await api(`/groups${state.archived?'?archived=true':''}`); state.groups = data.groups || []; renderGroups(); }
async function selectGroup(id, {mobileClose=true}={}) {
  state.selected=id; state.renderedVersion=null; state.lastMessageCount=0; closeMenu();
  renderGroups(); if(mobileClose) sidebar(false); setDetails(false);
  history.replaceState(null,'',`#group/${encodeURIComponent(id)}`);
  $('boot-loading').hidden=false; $('empty-state').hidden=true; $('group-workspace').hidden=true;
  try { const data = await api(`/groups/${encodeURIComponent(id)}`); if(state.selected!==id)return; state.group=data.group; renderGroup(true); setConnected(true); }
  catch(error) { if(state.selected!==id)return; toast(error.message); state.group=null; state.selected=null; renderEmpty(); }
  finally { $('boot-loading').hidden=true; }
}
function renderEmpty() { $('boot-loading').hidden=true; $('group-workspace').hidden=true; $('empty-state').hidden=false; }
function renderGroup(force=false) {
  const group = state.group; if(!group)return renderEmpty();
  if(!force && state.renderedVersion === group.version)return;
  const previousScroll = $('conversation').scrollTop;
  const nearBottom = $('conversation').scrollHeight - $('conversation').clientHeight - previousScroll < 120;
  const wasInitial = state.renderedVersion===null;
  $('empty-state').hidden=true; $('boot-loading').hidden=true; $('group-workspace').hidden=false;
  $('group-title').textContent=group.title;
  $('group-subtitle').textContent=`${(group.members||[]).length} AI collaborator${group.members?.length===1?'':'s'} + you · One shared goal`;
  $('group-mode').textContent=modeText(group); $('group-mode').className=`mode-label ${isDemo(group)?'':'live'}`;
  $('avatar-stack').innerHTML=(group.members||[]).slice(0,5).map(member=>avatar(member.name,member.id)).join('')+avatar('You','you','human-avatar');
  $('mobile-team-count').textContent=(group.members?.length||0)+1;
  $('archive-group').textContent=group.archived?'Restore group':'Archive group';
  renderRunStrip(); renderMessages(); renderDetails(); renderComposer();
  state.renderedVersion=group.version;
  if(wasInitial || nearBottom) { requestAnimationFrame(()=>{$('conversation').scrollTop=$('conversation').scrollHeight;}); $('new-messages').hidden=true; }
  else { $('conversation').scrollTop=previousScroll; if(group.messages?.length>state.lastMessageCount) $('new-messages').hidden=false; }
  state.lastMessageCount=group.messages?.length||0;
}
function renderRunStrip() {
  const g=state.group; const status=g.status; const controls=[];
  if(status==='draft') controls.push(['start','Start group','accent']);
  if(status==='running') controls.push(['pause','Ⅱ Pause',''],['cancel','Stop','danger']);
  if(status==='paused') controls.push(['resume','▶ Resume','accent'],['cancel','Stop','danger']);
  if(status==='review') controls.push(['resume','Continue','accent']);
  if(status==='error') controls.push(['retry','Retry','accent']);
  const run=g.runs?.findLast(run=>run.status==='running');
  let copy=status==='running' ? (run ? `${memberName(run.agentId,run.agentRole)} is contributing` : 'Collaborators are working on your brief') : ({draft:'Your team is ready when you are',paused:'Work is saved. Resume whenever you’re ready.',review:'Review the deliverable and check your criteria',completed:'You accepted the result. Nice teamwork.',cancelled:'This run was stopped. Your conversation is saved.',error:'The provider needs attention',budget_exhausted:'The group reached its safety limit'})[status] || '';
  if(isDemo(g)) copy=status==='running'?'Playing a canned sample · no model calls':copy;
  $('run-strip').innerHTML=`<span class="status-pill ${e(status)}"><span class="status-dot"></span>${e(statusLabel(status))}</span><span class="run-copy">${e(copy)}</span><div class="run-controls">${controls.map(([action,label,cls])=>`<button class="subtle-button ${cls}" data-group-action="${action}" ${state.busy?'disabled':''}>${label}</button>`).join('')}</div>`;
}
function memberName(agentId,role) { return state.group?.members?.find(m=>(agentId && (m.agentId===agentId || m.id===agentId)) || (!agentId && m.role===role))?.name || ROLE_NAMES[role] || role || 'A collaborator'; }
function renderMessages() {
  const g=state.group; const messages=g.messages||[];
  const date=new Date(g.createdAt); const day=Number.isFinite(date.getTime()) ? date.toLocaleDateString([],{month:'long',day:'numeric'}) : 'Conversation';
  let output=`<div class="day-divider">${e(day.toUpperCase())}</div>`;
  if(!messages.some(message=>message.role==='human' && message.content===g.goal)) output+=`<article class="message human">${avatar('You','you','human-avatar')}<div class="message-main"><div class="message-meta"><span class="message-name">You</span><span class="role-label">THE BRIEF</span></div><div class="message-content">${markdown(g.goal)}</div></div></article>`;
  for(const message of messages) {
    if(message.role==='system') { output+=`<div class="message system"><span class="system-icon" aria-hidden="true">✦</span><span class="system-content">${e(message.content)}</span><span class="system-line"></span></div>`; continue; }
    const human=message.role==='human'; const name=human?'You':message.agentName||memberName(message.agentId,message.agentRole);
    const artifact=message.kind==='artifact'||message.kind==='deliverable';
    output+=`<article class="message ${human?'human':''} ${artifact?'artifact-message':''}">${avatar(name,human?'you':message.agentId||message.agentRole,human?'human-avatar':'')}<div class="message-main"><div class="message-meta"><span class="message-name">${e(name)}</span><span class="role-label">${human?'YOU':e(ROLE_NAMES[message.agentRole]||message.agentRole||'COLLABORATOR')}</span><time class="message-time" datetime="${e(message.createdAt)}">${e(clockTime(message.createdAt))}</time></div><div class="message-content">${artifact?'<div class="artifact-heading">✧ PROPOSED DELIVERABLE</div>':''}${markdown(message.content)}</div></div></article>`;
  }
  // Some providers return an artifact separately, rather than as a chat message.
  const lastArtifact=g.artifacts?.at(-1);
  if(lastArtifact && !messages.some(message=>message.content===lastArtifact.content || message.kind==='artifact'||message.kind==='deliverable')) {
    output+=`<article class="message artifact-message">${avatar('Deliverable','artifact')}<div class="message-main"><div class="message-meta"><span class="message-name">${e(lastArtifact.title||'Proposed deliverable')}</span></div><div class="message-content"><div class="artifact-heading">✧ PROPOSED DELIVERABLE</div>${markdown(lastArtifact.content)}</div></div></article>`;
  }
  if(g.lastError) output+=`<div class="message-error"><strong>Work is saved, but this run needs attention.</strong><br>${e(typeof g.lastError==='object'?g.lastError.message||JSON.stringify(g.lastError):g.lastError)}</div>`;
  $('messages').innerHTML=output;
  $('thinking-indicator').hidden=g.status!=='running';
  $('thinking-indicator').innerHTML=`<span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>${isDemo(g)?'Playing sample conversation':'The group is thinking'}…`;
}
function renderDetails() {
  const g=state.group; const criteria=g.criteria||[]; const accepted=criteria.filter(item=>item.accepted).length; const members=g.members||[];
  const artifact=g.artifacts?.at(-1); const complete=g.status==='completed'; const progress=Math.min(100,((g.turnsUsed||0)/(g.maxTurns||16))*100);
  const canAccept=g.status==='review'&&criteria.length&&accepted===criteria.length&&artifact;
  const usedAgents=new Set(members.map(m=>m.agentId)); const availableAgents=state.agents.filter(a=>{const connection=state.connections.find(c=>c.id===a.connectionId);return !usedAgents.has(a.id) && connection?.configured && (isDemo(g)?connection.provider==='demo':connection.provider!=='demo');});
  $('details-panel').innerHTML=`<section class="detail-section"><div class="section-header"><h3 class="section-label">THE SHARED GOAL</h3><span aria-hidden="true">⌁</span></div><div class="goal-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".7"/></svg></div><p class="goal-text">${e(g.goal)}</p><p class="goal-hint">Every perspective moves toward the same outcome.</p></section>
  <section class="detail-section"><div class="section-header"><h3 class="section-label">DEFINITION OF DONE</h3><span class="progress-count">${accepted}/${criteria.length}</span></div><div class="criteria-list">${criteria.map(item=>`<label class="criterion ${item.accepted?'accepted':''} ${item.evidence?'evidenced':''}"><input type="checkbox" data-criterion="${e(item.id)}" ${item.accepted?'checked':''} ${g.status!=='review'||g.archived||state.busy?'disabled':''}><span>${e(item.text)}${item.evidence?`<small class="criterion-evidence">Evidence: ${e(typeof item.evidence==='string'?item.evidence:JSON.stringify(item.evidence))}</small>`:''}</span></label>`).join('')}</div><p class="criteria-help">${complete?'Reviewed and accepted by you.':g.status==='review'?'Only you can check these off. Verify each criterion against the proposed work.':'You can check these off when a deliverable is ready for your review.'}</p></section>
  <section class="detail-section"><div class="section-header"><h3 class="section-label">IN THIS GROUP</h3><span class="count" style="background:#eeedf5;color:#a1a0b3">${members.length+1}</span></div><div class="member-list"><div class="member">${avatar('You','you','human-avatar')}<div class="member-copy"><div class="member-name">You <span class="you-tag">GROUP OWNER</span></div><div class="member-description">Set the direction. Make the final call.</div></div><span class="member-dot"></span></div>${members.map(member=>`<div class="member">${avatar(member.name,member.id)}<div class="member-copy"><div class="member-name">${e(member.name)}</div><div class="member-description" title="${e(member.model||member.reason||member.role)}">${e(ROLE_NAMES[member.role]||member.role||'Collaborator')}${member.model?` · ${e(member.model)}`:''}</div></div><span class="member-dot"></span></div>`).join('')}</div>${!complete && !g.archived && g.status!=='cancelled' && availableAgents.length && members.length<(g.maxAgents||12)?`<label class="field" style="margin:15px 0 0;font-size:9px">Invite a collaborator<select id="invite-agent" style="font-size:11px;padding:7px"><option value="">Choose an agent…</option>${availableAgents.map(agent=>`<option value="${e(agent.id)}">${e(agent.name)} · ${e(ROLE_NAMES[agent.role]||agent.role)}</option>`).join('')}</select></label>`:''}<p class="member-note">✧ Specialists may join as the task evolves. ${members.length}/${g.maxAgents||12} collaborator slots used.</p></section>
  <section class="detail-section"><div class="section-header"><h3 class="section-label">GROUP PROGRESS</h3><span aria-hidden="true">◷</span></div><div class="progress-top"><span>${complete?'Goal accepted':g.status==='review'?'Awaiting your review':'Working within limits'}</span><span>${g.turnsUsed||0}/${g.maxTurns||16}</span></div><div class="progress-track" role="progressbar" aria-label="Turn budget used" aria-valuenow="${g.turnsUsed||0}" aria-valuemin="0" aria-valuemax="${g.maxTurns||16}"><div class="progress-bar" style="width:${progress}%"></div></div><div class="progress-meta"><span>Turns used</span><span title="Conservative reserved token budget, including retries; not measured billable tokens">${(g.tokensUsed||0).toLocaleString()} budget units</span></div><div style="margin-top:18px"><div class="progress-step done"><i></i>Brief & success criteria</div><div class="progress-step ${g.turnsUsed?'done':'current'}"><i></i>Explore & collaborate</div><div class="progress-step ${artifact?'done':g.turnsUsed?'current':''}"><i></i>Propose a deliverable</div><div class="progress-step ${complete?'done':g.status==='review'?'current':''}"><i></i>Your final review</div></div></section>
  ${artifact?`<section class="detail-section"><div class="section-header"><h3 class="section-label">THE DELIVERABLE</h3><span aria-hidden="true">✧</span></div><div class="result-preview"><strong>${e(artifact.title||'Proposed result')}</strong><p>${e(artifact.content?.slice(0,180)||'A result is ready in your conversation.')}</p></div><button class="button secondary wide" id="copy-deliverable">Copy deliverable</button>${complete?'<p class="accept-help">✓ Accepted by you. This group is complete.</p>':`<button class="button primary wide" id="accept-result" style="margin-top:8px" ${canAccept?'':'disabled'}>Accept & complete <span>✓</span></button><p class="accept-help">${canAccept?'You’ve checked every criterion. Ready to call it done?':'Check each acceptance criterion before completing this group.'}</p>`}</section>`:''}`;
}
function renderComposer() {
  const g=state.group; const terminal=['completed','cancelled','budget_exhausted'].includes(g.status); const archived=Boolean(g.archived);
  $('message-input').disabled=state.busy||terminal||archived;
  $('send-message').disabled=state.busy||terminal||archived||!$('message-input').value.trim();
  $('message-input').placeholder=archived?'Restore this group to continue…':g.status==='completed'?'This goal is complete. Start a new group for what’s next.':terminal?'This run has ended. Create a new group to continue.':'Add a thought or steer the group…';
  $('composer-context').textContent=isDemo(g)?'Sample mode · These are canned responses for exploring the workflow, not live AI work.':groupProviders(g).has('demo')?'Mixed models · This group includes live model connections and canned sample collaborators.':g.status==='review'?'Need a revision? Send your feedback, then select Continue to let the group work on it.':'';
}
async function mutate(path,body) {
  if(state.busy)return;
  const selected=state.selected; state.busy=true; renderRunStrip(); renderComposer();
  try {
    let expectedVersion=state.group.version;
    // Fresh state reduces avoidable conflicts while the server is generating.
    // Human acceptance always uses the exact version the person reviewed.
    if(!path.startsWith('/criteria/') && body.action!=='accept') {
      const fresh=await api(`/groups/${encodeURIComponent(selected)}`); expectedVersion=fresh.group.version;
      if(state.selected===selected){state.group=fresh.group;renderGroup(true);}
    }
    const data=await api(`/groups/${encodeURIComponent(selected)}${path}`,{method:'POST',body:{...body,expectedVersion}});
    if(state.selected===selected){state.group=data.group;renderGroup(true);}
    await loadGroups().catch(()=>setConnected(false)); return data;
  }
  catch(error) {
    if(error.status===409 && error.code==='stale_version') {
      try {const data=await api(`/groups/${encodeURIComponent(selected)}`);if(state.selected===selected){state.group=data.group;renderGroup(true);}}catch {setConnected(false);}
      toast('The group updated while you were working. Review the latest state and try again.');
    } else toast(error.message); return null;
  }
  finally{state.busy=false;if(state.group){renderRunStrip();renderComposer();renderDetails();}}
}
async function groupAction(action) {
  if(action==='archive' && state.group.status==='running'){toast('Pause the group before archiving it.');return;}
  if(action==='cancel'){openConfirm('Stop this run?','The group will stop generating. Messages and any proposed work will stay in your workspace.','Stop run',async()=>{await mutate('/actions',{action:'cancel'});});return;}
  const result=await mutate('/actions',{action}); if(!result)return;
  if(action==='archive'||action==='restore'){toast(action==='archive'?'Group archived. You can restore it from Archived.':'Group restored.');state.selected=null;state.group=null;history.replaceState(null,'',location.pathname);if(state.groups.length)selectGroup(state.groups[0].id);else renderEmpty();}
}
function openConfirm(title,copy,label,action) { $('confirm-title').textContent=title;$('confirm-copy').textContent=copy;$('confirm-action').textContent=label;$('confirm-details').innerHTML='';$('confirm-action').onclick=async()=>{closeDialog($('confirm-dialog'));await action();};showDialog('confirm-dialog'); }
function updateCreateAgents() {
  const provider=$('create-mode').value;
  const connectionIds=new Set(state.connections.filter(c=>c.provider===provider).map(c=>c.id));
  const agents=state.agents.filter(agent=>connectionIds.has(agent.connectionId)&&state.connections.find(connection=>connection.id===agent.connectionId)?.configured);
  $('create-team-preview').className='create-team-preview agent-picker';
  $('create-team-preview').innerHTML=agents.length?agents.map((agent,index)=>`<label class="agent-option"><input type="checkbox" name="initialAgentIds" value="${e(agent.id)}" ${index<4?'checked':''}>${avatar(agent.name,agent.id)}<span>${e(agent.name)}<small>${e(ROLE_NAMES[agent.role]||agent.role)}</small></span></label>`).join(''):'<span class="readonly-hint">No agent profiles for this provider yet. Add them in Models & agents.</span>';
  $('mode-help').textContent=provider==='demo'?'Canned sample responses. No AI model is called. Great for exploring Huddle.':'Live requests go to your configured model connections. Any free-tier quotas or local compute requirements still apply.';
  const extra=state.agents.filter(agent=>!connectionIds.has(agent.connectionId) && state.connections.find(c=>c.id===agent.connectionId)?.configured && state.connections.find(c=>c.id===agent.connectionId)?.provider!=='demo');
  if(provider!=='demo' && extra.length){$('create-team-preview').innerHTML+=extra.map(agent=>`<label class="agent-option"><input type="checkbox" name="initialAgentIds" value="${e(agent.id)}">${avatar(agent.name,agent.id)}<span>${e(agent.name)}<small>${e(state.connections.find(c=>c.id===agent.connectionId)?.name||agent.role)}</small></span></label>`).join('');}
}
function openCreate(template) {
  $('create-form').reset();$('create-error').hidden=true;
  const modes=(state.config?.providers||[{id:'demo',label:'Sample mode',available:true}]).map(provider=>({...provider,available:provider.id==='demo'||state.connections.some(connection=>connection.provider===provider.id&&connection.configured)}));
  if(!modes.some(provider=>provider.id==='compatible')&&state.connections.some(connection=>connection.provider==='compatible'))modes.push({id:'compatible',label:'Open-model connections',available:state.connections.some(connection=>connection.provider==='compatible'&&connection.configured)});
  $('create-mode').innerHTML=modes.map(provider=>`<option value="${e(provider.id)}" ${provider.available===false?'disabled':''}>${e(provider.id==='demo'?'Sample mode · canned demonstration':provider.label)}${provider.available===false?' · not connected':''}</option>`).join('');
  const live=modes.find(provider=>provider.id!=='demo'&&provider.available);if(live)$('create-mode').value=live.id;
  if(template && templates[template]) { $('create-name').value=templates[template].name;$('create-task').value=templates[template].task;$('create-criteria').value=templates[template].criteria; }
  updateCreateAgents();showDialog('create-dialog');setTimeout(()=>$('create-name').focus(),30);
}
async function createGroup(event) {
  event.preventDefault(); const form=$('create-form'); if(!form.reportValidity())return;
  const criteria=parseCriteria($('create-criteria').value);if(criteria.length>12||criteria.some(item=>item.length>500)){$('create-error').textContent='Use up to 12 acceptance criteria, each no more than 500 characters.';$('create-error').hidden=false;return;}if(!criteria.length){$('create-error').textContent='Add at least one clear acceptance criterion.';$('create-error').hidden=false;return;}
  const initialAgentIds=[...form.querySelectorAll('[name=initialAgentIds]:checked')].map(input=>input.value);
  const maxAgents=Number($('create-size').value); if(initialAgentIds.length>maxAgents){$('create-error').textContent=`Choose no more than ${maxAgents} starting collaborators, or increase the group size.`;$('create-error').hidden=false;return;}
  if(state.agents.length&&!initialAgentIds.length){$('create-error').textContent='Choose at least one starting collaborator.';$('create-error').hidden=false;return;}
  $('create-submit').disabled=true;$('create-submit').textContent='Creating group…';$('create-error').hidden=true;
  try { const {group}=await api('/groups',{method:'POST',body:{title:$('create-name').value.trim(),goal:$('create-task').value.trim(),criteria,provider:$('create-mode').value,maxTurns:Number($('create-turns').value),maxAgents,initialAgentIds}});closeDialog($('create-dialog'));state.archived=false;updateFilterTabs();await loadGroups();await selectGroup(group.id);toast('Your group is ready. Start when you’re happy with the brief.'); }
  catch(error){$('create-error').textContent=error.message;$('create-error').hidden=false;}
  finally{$('create-submit').disabled=false;$('create-submit').innerHTML='Create group <span>↗</span>';}
}
function updateFilterTabs(){for(const [id,active] of [['active-tab',!state.archived],['archived-tab',state.archived]]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-selected',String(active));}}
async function switchArchive(value){state.archived=value;updateFilterTabs();try{await loadGroups();}catch(error){toast(error.message);}}
async function refreshRegistry(){const [config,connections,agents]=await Promise.all([api('/config'),api('/connections'),api('/agents')]);state.config=config;state.connections=connections.connections||config.connections||[];state.agents=agents.agents||config.agents||[];renderProvider();}
async function openSettings(tab='models') {state.registryTab=tab;state.registryEditor=null;showDialog('settings-dialog');$('settings-body').innerHTML='<div class="loader"></div>';try{await refreshRegistry();renderSettings();}catch(error){$('settings-body').innerHTML=`<div class="inline-error">${e(error.message)}</div>`;}}
function renderSettings() {
  const models=state.registryTab==='models';
  $('settings-title').textContent='Models & agents';
  $('settings-body').innerHTML=`<div class="registry-tabs" role="tablist"><button data-registry-tab="models" class="${models?'active':''}" role="tab" aria-selected="${models}">Model connections <span>${state.connections.length}</span></button><button data-registry-tab="agents" class="${!models?'active':''}" role="tab" aria-selected="${!models}">AI agents <span>${state.agents.length}</span></button></div><div class="registry-toolbar"><p>${models?'Connect a model once. Let multiple agents share it.':'Different perspectives, instructions, and model connections.'}</p><button class="button primary small" id="add-registry">+ ${models?'Connection':'Agent'}</button></div>
  ${models?state.connections.map(connection=>`<div class="registry-card"><div class="registry-card-head"><span class="template-icon lavender" style="margin:0">${connection.provider==='ollama'?'⌘':connection.provider==='demo'?'◈':'↗'}</span><div class="registry-card-copy"><div class="registry-card-title">${e(connection.name)}</div><div class="registry-card-meta">${e(providerLabel(connection.provider))} · ${e(connection.model)}</div></div><span class="availability ${connection.configured?'yes':''}">${connection.provider==='demo'?'Sample only':connection.configured?'Configured':'Not configured'}</span></div><p>${connection.provider==='demo'?'Deterministic sample responses. No live AI calls.':`Endpoint: ${e(connection.baseUrl||'Default provider endpoint')}`}</p>${connection.provider!=='demo'?`<div class="registry-card-meta">${connection.hasApiKey?'Secret configured · never returned to this browser':connection.apiKeyEnv?`Server secret: ${e(connection.apiKeyEnv)}`:'No API secret configured'} · ${connection.supportsReasoning?'Reasoning controls supported':'Default model reasoning'}</div>`:''}<div class="registry-actions"><button class="subtle-button" data-edit-connection="${e(connection.id)}">Edit connection</button></div></div>`).join(''):state.agents.map(agent=>{const connection=state.connections.find(c=>c.id===agent.connectionId);return `<div class="registry-card"><div class="registry-card-head">${avatar(agent.name,agent.id)}<div class="registry-card-copy"><div class="registry-card-title">${e(agent.name)}</div><div class="registry-card-meta">${e(ROLE_NAMES[agent.role]||agent.role)} · ${e(connection?.name||'Missing connection')}</div></div><span class="role-label">${e(agent.reasoningEffort||'default')}</span></div><p>${e(agent.instructions||'Uses the role’s default instructions.')}</p><div class="registry-actions"><button class="subtle-button" data-edit-agent="${e(agent.id)}">Edit agent</button></div></div>`;}).join('')}
  ${!(models?state.connections:state.agents).length?`<div class="registry-empty">No ${models?'model connections':'agent profiles'} yet. Add your first one to get started.</div>`:''}
  <div id="registry-editor"></div><p class="settings-note">${models?'Huddle includes NVIDIA Build, local Ollama, and operator-approved open-model endpoints. There are no paid model presets. Provider terms, quotas, and any deployment costs still apply. Configuration does not verify connectivity.':'An agent is a reusable profile, with its own role and instructions. Several agents can use the same model. Changes to an agent profile affect groups using that agent and interrupt any in-flight response.'}</p>`;
  if(state.registryEditor)renderRegistryEditor();
}
function field(label,name,value='',opts={}) {return `<label class="field">${label}<${opts.textarea?'textarea':'input'} name="${name}" ${opts.textarea?'rows="3"':`type="${opts.type||'text'}" value="${e(value)}"`} ${opts.required?'required':''} ${opts.placeholder?`placeholder="${e(opts.placeholder)}"`:''} ${opts.autocomplete?`autocomplete="${opts.autocomplete}"`:''}>${opts.textarea?`${e(value)}</textarea>`:''}${opts.help?`<small>${e(opts.help)}</small>`:''}</label>`;}
function renderRegistryEditor() {
  const {type,id}=state.registryEditor; const connectionForm=type==='connection'; const item=(connectionForm?state.connections:state.agents).find(item=>item.id===id)||{};
  $('registry-editor').innerHTML=`<form id="registry-form" class="registry-form"><h3>${id?'Edit':'Add'} ${connectionForm?'model connection':'AI agent'}</h3>${field('Name','name',item.name||'',{required:true,placeholder:connectionForm?'e.g. Local Llama':'e.g. Maya · Product strategist'})}
  ${connectionForm?`<label class="field">Provider<select name="provider" id="connection-provider"><option value="nvidia" ${item.provider==='nvidia'?'selected':''}>NVIDIA Build</option><option value="ollama" ${item.provider==='ollama'?'selected':''}>Ollama · local</option><option value="compatible" ${item.provider==='compatible'?'selected':''}>Compatible open-model endpoint</option>${item.provider==='demo'?'<option value="demo" selected>Sample (no model calls)</option>':''}</select></label>${field('Model ID','model',item.model||'',{required:true,placeholder:'e.g. meta/llama-3.3-70b-instruct'})}${field('API base URL','baseUrl',item.baseUrl||'',{placeholder:'https://integrate.api.nvidia.com/v1',help:'Ollama usually uses http://127.0.0.1:11434/v1 on the server. Compatible origins must be operator-approved.'})}${field('API key · optional, write-only','apiKey','',{type:'password',autocomplete:'new-password',placeholder:item.hasApiKey?'Already configured · leave blank to keep':'Enter only in this field',help:'Stored encrypted on the server. Never saved to browser storage or returned by the API.'})}${field('Or use a server environment variable','apiKeyEnv',item.apiKeyEnv||'',{placeholder:'NVIDIA_API_KEY or HUDDLE_API_KEY_LOCAL',help:'Use NVIDIA_API_KEY or a HUDDLE_API_KEY_* variable configured on the server. Do not paste the key itself here.'})}<label class="checkbox-field"><input type="checkbox" name="supportsReasoning" ${item.supportsReasoning?'checked':''}>This model endpoint supports a reasoning_effort parameter</label>`:
  `<label class="field">Collaboration role<select name="role"><option value="coordinator" ${item.role==='coordinator'?'selected':''}>Coordinator · shapes the plan and final result</option><option value="researcher" ${item.role==='researcher'?'selected':''}>Researcher · explores options and evidence</option><option value="builder" ${item.role==='builder'?'selected':''}>Builder · turns ideas into concrete work</option><option value="critic" ${item.role==='critic'?'selected':''}>Reviewer · tests assumptions and quality</option></select></label>${field('Agent instructions','instructions',item.instructions||'',{textarea:true,required:true,placeholder:'Describe this agent’s expertise, perspective, and how it should contribute…'})}<label class="field">Model connection<select name="connectionId" id="agent-connection" required>${state.connections.map(connection=>`<option value="${e(connection.id)}" ${item.connectionId===connection.id?'selected':''}>${e(connection.name)} · ${e(connection.model)}</option>`).join('')}</select></label><label class="field">Reasoning effort<select name="reasoningEffort" id="agent-reasoning"><option value="default">Default model behavior</option><option value="low" ${item.reasoningEffort==='low'?'selected':''}>Low</option><option value="medium" ${item.reasoningEffort==='medium'?'selected':''}>Medium</option><option value="high" ${item.reasoningEffort==='high'?'selected':''}>High</option></select><small id="reasoning-help"></small></label>`}
  <div id="registry-error" class="inline-error" role="alert" hidden></div><div class="registry-form-actions"><button type="button" class="button secondary small" id="cancel-registry">Cancel</button><button type="submit" class="button primary small" id="save-registry">Save ${connectionForm?'connection':'agent'}</button></div></form>`;
  if(!connectionForm)updateReasoning();
  $('registry-form').addEventListener('submit',saveRegistry);$('registry-editor').scrollIntoView({behavior:'smooth',block:'nearest'});$('registry-form').querySelector('input').focus();
}
function updateReasoning() {const connection=state.connections.find(c=>c.id===$('agent-connection').value);const supported=Boolean(connection?.supportsReasoning);$('agent-reasoning').disabled=!supported;if(!supported)$('agent-reasoning').value='default';$('reasoning-help').textContent=supported?'Only supported values are sent to this connection.':'This connection does not declare reasoning controls. The model’s default behavior is used.';if(supported){for(const option of $('agent-reasoning').options)option.disabled=option.value!=='default'&&!(connection.reasoningEfforts||['low','medium','high']).includes(option.value);}}
async function saveRegistry(event) {
  event.preventDefault();if(!$('registry-form').reportValidity())return;
  const {type,id}=state.registryEditor;const form=new FormData($('registry-form'));const body=Object.fromEntries(form.entries());
  if(type==='connection'){body.supportsReasoning=form.has('supportsReasoning');if(!body.apiKey)delete body.apiKey;}
  else body.reasoningEffort=$('agent-reasoning').disabled?'default':$('agent-reasoning').value;
  $('save-registry').disabled=true;$('registry-error').hidden=true;
  try {
    const saved=await api(`/${type==='connection'?'connections':'agents'}${id?'/'+encodeURIComponent(id):''}`,{method:id?'PATCH':'POST',body});
    const secret=$('registry-form')?.querySelector('[name=apiKey]');if(secret)secret.value='';
    const key=type==='connection'?'connections':'agents';const record=saved[type];
    state[key]=state[key].filter(item=>item.id!==record.id).concat(record);
    state.registryEditor=null;renderSettings();renderProvider();
    toast(type==='connection'?'Connection saved. Connectivity has not been tested.':'Agent profile saved.');
    refreshRegistry().catch(()=>setConnected(false));
  }
  catch(error){if(!$('registry-error')){toast(error.message);return;}$('registry-error').textContent=error.message;$('registry-error').hidden=false;$('save-registry').disabled=false;const secret=$('registry-form').querySelector('[name=apiKey]');if(secret)secret.value='';}
}
async function poll() {
  if(state.polling||state.busy||document.hidden)return;
  state.polling=true;
  try{await loadGroups();if(state.selected){const selected=state.selected;const {group}=await api(`/groups/${encodeURIComponent(selected)}`);if(state.selected===selected&&(!state.group||group.version>=state.group.version)){state.group=group;renderGroup();}}setConnected(true);}
  catch(error){if(error.status===401){clearInterval(pollTimer);showAuth();}else setConnected(false);}
  finally{state.polling=false;}
}
function showAuth() {
  $('boot-loading').hidden=true;$('group-workspace').hidden=true;$('empty-state').hidden=false;
  $('empty-state').innerHTML=`<div class="eyebrow">PRIVATE WORKSPACE</div><h2>Welcome to Huddle.</h2><p>Enter the workspace access secret to continue.</p><form id="auth-form" class="auth-form"><label class="field">Workspace access secret<input id="access-secret" type="password" required autocomplete="current-password"></label><p class="auth-note">Ask your server operator for the secret. It is used only to establish a secure session.</p><div id="auth-error" class="inline-error" hidden></div><button class="button primary" type="submit">Open workspace</button></form>`;
  $('auth-form').addEventListener('submit',async event=>{event.preventDefault();const value=$('access-secret').value;$('access-secret').value='';try{await api('/session',{method:'POST',body:{accessSecret:value}});location.reload();}catch(error){$('auth-error').textContent=error.message;$('auth-error').hidden=false;}});
}
async function boot() {
  try {state.config=await api('/config');if(state.config.authRequired&&!state.config.authenticated){showAuth();return;}
    state.connections=state.config.connections||[];state.agents=state.config.agents||[];
    if(!state.connections.length||!state.agents.length){try{await refreshRegistry();}catch(error){console.warn('Registry unavailable',error.message);}}
    renderProvider();await loadGroups();const hash=location.hash.match(/^#group\/(.+)$/);const id=hash?decodeURIComponent(hash[1]):state.groups[0]?.id;
    if(id)await selectGroup(id);else renderEmpty();pollTimer=setInterval(poll,1800);
  }catch(error){$('boot-loading').hidden=true;if(error.status===401){showAuth();return;}$('empty-state').hidden=false;$('empty-state').innerHTML=`<div class="eyebrow">CONNECTION NEEDED</div><h2>Your workspace is taking a moment.</h2><p>${e(error.message)}</p><button class="button primary" id="retry-boot">Try again</button>`;$('retry-boot').onclick=()=>location.reload();setConnected(false,'Cannot reach the Huddle server. Check that it is running, then try again.');}
}
// Event delegation keeps refreshed views wired without repeated listeners.
document.addEventListener('click',async event=>{
  const action=event.target.closest('[data-action]');if(action){if(action.dataset.action==='new-group')openCreate();if(action.dataset.action==='settings')openSettings();if(action.dataset.action==='agents')openSettings('agents');return;}
  const group=event.target.closest('[data-group-id]');if(group){selectGroup(group.dataset.groupId);return;}
  const template=event.target.closest('[data-template]');if(template){openCreate(template.dataset.template);return;}
  const control=event.target.closest('[data-group-action]');if(control){groupAction(control.dataset.groupAction);return;}
  const closer=event.target.closest('.close-dialog');if(closer){closeDialog(closer.closest('dialog'));return;}
  const registryTab=event.target.closest('[data-registry-tab]');if(registryTab){state.registryTab=registryTab.dataset.registryTab;state.registryEditor=null;renderSettings();return;}
  const editConnection=event.target.closest('[data-edit-connection]');const editAgent=event.target.closest('[data-edit-agent]');if(editConnection||editAgent){state.registryEditor={type:editConnection?'connection':'agent',id:editConnection?.dataset.editConnection||editAgent.dataset.editAgent};renderRegistryEditor();return;}
  if(event.target.closest('#add-registry')){state.registryEditor={type:state.registryTab==='models'?'connection':'agent'};renderRegistryEditor();return;}
  if(event.target.closest('#cancel-registry')){state.registryEditor=null;renderSettings();return;}
  if(event.target.closest('#accept-result')){openConfirm('Accept this result?','You’ve checked every acceptance criterion. Accepting completes this group and records your final review.','Accept & complete',()=>mutate('/actions',{action:'accept'}));return;}
  if(event.target.closest('#copy-deliverable')){try{await navigator.clipboard.writeText(state.group.artifacts.at(-1).content);toast('Deliverable copied.');}catch{toast('Clipboard access is unavailable. Use Export conversation in the group menu.');}return;}
  if(!event.target.closest('.header-actions'))closeMenu();
});
document.addEventListener('change',async event=>{
  if(event.target.dataset.criterion){await mutate(`/criteria/${encodeURIComponent(event.target.dataset.criterion)}`,{accepted:event.target.checked});}
  if(event.target.id==='invite-agent'&&event.target.value)await mutate('/members',{agentId:event.target.value});
  if(event.target.id==='agent-connection')updateReasoning();
});
$('create-form').addEventListener('submit',createGroup);$('create-mode').addEventListener('change',updateCreateAgents);
$('group-search').addEventListener('input',event=>{state.search=event.target.value;renderGroups();});
$('active-tab').onclick=()=>switchArchive(false);$('archived-tab').onclick=()=>switchArchive(true);
$('open-sidebar').onclick=()=>sidebar(true);$('close-sidebar').onclick=()=>sidebar(false);$('sidebar-backdrop').onclick=()=>sidebar(false);$('workspace-button').onclick=()=>sidebar(true);
$('toggle-details').onclick=()=>setDetails(!$('group-workspace').classList.contains('details-open'));$('chat-tab').onclick=()=>setDetails(false);$('details-tab').onclick=()=>setDetails(true);
$('group-menu-button').onclick=()=>{const open=$('group-menu').hidden;$('group-menu').hidden=!open;$('group-menu-button').setAttribute('aria-expanded',String(open));};
$('archive-group').onclick=()=>{closeMenu();groupAction(state.group?.archived?'restore':'archive');};
$('export-group').onclick=()=>{closeMenu();const blob=new Blob([groupExport(state.group)],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=`${state.group.title.replace(/[^a-z0-9]+/gi,'-').toLowerCase()||'huddle'}-conversation.md`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Conversation exported.');};
$('message-input').addEventListener('input',()=>{$('message-input').style.height='auto';$('message-input').style.height=`${Math.min($('message-input').scrollHeight,130)}px`;renderComposer();});
$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!$('send-message').disabled)$('message-form').requestSubmit();}});
$('message-form').addEventListener('submit',async event=>{event.preventDefault();const content=$('message-input').value.trim();if(!content||state.busy)return;const result=await mutate('/messages',{content});if(result){$('message-input').value='';$('message-input').style.height='auto';renderComposer();$('message-input').focus();requestAnimationFrame(()=>$('conversation').scrollTop=$('conversation').scrollHeight);}});
$('new-messages').onclick=()=>{$('conversation').scrollTop=$('conversation').scrollHeight;$('new-messages').hidden=true;};
$('conversation').addEventListener('scroll',()=>{if($('conversation').scrollHeight-$('conversation').clientHeight-$('conversation').scrollTop<80)$('new-messages').hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){sidebar(false);closeMenu();}if(event.metaKey||event.ctrlKey||event.altKey||document.querySelector('dialog[open]')||['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))return;if(event.key.toLowerCase()==='n'){event.preventDefault();openCreate();}if(event.key==='/'){event.preventDefault();if(innerWidth<=760)sidebar(true);$('group-search').focus();}});
document.querySelectorAll('dialog').forEach(dialog=>{dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDialog(dialog);}});dialog.addEventListener('close',()=>{if(dialog.id==='settings-dialog'){const secret=dialog.querySelector('[name=apiKey]');if(secret)secret.value='';}});});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
boot();
