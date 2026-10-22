/* missile-studio web UI v4: rail + list pane + split chat panes + workspace/artifacts drawer. Vanilla JS, no build. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k === 'style') n.style.cssText = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const I = (name, cls) => window.icon(name, cls);
  const md = (s) => DOMPurify.sanitize(marked.parse(String(s ?? ''), { breaks: true, gfm: true }));
  // links in answers open in a new tab (DOMPurify drops target= by default, so it is set after sanitising)
  DOMPurify.addHook('afterSanitizeAttributes', (node) => { if (node.tagName === 'A' && /^(https?:|mailto:)/i.test(node.getAttribute('href') || '')) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); } });
  const URL_RE = /https?:\/\/[^\s"'<>\\)\]]+/g;
  // plain text (tool results) with its URLs turned into links; built from nodes, never from HTML
  function linkedPre(text) {
    const pre = el('pre');
    let last = 0;
    for (const m of String(text).matchAll(URL_RE)) {
      let url = m[0]; let tail = '';
      while (/[.,;:!?]$/.test(url)) { tail = url.slice(-1) + tail; url = url.slice(0, -1); }
      pre.append(document.createTextNode(text.slice(last, m.index)), el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
      if (tail) pre.append(document.createTextNode(tail));
      last = m.index + m[0].length;
    }
    pre.append(document.createTextNode(text.slice(last)));
    return pre;
  }
  const fmtMs = (ms) => ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const fmtBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  const initials = (s) => (s || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const avatarStyle = (s) => `background: hsl(${hue(s)} 55% 48%)`;
  const shortModel = (m) => (m || '').includes('|') ? m.split('|')[1] : m || '';
  // provider reachability (probed by the server every 2 minutes and after every turn): ok · down · nokey · unknown
  const HEALTH_LABEL = { ok: 'reachable', down: 'unreachable', nokey: 'no API key', unknown: 'not checked yet' };
  const healthOf = (p) => (p && p.health) || { state: 'unknown', error: '' };
  const hdot = (p) => { const h = healthOf(p); return el('span', { class: 'hdot ' + h.state, title: `${p?.label || p?.id || ''}: ${HEALTH_LABEL[h.state] || h.state}${h.error ? ' · ' + h.error : ''}${h.ms ? ' · ' + h.ms + 'ms' : ''}` }); };
  const unusable = (p) => ['down', 'nokey'].includes(healthOf(p).state);
  // tool catalog: above the threshold the model is sent one line per tool and loads the ones it needs
  const catalogOn = () => { const c = (S.st && S.st.tool_catalog) || {}; return c.mode === 'on' || (c.mode !== 'off' && (S.st?.tools?.length || 0) > (c.threshold || 24)); };
  // permission mode of a chat: remembered per conversation, and the last choice becomes the default for new chats
  const PERM = { '': ['Ask', 'Ask before tools that write or run things (the policy decides)'], auto: ['Allow all', 'Run every tool in this chat without asking (blocked tools and dangerous shell commands still stop)'], readonly: ['Read-only', 'Only read-only tools; anything that writes or runs is off for this chat'] };
  const permOf = (pane) => { if (pane.sel.permission != null) return pane.sel.permission; try { return (pane.convId && localStorage.getItem('missile_perm:' + pane.convId)) || localStorage.getItem('missile_perm_default') || ''; } catch { return ''; } };
  function setPerm(pane, v) { pane.sel.permission = v; try { if (pane.convId) localStorage.setItem('missile_perm:' + pane.convId, v); localStorage.setItem('missile_perm_default', v); } catch {} render(); }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hl = (snippet) => esc(snippet).replace(/\[([^\]]{1,80})\]/g, '<mark>$1</mark>');  // the search API marks hits with [ ]
  const MAX_PANES = 3;
  const THINK_LABEL = { '': 'provider default', on: 'thinking on', max: 'thinking max', off: 'thinking off' };
  const EXT = { html: 'html', svg: 'svg', markdown: 'md', md: 'md', json: 'json', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', bash: 'sh', sh: 'sh', powershell: 'ps1', css: 'css', yaml: 'yml', yml: 'yml', sql: 'sql', go: 'go', rust: 'rs', java: 'java', csharp: 'cs', cpp: 'cpp', c: 'c', xml: 'xml', toml: 'toml', mermaid: 'mmd' };
  const PREVIEWABLE = ['html', 'svg', 'markdown', 'md', 'json'];

  // ---------------------------------------------------------------- toast / modal / menu
  let toastTimer;
  function toast(msg, isErr) { $('.toast')?.remove(); const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg); document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200); }
  function modal({ title, body, footer, wide }) {
    const bd = el('div', { class: 'backdrop', onclick: (e) => { if (e.target === bd) close(); } });
    const m = el('div', { class: 'modal', style: wide ? 'width:min(900px,100%)' : '' },
      el('header', {}, el('h3', {}, title), el('span', { class: 'spacer' }), el('button', { class: 'btn quiet icon sm', onclick: () => close(), 'aria-label': 'close' }, I('x', 'sm'))),
      el('div', { class: 'body' }, body), footer ? el('footer', {}, footer) : null);
    bd.append(m); $('#layer').append(bd);
    function close() { bd.remove(); document.removeEventListener('keydown', esc_); }
    const esc_ = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc_);
    return { close, root: m };
  }
  const confirmDialog = (text, okLabel = 'Delete') => new Promise((res) => { const m = modal({ title: 'Are you sure?', body: el('p', { style: 'margin:0' }, text), footer: [el('button', { class: 'btn', onclick: () => { m.close(); res(false); } }, 'Cancel'), el('button', { class: 'btn danger', onclick: () => { m.close(); res(true); } }, okLabel)] }); });
  const promptDialog = (title, value, help) => new Promise((res) => { const inp = el('input', { class: 'input', value }); const m = modal({ title, body: [inp, help ? el('div', { class: 'muted tiny' }, help) : null], footer: [el('button', { class: 'btn', onclick: () => { m.close(); res(null); } }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => { m.close(); res(inp.value.trim()); } }, 'OK')] }); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { m.close(); res(inp.value.trim()); } }); setTimeout(() => inp.focus(), 0); });
  function menu(anchor, items, { searchable = false, onPick, filter = '' } = {}) {
    $('.menu')?.remove();
    const r = anchor.getBoundingClientRect();
    const m = el('div', { class: 'menu', style: `left:${Math.min(r.left, window.innerWidth - 440)}px; top:${r.bottom + 6}px` });
    let list;
    const visible = (it, ql) => !it.group && (!ql || (it.label + ' ' + (it.sub || '')).toLowerCase().includes(ql));
    // label hits rank above description hits, so "/th" offers /think before "new chat in this pane"
    const ranked = (ql) => ql ? items.filter((it) => visible(it, ql)).sort((a, b) => (a.label.toLowerCase().includes(ql) ? 0 : 1) - (b.label.toLowerCase().includes(ql) ? 0 : 1)) : items;
    const render = (q = '') => {
      list.innerHTML = ''; const ql = q.toLowerCase();
      for (const it of ranked(ql)) {
        if (it.group) { if (!q) list.append(el('div', { class: 'mgroup' }, it.group)); continue; }
        list.append(el('div', { class: 'mitem' + (it.selected ? ' sel' : '') + (it.dim ? ' dim' : ''), title: it.title || '', onclick: () => { m.remove(); onPick(it); } }, it.icon ? I(it.icon, 'sm') : null, el('span', { class: 'truncate' }, it.label), it.sub ? el('span', { class: 'sub' }, it.sub) : null, it.selected ? I('check', 'sm') : null));
      }
      if (!list.children.length) list.append(el('div', { class: 'mitem muted' }, 'no matches'));
    };
    if (searchable) { const inp = el('input', { class: 'input', placeholder: 'Search…', oninput: () => render(inp.value) }); m.append(el('div', { class: 'msearch' }, inp)); setTimeout(() => inp.focus(), 0); }
    list = el('div'); m.append(list); render(filter);
    document.body.append(m);
    const off = (e) => { if (!m.contains(e.target) && e.target !== anchor) { m.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
    if (m.getBoundingClientRect().bottom > window.innerHeight) m.style.top = Math.max(8, r.top - m.offsetHeight - 6) + 'px';
    let cur = filter;
    return { el: m, rerender: (q) => { cur = q; render(q); }, pickFirst: () => { const it = ranked(cur.toLowerCase()).find((x) => !x.group); if (it) { m.remove(); onPick(it); } } };
  }
  const switchEl = (checked, onchange) => { const b = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!checked), onclick: () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onchange(v); } }); return b; };
  const field = (label, control, help) => el('div', { class: 'field' }, el('label', {}, label), control, help ? el('div', { class: 'help' }, help) : null);

  // ---------------------------------------------------------------- auth / api
  let token = localStorage.getItem('missile_token') || new URLSearchParams(location.search).get('token') || '';
  if (new URLSearchParams(location.search).get('token')) { localStorage.setItem('missile_token', token); history.replaceState({}, '', location.pathname); }
  const headers = () => ({ 'X-Requested-With': 'missile-admin', ...(token ? { Authorization: 'Bearer ' + token } : {}) });
  // plain links need their own credential: cookie sessions just work, token users get ?token= on the URL
  const downloadUrl = (p) => '/api/workspace/download?path=' + encodeURIComponent(p) + (token ? '&token=' + encodeURIComponent(token) : '');
  const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop() || 'file';
  function saveBlob(name, text, type = 'text/plain;charset=utf-8') { const u = URL.createObjectURL(new Blob([text], { type })); const a = el('a', { href: u, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 3000); }
  async function api(path, opts = {}) {
    const o = { ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers(), ...(opts.headers || {}) } };
    if (o.body && typeof o.body !== 'string' && !(o.body instanceof FormData)) o.body = JSON.stringify(o.body);
    const r = await fetch(path, o);
    if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
    if (!r.ok) { let d = ''; try { d = (await r.json()).detail; } catch { d = await r.text(); } throw new Error(typeof d === 'string' ? d : JSON.stringify(d)); }
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }
  function showLogin() {
    $('#login').classList.remove('hidden'); $('#app').classList.add('hidden');
    const mode = (S.health && S.health.signup) || 'off';
    $('#toSignup').classList.toggle('hidden', mode === 'off');
    $('#suInvite').classList.toggle('hidden', mode !== 'invite');
  }
  document.querySelectorAll('.logo-slot').forEach((s) => { s.innerHTML = window.logoMark(28); });
  const swapAuth = (signup) => { $('#loginForm').classList.toggle('hidden', signup); $('#signupForm').classList.toggle('hidden', !signup); $('#loginErr').textContent = ''; $('#suErr').textContent = ''; };
  $('#toSignupLink').addEventListener('click', (e) => { e.preventDefault(); swapAuth(true); setTimeout(() => $('#suUser').focus(), 0); });
  $('#toLoginLink').addEventListener('click', (e) => { e.preventDefault(); swapAuth(false); });
  $('#signupForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('#suErr'); err.textContent = '';
    if ($('#suPass').value !== $('#suPass2').value) { err.textContent = 'The passwords differ.'; return; }
    try {
      token = ''; localStorage.removeItem('missile_token');
      await api('/api/admin/auth/signup', { method: 'POST', body: { username: $('#suUser').value.trim(), password: $('#suPass').value, invite_code: $('#suInvite').value.trim(), remember: true } });
      swapAuth(false); $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); await boot();
    } catch (e2) {
      const m = e2.message || '';
      err.textContent = m === 'bad_invite_code' ? 'That invite code is not right.' : m === 'username_taken' ? 'That username is taken.' : m === 'signup_closed' ? 'Sign-up is closed.' : m === 'rate_limited' ? 'Too many attempts. Wait a minute.' : (m || 'Could not create the account.');
    }
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const err = $('#loginErr'); err.textContent = '';
    const tokenVal = $('#loginToken').value.trim();
    try {
      if (tokenVal) { token = tokenVal; await api('/api/login', { method: 'POST', body: { token } }); localStorage.setItem('missile_token', token); }
      else {
        // admin account: the cookie session covers the studio and /admin; no token is kept in this browser
        token = ''; localStorage.removeItem('missile_token');
        await api('/api/admin/auth/login', { method: 'POST', body: { username: $('#loginUser').value.trim(), password: $('#loginPass').value, remember: $('#loginRemember').checked } });
      }
      $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); await boot();
    } catch (e2) { err.textContent = tokenVal ? 'That token was not accepted.' : (e2.message === 'rate_limited' ? 'Too many attempts. Wait a minute.' : 'Wrong username or password.'); }
  });
  async function signOut() { try { await api('/api/admin/auth/logout', { method: 'POST' }); } catch {} token = ''; try { localStorage.removeItem('missile_token'); } catch {} location.reload(); }

  // ---------------------------------------------------------------- state
  const newPane = () => ({ id: Math.random().toString(36).slice(2, 8), convId: null, conv: null, messages: [], branches: {}, sel: {}, attachments: [], draft: '', editing: null, pendingEdit: null });
  const S = { st: null, convs: [], view: 'chat', settingsPage: 'providers', sel: {}, search: '', panes: [newPane()], active: 0, live: {}, linkInputs: false, artifacts: {},
    drawer: { open: false, tab: 'files', path: '.', entries: [], file: null, term: [], loading: false, artifact: null, aTab: 'preview', versions: null } };
  const THEMES = ['dark', 'warm', 'light'];  // dark is the default look
  const theme = {
    get: () => document.documentElement.getAttribute('data-theme') || 'dark',
    set(t) { t = t || 'dark'; document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('missile_theme', t); } catch {} render(); },
    toggle() { const cur = this.get(); this.set(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]); },
  };
  // the stock emoji (🤖 🚀 💬 🧑) are treated as "no emoji": only an emoji the user chose is ever shown
  const STOCK_EMOJI = new Set(['🤖', '🚀', '💬', '🧑', '']);
  // my messages: the owner's photo for admin sessions, otherwise the account's initials (cool tones, no orange)
  // assistants: a custom emoji if one was set, otherwise a small single-colour glyph (lists show nothing at all)
  const assistantGlyph = (a, size) => (a?.emoji && !STOCK_EMOJI.has(a.emoji)) ? el('span', { class: 'avatar emoji' + (size ? ' ' + size : '') }, a.emoji) : el('span', { class: 'glyph' + (size ? ' ' + size : ''), title: a?.name || 'Assistant' }, I('sparkles', size === 'sm' ? 'xs' : 'sm'));
  const customEmoji = (a) => (a?.emoji && !STOCK_EMOJI.has(a.emoji)) ? el('span', { class: 'cemoji' }, a.emoji) : null;
  const userAvatar = () => (S.me && S.me.role === 'admin') ? el('img', { class: 'avatar photo', src: '/static/brand/avatar.png?v=2', alt: '', title: S.me.username || 'me', draggable: 'false' }) : el('span', { class: 'avatar', style: '--a1:#60a5fa;--a2:#8b5cf6', title: S.me?.username || 'me' }, (S.me?.username || 'me').slice(0, 2).toUpperCase());
  async function loadState() { S.st = await api('/api/state'); }
  async function loadConvs() { S.convs = await api('/api/conversations'); }
  const providerOf = (id) => S.st.providers.find((p) => p.id === id);
  const assistantOf = (id) => S.st.assistants.find((a) => a.id === id);
  const styleOf = (id) => (S.st.styles || []).find((s) => s.id === id);
  const isAdmin = () => S.st && S.st.role === 'admin';
  const activePane = () => S.panes[S.active] || S.panes[0];
  const textOf = (m) => typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  function targetOf(pane) {
    const c = pane.conv; const pid = c?.provider_id || pane.sel.provider || S.st.default.provider || S.st.providers[0]?.id || '';
    const p = providerOf(pid);
    const model = c?.model || pane.sel.model || (pid === S.st.default.provider ? S.st.default.model : '') || p?.default_model || p?.models?.[0] || '';
    const aid = c?.assistant_id || pane.sel.assistant || S.st.default.assistant || 'default';
    const sid = pane.sel.style !== undefined ? pane.sel.style : (c?.style_id || '');
    return { pid, model, aid, provider: p, assistant: assistantOf(aid), thinking: pane.sel.thinking || '', styleId: sid, style: styleOf(sid) };
  }
  async function patchConv(pane, body) { if (!pane.conv) return; try { await api('/api/conversations/' + pane.convId, { method: 'PATCH', body }); Object.assign(pane.conv, body); } catch (e) { toast(e.message, true); } }
  async function setStyle(pane, sid) { pane.sel.style = sid === 'normal' ? '' : sid; await patchConv(pane, { style_id: pane.sel.style }); render(); }
  async function setAssistant(pane, aid) { pane.sel.assistant = aid; await patchConv(pane, { assistant_id: aid }); render(); }

  // ---------------------------------------------------------------- shell
  function render() {
    const app = $('#app'); app.innerHTML = '';
    if (S.view.startsWith('settings')) { app.append(renderSettings()); return; }
    const shell = el('div', { class: 'shell' });
    shell.append(renderRail());
    shell.append(S.view === 'assistants' ? renderAssistantPane() : renderConvPane());
    const main = el('div', { class: 'main multi' });
    const panes = el('div', { class: 'panes' });
    S.panes.forEach((p, i) => panes.append(renderPane(p, i)));
    main.append(panes);
    if (S.drawer.open) main.append(renderDrawer());
    shell.append(main);
    app.append(shell);
  }
  function openDrawer(tab) { S.drawer.open = true; if (tab) S.drawer.tab = tab; if (tab === 'artifacts') S.drawer.artifact = null; S.view = 'chat'; render(); if (S.drawer.tab === 'files') loadTree(S.drawer.path); }
  function renderRail() {
    const btn = (name, icon, label, onclick) => el('button', { class: S.view === name || (name === 'settings' && S.view.startsWith('settings')) ? 'active' : '', onclick, 'aria-label': label }, I(icon), el('span', { class: 'tip' }, label));
    const cur = theme.get();
    return el('div', { class: 'rail' },
      el('div', { class: 'logo', html: window.logoMark(34), title: 'missile studio' }),
      btn('chat', 'chat', 'Chat', () => { S.view = 'chat'; render(); }),
      btn('assistants', 'sparkles', 'Assistants', () => { S.view = 'assistants'; render(); }),
      btn('settings', 'settings', 'Settings', () => { S.view = 'settings'; render(); }),
      el('div', { class: 'bottom' },
        el('button', { class: S.drawer.open ? 'active' : '', onclick: () => { if (S.drawer.open) { S.drawer.open = false; render(); } else openDrawer(); }, 'aria-label': 'workspace' }, I('file'), el('span', { class: 'tip' }, 'Workspace · artifacts (Ctrl/⌘ J)')),
        el('button', { onclick: () => openPalette(), 'aria-label': 'search' }, I('search'), el('span', { class: 'tip' }, 'Search & commands (Ctrl/⌘ K)')),
        el('button', { onclick: () => theme.toggle(), 'aria-label': 'theme' }, I(cur === 'dark' ? 'moon' : cur === 'warm' ? 'sparkles' : 'sun'), el('span', { class: 'tip' }, `Theme: ${cur} → ${THEMES[(THEMES.indexOf(cur) + 1) % 3]}`)),
        el('button', { onclick: () => window.open('/admin', '_blank'), 'aria-label': 'admin' }, I('shield'), el('span', { class: 'tip' }, 'Admin console'))));
  }

  // ---------------------------------------------------------------- list panes
  function groupLabel(ts) { const d = new Date(ts * 1000), now = new Date(); if (d.toDateString() === now.toDateString()) return 'Today'; const y = new Date(now); y.setDate(now.getDate() - 1); if (d.toDateString() === y.toDateString()) return 'Yesterday'; if (now - d < 7 * 86400e3) return 'Previous 7 days'; return 'Older'; }
  async function deleteConv(id) {
    if (!(await confirmDialog('Delete this chat and its messages?'))) return;
    await api('/api/conversations/' + id, { method: 'DELETE' });
    for (const p of S.panes) if (p.convId === id) { p.convId = null; p.conv = null; p.messages = []; p.branches = {}; }
    await loadConvs(); render();
  }
  function renderConvPane() {
    const pane = el('div', { class: 'pane' });
    pane.append(el('div', { class: 'pane-head' }, el('h2', {}, 'Chats'), el('span', { class: 'spacer' }), el('button', { class: 'btn primary sm', onclick: () => newConv(activePane()) }, I('plus', 'sm'), 'New chat')));
    const search = el('input', { class: 'input', placeholder: 'Search chats', value: S.search, oninput: (e) => { S.search = e.target.value; renderList(); } });
    pane.append(el('div', { class: 'pane-search' }, I('search', 'sm'), search));
    const list = el('div', { class: 'pane-list' }); pane.append(list);
    const openIds = new Set(S.panes.map((p) => p.convId).filter(Boolean));
    let searchTimer = null;
    function renderList() {
      list.innerHTML = ''; let last = '';
      const q = S.search.toLowerCase();
      const items = S.convs.filter((c) => !q || (c.title || '').toLowerCase().includes(q));
      // titles match instantly; message bodies are searched on the server after a short pause
      clearTimeout(searchTimer);
      if (q.length >= 2) searchTimer = setTimeout(async () => {
        let r; try { r = await api('/api/search?q=' + encodeURIComponent(S.search.trim()) + '&limit=40'); } catch { return; }
        if (S.search.toLowerCase() !== q || !list.isConnected) return;
        const seen = new Set(); const box = el('div', { class: 'srch' }, el('div', { class: 'pane-group' }, 'In messages'));
        for (const h of r.hits) {
          if (seen.has(h.conversation_id)) continue; seen.add(h.conversation_id);
          box.append(el('div', { class: 'pane-item hit', onclick: () => openConv(activePane(), h.conversation_id) }, el('div', { class: 'body' }, el('div', { class: 'title truncate' }, h.title || 'New chat'), el('div', { class: 'snip', html: hl(h.snippet) }))));
        }
        if (seen.size) list.append(box);
      }, 250);
      for (const c of items) {
        const g = groupLabel(c.updated_at); if (g !== last) { list.append(el('div', { class: 'pane-group' }, g)); last = g; }
        const a = assistantOf(c.assistant_id); const running = !!S.live[c.id] || c.running;
        list.append(el('div', { class: 'pane-item' + (activePane().convId === c.id ? ' active' : ''), style: openIds.has(c.id) && activePane().convId !== c.id ? 'box-shadow: inset 0 0 0 1px var(--border)' : '', onclick: () => openConv(activePane(), c.id) },
          el('div', { class: 'body' }, el('div', { class: 'title truncate' }, customEmoji(a), c.title || 'New chat'), el('div', { class: 'sub truncate' }, running ? 'running…' : (shortModel(c.model) || providerOf(c.provider_id)?.label || ''))),
          running ? el('span', { class: 'run', title: 'a turn is running' }) : el('button', { class: 'x', title: 'Delete', onclick: (e) => { e.stopPropagation(); deleteConv(c.id); } }, I('trash', 'xs'))));
      }
      if (!items.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px 10px' }, S.convs.length ? 'No chats match.' : 'No chats yet. Start one.'));
    }
    renderList();
    pane.append(el('div', { class: 'muted tiny', style: 'padding:8px 14px;border-top:1px solid var(--border)' }, S.panes.length > 1 ? `${S.panes.length} panes · clicking a chat opens it in the highlighted pane` : 'Ctrl/⌘ K searches chats and commands · ⫿ splits the view'));
    return pane;
  }
  function renderAssistantPane() {
    const pane = el('div', { class: 'pane' });
    pane.append(el('div', { class: 'pane-head' }, el('h2', {}, 'Assistants'), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: () => { S.view = 'settings'; S.settingsPage = 'assistants'; render(); } }, I('edit', 'sm'), 'Manage')));
    const list = el('div', { class: 'pane-list' }); pane.append(list);
    const cur = targetOf(activePane());
    for (const a of S.st.assistants) list.append(el('div', { class: 'pane-item' + (cur.aid === a.id ? ' active' : ''), onclick: () => setAssistant(activePane(), a.id) }, customEmoji(a) ? el('div', { class: 'em' }, customEmoji(a)) : null, el('div', { class: 'body' }, el('div', { class: 'title truncate' }, a.name), el('div', { class: 'sub truncate' }, (a.system_prompt || 'No system prompt').slice(0, 60)))));
    list.append(el('div', { style: 'padding:10px' }, el('button', { class: 'btn sm', style: 'width:100%', onclick: () => { S.view = 'settings'; S.settingsPage = 'assistants'; S.sel.newAssistant = true; render(); } }, I('plus', 'sm'), 'Add assistant')));
    return pane;
  }

  // ---------------------------------------------------------------- model picker (quick presets + every model) and thinking
  async function applyTarget(pane, pid, model, thinking, presetId) {
    pane.sel.provider = pid; pane.sel.model = model; if (thinking !== undefined) pane.sel.thinking = thinking; pane.sel.preset = presetId || null;
    await patchConv(pane, { provider_id: pid, model });
    render();
  }
  const presetOf = (pane, t) => (S.st.model_presets || []).find((p) => p.id === pane.sel.preset && p.provider === t.pid && p.model === t.model);
  function modelPicker(pane) {
    const t = targetOf(pane);
    const preset = presetOf(pane, t);
    const pill = el('button', { class: 'picker' + (unusable(t.provider) ? ' dim' : ''), title: 'Choose model: quick presets first, then every model' }, el('span', { class: 'pv' }, preset ? preset.label : (t.provider?.label || t.pid || 'no provider').split(' ')[0]), el('span', { class: 'name truncate' }, shortModel(t.model) || 'pick a model'), t.provider ? hdot(t.provider) : null, I('chevron', 'xs'));
    pill.addEventListener('click', () => openModelMenu(pane, pill));
    return pill;
  }
  // the same menu opens from the top-bar pill and from the model label in the composer
  function openModelMenu(pane, anchor) {
      const t = targetOf(pane); const preset = presetOf(pane, t);
      const items = [];
      if ((S.st.model_presets || []).length) {
        items.push({ group: 'Quick' });
        for (const p of S.st.model_presets) { const pp = providerOf(p.provider); const h = healthOf(pp); items.push({ label: `${p.label} · ${shortModel(p.model)}`, sub: `${pp?.label || p.provider}${p.thinking ? ' · ' + THINK_LABEL[p.thinking] : ''}${unusable(pp) ? ' · ' + HEALTH_LABEL[h.state] : ''}`, icon: p.id === 'fast' ? 'activity' : p.id === 'best' ? 'sparkles' : 'brain', pid: p.provider, model: p.model, thinking: p.thinking, presetId: p.id, selected: preset && preset.id === p.id, dim: unusable(pp), title: h.error || '' }); }
      }
      for (const p of S.st.providers) {
        const models = [...new Set([p.default_model, ...(p.models || [])].filter(Boolean))];
        const h = healthOf(p); const bad = unusable(p);
        items.push({ group: (p.label || p.id) + (bad ? ` · ${HEALTH_LABEL[h.state]}` : '') });
        if (!models.length) items.push({ label: '(no models: Discover in Settings)', sub: p.id, pid: p.id, model: '', dim: bad });
        for (const m of models.slice(0, 400)) items.push({ label: shortModel(m), sub: p.id + (bad ? ' · ' + HEALTH_LABEL[h.state] : ''), pid: p.id, model: m, selected: !preset && p.id === t.pid && m === t.model, dim: bad, title: h.error || '' });
      }
      if (!items.length) items.push({ label: 'Add a provider in Settings', sub: '', pid: '', model: '' });
      menu(anchor, items, { searchable: true, onPick: (it) => { if (!it.pid) { S.view = 'settings'; S.settingsPage = 'providers'; render(); return; } applyTarget(pane, it.pid, it.model, it.thinking, it.presetId); } });
  }
  const THINK_ORDER = ['', 'on', 'max', 'off'];
  function cycleThinking(pane) { pane.sel.thinking = THINK_ORDER[(THINK_ORDER.indexOf(pane.sel.thinking || '') + 1) % THINK_ORDER.length]; pane.sel.preset = null; render(); }
  function thinkingButton(pane) {
    const cur = pane.sel.thinking || '';
    return el('button', { class: 'ico' + (cur === 'on' || cur === 'max' ? ' on' : ''), title: `Thinking: ${THINK_LABEL[cur]} · click to cycle (default → on → max → off)`, onclick: () => cycleThinking(pane) }, I('brain', 'sm'));
  }

  // ---------------------------------------------------------------- chat panes
  function focusPane(idx) { if (S.active !== idx) { S.active = idx; document.querySelectorAll('.pane-col').forEach((c, i) => c.classList.toggle('active-pane', i === idx && S.panes.length > 1)); } }
  function renderPane(pane, idx) {
    const t = targetOf(pane);
    const col = el('div', { class: 'pane-col' + (idx === S.active && S.panes.length > 1 ? ' active-pane' : ''), onmousedown: () => focusPane(idx) });
    const asstBtn = el('button', { class: 'btn quiet', style: 'padding:0 8px', title: 'Assistant: ' + (t.assistant?.name || 'Assistant') }, el('span', { class: 'asst' }, customEmoji(t.assistant), S.panes.length > 1 ? (customEmoji(t.assistant) ? null : I('sparkles', 'sm')) : (t.assistant?.name || 'Assistant')), I('chevron', 'xs'));
    asstBtn.addEventListener('click', () => menu(asstBtn, S.st.assistants.map((a) => ({ label: a.name, sub: a.id, id: a.id, selected: a.id === t.aid })), { onPick: (it) => setAssistant(pane, it.id) }));
    const toolsOn = pane.sel.tools !== false;
    const toolsBtn = t.provider?.kind === 'agentserver' ? el('span', { class: 'chip info', title: 'tools run on the agent server' }, I('cloud', 'xs')) : el('button', { class: 'ico' + (toolsOn ? ' on' : ''), title: toolsOn ? `${S.st.tools.length} local tools on · click to turn off` : 'tools off · click to turn on', onclick: () => { pane.sel.tools = !toolsOn; render(); } }, I('wrench', 'sm'));
    const bar = el('div', { class: 'topbar' }, asstBtn, modelPicker(pane), thinkingButton(pane), toolsBtn, el('span', { class: 'spacer' }));
    if (S.panes.length > 1) bar.append(el('button', { class: 'ico' + (S.linkInputs ? ' on' : ''), title: S.linkInputs ? 'inputs linked: one message goes to every pane' : 'link inputs: send one message to every pane (compare models)', onclick: () => { S.linkInputs = !S.linkInputs; render(); } }, I('link', 'sm')));
    if (S.panes.length < MAX_PANES) bar.append(el('button', { class: 'ico', title: 'Split: open another chat beside this one (Ctrl/⌘ \\)', onclick: () => splitPane(idx) }, I('columns', 'sm')));
    if (S.panes.length > 1) bar.append(el('button', { class: 'ico', title: 'Close this pane', onclick: () => closePane(idx) }, I('x', 'sm')));
    if (pane.conv) bar.append(el('button', { class: 'ico', title: 'Delete chat', onclick: () => deleteConv(pane.convId) }, I('trash', 'sm')));
    col.append(bar);
    const scroll = el('div', { class: 'chat-scroll' }); const inner = el('div', { class: 'chat-inner' }); scroll.append(inner); col.append(scroll);
    renderMessages(pane, inner);
    col.append(renderComposer(pane));
    return col;
  }
  function splitPane(idx) { if (S.panes.length >= MAX_PANES) return; const np = newPane(); np.sel = { ...S.panes[idx].sel }; S.panes.splice(idx + 1, 0, np); S.active = idx + 1; S.view = 'chat'; render(); }
  function closePane(idx) { if (S.panes.length <= 1) return; S.panes.splice(idx, 1); S.active = Math.min(S.active, S.panes.length - 1); render(); }
  function toolCard(call, result, live = true) {
    // run = still executing in this live stream · stale = no result and nothing running (a stopped turn) · cancelled results are stale too
    const cancelled = !!result && result.decision === 'cancelled';
    const state = cancelled ? 'stale' : result ? (result.is_error ? 'err' : 'ok') : (live ? 'run' : 'stale');
    const d = el('details', { class: 'tool ' + state, open: state === 'run' || state === 'err' });
    const stateText = cancelled ? 'cancelled' : result ? `${result.decision || (result.is_error ? 'error' : 'ok')}${result.duration_ms != null ? ' · ' + fmtMs(result.duration_ms) : ''}` : (live ? 'running…' : 'no result · stopped');
    d.append(el('summary', {}, el('span', { class: 'dot' }), I('wrench', 'sm'), el('span', { class: 'tname' }, call.name), el('span', { class: 'tstate' }, stateText, I('chevron', 'xs'))));
    const body = el('div', { class: 'tbody' });
    const args = JSON.stringify(call.arguments ?? {}, null, 1);
    body.append(el('div', { class: 'lbl' }, 'arguments'), el('pre', {}, args.length > 2000 ? args.slice(0, 2000) + '…' : args));
    if (result) { body.append(el('div', { class: 'lbl' }, 'result'), linkedPre(String(result.text || result.content || '').slice(0, 6000))); for (const im of result.images || []) body.append(el('img', { src: `data:${im.mime_type || 'image/png'};base64,${im.data}` })); }
    // a file the agent just wrote into the workspace can be taken straight from the card
    if (result && !result.is_error && call.name === 'local__write_file' && call.arguments?.path) body.append(el('a', { class: 'btn sm', style: 'margin-top:8px;display:inline-flex', href: downloadUrl(call.arguments.path), download: baseName(call.arguments.path) }, I('download', 'sm'), 'Download ' + baseName(call.arguments.path)));
    d.append(body);
    return d;
  }
  function assistantTurn(pane, modelName) {
    const t = targetOf(pane);
    const node = el('div', { class: 'turn-ai' }, el('div', { class: 'av' }, assistantGlyph(t.assistant)));
    const body = el('div', { class: 'body' }); node.append(body);
    body.append(el('div', { class: 'head' }, el('span', { class: 'name' }, t.assistant?.name || 'Assistant'), el('span', { class: 'model' }, shortModel(modelName || t.model))));
    const content = el('div'); body.append(content);
    return { node, content, body };
  }
  // ---- artifacts: long fenced blocks (or any html/svg/markdown document) become cards that open in the drawer
  function artifactize(mdEl, msgId, convId) {
    let i = 0;
    mdEl.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement; const text = code.textContent || '';
      const lines = text.split('\n').filter((l, idx, arr) => !(idx === arr.length - 1 && l === '')).length;
      const lang = ((code.className.match(/language-([\w+-]+)/) || [])[1] || '').toLowerCase();
      if (lang === 'replace') return;
      if (lines < 15 && !['html', 'svg', 'markdown', 'md', 'mermaid'].includes(lang)) return;
      const id = `${msgId}-${i++}`;
      const existing = S.artifacts[id];
      const first = text.split('\n')[0] || '';
      const hint = (first.match(/^\s*(?:\/\/|#|<!--|--|\/\*)\s*(?:file(?:name)?:)?\s*([\w./-]+\.[a-z0-9]{1,5})/i) || [])[1];
      const art = existing || { id, lang, code: text, lines, name: hint || `artifact-${Object.keys(S.artifacts).length + 1}.${EXT[lang] || 'txt'}`, convId, msgId, ts: Date.now() };
      S.artifacts[id] = art;
      const card = el('div', { class: 'artifact', 'data-art': id },
        el('div', { class: 'ahead', onclick: () => openArtifact(id) }, el('div', { class: 'aicon' }, I(lang === 'html' || lang === 'svg' ? 'globe' : lang === 'markdown' || lang === 'md' ? 'file' : 'terminal', 'sm')), el('div', { style: 'min-width:0' }, el('div', { class: 'atitle truncate' }, art.name), el('div', { class: 'asub' }, `${lang || 'text'} · ${lines} lines · click to open`)), el('div', { class: 'aactions' }, el('button', { class: 'btn quiet icon sm', title: 'Copy', onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => toast('copied')); } }, I('copy', 'xs')), el('button', { class: 'btn quiet icon sm', title: 'Download', onclick: (e) => { e.stopPropagation(); saveBlob(art.name, text); } }, I('download', 'xs')), isAdmin() ? el('button', { class: 'btn quiet icon sm', title: 'Save to workspace', onclick: (e) => { e.stopPropagation(); saveArtifact(id); } }, I('file', 'xs')) : null)),
        el('details', {}, el('summary', {}, 'show code'), pre.cloneNode(true)));
      pre.replaceWith(card);
    });
  }
  function addCopyButtons(root) { root.querySelectorAll('pre').forEach((pre) => { if (pre.querySelector('.copy-btn') || pre.closest('.tool') || pre.closest('.artifact')) return; pre.append(el('button', { class: 'copy-btn', onclick: () => navigator.clipboard.writeText(pre.innerText.replace(/copy$/, '')).then(() => toast('copied')) }, 'copy')); }); }
  function branchNav(pane, id) {
    const b = pane.branches?.[id]; if (!b) return null;
    const go = async (j) => { try { const c = await api(`/api/conversations/${pane.convId}/head`, { method: 'POST', body: { message_id: b.siblings[j] } }); pane.conv = c; pane.messages = c.messages || []; pane.branches = c.branches || {}; render(); } catch (e) { toast(e.message, true); } };
    return el('span', { class: 'branchnav', title: 'this message has other versions' }, el('button', { disabled: b.index === 0, onclick: () => go(b.index - 1) }, '‹'), `${b.index + 1} / ${b.siblings.length}`, el('button', { disabled: b.index >= b.siblings.length - 1, onclick: () => go(b.index + 1) }, '›'));
  }
  function renderMessages(pane, inner) {
    inner.innerHTML = '';
    const live = pane.convId ? S.live[pane.convId] : null;
    if (!pane.conv || (!pane.messages.length && !live)) {
      const t = targetOf(pane);
      const sugg = ['Summarize the files in my workspace', 'What tools do you have? Show one example each', 'Write a short project README from notes/', 'Build a small HTML page that visualizes a to-do list'];
      inner.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, STOCK_EMOJI.has(t.assistant?.emoji || '') ? el('span', { html: window.logoMark(56) }) : t.assistant.emoji), el('h3', {}, t.assistant?.name ? `Chat with ${t.assistant.name}` : 'What can I help with?'), el('div', {}, t.provider ? `${t.provider.label || t.pid} · ${shortModel(t.model) || 'pick a model'} · ${S.st.tools.length} tools` : 'Add a provider in Settings to start.'), el('div', { class: 'sugg' }, sugg.map((s) => el('button', { onclick: () => { send(pane, s); } }, s)))));
      return;
    }
    const toolResults = {}; for (const m of pane.messages) if (m.role === 'tool') toolResults[m.tool_call_id] = { text: m.content, is_error: m.is_error, images: m.images, decision: m.decision, duration_ms: m.duration_ms };
    let i = 0; let lastUser = null;
    while (i < pane.messages.length) {
      const m = pane.messages[i];
      if (m.role === 'user') {
        lastUser = m;
        const text = textOf(m);
        if (pane.editing === m.id) {
          const ta = el('textarea', { class: 'textarea', style: 'min-height:90px' }); ta.value = text;
          const go = () => { const v = ta.value.trim(); if (!v) return; pane.editing = null; startStream(pane, v, [], { branchFrom: m.id }); };
          inner.append(el('div', { class: 'turn-user' }, el('div', { class: 'edit-box' }, ta, el('div', { class: 'row', style: 'justify-content:flex-end' }, el('span', { class: 'muted tiny', style: 'margin-right:auto' }, 'the original stays reachable with ‹ › below the message'), el('button', { class: 'btn sm', onclick: () => { pane.editing = null; render(); } }, 'Cancel'), el('button', { class: 'btn primary sm', onclick: go }, I('send', 'xs'), 'Send as new branch')))));
          ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } if (e.key === 'Escape') { pane.editing = null; render(); } });
          setTimeout(() => ta.focus(), 0); i++; continue;
        }
        const bub = el('div', { class: 'bubble' }, text);
        for (const p of (Array.isArray(m.content) ? m.content : [])) if (p.type === 'image_url') bub.append(el('img', { src: p.image_url.url }));
        inner.append(el('div', { class: 'turn-user' }, el('span', { class: 'uact' }, el('button', { class: 'btn quiet icon sm', title: 'Edit and resend as a new branch', onclick: () => { pane.editing = m.id; render(); } }, I('edit', 'xs')), el('button', { class: 'btn quiet icon sm', title: 'Copy', onclick: () => navigator.clipboard.writeText(text).then(() => toast('copied')) }, I('copy', 'xs'))), bub, el('div', { class: 'av' }, userAvatar())));
        const nav = branchNav(pane, m.id); if (nav) inner.append(el('div', { class: 'bnav' }, nav));
        i++; continue;
      }
      if (m.role === 'assistant') {
        const { node, content, body } = assistantTurn(pane, m.meta?.model);
        let totalMs = 0, usage = null, lastText = ''; const firstId = m.id;
        while (i < pane.messages.length && pane.messages[i].role !== 'user') {
          const mm = pane.messages[i];
          if (mm.role === 'assistant') {
            if (mm.thinking) content.append(el('details', { class: 'think' }, el('summary', {}, I('brain', 'sm'), 'Thinking'), el('div', { class: 'tbody' }, mm.thinking)));
            if (mm.content) { const mdEl = el('div', { class: 'md', html: md(mm.content) }); artifactize(mdEl, mm.id, pane.convId); content.append(mdEl); lastText = mm.content; }
            if (mm.meta?.error_text) content.append(el('div', { class: 'error-line' }, mm.meta.error_text, /401|credential|api key|unauthorized/i.test(mm.meta.error_text) ? el('button', { class: 'btn sm', style: 'margin-left:10px', onclick: () => { S.view = 'settings'; S.settingsPage = 'providers'; S.sel.providerId = pane.conv?.provider_id || ''; render(); } }, 'Open provider settings') : null));
            for (const c of mm.tool_calls || []) content.append(toolCard(c, toolResults[c.id], !!live));
            if (mm.meta?.duration_ms) totalMs += mm.meta.duration_ms; if (mm.meta?.usage) usage = mm.meta.usage;
          }
          i++;
        }
        const meta = el('div', { class: 'meta' }); if (totalMs) meta.append(el('span', {}, `Processed · ${fmtMs(totalMs)}`)); if (usage) meta.append(el('span', {}, `${usage.input_tokens || 0}↑ ${usage.output_tokens || 0}↓ tokens`));
        const nav = branchNav(pane, firstId); if (nav) meta.append(nav);
        const acts = el('span', { class: 'actions' });
        if (lastText) { const lt = lastText; acts.append(el('button', { class: 'btn quiet icon sm', title: 'Copy answer', onclick: () => navigator.clipboard.writeText(lt).then(() => toast('copied')) }, I('copy', 'xs')), el('button', { class: 'btn quiet icon sm', title: 'Download answer as Markdown (.md)', onclick: () => saveBlob(((pane.conv?.title || 'answer').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 50) || 'answer') + '.md', lt, 'text/markdown;charset=utf-8') }, I('download', 'xs'))); }
        if (lastUser) { const lu = lastUser; acts.append(el('button', { class: 'btn quiet icon sm', title: 'Retry: ask again as a new branch', onclick: () => startStream(pane, textOf(lu), [], { branchFrom: lu.id }) }, I('refresh', 'xs'))); }
        meta.append(acts); body.append(meta); inner.append(node); continue;
      }
      i++;
    }
    if (live) { if (live.userNode) inner.append(live.userNode); inner.append(live.node); }
    addCopyButtons(inner);
    requestAnimationFrame(() => { inner.parentElement.scrollTop = inner.parentElement.scrollHeight; });
  }

  // ---------------------------------------------------------------- composer: pills, style, "/" commands, long paste as a file
  function renderComposer(pane) {
    const t = targetOf(pane); const live = pane.convId ? S.live[pane.convId] : null;
    const wrap = el('div', { class: 'composer-wrap' });
    const box = el('div', { class: 'composer' });
    const pills = el('div', { class: 'pills' }); box.append(pills);
    const ta = el('textarea', { class: 'composerInput', rows: 1, placeholder: t.provider ? (S.linkInputs && S.panes.length > 1 ? 'Message every pane. Enter to send, "/" for commands.' : 'Type a message. Enter to send, Shift+Enter for a new line, "/" for commands.') : 'Add a provider in Settings first…' });
    ta.value = pane.draft || '';
    let slash = null;
    const closeSlash = () => { if (slash) { slash.el.remove(); slash = null; } };
    ta.addEventListener('input', () => {
      pane.draft = ta.value; ta.style.height = 'auto'; ta.style.height = Math.min(260, ta.scrollHeight) + 'px';
      const m = ta.value.match(/^\/(\S*)$/);
      if (m) { if (slash) slash.rerender(m[1]); else slash = openSlash(pane, ta, m[1]); } else closeSlash();
    });
    ta.addEventListener('keydown', (e) => {
      if (slash && e.key === 'Enter') { e.preventDefault(); const s = slash; slash = null; s.pickFirst(); return; }
      if (slash && e.key === 'Escape') { closeSlash(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(pane); }
    });
    ta.addEventListener('blur', () => setTimeout(closeSlash, 150));
    ta.addEventListener('focus', () => { const idx = S.panes.indexOf(pane); if (idx >= 0) focusPane(idx); });
    ta.addEventListener('paste', async (e) => {
      const items = e.clipboardData?.items || []; let handled = false;
      for (const it of items) if (it.type.startsWith('image/')) { handled = true; const fd = new FormData(); fd.append('file', it.getAsFile(), 'pasted.png'); try { pane.attachments.push(await api('/api/upload', { method: 'POST', body: fd })); renderPills(); } catch (err) { toast(err.message, true); } }
      const text = e.clipboardData?.getData('text/plain') || '';
      if (!handled && text.length > 2000) { e.preventDefault(); pane.attachments.push({ name: `pasted-${pane.attachments.length + 1}.txt`, text }); renderPills(); toast('long paste attached as a file'); }
    });
    box.append(ta);
    const fileInput = el('input', { type: 'file', multiple: true, style: 'display:none', onchange: async (e) => { for (const f of e.target.files) { const fd = new FormData(); fd.append('file', f); try { pane.attachments.push(await api('/api/upload', { method: 'POST', body: fd })); } catch (err) { toast(`${f.name}: ${err.message}`, true); } } e.target.value = ''; renderPills(); } });
    const modelBtn = el('button', { class: 'btn quiet sm modelbtn' + (unusable(t.provider) ? ' dim' : ''), title: 'Change model (same menu as the pill in the top bar)' }, el('span', { class: 'truncate' }, t.provider ? `${t.provider.label || t.pid} · ${shortModel(t.model)}` : 'pick a model'), t.provider ? hdot(t.provider) : null, I('chevron', 'xs'));
    modelBtn.addEventListener('click', () => openModelMenu(pane, modelBtn));
    // permission mode for this chat (research and knowledge need no switch: the model looks things up when a question needs it)
    const perm = permOf(pane);
    const permBtn = el('button', { class: 'btn quiet sm' + (perm ? ' on' : ''), title: PERM[perm][1] }, I('shield', 'sm'), PERM[perm][0]);
    permBtn.addEventListener('click', () => menu(permBtn, Object.entries(PERM).map(([id, [label, sub]]) => ({ label, sub, id, selected: id === perm })), { onPick: (it) => setPerm(pane, it.id) }));
    const styleBtn = el('button', { class: 'btn quiet sm', title: 'Writing style' }, I('wand', 'sm'), t.style && t.style.id !== 'normal' ? t.style.name : 'Style');
    styleBtn.addEventListener('click', () => menu(styleBtn, (S.st.styles || []).map((s) => ({ label: s.name, sub: s.prompt ? s.prompt.slice(0, 40) + '…' : '', id: s.id, selected: s.id === (t.styleId || 'normal') })), { onPick: (it) => setStyle(pane, it.id) }));
    const bar = el('div', { class: 'bar' },
      el('button', { class: 'btn quiet icon sm', title: 'Attach file or image', onclick: () => fileInput.click() }, I('paperclip', 'sm')), fileInput,
      el('button', { class: 'btn quiet icon sm', title: 'New chat in this pane (Ctrl/⌘ Shift O)', onclick: () => newConv(pane) }, I('plus', 'sm')),
      styleBtn, permBtn,
      el('span', { class: 'spacer' }),
      modelBtn,
      live ? el('button', { class: 'stop', onclick: () => stopTurn(pane) }, I('stop', 'sm'), 'Stop') : el('button', { class: 'send', title: 'Send', onclick: () => send(pane), disabled: !t.provider }, I('send', 'sm')));
    box.append(bar); wrap.append(box);
    function renderPills() {
      pills.innerHTML = '';
      const toolsOn = pane.sel.tools !== false;
      if (t.provider?.kind !== 'agentserver') pills.append(el('span', { class: 'chip' + (toolsOn ? ' primary' : ''), title: toolsOn ? (catalogOn() ? 'tools on · the model gets a catalog and loads what it needs' : 'local tools on') : 'local tools off' }, I('wrench', 'xs'), toolsOn ? `${S.st.tools.length} tools${catalogOn() ? ' · on demand' : ''}` : 'tools off', el('button', { title: toolsOn ? 'turn tools off' : 'turn tools on', onclick: () => { pane.sel.tools = !toolsOn; render(); } }, toolsOn ? '✕' : '＋')));
      if (pane.sel.thinking) pills.append(el('span', { class: 'chip info' }, I('brain', 'xs'), THINK_LABEL[pane.sel.thinking], el('button', { title: 'back to provider default', onclick: () => { pane.sel.thinking = ''; render(); } }, '✕')));
      if (pane.sel.research) pills.append(el('span', { class: 'chip info' }, I('globe', 'xs'), 'research', el('button', { title: 'normal mode', onclick: () => { pane.sel.research = false; render(); } }, '✕')));
      if (pane.sel.knowledge) pills.append(el('span', { class: 'chip' }, I('box', 'xs'), 'knowledge', el('button', { title: 'no knowledge retrieval', onclick: () => { pane.sel.knowledge = false; render(); } }, '✕')));
      if (t.style && t.style.id !== 'normal') pills.append(el('span', { class: 'chip' }, I('wand', 'xs'), t.style.name, el('button', { title: 'normal style', onclick: () => setStyle(pane, '') }, '✕')));
      pane.attachments.forEach((a, i) => pills.append(el('span', { class: 'chip' }, a.data_url ? '🖼' : '📄', a.name, el('button', { onclick: () => { pane.attachments.splice(i, 1); renderPills(); } }, '✕'))));
      pills.classList.toggle('hidden', !pills.children.length);
    }
    renderPills();
    return wrap;
  }
  function openSlash(pane, ta, q) {
    const items = [{ group: 'Commands' },
      { label: '/new', sub: 'new chat in this pane', icon: 'plus', run: () => newConv(pane) },
      { label: '/split', sub: 'open another pane', icon: 'columns', run: () => splitPane(S.panes.indexOf(pane)) },
      { label: '/files', sub: 'open the workspace drawer', icon: 'file', run: () => openDrawer('files') },
      { label: '/terminal', sub: 'open the terminal', icon: 'terminal', run: () => openDrawer('terminal') },
      { label: '/artifacts', sub: 'open generated artifacts', icon: 'box', run: () => openDrawer('artifacts') },
      { label: '/tools', sub: pane.sel.tools === false ? 'turn local tools on' : 'turn local tools off', icon: 'wrench', run: () => { pane.sel.tools = pane.sel.tools === false; render(); } },
      { label: '/think', sub: 'cycle thinking: default → on → max → off', icon: 'brain', run: () => cycleThinking(pane) },
      { label: '/research', sub: pane.sel.research ? 'back to automatic (the model looks things up when needed)' : 'force the full research mode: sub-questions, sources, cited report', icon: 'globe', run: () => { pane.sel.research = !pane.sel.research; render(); } },
      { label: '/knowledge', sub: pane.sel.knowledge ? 'back to automatic retrieval' : 'force more knowledge-base excerpts for every message', icon: 'box', run: () => { pane.sel.knowledge = !pane.sel.knowledge; render(); } },
      { label: '/permissions', sub: 'cycle the permission mode: Ask → Allow all → Read-only', icon: 'shield', run: () => { const ks = Object.keys(PERM); setPerm(pane, ks[(ks.indexOf(permOf(pane)) + 1) % ks.length]); } },
      { label: '/remember', sub: 'save a memory: /remember <fact>', icon: 'brain', insert: 'Remember this for future chats: ' },
      { label: '/clear', sub: 'clear the draft', icon: 'x', run: () => { pane.draft = ''; render(); } },
      { group: 'Assistants' }, ...S.st.assistants.map((a) => ({ label: `/assistant ${a.id}`, sub: a.name, icon: 'sparkles', run: () => setAssistant(pane, a.id) })),
      { group: 'Styles' }, ...(S.st.styles || []).map((s) => ({ label: `/style ${s.id}`, sub: s.name, icon: 'wand', run: () => setStyle(pane, s.id) })),
      { group: 'Tools (inserts a request to use the tool)' }, ...S.st.tools.map((tl) => ({ label: `/tool ${tl.full_name}`, sub: (tl.description || '').slice(0, 50), icon: 'wrench', insert: `Use the \`${tl.full_name}\` tool to ` }))];
    return menu(ta, items, { filter: q, onPick: (it) => { if (it.insert) { ta.value = it.insert; pane.draft = ta.value; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } else { ta.value = ''; pane.draft = ''; it.run(); } } });
  }
  function newConv(pane) { pane.convId = null; pane.conv = null; pane.messages = []; pane.branches = {}; pane.editing = null; S.view = 'chat'; render(); $('.composerInput', paneEl(pane))?.focus(); }
  async function openConv(pane, id) {
    const c = await api('/api/conversations/' + id); pane.convId = id; pane.conv = c; pane.messages = c.messages || []; pane.branches = c.branches || {}; pane.editing = null; S.view = 'chat'; render();
    if ((S.convs.find((x) => x.id === id) || {}).running && !S.live[id]) attachStream(pane, id);  // a turn still running on the server: follow it
  }
  async function stopTurn(pane) { if (pane.convId) await api(`/api/chat/${pane.convId}/stop`, { method: 'POST' }).catch(() => {}); const live = S.live[pane.convId]; if (live?.abort) live.abort.abort(); }
  async function refreshConv(convId) {
    let c; try { c = await api('/api/conversations/' + convId); } catch { return; }
    for (const p of S.panes) if (p.convId === convId) { p.conv = c; p.messages = c.messages || []; p.branches = c.branches || {}; }
    try { await loadConvs(); } catch {}
  }

  // ---------------------------------------------------------------- sending (one stream per conversation, many at once)
  const paneEl = (pane) => document.querySelectorAll('.pane-col')[S.panes.indexOf(pane)] || document;
  async function send(pane, forcedText) {
    const ta = $('.composerInput', paneEl(pane)); const text = (forcedText || ta?.value || '').trim(); if (!text) return;
    if (S.linkInputs && S.panes.length > 1 && !forcedText) { for (const p of S.panes) { p.draft = ''; startStream(p, text, p === pane ? pane.attachments.splice(0) : []); } return; }
    pane.draft = '';
    await startStream(pane, text, pane.attachments.splice(0));
  }
  async function startStream(pane, text, atts, opts = {}) {
    const t = targetOf(pane); if (!t.pid) return toast('Add a provider first (Settings → Model providers)', true);
    if (pane.convId && S.live[pane.convId]) return toast('this chat is still answering; open a new pane to run another', true);
    // a hosted provider without a saved key almost always answers 401: say so once, but still send (gateways and local servers need none)
    S.warnedNoKey = S.warnedNoKey || {};
    if (t.provider && t.provider.has_key === false && t.provider.kind !== 'agentserver' && !/127\.0\.0\.1|localhost|\[::1\]|\.local\b|^http:\/\/(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(t.provider.base_url || '') && !S.warnedNoKey[t.pid]) { S.warnedNoKey[t.pid] = true; toast(`${t.provider.label || t.pid} has no API key saved. If this fails with 401, add one in Settings → Model providers.`, true); }
    if (!pane.conv) { try { pane.conv = await api('/api/conversations', { method: 'POST', body: { assistant_id: t.aid, provider_id: t.pid, model: t.model } }); } catch (e) { return toast(e.message, true); } pane.convId = pane.conv.id; pane.messages = []; pane.branches = {}; await loadConvs(); }
    const convId = pane.convId;
    if (opts.branchFrom) { const idx = pane.messages.findIndex((m) => m.id === opts.branchFrom); if (idx >= 0) pane.messages = pane.messages.slice(0, idx); }
    const userNode = el('div', { class: 'turn-user' }, el('div', { class: 'bubble' }, text, ...atts.filter((a) => a.data_url).map((a) => el('img', { src: a.data_url }))), el('div', { class: 'av' }, userAvatar()));
    const { node, content } = assistantTurn(pane, t.model);
    const live = { convId, node, userNode, content, abort: new AbortController(), textBuf: '', thinkBuf: '', mdEl: null, thinkEl: null, statusEl: null, cards: {} };
    S.live[convId] = live;
    render();
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify({ conversation_id: convId, text, provider_id: t.pid, model: t.model, assistant_id: t.aid, attachments: atts, tools: opts.tools !== undefined ? opts.tools : (pane.sel.tools === false ? 'none' : null), thinking: t.thinking, style_id: t.styleId || '', branch_from: opts.branchFrom || '', mode: pane.sel.research ? 'research' : '', knowledge: !!pane.sel.knowledge, permission: permOf(pane) }), signal: live.abort.signal });
      if (!r.ok) throw new Error((await r.text()) || r.statusText);
      await pumpStream(r, pane, live);
    } catch (e) { if (e.name !== 'AbortError') content.append(el('div', { class: 'error-line' }, e.message)); await endLive(pane, live); }
  }
  // A turn that is running on the server while this tab was away: replay its buffered events into a live node, then follow.
  async function attachStream(pane, convId) {
    if (!convId || S.live[convId]) return false;
    let r; try { r = await fetch(`/api/chat/${convId}/stream?after=0`, { headers: headers() }); } catch { return false; }
    if (!r.ok) return false;
    const lastUser = [...pane.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) pane.messages = pane.messages.slice(0, pane.messages.indexOf(lastUser) + 1);  // the buffer re-renders this turn
    const t = targetOf(pane); const { node, content } = assistantTurn(pane, t.model);
    const live = { convId, node, userNode: null, content, abort: new AbortController(), textBuf: '', thinkBuf: '', mdEl: null, thinkEl: null, statusEl: null, cards: {}, attached: true };
    S.live[convId] = live; render();
    try { await pumpStream(r, pane, live); } catch (e) { if (e.name !== 'AbortError') content.append(el('div', { class: 'error-line' }, e.message)); await endLive(pane, live); }
    return true;
  }
  async function endLive(pane, live) { if (S.live[live.convId] !== live) return; delete S.live[live.convId]; await refreshConv(live.convId); render(); if (pane.pendingEdit) finishSelectionEdit(pane); refreshHealth(true); }
  async function pumpStream(r, pane, live) {
    const { node, content } = live;
    const scrollOf = () => { const inner = node.closest('.chat-inner'); return inner ? inner.parentElement : null; };
    const flush = () => { if (!live.mdEl) { live.mdEl = el('div', { class: 'md cursor' }); content.append(live.mdEl); } live.mdEl.innerHTML = md(live.textBuf); const sc = scrollOf(); if (sc) sc.scrollTop = sc.scrollHeight; };
    const status = (text, keep) => { if (!text) { live.statusEl?.remove(); live.statusEl = null; return; } if (!live.statusEl) { live.statusEl = el('div', { class: 'status-line' }); content.append(live.statusEl); } live.statusEl.innerHTML = ''; live.statusEl.append(I('activity', 'xs'), text); if (!keep) setTimeout(() => { if (live.statusEl && live.statusEl.textContent === text) { live.statusEl.remove(); live.statusEl = null; } }, 6000); };
    try {
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx; while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'); if (!data) continue;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          handle(ev);
        }
      }
    } finally { await endLive(pane, live); }
    function handle(ev) {
      switch (ev.type) {
        case 'text_delta': live.textBuf += ev.text; flush(); break;
        case 'thinking_delta': live.thinkBuf += ev.text; if (!live.thinkEl) { const d = el('details', { class: 'think', open: true }, el('summary', {}, I('brain', 'sm'), 'Thinking')); live.thinkEl = el('div', { class: 'tbody' }); d.append(live.thinkEl); content.prepend(d); } live.thinkEl.textContent = live.thinkBuf; break;
        case 'tool_call': { if (live.mdEl) live.mdEl.classList.remove('cursor'); live.mdEl = null; live.textBuf = ''; const c = toolCard(ev, null); live.cards[ev.id] = { card: c, call: ev }; content.append(c); const sc = scrollOf(); if (sc) sc.scrollTop = sc.scrollHeight; break; }
        case 'tool_result': { const k = live.cards[ev.id]; const nc = toolCard(k ? k.call : { name: ev.name, arguments: {} }, ev); if (k) k.card.replaceWith(nc); else content.append(nc); live.cards[ev.id] = { card: nc, call: k ? k.call : { name: ev.name } }; if (S.drawer.open && /write|edit|create|move|delete|run_shell/.test(ev.name)) loadTree(S.drawer.path); break; }
        case 'approval_required': { const a = el('div', { class: 'approval', 'data-approval': ev.id }, el('div', { class: 'ttl' }, I('alert', 'sm'), `${ev.name} wants to run`, el('span', { class: 'muted tiny', style: 'font-weight:400' }, ev.reason || '')), el('pre', {}, JSON.stringify(ev.arguments, null, 1).slice(0, 2000)), el('div', { class: 'row' }, ...[['Allow once', 'allow', 'btn primary sm'], ['Allow for this chat', 'allow_session', 'btn sm'], ['Always allow', 'allow_always', 'btn sm'], ['Deny', 'deny', 'btn danger sm']].map(([l, d, cls]) => el('button', { class: cls, onclick: async () => { await api('/api/approvals/' + ev.id, { method: 'POST', body: { decision: d } }).catch((e) => toast(e.message, true)); a.remove(); } }, l)))); content.append(a); const sc = scrollOf(); if (sc) sc.scrollTop = sc.scrollHeight; break; }
        case 'remote_tool': status(`${ev.event} ${ev.name || ''}`, true); break;
        case 'status': {
          const d = ev.data || {};
          if (ev.event === 'retry') status(`provider busy, retrying (attempt ${d.attempt + 1}/3)…`, true);
          else if (ev.event === 'compacting') status('long thread: compacting the earlier part into a summary…', true);
          else if (ev.event === 'compacted') status(`history compacted · ${d.kept} recent messages kept verbatim`);
          else if (ev.event === 'tool_catalog') status(`tool catalog: ${(d.loaded || []).length} of ${d.total} tools defined · the model loads the rest as needed`);
          else if (ev.event === 'tools_loaded') status(`loaded tools: ${(d.names || []).map((n) => n.split('__').pop()).join(', ')}`);
          else if (ev.event === 'knowledge') status(`${(d.hits || []).length} knowledge excerpts in context${d.auto ? ' (automatic)' : ''}: ${(d.hits || []).map((h) => baseName(h.path)).slice(0, 4).join(', ')}`);
          else if (ev.event === 'max_iterations') status('tool-call limit reached — answering with what it found', true);
          else if (ev.event === 'tools_unsupported') status('this model server cannot take tool definitions: switching to prompt-based tool calls', true);
          else if (ev.event === 'tools_via_prompt') status('tools go through the prompt on this server (no tool parser): calls are parsed from the text');
          else status(`${ev.event}…`, true);
          break;
        }
        case 'error': content.append(el('div', { class: 'error-line' }, ev.message)); break;
        case 'done': status(''); if (live.mdEl) live.mdEl.classList.remove('cursor'); break;
      }
    }
  }
  // provider reachability: the server already marks a provider down the moment a live turn fails (no regex
  // gate, any provider-level error counts), so refreshHealth() just needs to run soon after. endLive() calls
  // it with force=true right when a turn ends; the 60s interval is only the floor for an otherwise idle screen.
  async function refreshHealth(force) { if (!S.st) return; try { const h = await api('/api/providers/health'); let changed = false; for (const p of S.st.providers) { const n = h[p.id]; if (n && (p.health?.state !== n.state || p.health?.error !== n.error)) { p.health = n; changed = true; } } if ((changed || force) && S.view === 'chat' && !Object.keys(S.live).length && !/TEXTAREA|INPUT/.test(document.activeElement?.tagName || '')) render(); } catch {} }
  setInterval(() => refreshHealth(false), 60000);
  setInterval(async () => { if (!S.st || S.view !== 'chat') return; try { const before = S.convs.map((c) => c.id + c.running).join(); await loadConvs(); const after = S.convs.map((c) => c.id + c.running).join(); if (before !== after && !Object.keys(S.live).length) { const list = $('.pane'); if (list) list.replaceWith(renderConvPane()); } for (const p of S.panes) { const c = S.convs.find((x) => x.id === p.convId); if (c && c.running && !S.live[p.convId]) attachStream(p, p.convId); } } catch {} }, 6000);
  // a deployed update: when the server's version no longer matches the assets this tab loaded, reload (between turns) so nobody keeps an old UI
  const LOADED_VERSION = (document.querySelector('script[src*="app.js"]')?.getAttribute('src') || '').split('v=')[1] || '';
  setInterval(async () => { try { const h = await fetch('/api/health').then((r) => r.json()); if (LOADED_VERSION && h.version && h.version !== LOADED_VERSION && !Object.keys(S.live).length) { toast(`Updated to ${h.version}, reloading…`); setTimeout(() => location.reload(), 1200); } } catch {} }, 45000);

  // ---------------------------------------------------------------- palette (Ctrl/⌘ K) + shortcuts (Ctrl/⌘ /)
  function openPalette() {
    $('.palette')?.remove();
    const ov = el('div', { class: 'palette', onclick: (e) => { if (e.target === ov) close(); } });
    const inp = el('input', { placeholder: 'Search chats, run a command, or type a question…' });
    const list = el('div', { class: 'list' });
    ov.append(el('div', { class: 'box' }, inp, list)); document.body.append(ov);
    let hl = 0, rows = [];
    const actions = [
      { label: 'New chat', sub: 'Ctrl/⌘ Shift O', icon: 'plus', run: () => newConv(activePane()) },
      { label: 'Split pane', sub: 'Ctrl/⌘ \\', icon: 'columns', run: () => splitPane(S.active) },
      { label: 'Toggle workspace drawer', sub: 'Ctrl/⌘ J', icon: 'file', run: () => { if (S.drawer.open) { S.drawer.open = false; render(); } else openDrawer(); } },
      { label: 'Artifacts', sub: 'generated code & documents', icon: 'box', run: () => openDrawer('artifacts') },
      { label: 'Link pane inputs', sub: S.linkInputs ? 'on' : 'off', icon: 'link', run: () => { S.linkInputs = !S.linkInputs; render(); } },
      { label: 'Theme: dark / warm / light', sub: theme.get(), icon: 'moon', run: () => theme.toggle() },
      { label: 'Settings · Model providers', icon: 'cloud', run: () => { S.view = 'settings'; S.settingsPage = 'providers'; render(); } },
      { label: 'Settings · MCP servers', icon: 'plug', run: () => { S.view = 'settings'; S.settingsPage = 'mcp'; render(); } },
      { label: 'Settings · Tools & policy', icon: 'wrench', run: () => { S.view = 'settings'; S.settingsPage = 'tools'; render(); } },
      { label: 'Settings · Assistants', icon: 'sparkles', run: () => { S.view = 'settings'; S.settingsPage = 'assistants'; render(); } },
      { label: 'Settings · Writing styles', icon: 'wand', run: () => { S.view = 'settings'; S.settingsPage = 'styles'; render(); } },
      { label: 'Admin console', icon: 'shield', run: () => window.open('/admin', '_blank') },
      { label: 'Keyboard shortcuts', sub: 'Ctrl/⌘ /', icon: 'info', run: () => openShortcuts() },
      ...(S.health?.auth_required ? [{ label: 'Sign out', sub: 'end this session', icon: 'x', run: () => signOut() }] : []),
    ];
    const build = () => {
      const q = inp.value.trim(); const ql = q.toLowerCase(); list.innerHTML = ''; rows = [];
      const addRow = (node, run) => { const i = rows.length; rows.push({ node, run }); node.addEventListener('click', () => { close(); run(); }); node.addEventListener('mousemove', () => { hl = i; paint(); }); list.append(node); };
      const chats = S.convs.filter((c) => !ql || (c.title || '').toLowerCase().includes(ql)).slice(0, ql ? 12 : 6);
      if (chats.length) { list.append(el('div', { class: 'grp' }, 'Chats')); for (const c of chats) { const a = assistantOf(c.assistant_id); addRow(el('div', { class: 'it' }, customEmoji(a) || I('chat', 'sm'), el('span', { class: 'truncate' }, c.title || 'New chat'), el('span', { class: 'sub' }, shortModel(c.model))), () => openConv(activePane(), c.id)); } }
      const acts = actions.filter((a) => !ql || (a.label + ' ' + (a.sub || '')).toLowerCase().includes(ql));
      if (acts.length) { list.append(el('div', { class: 'grp' }, 'Commands')); for (const a of acts) addRow(el('div', { class: 'it' }, I(a.icon, 'sm'), el('span', {}, a.label), a.sub ? el('span', { class: 'sub' }, a.sub) : null), a.run); }
      if (q) { list.append(el('div', { class: 'grp' }, 'Ask')); addRow(el('div', { class: 'it' }, I('send', 'sm'), el('span', { class: 'truncate' }, `Ask: ${q}`), el('span', { class: 'sub' }, 'Enter')), () => { S.view = 'chat'; render(); send(activePane(), q); }); }
      hl = 0; paint();
    };
    const paint = () => rows.forEach((r, i) => r.node.classList.toggle('hl', i === hl));
    const close = () => { ov.remove(); document.removeEventListener('keydown', key); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, rows.length - 1); paint(); } else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); paint(); } else if (e.key === 'Enter') { e.preventDefault(); const r = rows[hl]; if (r) { close(); r.run(); } } };
    inp.addEventListener('input', build); document.addEventListener('keydown', key); build(); setTimeout(() => inp.focus(), 0);
  }
  function openShortcuts() {
    const rows = [['Ctrl/⌘ K', 'Search chats & commands'], ['Ctrl/⌘ Shift O', 'New chat in the active pane'], ['Ctrl/⌘ \\', 'Split the view'], ['Ctrl/⌘ Shift W', 'Close the active pane'], ['Ctrl/⌘ J', 'Workspace drawer'], ['Ctrl/⌘ S', 'Save the open file'], ['Ctrl/⌘ ,', 'Settings'], ['Ctrl/⌘ /', 'This panel'], ['Shift Esc', 'Focus the message box'], ['Ctrl/⌘ Shift C', 'Copy the last answer'], ['Ctrl/⌘ Shift ;', 'Copy the last code block'], ['Enter / Shift Enter', 'Send / new line'], ['/ at the start', 'Commands: /new /split /files /terminal /artifacts /tools /think /style /assistant /tool'], ['Esc (while editing)', 'Cancel editing a message']];
    modal({ title: 'Keyboard shortcuts', body: el('div', { class: 'shortcuts' }, rows.map(([k, d]) => el('div', {}, el('span', {}, d), el('span', { class: 'kbd' }, k)))) });
  }
  function lastAssistantText(pane) { for (let i = pane.messages.length - 1; i >= 0; i--) { const m = pane.messages[i]; if (m.role === 'assistant' && m.content) return m.content; } return ''; }

  // ---------------------------------------------------------------- workspace drawer (files · editor · terminal · artifacts)
  const redrawDrawer = () => { const d = $('.drawer'); if (d) d.replaceWith(renderDrawer()); };
  async function loadTree(path) {
    S.drawer.loading = true;
    try { const r = await api(`/api/workspace/tree?path=${encodeURIComponent(path || '.')}`); S.drawer.path = r.path; S.drawer.entries = r.entries; S.drawer.root = r.root; } catch (e) { toast(e.message, true); }
    S.drawer.loading = false;
    redrawDrawer();
  }
  async function openFile(path) {
    try { const r = await api(`/api/workspace/file?path=${encodeURIComponent(path)}`); S.drawer.file = { path: r.path, content: r.content, saved: r.content, size: r.size }; S.drawer.tab = 'editor'; S.drawer.versions = null; redrawDrawer(); } catch (e) { toast(e.message, true); }
  }
  async function saveFile() {
    const f = S.drawer.file; if (!f) return;
    try { const r = await api('/api/workspace/file', { method: 'PUT', body: { path: f.path, content: f.content } }); f.saved = f.content; f.size = r.size; toast('saved ' + f.path + (r.versioned ? ' · previous version kept' : '')); redrawDrawer(); } catch (e) { toast(e.message, true); }
  }
  async function runCommand(cmd) {
    const term = S.drawer.term; term.push({ kind: 'cmd', text: cmd });
    if (cmd === 'clear') { S.drawer.term = []; redrawDrawer(); return; }
    term.push({ kind: 'meta', text: 'running…' });
    redrawDrawer();
    try { const r = await api('/api/workspace/run', { method: 'POST', body: { command: cmd, cwd: S.drawer.path === '.' ? '' : S.drawer.path, timeout_seconds: 120 } }); term.pop(); term.push({ kind: /\[exit 0\]\s*$/.test(r.output) ? 'out' : 'err', text: r.output }); term.push({ kind: 'meta', text: `· ${fmtMs(r.duration_ms)}` }); loadTree(S.drawer.path); }
    catch (e) { term.pop(); term.push({ kind: 'err', text: e.message }); }
    redrawDrawer();
  }
  function openArtifact(id) { S.drawer.open = true; S.drawer.tab = 'artifacts'; S.drawer.artifact = id; S.drawer.aTab = PREVIEWABLE.includes(S.artifacts[id]?.lang) ? 'preview' : 'code'; S.drawer.versions = null; render(); }
  async function saveArtifact(id) {
    const a = S.artifacts[id]; if (!a) return;
    const path = await promptDialog('Save to workspace as', a.savedPath || `artifacts/${a.name}`, 'Relative to the workspace folder. Saving over an existing file keeps the previous version.');
    if (!path) return;
    try { const r = await api('/api/workspace/file', { method: 'PUT', body: { path, content: a.code } }); a.savedPath = path; toast(`saved ${path}` + (r.versioned ? ' · previous version kept' : '')); loadTree(S.drawer.path); } catch (e) { toast(e.message, true); }
  }
  function allArtifacts() { for (const p of S.panes) for (const m of p.messages) if (m.role === 'assistant' && m.content) { const tmp = el('div', { html: md(m.content) }); artifactize(tmp, m.id, p.convId); } return Object.values(S.artifacts).sort((a, b) => b.ts - a.ts); }
  function renderDrawer() {
    const D = S.drawer; const root = el('div', { class: 'drawer' });
    const tab = (id, icon, label) => el('button', { class: 'tab' + (D.tab === id ? ' active' : ''), onclick: () => { D.tab = id; root.replaceWith(renderDrawer()); if (id === 'files' && !D.entries.length) loadTree(D.path); } }, I(icon, 'sm'), label);
    root.append(el('div', { class: 'dhead' }, tab('files', 'file', 'Files'), tab('editor', 'edit', D.file ? (D.file.content !== D.file.saved ? '● ' : '') + D.file.path.split('/').pop() : 'Editor'), tab('terminal', 'terminal', 'Terminal'), tab('artifacts', 'box', 'Artifacts'), el('span', { class: 'spacer' }), el('button', { class: 'btn quiet icon sm', title: 'refresh', onclick: () => loadTree(D.path) }, I('refresh', 'sm')), el('button', { class: 'btn quiet icon sm', title: 'close', onclick: () => { D.open = false; render(); } }, I('x', 'sm'))));
    const body = el('div', { class: 'dbody' }); root.append(body);
    if (D.tab === 'files') {
      const parts = D.path === '.' ? [] : D.path.split('/');
      const crumbs = el('div', { class: 'crumbs' }, el('button', { onclick: () => loadTree('.') }, 'workspace'));
      parts.forEach((p, i) => { crumbs.append('/', el('button', { onclick: () => loadTree(parts.slice(0, i + 1).join('/')) }, p)); });
      body.append(crumbs);
      const tree = el('div', { class: 'tree' });
      if (D.path !== '.') tree.append(el('div', { class: 'row', onclick: () => loadTree(parts.slice(0, -1).join('/') || '.') }, I('chevronR', 'xs'), '..'));
      for (const e of D.entries) tree.append(el('div', { class: 'row' + (D.file && D.file.path === e.path ? ' sel' : ''), onclick: () => e.dir ? loadTree(e.path) : openFile(e.path) }, I(e.dir ? 'box' : 'file', 'sm'), el('span', { class: 'truncate' }, e.name), e.dir ? null : el('span', { class: 'sz' }, fmtBytes(e.size)), e.dir ? null : el('a', { class: 'dl', href: downloadUrl(e.path), download: e.name, title: 'Download', onclick: (ev) => ev.stopPropagation() }, I('download', 'xs'))));
      if (!D.entries.length && !D.loading) tree.append(el('div', { class: 'muted tiny', style: 'padding:10px' }, 'Empty folder. Ask the agent to create something, save an artifact, or use the terminal.'));
      body.append(tree);
      body.append(el('div', { class: 'dfoot' }, D.root || ''));
    } else if (D.tab === 'editor') body.append(renderEditor());
    else if (D.tab === 'artifacts') body.append(renderArtifacts());
    else {
      const term = el('div', { class: 'term' });
      const out = el('div', { class: 'tout' });
      if (!D.term.length) out.append(el('span', { class: 'meta' }, `workspace shell · ${navigator.platform.startsWith('Win') ? 'PowerShell' : 'sh'} · commands run on the server inside ${D.root || 'the workspace'} · "clear" clears\n`));
      for (const line of D.term) out.append(el('div', { class: line.kind }, line.kind === 'cmd' ? '$ ' + line.text : line.text));
      term.append(out);
      const inp = el('input', { placeholder: isAdmin() ? 'command…' : 'terminal needs the admin role', disabled: !isAdmin() || undefined, onkeydown: (e) => { if (e.key === 'Enter' && inp.value.trim()) { const c = inp.value.trim(); inp.value = ''; runCommand(c); } } });
      term.append(el('div', { class: 'tin' }, el('span', {}, (D.path === '.' ? '~' : D.path) + ' $'), inp));
      body.append(term);
      setTimeout(() => { out.scrollTop = out.scrollHeight; inp.focus(); }, 0);
    }
    return root;
  }
  // ---- editor with selection-based editing and saved versions
  function renderEditor() {
    const D = S.drawer;
    if (!D.file) return el('div', { class: 'empty' }, el('div', { class: 'big' }, '📝'), el('h3', {}, 'No file open'), el('div', {}, 'Pick one in Files, or open an artifact. Select text to ask the chat to rewrite just that part.'));
    const f = D.file; const dirty = f.content !== f.saved;
    const ed = el('div', { class: 'editor' });
    const versionsBtn = el('button', { class: 'btn sm', title: 'Previous saved versions', onclick: async () => { try { const h = await api(`/api/workspace/history?path=${encodeURIComponent(f.path)}`); D.versions = h.versions; ed.replaceWith(renderEditor()); } catch (e) { toast(e.message, true); } } }, I('clock', 'sm'), 'Versions');
    ed.append(el('div', { class: 'ehead' }, el('span', { class: 'mono truncate' }, f.path), el('span', { class: 'muted' }, fmtBytes(f.size)), el('span', { class: 'spacer' }), f.onDisk === false ? null : el('a', { class: 'btn sm', href: downloadUrl(f.path), download: baseName(f.path), title: 'Download this file' }, I('download', 'sm')), versionsBtn, el('button', { class: 'btn sm', title: 'Ask the active pane about this file', onclick: () => { const p = activePane(); p.draft = (p.draft ? p.draft + '\n' : '') + `Look at ${f.path} and `; render(); $('.composerInput', paneEl(p))?.focus(); } }, I('chat', 'sm'), 'Ask'), isAdmin() ? el('button', { class: 'btn primary sm', disabled: !dirty, onclick: saveFile }, I('check', 'sm'), dirty ? 'Save' : 'Saved') : el('span', { class: 'chip' }, 'read-only')));
    if (D.versions) {
      ed.append(el('div', { class: 'row', style: 'padding:6px 12px;border-bottom:1px solid var(--border);flex-wrap:wrap;font-size:12px' }, el('span', { class: 'muted' }, D.versions.length ? 'versions:' : 'no previous versions'), ...D.versions.slice(0, 8).map((v) => el('button', { class: 'btn sm', onclick: async () => { try { const r = await api(`/api/workspace/history/file?name=${encodeURIComponent(v.name)}`); showDiff(`Version from ${new Date(v.ts * 1000).toLocaleString()}`, f.content, r.content, () => { f.content = r.content; ed.replaceWith(renderEditor()); }); } catch (e) { toast(e.message, true); } } }, new Date(v.ts * 1000).toLocaleTimeString())), el('button', { class: 'btn quiet sm', onclick: () => { D.versions = null; ed.replaceWith(renderEditor()); } }, 'hide')));
    }
    const ta = el('textarea', { spellcheck: 'false', readonly: !isAdmin() || undefined });
    ta.value = f.content;
    ta.addEventListener('input', () => { f.content = ta.value; const t = $('.drawer .dhead .tab:nth-child(2)'); if (t) t.lastChild.textContent = (f.content !== f.saved ? '● ' : '') + f.path.split('/').pop(); const b = $('.drawer .ehead .btn.primary'); if (b) { b.disabled = f.content === f.saved; b.lastChild.textContent = f.content === f.saved ? 'Saved' : 'Save'; } });
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); } if (e.key === 'Tab') { e.preventDefault(); const s = e.target.selectionStart; e.target.setRangeText('  ', s, e.target.selectionEnd, 'end'); f.content = e.target.value; } });
    let tool = null;
    const showTool = () => {
      const s = ta.selectionStart, e = ta.selectionEnd;
      if (tool) { tool.remove(); tool = null; }
      if (s === e || !isAdmin()) return;
      const sel = ta.value.slice(s, e);
      const inp = el('input', { placeholder: 'Ask to change the selection…' });
      const go = (instr, mode = 'replace') => { tool?.remove(); tool = null; requestSelectionEdit(f, s, e, sel, instr, mode); };
      tool = el('div', { class: 'seltool', onmousedown: (ev) => ev.stopPropagation() }, inp, el('button', { class: 'btn primary sm', onclick: () => inp.value.trim() && go(inp.value.trim()) }, I('send', 'xs')), el('button', { class: 'btn sm', title: 'Fix bugs in the selection', onclick: () => go('Fix any bugs or mistakes in this selection. Keep the behaviour and style otherwise.') }, 'Fix'), el('button', { class: 'btn sm', title: 'Add explanatory comments', onclick: () => go('Add short, useful comments to this selection. Do not change the logic.') }, 'Comment'), el('button', { class: 'btn sm', title: 'Explain in chat (no change)', onclick: () => go('Explain what this selection does and point out anything risky.', 'ask') }, 'Explain'), el('button', { class: 'btn sm', title: 'Review in chat (no change)', onclick: () => go('Review this selection like a careful senior engineer: correctness, edge cases, naming. Be concrete.', 'ask') }, 'Review'));
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && inp.value.trim()) go(inp.value.trim()); if (ev.key === 'Escape') { tool?.remove(); tool = null; } });
      tool.style.top = '52px'; tool.style.left = '12px'; ed.append(tool);
    };
    ta.addEventListener('mouseup', () => setTimeout(showTool, 0));
    ta.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'Shift') setTimeout(showTool, 0); });
    ed.append(ta);
    return ed;
  }
  function requestSelectionEdit(f, start, end, selection, instruction, mode) {
    const pane = activePane(); const ext = (f.path.split('.').pop() || '').toLowerCase(); const lang = EXT[ext] ? ext : '';
    const lineA = f.content.slice(0, start).split('\n').length, lineB = lineA + selection.split('\n').length - 1;
    let prompt;
    if (mode === 'replace') {
      prompt = `Edit a selection inside \`${f.path}\` (lines ${lineA}-${lineB}). ${instruction}\n\nReturn ONLY the replacement for the selected text inside one \`\`\`replace fenced block, with no explanation before or after it.\n\nSelected text:\n\`\`\`${lang}\n${selection}\n\`\`\`\n\nFor context, the file starts with:\n\`\`\`${lang}\n${f.content.slice(0, 2500)}${f.content.length > 2500 ? '\n…' : ''}\n\`\`\``;
      pane.pendingEdit = { path: f.path, start, end, selection };
    } else {
      prompt = `${instruction}\n\nSelection from \`${f.path}\` (lines ${lineA}-${lineB}):\n\`\`\`${lang}\n${selection}\n\`\`\``;
    }
    S.view = 'chat'; render();
    startStream(pane, prompt, [], { tools: 'none' });
  }
  function finishSelectionEdit(pane) {
    const pe = pane.pendingEdit; pane.pendingEdit = null; if (!pe) return;
    const text = lastAssistantText(pane);
    const m = text.match(/```replace[^\n]*\n([\s\S]*?)```/) || text.match(/```[^\n]*\n([\s\S]*?)```/);
    if (!m) { toast('the model did not return a replacement block', true); return; }
    const replacement = m[1].replace(/\n$/, '');
    const f = S.drawer.file;
    if (!f || f.path !== pe.path) { toast('the file changed; replacement not applied', true); return; }
    showDiff(`Proposed change · ${pe.path}`, pe.selection, replacement, () => {
      const idx = f.content.indexOf(pe.selection, Math.max(0, pe.start - 50));
      const at = idx >= 0 ? idx : f.content.indexOf(pe.selection);
      if (at < 0) return toast('could not find the original selection anymore', true);
      f.content = f.content.slice(0, at) + replacement + f.content.slice(at + pe.selection.length);
      S.drawer.open = true; S.drawer.tab = 'editor'; render(); toast('applied · Ctrl/⌘ S to save');
    });
  }
  function lineDiff(a, b) {
    const A = a.split('\n'), B = b.split('\n'); const n = Math.min(A.length, 400), m = Math.min(B.length, 400);
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) { if (A[i] === B[j]) { out.push(['eq', A[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['del', A[i++]]); else out.push(['add', B[j++]]); }
    while (i < n) out.push(['del', A[i++]]); while (j < m) out.push(['add', B[j++]]);
    return out;
  }
  function showDiff(title, before, after, onApply) {
    const box = el('div', { class: 'diff' }); for (const [k, l] of lineDiff(before, after)) box.append(el('div', { class: k }, (k === 'add' ? '+ ' : k === 'del' ? '- ' : '  ') + l));
    const m = modal({ title, body: box, wide: true, footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Discard'), el('button', { class: 'btn primary', onclick: () => { m.close(); onApply(); } }, I('check', 'sm'), 'Apply to editor')] });
  }
  // ---- artifacts tab
  function renderArtifacts() {
    const D = S.drawer;
    if (!D.artifact || !S.artifacts[D.artifact]) {
      const arts = allArtifacts();
      const list = el('div', { class: 'alist' });
      if (!arts.length) list.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '📦'), el('h3', {}, 'No artifacts yet'), el('div', {}, 'Long code blocks and HTML / SVG / Markdown documents the assistant writes show up here with a preview, copy and save.')));
      for (const a of arts) list.append(el('div', { class: 'artifact' }, el('div', { class: 'ahead', onclick: () => openArtifact(a.id) }, el('div', { class: 'aicon' }, I(a.lang === 'html' || a.lang === 'svg' ? 'globe' : 'terminal', 'sm')), el('div', { style: 'min-width:0' }, el('div', { class: 'atitle truncate' }, a.name), el('div', { class: 'asub' }, `${a.lang || 'text'} · ${a.lines} lines${a.savedPath ? ' · saved ' + a.savedPath : ''}`)))));
      return list;
    }
    const a = S.artifacts[D.artifact]; const view = el('div', { class: 'aview' });
    const canPreview = PREVIEWABLE.includes(a.lang);
    const swap = () => view.replaceWith(renderArtifacts());
    const tabs = el('div', { class: 'tabs' }, ...(canPreview ? [el('button', { class: D.aTab === 'preview' ? 'active' : '', onclick: () => { D.aTab = 'preview'; swap(); } }, 'Preview')] : []), el('button', { class: D.aTab === 'code' || !canPreview ? 'active' : '', onclick: () => { D.aTab = 'code'; swap(); } }, 'Code'));
    view.append(el('div', { class: 'ahead' }, el('button', { class: 'btn quiet icon sm', title: 'all artifacts', onclick: () => { D.artifact = null; swap(); } }, I('chevronR', 'sm')), el('span', { class: 'mono truncate', style: 'max-width:160px' }, a.name), el('span', { class: 'muted' }, `${a.lang || 'text'} · ${a.lines} lines`), el('span', { class: 'spacer' }), tabs, el('button', { class: 'btn quiet icon sm', title: 'Copy', onclick: () => navigator.clipboard.writeText(a.code).then(() => toast('copied')) }, I('copy', 'sm')), el('button', { class: 'btn sm', title: 'Download', onclick: () => saveBlob(a.name, a.code) }, I('download', 'sm'), 'Download'), isAdmin() ? el('button', { class: 'btn primary sm', title: 'Save into the workspace folder', onclick: () => saveArtifact(a.id) }, I('file', 'sm'), a.savedPath ? 'Save again' : 'Save') : null, el('button', { class: 'btn sm', title: 'Open in the editor', onclick: () => { D.file = { path: a.savedPath || `artifacts/${a.name}`, content: a.code, saved: a.savedPath ? a.code : '', size: a.code.length, onDisk: !!a.savedPath }; D.tab = 'editor'; D.versions = null; redrawDrawer(); } }, I('edit', 'sm'))));
    const body = el('div', { class: 'abody' });
    if (canPreview && D.aTab !== 'code') {
      if (a.lang === 'html') { const fr = el('iframe', { sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox', title: a.name }); fr.srcdoc = a.code; body.style.display = 'flex'; body.append(fr); }
      else if (a.lang === 'svg') body.append(el('div', { style: 'padding:14px', html: DOMPurify.sanitize(a.code, { USE_PROFILES: { svg: true, svgFilters: true } }) }));
      else if (a.lang === 'json') { let pretty = a.code; try { pretty = JSON.stringify(JSON.parse(a.code), null, 2); } catch {} body.append(el('pre', {}, pretty)); }
      else body.append(el('div', { class: 'md', html: md(a.code) }));
    } else body.append(el('pre', {}, a.code));
    view.append(body);
    return view;
  }

  // ---------------------------------------------------------------- settings
  const SETTINGS_NAV = [
    { grp: 'Models' }, { id: 'providers', label: 'Model providers', icon: 'cloud' }, { id: 'default', label: 'Defaults & presets', icon: 'box' },
    { grp: 'Tools' }, { id: 'mcp', label: 'MCP servers', icon: 'plug' }, { id: 'tools', label: 'Tools & policy', icon: 'wrench' }, { id: 'knowledge', label: 'Knowledge base', icon: 'box' }, { id: 'memory', label: 'Memory', icon: 'brain' }, { id: 'assistants', label: 'Assistants', icon: 'sparkles' }, { id: 'styles', label: 'Writing styles', icon: 'wand' }, { id: 'agents', label: 'Agent servers', icon: 'bot' },
    { grp: 'Studio' }, { id: 'audit', label: 'Audit log', icon: 'list' }, { id: 'general', label: 'General', icon: 'settings' },
  ];
  function renderSettings() {
    const root = el('div', { class: 'settings' });
    const nav = el('div', { class: 'snav' }, el('h2', {}, 'Settings'));
    nav.append(el('button', { onclick: () => { S.view = 'chat'; render(); } }, I('chat', 'sm'), 'Back to chat'));
    for (const n of SETTINGS_NAV) { if (n.grp) { nav.append(el('div', { class: 'grp' }, n.grp)); continue; } nav.append(el('button', { class: S.settingsPage === n.id ? 'active' : '', onclick: () => { S.settingsPage = n.id; render(); } }, I(n.icon, 'sm'), n.label)); }
    root.append(nav);
    const content = el('div', { class: 'scontent' }); root.append(content);
    ({ providers: pageProviders, default: pageDefault, mcp: pageMcp, tools: pageTools, knowledge: pageKnowledge, memory: pageMemory, assistants: pageAssistants, styles: pageStyles, agents: pageAgents, audit: pageAudit, general: pageGeneral }[S.settingsPage] || pageProviders)(content);
    return root;
  }
  const page = (title, sub, ...kids) => el('div', { class: 'page' }, el('h1', {}, title, sub ? el('small', {}, sub) : null), ...kids);

  function pageProviders(content) {
    const list = el('div', { class: 'listbox' });
    const selId = S.sel.providerId && providerOf(S.sel.providerId) ? S.sel.providerId : (S.st.providers[0]?.id || '');
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: addProviderModal }, I('plus', 'sm'), 'Add provider')));
    for (const p of S.st.providers) list.append(el('div', { class: 'lrow' + (p.id === selId ? ' active' : ''), onclick: () => { S.sel.providerId = p.id; render(); } }, el('div', { class: 'em', style: avatarStyle(p.id) }, initials(p.label || p.id)), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, p.label || p.id), el('div', { class: 'sub truncate' }, `${p.kind} · ${p.models.length} models`)), el('span', { class: 'dot ' + (p.enabled === false ? '' : ({ ok: 'ok', down: 'err', nokey: 'warn' }[healthOf(p).state] || (p.has_key || p.kind === 'agentserver' || /127\.0\.0\.1|localhost/.test(p.base_url) ? 'ok' : 'warn'))), title: HEALTH_LABEL[healthOf(p).state] + (healthOf(p).error ? ' · ' + healthOf(p).error : '') })));
    if (!S.st.providers.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px' }, 'No providers yet.'));
    const detail = el('div');
    const p = providerOf(selId);
    if (p) detail.append(providerDetail(p)); else detail.append(el('div', { class: 'card' }, el('h3', {}, 'Pick a preset to begin'), el('p', { class: 'muted', style: 'margin:0' }, 'OpenAI, Anthropic, Gemini, DashScope, OpenRouter, Groq, DeepSeek, Mistral, xAI, or local Ollama / LM Studio / vLLM / llama.cpp. Any OpenAI-compatible endpoint works.'), el('div', {}, el('button', { class: 'btn primary', onclick: addProviderModal }, I('plus', 'sm'), 'Add provider'))));
    content.append(page('Model providers', 'where your models come from', el('div', { class: 'split' }, list, detail)));
  }
  function providerDetail(p) {
    const card = el('div', { class: 'card' });
    const draft = { ...p };
    card.append(el('h3', {}, el('span', { class: 'em', style: `${avatarStyle(p.id)};width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700` }, initials(p.label || p.id)), p.label || p.id, el('span', { class: 'chip' }, p.kind), S.st.default.provider === p.id ? el('span', { class: 'chip primary' }, 'default') : null, el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, 'enabled'), switchEl(p.enabled !== false, async (v) => { await api('/api/providers', { method: 'POST', body: { id: p.id, enabled: v } }); await loadState(); })));
    const keyIn = el('input', { class: 'input', type: 'password', placeholder: p.has_key ? 'saved · type to replace' : (p.kind === 'agentserver' ? '(not used)' : 'paste API key, or set an env var below'), oninput: (e) => { draft.api_key = e.target.value; } });
    const eye = el('button', { class: 'btn icon', title: 'show', onclick: () => { keyIn.type = keyIn.type === 'password' ? 'text' : 'password'; } }, I('eye', 'sm'));
    const testOut = el('pre', { class: 'out hidden' });
    const testBtn = el('button', { class: 'btn', onclick: async () => { testOut.classList.remove('hidden'); testOut.textContent = 'testing…'; try { const r = await api('/api/providers/test', { method: 'POST', body: { ...draft } }); testOut.textContent = r.ok ? `OK · ${r.count} models · ${r.ms}ms\n${r.models.slice(0, 40).join('\n')}${r.count > 40 ? '\n…' : ''}` : 'FAIL · ' + r.error; } catch (e) { testOut.textContent = e.message; } } }, I('activity', 'sm'), 'Test');
    if (p.kind !== 'agentserver') card.append(field('API key', el('div', { class: 'row', style: 'flex-wrap:nowrap' }, keyIn, eye, testBtn), 'Stored in config.json on this machine. Never sent back to the browser.'), field('API key from environment variable', el('input', { class: 'input', value: p.api_key_env || '', placeholder: 'OPENAI_API_KEY', oninput: (e) => { draft.api_key_env = e.target.value; } })));
    card.append(field('Base URL', el('input', { class: 'input', value: p.base_url || '', oninput: (e) => { draft.base_url = e.target.value; } })));
    if (p.kind === 'agentserver') card.append(el('div', { class: 'grid2' }, field('Login e-mail', el('input', { class: 'input', value: p.email || '', oninput: (e) => { draft.email = e.target.value; } })), field('Password', el('div', { class: 'row', style: 'flex-wrap:nowrap' }, el('input', { class: 'input', type: 'password', placeholder: p.has_password ? 'saved · type to replace' : '', oninput: (e) => { draft.password = e.target.value; } }), testBtn))));
    card.append(testOut);
    const models = [...new Set([p.default_model, ...(p.models || [])].filter(Boolean))];
    const modelsBox = el('div', { class: 'pill-list' });
    const renderModels = () => { modelsBox.innerHTML = ''; for (const m of models.slice(0, 300)) modelsBox.append(el('span', { class: 'chip' + (m === draft.default_model ? ' sel' : ''), title: 'set as default model', onclick: () => { draft.default_model = m; renderModels(); } }, shortModel(m))); if (models.length > 300) modelsBox.append(el('span', { class: 'muted tiny' }, `+${models.length - 300} more`)); if (!models.length) modelsBox.append(el('span', { class: 'muted tiny' }, 'No models yet. Discover, or type one below.')); };
    renderModels();
    const addModel = el('input', { class: 'input', placeholder: 'add a model id manually', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = addModel.value.trim(); if (v) { models.unshift(v); draft.models = [...new Set([...(draft.models || []), v])]; if (!draft.default_model) draft.default_model = v; addModel.value = ''; renderModels(); } } } });
    card.append(el('div', { class: 'sect' }, `Models · ${models.length}`), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { try { const r = await api(`/api/providers/${encodeURIComponent(p.id)}/models`, { method: 'POST' }); toast(`${r.models.length} models`); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('refresh', 'sm'), p.kind === 'agentserver' ? 'Sync agents' : 'Discover models'), addModel), modelsBox);
    const adv = el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer' }, 'Advanced: extra request body, headers, label, TLS'));
    adv.append(el('div', { class: 'grid2', style: 'margin-top:10px' }, field('Label', el('input', { class: 'input', value: p.label || '', oninput: (e) => { draft.label = e.target.value; } })), field('Allow self-signed TLS', switchEl(!!p.allow_insecure_tls, (v) => { draft.allow_insecure_tls = v; })), field('Tool calls via prompt', switchEl(!!p.tools_via_prompt, (v) => { draft.tools_via_prompt = v; }), 'For servers that reject tool definitions (vLLM without a tool-call parser): tools are described in the prompt and <tool_call> blocks are parsed from the text. Switched on automatically when such a server answers 400.'), field('Context window (tokens)', el('input', { class: 'input', type: 'number', value: p.context_window || '', placeholder: 'auto', oninput: (e) => { draft.context_window = parseInt(e.target.value || '0', 10) || 0; } }), 'Long threads are compacted at 60% of this.'), field('Extra body (JSON)', el('input', { class: 'input', value: Object.keys(p.extra_body || {}).length ? JSON.stringify(p.extra_body) : '', placeholder: '{"enable_thinking": false}', oninput: (e) => { draft._extra = e.target.value; } }), 'Merged into every request. The thinking toggle in chat adds its own switch per request on top of this.'), field('Headers (JSON)', el('input', { class: 'input', value: Object.keys(p.headers || {}).length ? JSON.stringify(p.headers) : '', placeholder: '{"X-Title": "missile"}', oninput: (e) => { draft._headers = e.target.value; } }))));
    card.append(adv);
    card.append(el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { try { const body = { ...draft }; delete body._extra; delete body._headers; if (draft._extra !== undefined) body.extra_body = draft._extra ? JSON.parse(draft._extra) : {}; if (draft._headers !== undefined) body.headers = draft._headers ? JSON.parse(draft._headers) : {}; if (!body.api_key) delete body.api_key; if (!body.password) delete body.password; await api('/api/providers', { method: 'POST', body }); toast('saved'); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), 'Save'), el('button', { class: 'btn', onclick: async () => { await api('/api/default', { method: 'POST', body: { provider: p.id, model: draft.default_model || p.default_model } }); toast('default updated'); await loadState(); render(); } }, 'Use as default'), el('span', { class: 'spacer' }), el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Remove provider ${p.id}?`)) { await api('/api/providers/' + encodeURIComponent(p.id), { method: 'DELETE' }); S.sel.providerId = ''; await loadState(); render(); } } }, I('trash', 'sm'), 'Remove')));
    return card;
  }
  function addProviderModal() {
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px' });
    const m = modal({ title: 'Add a provider', body: [el('p', { class: 'muted', style: 'margin:0' }, 'Pick a preset. You can change everything afterwards.'), grid], wide: true });
    for (const pr of S.st.presets) grid.append(el('button', { class: 'btn', style: 'height:auto;padding:10px 12px;justify-content:flex-start;text-align:left;gap:10px', onclick: () => { m.close(); createFromPreset(pr); } }, el('span', { class: 'em', style: `${avatarStyle(pr.id)};width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700;flex:none` }, initials(pr.label)), el('span', { style: 'min-width:0' }, el('div', { class: 'truncate', style: 'font-weight:600' }, pr.label), el('div', { class: 'muted tiny truncate' }, pr.needs_key ? 'API key' : 'no key · local'))));
  }
  function createFromPreset(pr) {
    let id = pr.id; let n = 2; while (providerOf(id)) id = `${pr.id}-${n++}`;
    const draft = { id, kind: pr.kind, label: pr.label, base_url: pr.base_url, default_model: pr.hint && !pr.hint.startsWith('(') ? pr.hint : '', extra_body: pr.extra_body || {}, api_key: '', email: '', password: '' };
    const body = [field('Id', el('input', { class: 'input', value: draft.id, oninput: (e) => { draft.id = e.target.value.trim(); } })), field('Base URL', el('input', { class: 'input', value: draft.base_url, oninput: (e) => { draft.base_url = e.target.value; } }))];
    if (pr.kind === 'agentserver') body.push(field('Login e-mail', el('input', { class: 'input', oninput: (e) => { draft.email = e.target.value; } })), field('Password', el('input', { class: 'input', type: 'password', oninput: (e) => { draft.password = e.target.value; } })));
    else body.push(field('API key', el('input', { class: 'input', type: 'password', placeholder: pr.needs_key ? 'sk-…' : 'not needed for local servers', oninput: (e) => { draft.api_key = e.target.value; } })));
    body.push(field('Default model', el('input', { class: 'input', value: draft.default_model, placeholder: pr.hint, oninput: (e) => { draft.default_model = e.target.value.trim(); } }), 'Leave empty and press Discover after saving.'));
    const m = modal({ title: `Add ${pr.label}`, body, footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => { try { const b = { ...draft }; if (b.default_model) b.models = [b.default_model]; if (!b.api_key) delete b.api_key; if (!b.password) delete b.password; await api('/api/providers', { method: 'POST', body: b }); m.close(); S.sel.providerId = b.id; await loadState(); render(); try { const r = await api(`/api/providers/${encodeURIComponent(b.id)}/models`, { method: 'POST' }); toast(`${r.models.length} models found`); await loadState(); render(); } catch (e) { toast('saved. Discover failed: ' + e.message.slice(0, 120), true); } } catch (e) { toast(e.message, true); } } }, 'Save')] });
  }
  function pageDefault(content) {
    const d = S.st.default; const card = el('div', { class: 'card' });
    const sp = el('select', { class: 'select' }, el('option', { value: '' }, '(none)'), ...S.st.providers.map((p) => el('option', { value: p.id, selected: p.id === d.provider }, p.label || p.id)));
    const sm = el('select', { class: 'select' });
    const fillModels = () => { sm.innerHTML = ''; const p = providerOf(sp.value); for (const m of [...new Set([p?.default_model, ...(p?.models || [])].filter(Boolean))]) sm.append(el('option', { value: m, selected: m === d.model }, shortModel(m))); };
    sp.addEventListener('change', fillModels); fillModels();
    const sa = el('select', { class: 'select' }, ...S.st.assistants.map((a) => el('option', { value: a.id, selected: a.id === d.assistant }, a.name)));
    card.append(el('h3', {}, 'Defaults for new chats'), el('div', { class: 'grid2' }, field('Provider', sp), field('Model', sm)), field('Assistant', sa), el('div', {}, el('button', { class: 'btn primary', onclick: async () => { await api('/api/default', { method: 'POST', body: { provider: sp.value, model: sm.value, assistant: sa.value } }); toast('saved'); await loadState(); render(); } }, 'Save')));
    const pc = el('div', { class: 'card' }, el('h3', {}, 'Quick presets', el('span', { class: 'chip' }, S.st.presets_configured ? 'custom' : 'derived from your providers')), el('div', { class: 'muted tiny' }, 'Shown at the top of the model picker. Thinking "default" keeps the provider as-is; on / max / off map to each provider\'s own switch (budgets, reasoning effort, enable_thinking).'));
    const rows = (S.st.model_presets || []).map((p) => ({ ...p }));
    const tbl = el('div', { style: 'display:grid;gap:8px' });
    const renderRows = () => { tbl.innerHTML = ''; rows.forEach((r, i) => { const prov = el('select', { class: 'select', onchange: (e) => { r.provider = e.target.value; } }, ...S.st.providers.map((p) => el('option', { value: p.id, selected: p.id === r.provider }, p.label || p.id))); tbl.append(el('div', { class: 'row', style: 'flex-wrap:nowrap' }, el('input', { class: 'input', style: 'width:80px', value: r.id, oninput: (e) => { r.id = e.target.value.trim(); } }), el('input', { class: 'input', style: 'width:110px', value: r.label, oninput: (e) => { r.label = e.target.value; } }), prov, el('input', { class: 'input', value: r.model, placeholder: 'model id', oninput: (e) => { r.model = e.target.value.trim(); } }), el('select', { class: 'select', style: 'width:150px', onchange: (e) => { r.thinking = e.target.value; } }, ...['', 'off', 'on', 'max'].map((v) => el('option', { value: v, selected: v === (r.thinking || '') }, v || 'default'))), el('button', { class: 'btn quiet icon sm', onclick: () => { rows.splice(i, 1); renderRows(); } }, I('x', 'sm')))); }); };
    renderRows();
    pc.append(tbl, el('div', { class: 'row' }, el('button', { class: 'btn sm', onclick: () => { rows.push({ id: `p${rows.length + 1}`, label: 'Preset', provider: S.st.providers[0]?.id || '', model: '', thinking: '' }); renderRows(); } }, I('plus', 'sm'), 'Add preset'), el('span', { class: 'spacer' }), el('button', { class: 'btn', onclick: async () => { await api('/api/presets', { method: 'PUT', body: [] }); toast('back to derived presets'); await loadState(); render(); } }, 'Reset'), el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/presets', { method: 'PUT', body: rows }); toast('presets saved'); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, 'Save presets')));
    content.append(page('Defaults & presets', 'what new chats use, and the quick picks', card, pc));
  }
  function pageStyles(content) {
    const list = el('div', { class: 'listbox' });
    const styles = S.st.styles || []; const sel = S.sel.newStyle ? null : (styles.some((s) => s.id === S.sel.styleId) ? S.sel.styleId : styles[0]?.id);
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: () => { S.sel.newStyle = true; render(); } }, I('plus', 'sm'), 'New style')));
    for (const s of styles) list.append(el('div', { class: 'lrow' + (s.id === sel ? ' active' : ''), onclick: () => { S.sel.newStyle = false; S.sel.styleId = s.id; render(); } }, el('div', { class: 'em', style: 'background:var(--bg-subtle);color:var(--fg)' }, I('wand', 'sm')), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, s.name), el('div', { class: 'sub truncate' }, s.prompt || 'no extra instructions'))));
    const s = sel ? styles.find((x) => x.id === sel) : { id: '', name: '', prompt: '' }; const d = { ...s };
    const card = el('div', { class: 'card' }, el('h3', {}, sel ? `Edit ${s.name}` : 'New style'), el('div', { class: 'grid2' }, field('Id', el('input', { class: 'input', value: d.id, disabled: !!sel, oninput: (e) => { d.id = e.target.value.trim(); } })), field('Name', el('input', { class: 'input', value: d.name, oninput: (e) => { d.name = e.target.value; } }))), field('Instructions', el('textarea', { class: 'textarea', style: 'min-height:140px', value: d.prompt || '', placeholder: 'How should answers sound? Paste a sample of your own writing and say "write like this".', oninput: (e) => { d.prompt = e.target.value; } }), 'Appended to the system prompt as "Writing style: …". Chat-level instructions still win.'), el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/styles', { method: 'POST', body: d }); toast('saved'); S.sel.newStyle = false; S.sel.styleId = d.id; await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), 'Save'), el('span', { class: 'spacer' }), sel && sel !== 'normal' ? el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Delete style ${s.name}?`)) { await api('/api/styles/' + sel, { method: 'DELETE' }); S.sel.styleId = ''; await loadState(); render(); } } }, I('trash', 'sm'), 'Delete') : null));
    content.append(page('Writing styles', 'tone presets you can switch per chat without changing the assistant', el('div', { class: 'split' }, list, card)));
  }
  function pageMcp(content) {
    const list = el('div', { class: 'listbox' });
    const names = S.st.mcp.map((s) => s.name); const selName = names.includes(S.sel.mcpName) ? S.sel.mcpName : names[0];
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'flex:1', onclick: () => mcpModal() }, I('plus', 'sm'), 'Add server'), el('button', { class: 'btn sm', onclick: importModal, title: 'Import from other MCP clients' }, I('download', 'sm'))));
    for (const s of S.st.mcp) list.append(el('div', { class: 'lrow' + (s.name === selName ? ' active' : ''), onclick: () => { S.sel.mcpName = s.name; render(); } }, el('span', { class: 'dot ' + (s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'err' : s.status === 'connecting' ? 'warn' : '') }), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, s.name), el('div', { class: 'sub truncate' }, `${s.status} · ${s.tool_count} tools · ${s.config.transport}`))));
    if (!S.st.mcp.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px' }, 'No MCP servers yet.'));
    const s = S.st.mcp.find((x) => x.name === selName);
    const detail = el('div');
    if (s) {
      const c = s.config; const card = el('div', { class: 'card' });
      card.append(el('h3', {}, s.name, el('span', { class: 'chip ' + (s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'err' : '') }, s.status), el('span', { class: 'chip' }, `${s.tool_count} tools`), el('span', { class: 'chip' }, c.transport), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, 'enabled'), switchEl(c.enabled !== false, async (v) => { await api('/api/mcp', { method: 'POST', body: { name: s.name, config: { ...c, enabled: v } } }); setTimeout(async () => { await loadState(); render(); }, 800); })));
      card.append(el('div', { class: 'mono muted', style: 'overflow-wrap:anywhere' }, c.transport === 'stdio' ? [c.command, ...(c.args || [])].join(' ') : c.url));
      if (s.error) card.append(el('div', { class: 'error-line' }, s.error.slice(0, 400)));
      if (s.server_info?.name) card.append(el('div', { class: 'muted tiny' }, `server: ${s.server_info.name} ${s.server_info.version || ''}`));
      const tools = S.st.tools.filter((t) => t.server === s.name);
      if (tools.length) card.append(el('div', { class: 'sect' }, 'Tools'), el('div', { class: 'pill-list' }, tools.map((t) => el('span', { class: 'chip', title: t.description }, t.name, t.read_only ? ' · ro' : '', t.destructive ? ' · destructive' : ''))));
      card.append(el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => mcpModal(s.name, c) }, I('edit', 'sm'), 'Edit'), el('button', { class: 'btn', onclick: async () => { await api(`/api/mcp/${encodeURIComponent(s.name)}/restart`, { method: 'POST' }); toast('restarting'); setTimeout(async () => { await loadState(); render(); }, 1500); } }, I('refresh', 'sm'), 'Restart'), el('span', { class: 'spacer' }), el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Remove ${s.name}?`)) { await api('/api/mcp/' + encodeURIComponent(s.name), { method: 'DELETE' }); S.sel.mcpName = ''; await loadState(); render(); } } }, I('trash', 'sm'), 'Remove')));
      card.append(el('div', { class: 'muted tiny' }, 'Use this studio from other MCP clients: add a stdio server with command ', el('code', {}, 'ms'), ' and args ', el('code', {}, 'hub'), '. Export the standard JSON at ', el('a', { href: '/api/mcp/export', target: '_blank' }, '/api/mcp/export'), '.'));
      detail.append(card);
    } else detail.append(el('div', { class: 'card' }, el('h3', {}, 'Add your first MCP server'), el('p', { class: 'muted', style: 'margin:0' }, 'stdio commands (npx / uvx / python …), Streamable HTTP or SSE URLs. Or import the servers you already use in other MCP clients on this machine.'), el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => mcpModal() }, I('plus', 'sm'), 'Add server'), el('button', { class: 'btn', onclick: importModal }, I('download', 'sm'), 'Import'))));
    content.append(page('MCP servers', 'tools from your machine and the network', el('div', { class: 'split' }, list, detail)));
  }
  const kv = (txt) => Object.fromEntries(txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  function mcpModal(name = '', c = { transport: 'stdio', enabled: true }) {
    const d = { name, transport: c.transport || 'stdio', command: c.command || '', args: (c.args || []).join('\n'), env: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'), cwd: c.cwd || '', url: c.url || '', headers: Object.entries(c.headers || {}).map(([k, v]) => `${k}=${v}`).join('\n'), enabled: c.enabled !== false };
    const stdio = el('div', { style: 'display:grid;gap:12px' }, field('Command', el('input', { class: 'input', value: d.command, placeholder: 'npx', oninput: (e) => { d.command = e.target.value; } })), field('Arguments (one per line)', el('textarea', { class: 'textarea', value: d.args, placeholder: '-y\n@modelcontextprotocol/server-filesystem\n.', oninput: (e) => { d.args = e.target.value; } })), field('Environment (KEY=VALUE per line)', el('textarea', { class: 'textarea', style: 'min-height:56px', value: d.env, oninput: (e) => { d.env = e.target.value; } })), field('Working directory', el('input', { class: 'input', value: d.cwd, oninput: (e) => { d.cwd = e.target.value; } })));
    const http = el('div', { style: 'display:grid;gap:12px' }, field('URL', el('input', { class: 'input', value: d.url, placeholder: 'http://127.0.0.1:8000/mcp', oninput: (e) => { d.url = e.target.value; } })), field('Headers (KEY=VALUE per line)', el('textarea', { class: 'textarea', style: 'min-height:56px', value: d.headers, oninput: (e) => { d.headers = e.target.value; } })));
    const tr = el('select', { class: 'select', onchange: (e) => { d.transport = e.target.value; stdio.classList.toggle('hidden', d.transport !== 'stdio'); http.classList.toggle('hidden', d.transport === 'stdio'); } }, el('option', { value: 'stdio', selected: d.transport === 'stdio' }, 'stdio (command)'), el('option', { value: 'http', selected: d.transport === 'http' }, 'Streamable HTTP'), el('option', { value: 'sse', selected: d.transport === 'sse' }, 'SSE'));
    stdio.classList.toggle('hidden', d.transport !== 'stdio'); http.classList.toggle('hidden', d.transport === 'stdio');
    const m = modal({ title: name ? `Edit ${name}` : 'Add MCP server', body: [el('div', { class: 'grid2' }, field('Name', el('input', { class: 'input', value: d.name, placeholder: 'filesystem', oninput: (e) => { d.name = e.target.value.trim(); } })), field('Transport', tr)), stdio, http], footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => { if (!d.name) return toast('name required', true); const cfg = { transport: d.transport, enabled: d.enabled, command: d.command, args: d.args.split('\n').map((s) => s.trim()).filter(Boolean), env: kv(d.env), cwd: d.cwd, url: d.url, headers: kv(d.headers) }; try { await api('/api/mcp', { method: 'POST', body: { name: d.name, config: cfg } }); m.close(); S.sel.mcpName = d.name; toast('saved · connecting'); await loadState(); render(); setTimeout(async () => { await loadState(); render(); }, 2500); setTimeout(async () => { await loadState(); render(); }, 7000); } catch (e) { toast(e.message, true); } } }, 'Save & connect')] });
  }
  async function importModal() {
    const box = el('div', { style: 'display:grid;gap:8px' }, el('div', { class: 'muted' }, 'scanning…'));
    const ta = el('textarea', { class: 'textarea', placeholder: '{"mcpServers": {"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}}' });
    const m = modal({ title: 'Import MCP servers', body: [box, el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer' }, 'Paste JSON (mcpServers / servers)'), ta, el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/mcp/import', { method: 'POST', body: { source: 'json', json_text: ta.value } }); toast(`imported ${r.added.length}`); m.close(); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, 'Import JSON')))], wide: true });
    try { const src = await api('/api/mcp/import/sources'); box.innerHTML = ''; for (const s of src) box.append(el('div', { class: 'card', style: 'padding:12px 14px;gap:6px' }, el('div', { class: 'row' }, el('b', {}, s.source), el('span', { class: 'chip ' + (s.available ? 'ok' : '') }, s.available ? `${s.servers.length} servers` : 'not found'), el('span', { class: 'spacer' }), s.available ? el('button', { class: 'btn sm primary', onclick: async () => { const r = await api('/api/mcp/import', { method: 'POST', body: { source: s.source } }); toast(`imported ${r.added.length}`); m.close(); await loadState(); render(); } }, 'Import all') : null), el('div', { class: 'muted tiny mono truncate' }, s.available ? s.servers.join(', ') : s.paths.join(' | ')))); } catch (e) { box.textContent = e.message; }
  }
  function pageTools(content) {
    const pol = S.st.policy; const bt = S.st.builtin_tools;
    const polCard = el('div', { class: 'card' });
    const selDef = el('select', { class: 'select' }, ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: v === pol.default }, v)));
    const selRO = el('select', { class: 'select' }, ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: v === pol.read_only_default }, v)));
    const ws = el('input', { class: 'input', value: bt.workspace || '', placeholder: bt.workspace_resolved });
    const sw = { shell: bt.shell, filesystem: bt.filesystem, web: bt.web };
    const wsc = { ...(bt.web_search || { provider: 'duckduckgo', api_key: '', api_key_env: '', url: '' }) };
    const wsProv = el('select', { class: 'select', onchange: (e) => { wsc.provider = e.target.value; } }, ...[['duckduckgo', 'DuckDuckGo · no key'], ['tavily', 'Tavily · API key'], ['brave', 'Brave Search · API key'], ['serper', 'Serper (Google) · API key'], ['searxng', 'SearXNG · your own URL']].map(([v, l]) => el('option', { value: v, selected: v === wsc.provider }, l)));
    const wsKey = el('input', { class: 'input', type: 'password', placeholder: wsc.has_key ? 'saved · type to replace' : 'API key (tavily / brave / serper)', oninput: (e) => { wsc.api_key = e.target.value; } });
    const wsEnv = el('input', { class: 'input', value: wsc.api_key_env || '', placeholder: 'or an env var name, e.g. TAVILY_API_KEY', oninput: (e) => { wsc.api_key_env = e.target.value.trim(); } });
    const wsUrl = el('input', { class: 'input', value: wsc.url || '', placeholder: 'https://searx.example.com (searxng only)', oninput: (e) => { wsc.url = e.target.value.trim(); } });
    const tc = { ...(S.st.tool_catalog || { mode: 'auto', threshold: 24, always: [] }) };
    const tcMode = el('select', { class: 'select' }, ...[['auto', 'auto · above the threshold'], ['on', 'always'], ['off', 'off · send every schema']].map(([v, l]) => el('option', { value: v, selected: v === tc.mode }, l)));
    const tcThr = el('input', { class: 'input', type: 'number', min: 1, max: 500, value: tc.threshold || 24 });
    const tcAlways = el('input', { class: 'input', value: (tc.always || []).join(', '), placeholder: 'e.g. local__now, webtoon-studio__status, fs__*' });
    polCard.append(el('h3', {}, 'Defaults'), el('div', { class: 'grid2' }, field('Tools that write or run things', selDef, 'ask = pause and show an approval card'), field('Read-only tools', selRO)), el('div', { class: 'sect' }, 'Local tools'), field('Workspace folder', ws, 'Local file and shell tools cannot leave this folder.'), el('div', { class: 'row' }, ...Object.keys(sw).map((k) => el('span', { class: 'row' }, switchEl(sw[k], (v) => { sw[k] = v; }), k === 'web' ? 'web fetch + search' : k))),
      el('div', { class: 'sect' }, 'Web search'), el('div', { class: 'muted tiny' }, 'The web_search tool (and Research mode) use one search API. DuckDuckGo works without a key; the others are faster and cleaner.'), el('div', { class: 'grid2' }, field('Provider', wsProv), field('API key', wsKey)), el('div', { class: 'grid2' }, field('Key from environment', wsEnv), field('SearXNG URL', wsUrl)),
      el('div', { class: 'sect' }, 'Tool catalog'), el('div', { class: 'muted tiny' }, `With many tools connected (${S.st.tools.length} now), the model gets a one-line catalog instead of every schema and loads the tools it needs with load_tools. Keeps small-context models usable; loaded tools stay loaded for the conversation.`), el('div', { class: 'grid2' }, field('Mode', tcMode, 'auto = catalog when more tools than the threshold'), field('Threshold (tools)', tcThr)), field('Always defined', tcAlways, 'comma-separated tool names, server names or server__* patterns that skip the catalog'),
      el('div', {}, el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/policy', { method: 'PUT', body: { ...pol, default: selDef.value, read_only_default: selRO.value } }); const body = { ...sw, workspace: ws.value.trim(), web_search: { provider: wsc.provider, api_key: wsc.api_key || (wsc.has_key ? '…' : ''), api_key_env: wsc.api_key_env || '', url: wsc.url || '' } }; await api('/api/builtin-tools', { method: 'PUT', body }); await api('/api/tool-catalog', { method: 'PUT', body: { mode: tcMode.value, threshold: parseInt(tcThr.value, 10) || 24, always: tcAlways.value } }); toast('saved'); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, 'Save')));
    const tb = el('tbody');
    for (const t of S.st.tools) {
      const sel = el('select', { class: 'select', onchange: async (e) => { const rules = { ...pol.rules }; if (e.target.value) rules[t.full_name] = e.target.value; else delete rules[t.full_name]; await api('/api/policy', { method: 'PUT', body: { ...pol, rules } }); pol.rules = rules; toast('rule saved'); } }, el('option', { value: '' }, 'default'), ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: pol.rules[t.full_name] === v }, v)));
      tb.append(el('tr', {}, el('td', { class: 'mono' }, t.full_name), el('td', {}, t.server), el('td', {}, t.read_only ? el('span', { class: 'chip ok' }, 'read-only') : null, ' ', t.destructive ? el('span', { class: 'chip warn' }, 'destructive') : null), el('td', {}, sel), el('td', { class: 'muted' }, (t.description || '').slice(0, 140))));
    }
    content.append(page('Tools & policy', 'what the agent may run, and when to ask you', polCard, el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'tool'), el('th', {}, 'server'), el('th', {}, 'flags'), el('th', {}, 'rule'), el('th', {}, 'description'))), tb))));
  }
  function pageAssistants(content) {
    const list = el('div', { class: 'listbox' });
    const ids = S.st.assistants.map((a) => a.id);
    const sel = S.sel.newAssistant ? null : (ids.includes(S.sel.assistantId) ? S.sel.assistantId : ids[0]);
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: () => { S.sel.newAssistant = true; render(); } }, I('plus', 'sm'), 'New assistant')));
    for (const a of S.st.assistants) list.append(el('div', { class: 'lrow' + (a.id === sel ? ' active' : ''), onclick: () => { S.sel.newAssistant = false; S.sel.assistantId = a.id; render(); } }, el('div', { class: 'em', style: 'background:transparent' }, assistantGlyph(a)), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, a.name), el('div', { class: 'sub truncate' }, a.model ? `${a.provider || 'default'} / ${shortModel(a.model)}` : 'default model')), S.st.default.assistant === a.id ? el('span', { class: 'chip primary' }, 'default') : null));
    const a = sel ? assistantOf(sel) : { id: '', name: '', emoji: '🤖', system_prompt: '', provider: '', model: '', tools: 'all', max_iterations: 25 };
    const d = { ...a, tools: Array.isArray(a.tools) ? a.tools.join(', ') : a.tools };
    const card = el('div', { class: 'card' },
      el('h3', {}, sel ? `Edit ${a.name}` : 'New assistant'),
      el('div', { class: 'grid2' }, field('Emoji', el('input', { class: 'input', value: d.emoji || '', oninput: (e) => { d.emoji = e.target.value; } })), field('Id', el('input', { class: 'input', value: d.id, disabled: !!sel, placeholder: 'writer', oninput: (e) => { d.id = e.target.value.trim(); } }))),
      field('Name', el('input', { class: 'input', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
      field('System prompt', el('textarea', { class: 'textarea', style: 'min-height:160px', value: d.system_prompt || '', oninput: (e) => { d.system_prompt = e.target.value; } })),
      el('div', { class: 'grid2' }, field('Provider (optional)', el('select', { class: 'select', onchange: (e) => { d.provider = e.target.value; } }, el('option', { value: '' }, '(default)'), ...S.st.providers.map((p) => el('option', { value: p.id, selected: p.id === d.provider }, p.label || p.id)))), field('Model (optional)', el('input', { class: 'input', value: d.model || '', oninput: (e) => { d.model = e.target.value.trim(); } }))),
      el('div', { class: 'grid2' }, field('Tools', el('input', { class: 'input', value: d.tools, placeholder: 'all · none · local__*, filesystem__read_file', oninput: (e) => { d.tools = e.target.value; } })), field('Max tool iterations', el('input', { class: 'input', type: 'number', value: d.max_iterations || 25, oninput: (e) => { d.max_iterations = parseInt(e.target.value || '25', 10); } }))),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { const tv = (d.tools || '').trim(); const tools = !tv || tv === 'all' ? 'all' : tv === 'none' ? 'none' : tv.split(',').map((s) => s.trim()).filter(Boolean); try { await api('/api/assistants', { method: 'POST', body: { id: d.id, name: d.name, emoji: d.emoji, system_prompt: d.system_prompt, provider: d.provider, model: d.model, tools, max_iterations: d.max_iterations } }); toast('saved'); S.sel.newAssistant = false; S.sel.assistantId = d.id; await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), 'Save'), sel ? el('button', { class: 'btn', onclick: async () => { await api('/api/default', { method: 'POST', body: { assistant: a.id } }); await loadState(); render(); } }, 'Use as default') : null, el('span', { class: 'spacer' }), sel && a.id !== 'default' ? el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(`Delete assistant ${a.name}?`)) { await api('/api/assistants/' + a.id, { method: 'DELETE' }); S.sel.assistantId = ''; await loadState(); render(); } } }, I('trash', 'sm'), 'Delete') : null));
    content.append(page('Assistants', 'system prompt + preferred model + tool set', el('div', { class: 'split' }, list, card)));
  }
  function pageAgents(content) {
    const xs = S.st.providers.filter((p) => p.kind === 'agentserver');
    const card = el('div', { class: 'card' });
    if (!xs.length) card.append(el('h3', {}, 'No agent server configured'), el('p', { class: 'muted', style: 'margin:0' }, 'Add a provider with the "Agent server" preset (server URL + e-mail + password). Then its agents appear here and as models in chat.'), el('div', {}, el('button', { class: 'btn primary', onclick: () => { S.settingsPage = 'providers'; render(); addProviderModal(); } }, 'Add provider')));
    else {
      const sel = el('select', { class: 'select' }, ...xs.map((p) => el('option', { value: p.id, selected: p.id === S.sel.agentProvider }, `${p.label || p.id} (${p.base_url})`)));
      const trust = { v: false };
      const agentsBox = el('div', { class: 'pill-list' });
      const bridgeBox = el('div');
      const renderBridges = () => { bridgeBox.innerHTML = ''; for (const b of S.st.bridges) bridgeBox.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (b.status === 'connected' ? 'ok' : b.status === 'connecting' ? 'warn' : 'err') }), el('b', {}, b.provider_id), el('span', { class: 'chip' }, b.status), el('span', { class: 'chip' }, `${b.tool_count} tools`), el('span', { class: 'chip' }, `${b.calls} calls`), el('span', { class: 'muted tiny' }, b.device_name), b.error ? el('span', { class: 'muted tiny', style: 'color:var(--destructive)' }, b.error.slice(0, 120)) : null)); if (!S.st.bridges.length) bridgeBox.append(el('div', { class: 'muted tiny' }, 'Bridge not running. Start it to let the server\'s agents call your local tools and MCP servers (through your policy).')); };
      renderBridges();
      card.append(el('h3', {}, 'Agent server'), field('Server', sel), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { agentsBox.innerHTML = 'loading…'; try { const ag = await api(`/api/agents/${encodeURIComponent(sel.value)}`); agentsBox.innerHTML = ''; for (const a of ag) agentsBox.append(el('span', { class: 'chip', style: 'cursor:pointer', title: 'chat with this agent', onclick: async () => { const p = providerOf(sel.value); const model = `${a.id}|${a.name}`; await api('/api/providers', { method: 'POST', body: { id: p.id, default_model: model, models: [...new Set([model, ...(p.models || [])])] } }); await loadState(); const pane = activePane(); pane.sel.provider = p.id; pane.sel.model = model; pane.convId = null; pane.conv = null; pane.messages = []; S.view = 'chat'; render(); } }, a.name)); if (!ag.length) agentsBox.textContent = 'no agents'; } catch (e) { agentsBox.textContent = e.message; } } }, I('refresh', 'sm'), 'List agents')), agentsBox, el('div', { class: 'sect' }, 'Device bridge'), bridgeBox, el('div', { class: 'row' }, switchEl(false, (v) => { trust.v = v; }), el('span', { class: 'muted tiny' }, 'trust: run "ask" tools without approval'), el('span', { class: 'spacer' }), el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/bridge/start', { method: 'POST', body: { provider_id: sel.value, trust: trust.v } }); toast('bridge starting'); setTimeout(async () => { await loadState(); render(); }, 2500); } catch (e) { toast(e.message, true); } } }, I('link', 'sm'), 'Start bridge'), el('button', { class: 'btn', onclick: async () => { await api('/api/bridge/stop', { method: 'POST', body: { provider_id: sel.value } }); await loadState(); render(); } }, 'Stop')));
    }
    content.append(page('Agent servers', 'chat with hosted agents, or lend this machine to them', card));
  }
  async function pageAudit(content) {
    const tb = el('tbody'); const wrap = page('Audit log', 'every tool call, decision and result', el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { S.settingsPage = 'audit'; render(); } }, I('refresh', 'sm'), 'Refresh')), el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'time'), el('th', {}, 'tool'), el('th', {}, 'decision'), el('th', {}, 'took'), el('th', {}, 'arguments'), el('th', {}, 'result'))), tb)));
    content.append(wrap);
    try { const rows = await api('/api/audit?limit=300'); for (const r of rows) tb.append(el('tr', {}, el('td', { class: 'muted tiny' }, new Date(r.ts * 1000).toLocaleString()), el('td', { class: 'mono' }, r.tool), el('td', {}, el('span', { class: 'chip ' + (r.is_error ? 'err' : r.decision === 'allow' || r.decision === 'human' ? 'ok' : 'warn') }, r.decision + (r.is_error ? ' · error' : ''))), el('td', {}, fmtMs(r.duration_ms)), el('td', { class: 'mono' }, (r.arguments || '').slice(0, 160)), el('td', { class: 'mono' }, (r.result_excerpt || '').slice(0, 160)))); if (!rows.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Nothing yet.'))); } catch (e) { toast(e.message, true); }
  }
  // ---- memory: facts the assistant keeps across chats (it saves them with memory_save; you can add, edit, delete)
  async function pageMemory(content) {
    const mem = S.st.memory || { enabled: true, recall_k: 5 };
    const on = switchEl(mem.enabled, async (v) => { try { await api('/api/memory-settings', { method: 'PUT', body: { enabled: v, recall_k: mem.recall_k } }); await loadState(); toast(v ? 'memory on' : 'memory off'); } catch (e) { toast(e.message, true); } });
    const k = el('input', { class: 'input', type: 'number', value: mem.recall_k, style: 'width:90px', onchange: async (e) => { try { await api('/api/memory-settings', { method: 'PUT', body: { enabled: mem.enabled, recall_k: parseInt(e.target.value || '5', 10) } }); await loadState(); toast('saved'); } catch (err) { toast(err.message, true); } } });
    const add = el('textarea', { class: 'textarea', style: 'min-height:70px', placeholder: 'Something to remember, e.g. "My webtoon is called Backstage; the uc board is the default."' });
    const listBox = el('div', { style: 'display:grid;gap:8px' });
    const refresh = async () => { const r = await api('/api/memory'); listBox.innerHTML = ''; if (!r.items.length) listBox.append(el('div', { class: 'muted tiny' }, 'Nothing remembered yet. The assistant saves facts with the memory_save tool when you ask it to remember something, or add one here.')); for (const m of r.items) { const ta = el('textarea', { class: 'textarea', style: 'min-height:44px', value: m.text }); listBox.append(el('div', { class: 'card', style: 'padding:10px 12px;gap:6px' }, ta, el('div', { class: 'row' }, el('span', { class: 'muted tiny' }, `${new Date(m.updated_at * 1000).toLocaleString()}${m.source ? ' · ' + m.source : ''}`), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async () => { try { await api('/api/memory/' + m.id, { method: 'PUT', body: { text: ta.value } }); toast('saved'); } catch (e) { toast(e.message, true); } } }, 'Save'), el('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog('Forget this memory?', 'Forget')) { await api('/api/memory/' + m.id, { method: 'DELETE' }); refresh(); } } }, 'Forget')))); } };
    content.append(page('Memory', 'what the assistant remembers about you across chats',
      el('div', { class: 'card' }, el('h3', {}, 'Recall', el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, 'enabled'), on), el('div', { class: 'muted tiny' }, 'Before each answer the best-matching memories are placed in the system prompt. The assistant can also search them (memory_search) and add new ones (memory_save).'), field('Memories recalled per message', k)),
      el('div', { class: 'card' }, el('h3', {}, 'Add a memory'), add, el('div', {}, el('button', { class: 'btn primary', onclick: async () => { const t = add.value.trim(); if (!t) return; try { await api('/api/memory', { method: 'POST', body: { text: t } }); add.value = ''; refresh(); toast('remembered'); } catch (e) { toast(e.message, true); } } }, I('plus', 'sm'), 'Remember'))),
      el('div', { class: 'card' }, el('h3', {}, 'Memories'), listBox)));
    try { await refresh(); } catch (e) { toast(e.message, true); }
  }
  // ---- knowledge base: folders and files indexed for retrieval (keyword search always, embeddings optional)
  async function pageKnowledge(content) {
    const kc = S.st.knowledge || {};
    const pathIn = el('input', { class: 'input', placeholder: 'Folder or file to index, e.g. D:\\notes or /home/me/docs' });
    const srcBox = el('div', { style: 'display:grid;gap:6px' });
    const statusBox = el('div', { class: 'muted tiny' });
    const prov = el('select', { class: 'select', onchange: () => fillModels() }, el('option', { value: '' }, '(keyword search only)'), ...S.st.providers.filter((p) => p.kind === 'openai').map((p) => el('option', { value: p.id, selected: p.id === kc.embeddings_provider }, p.label || p.id)));
    const modelIn = el('input', { class: 'input', value: kc.embeddings_model || '', placeholder: 'text-embedding-v4 · text-embedding-3-small · …', list: 'embModels' });
    const dl = el('datalist', { id: 'embModels' }, ...['text-embedding-v4', 'text-embedding-v3', 'text-embedding-3-small', 'text-embedding-3-large', 'bge-m3', 'nomic-embed-text'].map((m) => el('option', { value: m })));
    const fillModels = () => { if (!modelIn.value) modelIn.value = prov.value.includes('dashscope') ? 'text-embedding-v4' : prov.value.includes('openai') ? 'text-embedding-3-small' : ''; };
    const chunk = el('input', { class: 'input', type: 'number', value: kc.chunk_chars || 900, style: 'width:110px' });
    const topk = el('input', { class: 'input', type: 'number', value: kc.top_k || 6, style: 'width:90px' });
    const q = el('input', { class: 'input', placeholder: 'Try a search…', onkeydown: async (e) => { if (e.key === 'Enter' && q.value.trim()) { const r = await api('/api/knowledge/search?q=' + encodeURIComponent(q.value.trim())); hits.innerHTML = ''; if (!r.hits.length) hits.append(el('div', { class: 'muted tiny' }, 'no matches')); for (const h of r.hits) hits.append(el('div', { class: 'card', style: 'padding:10px 12px;gap:4px' }, el('div', { class: 'mono tiny truncate' }, `${h.path} · chunk ${h.idx} · ${h.score}`), el('div', { style: 'white-space:pre-wrap;font-size:12.5px' }, h.text.slice(0, 600)))); } } });
    const hits = el('div', { style: 'display:grid;gap:6px' });
    const refresh = async () => { const st = await api('/api/knowledge'); srcBox.innerHTML = ''; for (const s of st.sources || []) srcBox.append(el('div', { class: 'row', style: 'font-size:12.5px' }, I('box', 'sm'), el('span', { class: 'mono truncate', style: 'flex:1' }, s.path), el('span', { class: 'chip' }, `${s.files} files`), el('span', { class: 'chip' }, `${s.chunks} chunks`), s.error ? el('span', { class: 'chip err' }, s.error.slice(0, 60)) : null, el('button', { class: 'btn quiet icon sm', title: 'remove from the index', onclick: async () => { if (await confirmDialog(`Remove ${s.path} from the knowledge base?`, 'Remove')) { await api('/api/knowledge/sources/' + s.id, { method: 'DELETE' }); refresh(); } } }, I('trash', 'xs')))); if (!(st.sources || []).length) srcBox.append(el('div', { class: 'muted tiny' }, 'No sources yet. Add a folder of notes, docs or code.')); statusBox.textContent = `${st.chunks} chunks · ${st.vectors} with embeddings · ${st.indexing ? 'indexing…' : 'idle'}${st.last && st.last.seconds != null ? ` · last run ${st.last.seconds}s${st.last.embed_error ? ' · embeddings: ' + st.last.embed_error : ''}` : ''}`; if (st.indexing) setTimeout(refresh, 2000); };
    content.append(page('Knowledge base', 'your folders and files, searchable by the assistant and injected on demand',
      el('div', { class: 'card' }, el('h3', {}, 'Sources'), srcBox, el('div', { class: 'row' }, pathIn, el('button', { class: 'btn primary', onclick: async () => { const p = pathIn.value.trim(); if (!p) return; try { await api('/api/knowledge/sources', { method: 'POST', body: { path: p } }); pathIn.value = ''; toast('added · indexing'); setTimeout(refresh, 800); } catch (e) { toast(e.message, true); } } }, I('plus', 'sm'), 'Add'), el('button', { class: 'btn', onclick: async () => { await api('/api/knowledge/reindex', { method: 'POST' }); toast('reindexing'); setTimeout(refresh, 800); } }, I('refresh', 'sm'), 'Reindex')), statusBox, el('div', { class: 'muted tiny' }, 'Files are chunked and indexed for substring search (any language). Changed files are re-read on reindex. Once something is indexed, the best excerpts go into context automatically for every message; /knowledge in the composer forces more of them, and the assistant can also call knowledge_search.'), el('div', { class: 'row', style: 'margin-top:8px' }, switchEl(kc.auto !== false, async (v) => { try { await api('/api/knowledge/settings', { method: 'PUT', body: { embeddings_provider: kc.embeddings_provider || '', embeddings_model: kc.embeddings_model || '', chunk_chars: kc.chunk_chars || 900, top_k: kc.top_k || 6, auto: v } }); toast(v ? 'automatic retrieval on' : 'automatic retrieval off'); await loadState(); } catch (e) { toast(e.message, true); } }), 'Automatic retrieval for every message')),
      el('div', { class: 'card' }, el('h3', {}, 'Embeddings (optional)'), el('div', { class: 'muted tiny' }, 'Semantic search on top of keyword search: any OpenAI-compatible /embeddings endpoint (DashScope text-embedding-v4, OpenAI text-embedding-3-small, a local vLLM). Vectors are computed on reindex.'), el('div', { class: 'grid2' }, field('Provider', prov), field('Model', el('div', {}, modelIn, dl))), el('div', { class: 'grid2' }, field('Chunk size (chars)', chunk), field('Excerpts per message', topk)), el('div', {}, el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/knowledge/settings', { method: 'PUT', body: { embeddings_provider: prov.value, embeddings_model: modelIn.value.trim(), chunk_chars: parseInt(chunk.value || '900', 10), top_k: parseInt(topk.value || '6', 10), auto: kc.auto !== false } }); toast('saved · reindex to compute embeddings'); await loadState(); } catch (e) { toast(e.message, true); } } }, 'Save'))),
      el('div', { class: 'card' }, el('h3', {}, 'Test a search'), q, hits)));
    try { await refresh(); } catch (e) { toast(e.message, true); }
  }
  function pageGeneral(content) {
    const st = S.st;
    content.append(page('General', 'this studio', el('div', { class: 'card' }, el('h3', {}, 'Server'), el('div', { class: 'grid2' }, field('Version', el('div', {}, 'missile-studio ' + st.version)), field('Bound to', el('div', {}, `${st.server.host}:${st.server.port}` + (st.server.auth_required ? ' · token required' : ' · loopback, no token'))), field('Config file', el('code', {}, st.config_path)), field('Data folder', el('code', {}, st.home))), el('div', { class: 'muted tiny' }, 'Change host/port/token with ', el('code', {}, 'ms serve --host 0.0.0.0 --port 7700 --token …'), ' or ', el('code', {}, 'ms config set-token …'), '. The admin console at ', el('a', { href: '/admin', target: '_blank' }, '/admin'), ' manages tokens, logs, retention and system status.')),
      st.server.auth_required ? (() => { const who = el('div', { class: 'muted tiny' }, S.health?.via === 'cookie' ? 'Signed in with an account (cookie session).' : 'Signed in with an access token kept in this browser.'); api('/api/admin/auth/me').then((me) => { who.textContent = `Signed in as ${me.username} · ${me.role}${me.role === 'admin' ? ' (the same session opens /admin)' : ' (chat only: settings belong to the admin)'}`; }).catch(() => {}); return el('div', { class: 'card' }, el('h3', {}, 'Session'), who, el('div', {}, el('button', { class: 'btn', onclick: signOut }, I('x', 'sm'), 'Sign out'))); })() : null,
      el('div', { class: 'card' }, el('h3', {}, 'Appearance'), el('div', { class: 'row' }, el('button', { class: 'btn' + (theme.get() === 'dark' ? ' primary' : ''), onclick: () => theme.set('dark') }, I('moon', 'sm'), 'Dark'), el('button', { class: 'btn' + (theme.get() === 'warm' ? ' primary' : ''), onclick: () => theme.set('warm') }, I('sparkles', 'sm'), 'Warm'), el('button', { class: 'btn' + (theme.get() === 'light' ? ' primary' : ''), onclick: () => theme.set('light') }, I('sun', 'sm'), 'Light')), el('div', { class: 'muted tiny' }, 'Dark is the default. Warm: cream paper, terracotta accents, serif headings.')),
      el('div', { class: 'card' }, el('h3', {}, 'Keyboard'), el('div', {}, el('button', { class: 'btn', onclick: openShortcuts }, I('info', 'sm'), 'Show all shortcuts (Ctrl/⌘ /)'))),
      el('div', { class: 'card' }, el('h3', {}, 'Use this studio elsewhere'), el('div', { class: 'md', html: md('- **Terminal / SSH**: `ms chat`, `ms ask "…" --json`\n- **As one MCP server** for other MCP clients: `ms hub` (stdio) or `ms hub --http --port 7701`\n- **Lend tools to an agent server**: `ms bridge --provider <id>`\n- **API**: `Authorization: Bearer <token>`, docs at [/api/docs](/api/docs)') }))));
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { const h = await fetch('/api/health', { headers: headers() }).then((r) => r.json()); S.health = h; if (h.auth_required && !token && !h.signed_in) return showLogin(); } catch {}
    try { await loadState(); await loadConvs(); } catch (e) { if (e.message !== 'unauthorized') toast(e.message, true); return; }
    try { S.me = await api('/api/admin/auth/me'); } catch { S.me = null; }  // who am I (username, role) for avatars and the session card
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    if (!S.st.providers.length) { S.view = 'settings'; S.settingsPage = 'providers'; }
    render();
    setInterval(async () => { if (S.view.startsWith('settings') && (S.settingsPage === 'mcp' || S.settingsPage === 'agents')) { try { await loadState(); } catch {} } }, 6000);
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && e.shiftKey) { e.preventDefault(); $('.composerInput', paneEl(activePane()))?.focus(); return; }
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); openPalette(); }
      else if (k === 'o' && e.shiftKey) { e.preventDefault(); newConv(activePane()); }
      else if (e.key === ',') { e.preventDefault(); S.view = 'settings'; render(); }
      else if (e.key === '/') { e.preventDefault(); openShortcuts(); }
      else if (e.key === '\\') { e.preventDefault(); splitPane(S.active); }
      else if (k === 'w' && e.shiftKey) { e.preventDefault(); closePane(S.active); }
      else if (k === 'j') { e.preventDefault(); if (S.drawer.open) { S.drawer.open = false; render(); } else openDrawer(); }
      else if (k === 'c' && e.shiftKey) { e.preventDefault(); const t = lastAssistantText(activePane()); if (t) navigator.clipboard.writeText(t).then(() => toast('last answer copied')); }
      else if (e.key === ';' && e.shiftKey) { e.preventDefault(); const t = lastAssistantText(activePane()); const m = [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].pop(); if (m) navigator.clipboard.writeText(m[1]).then(() => toast('last code block copied')); else toast('no code block in the last answer', true); }
    });
  }
  boot();
})();
