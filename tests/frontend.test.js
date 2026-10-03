import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, initials, colorIndex, statusLabel, relativeTime, parseCriteria, markdown, groupExport } from '../public/ui.js';

test('escapes every HTML boundary in user-controlled text', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)"> & \'quoted\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;');
});
test('safe markdown handles malicious HTML, links, and code without executable content', () => {
  const html=markdown('# <script>alert(1)</script>\n\n**<img src=x onerror=alert(1)>**\n\n[x](javascript:alert(1))\n\n```html\n<iframe srcdoc="evil"></iframe>\n```');
  assert.ok(!/<(?:script|img|iframe|a)\b/i.test(html));
  assert.ok(html.includes('<h3>&lt;script&gt;'));
  assert.ok(html.includes('<strong>&lt;img'));
  assert.ok(html.includes('<pre><code>&lt;iframe'));
});
test('markdown produces balanced paragraphs, ordered and unordered lists', () => {
  assert.equal(markdown('Opening\nline\n\n- First\n- Second\n\n1. One\n2. Two'),'<p>Opening<br>line</p><ul><li>First</li><li>Second</li></ul><ol><li>One</li><li>Two</li></ol>');
  assert.equal(markdown('**Bold** and `inline`'),'<p><strong>Bold</strong> and <code>inline</code></p>');
});
test('unterminated code is still escaped safely', () => { assert.equal(markdown('```js\n<script>'), '<pre><code>&lt;script&gt;</code></pre>'); });
test('acceptance criteria parsing keeps content while removing list prefixes', () => {
  assert.deepEqual(parseCriteria(' - Compare options\n\n2. Identify risks\n• Draft an outline\n Plain criterion '),['Compare options','Identify risks','Draft an outline','Plain criterion']);
});
test('avatar labels and deterministic palette work for empty and long names', () => {
  assert.equal(initials('Maya Product Strategist'),'MP');assert.equal(initials('  '),'AI');assert.equal(initials('Sage'),'S');
  assert.equal(colorIndex('same'),colorIndex('same'));assert.ok(colorIndex('agent')>=0&&colorIndex('agent')<6);
});
test('run states are human-readable and unknown states have a safe fallback', () => {
  assert.equal(statusLabel('budget_exhausted'),'Turn limit reached');assert.equal(statusLabel('review'),'Ready for review');assert.equal(statusLabel('made-up'),'Ready');
});
test('relative timestamps handle future and invalid dates', () => {
  const now=Date.UTC(2026,9,3,12);assert.equal(relativeTime(now-120000,now),'2m');assert.equal(relativeTime(now+10000,now),'now');assert.equal(relativeTime('invalid',now),'');
});
test('export distinguishes sample work and records human acceptance', () => {
  const text=groupExport({title:'Planning',goal:'Choose a direction',provider:'demo',status:'completed',criteria:[{text:'Compare options',accepted:true}],messages:[{role:'human',content:'My feedback',createdAt:'2026-10-03T12:00:00Z'}],artifacts:[{title:'Result',content:'A useful draft'}]});
  assert.ok(text.includes('canned demonstration; no model calls'));assert.ok(text.includes('[x] Compare options'));assert.ok(text.includes('## Result'));assert.ok(text.includes('My feedback'));
});

test('static document has unique control IDs and valid ARIA/label references', async () => {
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'duplicate document IDs');
  for(const match of html.matchAll(/\b(?:for|aria-labelledby|aria-controls)="([^"]+)"/g)) {
    for(const id of match[1].split(/\s+/))assert.ok(ids.includes(id),`missing referenced ID: ${id}`);
  }
  assert.ok(html.includes('class="skip-link"'));
  assert.ok(html.includes('type="module" src="/app.js"'));
  assert.ok(!/<script[^>]+src="https?:/i.test(html),'scripts must remain local');
});
test('responsive and motion accommodations remain present', async () => {
  const {readFile}=await import('node:fs/promises');
  const css=await readFile(new URL('../public/styles.css',import.meta.url),'utf8');
  assert.ok(css.includes('@media(max-width:760px)'));
  assert.ok(css.includes('@media(prefers-reduced-motion:reduce)'));
  assert.ok(css.includes(':focus-visible'));
  assert.ok(css.includes('.mobile-details .chat-column'));
});
