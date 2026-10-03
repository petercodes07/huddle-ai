/** Small, dependency-free view helpers. All model/user text is escaped. */
export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
export function initials(name = '') { return String(name).trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'AI'; }
export function colorIndex(value = '') { return [...String(value)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6; }
export function avatar(name, key = name, extra = '') { return `<span class="avatar color-${colorIndex(key)} ${escapeHtml(extra)}" aria-hidden="true">${escapeHtml(initials(name))}</span>`; }
export function statusLabel(status) { return ({draft:'Ready to begin',running:'In progress',paused:'Paused',review:'Ready for review',completed:'Completed',cancelled:'Cancelled',error:'Needs attention',budget_exhausted:'Turn limit reached'})[status] || 'Ready'; }
export function relativeTime(date, now = Date.now()) {
  const elapsed = Math.max(0, now - new Date(date).getTime());
  if (!Number.isFinite(elapsed)) return '';
  if (elapsed < 60000) return 'now';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h`;
  return `${Math.floor(elapsed / 86400000)}d`;
}
export function clockTime(date) { const parsed = new Date(date); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : ''; }
export function parseCriteria(value) { return String(value || '').split('\n').map(line => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '')).filter(Boolean); }
function inline(text) { return escapeHtml(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>'); }
export function markdown(content = '') {
  // Intentionally supports only paragraphs, lists, headings, bold, and code.
  // Never accepts raw HTML, links, images, or executable markdown extensions.
  const blocks = String(content).replace(/\r\n/g, '\n').split(/(```[\s\S]*?(?:```|$))/g);
  return blocks.map(block => {
    if (block.startsWith('```')) {
      const code = block.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
    let listType = '', output = '', paragraph = [];
    const flush = () => { if (paragraph.length) { output += `<p>${paragraph.map(inline).join('<br>')}</p>`; paragraph = []; } };
    const closeList = () => { if (listType) { output += `</${listType}>`; listType = ''; } };
    for (const line of block.split('\n')) {
      if (!line.trim()) { flush(); closeList(); continue; }
      const list = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.+)$/);
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (list) { flush(); const type = list[2] ? 'ol' : 'ul'; if (listType !== type) { closeList(); output += `<${type}>`; listType = type; } output += `<li>${inline(list[3])}</li>`; }
      else if (heading) { flush(); closeList(); output += `<h3>${inline(heading[1])}</h3>`; }
      else { closeList(); paragraph.push(line); }
    }
    flush(); closeList(); return output;
  }).join('');
}
export function groupExport(group) {
  const criteria = (group.criteria || []).map(item => `- [${item.accepted ? 'x' : ' '}] ${item.text}`).join('\n');
  const messages = (group.messages || []).map(item => `### ${item.role === 'human' ? 'You' : item.agentName || item.agentRole || 'Group update'} · ${item.createdAt || ''}\n\n${item.content}`).join('\n\n');
  const artifacts = (group.artifacts || []).map(item => `## ${item.title || 'Deliverable'}\n\n${item.content}`).join('\n\n');
  return `# ${group.title}\n\n${group.goal}\n\nMode: ${group.provider === 'demo' ? 'Sample (canned demonstration; no model calls)' : group.provider}\nStatus: ${statusLabel(group.status)}\n\n## Acceptance criteria\n\n${criteria}\n\n## Conversation\n\n${messages}${artifacts ? '\n\n' + artifacts : ''}\n`;
}
