/* missile-studio web UI v4: rail + list pane + split chat panes + workspace/artifacts drawer. Vanilla JS, no build. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      // value is set as the property: a textarea ignores a value attribute and would show up empty
      if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k === 'style') n.style.cssText = v; else if (k === 'value') n.value = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const I = (name, cls) => window.icon(name, cls);
  const LOC = () => (i18n.lang === 'ko' ? 'ko-KR' : 'en-US');  // dates and times follow the UI language
  const T = window.T;  // UI text: written in English here, other languages live in i18n.js
  // a translated sentence with elements (code, links) in its {slots}
  const rich = (s, parts) => s.split(/(\{\w+\})/).map((x) => { const k = x.match(/^\{(\w+)\}$/); return k && parts[k[1]] !== undefined ? parts[k[1]] : x; });
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
  // a message time: the clock for today, the date too for older ones
  const fmtClock = (ts) => { const d = new Date(ts * 1000); return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(LOC(), { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(LOC(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const fmtK = (n) => n >= 1000 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k' : String(n);
  const fmtBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  const initials = (s) => (s || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const avatarStyle = (s) => `background: hsl(${hue(s)} 55% 48%)`;
  const shortModel = (m) => (m || '').includes('|') ? m.split('|')[1] : m || '';
  // provider reachability (probed by the server every 2 minutes and after every turn): ok · down · nokey · unknown
  const HEALTH_LABEL = { ok: 'reachable', down: 'unreachable', nokey: 'no API key', unknown: 'not checked yet' };
  const healthOf = (p) => (p && p.health) || { state: 'unknown', error: '' };
  const healthLabel = (s) => T(HEALTH_LABEL[s] || s);
  const hdot = (p) => { const h = healthOf(p); return el('span', { class: 'hdot ' + h.state, title: `${p?.label || p?.id || ''}: ${healthLabel(h.state)}${h.error ? ' · ' + h.error : ''}${h.ms ? ' · ' + h.ms + 'ms' : ''}` }); };
  const unusable = (p) => ['down', 'nokey'].includes(healthOf(p).state);
  // tool catalog: above the threshold the model is sent one line per tool and loads the ones it needs
  const catalogOn = () => { const c = (S.st && S.st.tool_catalog) || {}; return c.mode === 'on' || (c.mode !== 'off' && (S.st?.tools?.length || 0) > (c.threshold || 24)); };
  // permission mode of a chat: remembered per conversation, and the last choice becomes the default for new chats
  const PERM = { '': ['Ask', 'Asks before tools that write or run things, as your tool policy sets.'], auto: ['Allow all', 'Runs every tool in this chat without asking. Blocked tools and dangerous shell commands still stop.'], readonly: ['Read-only', 'Only read-only tools run in this chat. Tools that write or run things are off.'] };
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
      el('header', {}, el('h3', {}, title), el('span', { class: 'spacer' }), el('button', { class: 'btn quiet icon sm', onclick: () => close(), 'aria-label': T('Close') }, I('x', 'sm'))),
      el('div', { class: 'body' }, body), footer ? el('footer', {}, footer) : null);
    bd.append(m); $('#layer').append(bd);
    function close() { bd.remove(); document.removeEventListener('keydown', esc_); }
    const esc_ = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc_);
    return { close, root: m };
  }
  const confirmDialog = (text, okLabel = T('Delete')) => new Promise((res) => { const m = modal({ title: T('Are you sure?'), body: el('p', { style: 'margin:0' }, text), footer: [el('button', { class: 'btn', onclick: () => { m.close(); res(false); } }, T('Cancel')), el('button', { class: 'btn danger', onclick: () => { m.close(); res(true); } }, okLabel)] }); });
  const promptDialog = (title, value, help) => new Promise((res) => { const inp = el('input', { class: 'input', value }); const m = modal({ title, body: [inp, help ? el('div', { class: 'muted tiny' }, help) : null], footer: [el('button', { class: 'btn', onclick: () => { m.close(); res(null); } }, T('Cancel')), el('button', { class: 'btn primary', onclick: () => { m.close(); res(inp.value.trim()); } }, T('OK'))] }); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { m.close(); res(inp.value.trim()); } }); setTimeout(() => inp.focus(), 0); });
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
      if (!list.children.length) list.append(el('div', { class: 'mitem muted' }, T('No matches')));
    };
    if (searchable) { const inp = el('input', { class: 'input', placeholder: T('Search…'), oninput: () => render(inp.value) }); m.append(el('div', { class: 'msearch' }, inp)); setTimeout(() => inp.focus(), 0); }
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
    if ($('#suPass').value !== $('#suPass2').value) { err.textContent = T('The passwords do not match.'); return; }
    try {
      token = ''; localStorage.removeItem('missile_token');
      await api('/api/admin/auth/signup', { method: 'POST', body: { username: $('#suUser').value.trim(), password: $('#suPass').value, invite_code: $('#suInvite').value.trim(), remember: true } });
      swapAuth(false); $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); await boot();
    } catch (e2) {
      const m = e2.message || '';
      err.textContent = m === 'bad_invite_code' ? T('The invite code is not valid.') : m === 'username_taken' ? T('That username is already taken.') : m === 'signup_closed' ? T('Sign-up is closed.') : m === 'rate_limited' ? T('Too many attempts. Try again in a minute.') : (m || T('Could not create the account.'));
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
    } catch (e2) { err.textContent = tokenVal ? T('The access token was not accepted.') : (e2.message === 'rate_limited' ? T('Too many attempts. Try again in a minute.') : T('Wrong username or password.')); }
  });
  async function signOut() { try { await api('/api/admin/auth/logout', { method: 'POST' }); } catch {} token = ''; try { localStorage.removeItem('missile_token'); } catch {} location.reload(); }

  // ---------------------------------------------------------------- state
  const newPane = () => ({ id: Math.random().toString(36).slice(2, 8), convId: null, conv: null, messages: [], branches: {}, sel: {}, attachments: [], draft: '', editing: null, pendingEdit: null });
  const S = { st: null, convs: [], unread: {}, view: 'chat', settingsPage: 'providers', sel: {}, search: '', panes: [newPane()], active: 0, live: {}, linkInputs: false, artifacts: {},
    drawer: { open: false, tab: 'files', path: '.', entries: [], file: null, term: [], loading: false, artifact: null, aTab: 'preview', versions: null } };
  const THEMES = ['dark', 'warm', 'light'];  // dark is the default look
  const theme = {
    get: () => document.documentElement.getAttribute('data-theme') || 'dark',
    set(t) { t = t || 'dark'; document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('missile_theme', t); } catch {} render(); },
    toggle() { const cur = this.get(); this.set(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]); },
  };
  // chat text size and width (per browser; applied before first paint by the script in index.html)
  const view = {
    get: (k) => document.documentElement.getAttribute('data-' + k) || '',
    set(k, v) { if (v) document.documentElement.setAttribute('data-' + k, v); else document.documentElement.removeAttribute('data-' + k); try { if (v) localStorage.setItem('missile_' + k, v); else localStorage.removeItem('missile_' + k); } catch {} render(); },
  };
  // UI language (English / Korean), remembered in this browser; each language is named in itself
  const LANG_NAME = { en: 'English', ko: '한국어' };
  function setLang(l) { i18n.set(l); render(); }
  // the stock emoji (🤖 🚀 💬 🧑) are treated as "no emoji": only an emoji the user chose is ever shown
  const STOCK_EMOJI = new Set(['🤖', '🚀', '💬', '🧑', '']);
  // my messages: the owner's photo for admin sessions, otherwise the account's initials (cool tones, no orange)
  // assistants: a custom emoji if one was set, otherwise a small single-colour glyph (lists show nothing at all)
  const assistantGlyph = (a, size) => (a?.emoji && !STOCK_EMOJI.has(a.emoji)) ? el('span', { class: 'avatar emoji' + (size ? ' ' + size : '') }, a.emoji) : el('span', { class: 'glyph' + (size ? ' ' + size : ''), title: a?.name || T('Assistant') }, I('sparkles', size === 'sm' ? 'xs' : 'sm'));
  const customEmoji = (a) => (a?.emoji && !STOCK_EMOJI.has(a.emoji)) ? el('span', { class: 'cemoji' }, a.emoji) : null;
  const userAvatar = () => (S.me && S.me.role === 'admin') ? el('img', { class: 'avatar photo', src: '/static/brand/avatar.png?v=2', alt: '', title: S.me.username || 'me', draggable: 'false' }) : el('span', { class: 'avatar', style: '--a1:#60a5fa;--a2:#8b5cf6', title: S.me?.username || 'me' }, (S.me?.username || 'me').slice(0, 2).toUpperCase());
  async function loadState() { S.st = await api('/api/state'); if ((S.st.wake || []).some((j) => j.state === 'running' || j.state === 'reconnecting') && !wakeTimer) pollWake(); }
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

  // ---------------------------------------------------------------- sidebar: drag its edge to resize, Ctrl/⌘ B to hide (both remembered in this browser)
  const PANE_W = { min: 200, max: 480, def: 272 };
  const ui = { paneW: PANE_W.def, paneHidden: false, mobilePane: false };
  try { const w = parseInt(localStorage.getItem('missile_pane_w'), 10); if (w) ui.paneW = Math.min(PANE_W.max, Math.max(PANE_W.min, w)); ui.paneHidden = localStorage.getItem('missile_pane_hidden') === '1'; } catch {}
  const narrow = () => matchMedia('(max-width: 900px)').matches;  // the list opens over the chat there
  const phone = () => matchMedia('(max-width: 640px)').matches;
  function setPaneHidden(v) { ui.paneHidden = v; try { localStorage.setItem('missile_pane_hidden', v ? '1' : '0'); } catch {} }
  function togglePane() { if (narrow()) ui.mobilePane = !ui.mobilePane; else setPaneHidden(!ui.paneHidden); render(); }
  function setPaneW(w, save) { ui.paneW = Math.min(PANE_W.max, Math.max(PANE_W.min, Math.round(w))); $('.shell')?.style.setProperty('--pane', ui.paneW + 'px'); if (save) try { localStorage.setItem('missile_pane_w', String(ui.paneW)); } catch {} }
  function paneGrip() {
    const g = el('div', { class: 'pane-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': T('Resize sidebar'), tabindex: '0', title: T('Drag to resize · double-click to reset') });
    g.addEventListener('pointerdown', (e) => {
      if (narrow() || e.button !== 0) return;
      e.preventDefault(); g.setPointerCapture(e.pointerId);
      const shell = g.closest('.shell'); const x0 = e.clientX, w0 = ui.paneW; let raw = w0;
      shell.classList.add('resizing');
      const move = (ev) => { raw = w0 + ev.clientX - x0; shell.classList.toggle('pane-closing', raw < PANE_W.min - 60); setPaneW(raw, false); };
      const up = () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); shell.classList.remove('resizing', 'pane-closing'); if (raw < PANE_W.min - 60) { setPaneW(w0, true); setPaneHidden(true); render(); } else setPaneW(ui.paneW, true); };
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up);
    });
    g.addEventListener('dblclick', () => setPaneW(PANE_W.def, true));
    g.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setPaneW(ui.paneW + (e.key === 'ArrowLeft' ? -16 : 16), true); } });
    return g;
  }
  const hidePaneBtn = () => el('button', { class: 'btn quiet icon sm', title: T('Hide sidebar') + ' (Ctrl/⌘ B)', 'aria-label': T('Hide sidebar'), onclick: togglePane }, I('sidebar', 'sm'));

  // ---------------------------------------------------------------- shell
  function render() {
    const app = $('#app'); app.innerHTML = '';
    if (S.view.startsWith('settings')) { app.append(renderSettings()); return; }
    const showPane = !ui.paneHidden || narrow();
    const shell = el('div', { class: 'shell' + (showPane ? '' : ' no-pane') + (ui.mobilePane ? ' show-pane' : ''), style: `--pane:${ui.paneW}px` });
    shell.append(renderRail());
    if (showPane) shell.append(S.view === 'assistants' ? renderAssistantPane() : renderConvPane());
    if (ui.mobilePane) shell.append(el('div', { class: 'pane-scrim', onclick: () => { ui.mobilePane = false; render(); } }));
    const main = el('div', { class: 'main multi' });
    const panes = el('div', { class: 'panes' });
    S.panes.forEach((p, i) => panes.append(renderPane(p, i)));
    main.append(panes);
    if (S.drawer.open) main.append(renderDrawer());
    shell.append(main);
    app.append(shell);
  }
  function openDrawer(tab) { S.drawer.open = true; if (tab) S.drawer.tab = tab; if (!isAdmin()) S.drawer.tab = 'artifacts'; if (tab === 'artifacts') S.drawer.artifact = null; S.view = 'chat'; render(); if (S.drawer.tab === 'files') loadTree(S.drawer.path); }
  function renderRail() {
    const btn = (name, icon, label, onclick) => el('button', { class: S.view === name || (name === 'settings' && S.view.startsWith('settings')) ? 'active' : '', onclick, 'aria-label': label }, I(icon), el('span', { class: 'tip' }, label));
    const cur = theme.get();
    // clicking the view you are already on shows or hides its list; switching views brings the list back
    const view = (name) => () => { if (S.view === name) return togglePane(); S.view = name; if (ui.paneHidden) setPaneHidden(false); render(); };
    const listTip = (name, label, showLabel) => S.view === name ? (ui.paneHidden && !narrow() ? showLabel : T('{list} · click to hide the list', { list: label })) : label;
    const other = i18n.lang === 'ko' ? 'en' : 'ko';
    return el('div', { class: 'rail' },
      el('button', { class: 'logo', html: window.logoMark(34), 'aria-label': T('About missile studio'), onclick: () => openIntro() }, el('span', { class: 'tip' }, T('About missile studio'))),
      btn('chat', 'chat', listTip('chat', T('Chats'), T('Show chats')), view('chat')),
      btn('assistants', 'sparkles', listTip('assistants', T('Assistants'), T('Show assistants')), view('assistants')),
      btn('settings', 'settings', T('Settings'), () => { S.view = 'settings'; render(); }),
      el('div', { class: 'bottom' },
        el('button', { class: S.drawer.open ? 'active' : '', onclick: () => { if (S.drawer.open) { S.drawer.open = false; render(); } else openDrawer(); }, 'aria-label': T('Workspace') }, I('file'), el('span', { class: 'tip' }, T('Workspace · artifacts') + ' (Ctrl/⌘ J)')),
        el('button', { onclick: () => openPalette(), 'aria-label': T('Search') }, I('search'), el('span', { class: 'tip' }, T('Search & commands') + ' (Ctrl/⌘ K)')),
        el('button', { onclick: () => theme.toggle(), 'aria-label': T('Theme') }, I(cur === 'dark' ? 'moon' : cur === 'warm' ? 'sparkles' : 'sun'), el('span', { class: 'tip' }, T('Theme: {cur} → {next}', { cur: T(cur), next: T(THEMES[(THEMES.indexOf(cur) + 1) % 3]) }))),
        isAdmin() ? el('button', { onclick: () => window.open('/admin', '_blank'), 'aria-label': T('Admin console') }, I('shield'), el('span', { class: 'tip' }, T('Admin console'))) : null,
        el('button', { class: 'lang', onclick: () => setLang(other), 'aria-label': T('Language') }, I('globe', 'sm'), el('span', { class: 'lang-badge' }, i18n.lang === 'ko' ? '한국어' : 'EN'), el('span', { class: 'tip' }, `${T('Language')}: ${LANG_NAME[i18n.lang]} → ${LANG_NAME[other]}`)),
        // sign out where it is seen, not only under Settings › General (only when the server asks for a sign-in)
        S.st?.server?.auth_required ? el('button', { onclick: signOut, 'aria-label': T('Sign out') }, I('power'), el('span', { class: 'tip' }, T('Sign out'))) : null));
  }

  // ---------------------------------------------------------------- list panes
  function groupLabel(ts) { const d = new Date(ts * 1000), now = new Date(); if (d.toDateString() === now.toDateString()) return T('Today'); const y = new Date(now); y.setDate(now.getDate() - 1); if (d.toDateString() === y.toDateString()) return T('Yesterday'); if (now - d < 7 * 86400e3) return T('Previous 7 days'); return T('Older'); }
  async function deleteConv(id) {
    if (!(await confirmDialog(T('Delete this chat and all its messages?')))) return;
    await api('/api/conversations/' + id, { method: 'DELETE' });
    for (const p of S.panes) if (p.convId === id) { p.convId = null; p.conv = null; p.messages = []; p.branches = {}; }
    await loadConvs(); render();
  }
  // ---- one chat's ⋯ menu in the list: rename, pin to the top, export, delete
  function convMenu(anchor, c) {
    menu(anchor, [
      { label: T('Rename'), icon: 'edit', run: () => renameConv(c) },
      { label: c.pinned > 0 ? T('Unpin') : T('Pin to top'), icon: 'pin', run: () => pinConv(c, !(c.pinned > 0)) },
      { label: T('Export as Markdown'), icon: 'download', run: () => exportConv(c.id, 'md') },
      { label: T('Export as JSON'), icon: 'download', run: () => exportConv(c.id, 'json') },
      { label: T('Delete'), icon: 'trash', run: () => deleteConv(c.id) },
    ], { onPick: (it) => it.run() });
  }
  async function renameConv(c) {
    const title = await promptDialog(T('Rename chat'), c.title || '', '');
    if (title == null || title === c.title) return;
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { title } }); for (const p of S.panes) if (p.convId === c.id && p.conv) p.conv.title = title; await loadConvs(); render(); } catch (e) { toast(e.message, true); }
  }
  async function pinConv(c, on) {
    try { await api('/api/conversations/' + c.id, { method: 'PATCH', body: { pinned: on } }); await loadConvs(); render(); } catch (e) { toast(e.message, true); }
  }
  // the visible branch of a chat as Markdown (tool calls as one line each) or as the full JSON
  async function exportConv(id, fmt) {
    let c; try { c = await api('/api/conversations/' + id); } catch (e) { return toast(e.message, true); }
    const name = (c.title || 'chat').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'chat';
    if (fmt === 'json') return saveBlob(name + '.json', JSON.stringify(c, null, 2), 'application/json');
    const out = [`# ${c.title || T('New chat')}`, '']; let last = '';
    for (const m of c.messages || []) {
      if (m.role === 'user' && m.meta?.note) continue;
      if (m.role === 'user') { out.push(`## ${T('You')}`, '', textOf(m), ''); last = 'user'; }
      else if (m.role === 'assistant') {
        if (last !== 'assistant') out.push(`## ${T('Assistant')}${m.meta?.model ? ` · ${shortModel(m.meta.model)}` : ''}`, '');
        if (m.content) out.push(m.content, '');
        for (const tc of m.tool_calls || []) out.push(`> ${T('Tool')}: \`${tc.name}\``, '');
        last = 'assistant';
      }
    }
    saveBlob(name + '.md', out.join('\n'), 'text/markdown;charset=utf-8');
  }
  function renderConvPane() {
    const pane = el('div', { class: 'pane' });
    pane.append(paneGrip(), el('div', { class: 'pane-head' }, el('h2', {}, T('Chats')), el('span', { class: 'spacer' }), el('button', { class: 'btn primary sm', onclick: () => newConv(activePane()) }, I('plus', 'sm'), T('New chat')), hidePaneBtn()));
    const search = el('input', { class: 'input', placeholder: T('Search chats'), value: S.search, oninput: (e) => { S.search = e.target.value; renderList(); } });
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
        const seen = new Set(); const box = el('div', { class: 'srch' }, el('div', { class: 'pane-group' }, T('In messages')));
        for (const h of r.hits) {
          if (seen.has(h.conversation_id)) continue; seen.add(h.conversation_id);
          box.append(el('div', { class: 'pane-item hit', onclick: () => openConv(activePane(), h.conversation_id) }, el('div', { class: 'body' }, el('div', { class: 'title truncate' }, h.title || T('New chat')), el('div', { class: 'snip', html: hl(h.snippet) }))));
        }
        if (seen.size) list.append(box);
      }, 250);
      for (const c of items) {
        const g = c.pinned > 0 ? T('Pinned') : groupLabel(c.updated_at); if (g !== last) { list.append(el('div', { class: 'pane-group' }, g)); last = g; }
        const a = assistantOf(c.assistant_id); const running = !!S.live[c.id] || c.running;
        list.append(el('div', { class: 'pane-item' + (activePane().convId === c.id ? ' active' : ''), style: openIds.has(c.id) && activePane().convId !== c.id ? 'box-shadow: inset 0 0 0 1px var(--border)' : '', onclick: () => openConv(activePane(), c.id) },
          el('div', { class: 'body' }, el('div', { class: 'title truncate' }, customEmoji(a), c.title || T('New chat')), el('div', { class: 'sub truncate' }, running ? T('Running…') : (shortModel(c.model) || providerOf(c.provider_id)?.label || ''))),
          running ? el('span', { class: 'run', title: T('A turn is running') }) : S.unread[c.id] ? el('span', { class: 'unread', title: T('New answer') }) : null, running ? null : el('button', { class: 'x', title: T('More'), 'aria-label': T('More'), onclick: (e) => { e.stopPropagation(); convMenu(e.currentTarget, c); } }, I('more', 'sm'))));
      }
      if (!items.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px 10px' }, S.convs.length ? T('No chats match.') : T('No chats yet. Start one.')));
    }
    renderList();
    pane.append(el('div', { class: 'muted tiny pane-hint', style: 'padding:8px 14px;border-top:1px solid var(--border)' }, S.panes.length > 1 ? T('{n} panes · a chat you pick opens in the highlighted pane', { n: S.panes.length }) : T('Ctrl/⌘ K searches chats and commands · ⫿ splits the view')));
    return pane;
  }
  function renderAssistantPane() {
    const pane = el('div', { class: 'pane' });
    pane.append(paneGrip(), el('div', { class: 'pane-head' }, el('h2', {}, T('Assistants')), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: () => { S.view = 'settings'; S.settingsPage = 'assistants'; render(); } }, I('edit', 'sm'), T('Manage')), hidePaneBtn()));
    const list = el('div', { class: 'pane-list' }); pane.append(list);
    const cur = targetOf(activePane());
    for (const a of S.st.assistants) list.append(el('div', { class: 'pane-item' + (cur.aid === a.id ? ' active' : ''), onclick: () => setAssistant(activePane(), a.id) }, customEmoji(a) ? el('div', { class: 'em' }, customEmoji(a)) : null, el('div', { class: 'body' }, el('div', { class: 'title truncate' }, a.name), el('div', { class: 'sub truncate' }, (a.system_prompt || T('No system prompt')).slice(0, 60)))));
    list.append(el('div', { style: 'padding:10px' }, el('button', { class: 'btn sm', style: 'width:100%', onclick: () => { S.view = 'settings'; S.settingsPage = 'assistants'; S.sel.newAssistant = true; render(); } }, I('plus', 'sm'), T('Add assistant'))));
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
    const pill = el('button', { class: 'picker' + (unusable(t.provider) ? ' dim' : ''), title: T('Choose a model: quick presets first, then every model') }, el('span', { class: 'pv' }, preset ? preset.label : (t.provider?.label || t.pid || T('No provider')).split(' ')[0]), el('span', { class: 'name truncate' }, shortModel(t.model) || T('Pick a model')), t.provider ? hdot(t.provider) : null, I('chevron', 'xs'));
    pill.addEventListener('click', () => openModelMenu(pane, pill));
    return pill;
  }
  // the same menu opens from the top-bar pill and from the model label in the composer
  function openModelMenu(pane, anchor, then) {
      const t = targetOf(pane); const preset = presetOf(pane, t);
      const items = [];
      if ((S.st.model_presets || []).length) {
        items.push({ group: T('Quick') });
        for (const p of S.st.model_presets) { const pp = providerOf(p.provider); const h = healthOf(pp); items.push({ label: `${p.label} · ${shortModel(p.model)}`, sub: `${pp?.label || p.provider}${p.thinking ? ' · ' + T(THINK_LABEL[p.thinking]) : ''}${unusable(pp) ? ' · ' + healthLabel(h.state) : ''}`, icon: p.id === 'fast' ? 'activity' : p.id === 'best' ? 'sparkles' : 'brain', pid: p.provider, model: p.model, thinking: p.thinking, presetId: p.id, selected: preset && preset.id === p.id, dim: unusable(pp), title: h.error || '' }); }
      }
      for (const p of S.st.providers) {
        const models = [...new Set([p.default_model, ...(p.models || [])].filter(Boolean))];
        const h = healthOf(p); const bad = unusable(p);
        items.push({ group: (p.label || p.id) + (bad ? ` · ${healthLabel(h.state)}` : '') });
        if (!models.length) items.push({ label: T('No models yet. Find them in Settings.'), sub: p.id, pid: p.id, model: '', dim: bad });
        for (const m of models.slice(0, 400)) items.push({ label: shortModel(m), sub: p.id + (bad ? ' · ' + healthLabel(h.state) : ''), pid: p.id, model: m, selected: !preset && p.id === t.pid && m === t.model, dim: bad, title: h.error || '' });
      }
      if (!items.length) items.push({ label: T('Add a provider in Settings'), sub: '', pid: '', model: '' });
      menu(anchor, items, { searchable: true, onPick: (it) => { if (!it.pid) { S.view = 'settings'; S.settingsPage = 'providers'; render(); return; } applyTarget(pane, it.pid, it.model, it.thinking, it.presetId).then(() => then && then()); } });
  }
  const THINK_ORDER = ['', 'on', 'max', 'off'];
  function cycleThinking(pane) { pane.sel.thinking = THINK_ORDER[(THINK_ORDER.indexOf(pane.sel.thinking || '') + 1) % THINK_ORDER.length]; pane.sel.preset = null; render(); }
  function thinkingButton(pane) {
    const cur = pane.sel.thinking || '';
    return el('button', { class: 'ico' + (cur === 'on' || cur === 'max' ? ' on' : ''), title: T('Thinking: {mode} · click to cycle (default → on → max → off)', { mode: T(THINK_LABEL[cur]) }), onclick: () => cycleThinking(pane) }, I('brain', 'sm'));
  }

  // ---------------------------------------------------------------- chat settings: instructions, temperature and output length for one chat
  const chatSettingsOf = (pane) => (pane.conv ? pane.conv.settings : pane.sel.chatSettings) || {};
  const hasChatSettings = (cs) => !!(cs.instructions || cs.temperature != null || cs.max_tokens);
  function chatSettingsButton(pane) {
    const cs = chatSettingsOf(pane); const on = hasChatSettings(cs);
    const tip = on ? [cs.instructions ? T('Instructions: {text}', { text: cs.instructions.slice(0, 80) }) : '', cs.temperature != null ? T('Temperature {n}', { n: cs.temperature }) : '', cs.max_tokens ? T('Max output tokens {n}', { n: cs.max_tokens }) : ''].filter(Boolean).join('\n') : T('Chat settings: instructions, temperature, answer length');
    return el('button', { class: 'ico' + (on ? ' on' : ''), title: tip, 'aria-label': T('Chat settings'), onclick: () => openChatSettings(pane) }, I('sliders', 'sm'));
  }
  function openChatSettings(pane) {
    const cs = { ...chatSettingsOf(pane) };
    const ins = el('textarea', { class: 'textarea', style: 'min-height:120px', placeholder: T('e.g. Answer in Korean. Keep code comments short.'), value: cs.instructions || '' });
    const temp = el('input', { class: 'input', type: 'number', min: 0, max: 2, step: 0.1, placeholder: T('Assistant default'), value: cs.temperature ?? '' });
    const maxT = el('input', { class: 'input', type: 'number', min: 1, placeholder: T('Assistant default'), value: cs.max_tokens ?? '' });
    const save = async (v) => {
      if (pane.conv) { try { pane.conv = { ...pane.conv, ...(await api('/api/conversations/' + pane.convId, { method: 'PATCH', body: { settings: v } })) }; } catch (e) { return toast(e.message, true); } }
      else pane.sel.chatSettings = v;
      m.close(); render(); toast(hasChatSettings(v) ? T('Chat settings saved') : T('Chat settings cleared'));
    };
    const m = modal({ title: T('Chat settings'), body: [
      el('div', { class: 'muted tiny' }, T('Only for this chat. Empty fields follow the assistant.')),
      field(T('Instructions for this chat'), ins, T('Added after the assistant prompt and takes priority over it.')),
      el('div', { class: 'grid2' }, field(T('Temperature'), temp, T('Lower is steadier, higher is more varied.')), field(T('Max output tokens'), maxT, T('The longest answer per request.')))],
      footer: [el('button', { class: 'btn quiet', onclick: () => save({}) }, T('Clear all')), el('span', { class: 'spacer' }), el('button', { class: 'btn', onclick: () => m.close() }, T('Cancel')), el('button', { class: 'btn primary', onclick: () => save({ instructions: ins.value.trim(), temperature: temp.value === '' ? null : parseFloat(temp.value), max_tokens: maxT.value === '' ? null : parseInt(maxT.value, 10) }) }, I('check', 'sm'), T('Save'))] });
    setTimeout(() => ins.focus(), 0);
  }

  // ---------------------------------------------------------------- chat panes
  function focusPane(idx) { if (S.active !== idx) { S.active = idx; document.querySelectorAll('.pane-col').forEach((c, i) => c.classList.toggle('active-pane', i === idx && S.panes.length > 1)); } }
  function renderPane(pane, idx) {
    const t = targetOf(pane);
    const col = el('div', { class: 'pane-col' + (idx === S.active && S.panes.length > 1 ? ' active-pane' : ''), onmousedown: () => focusPane(idx) });
    const asstBtn = el('button', { class: 'btn quiet', style: 'padding:0 8px', title: T('Assistant') + ': ' + (t.assistant?.name || T('Assistant')) }, el('span', { class: 'asst' }, customEmoji(t.assistant), S.panes.length > 1 ? (customEmoji(t.assistant) ? null : I('sparkles', 'sm')) : [customEmoji(t.assistant) ? null : el('span', { class: 'asst-ico' }, I('sparkles', 'sm')), el('span', { class: 'asst-name truncate' }, t.assistant?.name || T('Assistant'))]), I('chevron', 'xs'));
    asstBtn.addEventListener('click', () => menu(asstBtn, S.st.assistants.map((a) => ({ label: a.name, sub: a.id, id: a.id, selected: a.id === t.aid })), { onPick: (it) => setAssistant(pane, it.id) }));
    const toolsOn = pane.sel.tools !== false;
    const toolsBtn = t.provider?.kind === 'agentserver' ? el('span', { class: 'chip info', title: T('Tools run on the agent server') }, I('cloud', 'xs')) : el('button', { class: 'ico' + (toolsOn ? ' on' : ''), title: toolsOn ? T('{n} local tools on · click to turn off', { n: S.st.tools.length }) : T('Tools off · click to turn on'), onclick: () => { pane.sel.tools = !toolsOn; render(); } }, I('wrench', 'sm'));
    const waking = (S.st.wake || []).filter(wakeActive);
    const wakeChip = waking.length ? el('button', { class: 'chip info wake-chip', title: waking.map((j) => `${j.server}: ${j.stage}`).join('\n'), onclick: () => { S.view = 'settings'; S.settingsPage = 'mcp'; S.sel.mcpName = waking[0].server; render(); } }, I('refresh', 'xs'), T('Waking {server} · {status}', { server: waking[0].server, status: wakeLabel(waking[0]) })) : null;
    const showPaneBtn = idx === 0 && (ui.paneHidden || narrow()) ? el('button', { class: 'ico pane-btn', title: T('Show sidebar') + ' (Ctrl/⌘ B)', 'aria-label': T('Show sidebar'), onclick: togglePane }, I('sidebar', 'sm')) : null;
    const bar = el('div', { class: 'topbar' }, showPaneBtn, asstBtn, modelPicker(pane), thinkingButton(pane), chatSettingsButton(pane), toolsBtn, wakeChip, el('span', { class: 'spacer' }));
    if (idx === S.panes.length - 1 && S.st.version) bar.append(el('button', { class: 'ver', title: T('missile studio {v} · what this is', { v: S.st.version }), onclick: () => openIntro() }, 'v' + S.st.version));
    if (S.panes.length > 1) bar.append(el('button', { class: 'ico' + (S.linkInputs ? ' on' : ''), title: S.linkInputs ? T('Inputs linked: one message goes to every pane') : T('Link inputs: send one message to every pane to compare models'), onclick: () => { S.linkInputs = !S.linkInputs; render(); } }, I('link', 'sm')));
    if (S.panes.length < MAX_PANES) bar.append(el('button', { class: 'ico split-btn', title: T('Split: open another chat beside this one') + ' (Ctrl/⌘ \\)', onclick: () => splitPane(idx) }, I('columns', 'sm')));
    if (S.panes.length > 1) bar.append(el('button', { class: 'ico', title: T('Close this pane'), onclick: () => closePane(idx) }, I('x', 'sm')));
    if (pane.conv) bar.append(el('button', { class: 'ico', title: T('Delete chat'), onclick: () => deleteConv(pane.convId) }, I('trash', 'sm')));
    col.append(bar);
    const scroll = el('div', { class: 'chat-scroll' }); const inner = el('div', { class: 'chat-inner' }); scroll.append(inner); col.append(scroll);
    // reading earlier messages stops the stream from pulling the view down; the ↓ button (or sending) resumes it
    const jump = el('button', { class: 'jump-bottom', title: T('Jump to the latest'), 'aria-label': T('Jump to the latest'), onclick: () => { pane.follow = true; jump.classList.remove('show'); scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' }); } }, I('chevron', 'sm'));
    scroll.addEventListener('scroll', () => { pane.follow = atBottom(scroll); pane.scrollTop = scroll.scrollTop; jump.classList.toggle('show', !pane.follow); });
    col.append(jump);
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
    const stateText = cancelled ? T('cancelled') : result ? `${T(result.decision || (result.is_error ? 'error' : 'ok'))}${result.duration_ms != null ? ' · ' + fmtMs(result.duration_ms) : ''}` : (live ? T('Running…') : T('No result · stopped'));
    d.append(el('summary', {}, el('span', { class: 'dot' }), I('wrench', 'sm'), el('span', { class: 'tname' }, call.name), el('span', { class: 'tstate' }, stateText, I('chevron', 'xs'))));
    const body = el('div', { class: 'tbody' });
    const args = JSON.stringify(call.arguments ?? {}, null, 1);
    body.append(el('div', { class: 'lbl' }, T('Arguments')), el('pre', {}, args.length > 2000 ? args.slice(0, 2000) + '…' : args));
    if (result) { body.append(el('div', { class: 'lbl' }, T('Result')), linkedPre(String(result.text || result.content || '').slice(0, 6000))); for (const im of result.images || []) body.append(el('img', { src: `data:${im.mime_type || 'image/png'};base64,${im.data}` })); }
    // a file the agent just wrote into the workspace can be taken straight from the card
    if (result && !result.is_error && call.name === 'local__write_file' && call.arguments?.path) body.append(el('a', { class: 'btn sm', style: 'margin-top:8px;display:inline-flex', href: downloadUrl(call.arguments.path), download: baseName(call.arguments.path) }, I('download', 'sm'), T('Download {name}', { name: baseName(call.arguments.path) })));
    d.append(body);
    return d;
  }
  function assistantTurn(pane, modelName) {
    const t = targetOf(pane);
    const node = el('div', { class: 'turn-ai' }, el('div', { class: 'av' }, assistantGlyph(t.assistant)));
    const body = el('div', { class: 'body' }); node.append(body);
    body.append(el('div', { class: 'head' }, el('span', { class: 'name' }, t.assistant?.name || T('Assistant')), el('span', { class: 'model' }, shortModel(modelName || t.model))));
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
        el('div', { class: 'ahead', onclick: () => openArtifact(id) }, el('div', { class: 'aicon' }, I(lang === 'html' || lang === 'svg' ? 'globe' : lang === 'markdown' || lang === 'md' ? 'file' : 'terminal', 'sm')), el('div', { style: 'min-width:0' }, el('div', { class: 'atitle truncate' }, art.name), el('div', { class: 'asub' }, T('{lang} · {n} lines · click to open', { lang: lang || 'text', n: lines }))), el('div', { class: 'aactions' }, el('button', { class: 'btn quiet icon sm', title: T('Copy'), onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => toast(T('Copied'))); } }, I('copy', 'xs')), el('button', { class: 'btn quiet icon sm', title: T('Download'), onclick: (e) => { e.stopPropagation(); saveBlob(art.name, text); } }, I('download', 'xs')), isAdmin() ? el('button', { class: 'btn quiet icon sm', title: T('Save to workspace'), onclick: (e) => { e.stopPropagation(); saveArtifact(id); } }, I('file', 'xs')) : null)),
        el('details', {}, el('summary', {}, T('Show code')), pre.cloneNode(true)));
      pre.replaceWith(card);
    });
  }
  // the copied text is the block without its own button label (which depends on the UI language)
  const preText = (pre) => { const c = pre.cloneNode(true); c.querySelector('.copy-btn')?.remove(); return c.textContent; };
  function addCopyButtons(root) { root.querySelectorAll('pre').forEach((pre) => { if (pre.querySelector('.copy-btn') || pre.closest('.tool') || pre.closest('.artifact')) return; pre.append(el('button', { class: 'copy-btn', onclick: () => navigator.clipboard.writeText(preText(pre)).then(() => toast(T('Copied'))) }, T('Copy'))); }); }
  function branchNav(pane, id) {
    const b = pane.branches?.[id]; if (!b) return null;
    const go = async (j) => { try { const c = await api(`/api/conversations/${pane.convId}/head`, { method: 'POST', body: { message_id: b.siblings[j] } }); pane.conv = c; pane.messages = c.messages || []; pane.branches = c.branches || {}; render(); } catch (e) { toast(e.message, true); } };
    return el('span', { class: 'branchnav', title: T('This message has other versions') }, el('button', { disabled: b.index === 0, onclick: () => go(b.index - 1) }, '‹'), `${b.index + 1} / ${b.siblings.length}`, el('button', { disabled: b.index >= b.siblings.length - 1, onclick: () => go(b.index + 1) }, '›'));
  }
  function renderMessages(pane, inner) {
    inner.innerHTML = '';
    const live = pane.convId ? S.live[pane.convId] : null;
    if (!pane.conv || (!pane.messages.length && !live)) {
      const t = targetOf(pane);
      const sugg = [T('Summarize the files in my workspace'), T('What tools do you have? Show one example each'), T('Write a short project README from notes/'), T('Build a small HTML page that visualizes a to-do list')];
      inner.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, STOCK_EMOJI.has(t.assistant?.emoji || '') ? el('span', { html: window.logoMark(56) }) : t.assistant.emoji), el('h3', {}, t.assistant?.name ? T('Chat with {name}', { name: t.assistant.name }) : T('What can I help with?')), el('div', {}, t.provider ? `${t.provider.label || t.pid} · ${shortModel(t.model) || T('Pick a model')} · ${T('{n} tools', { n: S.st.tools.length })}` : T('Add a provider in Settings to start.')), el('div', { class: 'sugg' }, sugg.map((s) => el('button', { onclick: () => { send(pane, s); } }, s)))));
      return;
    }
    const toolResults = {}; for (const m of pane.messages) if (m.role === 'tool') toolResults[m.tool_call_id] = { text: m.content, is_error: m.is_error, images: m.images, decision: m.decision, duration_ms: m.duration_ms };
    let i = 0; let lastUser = null;
    while (i < pane.messages.length) {
      const m = pane.messages[i];
      if (m.role === 'user' && m.meta?.note) { inner.append(el('div', { class: 'note-line', title: textOf(m) }, I('info', 'xs'), noteText(m.meta))); i++; continue; }
      if (m.role === 'user') {
        lastUser = m;
        const text = textOf(m);
        if (pane.editing === m.id) {
          const ta = el('textarea', { class: 'textarea', style: 'min-height:90px' }); ta.value = text;
          const go = () => { const v = ta.value.trim(); if (!v) return; pane.editing = null; startStream(pane, v, [], { branchFrom: m.id }); };
          inner.append(el('div', { class: 'turn-user' }, el('div', { class: 'edit-box' }, ta, el('div', { class: 'row', style: 'justify-content:flex-end' }, el('span', { class: 'muted tiny', style: 'margin-right:auto' }, T('The original stays one click away with ‹ › under the message')), el('button', { class: 'btn sm', onclick: () => { pane.editing = null; render(); } }, T('Cancel')), el('button', { class: 'btn primary sm', onclick: go }, I('send', 'xs'), T('Send as a new branch'))))));
          ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } if (e.key === 'Escape') { pane.editing = null; render(); } });
          setTimeout(() => ta.focus(), 0); i++; continue;
        }
        const bub = el('div', { class: 'bubble', title: m.ts ? new Date(m.ts * 1000).toLocaleString(LOC()) : '' }, text);
        for (const p of (Array.isArray(m.content) ? m.content : [])) if (p.type === 'image_url') bub.append(el('img', { src: p.image_url.url }));
        inner.append(el('div', { class: 'turn-user' }, el('span', { class: 'uact' }, el('button', { class: 'btn quiet icon sm', title: T('Edit and resend as a new branch'), onclick: () => { pane.editing = m.id; render(); } }, I('edit', 'xs')), el('button', { class: 'btn quiet icon sm', title: T('Copy'), onclick: () => navigator.clipboard.writeText(text).then(() => toast(T('Copied'))) }, I('copy', 'xs'))), bub, el('div', { class: 'av' }, userAvatar())));
        const nav = branchNav(pane, m.id); if (nav) inner.append(el('div', { class: 'bnav' }, nav));
        i++; continue;
      }
      if (m.role === 'assistant') {
        const { node, content, body } = assistantTurn(pane, m.meta?.model);
        let totalMs = 0, usage = null, lastText = '', finishInfo = null, speed = 0; const firstId = m.id, firstTs = m.ts;
        while (i < pane.messages.length && pane.messages[i].role !== 'user') {
          const mm = pane.messages[i];
          if (mm.role === 'assistant') {
            if (mm.thinking) content.append(el('details', { class: 'think' }, el('summary', {}, I('brain', 'sm'), T('Thinking')), el('div', { class: 'tbody' }, mm.thinking)));
            if (mm.content) { const mdEl = el('div', { class: 'md', html: md(mm.content) }); artifactize(mdEl, mm.id, pane.convId); content.append(mdEl); lastText = mm.content; }
            if (mm.meta?.error_text) { const ep = providerOf(mm.meta.provider || pane.conv?.provider_id || ''); const ws = ep?.wake_server; const wj = ws && (S.st.wake || []).find((j) => j.server === ws); content.append(el('div', { class: 'error-line' }, mm.meta.error_text, /401|credential|api key|unauthorized/i.test(mm.meta.error_text) ? el('button', { class: 'btn sm', style: 'margin-left:10px', onclick: () => { S.view = 'settings'; S.settingsPage = 'providers'; S.sel.providerId = pane.conv?.provider_id || ''; render(); } }, T('Open provider settings')) : null, ws && unusable(ep) ? (wakeActive(wj) ? el('span', { class: 'chip info', style: 'margin-left:10px' }, T('Waking · {status}', { status: wakeLabel(wj) })) : el('button', { class: 'btn sm primary', style: 'margin-left:10px', title: T('Runs the wake command of {server}, then reconnects', { server: ws }), onclick: () => wakeServer(ws) }, I('refresh', 'sm'), T('Wake {server}', { server: ws }))) : null)); }
            for (const c of mm.tool_calls || []) content.append(toolCard(c, toolResults[c.id], !!live));
            if (mm.meta?.duration_ms) totalMs += mm.meta.duration_ms; if (mm.meta?.usage) usage = mm.meta.usage; if (mm.meta?.usage?.output_tokens > 1 && mm.meta?.duration_ms > 200) speed = mm.meta.usage.output_tokens / (mm.meta.duration_ms / 1000); if (mm.meta?.finish) { finishInfo = { finish: mm.meta.finish, stop_reason: mm.meta.stop_reason, out: mm.meta.usage?.output_tokens }; }
          }
          i++;
        }
        const meta = el('div', { class: 'meta' }); if (firstTs) meta.append(el('span', { class: 'ts', title: new Date(firstTs * 1000).toLocaleString(LOC()) }, fmtClock(firstTs))); if (totalMs) meta.append(el('span', {}, T('Processed · {time}', { time: fmtMs(totalMs) }))); if (usage) meta.append(el('span', { title: finishInfo ? finishTitle(finishInfo) : '' }, T('{in}↑ {out}↓ tokens', { in: usage.input_tokens || 0, out: usage.output_tokens || 0 }))); if (speed) meta.append(el('span', { title: T('Output speed of the last request') }, T('{n} tok/s', { n: speed < 10 ? speed.toFixed(1) : Math.round(speed) }))); if (finishInfo && !NORMAL_FINISH.has(finishInfo.finish)) meta.append(el('span', { class: 'finish-flag', title: finishTitle(finishInfo) }, T('Ended: {reason}', { reason: finishInfo.finish })));
        const nav = branchNav(pane, firstId); if (nav) meta.append(nav);
        const acts = el('span', { class: 'actions' });
        if (lastText) { const lt = lastText; acts.append(el('button', { class: 'btn quiet icon sm', title: T('Copy answer'), onclick: () => navigator.clipboard.writeText(lt).then(() => toast(T('Copied'))) }, I('copy', 'xs')), el('button', { class: 'btn quiet icon sm', title: T('Download answer as Markdown (.md)'), onclick: () => saveBlob(((pane.conv?.title || 'answer').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 50) || 'answer') + '.md', lt, 'text/markdown;charset=utf-8') }, I('download', 'xs'))); }
        if (lastUser) { const lu = lastUser; acts.append(el('button', { class: 'btn quiet icon sm', title: T('Retry: ask again as a new branch'), onclick: () => startStream(pane, textOf(lu), [], { branchFrom: lu.id }) }, I('refresh', 'xs')), el('button', { class: 'btn quiet icon sm', title: T('Retry with another model'), onclick: (e) => openModelMenu(pane, e.currentTarget, () => startStream(pane, textOf(lu), [], { branchFrom: lu.id })) }, I('chevron', 'xs'))); }
        meta.append(acts); body.append(meta); inner.append(node); continue;
      }
      i++;
    }
    if (live) { if (live.userNode) inner.append(live.userNode); inner.append(live.node); }
    addCopyButtons(inner);
    requestAnimationFrame(() => { const sc = inner.parentElement; if (pane.follow === false && pane.scrollTop != null) { sc.scrollTop = pane.scrollTop; sc.parentElement.querySelector('.jump-bottom')?.classList.add('show'); } else sc.scrollTop = sc.scrollHeight; });
  }

  // ---------------------------------------------------------------- composer: pills, style, "/" commands, long paste as a file
  function renderComposer(pane) {
    const t = targetOf(pane); const live = pane.convId ? S.live[pane.convId] : null;
    const wrap = el('div', { class: 'composer-wrap' });
    const box = el('div', { class: 'composer' });
    const pills = el('div', { class: 'pills' }); box.append(pills);
    const ta = el('textarea', { class: 'composerInput', rows: 1, placeholder: t.provider ? (S.linkInputs && S.panes.length > 1 ? T('Message every pane. Enter to send, "/" for commands.') : phone() ? T('Type a message') : T('Type a message. Enter to send, Shift+Enter for a new line, "/" for commands.')) : T('Add a provider in Settings first.') });
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
      if (!handled && text.length > 2000) { e.preventDefault(); pane.attachments.push({ name: `pasted-${pane.attachments.length + 1}.txt`, text }); renderPills(); toast(T('Long paste attached as a file')); }
    });
    box.append(ta);
    const upload = async (files) => { for (const f of files) { const fd = new FormData(); fd.append('file', f); try { pane.attachments.push(await api('/api/upload', { method: 'POST', body: fd })); } catch (err) { toast(`${f.name}: ${err.message}`, true); } } renderPills(); };
    const fileInput = el('input', { type: 'file', multiple: true, style: 'display:none', onchange: async (e) => { await upload([...e.target.files]); e.target.value = ''; } });
    // files dropped anywhere on the message box are attached like the paperclip does
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    wrap.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); box.classList.add('dropping'); });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) box.classList.remove('dropping'); });
    wrap.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); box.classList.remove('dropping'); upload([...e.dataTransfer.files]); });
    const modelBtn = el('button', { class: 'btn quiet sm modelbtn' + (unusable(t.provider) ? ' dim' : ''), title: T('Change model') }, el('span', { class: 'truncate' }, t.provider ? `${t.provider.label || t.pid} · ${shortModel(t.model)}` : T('Pick a model')), t.provider ? hdot(t.provider) : null, I('chevron', 'xs'));
    modelBtn.addEventListener('click', () => openModelMenu(pane, modelBtn));
    // permission mode for this chat (research and knowledge need no switch: the model looks things up when a question needs it)
    const perm = isAdmin() ? permOf(pane) : 'readonly';  // a studio user's chats always run read-only (the server enforces it)
    const permBtn = el('button', { class: 'btn quiet sm' + (perm ? ' on' : ''), title: T(PERM[perm][1]) }, I('shield', 'sm'), T(PERM[perm][0]));
    if (isAdmin()) permBtn.addEventListener('click', () => menu(permBtn, Object.entries(PERM).map(([id, [label, sub]]) => ({ label: T(label), sub: T(sub), id, selected: id === perm })), { onPick: (it) => setPerm(pane, it.id) }));
    const styleBtn = el('button', { class: 'btn quiet sm', title: T('Writing style') }, I('wand', 'sm'), t.style && t.style.id !== 'normal' ? t.style.name : T('Style'));
    styleBtn.addEventListener('click', () => menu(styleBtn, (S.st.styles || []).map((s) => ({ label: s.name, sub: s.prompt ? s.prompt.slice(0, 40) + '…' : '', id: s.id, selected: s.id === (t.styleId || 'normal') })), { onPick: (it) => setStyle(pane, it.id) }));
    // how full the context was on the last request (the model's own count), against the window when it is known
    const lastUse = [...pane.messages].reverse().find((x) => x.role === 'assistant' && x.meta?.usage?.input_tokens)?.meta.usage;
    const win = t.provider?.context_window || 0; const used = lastUse ? (lastUse.input_tokens || 0) + (lastUse.output_tokens || 0) : 0;
    const gauge = used ? el('span', { class: 'ctx' + (win && used / win > 0.8 ? ' warn' : ''), title: win ? T('Context on the last request: {used} of {max} tokens. Long threads are summarized at 60%.', { used: used.toLocaleString(LOC()), max: win.toLocaleString(LOC()) }) : T('Context on the last request: {used} tokens', { used: used.toLocaleString(LOC()) }) }, win ? el('span', { class: 'ctxbar' }, el('i', { style: `width:${Math.min(100, Math.round(100 * used / win))}%` })) : null, win ? `${fmtK(used)} / ${fmtK(win)}` : fmtK(used)) : null;
    const bar = el('div', { class: 'bar' },
      el('button', { class: 'btn quiet icon sm', title: T('Attach a file or image'), onclick: () => fileInput.click() }, I('paperclip', 'sm')), fileInput,
      el('button', { class: 'btn quiet icon sm', title: T('New chat in this pane') + ' (Ctrl/⌘ Shift O)', onclick: () => newConv(pane) }, I('plus', 'sm')),
      styleBtn, permBtn,
      el('span', { class: 'spacer' }),
      gauge, modelBtn,
      live ? el('button', { class: 'stop', onclick: () => stopTurn(pane) }, I('stop', 'sm'), T('Stop')) : el('button', { class: 'send', title: T('Send'), onclick: () => send(pane), disabled: !t.provider }, I('send', 'sm')));
    box.append(bar); wrap.append(box);
    function renderPills() {
      pills.innerHTML = '';
      const toolsOn = pane.sel.tools !== false;
      if (t.provider?.kind !== 'agentserver') pills.append(el('span', { class: 'chip' + (toolsOn ? ' primary' : ''), title: toolsOn ? (catalogOn() ? T('Tools on · the model sees a catalog and loads what it needs') : T('Local tools on')) : T('Local tools off') }, I('wrench', 'xs'), toolsOn ? (catalogOn() ? T('{n} tools · on demand', { n: S.st.tools.length }) : T('{n} tools', { n: S.st.tools.length })) : T('Tools off'), el('button', { title: toolsOn ? T('Turn tools off') : T('Turn tools on'), onclick: () => { pane.sel.tools = !toolsOn; render(); } }, toolsOn ? '✕' : '＋')));
      if (pane.sel.thinking) pills.append(el('span', { class: 'chip info' }, I('brain', 'xs'), T(THINK_LABEL[pane.sel.thinking]), el('button', { title: T('Back to the provider default'), onclick: () => { pane.sel.thinking = ''; render(); } }, '✕')));
      if (pane.sel.research) pills.append(el('span', { class: 'chip info' }, I('globe', 'xs'), T('Research'), el('button', { title: T('Back to normal mode'), onclick: () => { pane.sel.research = false; render(); } }, '✕')));
      if (pane.sel.knowledge) pills.append(el('span', { class: 'chip' }, I('box', 'xs'), T('Knowledge'), el('button', { title: T('Back to automatic retrieval'), onclick: () => { pane.sel.knowledge = false; render(); } }, '✕')));
      if (hasChatSettings(chatSettingsOf(pane))) pills.append(el('span', { class: 'chip info', style: 'cursor:pointer', title: T('Chat settings'), onclick: () => openChatSettings(pane) }, I('sliders', 'xs'), T('Chat settings')));
      if (t.style && t.style.id !== 'normal') pills.append(el('span', { class: 'chip' }, I('wand', 'xs'), t.style.name, el('button', { title: T('Back to the normal style'), onclick: () => setStyle(pane, '') }, '✕')));
      pane.attachments.forEach((a, i) => pills.append(el('span', { class: 'chip', title: a.path ? T('Saved to {path} · tools can use this path', { path: a.path }) : '' }, a.data_url ? '🖼' : '📄', a.name, el('button', { onclick: () => { pane.attachments.splice(i, 1); renderPills(); } }, '✕'))));
      pills.classList.toggle('hidden', !pills.children.length);
    }
    renderPills();
    return wrap;
  }
  function openSlash(pane, ta, q) {
    const items = [{ group: T('Commands') },
      { label: '/new', sub: T('New chat in this pane'), icon: 'plus', run: () => newConv(pane) },
      { label: '/split', sub: T('Open another pane'), icon: 'columns', run: () => splitPane(S.panes.indexOf(pane)) },
      { label: '/files', sub: T('Open the workspace files'), icon: 'file', run: () => openDrawer('files') },
      { label: '/terminal', sub: T('Open the terminal'), icon: 'terminal', run: () => openDrawer('terminal') },
      { label: '/artifacts', sub: T('Open generated artifacts'), icon: 'box', run: () => openDrawer('artifacts') },
      { label: '/tools', sub: pane.sel.tools === false ? T('Turn local tools on') : T('Turn local tools off'), icon: 'wrench', run: () => { pane.sel.tools = pane.sel.tools === false; render(); } },
      { label: '/think', sub: T('Cycle thinking: default → on → max → off'), icon: 'brain', run: () => cycleThinking(pane) },
      { label: '/research', sub: pane.sel.research ? T('Back to automatic: the model looks things up when needed') : T('Full research mode: sub-questions, sources and a cited report'), icon: 'globe', run: () => { pane.sel.research = !pane.sel.research; render(); } },
      { label: '/knowledge', sub: pane.sel.knowledge ? T('Back to automatic retrieval') : T('More knowledge-base excerpts for every message'), icon: 'box', run: () => { pane.sel.knowledge = !pane.sel.knowledge; render(); } },
      { label: '/permissions', sub: T('Cycle the permission mode: Ask → Allow all → Read-only'), icon: 'shield', run: () => { const ks = Object.keys(PERM); setPerm(pane, ks[(ks.indexOf(permOf(pane)) + 1) % ks.length]); } },
      { label: '/remember', sub: T('Save a memory: /remember <fact>'), icon: 'brain', insert: T('Remember this for future chats: ') },
      { label: '/clear', sub: T('Clear the draft'), icon: 'x', run: () => { pane.draft = ''; render(); } },
      { group: T('Assistants') }, ...S.st.assistants.map((a) => ({ label: `/assistant ${a.id}`, sub: a.name, icon: 'sparkles', run: () => setAssistant(pane, a.id) })),
      ...((S.st.prompts || []).length ? [{ group: T('Prompts') }, ...S.st.prompts.map((p) => ({ label: `/${p.id}`, sub: p.name, icon: 'list', prompt: p }))] : []),
      { group: T('Styles') }, ...(S.st.styles || []).map((s) => ({ label: `/style ${s.id}`, sub: s.name, icon: 'wand', run: () => setStyle(pane, s.id) })),
      { group: T('Tools (inserts a request to use the tool)') }, ...S.st.tools.map((tl) => ({ label: `/tool ${tl.full_name}`, sub: (tl.description || '').slice(0, 50), icon: 'wrench', insert: T('Use the `{tool}` tool to ', { tool: tl.full_name }) }))];
    return menu(ta, items, { filter: q, onPick: (it) => { if (it.prompt) { ta.value = ''; pane.draft = ''; usePrompt(pane, ta, it.prompt.text); return; } if (it.insert) { ta.value = it.insert; pane.draft = ta.value; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } else { ta.value = ''; pane.draft = ''; it.run(); } } });
  }
  // a saved prompt into the message box; each {{name}} is asked for first (same name, same value)
  function usePrompt(pane, ta, text) {
    const names = [...new Set([...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((x) => x[1]))];
    const put = (v) => { ta.value = v; pane.draft = v; ta.style.height = 'auto'; ta.style.height = Math.min(260, ta.scrollHeight) + 'px'; ta.focus(); ta.setSelectionRange(v.length, v.length); };
    if (!names.length) return put(text);
    const inputs = names.map((n) => el('input', { class: 'input', 'data-var': n }));
    const fill = () => { const vals = Object.fromEntries(inputs.map((i) => [i.dataset.var, i.value])); m.close(); put(text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, n) => vals[n] ?? all)); };
    inputs.forEach((i, k) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (k === inputs.length - 1) fill(); else inputs[k + 1].focus(); } }));
    const m = modal({ title: T('Fill in the prompt'), body: names.map((n, k) => field(n, inputs[k])), footer: [el('button', { class: 'btn', onclick: () => m.close() }, T('Cancel')), el('button', { class: 'btn primary', onclick: fill }, T('Insert'))] });
    setTimeout(() => inputs[0].focus(), 0);
  }
  function newConv(pane) { pane.convId = null; pane.conv = null; pane.messages = []; pane.branches = {}; pane.editing = null; S.view = 'chat'; ui.mobilePane = false; render(); $('.composerInput', paneEl(pane))?.focus(); }
  async function openConv(pane, id) {
    const c = await api('/api/conversations/' + id); delete S.unread[id]; pane.convId = id; pane.conv = c; pane.messages = c.messages || []; pane.branches = c.branches || {}; pane.editing = null; S.view = 'chat'; ui.mobilePane = false; render();
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
  const atBottom = (sc) => sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  async function send(pane, forcedText) {
    const ta = $('.composerInput', paneEl(pane)); const text = (forcedText || ta?.value || '').trim(); if (!text) return;
    if (S.linkInputs && S.panes.length > 1 && !forcedText) { for (const p of S.panes) { p.draft = ''; startStream(p, text, p === pane ? pane.attachments.splice(0) : []); } return; }
    pane.draft = '';
    await startStream(pane, text, pane.attachments.splice(0));
  }
  async function startStream(pane, text, atts, opts = {}) {
    const t = targetOf(pane); if (!t.pid) return toast(T('Add a provider first in Settings → Model providers.'), true);
    if (pane.convId && S.live[pane.convId]) return toast(T('This chat is still answering. Open another pane to run a second one.'), true);
    // a hosted provider without a saved key almost always answers 401: say so once, but still send (gateways and local servers need none)
    S.warnedNoKey = S.warnedNoKey || {};
    if (t.provider && t.provider.has_key === false && t.provider.kind !== 'agentserver' && !/127\.0\.0\.1|localhost|\[::1\]|\.local\b|^http:\/\/(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(t.provider.base_url || '') && !S.warnedNoKey[t.pid]) { S.warnedNoKey[t.pid] = true; toast(T('{name} has no API key saved. If the request fails with 401, add one in Settings → Model providers.', { name: t.provider.label || t.pid }), true); }
    if (!pane.conv) { try { pane.conv = await api('/api/conversations', { method: 'POST', body: { assistant_id: t.aid, provider_id: t.pid, model: t.model } }); if (hasChatSettings(pane.sel.chatSettings || {})) pane.conv = await api('/api/conversations/' + pane.conv.id, { method: 'PATCH', body: { settings: pane.sel.chatSettings } }); pane.sel.chatSettings = null; } catch (e) { return toast(e.message, true); } pane.convId = pane.conv.id; pane.messages = []; pane.branches = {}; await loadConvs(); }
    const convId = pane.convId; pane.follow = true;
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
    const lastUser = [...pane.messages].reverse().find((m) => m.role === 'user' && !m.meta?.note);
    if (lastUser) pane.messages = pane.messages.slice(0, pane.messages.indexOf(lastUser) + 1);  // the buffer re-renders this turn
    const t = targetOf(pane); const { node, content } = assistantTurn(pane, t.model);
    const live = { convId, node, userNode: null, content, abort: new AbortController(), textBuf: '', thinkBuf: '', mdEl: null, thinkEl: null, statusEl: null, cards: {}, attached: true };
    S.live[convId] = live; render();
    try { await pumpStream(r, pane, live); } catch (e) { if (e.name !== 'AbortError') content.append(el('div', { class: 'error-line' }, e.message)); await endLive(pane, live); }
    return true;
  }
  async function endLive(pane, live) { if (S.live[live.convId] !== live) return; delete S.live[live.convId]; if (!S.panes.some((p) => p.convId === live.convId)) S.unread[live.convId] = true; await refreshConv(live.convId); render(); if (pane.pendingEdit) finishSelectionEdit(pane); refreshHealth(true); notifyDone(pane, live.convId); }
  // a turn that ends while this tab is in the background: a ● in the tab title until the tab is looked at, and a
  // system notification when that is turned on in Settings → General
  const BASE_TITLE = document.title;
  const notifyOn = () => { try { return localStorage.getItem('missile_notify') === '1'; } catch { return false; } };
  function notifyDone(pane, convId) {
    if (!document.hidden) return;
    document.title = '● ' + BASE_TITLE;
    if (!notifyOn() || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { const c = S.convs.find((x) => x.id === convId); const n = new Notification(T('Answer ready'), { body: c?.title || T('New chat'), tag: convId, icon: '/static/brand/favicon.png' }); n.onclick = () => { window.focus(); openConv(pane, convId); n.close(); }; } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = BASE_TITLE; });
  async function setNotify(on) {
    if (on && 'Notification' in window && Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') { toast(T('The browser did not allow notifications. Allow them for this site and try again.'), true); render(); return; } }
    try { localStorage.setItem('missile_notify', on ? '1' : '0'); } catch {}
    toast(on ? T('Notifications on') : T('Notifications off')); render();
  }
  async function pumpStream(r, pane, live) {
    const { node, content } = live;
    const scrollOf = () => { const inner = node.closest('.chat-inner'); return inner ? inner.parentElement : null; };
    const stick = () => { const sc = scrollOf(); if (sc && pane.follow !== false) sc.scrollTop = sc.scrollHeight; };
    const flush = () => { if (!live.mdEl) { live.mdEl = el('div', { class: 'md cursor' }); content.append(live.mdEl); } live.mdEl.innerHTML = md(live.textBuf); stick(); };
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
        case 'thinking_delta': live.thinkBuf += ev.text; if (!live.thinkEl) { const d = el('details', { class: 'think', open: true }, el('summary', {}, I('brain', 'sm'), T('Thinking'))); live.thinkEl = el('div', { class: 'tbody' }); d.append(live.thinkEl); content.prepend(d); } live.thinkEl.textContent = live.thinkBuf; break;
        case 'tool_call': { if (live.mdEl) live.mdEl.classList.remove('cursor'); live.mdEl = null; live.textBuf = ''; const c = toolCard(ev, null); live.cards[ev.id] = { card: c, call: ev }; content.append(c); stick(); break; }
        case 'tool_result': { const k = live.cards[ev.id]; const nc = toolCard(k ? k.call : { name: ev.name, arguments: {} }, ev); if (k) k.card.replaceWith(nc); else content.append(nc); live.cards[ev.id] = { card: nc, call: k ? k.call : { name: ev.name } }; if (S.drawer.open && /write|edit|create|move|delete|run_shell/.test(ev.name)) loadTree(S.drawer.path); break; }
        case 'approval_required': { const a = el('div', { class: 'approval', 'data-approval': ev.id }, el('div', { class: 'ttl' }, I('alert', 'sm'), T('{tool} wants to run', { tool: ev.name }), el('span', { class: 'muted tiny', style: 'font-weight:400' }, ev.reason || '')), el('pre', {}, JSON.stringify(ev.arguments, null, 1).slice(0, 2000)), el('div', { class: 'row' }, ...[[T('Allow once'), 'allow', 'btn primary sm'], [T('Allow in this chat'), 'allow_session', 'btn sm'], [T('Always allow'), 'allow_always', 'btn sm'], [T('Deny'), 'deny', 'btn danger sm']].map(([l, d, cls]) => el('button', { class: cls, onclick: async () => { await api('/api/approvals/' + ev.id, { method: 'POST', body: { decision: d } }).catch((e) => toast(e.message, true)); a.remove(); } }, l)))); content.append(a); stick(); break; }
        case 'remote_tool': status(`${ev.event} ${ev.name || ''}`, true); break;
        case 'status': {
          const d = ev.data || {};
          if (ev.event === 'retry') status(T('Provider busy. Retrying ({n}/3)…', { n: d.attempt + 1 }), true);
          else if (ev.event === 'compacting') status(T('Long thread: summarizing the earlier part…'), true);
          else if (ev.event === 'compacted') status(T('History summarized · the last {n} messages kept as they are', { n: d.kept }));
          else if (ev.event === 'tool_catalog') status(T('Tool catalog: {n} of {total} tools defined · the model loads the rest as needed', { n: (d.loaded || []).length, total: d.total }));
          else if (ev.event === 'answer_cut_off') status(cutText(d) + (d.retry ? ' · ' + T('asked the model to continue') : ''), true);
          else if (ev.event === 'tool_call_not_run') status(noteText(d) + ' · ' + (d.retry ? T('asked the model to send it again') : T('not retried again')), true);
          else if (ev.event === 'tools_loaded') status(T('Loaded tools: {names}', { names: (d.names || []).map((n) => n.split('__').pop()).join(', ') }));
          else if (ev.event === 'knowledge') status(T('{n} knowledge excerpts in context: {files}', { n: (d.hits || []).length, files: (d.hits || []).map((h) => baseName(h.path)).slice(0, 4).join(', ') }));
          else if (ev.event === 'max_iterations') status(T('Tool-call limit reached. Answering with what it found.'), true);
          else if (ev.event === 'tools_unsupported') status(T('This model server does not accept tool definitions. Switching to tool calls through the prompt.'), true);
          else if (ev.event === 'tools_via_prompt') status(T('Tools go through the prompt on this server. Calls are read from the text.'));
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
  // a tool call the model wrote as text that did not run (untagged, unreadable, or cut off at the output limit)
  // why an answer ended, as the model server said it: a normal end shows only in the tooltip
  const NORMAL_FINISH = new Set(['stop', 'tool_calls', 'end_turn', 'tool_use', 'STOP', 'stop_sequence']);
  const finishTitle = (f) => T('Ended: {reason}', { reason: f.finish }) + (f.stop_reason != null ? ` · stop_reason ${f.stop_reason}` : '') + (f.out != null ? ' · ' + T('{n} output tokens', { n: f.out }) : '');
  const cutText = (d) => T('Answer stopped mid-sentence ({reason})', { reason: (d.finish || 'stop') + (d.output_tokens != null ? ', ' + T('{n} tokens', { n: d.output_tokens }) : '') });
  const noteText = (d) => { if (d.note === 'continue') return cutText(d) + ' · ' + T('asked the model to continue'); return strayText(d); };
  const strayText = (d) => { const n = d.name ? d.name.split('__').pop() : ''; return d.reason === 'cut_off' ? T('A call to {tool} was cut off at the output limit and did not run', { tool: n || T('a tool') }) : d.reason === 'malformed' ? T('A tool call could not be read and did not run') : T('A call to {tool} was written as text and did not run', { tool: n || T('a tool') }); };
  // wake jobs (MCP Restart with a wake command, e.g. bringing a GPU server up): progress, remaining time, reconnect
  const wakeActive = (j) => j && (j.state === 'running' || j.state === 'reconnecting');
  const fmtSpan = (s) => s < 60 ? T('{n} s', { n: Math.round(s) }) : T('{n} min', { n: Math.round(s / 60) });
  const fmtLeft = (s) => s == null || s <= 0 ? '' : T('about {time} left', { time: fmtSpan(s) });
  const wakeLabel = (j) => j.state === 'reconnecting' ? T('Reconnecting…') : j.state === 'done' ? T('Done in {time}', { time: fmtSpan(j.elapsed_s) }) : j.state !== 'running' ? T(j.state) : [j.pct != null ? `${j.pct}%` : '', fmtLeft(j.eta_s)].filter(Boolean).join(' · ') || T('Starting…');
  let wakeTimer = null;
  async function pollWake() {
    clearTimeout(wakeTimer);
    try {
      const before = (S.st?.wake || []).filter(wakeActive).map((j) => j.server);
      const jobs = await api('/api/wake');
      if (S.st) S.st.wake = jobs;
      for (const s of before) { const j = jobs.find((x) => x.server === s); if (j && !wakeActive(j)) { toast(j.state === 'done' ? T('{server} is awake · {time}', { server: s, time: fmtSpan(j.elapsed_s) }) : T('{server}: wake {state} · {stage}', { server: s, state: T(j.state), stage: j.stage }), j.state !== 'done'); await loadState(); refreshHealth(true); } }
      if (!/TEXTAREA|INPUT/.test(document.activeElement?.tagName || '') && !Object.keys(S.live).length) render();
      if (jobs.some(wakeActive)) wakeTimer = setTimeout(pollWake, 3000);
    } catch { wakeTimer = setTimeout(pollWake, 6000); }
  }
  async function wakeServer(name) {
    try { const r = await api(`/api/mcp/${encodeURIComponent(name)}/restart`, { method: 'POST' }); toast(r.wake ? T('Waking {server}…', { server: name }) : T('Restarting')); if (r.wake) { S.st.wake = [...(S.st.wake || []).filter((j) => j.server !== name), r.wake]; render(); pollWake(); } else setTimeout(async () => { await loadState(); render(); }, 1500); } catch (e) { toast(e.message, true); }
  }
  function wakeBar(j) {
    return el('div', { class: 'wake' }, el('div', { class: 'wake-head' }, el('b', {}, j.state === 'failed' ? T('Wake failed') : j.state === 'cancelled' ? T('Wake cancelled') : j.state === 'done' ? T('Awake') : T('Waking')), el('span', { class: 'muted tiny' }, wakeLabel(j)), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, T('Elapsed {time}', { time: `${Math.floor(j.elapsed_s / 60)}:${String(j.elapsed_s % 60).padStart(2, '0')}` }) + (j.expected_s ? ' · ' + T('last time {time}', { time: fmtSpan(j.expected_s) }) : ''))),
      el('div', { class: 'wake-track' }, el('div', { class: 'wake-fill' + (j.state === 'failed' ? ' err' : ''), style: `width:${j.state === 'done' ? 100 : Math.max(3, j.pct || 0)}%` })),
      el('div', { class: 'muted tiny' }, j.stage || ''),
      j.tail?.length ? el('details', {}, el('summary', { class: 'muted tiny', style: 'cursor:pointer' }, T('Log')), el('pre', {}, j.tail.join('\n'))) : null);
  }
  async function refreshHealth(force) { if (!S.st) return; try { const h = await api('/api/providers/health'); let changed = false; for (const p of S.st.providers) { const n = h[p.id]; if (n && (p.health?.state !== n.state || p.health?.error !== n.error)) { p.health = n; changed = true; } } if ((changed || force) && S.view === 'chat' && !Object.keys(S.live).length && !/TEXTAREA|INPUT/.test(document.activeElement?.tagName || '')) render(); } catch {} }
  setInterval(() => refreshHealth(false), 60000);
  setInterval(async () => { if (!S.st || S.view !== 'chat') return; try { const before = S.convs.map((c) => c.id + c.running).join(); await loadConvs(); const after = S.convs.map((c) => c.id + c.running).join(); if (before !== after && !Object.keys(S.live).length) { const list = $('.pane'); if (list) list.replaceWith(renderConvPane()); } for (const p of S.panes) { const c = S.convs.find((x) => x.id === p.convId); if (c && c.running && !S.live[p.convId]) attachStream(p, p.convId); } } catch {} }, 6000);
  // a deployed update: when the server's version changes after this tab loaded, reload (between turns) so nobody keeps an old UI.
  // The baseline is the version the server reported at load (set in boot), not the ?v= of the asset links: a release that left
  // the HTML at an old ?v= made every tab reload every 45 seconds. A version already reloaded for is not reloaded for again.
  let LOADED_VERSION = '';
  setInterval(async () => {
    try {
      const h = await fetch('/api/health').then((r) => r.json());
      if (!LOADED_VERSION || !h.version || h.version === LOADED_VERSION || Object.keys(S.live).length) return;
      let tried = ''; try { tried = sessionStorage.getItem('missile_reloaded_for') || ''; } catch {}
      if (tried === h.version) return;
      try { sessionStorage.setItem('missile_reloaded_for', h.version); } catch {}
      toast(T('Updated to {v}. Reloading…', { v: h.version })); setTimeout(() => location.reload(), 1200);
    } catch {}
  }, 45000);

  // ---------------------------------------------------------------- intro: what this launchpad does (the mark in the rail, the version chip, once on a first visit)
  const ROCKET = '<svg viewBox="0 0 40 124" width="40" height="124"><defs>'
    + '<linearGradient id="rkBody" x1="0" x2="1"><stop offset="0" stop-color="#c9cee2"/><stop offset=".5" stop-color="#f5f6fb"/><stop offset="1" stop-color="#b3b9d3"/></linearGradient>'
    + '<linearGradient id="rkFlame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffbe8"/><stop offset=".3" stop-color="#fcd34d"/><stop offset=".7" stop-color="#fb923c"/><stop offset="1" stop-color="#f97316" stop-opacity="0"/></linearGradient></defs>'
    + '<g class="flicker"><path class="flame" d="M12 92 Q20 136 28 92 Z" fill="url(#rkFlame)"/></g>'
    + '<path d="M20 3 C30 15 32 30 32 44 L32 92 L8 92 L8 44 C8 30 10 15 20 3 Z" fill="url(#rkBody)"/>'
    + '<path d="M20 3 C26 10 29 18 30.6 27 L9.4 27 C11 18 14 10 20 3 Z" fill="#8b7cff"/>'
    + '<circle cx="20" cy="46" r="5.5" fill="#141821" stroke="#8b7cff" stroke-width="2"/>'
    + '<path d="M8 68 L0 92 L8 92 Z" fill="#6d5df5"/><path d="M32 68 L40 92 L32 92 Z" fill="#6d5df5"/><rect x="18" y="62" width="4" height="30" rx="2" fill="#8b7cff" opacity=".55"/></svg>';
  function openIntro() {
    if ($('.intro') || !S.st) return;
    try { localStorage.setItem('missile_intro_seen', '1'); } catch {}
    const st = S.st; const provs = st.providers || []; const servers = st.mcp || [];
    const up = provs.filter((p) => healthOf(p).state === 'ok').length;
    const live = servers.filter((s) => s.status === 'connected').length;
    const t = targetOf(activePane());

    const sdot = (s) => el('span', { class: 'hdot ' + (s.status === 'connected' ? 'ok' : ['disabled', 'stopped'].includes(s.status) ? 'unknown' : 'down'), title: `${s.name}: ${s.status}` });
    const chips = (items, more) => items.length ? el('div', { class: 'intro-chips' }, items, more > 0 ? el('span', { class: 'chip' }, `+${more}`) : null) : null;
    const stage = (n, eyebrow, title, text, extra) => el('div', { class: 'intro-stage', style: `--d:${n}` }, el('div', { class: 'eyebrow' }, `0${n} · ${eyebrow}`), el('h4', {}, title), el('p', {}, text), extra);
    const sky = el('div', { class: 'intro-sky' });
    for (let i = 0; i < 30; i++) sky.append(el('i', { style: `left:${(Math.random() * 100).toFixed(1)}%;top:${(Math.random() * 78).toFixed(1)}%;animation-delay:${(Math.random() * 3).toFixed(2)}s;opacity:${(0.25 + Math.random() * 0.6).toFixed(2)}` }));
    const count = el('div', { class: 'intro-count' }, 'T-3');
    const scene = el('div', { class: 'intro-scene', 'aria-hidden': 'true' }, sky, el('div', { class: 'intro-tower' }), el('div', { class: 'intro-carriage' }), el('div', { class: 'intro-arm back' }), el('div', { class: 'intro-trail' }), el('div', { class: 'intro-rocket', html: ROCKET }), el('div', { class: 'intro-arm front' }), el('div', { class: 'intro-smoke' }, [0, 1, 2, 3, 4, 5].map(() => el('i'))), el('div', { class: 'intro-pad' }), el('div', { class: 'intro-orbit' }), count);
    const launch = el('button', { class: 'btn primary', onclick: () => { close(); $('.composerInput', paneEl(activePane()))?.focus(); } }, I('send', 'sm'), T('Launch'));
    const ov = el('div', { class: 'intro', role: 'dialog', 'aria-modal': 'true', 'aria-label': T('About missile studio') },
      el('button', { class: 'btn quiet icon sm intro-x', 'aria-label': T('Close'), onclick: () => close() }, I('x', 'sm')),
      el('div', { class: 'intro-box' }, scene,
        el('div', { class: 'intro-head' }, el('span', { html: window.logoMark(40) }), el('span', { class: 'wordmark' }, 'missile', el('em', {}, 'studio'))),
        el('p', { class: 'intro-lede' }, T('A launchpad for your models and your tools.')),
        el('p', { class: 'intro-sub' }, T("Connect any model endpoint and the MCP servers on your own machine, then hand it the work. The agent runs the tools, keeps every request inside the model's context and carries the job through.")),
        el('div', { class: 'intro-stages' },
          stage(1, 'fuel', T('Models'), [provs.length ? T(provs.length === 1 ? '1 provider, {up} reachable now.' : '{n} providers, {up} reachable now.', { n: provs.length, up }) : T('No model provider yet.'), t.provider ? T('Default: {model}.', { model: `${t.provider.label || t.pid} · ${shortModel(t.model) || T('No model')}` }) : '', T('OpenAI-compatible servers, Anthropic, Gemini and your own GPU endpoints.')].filter(Boolean).join(' '),
            chips(provs.slice(0, 6).map((p) => el('span', { class: 'chip' }, hdot(p), p.label || p.id)), provs.length - 6)),
          stage(2, 'payload', T('Tools'), !isAdmin() ? T('Your chats use the tools the admin allows for studio accounts.') : [servers.length ? T(servers.length === 1 ? '{live} of 1 MCP server connected.' : '{live} of {n} MCP servers connected.', { live, n: servers.length }) : T('No MCP server yet.'), T((st.tools || []).length === 1 ? '1 tool in all.' : '{n} tools in all.', { n: (st.tools || []).length }), T('Each call follows your permission mode, and only the tools a task needs are loaded.')].join(' '),
            chips(servers.slice(0, 6).map((s) => el('span', { class: 'chip' }, sdot(s), s.name)), servers.length - 6)),
          stage(3, 'guidance', T('Harness'), T('One agent loop for every model. It retries failed requests, fits long threads into small context windows, and picks an answer back up when it stops short.')),
          stage(4, 'pad', T('Workspace'), isAdmin() ? T('Files, an editor, a terminal and artifacts sit in one panel (Ctrl/⌘ J). Chats, memory and knowledge stay on this machine.') : T('Artifacts from your chats open in a side panel (Ctrl/⌘ J). Only you see your chats.'))),
        el('div', { class: 'intro-foot' }, el('span', { class: 'chip mono' }, 'v' + (st.version || '')), el('span', { class: 'muted tiny' }, T('Ctrl/⌘ K for commands · Ctrl/⌘ B for the sidebar')), el('span', { class: 'spacer' }),
          isAdmin() ? el('button', { class: 'btn', onclick: () => { close(); S.view = 'settings'; S.settingsPage = 'providers'; render(); } }, I('settings', 'sm'), T('Settings')) : null, launch)));
    document.body.append(ov);
    const timers = [];
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // the caption follows the 11s launch-and-catch loop in app.css (phase ends in % of the loop)
    const PHASES = [[3, 'T-3'], [6, 'T-2'], [9, 'T-1'], [30, 'LIFTOFF'], [44, 'BOOSTBACK'], [64, 'LANDING BURN'], [70, 'CATCH'], [80, 'CAUGHT'], [90, 'SET DOWN'], [100, 'RESET']];
    const t0 = performance.now();
    const tick = () => { const at = ((performance.now() - t0) % 11000) / 110; const txt = PHASES.find(([end]) => at < end)[1]; if (count.textContent !== txt) count.textContent = txt; };
    if (calm) count.textContent = 'READY';
    else timers.push(setInterval(tick, 100));
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    function close() { timers.forEach(clearInterval); ov.remove(); document.removeEventListener('keydown', key); }
    document.addEventListener('keydown', key);
    setTimeout(() => launch.focus({ preventScroll: true }), 0);
  }

  // ---------------------------------------------------------------- palette (Ctrl/⌘ K) + shortcuts (Ctrl/⌘ /)
  function openPalette() {
    $('.palette')?.remove();
    const ov = el('div', { class: 'palette', onclick: (e) => { if (e.target === ov) close(); } });
    const inp = el('input', { placeholder: T('Search chats, run a command, or type a question…') });
    const list = el('div', { class: 'list' });
    ov.append(el('div', { class: 'box' }, inp, list)); document.body.append(ov);
    let hl = 0, rows = [];
    const actions = [
      { label: T('New chat'), sub: 'Ctrl/⌘ Shift O', icon: 'plus', run: () => newConv(activePane()) },
      { label: T('Split pane'), sub: 'Ctrl/⌘ \\', icon: 'columns', run: () => splitPane(S.active) },
      { label: T('Workspace panel'), sub: 'Ctrl/⌘ J', icon: 'file', run: () => { if (S.drawer.open) { S.drawer.open = false; render(); } else openDrawer(); } },
      { label: T('Show / hide sidebar'), sub: 'Ctrl/⌘ B', icon: 'sidebar', run: () => { if (S.view.startsWith('settings')) S.view = 'chat'; togglePane(); } },
      { label: T('About missile studio'), sub: S.st?.version ? 'v' + S.st.version : '', icon: 'info', run: () => openIntro() },
      { label: T('Artifacts'), sub: T('Generated code and documents'), icon: 'box', run: () => openDrawer('artifacts') },
      { label: T('Link pane inputs'), sub: S.linkInputs ? T('On') : T('Off'), icon: 'link', run: () => { S.linkInputs = !S.linkInputs; render(); } },
      { label: T('Theme: dark / warm / light'), sub: T(theme.get()), icon: 'moon', run: () => theme.toggle() },
      { label: T('Language: English / 한국어'), sub: LANG_NAME[i18n.lang], icon: 'globe', run: () => setLang(i18n.lang === 'ko' ? 'en' : 'ko') },
      { label: T('Settings · Model providers'), icon: 'cloud', run: () => { S.view = 'settings'; S.settingsPage = 'providers'; render(); } },
      { label: T('Settings · MCP servers'), icon: 'plug', run: () => { S.view = 'settings'; S.settingsPage = 'mcp'; render(); } },
      { label: T('Settings · Tools & policy'), icon: 'wrench', run: () => { S.view = 'settings'; S.settingsPage = 'tools'; render(); } },
      { label: T('Settings · Assistants'), icon: 'sparkles', run: () => { S.view = 'settings'; S.settingsPage = 'assistants'; render(); } },
      { label: T('Settings · Writing styles'), icon: 'wand', run: () => { S.view = 'settings'; S.settingsPage = 'styles'; render(); } },
      { label: T('Admin console'), icon: 'shield', run: () => window.open('/admin', '_blank') },
      { label: T('Keyboard shortcuts'), sub: 'Ctrl/⌘ /', icon: 'info', run: () => openShortcuts() },
      ...(S.health?.auth_required ? [{ label: T('Sign out'), sub: T('End this session'), icon: 'x', run: () => signOut() }] : []),
    ];
    const build = () => {
      const q = inp.value.trim(); const ql = q.toLowerCase(); list.innerHTML = ''; rows = [];
      const addRow = (node, run) => { const i = rows.length; rows.push({ node, run }); node.addEventListener('click', () => { close(); run(); }); node.addEventListener('mousemove', () => { hl = i; paint(); }); list.append(node); };
      const chats = S.convs.filter((c) => !ql || (c.title || '').toLowerCase().includes(ql)).slice(0, ql ? 12 : 6);
      if (chats.length) { list.append(el('div', { class: 'grp' }, T('Chats'))); for (const c of chats) { const a = assistantOf(c.assistant_id); addRow(el('div', { class: 'it' }, customEmoji(a) || I('chat', 'sm'), el('span', { class: 'truncate' }, c.title || T('New chat')), el('span', { class: 'sub' }, shortModel(c.model))), () => openConv(activePane(), c.id)); } }
      const acts = actions.filter((a) => !ql || (a.label + ' ' + (a.sub || '')).toLowerCase().includes(ql));
      if (acts.length) { list.append(el('div', { class: 'grp' }, T('Commands'))); for (const a of acts) addRow(el('div', { class: 'it' }, I(a.icon, 'sm'), el('span', {}, a.label), a.sub ? el('span', { class: 'sub' }, a.sub) : null), a.run); }
      if (q) { list.append(el('div', { class: 'grp' }, T('Ask the model'))); addRow(el('div', { class: 'it' }, I('send', 'sm'), el('span', { class: 'truncate' }, T('Ask: {q}', { q })), el('span', { class: 'sub' }, 'Enter')), () => { S.view = 'chat'; render(); send(activePane(), q); }); }
      hl = 0; paint();
    };
    const paint = () => rows.forEach((r, i) => r.node.classList.toggle('hl', i === hl));
    const close = () => { ov.remove(); document.removeEventListener('keydown', key); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, rows.length - 1); paint(); } else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); paint(); } else if (e.key === 'Enter') { e.preventDefault(); const r = rows[hl]; if (r) { close(); r.run(); } } };
    inp.addEventListener('input', build); document.addEventListener('keydown', key); build(); setTimeout(() => inp.focus(), 0);
  }
  function openShortcuts() {
    const rows = [['Ctrl/⌘ K', 'Search chats and commands'], ['Ctrl/⌘ Shift O', 'New chat in the active pane'], ['Ctrl/⌘ \\', 'Split the view'], ['Ctrl/⌘ Shift W', 'Close the active pane'], ['Ctrl/⌘ J', 'Workspace panel'], ['Ctrl/⌘ B', 'Show / hide the sidebar'], ['Ctrl/⌘ S', 'Save the open file'], ['Ctrl/⌘ ,', 'Settings'], ['Ctrl/⌘ /', 'This list'], ['Shift Esc', 'Focus the message box'], ['Ctrl/⌘ Shift C', 'Copy the last answer'], ['Ctrl/⌘ Shift ;', 'Copy the last code block'], ['Enter / Shift Enter', 'Send / new line'], [T('/ at the start'), 'Commands: /new /split /files /terminal /artifacts /tools /think /style /assistant /tool'], [T('Esc (while editing)'), 'Cancel editing a message']];
    modal({ title: T('Keyboard shortcuts'), body: el('div', { class: 'shortcuts' }, rows.map(([k, d]) => el('div', {}, el('span', {}, T(d)), el('span', { class: 'kbd' }, k)))) });
  }
  function lastAssistantText(pane) { for (let i = pane.messages.length - 1; i >= 0; i--) { const m = pane.messages[i]; if (m.role === 'assistant' && m.content) return m.content; } return ''; }

  // ---------------------------------------------------------------- workspace drawer (files · editor · terminal · artifacts)
  const redrawDrawer = () => { const d = $('.drawer'); if (d) d.replaceWith(renderDrawer()); };
  async function loadTree(path) {
    if (!isAdmin()) return;  // the workspace folder is the admins'; a studio user's drawer holds artifacts only
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
    try { const r = await api('/api/workspace/file', { method: 'PUT', body: { path: f.path, content: f.content } }); f.saved = f.content; f.size = r.size; toast(T('Saved {path}', { path: f.path }) + (r.versioned ? ' · ' + T('previous version kept') : '')); redrawDrawer(); } catch (e) { toast(e.message, true); }
  }
  async function runCommand(cmd) {
    const term = S.drawer.term; term.push({ kind: 'cmd', text: cmd });
    if (cmd === 'clear') { S.drawer.term = []; redrawDrawer(); return; }
    term.push({ kind: 'meta', text: T('Running…') });
    redrawDrawer();
    try { const r = await api('/api/workspace/run', { method: 'POST', body: { command: cmd, cwd: S.drawer.path === '.' ? '' : S.drawer.path, timeout_seconds: 120 } }); term.pop(); term.push({ kind: /\[exit 0\]\s*$/.test(r.output) ? 'out' : 'err', text: r.output }); term.push({ kind: 'meta', text: `· ${fmtMs(r.duration_ms)}` }); loadTree(S.drawer.path); }
    catch (e) { term.pop(); term.push({ kind: 'err', text: e.message }); }
    redrawDrawer();
  }
  function openArtifact(id) { S.drawer.open = true; S.drawer.tab = 'artifacts'; S.drawer.artifact = id; S.drawer.aTab = PREVIEWABLE.includes(S.artifacts[id]?.lang) ? 'preview' : 'code'; S.drawer.versions = null; render(); }
  async function saveArtifact(id) {
    const a = S.artifacts[id]; if (!a) return;
    const path = await promptDialog(T('Save to the workspace as'), a.savedPath || `artifacts/${a.name}`, T('A path inside the workspace folder. Saving over an existing file keeps the previous version.'));
    if (!path) return;
    try { const r = await api('/api/workspace/file', { method: 'PUT', body: { path, content: a.code } }); a.savedPath = path; toast(T('Saved {path}', { path }) + (r.versioned ? ' · ' + T('previous version kept') : '')); loadTree(S.drawer.path); } catch (e) { toast(e.message, true); }
  }
  function allArtifacts() { for (const p of S.panes) for (const m of p.messages) if (m.role === 'assistant' && m.content) { const tmp = el('div', { html: md(m.content) }); artifactize(tmp, m.id, p.convId); } return Object.values(S.artifacts).sort((a, b) => b.ts - a.ts); }
  function renderDrawer() {
    const D = S.drawer; const root = el('div', { class: 'drawer' });
    if (!isAdmin()) D.tab = 'artifacts';
    const tab = (id, icon, label) => el('button', { class: 'tab' + (D.tab === id ? ' active' : ''), onclick: () => { D.tab = id; root.replaceWith(renderDrawer()); if (id === 'files' && !D.entries.length) loadTree(D.path); } }, I(icon, 'sm'), label);
    root.append(el('div', { class: 'dhead' }, isAdmin() ? tab('files', 'file', T('Files')) : null, isAdmin() ? tab('editor', 'edit', D.file ? (D.file.content !== D.file.saved ? '● ' : '') + D.file.path.split('/').pop() : T('Editor')) : null, isAdmin() ? tab('terminal', 'terminal', T('Terminal')) : null, tab('artifacts', 'box', T('Artifacts')), el('span', { class: 'spacer' }), isAdmin() ? el('button', { class: 'btn quiet icon sm', title: T('Refresh'), onclick: () => loadTree(D.path) }, I('refresh', 'sm')) : null, el('button', { class: 'btn quiet icon sm', title: T('Close'), onclick: () => { D.open = false; render(); } }, I('x', 'sm'))));
    const body = el('div', { class: 'dbody' }); root.append(body);
    if (D.tab === 'files') {
      const parts = D.path === '.' ? [] : D.path.split('/');
      const crumbs = el('div', { class: 'crumbs' }, el('button', { onclick: () => loadTree('.') }, T('workspace')));
      parts.forEach((p, i) => { crumbs.append('/', el('button', { onclick: () => loadTree(parts.slice(0, i + 1).join('/')) }, p)); });
      body.append(crumbs);
      const tree = el('div', { class: 'tree' });
      if (D.path !== '.') tree.append(el('div', { class: 'row', onclick: () => loadTree(parts.slice(0, -1).join('/') || '.') }, I('chevronR', 'xs'), '..'));
      for (const e of D.entries) tree.append(el('div', { class: 'row' + (D.file && D.file.path === e.path ? ' sel' : ''), onclick: () => e.dir ? loadTree(e.path) : openFile(e.path) }, I(e.dir ? 'box' : 'file', 'sm'), el('span', { class: 'truncate' }, e.name), e.dir ? null : el('span', { class: 'sz' }, fmtBytes(e.size)), e.dir ? null : el('a', { class: 'dl', href: downloadUrl(e.path), download: e.name, title: T('Download'), onclick: (ev) => ev.stopPropagation() }, I('download', 'xs'))));
      if (!D.entries.length && !D.loading) tree.append(el('div', { class: 'muted tiny', style: 'padding:10px' }, T('Empty folder. Ask the agent to create something, save an artifact, or use the terminal.')));
      body.append(tree);
      body.append(el('div', { class: 'dfoot' }, D.root || ''));
    } else if (D.tab === 'editor') body.append(renderEditor());
    else if (D.tab === 'artifacts') body.append(renderArtifacts());
    else {
      const term = el('div', { class: 'term' });
      const out = el('div', { class: 'tout' });
      if (!D.term.length) out.append(el('span', { class: 'meta' }, T('Workspace shell · {shell} · commands run on the server inside {dir} · "clear" clears the screen', { shell: navigator.platform.startsWith('Win') ? 'PowerShell' : 'sh', dir: D.root || T('the workspace') }) + '\n'));
      for (const line of D.term) out.append(el('div', { class: line.kind }, line.kind === 'cmd' ? '$ ' + line.text : line.text));
      term.append(out);
      const inp = el('input', { placeholder: isAdmin() ? T('Command…') : T('The terminal needs the admin role'), disabled: !isAdmin() || undefined, onkeydown: (e) => { if (e.key === 'Enter' && inp.value.trim()) { const c = inp.value.trim(); inp.value = ''; runCommand(c); } } });
      term.append(el('div', { class: 'tin' }, el('span', {}, (D.path === '.' ? '~' : D.path) + ' $'), inp));
      body.append(term);
      setTimeout(() => { out.scrollTop = out.scrollHeight; inp.focus(); }, 0);
    }
    return root;
  }
  // ---- editor with selection-based editing and saved versions
  function renderEditor() {
    const D = S.drawer;
    if (!D.file) return el('div', { class: 'empty' }, el('div', { class: 'big' }, '📝'), el('h3', {}, T('No file open')), el('div', {}, T('Pick one in Files, or open an artifact. Select text to have the chat rewrite just that part.')));
    const f = D.file; const dirty = f.content !== f.saved;
    const ed = el('div', { class: 'editor' });
    const versionsBtn = el('button', { class: 'btn sm', title: T('Previously saved versions'), onclick: async () => { try { const h = await api(`/api/workspace/history?path=${encodeURIComponent(f.path)}`); D.versions = h.versions; ed.replaceWith(renderEditor()); } catch (e) { toast(e.message, true); } } }, I('clock', 'sm'), T('Versions'));
    ed.append(el('div', { class: 'ehead' }, el('span', { class: 'mono truncate' }, f.path), el('span', { class: 'muted' }, fmtBytes(f.size)), el('span', { class: 'spacer' }), f.onDisk === false ? null : el('a', { class: 'btn sm', href: downloadUrl(f.path), download: baseName(f.path), title: T('Download this file') }, I('download', 'sm')), versionsBtn, el('button', { class: 'btn sm', title: T('Ask the active pane about this file'), onclick: () => { const p = activePane(); p.draft = (p.draft ? p.draft + '\n' : '') + T('Look at {path} and ', { path: f.path }); render(); $('.composerInput', paneEl(p))?.focus(); } }, I('chat', 'sm'), T('Ask about this')), isAdmin() ? el('button', { class: 'btn primary sm', disabled: !dirty, onclick: saveFile }, I('check', 'sm'), dirty ? T('Save') : T('Saved')) : el('span', { class: 'chip' }, T('read-only'))));
    if (D.versions) {
      ed.append(el('div', { class: 'row', style: 'padding:6px 12px;border-bottom:1px solid var(--border);flex-wrap:wrap;font-size:12px' }, el('span', { class: 'muted' }, D.versions.length ? T('Versions:') : T('No previous versions')), ...D.versions.slice(0, 8).map((v) => el('button', { class: 'btn sm', onclick: async () => { try { const r = await api(`/api/workspace/history/file?name=${encodeURIComponent(v.name)}`); showDiff(T('Version from {time}', { time: new Date(v.ts * 1000).toLocaleString(LOC()) }), f.content, r.content, () => { f.content = r.content; ed.replaceWith(renderEditor()); }); } catch (e) { toast(e.message, true); } } }, new Date(v.ts * 1000).toLocaleTimeString(LOC()))), el('button', { class: 'btn quiet sm', onclick: () => { D.versions = null; ed.replaceWith(renderEditor()); } }, T('Hide'))));
    }
    const ta = el('textarea', { spellcheck: 'false', readonly: !isAdmin() || undefined });
    ta.value = f.content;
    ta.addEventListener('input', () => { f.content = ta.value; const t = $('.drawer .dhead .tab:nth-child(2)'); if (t) t.lastChild.textContent = (f.content !== f.saved ? '● ' : '') + f.path.split('/').pop(); const b = $('.drawer .ehead .btn.primary'); if (b) { b.disabled = f.content === f.saved; b.lastChild.textContent = f.content === f.saved ? T('Saved') : T('Save'); } });
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); } if (e.key === 'Tab') { e.preventDefault(); const s = e.target.selectionStart; e.target.setRangeText('  ', s, e.target.selectionEnd, 'end'); f.content = e.target.value; } });
    let tool = null;
    const showTool = () => {
      const s = ta.selectionStart, e = ta.selectionEnd;
      if (tool) { tool.remove(); tool = null; }
      if (s === e || !isAdmin()) return;
      const sel = ta.value.slice(s, e);
      const inp = el('input', { placeholder: T('Ask to change the selection…') });
      const go = (instr, mode = 'replace') => { tool?.remove(); tool = null; requestSelectionEdit(f, s, e, sel, instr, mode); };
      tool = el('div', { class: 'seltool', onmousedown: (ev) => ev.stopPropagation() }, inp, el('button', { class: 'btn primary sm', onclick: () => inp.value.trim() && go(inp.value.trim()) }, I('send', 'xs')), el('button', { class: 'btn sm', title: T('Fix bugs in the selection'), onclick: () => go(T('Fix any bugs or mistakes in this selection. Keep the behaviour and style otherwise.')) }, T('Fix')), el('button', { class: 'btn sm', title: T('Add explanatory comments'), onclick: () => go(T('Add short, useful comments to this selection. Do not change the logic.')) }, T('Comment')), el('button', { class: 'btn sm', title: T('Explain in chat without changing the file'), onclick: () => go(T('Explain what this selection does and point out anything risky.'), 'ask') }, T('Explain')), el('button', { class: 'btn sm', title: T('Review in chat without changing the file'), onclick: () => go(T('Review this selection like a careful senior engineer: correctness, edge cases, naming. Be concrete.'), 'ask') }, T('Review')));
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
    if (!m) { toast(T('The model did not return a replacement block.'), true); return; }
    const replacement = m[1].replace(/\n$/, '');
    const f = S.drawer.file;
    if (!f || f.path !== pe.path) { toast(T('The file changed. The replacement was not applied.'), true); return; }
    showDiff(T('Proposed change · {path}', { path: pe.path }), pe.selection, replacement, () => {
      const idx = f.content.indexOf(pe.selection, Math.max(0, pe.start - 50));
      const at = idx >= 0 ? idx : f.content.indexOf(pe.selection);
      if (at < 0) return toast(T('The original selection is no longer in the file.'), true);
      f.content = f.content.slice(0, at) + replacement + f.content.slice(at + pe.selection.length);
      S.drawer.open = true; S.drawer.tab = 'editor'; render(); toast(T('Applied · Ctrl/⌘ S to save'));
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
    const m = modal({ title, body: box, wide: true, footer: [el('button', { class: 'btn', onclick: () => m.close() }, T('Discard')), el('button', { class: 'btn primary', onclick: () => { m.close(); onApply(); } }, I('check', 'sm'), T('Apply to the editor'))] });
  }
  // ---- artifacts tab
  function renderArtifacts() {
    const D = S.drawer;
    if (!D.artifact || !S.artifacts[D.artifact]) {
      const arts = allArtifacts();
      const list = el('div', { class: 'alist' });
      if (!arts.length) list.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '📦'), el('h3', {}, T('No artifacts yet')), el('div', {}, T('Long code blocks and HTML, SVG or Markdown documents the assistant writes show up here, with a preview, copy and save.'))));
      for (const a of arts) list.append(el('div', { class: 'artifact' }, el('div', { class: 'ahead', onclick: () => openArtifact(a.id) }, el('div', { class: 'aicon' }, I(a.lang === 'html' || a.lang === 'svg' ? 'globe' : 'terminal', 'sm')), el('div', { style: 'min-width:0' }, el('div', { class: 'atitle truncate' }, a.name), el('div', { class: 'asub' }, T('{lang} · {n} lines', { lang: a.lang || 'text', n: a.lines }) + (a.savedPath ? ' · ' + T('saved to {path}', { path: a.savedPath }) : ''))))));
      return list;
    }
    const a = S.artifacts[D.artifact]; const view = el('div', { class: 'aview' });
    const canPreview = PREVIEWABLE.includes(a.lang);
    const swap = () => view.replaceWith(renderArtifacts());
    const tabs = el('div', { class: 'tabs' }, ...(canPreview ? [el('button', { class: D.aTab === 'preview' ? 'active' : '', onclick: () => { D.aTab = 'preview'; swap(); } }, T('Preview'))] : []), el('button', { class: D.aTab === 'code' || !canPreview ? 'active' : '', onclick: () => { D.aTab = 'code'; swap(); } }, T('Code')));
    view.append(el('div', { class: 'ahead' }, el('button', { class: 'btn quiet icon sm', title: T('All artifacts'), onclick: () => { D.artifact = null; swap(); } }, I('chevronR', 'sm')), el('span', { class: 'mono truncate', style: 'max-width:160px' }, a.name), el('span', { class: 'muted' }, T('{lang} · {n} lines', { lang: a.lang || 'text', n: a.lines })), el('span', { class: 'spacer' }), tabs, el('button', { class: 'btn quiet icon sm', title: T('Copy'), onclick: () => navigator.clipboard.writeText(a.code).then(() => toast(T('Copied'))) }, I('copy', 'sm')), el('button', { class: 'btn sm', title: T('Download'), onclick: () => saveBlob(a.name, a.code) }, I('download', 'sm'), T('Download')), isAdmin() ? el('button', { class: 'btn primary sm', title: T('Save into the workspace folder'), onclick: () => saveArtifact(a.id) }, I('file', 'sm'), a.savedPath ? T('Save again') : T('Save')) : null, el('button', { class: 'btn sm', title: T('Open in the editor'), onclick: () => { D.file = { path: a.savedPath || `artifacts/${a.name}`, content: a.code, saved: a.savedPath ? a.code : '', size: a.code.length, onDisk: !!a.savedPath }; D.tab = 'editor'; D.versions = null; redrawDrawer(); } }, I('edit', 'sm'))));
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
  const USER_PAGES = ['general'];  // the settings a studio user sees; the rest is the admins'
  const SETTINGS_NAV = [
    { grp: 'Models' }, { id: 'providers', label: 'Model providers', icon: 'cloud' }, { id: 'default', label: 'Defaults & presets', icon: 'box' },
    { grp: 'Tools' }, { id: 'mcp', label: 'MCP servers', icon: 'plug' }, { id: 'tools', label: 'Tools & policy', icon: 'wrench' }, { id: 'knowledge', label: 'Knowledge base', icon: 'box' }, { id: 'memory', label: 'Memory', icon: 'brain' }, { id: 'assistants', label: 'Assistants', icon: 'sparkles' }, { id: 'styles', label: 'Writing styles', icon: 'wand' }, { id: 'prompts', label: 'Prompt library', icon: 'list' }, { id: 'agents', label: 'Agent servers', icon: 'bot' },
    { grp: 'Studio' }, { id: 'audit', label: 'Audit log', icon: 'list' }, { id: 'general', label: 'General', icon: 'settings' },
  ];
  // what each settings page holds, for the settings search (English here, Korean in i18n.js)
  const SETTINGS_KEYS = { providers: 'api key endpoint url custom model openai anthropic gemini ollama vllm test', default: 'default new chat preset quick model', mcp: 'mcp server tool stdio http sse wake restart import', tools: 'policy permission allow ask block shell file web search catalog workspace', knowledge: 'knowledge documents folder index embeddings search', memory: 'memory remember recall', assistants: 'assistant system prompt temperature max tokens tools', styles: 'writing style tone', prompts: 'prompt library template variables slash command', agents: 'agent server bridge device', audit: 'audit log tool calls history export csv', general: 'general language theme appearance text size wide notifications keyboard shortcuts session sign out version' };
  function renderSettings() {
    if (!isAdmin() && !USER_PAGES.includes(S.settingsPage)) S.settingsPage = 'general';
    const root = el('div', { class: 'settings' });
    const nav = el('div', { class: 'snav' }, el('h2', {}, T('Settings')));
    nav.append(el('button', { onclick: () => { S.view = 'chat'; render(); } }, I('chat', 'sm'), T('Back to chat')));
    // search the settings: page names and what each page holds, in both languages; Enter opens the first match
    const find = el('input', { class: 'input sfind', placeholder: T('Search settings'), value: S.settingsQuery || '' });
    nav.append(find);
    const navItems = [];
    for (const n of isAdmin() ? SETTINGS_NAV : SETTINGS_NAV.filter((x) => USER_PAGES.includes(x.id))) { if (n.grp) { const g = el('div', { class: 'grp' }, T(n.grp)); nav.append(g); navItems.push({ g }); continue; } const b = el('button', { class: S.settingsPage === n.id ? 'active' : '', onclick: () => { S.settingsPage = n.id; render(); } }, I(n.icon, 'sm'), T(n.label)); nav.append(b); const label = [n.label, T(n.label)].join(' ').toLowerCase(); navItems.push({ b, label, hay: [label, SETTINGS_KEYS[n.id] || '', T(SETTINGS_KEYS[n.id] || '')].join(' ').toLowerCase() }); }
    const filterNav = () => { const q = find.value.trim().toLowerCase(); S.settingsQuery = find.value; let group = null, groupHas = false; for (const it of [...navItems, { g: null }]) { if ('g' in it) { if (group) group.style.display = groupHas || !q ? '' : 'none'; group = it.g; groupHas = false; continue; } const hit = !q || q.split(/\s+/).every((w) => it.hay.includes(w)); it.b.style.display = hit ? '' : 'none'; if (hit) groupHas = true; } };
    find.addEventListener('input', filterNav);
    // Enter opens the page whose name matches first, otherwise the first page that mentions the words
    find.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const ws = find.value.trim().toLowerCase().split(/\s+/); const shown = navItems.filter((it) => it.b && it.b.style.display !== 'none'); const best = shown.find((it) => ws.every((w) => it.label.includes(w))) || shown[0]; if (best) best.b.click(); } else if (e.key === 'Escape') { find.value = ''; filterNav(); } });
    filterNav();
    root.append(nav);
    const content = el('div', { class: 'scontent' }); root.append(content);
    ({ providers: pageProviders, default: pageDefault, mcp: pageMcp, tools: pageTools, knowledge: pageKnowledge, memory: pageMemory, assistants: pageAssistants, styles: pageStyles, prompts: pagePrompts, agents: pageAgents, audit: pageAudit, general: pageGeneral }[S.settingsPage] || pageProviders)(content);
    return root;
  }
  const page = (title, sub, ...kids) => el('div', { class: 'page' }, el('h1', {}, T(title), sub ? el('small', {}, T(sub)) : null), ...kids);

  function pageProviders(content) {
    const list = el('div', { class: 'listbox' });
    const selId = S.sel.providerId && providerOf(S.sel.providerId) ? S.sel.providerId : (S.st.providers[0]?.id || '');
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: addProviderModal }, I('plus', 'sm'), T('Add provider'))));
    for (const p of S.st.providers) list.append(el('div', { class: 'lrow' + (p.id === selId ? ' active' : ''), onclick: () => { S.sel.providerId = p.id; render(); } }, el('div', { class: 'em', style: avatarStyle(p.id) }, initials(p.label || p.id)), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, p.label || p.id), el('div', { class: 'sub truncate' }, `${p.kind} · ${T('{n} models', { n: p.models.length })}`)), el('span', { class: 'dot ' + (p.enabled === false ? '' : ({ ok: 'ok', down: 'err', nokey: 'warn' }[healthOf(p).state] || (p.has_key || p.kind === 'agentserver' || /127\.0\.0\.1|localhost/.test(p.base_url) ? 'ok' : 'warn'))), title: healthLabel(healthOf(p).state) + (healthOf(p).error ? ' · ' + healthOf(p).error : '') })));
    if (!S.st.providers.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px' }, T('No providers yet.')));
    const detail = el('div');
    const p = providerOf(selId);
    if (p) detail.append(providerDetail(p)); else detail.append(el('div', { class: 'card' }, el('h3', {}, T('Pick a preset to begin')), el('p', { class: 'muted', style: 'margin:0' }, T('OpenAI, Anthropic, Gemini, DashScope, OpenRouter, Groq, DeepSeek, Mistral, xAI, or a local Ollama, LM Studio, vLLM or llama.cpp. Any OpenAI-compatible endpoint works.')), el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: customEndpointModal }, I('link', 'sm'), T('Custom endpoint')), el('button', { class: 'btn', onclick: addProviderModal }, I('plus', 'sm'), T('Add provider')))));
    content.append(page('Model providers', 'Where your models come from', el('div', { class: 'split' }, list, detail)));
  }
  function providerDetail(p) {
    const card = el('div', { class: 'card' });
    const draft = { ...p };
    card.append(el('h3', {}, el('span', { class: 'em', style: `${avatarStyle(p.id)};width:28px;height:28px;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700` }, initials(p.label || p.id)), p.label || p.id, el('span', { class: 'chip' }, p.kind), S.st.default.provider === p.id ? el('span', { class: 'chip primary' }, T('default')) : null, el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, T('Enabled')), switchEl(p.enabled !== false, async (v) => { await api('/api/providers', { method: 'POST', body: { id: p.id, enabled: v } }); await loadState(); })));
    const keyIn = el('input', { class: 'input', type: 'password', placeholder: p.has_key ? T('Saved · type to replace') : (p.kind === 'agentserver' ? T('Not used') : T('Paste an API key, or name an environment variable below')), oninput: (e) => { draft.api_key = e.target.value; } });
    const eye = el('button', { class: 'btn icon', title: T('Show'), onclick: () => { keyIn.type = keyIn.type === 'password' ? 'text' : 'password'; } }, I('eye', 'sm'));
    const testOut = el('pre', { class: 'out hidden' });
    const testBtn = el('button', { class: 'btn', onclick: async () => { testOut.classList.remove('hidden'); testOut.textContent = T('Testing…'); try { const r = await api('/api/providers/test', { method: 'POST', body: { ...draft } }); testOut.textContent = r.ok ? `OK · ${T('{n} models', { n: r.count })} · ${r.ms}ms\n${r.models.slice(0, 40).join('\n')}${r.count > 40 ? '\n…' : ''}` : T('Failed') + ' · ' + r.error; } catch (e) { testOut.textContent = e.message; } } }, I('activity', 'sm'), T('Test'));
    if (p.kind !== 'agentserver') card.append(field(T('API key'), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, keyIn, eye, testBtn), T('Stored in config.json on this machine. It is never sent back to the browser.')), field(T('API key from an environment variable'), el('input', { class: 'input', value: p.api_key_env || '', placeholder: 'OPENAI_API_KEY', oninput: (e) => { draft.api_key_env = e.target.value; } })));
    card.append(field(T('Base URL'), el('input', { class: 'input', value: p.base_url || '', oninput: (e) => { draft.base_url = e.target.value; } })));
    if (p.kind === 'agentserver') card.append(el('div', { class: 'grid2' }, field(T('Login e-mail'), el('input', { class: 'input', value: p.email || '', oninput: (e) => { draft.email = e.target.value; } })), field(T('Password'), el('div', { class: 'row', style: 'flex-wrap:nowrap' }, el('input', { class: 'input', type: 'password', placeholder: p.has_password ? T('Saved · type to replace') : '', oninput: (e) => { draft.password = e.target.value; } }), testBtn))));
    card.append(testOut);
    const models = [...new Set([p.default_model, ...(p.models || [])].filter(Boolean))];
    const modelsBox = el('div', { class: 'pill-list' });
    // click a model to make it the default, ✕ to drop it from the picker (Save keeps the change); a filter for long lists
    const mFilter = el('input', { class: 'input', placeholder: T('Filter models…'), oninput: () => renderModels() });
    const dropModel = (m) => { models.splice(models.indexOf(m), 1); draft.models = models.slice(); if (draft.default_model === m) draft.default_model = models[0] || ''; renderModels(); };
    const renderModels = () => { modelsBox.innerHTML = ''; const q = mFilter.value.trim().toLowerCase(); const shown = models.filter((m) => !q || m.toLowerCase().includes(q)); for (const m of shown.slice(0, 300)) modelsBox.append(el('span', { class: 'chip mchip' + (m === draft.default_model ? ' sel' : ''), title: T('Set as the default model'), onclick: () => { draft.default_model = m; renderModels(); } }, shortModel(m), el('button', { class: 'x', title: T('Remove from the list'), onclick: (e) => { e.stopPropagation(); dropModel(m); } }, '✕'))); if (shown.length > 300) modelsBox.append(el('span', { class: 'muted tiny' }, T('+{n} more', { n: shown.length - 300 }))); if (!models.length) modelsBox.append(el('span', { class: 'muted tiny' }, T('No models yet. Find them, or type one below.'))); else if (!shown.length) modelsBox.append(el('span', { class: 'muted tiny' }, T('No matches'))); };
    renderModels();
    const addModel = el('input', { class: 'input', placeholder: T('Add a model id by hand'), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = addModel.value.trim(); if (v) { models.unshift(v); draft.models = [...new Set([...(draft.models || []), v])]; if (!draft.default_model) draft.default_model = v; addModel.value = ''; renderModels(); } } } });
    card.append(el('div', { class: 'sect' }, `${T('Models')} · ${models.length}`), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { try { const r = await api(`/api/providers/${encodeURIComponent(p.id)}/models`, { method: 'POST' }); toast(T('{n} models', { n: r.models.length })); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('refresh', 'sm'), p.kind === 'agentserver' ? T('Sync agents') : T('Find models')), addModel), models.length > 12 ? mFilter : '', modelsBox, models.length ? el('div', { class: 'muted tiny' }, T('Click a model to make it the default, ✕ to remove it from the picker. Save keeps the change.')) : '');  // native append prints null, so '' for nothing
    const adv = el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer' }, T('Advanced: extra request body, headers, label, TLS')));
    adv.append(el('div', { class: 'grid2', style: 'margin-top:10px' }, field(T('Label'), el('input', { class: 'input', value: p.label || '', oninput: (e) => { draft.label = e.target.value; } })), field(T('Allow self-signed TLS'), switchEl(!!p.allow_insecure_tls, (v) => { draft.allow_insecure_tls = v; })), field(T('Tool calls through the prompt'), switchEl(!!p.tools_via_prompt, (v) => { draft.tools_via_prompt = v; }), T('For servers that reject tool definitions, such as vLLM without a tool-call parser. Tools are described in the prompt and <tool_call> blocks are read from the text. Turns on by itself when such a server answers 400.')), field(T('Context window (tokens)'), el('input', { class: 'input', type: 'number', value: p.context_window || '', placeholder: T('auto'), oninput: (e) => { draft.context_window = parseInt(e.target.value || '0', 10) || 0; } }), T('Long threads are summarized at 60% of this.')), field(T('Extra body (JSON)'), el('input', { class: 'input', value: Object.keys(p.extra_body || {}).length ? JSON.stringify(p.extra_body) : '', placeholder: '{"enable_thinking": false}', oninput: (e) => { draft._extra = e.target.value; } }), T('Merged into every request. The thinking switch in chat adds its own setting on top of this.')), field(T('Headers (JSON)'), el('input', { class: 'input', value: Object.keys(p.headers || {}).length ? JSON.stringify(p.headers) : '', placeholder: '{"X-Title": "missile"}', oninput: (e) => { draft._headers = e.target.value; } })), field(T('Endpoint file'), el('input', { class: 'input', value: p.endpoint_file || '', placeholder: 'D:/path/to/endpoint.txt', oninput: (e) => { draft.endpoint_file = e.target.value.trim(); } }), T('A file with "base_url|model|api_key" that this provider follows. When the server moves (a recreated GPU pod, for example), rewriting the file moves the provider too.')), field(T('Wake server'), el('select', { class: 'select', onchange: (e) => { draft.wake_server = e.target.value; } }, el('option', { value: '' }, T('(none)')), ...(S.st.mcp || []).filter((m) => m.config?.wake_command).map((m) => el('option', { value: m.name, selected: m.name === p.wake_server }, m.name))), T('When this provider is down, the chat offers a Wake button that runs the wake command of this MCP server.'))));
    card.append(adv);
    card.append(el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { try { const body = { ...draft }; delete body._extra; delete body._headers; if (draft._extra !== undefined) body.extra_body = draft._extra ? JSON.parse(draft._extra) : {}; if (draft._headers !== undefined) body.headers = draft._headers ? JSON.parse(draft._headers) : {}; if (!body.api_key) delete body.api_key; if (!body.password) delete body.password; await api('/api/providers', { method: 'POST', body }); toast(T('Saved')); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), T('Save')), el('button', { class: 'btn', onclick: async () => { await api('/api/default', { method: 'POST', body: { provider: p.id, model: draft.default_model || p.default_model } }); toast(T('Default updated')); await loadState(); render(); } }, T('Use as default')), el('span', { class: 'spacer' }), el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(T('Remove the provider {id}?', { id: p.id }), T('Remove'))) { await api('/api/providers/' + encodeURIComponent(p.id), { method: 'DELETE' }); S.sel.providerId = ''; await loadState(); render(); } } }, I('trash', 'sm'), T('Remove'))));
    return card;
  }
  function addProviderModal() {
    const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px' });
    const custom = el('button', { class: 'btn custom-ep', onclick: () => { m.close(); customEndpointModal(); } }, el('span', { class: 'em' }, I('link', 'sm')), el('span', { style: 'min-width:0' }, el('div', { style: 'font-weight:700' }, T('Custom endpoint')), el('div', { class: 'muted tiny' }, T('Any server with an OpenAI, Anthropic or Gemini API. Paste its URL and key; the format and models are found for you.'))));
    const m = modal({ title: T('Add a provider'), body: [custom, el('div', { class: 'sect' }, T('Or start from a preset')), grid], wide: true });
    for (const pr of S.st.presets) grid.append(el('button', { class: 'btn', style: 'height:auto;padding:10px 12px;justify-content:flex-start;text-align:left;gap:10px', onclick: () => { m.close(); createFromPreset(pr); } }, el('span', { class: 'em', style: `${avatarStyle(pr.id)};width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700;flex:none` }, initials(pr.label)), el('span', { style: 'min-width:0' }, el('div', { class: 'truncate', style: 'font-weight:600' }, pr.label), el('div', { class: 'muted tiny truncate' }, pr.needs_key ? T('API key') : T('No key · local')))));
  }
  // ---- a provider from any endpoint: paste a bare host, a base URL or a full request URL and a key; the server
  // tries the likely API format and base URL, then the models it lists can be kept or dropped
  const slugId = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  function customEndpointModal() {
    const d = { label: '', id: '', url: '', kind: 'auto', api_key: '', headers: '', tls: false, viaPrompt: false, ctx: '' };
    let probe = null; let keep = new Set(); let def = ''; let idTouched = false;
    const idIn = el('input', { class: 'input', placeholder: 'my-server', oninput: (e) => { idTouched = true; d.id = slugId(e.target.value); } });
    const nameIn = el('input', { class: 'input', placeholder: T('e.g. My GPU server'), oninput: (e) => { d.label = e.target.value; if (!idTouched) { d.id = slugId(d.label); idIn.value = d.id; } } });
    const urlIn = el('input', { class: 'input', placeholder: 'http://localhost:11434 · https://host/v1/chat/completions', oninput: (e) => { d.url = e.target.value; probe = null; result.innerHTML = ''; } });
    const kindSel = el('select', { class: 'select', onchange: (e) => { d.kind = e.target.value; probe = null; result.innerHTML = ''; } }, ...[['auto', T('Detect from the URL')], ['openai', T('OpenAI-compatible')], ['anthropic', 'Anthropic'], ['gemini', 'Google Gemini']].map(([v, l]) => el('option', { value: v }, l)));
    const keyIn = el('input', { class: 'input', type: 'password', placeholder: T('Leave empty if the server needs no key'), oninput: (e) => { d.api_key = e.target.value; } });
    const manualIn = el('input', { class: 'input', placeholder: T('A model id, if the server does not list its models') });
    const result = el('div', { class: 'probe' });
    const checkBtn = el('button', { class: 'btn', onclick: () => check() }, I('activity', 'sm'), T('Check and find models'));
    const adv = el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer' }, T('Advanced: headers, TLS, tool calls, context window')),
      el('div', { style: 'display:grid;gap:12px;margin-top:10px' },
        field(T('Headers (KEY=VALUE per line)'), el('textarea', { class: 'textarea', style: 'min-height:56px', oninput: (e) => { d.headers = e.target.value; } })),
        el('div', { class: 'grid2' }, field(T('Allow self-signed TLS'), switchEl(false, (v) => { d.tls = v; })), field(T('Tool calls through the prompt'), switchEl(false, (v) => { d.viaPrompt = v; }), T('For servers that reject tool definitions. Turns on by itself when such a server answers 400.'))),
        field(T('Context window (tokens)'), el('input', { class: 'input', type: 'number', placeholder: T('auto'), oninput: (e) => { d.ctx = e.target.value; } }))));
    function renderModels() {
      result.innerHTML = '';
      if (!probe) return;
      if (!probe.ok) {
        result.append(el('div', { class: 'error-line' }, T('Could not reach it: {error}', { error: (probe.error || '').slice(0, 300) })), el('div', { class: 'muted tiny' }, T('Tried: {list}', { list: (probe.tried || []).map((t) => `${t.kind} ${t.base_url}`).join(' · ') })), field(T('Model id'), manualIn, T('You can still save it with a model id and fix the address later.')));
        return;
      }
      const models = probe.models || [];
      result.append(el('div', { class: 'okline' }, I('check', 'sm'), T('Connected · {kind} · {n} models · {ms}ms', { kind: probe.kind === 'openai' ? T('OpenAI-compatible') : probe.kind, n: probe.count, ms: probe.ms }), el('span', { class: 'mono muted tiny', style: 'margin-left:6px' }, probe.base_url)));
      if (!models.length) { result.append(field(T('Model id'), manualIn, T('The server listed no models. Type the one to use.'))); return; }
      const filter = el('input', { class: 'input', placeholder: T('Filter models…') });
      const list = el('div', { class: 'mlist' });
      const head = el('div', { class: 'row tiny' }, el('span', { class: 'muted' }, T('Keep the models to show in the picker. ★ marks the default.')), el('span', { class: 'spacer' }), el('button', { class: 'btn quiet sm', onclick: () => { keep = new Set(models); draw(); } }, T('Keep all')), el('button', { class: 'btn quiet sm', onclick: () => { keep = new Set(def ? [def] : []); draw(); } }, T('Clear')));
      const draw = () => {
        list.innerHTML = ''; const q = filter.value.trim().toLowerCase();
        for (const m of models.filter((x) => !q || x.toLowerCase().includes(q)).slice(0, 400)) {
          list.append(el('label', { class: 'mrow' + (keep.has(m) ? ' on' : '') }, el('input', { type: 'checkbox', checked: keep.has(m) || undefined, onchange: (e) => { if (e.target.checked) keep.add(m); else { keep.delete(m); if (def === m) def = ''; } draw(); } }), el('span', { class: 'mono truncate' }, m), el('button', { class: 'star' + (def === m ? ' on' : ''), title: T('Use as the default model'), onclick: (e) => { e.preventDefault(); def = m; keep.add(m); draw(); } }, def === m ? '★' : '☆')));
        }
      };
      filter.addEventListener('input', draw);
      result.append(head, filter, list); draw();
    }
    async function check() {
      if (!d.url.trim()) { toast(T('Enter the endpoint URL.'), true); return null; }
      checkBtn.disabled = true; result.innerHTML = ''; result.append(el('div', { class: 'muted tiny' }, T('Checking…')));
      try { probe = await api('/api/providers/probe', { method: 'POST', body: { url: d.url, kind: d.kind, api_key: d.api_key, headers: kv(d.headers), allow_insecure_tls: d.tls } }); }
      catch (e) { probe = { ok: false, error: e.message, tried: [] }; }
      checkBtn.disabled = false;
      if (probe.ok) { const ms = probe.models || []; keep = new Set(ms); def = ms[0] || ''; }
      renderModels();
      return probe;
    }
    async function save() {
      if (!d.label.trim()) { toast(T('Enter a name.'), true); nameIn.focus(); return; }
      if (!probe) await check();
      if (!probe) return;
      let id = d.id || slugId(d.label) || 'custom'; const base = id; let n = 2; while (providerOf(id)) id = `${base}-${n++}`;
      const manual = manualIn.value.trim();
      const models = probe.ok && (probe.models || []).length ? [...keep] : (manual ? [manual] : []);
      const body = { id, label: d.label.trim(), kind: probe.kind || (d.kind === 'auto' ? 'openai' : d.kind), base_url: probe.base_url || d.url.trim(), api_key: d.api_key, models, default_model: def && keep.has(def) ? def : (models[0] || ''), headers: kv(d.headers), allow_insecure_tls: d.tls, tools_via_prompt: d.viaPrompt };
      if (parseInt(d.ctx, 10) > 0) body.context_window = parseInt(d.ctx, 10);
      try { await api('/api/providers', { method: 'POST', body }); m.close(); S.sel.providerId = id; await loadState(); render(); toast(T('Added {name}', { name: body.label })); } catch (e) { toast(e.message, true); }
    }
    const m = modal({ title: T('Custom endpoint'), wide: true, body: [
      el('div', { class: 'grid2' }, field(T('Name'), nameIn), field(T('Id'), idIn, T('Used in URLs and tool settings. Filled in from the name.'))),
      field(T('Endpoint URL'), urlIn, T('A server address, a base URL or a full request URL. Request paths such as /chat/completions are removed for you.')),
      el('div', { class: 'grid2' }, field(T('API format'), kindSel), field(T('API key'), keyIn)),
      el('div', {}, checkBtn), result, adv],
      footer: [el('button', { class: 'btn', onclick: () => m.close() }, T('Cancel')), el('button', { class: 'btn primary', onclick: save }, I('check', 'sm'), T('Save'))] });
    setTimeout(() => nameIn.focus(), 0);
  }
  function createFromPreset(pr) {
    let id = pr.id; let n = 2; while (providerOf(id)) id = `${pr.id}-${n++}`;
    const draft = { id, kind: pr.kind, label: pr.label, base_url: pr.base_url, default_model: pr.hint && !pr.hint.startsWith('(') ? pr.hint : '', extra_body: pr.extra_body || {}, api_key: '', email: '', password: '' };
    const body = [field(T('Id'), el('input', { class: 'input', value: draft.id, oninput: (e) => { draft.id = e.target.value.trim(); } })), field(T('Base URL'), el('input', { class: 'input', value: draft.base_url, oninput: (e) => { draft.base_url = e.target.value; } }))];
    if (pr.kind === 'agentserver') body.push(field(T('Login e-mail'), el('input', { class: 'input', oninput: (e) => { draft.email = e.target.value; } })), field(T('Password'), el('input', { class: 'input', type: 'password', oninput: (e) => { draft.password = e.target.value; } })));
    else body.push(field(T('API key'), el('input', { class: 'input', type: 'password', placeholder: pr.needs_key ? 'sk-…' : T('Not needed for local servers'), oninput: (e) => { draft.api_key = e.target.value; } })));
    body.push(field(T('Default model'), el('input', { class: 'input', value: draft.default_model, placeholder: pr.hint, oninput: (e) => { draft.default_model = e.target.value.trim(); } }), T('Leave it empty and press Find models after saving.')));
    const m = modal({ title: T('Add {name}', { name: pr.label }), body, footer: [el('button', { class: 'btn', onclick: () => m.close() }, T('Cancel')), el('button', { class: 'btn primary', onclick: async () => { try { const b = { ...draft }; if (b.default_model) b.models = [b.default_model]; if (!b.api_key) delete b.api_key; if (!b.password) delete b.password; await api('/api/providers', { method: 'POST', body: b }); m.close(); S.sel.providerId = b.id; await loadState(); render(); try { const r = await api(`/api/providers/${encodeURIComponent(b.id)}/models`, { method: 'POST' }); toast(T('{n} models found', { n: r.models.length })); await loadState(); render(); } catch (e) { toast(T('Saved. Finding models failed: {error}', { error: e.message.slice(0, 120) }), true); } } catch (e) { toast(e.message, true); } } }, T('Save'))] });
  }
  function pageDefault(content) {
    const d = S.st.default; const card = el('div', { class: 'card' });
    const sp = el('select', { class: 'select' }, el('option', { value: '' }, T('(none)')), ...S.st.providers.map((p) => el('option', { value: p.id, selected: p.id === d.provider }, p.label || p.id)));
    const sm = el('select', { class: 'select' });
    const fillModels = () => { sm.innerHTML = ''; const p = providerOf(sp.value); for (const m of [...new Set([p?.default_model, ...(p?.models || [])].filter(Boolean))]) sm.append(el('option', { value: m, selected: m === d.model }, shortModel(m))); };
    sp.addEventListener('change', fillModels); fillModels();
    const sa = el('select', { class: 'select' }, ...S.st.assistants.map((a) => el('option', { value: a.id, selected: a.id === d.assistant }, a.name)));
    card.append(el('h3', {}, T('Defaults for new chats')), el('div', { class: 'grid2' }, field(T('Provider'), sp), field(T('Model'), sm)), field(T('Assistant'), sa), el('div', {}, el('button', { class: 'btn primary', onclick: async () => { await api('/api/default', { method: 'POST', body: { provider: sp.value, model: sm.value, assistant: sa.value } }); toast(T('Saved')); await loadState(); render(); } }, T('Save'))));
    const pc = el('div', { class: 'card' }, el('h3', {}, T('Quick presets'), el('span', { class: 'chip' }, S.st.presets_configured ? T('custom') : T('derived from your providers'))), el('div', { class: 'muted tiny' }, T("Shown at the top of the model picker. Thinking \"default\" leaves the provider as it is; on, max and off map to each provider's own setting (budgets, reasoning effort, enable_thinking).")));
    // a pick whose provider does not list its model only failed when clicked: say so here (never auto-switched, that could land on a paid provider)
    for (const issue of S.st.selection_issues || []) pc.append(el('div', { class: 'tiny', style: 'background:var(--warning-soft);color:var(--warning);padding:6px 10px;border-radius:8px' }, issue));
    const rows = (S.st.model_presets || []).map((p) => ({ ...p }));
    const tbl = el('div', { style: 'display:grid;gap:8px;overflow-x:auto' });  // a row is wider than a phone: it scrolls inside the card
    const renderRows = () => { tbl.innerHTML = ''; rows.forEach((r, i) => { const prov = el('select', { class: 'select', onchange: (e) => { r.provider = e.target.value; } }, ...S.st.providers.map((p) => el('option', { value: p.id, selected: p.id === r.provider }, p.label || p.id))); tbl.append(el('div', { class: 'row', style: 'flex-wrap:nowrap' }, el('input', { class: 'input', style: 'width:80px', value: r.id, oninput: (e) => { r.id = e.target.value.trim(); } }), el('input', { class: 'input', style: 'width:110px', value: r.label, oninput: (e) => { r.label = e.target.value; } }), prov, el('input', { class: 'input', value: r.model, placeholder: T('Model id'), oninput: (e) => { r.model = e.target.value.trim(); } }), el('select', { class: 'select', style: 'width:150px', onchange: (e) => { r.thinking = e.target.value; } }, ...['', 'off', 'on', 'max'].map((v) => el('option', { value: v, selected: v === (r.thinking || '') }, T(THINK_LABEL[v])))), el('button', { class: 'btn quiet icon sm', onclick: () => { rows.splice(i, 1); renderRows(); } }, I('x', 'sm')))); }); };
    renderRows();
    pc.append(tbl, el('div', { class: 'row' }, el('button', { class: 'btn sm', onclick: () => { rows.push({ id: `p${rows.length + 1}`, label: T('Preset'), provider: S.st.providers[0]?.id || '', model: '', thinking: '' }); renderRows(); } }, I('plus', 'sm'), T('Add preset')), el('span', { class: 'spacer' }), el('button', { class: 'btn', onclick: async () => { await api('/api/presets', { method: 'PUT', body: [] }); toast(T('Back to presets derived from your providers')); await loadState(); render(); } }, T('Reset')), el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/presets', { method: 'PUT', body: rows }); toast(T('Presets saved')); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, T('Save presets'))));
    content.append(page('Defaults & presets', 'What new chats use, and the quick picks', card, pc));
  }
  function pageStyles(content) {
    const list = el('div', { class: 'listbox' });
    const styles = S.st.styles || []; const sel = S.sel.newStyle ? null : (styles.some((s) => s.id === S.sel.styleId) ? S.sel.styleId : styles[0]?.id);
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: () => { S.sel.newStyle = true; render(); } }, I('plus', 'sm'), T('New style'))));
    for (const s of styles) list.append(el('div', { class: 'lrow' + (s.id === sel ? ' active' : ''), onclick: () => { S.sel.newStyle = false; S.sel.styleId = s.id; render(); } }, el('div', { class: 'em', style: 'background:var(--bg-subtle);color:var(--fg)' }, I('wand', 'sm')), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, s.name), el('div', { class: 'sub truncate' }, s.prompt || T('No extra instructions')))));
    const s = sel ? styles.find((x) => x.id === sel) : { id: '', name: '', prompt: '' }; const d = { ...s };
    const card = el('div', { class: 'card' }, el('h3', {}, sel ? T('Edit {name}', { name: s.name }) : T('New style')), el('div', { class: 'grid2' }, field(T('Id'), el('input', { class: 'input', value: d.id, disabled: !!sel, oninput: (e) => { d.id = e.target.value.trim(); } })), field(T('Name'), el('input', { class: 'input', value: d.name, oninput: (e) => { d.name = e.target.value; } }))), field(T('Instructions'), el('textarea', { class: 'textarea', style: 'min-height:140px', value: d.prompt || '', placeholder: T('How should answers sound? Paste a sample of your own writing and say "write like this".'), oninput: (e) => { d.prompt = e.target.value; } }), T('Added to the system prompt as "Writing style: …". Instructions in the chat still take priority.')), el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/styles', { method: 'POST', body: d }); toast(T('Saved')); S.sel.newStyle = false; S.sel.styleId = d.id; await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), T('Save')), el('span', { class: 'spacer' }), sel && sel !== 'normal' ? el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(T('Delete the style {name}?', { name: s.name }))) { await api('/api/styles/' + sel, { method: 'DELETE' }); S.sel.styleId = ''; await loadState(); render(); } } }, I('trash', 'sm'), T('Delete')) : null));
    content.append(page('Writing styles', 'Tone presets you can switch per chat without changing the assistant', el('div', { class: 'split' }, list, card)));
  }
  function pagePrompts(content) {
    const list = el('div', { class: 'listbox' });
    const prompts = S.st.prompts || []; const sel = S.sel.newPrompt ? null : (prompts.some((p) => p.id === S.sel.promptId) ? S.sel.promptId : prompts[0]?.id);
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: () => { S.sel.newPrompt = true; render(); } }, I('plus', 'sm'), T('New prompt'))));
    for (const p of prompts) list.append(el('div', { class: 'lrow' + (p.id === sel ? ' active' : ''), onclick: () => { S.sel.newPrompt = false; S.sel.promptId = p.id; render(); } }, el('div', { class: 'em', style: 'background:var(--bg-subtle);color:var(--fg)' }, I('list', 'sm')), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, p.name), el('div', { class: 'sub truncate mono' }, '/' + p.id))));
    if (!prompts.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px' }, T('No prompts yet.')));
    const p = sel ? prompts.find((x) => x.id === sel) : { id: '', name: '', text: '' }; const d = { ...p };
    const preview = el('div', { class: 'muted tiny' });
    const showVars = () => { const names = [...new Set([...(d.text || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((x) => x[1]))]; preview.textContent = names.length ? T('Asked when inserted: {names}', { names: names.join(', ') }) : ''; };
    const card = el('div', { class: 'card' }, el('h3', {}, sel ? T('Edit {name}', { name: p.name }) : T('New prompt')),
      el('div', { class: 'grid2' }, field(T('Command'), el('input', { class: 'input', value: d.id, disabled: !!sel, placeholder: 'summary', oninput: (e) => { d.id = e.target.value.trim(); } }), T('Typed after / in the message box.')), field(T('Name'), el('input', { class: 'input', value: d.name, oninput: (e) => { d.name = e.target.value; } }))),
      field(T('Prompt'), el('textarea', { class: 'textarea', style: 'min-height:160px', value: d.text || '', placeholder: T('e.g. Summarize {{topic}} in {{count}} bullet points for a manager.'), oninput: (e) => { d.text = e.target.value; showVars(); } }), T('Words in {{double braces}} become blanks you fill in when the prompt is inserted.')), preview,
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { if (!d.id || !d.name) return toast(T('Enter a command and a name.'), true); try { await api('/api/prompts', { method: 'POST', body: d }); toast(T('Saved')); S.sel.newPrompt = false; S.sel.promptId = d.id; await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), T('Save')), el('span', { class: 'spacer' }), sel ? el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(T("Delete the prompt '{name}'?", { name: p.name }))) { await api('/api/prompts/' + encodeURIComponent(sel), { method: 'DELETE' }); S.sel.promptId = ''; await loadState(); render(); } } }, I('trash', 'sm'), T('Delete')) : null));
    showVars();
    content.append(page('Prompt library', 'Saved prompts you insert with / in any chat', el('div', { class: 'split' }, list, card)));
  }
  function pageMcp(content) {
    const list = el('div', { class: 'listbox' });
    const names = S.st.mcp.map((s) => s.name); const selName = names.includes(S.sel.mcpName) ? S.sel.mcpName : names[0];
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'flex:1', onclick: () => mcpModal() }, I('plus', 'sm'), T('Add server')), el('button', { class: 'btn sm', onclick: importModal, title: T('Import from other MCP clients') }, I('download', 'sm'))));
    for (const s of S.st.mcp) list.append(el('div', { class: 'lrow' + (s.name === selName ? ' active' : ''), onclick: () => { S.sel.mcpName = s.name; render(); } }, el('span', { class: 'dot ' + (s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'err' : s.status === 'connecting' ? 'warn' : '') }), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, s.name), el('div', { class: 'sub truncate' }, `${T(s.status)} · ${T('{n} tools', { n: s.tool_count })} · ${s.config.transport}`))));
    if (!S.st.mcp.length) list.append(el('div', { class: 'muted tiny', style: 'padding:14px' }, T('No MCP servers yet.')));
    const s = S.st.mcp.find((x) => x.name === selName);
    const detail = el('div');
    if (s) {
      const c = s.config; const card = el('div', { class: 'card' });
      card.append(el('h3', {}, s.name, el('span', { class: 'chip ' + (s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'err' : '') }, T(s.status)), el('span', { class: 'chip' }, T('{n} tools', { n: s.tool_count })), el('span', { class: 'chip' }, c.transport), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, T('Enabled')), switchEl(c.enabled !== false, async (v) => { await api('/api/mcp', { method: 'POST', body: { name: s.name, config: { ...c, enabled: v } } }); setTimeout(async () => { await loadState(); render(); }, 800); })));
      card.append(el('div', { class: 'mono muted', style: 'overflow-wrap:anywhere' }, c.transport === 'stdio' ? [c.command, ...(c.args || [])].join(' ') : c.url));
      if (s.error) card.append(el('div', { class: 'error-line' }, s.error.slice(0, 400)));
      const wj = (S.st.wake || []).find((j) => j.server === s.name);
      if (c.wake_command) card.append(el('div', { class: 'muted tiny mono', style: 'overflow-wrap:anywhere' }, T('Wake') + ': ' + c.wake_command));
      if (wj) card.append(wakeBar(wj), wakeActive(wj) ? el('div', {}, el('button', { class: 'btn sm', onclick: async () => { await api(`/api/wake/${encodeURIComponent(s.name)}/cancel`, { method: 'POST' }); pollWake(); } }, T('Cancel wake'))) : '');
      if (s.server_info?.name) card.append(el('div', { class: 'muted tiny' }, `${T('Server')}: ${s.server_info.name} ${s.server_info.version || ''}`));
      const tools = S.st.tools.filter((t) => t.server === s.name);
      if (tools.length) card.append(el('div', { class: 'sect' }, T('Tools')), el('div', { class: 'pill-list' }, tools.map((t) => el('span', { class: 'chip', title: t.description }, t.name, t.read_only ? ' · ' + T('read-only') : '', t.destructive ? ' · ' + T('destructive') : ''))));
      card.append(el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => mcpModal(s.name, c) }, I('edit', 'sm'), T('Edit')), el('button', { class: 'btn', title: c.wake_command ? T('Runs the wake command first in the background, then reconnects') : T('Reconnect this server'), onclick: () => wakeServer(s.name) }, I('refresh', 'sm'), c.wake_command ? T('Restart (wake)') : T('Restart')), el('span', { class: 'spacer' }), el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(T('Remove {name}?', { name: s.name }), T('Remove'))) { await api('/api/mcp/' + encodeURIComponent(s.name), { method: 'DELETE' }); S.sel.mcpName = ''; await loadState(); render(); } } }, I('trash', 'sm'), T('Remove'))));
      card.append(el('div', { class: 'muted tiny' }, ...rich(T('Use this studio from other MCP clients: add a stdio server with the command {cmd} and the argument {arg}. The standard JSON is at {url}.'), { cmd: el('code', {}, 'ms'), arg: el('code', {}, 'hub'), url: el('a', { href: '/api/mcp/export', target: '_blank' }, '/api/mcp/export') })));
      detail.append(card);
    } else detail.append(el('div', { class: 'card' }, el('h3', {}, T('Add your first MCP server')), el('p', { class: 'muted', style: 'margin:0' }, T('stdio commands (npx, uvx, python …), Streamable HTTP or SSE URLs. Or import the servers you already use in other MCP clients on this machine.')), el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => mcpModal() }, I('plus', 'sm'), T('Add server')), el('button', { class: 'btn', onclick: importModal }, I('download', 'sm'), T('Import')))));
    content.append(page('MCP servers', 'Tools from your machine and the network', el('div', { class: 'split' }, list, detail)));
  }
  const kv = (txt) => Object.fromEntries(txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  function mcpModal(name = '', c = { transport: 'stdio', enabled: true }) {
    const d = { name, transport: c.transport || 'stdio', command: c.command || '', args: (c.args || []).join('\n'), env: Object.entries(c.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'), cwd: c.cwd || '', url: c.url || '', headers: Object.entries(c.headers || {}).map(([k, v]) => `${k}=${v}`).join('\n'), enabled: c.enabled !== false, wake_command: c.wake_command || '', wake_cwd: c.wake_cwd || '', wake_timeout: c.wake_timeout || 2400 };
    const wake = el('div', { style: 'display:grid;gap:12px' }, el('div', { class: 'sect' }, T('Wake on Restart (optional)')), field(T('Wake command'), el('input', { class: 'input', value: d.wake_command, placeholder: 'python tools/wake_gpu.py', oninput: (e) => { d.wake_command = e.target.value; } }), T('Runs in the background when Restart is pressed, then the server reconnects. Lines like "##progress <pct> <eta_seconds> <stage>" move the progress bar; without them, the last run sets the estimate.')), el('div', { class: 'grid2' }, field(T('Wake working directory'), el('input', { class: 'input', value: d.wake_cwd, oninput: (e) => { d.wake_cwd = e.target.value; } })), field(T('Wake timeout (s)'), el('input', { class: 'input', type: 'number', value: d.wake_timeout, oninput: (e) => { d.wake_timeout = parseFloat(e.target.value) || 2400; } }))));
    const stdio = el('div', { style: 'display:grid;gap:12px' }, field(T('Command'), el('input', { class: 'input', value: d.command, placeholder: 'npx', oninput: (e) => { d.command = e.target.value; } })), field(T('Arguments (one per line)'), el('textarea', { class: 'textarea', value: d.args, placeholder: '-y\n@modelcontextprotocol/server-filesystem\n.', oninput: (e) => { d.args = e.target.value; } })), field(T('Environment (KEY=VALUE per line)'), el('textarea', { class: 'textarea', style: 'min-height:56px', value: d.env, oninput: (e) => { d.env = e.target.value; } })), field(T('Working directory'), el('input', { class: 'input', value: d.cwd, oninput: (e) => { d.cwd = e.target.value; } })));
    const http = el('div', { style: 'display:grid;gap:12px' }, field('URL', el('input', { class: 'input', value: d.url, placeholder: 'http://127.0.0.1:8000/mcp', oninput: (e) => { d.url = e.target.value; } })), field(T('Headers (KEY=VALUE per line)'), el('textarea', { class: 'textarea', style: 'min-height:56px', value: d.headers, oninput: (e) => { d.headers = e.target.value; } })));
    const tr = el('select', { class: 'select', onchange: (e) => { d.transport = e.target.value; stdio.classList.toggle('hidden', d.transport !== 'stdio'); http.classList.toggle('hidden', d.transport === 'stdio'); } }, el('option', { value: 'stdio', selected: d.transport === 'stdio' }, T('stdio (command)')), el('option', { value: 'http', selected: d.transport === 'http' }, 'Streamable HTTP'), el('option', { value: 'sse', selected: d.transport === 'sse' }, 'SSE'));
    stdio.classList.toggle('hidden', d.transport !== 'stdio'); http.classList.toggle('hidden', d.transport === 'stdio');
    const m = modal({ title: name ? T('Edit {name}', { name }) : T('Add an MCP server'), body: [el('div', { class: 'grid2' }, field(T('Name'), el('input', { class: 'input', value: d.name, placeholder: 'filesystem', oninput: (e) => { d.name = e.target.value.trim(); } })), field(T('Transport'), tr)), stdio, http, wake], footer: [el('button', { class: 'btn', onclick: () => m.close() }, T('Cancel')), el('button', { class: 'btn primary', onclick: async () => { if (!d.name) return toast(T('Enter a name.'), true); const cfg = { ...c, transport: d.transport, enabled: d.enabled, command: d.command, args: d.args.split('\n').map((s) => s.trim()).filter(Boolean), env: kv(d.env), cwd: d.cwd, url: d.url, headers: kv(d.headers), wake_command: d.wake_command.trim(), wake_cwd: d.wake_cwd.trim(), wake_timeout: d.wake_timeout }; try { await api('/api/mcp', { method: 'POST', body: { name: d.name, config: cfg } }); m.close(); S.sel.mcpName = d.name; toast(T('Saved · connecting')); await loadState(); render(); setTimeout(async () => { await loadState(); render(); }, 2500); setTimeout(async () => { await loadState(); render(); }, 7000); } catch (e) { toast(e.message, true); } } }, T('Save and connect'))] });
  }
  async function importModal() {
    const box = el('div', { style: 'display:grid;gap:8px' }, el('div', { class: 'muted' }, T('Looking for other MCP clients…')));
    const ta = el('textarea', { class: 'textarea', placeholder: '{"mcpServers": {"fs": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]}}}' });
    const m = modal({ title: T('Import MCP servers'), body: [box, el('details', {}, el('summary', { class: 'muted', style: 'cursor:pointer' }, T('Paste JSON (mcpServers or servers)')), ta, el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/mcp/import', { method: 'POST', body: { source: 'json', json_text: ta.value } }); toast(T('Imported {n}', { n: r.added.length })); m.close(); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, T('Import JSON'))))], wide: true });
    try { const src = await api('/api/mcp/import/sources'); box.innerHTML = ''; for (const s of src) box.append(el('div', { class: 'card', style: 'padding:12px 14px;gap:6px' }, el('div', { class: 'row' }, el('b', {}, s.source), el('span', { class: 'chip ' + (s.available ? 'ok' : '') }, s.available ? T('{n} servers', { n: s.servers.length }) : T('Not found')), el('span', { class: 'spacer' }), s.available ? el('button', { class: 'btn sm primary', onclick: async () => { const r = await api('/api/mcp/import', { method: 'POST', body: { source: s.source } }); toast(T('Imported {n}', { n: r.added.length })); m.close(); await loadState(); render(); } }, T('Import all')) : null), el('div', { class: 'muted tiny mono truncate' }, s.available ? s.servers.join(', ') : s.paths.join(' | ')))); } catch (e) { box.textContent = e.message; }
  }
  function pageTools(content) {
    const pol = S.st.policy; const bt = S.st.builtin_tools;
    const polCard = el('div', { class: 'card' });
    const selDef = el('select', { class: 'select' }, ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: v === pol.default }, T(v))));
    const selRO = el('select', { class: 'select' }, ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: v === pol.read_only_default }, T(v))));
    const ws = el('input', { class: 'input', value: bt.workspace || '', placeholder: bt.workspace_resolved });
    const sw = { shell: bt.shell, filesystem: bt.filesystem, web: bt.web };
    const wsc = { ...(bt.web_search || { provider: 'duckduckgo', api_key: '', api_key_env: '', url: '' }) };
    const wsProv = el('select', { class: 'select', onchange: (e) => { wsc.provider = e.target.value; } }, ...[['duckduckgo', 'DuckDuckGo · ' + T('no key')], ['tavily', 'Tavily · ' + T('API key')], ['brave', 'Brave Search · ' + T('API key')], ['serper', 'Serper (Google) · ' + T('API key')], ['searxng', 'SearXNG · ' + T('your own URL')]].map(([v, l]) => el('option', { value: v, selected: v === wsc.provider }, l)));
    const wsKey = el('input', { class: 'input', type: 'password', placeholder: wsc.has_key ? T('Saved · type to replace') : T('API key (Tavily, Brave, Serper)'), oninput: (e) => { wsc.api_key = e.target.value; } });
    const wsEnv = el('input', { class: 'input', value: wsc.api_key_env || '', placeholder: T('Or an environment variable, e.g. TAVILY_API_KEY'), oninput: (e) => { wsc.api_key_env = e.target.value.trim(); } });
    const wsUrl = el('input', { class: 'input', value: wsc.url || '', placeholder: T('https://searx.example.com (SearXNG only)'), oninput: (e) => { wsc.url = e.target.value.trim(); } });
    const tc = { ...(S.st.tool_catalog || { mode: 'auto', threshold: 24, always: [] }) };
    const tcMode = el('select', { class: 'select' }, ...[['auto', T('Auto · above the threshold')], ['on', T('Always')], ['off', T('Off · send every schema')]].map(([v, l]) => el('option', { value: v, selected: v === tc.mode }, l)));
    const tcThr = el('input', { class: 'input', type: 'number', min: 1, max: 500, value: tc.threshold || 24 });
    const tcAlways = el('input', { class: 'input', value: (tc.always || []).join(', '), placeholder: T('e.g. local__now, my-server__status, fs__*') });
    polCard.append(el('h3', {}, T('Defaults')), el('div', { class: 'grid2' }, field(T('Tools that write or run things'), selDef, T('Ask: pause and show an approval card.')), field(T('Read-only tools'), selRO)), el('div', { class: 'sect' }, T('Local tools')), field(T('Workspace folder'), ws, T('Local file and shell tools cannot leave this folder.')), el('div', { class: 'row' }, ...Object.keys(sw).map((k) => el('span', { class: 'row' }, switchEl(sw[k], (v) => { sw[k] = v; }), T({ shell: 'Shell', filesystem: 'Files', web: 'Web fetch and search' }[k] || k)))),
      el('div', { class: 'sect' }, T('Web search')), el('div', { class: 'muted tiny' }, T('The web_search tool and Research mode use one search API. DuckDuckGo works without a key; the others are faster and cleaner.')), el('div', { class: 'grid2' }, field(T('Provider'), wsProv), field(T('API key'), wsKey)), el('div', { class: 'grid2' }, field(T('Key from an environment variable'), wsEnv), field('SearXNG URL', wsUrl)),
      el('div', { class: 'sect' }, T('Tool catalog')), el('div', { class: 'muted tiny' }, T('With many tools connected ({n} now), the model gets a one-line catalog instead of every schema and loads the tools it needs with load_tools. This keeps small-context models usable; loaded tools stay loaded for the conversation.', { n: S.st.tools.length })), el('div', { class: 'grid2' }, field(T('Mode'), tcMode, T('Auto: use the catalog when there are more tools than the threshold.')), field(T('Threshold (tools)'), tcThr)), field(T('Always defined'), tcAlways, T('Comma-separated tool names, server names or server__* patterns that skip the catalog.')),
      el('div', {}, el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/policy', { method: 'PUT', body: { ...pol, default: selDef.value, read_only_default: selRO.value } }); const body = { ...sw, workspace: ws.value.trim(), web_search: { provider: wsc.provider, api_key: wsc.api_key || (wsc.has_key ? '…' : ''), api_key_env: wsc.api_key_env || '', url: wsc.url || '' } }; await api('/api/builtin-tools', { method: 'PUT', body }); await api('/api/tool-catalog', { method: 'PUT', body: { mode: tcMode.value, threshold: parseInt(tcThr.value, 10) || 24, always: tcAlways.value } }); toast(T('Saved')); await loadState(); render(); } catch (e) { toast(e.message, true); } } }, T('Save'))));
    const tb = el('tbody');
    for (const t of S.st.tools) {
      const sel = el('select', { class: 'select', onchange: async (e) => { const rules = { ...pol.rules }; if (e.target.value) rules[t.full_name] = e.target.value; else delete rules[t.full_name]; await api('/api/policy', { method: 'PUT', body: { ...pol, rules } }); pol.rules = rules; toast(T('Rule saved')); } }, el('option', { value: '' }, T('default')), ...['allow', 'ask', 'block'].map((v) => el('option', { value: v, selected: pol.rules[t.full_name] === v }, T(v))));
      tb.append(el('tr', {}, el('td', { class: 'mono' }, t.full_name), el('td', {}, t.server), el('td', {}, t.read_only ? el('span', { class: 'chip ok' }, T('read-only')) : null, ' ', t.destructive ? el('span', { class: 'chip warn' }, T('destructive')) : null), el('td', {}, sel), el('td', { class: 'muted' }, (t.description || '').slice(0, 140))));
    }
    content.append(page('Tools & policy', 'What the agent may run, and when to ask you', polCard, el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, T('Tool')), el('th', {}, T('Server')), el('th', {}, T('Flags')), el('th', {}, T('Rule')), el('th', {}, T('Description')))), tb))));
  }
  function pageAssistants(content) {
    const list = el('div', { class: 'listbox' });
    const ids = S.st.assistants.map((a) => a.id);
    const sel = S.sel.newAssistant ? null : (ids.includes(S.sel.assistantId) ? S.sel.assistantId : ids[0]);
    list.append(el('div', { class: 'lhead' }, el('button', { class: 'btn primary sm', style: 'width:100%', onclick: () => { S.sel.newAssistant = true; render(); } }, I('plus', 'sm'), T('New assistant'))));
    for (const a of S.st.assistants) list.append(el('div', { class: 'lrow' + (a.id === sel ? ' active' : ''), onclick: () => { S.sel.newAssistant = false; S.sel.assistantId = a.id; render(); } }, el('div', { class: 'em', style: 'background:transparent' }, assistantGlyph(a)), el('div', { style: 'min-width:0;flex:1' }, el('div', { class: 'ttl truncate' }, a.name), el('div', { class: 'sub truncate' }, a.model ? `${a.provider || T('default')} / ${shortModel(a.model)}` : T('Default model'))), S.st.default.assistant === a.id ? el('span', { class: 'chip primary' }, T('default')) : null));
    const a = sel ? assistantOf(sel) : { id: '', name: '', emoji: '🤖', system_prompt: '', provider: '', model: '', tools: 'all', max_iterations: 25, temperature: null, max_tokens: null };
    const d = { ...a, tools: Array.isArray(a.tools) ? a.tools.join(', ') : a.tools };
    const card = el('div', { class: 'card' },
      el('h3', {}, sel ? T('Edit {name}', { name: a.name }) : T('New assistant')),
      el('div', { class: 'grid2' }, field(T('Emoji'), el('input', { class: 'input', value: d.emoji || '', oninput: (e) => { d.emoji = e.target.value; } })), field(T('Id'), el('input', { class: 'input', value: d.id, disabled: !!sel, placeholder: 'writer', oninput: (e) => { d.id = e.target.value.trim(); } }))),
      field(T('Name'), el('input', { class: 'input', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
      field(T('System prompt'), el('textarea', { class: 'textarea', style: 'min-height:160px', value: d.system_prompt || '', oninput: (e) => { d.system_prompt = e.target.value; } })),
      el('div', { class: 'grid2' }, field(T('Provider (optional)'), el('select', { class: 'select', onchange: (e) => { d.provider = e.target.value; } }, el('option', { value: '' }, T('(default)')), ...S.st.providers.map((p) => el('option', { value: p.id, selected: p.id === d.provider }, p.label || p.id)))), field(T('Model (optional)'), el('input', { class: 'input', value: d.model || '', oninput: (e) => { d.model = e.target.value.trim(); } }))),
      el('div', { class: 'grid2' }, field(T('Tools'), el('input', { class: 'input', value: d.tools, placeholder: 'all · none · local__*, filesystem__read_file', oninput: (e) => { d.tools = e.target.value; } })), field(T('Max tool iterations'), el('input', { class: 'input', type: 'number', value: d.max_iterations || 25, oninput: (e) => { d.max_iterations = parseInt(e.target.value || '25', 10); } }))),
      el('div', { class: 'grid2' }, field(T('Temperature'), el('input', { class: 'input', type: 'number', min: 0, max: 2, step: 0.1, value: d.temperature ?? '', placeholder: T('Provider default'), oninput: (e) => { d.temperature = e.target.value; } }), T('Lower is steadier, higher is more varied. Empty uses the provider default.')), field(T('Max output tokens'), el('input', { class: 'input', type: 'number', min: 1, value: d.max_tokens ?? '', placeholder: T('Provider default'), oninput: (e) => { d.max_tokens = e.target.value; } }), T('The longest answer per request. Empty uses the provider default.'))),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { const tv = (d.tools || '').trim(); const tools = !tv || tv === 'all' ? 'all' : tv === 'none' ? 'none' : tv.split(',').map((s) => s.trim()).filter(Boolean); try { await api('/api/assistants', { method: 'POST', body: { id: d.id, name: d.name, emoji: d.emoji, system_prompt: d.system_prompt, provider: d.provider, model: d.model, tools, max_iterations: d.max_iterations, temperature: d.temperature === '' || d.temperature == null ? null : parseFloat(d.temperature), max_tokens: d.max_tokens === '' || d.max_tokens == null ? null : parseInt(d.max_tokens, 10) } }); toast(T('Saved')); S.sel.newAssistant = false; S.sel.assistantId = d.id; await loadState(); render(); } catch (e) { toast(e.message, true); } } }, I('check', 'sm'), T('Save')), sel ? el('button', { class: 'btn', onclick: async () => { await api('/api/default', { method: 'POST', body: { assistant: a.id } }); await loadState(); render(); } }, T('Use as default')) : null, el('span', { class: 'spacer' }), sel && a.id !== 'default' ? el('button', { class: 'btn danger', onclick: async () => { if (await confirmDialog(T('Delete the assistant {name}?', { name: a.name }))) { await api('/api/assistants/' + a.id, { method: 'DELETE' }); S.sel.assistantId = ''; await loadState(); render(); } } }, I('trash', 'sm'), T('Delete')) : null));
    content.append(page('Assistants', 'System prompt, preferred model and tool set', el('div', { class: 'split' }, list, card)));
  }
  function pageAgents(content) {
    const xs = S.st.providers.filter((p) => p.kind === 'agentserver');
    const card = el('div', { class: 'card' });
    if (!xs.length) card.append(el('h3', {}, T('No agent server set up')), el('p', { class: 'muted', style: 'margin:0' }, T('Add a provider with the "Agent server" preset (server URL, e-mail and password). Its agents then appear here and as models in chat.')), el('div', {}, el('button', { class: 'btn primary', onclick: () => { S.settingsPage = 'providers'; render(); addProviderModal(); } }, T('Add provider'))));
    else {
      const sel = el('select', { class: 'select' }, ...xs.map((p) => el('option', { value: p.id, selected: p.id === S.sel.agentProvider }, `${p.label || p.id} (${p.base_url})`)));
      const trust = { v: false };
      const agentsBox = el('div', { class: 'pill-list' });
      const bridgeBox = el('div');
      const renderBridges = () => { bridgeBox.innerHTML = ''; for (const b of S.st.bridges) bridgeBox.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (b.status === 'connected' ? 'ok' : b.status === 'connecting' ? 'warn' : 'err') }), el('b', {}, b.provider_id), el('span', { class: 'chip' }, T(b.status)), el('span', { class: 'chip' }, T('{n} tools', { n: b.tool_count })), el('span', { class: 'chip' }, T('{n} calls', { n: b.calls })), el('span', { class: 'muted tiny' }, b.device_name), b.error ? el('span', { class: 'muted tiny', style: 'color:var(--destructive)' }, b.error.slice(0, 120)) : null)); if (!S.st.bridges.length) bridgeBox.append(el('div', { class: 'muted tiny' }, T("The bridge is not running. Start it to let the server's agents call your local tools and MCP servers, under your policy."))); };
      renderBridges();
      card.append(el('h3', {}, T('Agent server')), field(T('Server'), sel), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { agentsBox.innerHTML = ''; agentsBox.textContent = T('Loading…'); try { const ag = await api(`/api/agents/${encodeURIComponent(sel.value)}`); agentsBox.innerHTML = ''; for (const a of ag) agentsBox.append(el('span', { class: 'chip', style: 'cursor:pointer', title: T('Chat with this agent'), onclick: async () => { const p = providerOf(sel.value); const model = `${a.id}|${a.name}`; await api('/api/providers', { method: 'POST', body: { id: p.id, default_model: model, models: [...new Set([model, ...(p.models || [])])] } }); await loadState(); const pane = activePane(); pane.sel.provider = p.id; pane.sel.model = model; pane.convId = null; pane.conv = null; pane.messages = []; S.view = 'chat'; render(); } }, a.name)); if (!ag.length) agentsBox.textContent = T('No agents'); } catch (e) { agentsBox.textContent = e.message; } } }, I('refresh', 'sm'), T('List agents'))), agentsBox, el('div', { class: 'sect' }, T('Device bridge')), bridgeBox, el('div', { class: 'row' }, switchEl(false, (v) => { trust.v = v; }), el('span', { class: 'muted tiny' }, T('Trust: run "ask" tools without approval')), el('span', { class: 'spacer' }), el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/bridge/start', { method: 'POST', body: { provider_id: sel.value, trust: trust.v } }); toast(T('Starting the bridge')); setTimeout(async () => { await loadState(); render(); }, 2500); } catch (e) { toast(e.message, true); } } }, I('link', 'sm'), T('Start bridge')), el('button', { class: 'btn', onclick: async () => { await api('/api/bridge/stop', { method: 'POST', body: { provider_id: sel.value } }); await loadState(); render(); } }, T('Stop'))));
    }
    content.append(page('Agent servers', 'Chat with hosted agents, or lend this machine to them', card));
  }
  // ---- audit log: every tool call, paged and filtered on the server (search, decision, failures), CSV export
  const AUDIT_DECISIONS = [['', 'All decisions'], ['allow', 'Allowed'], ['deny', 'Denied'], ['block', 'Blocked'], ['schema', 'Not run: arguments did not fit'], ['cancelled', 'Cancelled']];
  const prettyArgs = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s || ''; } };
  async function pageAudit(content) {
    const f = S.sel.audit = S.sel.audit || { q: '', decision: '', errors: false, offset: 0, limit: 50 };
    const tb = el('tbody'); const summary = el('span', { class: 'muted tiny' }); const nav = el('span', { class: 'row', style: 'gap:6px' });
    const qs = () => `q=${encodeURIComponent(f.q)}&decision=${encodeURIComponent(f.decision)}&errors=${f.errors ? 1 : 0}`;
    let timer = null;
    const search = el('input', { class: 'input', style: 'max-width:300px', placeholder: T('Search tools, arguments or results'), value: f.q, oninput: (e) => { f.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => { f.offset = 0; load(); }, 300); } });
    const dec = el('select', { class: 'select', style: 'width:auto', onchange: (e) => { f.decision = e.target.value; f.offset = 0; load(); } }, ...AUDIT_DECISIONS.map(([v, l]) => el('option', { value: v, selected: v === f.decision }, T(l))));
    const errs = el('label', { class: 'row tiny', style: 'gap:6px;cursor:pointer;white-space:nowrap' }, el('input', { type: 'checkbox', checked: f.errors || undefined, onchange: (e) => { f.errors = e.target.checked; f.offset = 0; load(); } }), T('Failed calls only'));
    const size = el('select', { class: 'select', style: 'width:auto', onchange: (e) => { f.limit = parseInt(e.target.value, 10); f.offset = 0; load(); } }, ...[25, 50, 100, 200].map((n) => el('option', { value: n, selected: n === f.limit }, T('{n} per page', { n }))));
    const exportBtn = el('a', { class: 'btn', download: '', title: T('Download the matching rows as CSV') }, I('download', 'sm'), T('Export CSV'));
    content.append(page('Audit log', 'Every tool call, decision and result',
      el('div', { class: 'row', style: 'flex-wrap:wrap' }, search, dec, errs, el('span', { class: 'spacer' }), exportBtn, el('button', { class: 'btn', onclick: () => load() }, I('refresh', 'sm'), T('Refresh'))),
      el('div', { class: 'table-wrap' }, el('table', { class: 'table audit' }, el('thead', {}, el('tr', {}, ...['Time', 'Tool', 'Decision', 'Took', 'Arguments', 'Result'].map((h) => el('th', {}, T(h))))), tb)),
      el('div', { class: 'row', style: 'flex-wrap:wrap' }, summary, el('span', { class: 'spacer' }), size, nav)));
    async function load() {
      let r; try { r = await api(`/api/audit/page?limit=${f.limit}&offset=${f.offset}&${qs()}`); } catch (e) { toast(e.message, true); return; }
      exportBtn.href = '/api/audit/export?' + qs() + (token ? '&token=' + encodeURIComponent(token) : '');
      tb.innerHTML = '';
      for (const row of r.items) {
        const tr = el('tr', { class: 'arow', title: T('Click to see the full arguments and result') },
          el('td', { class: 'muted tiny', style: 'white-space:nowrap' }, new Date(row.ts * 1000).toLocaleString(LOC())), el('td', { class: 'mono', style: 'white-space:nowrap' }, row.tool),
          el('td', {}, el('span', { class: 'chip ' + (row.is_error ? 'err' : row.decision === 'allow' || row.decision === 'human' ? 'ok' : 'warn') }, T(row.decision) + (row.is_error ? ' · ' + T('error') : ''))),
          el('td', { style: 'white-space:nowrap' }, fmtMs(row.duration_ms)), el('td', { class: 'mono' }, (row.arguments || '').slice(0, 140)), el('td', { class: 'mono' }, (row.result_excerpt || '').slice(0, 140)));
        tr.addEventListener('click', () => {
          const open = tr.nextElementSibling?.classList.contains('adetail');
          tb.querySelectorAll('.adetail').forEach((x) => x.remove());
          if (open) return;
          const chat = row.conversation_id ? el('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); openConv(activePane(), row.conversation_id).catch((err) => toast(err.message, true)); } }, I('chat', 'sm'), T('Open the chat')) : null;
          tr.after(el('tr', { class: 'adetail' }, el('td', { colspan: 6 }, el('div', { class: 'adgrid' }, el('div', {}, el('div', { class: 'lbl' }, T('Arguments')), el('pre', {}, prettyArgs(row.arguments))), el('div', {}, el('div', { class: 'lbl' }, T('Result')), linkedPre(row.result_excerpt || ''))), chat ? el('div', { class: 'row', style: 'margin-top:8px' }, chat) : null)));
        });
        tb.append(tr);
      }
      if (!r.items.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, f.q || f.decision || f.errors ? T('No calls match these filters.') : T('Nothing yet.'))));
      const pages = Math.max(1, Math.ceil(r.total / f.limit)); const cur = Math.floor(f.offset / f.limit) + 1;
      summary.textContent = r.total ? T('{from}–{to} of {total}', { from: f.offset + 1, to: Math.min(f.offset + f.limit, r.total), total: r.total }) : '';
      nav.innerHTML = '';
      const go = (o) => { f.offset = Math.max(0, o); load(); };
      nav.append(el('button', { class: 'btn sm', disabled: cur <= 1 || undefined, title: T('First page'), onclick: () => go(0) }, '«'), el('button', { class: 'btn sm', disabled: cur <= 1 || undefined, onclick: () => go(f.offset - f.limit) }, T('Previous')),
        el('span', { class: 'muted tiny' }, T('Page {cur} / {pages}', { cur, pages })),
        el('button', { class: 'btn sm', disabled: cur >= pages || undefined, onclick: () => go(f.offset + f.limit) }, T('Next')), el('button', { class: 'btn sm', disabled: cur >= pages || undefined, title: T('Last page'), onclick: () => go((pages - 1) * f.limit) }, '»'));
    }
    await load();
  }
  // ---- memory: facts the assistant keeps across chats (it saves them with memory_save; you can add, edit, delete)
  async function pageMemory(content) {
    const mem = S.st.memory || { enabled: true, recall_k: 5 };
    const on = switchEl(mem.enabled, async (v) => { try { await api('/api/memory-settings', { method: 'PUT', body: { enabled: v, recall_k: mem.recall_k } }); await loadState(); toast(v ? T('Memory on') : T('Memory off')); } catch (e) { toast(e.message, true); } });
    const k = el('input', { class: 'input', type: 'number', value: mem.recall_k, style: 'width:90px', onchange: async (e) => { try { await api('/api/memory-settings', { method: 'PUT', body: { enabled: mem.enabled, recall_k: parseInt(e.target.value || '5', 10) } }); await loadState(); toast(T('Saved')); } catch (err) { toast(err.message, true); } } });
    const add = el('textarea', { class: 'textarea', style: 'min-height:70px', placeholder: T('Something to remember, e.g. "I write in Korean; keep answers short."') });
    const listBox = el('div', { style: 'display:grid;gap:8px' });
    const refresh = async () => { const r = await api('/api/memory'); listBox.innerHTML = ''; if (!r.items.length) listBox.append(el('div', { class: 'muted tiny' }, T('Nothing remembered yet. The assistant saves facts with the memory_save tool when you ask it to remember something, or you can add one here.'))); for (const m of r.items) { const ta = el('textarea', { class: 'textarea', style: 'min-height:44px', value: m.text }); listBox.append(el('div', { class: 'card', style: 'padding:10px 12px;gap:6px' }, ta, el('div', { class: 'row' }, el('span', { class: 'muted tiny' }, `${new Date(m.updated_at * 1000).toLocaleString(LOC())}${m.source ? ' · ' + m.source : ''}`), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async () => { try { await api('/api/memory/' + m.id, { method: 'PUT', body: { text: ta.value } }); toast(T('Saved')); } catch (e) { toast(e.message, true); } } }, T('Save')), el('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog(T('Forget this memory?'), T('Forget'))) { await api('/api/memory/' + m.id, { method: 'DELETE' }); refresh(); } } }, T('Forget'))))); } };
    content.append(page('Memory', 'What the assistant remembers about you across chats',
      el('div', { class: 'card' }, el('h3', {}, T('Recall'), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, T('Enabled')), on), el('div', { class: 'muted tiny' }, T('Before each answer, the best-matching memories go into the system prompt. The assistant can also search them (memory_search) and add new ones (memory_save).')), field(T('Memories recalled per message'), k)),
      el('div', { class: 'card' }, el('h3', {}, T('Add a memory')), add, el('div', {}, el('button', { class: 'btn primary', onclick: async () => { const t = add.value.trim(); if (!t) return; try { await api('/api/memory', { method: 'POST', body: { text: t } }); add.value = ''; refresh(); toast(T('Remembered')); } catch (e) { toast(e.message, true); } } }, I('plus', 'sm'), T('Remember')))),
      el('div', { class: 'card' }, el('h3', {}, T('Memories')), listBox)));
    try { await refresh(); } catch (e) { toast(e.message, true); }
  }
  // ---- knowledge base: folders and files indexed for retrieval (keyword search always, embeddings optional)
  async function pageKnowledge(content) {
    const kc = S.st.knowledge || {};
    const pathIn = el('input', { class: 'input', placeholder: T('A folder or file to index, e.g. D:\\notes or /home/me/docs') });
    const srcBox = el('div', { style: 'display:grid;gap:6px' });
    const statusBox = el('div', { class: 'muted tiny' });
    const prov = el('select', { class: 'select', onchange: () => fillModels() }, el('option', { value: '' }, T('(keyword search only)')), ...S.st.providers.filter((p) => p.kind === 'openai').map((p) => el('option', { value: p.id, selected: p.id === kc.embeddings_provider }, p.label || p.id)));
    const modelIn = el('input', { class: 'input', value: kc.embeddings_model || '', placeholder: 'text-embedding-v4 · text-embedding-3-small · …', list: 'embModels' });
    const dl = el('datalist', { id: 'embModels' }, ...['text-embedding-v4', 'text-embedding-v3', 'text-embedding-3-small', 'text-embedding-3-large', 'bge-m3', 'nomic-embed-text'].map((m) => el('option', { value: m })));
    const fillModels = () => { if (!modelIn.value) modelIn.value = prov.value.includes('dashscope') ? 'text-embedding-v4' : prov.value.includes('openai') ? 'text-embedding-3-small' : ''; };
    const chunk = el('input', { class: 'input', type: 'number', value: kc.chunk_chars || 900, style: 'width:110px' });
    const topk = el('input', { class: 'input', type: 'number', value: kc.top_k || 6, style: 'width:90px' });
    const q = el('input', { class: 'input', placeholder: T('Try a search…'), onkeydown: async (e) => { if (e.key === 'Enter' && q.value.trim()) { const r = await api('/api/knowledge/search?q=' + encodeURIComponent(q.value.trim())); hits.innerHTML = ''; if (!r.hits.length) hits.append(el('div', { class: 'muted tiny' }, T('No matches'))); for (const h of r.hits) hits.append(el('div', { class: 'card', style: 'padding:10px 12px;gap:4px' }, el('div', { class: 'mono tiny truncate' }, `${h.path} · ${T('chunk {n}', { n: h.idx })} · ${h.score}`), el('div', { style: 'white-space:pre-wrap;font-size:12.5px' }, h.text.slice(0, 600)))); } } });
    const hits = el('div', { style: 'display:grid;gap:6px' });
    const refresh = async () => { const st = await api('/api/knowledge'); srcBox.innerHTML = ''; for (const s of st.sources || []) srcBox.append(el('div', { class: 'row', style: 'font-size:12.5px' }, I('box', 'sm'), el('span', { class: 'mono truncate', style: 'flex:1' }, s.path), el('span', { class: 'chip' }, T('{n} files', { n: s.files })), el('span', { class: 'chip' }, T('{n} chunks', { n: s.chunks })), s.error ? el('span', { class: 'chip err' }, s.error.slice(0, 60)) : null, el('button', { class: 'btn quiet icon sm', title: T('Remove from the index'), onclick: async () => { if (await confirmDialog(T('Remove {path} from the knowledge base?', { path: s.path }), T('Remove'))) { await api('/api/knowledge/sources/' + s.id, { method: 'DELETE' }); refresh(); } } }, I('trash', 'xs')))); if (!(st.sources || []).length) srcBox.append(el('div', { class: 'muted tiny' }, T('No sources yet. Add a folder of notes, docs or code.'))); statusBox.textContent = [T('{n} chunks', { n: st.chunks }), T('{n} with embeddings', { n: st.vectors }), st.indexing ? T('Indexing…') : T('Idle'), st.last && st.last.seconds != null ? T('last run {n}s', { n: st.last.seconds }) + (st.last.embed_error ? ' · ' + T('embeddings: {error}', { error: st.last.embed_error }) : '') : ''].filter(Boolean).join(' · '); if (st.indexing) setTimeout(refresh, 2000); };
    content.append(page('Knowledge base', 'Your folders and files, searchable by the assistant and added to answers when they help',
      el('div', { class: 'card' }, el('h3', {}, T('Sources')), srcBox, el('div', { class: 'row' }, pathIn, el('button', { class: 'btn primary', onclick: async () => { const p = pathIn.value.trim(); if (!p) return; try { await api('/api/knowledge/sources', { method: 'POST', body: { path: p } }); pathIn.value = ''; toast(T('Added · indexing')); setTimeout(refresh, 800); } catch (e) { toast(e.message, true); } } }, I('plus', 'sm'), T('Add')), el('button', { class: 'btn', onclick: async () => { await api('/api/knowledge/reindex', { method: 'POST' }); toast(T('Reindexing')); setTimeout(refresh, 800); } }, I('refresh', 'sm'), T('Reindex'))), statusBox, el('div', { class: 'muted tiny' }, T('Files are split into chunks and indexed for substring search in any language. Changed files are read again on reindex. Once something is indexed, the best excerpts go into context for every message; /knowledge in the composer adds more of them, and the assistant can also call knowledge_search.')), el('div', { class: 'row', style: 'margin-top:8px' }, switchEl(kc.auto !== false, async (v) => { try { await api('/api/knowledge/settings', { method: 'PUT', body: { embeddings_provider: kc.embeddings_provider || '', embeddings_model: kc.embeddings_model || '', chunk_chars: kc.chunk_chars || 900, top_k: kc.top_k || 6, auto: v } }); toast(v ? T('Automatic retrieval on') : T('Automatic retrieval off')); await loadState(); } catch (e) { toast(e.message, true); } }), T('Automatic retrieval for every message'))),
      el('div', { class: 'card' }, el('h3', {}, T('Embeddings (optional)')), el('div', { class: 'muted tiny' }, T('Semantic search on top of keyword search, through any OpenAI-compatible /embeddings endpoint (DashScope text-embedding-v4, OpenAI text-embedding-3-small, a local vLLM). Vectors are computed on reindex.')), el('div', { class: 'grid2' }, field(T('Provider'), prov), field(T('Model'), el('div', {}, modelIn, dl))), el('div', { class: 'grid2' }, field(T('Chunk size (characters)'), chunk), field(T('Excerpts per message'), topk)), el('div', {}, el('button', { class: 'btn primary', onclick: async () => { try { await api('/api/knowledge/settings', { method: 'PUT', body: { embeddings_provider: prov.value, embeddings_model: modelIn.value.trim(), chunk_chars: parseInt(chunk.value || '900', 10), top_k: parseInt(topk.value || '6', 10), auto: kc.auto !== false } }); toast(T('Saved · reindex to compute embeddings')); await loadState(); } catch (e) { toast(e.message, true); } } }, T('Save')))),
      el('div', { class: 'card' }, el('h3', {}, T('Test a search')), q, hits)));
    try { await refresh(); } catch (e) { toast(e.message, true); }
  }
  function pageGeneral(content) {
    const st = S.st;
    content.append(page('General', 'This studio', el('div', { class: 'card' }, el('h3', {}, T('Server')), el('div', { class: 'grid2' }, field(T('Version'), el('div', {}, 'missile-studio ' + st.version)), field(T('Bound to'), el('div', {}, `${st.server.host}:${st.server.port} · ` + (st.server.auth_required ? T('token required') : T('this machine only, no token')))), field(T('Config file'), el('code', {}, st.config_path)), field(T('Data folder'), el('code', {}, st.home))), el('div', { class: 'muted tiny' }, ...rich(T('Change the host, port or token with {serve} or {token}. The admin console at {admin} manages tokens, logs, retention and system status.'), { serve: el('code', {}, 'ms serve --host 0.0.0.0 --port 7700 --token …'), token: el('code', {}, 'ms config set-token …'), admin: el('a', { href: '/admin', target: '_blank' }, '/admin') }))),
      st.server.auth_required ? (() => { const who = el('div', { class: 'muted tiny' }, S.health?.via === 'cookie' ? T('Signed in with an account.') : T('Signed in with an access token kept in this browser.')); api('/api/admin/auth/me').then((me) => { who.textContent = T('Signed in as {user} · {role}', { user: me.username, role: T(me.role) }) + ' · ' + (me.role === 'admin' ? T('the same session opens /admin') : T('chat only; settings belong to the admin')); }).catch(() => {}); return el('div', { class: 'card' }, el('h3', {}, T('Session')), who, el('div', {}, el('button', { class: 'btn', onclick: signOut }, I('x', 'sm'), T('Sign out')))); })() : null,
      el('div', { class: 'card' }, el('h3', {}, T('Language')), el('div', { class: 'row' }, ...['en', 'ko'].map((l) => el('button', { class: 'btn' + (i18n.lang === l ? ' primary' : ''), onclick: () => setLang(l) }, LANG_NAME[l]))), el('div', { class: 'muted tiny' }, T('Kept in this browser. The rail button at the bottom left switches it too.'))),
      el('div', { class: 'card' }, el('h3', {}, T('Appearance')), el('div', { class: 'row' }, el('button', { class: 'btn' + (theme.get() === 'dark' ? ' primary' : ''), onclick: () => theme.set('dark') }, I('moon', 'sm'), T('Dark')), el('button', { class: 'btn' + (theme.get() === 'warm' ? ' primary' : ''), onclick: () => theme.set('warm') }, I('sparkles', 'sm'), T('Warm')), el('button', { class: 'btn' + (theme.get() === 'light' ? ' primary' : ''), onclick: () => theme.set('light') }, I('sun', 'sm'), T('Light'))), el('div', { class: 'muted tiny' }, T('Dark is the default. Warm has cream paper, terracotta accents and serif headings.')),
        el('div', { class: 'sect' }, T('Chat text')), el('div', { class: 'row' }, ...[['s', 'Small'], ['m', 'Default'], ['l', 'Large']].map(([v, l]) => el('button', { class: 'btn sm' + ((view.get('text') || 'm') === v ? ' primary' : ''), onclick: () => view.set('text', v === 'm' ? '' : v) }, T(l))), el('span', { class: 'spacer' }), el('span', { class: 'row tiny' }, switchEl(view.get('wide') === '1', (v) => view.set('wide', v ? '1' : '')), T('Wide chat column')))),
      el('div', { class: 'card' }, el('h3', {}, T('Notifications')), el('div', { class: 'row' }, switchEl(notifyOn(), (v) => setNotify(v)), T('Notify me when an answer finishes while this tab is in the background')), el('div', { class: 'muted tiny' }, T('The tab title gets a ● either way. Kept in this browser.'))),
      el('div', { class: 'card' }, el('h3', {}, T('Keyboard')), el('div', {}, el('button', { class: 'btn', onclick: openShortcuts }, I('info', 'sm'), T('Show all shortcuts') + ' (Ctrl/⌘ /)'))),
      el('div', { class: 'card' }, el('h3', {}, T('Use this studio elsewhere')), el('div', { class: 'md', html: md(T('- **Terminal / SSH**: `ms chat`, `ms ask "…" --json`\n- **As one MCP server** for other MCP clients: `ms hub` (stdio) or `ms hub --http --port 7701`\n- **Lend tools to an agent server**: `ms bridge --provider <id>`\n- **API**: `Authorization: Bearer <token>`, docs at [/api/docs](/api/docs)')) }))));
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { const h = await fetch('/api/health', { headers: headers() }).then((r) => r.json()); S.health = h; if (h.auth_required && !token && !h.signed_in) return showLogin(); } catch {}
    try { await loadState(); await loadConvs(); } catch (e) { if (e.message !== 'unauthorized') toast(e.message, true); return; }
    LOADED_VERSION = S.st.version || S.health?.version || '';
    try { S.me = await api('/api/admin/auth/me'); } catch { S.me = null; }  // who am I (username, role) for avatars and the session card
    $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
    if (!S.st.providers.length) { S.view = 'settings'; S.settingsPage = 'providers'; }
    render();
    let introSeen = true; try { introSeen = !!localStorage.getItem('missile_intro_seen'); } catch {}
    if (!introSeen && S.view === 'chat') openIntro();
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
      else if (k === 'b' && !e.shiftKey && !S.view.startsWith('settings')) { e.preventDefault(); togglePane(); }
      else if (k === 'c' && e.shiftKey) { e.preventDefault(); const t = lastAssistantText(activePane()); if (t) navigator.clipboard.writeText(t).then(() => toast(T('Last answer copied'))); }
      else if (e.key === ';' && e.shiftKey) { e.preventDefault(); const t = lastAssistantText(activePane()); const m = [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].pop(); if (m) navigator.clipboard.writeText(m[1]).then(() => toast(T('Last code block copied'))); else toast(T('The last answer has no code block.'), true); }
    });
  }
  boot();
})();
