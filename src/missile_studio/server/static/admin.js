/* missile-studio admin console. Cookie session (login below) or the owner token from the main UI. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v === undefined || v === null || v === false) continue; if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k === 'style') n.style.cssText = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v); } for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k))); return n; };
  const I = (n, c) => window.icon(n, c);
  const fmtBytes = (b) => b == null ? '-' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
  const fmtDur = (s) => { s = Math.floor(s || 0); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };
  const fmtTs = (t) => t ? new Date(t * 1000).toLocaleString() : '-';
  const fmtMs = (ms) => ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  let toastTimer; function toast(msg, isErr) { $('.toast')?.remove(); const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg); document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200); }
  function modal({ title, body, footer, wide }) { const bd = el('div', { class: 'backdrop', onclick: (e) => { if (e.target === bd) close(); } }); const m = el('div', { class: 'modal', style: wide ? 'width:min(900px,100%)' : '' }, el('header', {}, el('h3', {}, title), el('span', { class: 'spacer' }), el('button', { class: 'btn quiet icon sm', onclick: () => close() }, I('x', 'sm'))), el('div', { class: 'body' }, body), footer ? el('footer', {}, footer) : null); bd.append(m); $('#layer').append(bd); function close() { bd.remove(); } return { close, root: m }; }
  const confirmDialog = (text, ok = 'Confirm') => new Promise((res) => { const m = modal({ title: 'Are you sure?', body: el('p', { style: 'margin:0' }, text), footer: [el('button', { class: 'btn', onclick: () => { m.close(); res(false); } }, 'Cancel'), el('button', { class: 'btn danger', onclick: () => { m.close(); res(true); } }, ok)] }); });
  const switchEl = (checked, onchange) => { const b = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!checked), onclick: () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onchange(v); } }); return b; };
  const field = (label, control, help) => el('div', { class: 'field' }, el('label', {}, label), control, help ? el('div', { class: 'help' }, help) : null);
  const page = (title, sub, ...kids) => el('div', { class: 'page' }, el('h1', {}, title, sub ? el('small', {}, sub) : null), ...kids);

  // ---------------------------------------------------------------- api (cookie session; owner token as fallback)
  const ownerToken = localStorage.getItem('missile_token') || '';
  async function api(path, opts = {}) {
    const o = { ...opts, headers: { 'X-Requested-With': 'missile-admin', ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(ownerToken ? { Authorization: 'Bearer ' + ownerToken } : {}), ...(opts.headers || {}) }, credentials: 'same-origin' };
    if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
    const r = await fetch(path, o);
    if (r.status === 401) { S.me = null; renderLogin(); throw new Error('unauthorized'); }
    if (!r.ok) { let d = ''; try { d = (await r.json()).detail; } catch { d = await r.text(); } throw new Error(typeof d === 'string' ? d : JSON.stringify(d)); }
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }
  const S = { me: null, view: location.hash.replace('#', '') || 'dashboard', timers: [] };
  const NAV = [['dashboard', 'Dashboard', 'home'], ['chats', 'Chats', 'chat'], ['tokens', 'Access tokens', 'key'], ['settings', 'Settings', 'settings'], ['events', 'Events', 'list'], ['system', 'System', 'server'], ['account', 'Account', 'users']];

  // ---------------------------------------------------------------- login
  function renderLogin(msg) {
    S.timers.forEach(clearInterval); S.timers = [];
    const app = $('#app'); app.innerHTML = '';
    const u = el('input', { class: 'input', placeholder: 'username', autocomplete: 'username', value: 'admin' });
    const p = el('input', { class: 'input', type: 'password', placeholder: 'password', autocomplete: 'current-password' });
    const err = el('div', { class: 'tiny', style: 'color:var(--destructive);min-height:1.2em' }, msg || '');
    const form = el('form', { onsubmit: async (e) => { e.preventDefault(); try { const r = await api('/api/admin/auth/login', { method: 'POST', body: { username: u.value.trim(), password: p.value } }); S.me = { username: r.username, mustChangePassword: r.mustChangePassword }; if (r.mustChangePassword) { S.view = 'account'; } await boot(); } catch (e2) { err.textContent = e2.message === 'rate_limited' ? 'Too many attempts. Wait a minute.' : 'Wrong username or password.'; } } },
      el('h1', {}, el('span', { class: 'logo', style: 'width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--fg);color:var(--bg);font-weight:700' }, 'M'), 'Admin console'),
      el('p', { class: 'muted', style: 'margin:0' }, 'Sign in with an admin account. The first password was printed by ', el('code', {}, 'ms serve'), ' and can be reset with ', el('code', {}, 'ms admin reset-password'), '.'),
      field('Username', u), field('Password', p), el('button', { class: 'btn primary', type: 'submit' }, 'Sign in'), err,
      el('div', { class: 'tiny muted' }, el('a', { href: '/' }, '← back to the studio')));
    app.append(el('div', { class: 'login' }, form));
    setTimeout(() => p.focus(), 0);
  }

  // ---------------------------------------------------------------- shell
  function render() {
    S.timers.forEach(clearInterval); S.timers = [];
    const app = $('#app'); app.innerHTML = '';
    const nav = el('div', { class: 'anav' }, el('div', { class: 'brand' }, el('div', { class: 'logo', style: 'background:transparent;box-shadow:none;padding:0', html: window.logoMark(30) }), el('div', {}, el('div', { class: 't' }, S.me?.studio_name || 'missile-studio'), el('div', { class: 's' }, 'admin console'))));
    for (const [id, label, icon] of NAV) nav.append(el('button', { class: S.view === id ? 'active' : '', onclick: () => { S.view = id; location.hash = id; render(); } }, I(icon, 'sm'), label));
    nav.append(el('div', { class: 'foot' }, el('button', { onclick: () => { window.open('/', '_blank'); } }, I('chat', 'sm'), 'Open studio'), el('button', { onclick: () => { S.view = 'account'; render(); } }, I('users', 'sm'), S.me?.username || 'admin'), el('button', { onclick: async () => { await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {}); if (ownerToken) { localStorage.removeItem('missile_token'); } S.me = null; renderLogin('Signed out.'); } }, I('power', 'sm'), 'Sign out')));
    const content = el('div', { class: 'acontent' });
    app.append(el('div', { class: 'admin' }, nav, content));
    ({ dashboard: pageDashboard, chats: pageChats, tokens: pageTokens, settings: pageSettings, events: pageEvents, system: pageSystem, account: pageAccount }[S.view] || pageDashboard)(content);
  }
  const poll = (fn, ms) => { S.timers.push(setInterval(fn, ms)); };

  // ---------------------------------------------------------------- dashboard
  async function pageDashboard(content) {
    const root = page('Dashboard', 'refreshes every 10s'); content.append(root);
    const body = el('div', { style: 'display:grid;gap:18px' }); root.append(body);
    async function load() {
      let o; try { o = await api('/api/admin/overview'); } catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'error-line' }, e.message)); return; }
      body.innerHTML = '';
      if (S.me?.mustChangePassword) body.append(el('div', { class: 'warnbar' }, I('alert', 'sm'), 'You are using the generated password. Change it now.', el('button', { class: 'btn sm', onclick: () => { S.view = 'account'; render(); } }, 'Account')));
      for (const w of o.warnings) body.append(el('div', { class: 'warnbar' }, I('alert', 'sm'), w.text, el('button', { class: 'btn sm', onclick: () => { S.view = w.fix === 'settings' ? 'settings' : w.fix === 'account' ? 'account' : 'system'; render(); } }, 'Go')));
      const d = o.day; const ok = d.tool_calls ? Math.round(100 * (d.tool_calls - d.tool_errors) / d.tool_calls) : 100;
      body.append(el('div', { class: 'stat-row' }, stat(d.user_messages, 'messages · 24h'), stat(d.tool_calls, 'tool calls · 24h'), stat(ok + '%', 'tool success · 24h'), stat(d.tool_denied + d.tool_blocked, 'denied / blocked · 24h'), stat(o.active_turns, 'turns running'), stat(o.pending_approvals, 'approvals waiting'), stat(fmtDur(o.uptime_s), 'uptime')));
      // chart
      const max = Math.max(1, ...o.hourly.map((h) => h.messages + h.tool_calls));
      const chart = el('div', { class: 'chart' });
      o.hourly.forEach((h, i) => { const col = el('div', { class: 'col', title: `${new Date(h.hour * 1000).getHours()}:00 · ${h.messages} msgs · ${h.tool_calls} tools · ${h.errors} errors` }); col.append(el('div', { class: 'e', style: `height:${100 * h.errors / max}%` }), el('div', { class: 't', style: `height:${100 * (h.tool_calls - h.errors) / max}%` }), el('div', { class: 'm', style: `height:${100 * h.messages / max}%` })); if (i % 4 === 0) col.append(el('span', { class: 'lbl' }, new Date(h.hour * 1000).getHours() + 'h')); chart.append(col); });
      body.append(el('div', { class: 'card' }, el('h3', {}, 'Last 24 hours'), chart, el('div', { class: 'legend' }, el('span', { class: 'm' }, 'user messages'), el('span', { class: 't' }, 'tool calls'), el('span', { class: 'e' }, 'tool errors'))));
      const two = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px' });
      // providers + mcp
      const health = el('div', { class: 'card' }, el('h3', {}, 'Providers & MCP'));
      for (const p of o.providers) health.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (p.enabled === false ? '' : (p.has_key || p.kind === 'agentserver' ? 'ok' : 'warn')) }), el('b', {}, p.label || p.id), el('span', { class: 'chip' }, p.kind), el('span', { class: 'muted tiny' }, `${p.models} models`), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { const r = await api(`/api/admin/providers/${encodeURIComponent(p.id)}/test`, { method: 'POST' }); toast(r.ok ? `${p.id}: ok, ${r.count} models` : `${p.id}: ${r.error}`, !r.ok); } catch (err) { toast(err.message, true); } e.target.disabled = false; } }, 'Test')));
      for (const s of o.mcp) health.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'err' : 'warn') }), el('b', {}, s.name), el('span', { class: 'chip' }, s.status), el('span', { class: 'muted tiny' }, `${s.tool_count} tools`), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async () => { await api(`/api/admin/mcp/${encodeURIComponent(s.name)}/restart`, { method: 'POST' }); toast('restarting'); setTimeout(load, 2000); } }, 'Restart')));
      for (const b of o.bridges) health.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (b.status === 'connected' ? 'ok' : 'warn') }), el('b', {}, 'bridge ' + b.provider_id), el('span', { class: 'chip' }, b.status), el('span', { class: 'muted tiny' }, `${b.tool_count} tools · ${b.calls} calls`)));
      if (!o.providers.length && !o.mcp.length) health.append(el('div', { class: 'muted tiny' }, 'Nothing configured yet.'));
      two.append(health);
      // top tools + models
      const tools = el('div', { class: 'card' }, el('h3', {}, 'Top tools · 7d'));
      const tmax = Math.max(1, ...o.top_tools.map((t) => t.n));
      const bars = el('div', { class: 'bars' }); for (const t of o.top_tools) bars.append(el('div', { class: 'b' }, el('span', { class: 'mono truncate', title: t.tool }, t.tool), el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${100 * t.n / tmax}%` })), el('span', { class: 'muted' }, `${t.n}${t.errors ? ' · ' + t.errors + ' err' : ''}`)));
      if (!o.top_tools.length) bars.append(el('div', { class: 'muted tiny' }, 'No tool calls yet.'));
      tools.append(bars, el('div', { class: 'sect' }, 'Models · 7d'));
      for (const m of o.usage_by_model) tools.append(el('div', { class: 'row', style: 'font-size:13px' }, el('span', { class: 'mono truncate', style: 'max-width:60%' }, m.key), el('span', { class: 'spacer' }), el('span', { class: 'muted' }, `${m.turns} turns · ${m.input_tokens}↑ ${m.output_tokens}↓`)));
      if (!o.usage_by_model.length) tools.append(el('div', { class: 'muted tiny' }, 'No turns yet.'));
      two.append(tools);
      body.append(two);
      const ev = el('div', { class: 'card' }, el('h3', {}, 'Recent events', el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: () => { S.view = 'events'; render(); } }, 'All events')));
      for (const e of o.recent_events) ev.append(el('div', { class: 'row', style: 'font-size:13px' }, el('span', { class: 'muted tiny', style: 'width:150px' }, fmtTs(e.ts)), el('span', { class: 'chip ' + (e.level === 'warn' ? 'warn' : e.level === 'error' ? 'err' : '') }, e.category), el('span', {}, e.message), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, e.actor)));
      body.append(ev);
    }
    const stat = (v, l) => el('div', { class: 'stat' }, el('div', { class: 'v' }, v), el('div', { class: 'l' }, l));
    await load(); poll(load, 10000);
  }

  // ---------------------------------------------------------------- chats
  async function pageChats(content) {
    const state = { q: '', offset: 0, limit: 30 };
    const search = el('input', { class: 'input', placeholder: 'search titles', style: 'max-width:320px', oninput: (e) => { state.q = e.target.value; state.offset = 0; load(); } });
    const tb = el('tbody'); const pager = el('div', { class: 'row' });
    content.append(page('Chats', 'every conversation on this studio', el('div', { class: 'row' }, search), el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'updated'), el('th', {}, 'title'), el('th', {}, 'assistant'), el('th', {}, 'model'), el('th', {}, 'messages'), el('th', {}, ''))), tb)), pager));
    async function load() {
      const r = await api(`/api/admin/conversations?q=${encodeURIComponent(state.q)}&limit=${state.limit}&offset=${state.offset}`);
      tb.innerHTML = '';
      for (const c of r.items) tb.append(el('tr', { style: 'cursor:pointer', onclick: () => openConv(c.id) }, el('td', { class: 'muted tiny' }, fmtTs(c.updated_at)), el('td', {}, c.title || 'New chat'), el('td', {}, c.assistant_id), el('td', { class: 'mono' }, (c.model || '').split('|').pop()), el('td', {}, c.message_count), el('td', {}, el('button', { class: 'btn quiet icon sm', onclick: async (e) => { e.stopPropagation(); if (await confirmDialog('Delete this conversation?')) { await api('/api/admin/conversations/' + c.id, { method: 'DELETE' }); load(); } } }, I('trash', 'xs')))));
      if (!r.items.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No conversations.')));
      pager.innerHTML = ''; const pages = Math.max(1, Math.ceil(r.total / state.limit)); const cur = Math.floor(state.offset / state.limit) + 1;
      pager.append(el('span', { class: 'muted tiny' }, `${r.total} total · page ${cur} / ${pages}`), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', disabled: cur <= 1, onclick: () => { state.offset -= state.limit; load(); } }, 'Previous'), el('button', { class: 'btn sm', disabled: cur >= pages, onclick: () => { state.offset += state.limit; load(); } }, 'Next'));
    }
    async function openConv(id) {
      const c = await api('/api/admin/conversations/' + id);
      const body = el('div', { style: 'display:grid;gap:10px;max-height:70vh;overflow:auto' });
      for (const m of c.messages) { const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content); body.append(el('div', { style: 'display:grid;gap:4px' }, el('div', { class: 'row' }, el('span', { class: 'chip ' + (m.role === 'user' ? 'primary' : m.role === 'tool' ? (m.is_error ? 'err' : 'ok') : '') }, m.role + (m.name ? ' · ' + m.name : '')), m.meta?.model ? el('span', { class: 'muted tiny' }, m.meta.model) : null, m.decision ? el('span', { class: 'muted tiny' }, m.decision) : null), el('pre', { class: 'out', style: 'max-height:200px' }, text.slice(0, 4000)))); }
      modal({ title: c.title || 'New chat', body, wide: true, footer: [el('span', { class: 'muted tiny' }, `${c.messages.length} messages · ${c.audit.length} tool calls · ${c.provider_id} / ${(c.model || '').split('|').pop()}`)] });
    }
    await load();
  }

  // ---------------------------------------------------------------- tokens
  async function pageTokens(content) {
    const tb = el('tbody');
    const root = page('Access tokens', 'API tokens for scripts, other devices and people', el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: createToken }, I('plus', 'sm'), 'New token'), el('span', { class: 'muted tiny' }, 'Scope "chat" can talk and manage its own conversations; "admin" can change settings. The owner token from config.json is always admin.')), el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'name'), el('th', {}, 'scope'), el('th', {}, 'created'), el('th', {}, 'last used'), el('th', {}, 'status'), el('th', {}, ''))), tb)));
    content.append(root);
    async function load() {
      const rows = await api('/api/admin/tokens'); tb.innerHTML = '';
      for (const t of rows) tb.append(el('tr', {}, el('td', {}, t.name, el('div', { class: 'muted tiny mono' }, t.id)), el('td', {}, el('span', { class: 'chip ' + (t.scopes === 'admin' ? 'warn' : 'info') }, t.scopes)), el('td', { class: 'muted tiny' }, fmtTs(t.created_at) + (t.created_by ? ' · ' + t.created_by : '')), el('td', { class: 'muted tiny' }, t.last_used_at ? fmtTs(t.last_used_at) : 'never'), el('td', {}, t.revoked_at ? el('span', { class: 'chip err' }, 'revoked') : el('span', { class: 'chip ok' }, 'active')), el('td', {}, t.revoked_at ? null : el('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog(`Revoke token "${t.name}"? Clients using it stop working immediately.`, 'Revoke')) { await api('/api/admin/tokens/' + t.id, { method: 'DELETE' }); load(); } } }, 'Revoke'))));
      if (!rows.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No tokens yet.')));
    }
    function createToken() {
      const d = { name: '', scopes: 'chat' };
      const m = modal({ title: 'New access token', body: [field('Name', el('input', { class: 'input', placeholder: 'laptop · scripts · phone', oninput: (e) => { d.name = e.target.value; } })), field('Scope', el('select', { class: 'select', onchange: (e) => { d.scopes = e.target.value; } }, el('option', { value: 'chat' }, 'chat (conversations, tools, approvals)'), el('option', { value: 'admin' }, 'admin (everything, including settings)')))], footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => { try { const r = await api('/api/admin/tokens', { method: 'POST', body: d }); m.close(); modal({ title: 'Copy this token now', body: [el('p', { class: 'muted', style: 'margin:0' }, 'It is shown once. Use it as ', el('code', {}, 'Authorization: Bearer …'), ' or paste it on the studio login screen.'), el('pre', { class: 'out' }, r.token), el('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(r.token).then(() => toast('copied')) }, I('copy', 'sm'), 'Copy')] }); load(); } catch (e) { toast(e.message, true); } } }, 'Create')] });
    }
    await load();
  }

  // ---------------------------------------------------------------- settings
  async function pageSettings(content) {
    const GROUP = { general: 'General', models: 'Models', tools: 'Tools & policy', access: 'Access', retention: 'Retention' };
    const LABEL = { studio_name: 'Studio name', maintenance_mode: 'Maintenance mode', default_provider: 'Default provider', default_model: 'Default model', policy_default: 'Tools that write or run', policy_read_only_default: 'Read-only tools', builtin_shell: 'Local shell tool', builtin_filesystem: 'Local file tools', builtin_web: 'Local web fetch', workspace: 'Workspace folder', server_token: 'Owner API token', login_rate_limit: 'Login attempts / minute', upload_max_mb: 'Max upload (MB)', retention_days: 'Delete chats after (days)', event_retention_days: 'Delete events after (days)', audit_retention_days: 'Delete tool audit after (days)' };
    const draft = {}; let items = [];
    const root = page('Settings', 'saved values apply immediately'); content.append(root);
    const head = el('div', { class: 'row' }); const body = el('div', { style: 'display:grid;gap:18px' }); root.append(head, body);
    function renderHead() { head.innerHTML = ''; const n = Object.keys(draft).length; head.append(el('span', { class: 'muted tiny' }, n ? `${n} unsaved change${n > 1 ? 's' : ''}` : 'No unsaved changes'), el('span', { class: 'spacer' }), el('button', { class: 'btn', disabled: !n, onclick: () => { for (const k in draft) delete draft[k]; renderAll(); } }, 'Revert'), el('button', { class: 'btn primary', disabled: !n, onclick: save }, `Save (${n})`)); }
    async function save() { try { const r = await api('/api/admin/settings', { method: 'PUT', body: { changes: draft } }); for (const k in draft) delete draft[k]; items = r.items; toast(r.changed.length ? `saved: ${r.changed.join(', ')}` : 'nothing changed'); renderAll(); } catch (e) { toast(e.message, true); } }
    function control(it) {
      const cur = it.key in draft ? draft[it.key] : it.value;
      const set = (v) => { if (v === it.value || (it.kind === 'secret' && v === '')) delete draft[it.key]; else draft[it.key] = v; renderHead(); row.querySelector('.changed')?.remove(); if (it.key in draft) row.querySelector('.k').append(el('span', { class: 'changed' }, 'changed')); };
      let c;
      if (it.kind === 'bool') c = switchEl(cur, set);
      else if (it.kind === 'enum') c = el('select', { class: 'select', onchange: (e) => set(e.target.value) }, ...(it.choices || []).map((v) => el('option', { value: v, selected: v === cur }, v || '(none)')));
      else if (it.kind === 'int') c = el('input', { class: 'input', type: 'number', value: cur, min: it.min ?? undefined, max: it.max ?? undefined, oninput: (e) => set(parseInt(e.target.value || '0', 10)) });
      else if (it.kind === 'secret') c = el('div', { class: 'row', style: 'flex:1' }, el('input', { class: 'input', type: 'password', placeholder: it.hasValue ? `set (${it.value}) · type to replace` : 'not set', oninput: (e) => set(e.target.value) }), el('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog('Rotate the owner token? Every browser and script using the old one must log in again.', 'Rotate')) { try { const r = await api('/api/admin/settings', { method: 'PUT', body: { changes: { server_token: 'rotate' } } }); items = r.items; toast('token rotated: find it in config.json or `ms config show`'); renderAll(); } catch (e) { toast(e.message, true); } } } }, 'Rotate'));
      else c = el('input', { class: 'input', value: cur || '', oninput: (e) => set(e.target.value) });
      const row = el('div', { class: 'setting-row' }, el('div', {}, el('div', { class: 'k' }, LABEL[it.key] || it.key, it.key in draft ? el('span', { class: 'changed' }, 'changed') : null), el('div', { class: 'h' }, it.help)), el('div', { class: 'c' }, c));
      return row;
    }
    function renderAll() {
      renderHead(); body.innerHTML = '';
      for (const g of ['general', 'models', 'tools', 'access', 'retention']) { const card = el('div', { class: 'card', style: 'gap:0' }, el('h3', { style: 'margin-bottom:6px' }, GROUP[g])); for (const it of items.filter((x) => x.group === g)) card.append(control(it)); body.append(card); }
      body.append(el('div', { class: 'card' }, el('h3', {}, 'Data'), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const r = await api('/api/admin/data/prune', { method: 'POST' }); toast(`pruned: ${r.conversations} chats, ${r.events} events, ${r.audit} audit rows`); } }, 'Run retention now'), el('button', { class: 'btn', onclick: async () => { const r = await api('/api/admin/data/vacuum', { method: 'POST' }); toast(`vacuum: ${fmtBytes(r.before)} → ${fmtBytes(r.after)}`); } }, 'Vacuum database'), el('a', { class: 'btn', href: '/api/admin/data/export', target: '_blank' }, I('download', 'sm'), 'Export config (secrets stripped)'))));
    }
    try { items = (await api('/api/admin/settings')).items; renderAll(); } catch (e) { body.append(el('div', { class: 'error-line' }, e.message)); }
  }

  // ---------------------------------------------------------------- events
  async function pageEvents(content) {
    const state = { category: '', level: '', before: null };
    const list = el('div', { class: 'table-wrap' }); const more = el('div', { class: 'row' });
    const cats = ['', 'auth', 'settings', 'access', 'data', 'system'];
    const filters = el('div', { class: 'filters' }, ...cats.map((c) => el('button', { class: 'btn sm' + (state.category === c ? ' primary' : ''), onclick: (e) => { state.category = c; state.before = null; filters.querySelectorAll('button').forEach((b) => b.classList.remove('primary')); e.target.classList.add('primary'); load(true); } }, c || 'all')), el('select', { class: 'select', style: 'width:auto', onchange: (e) => { state.level = e.target.value; state.before = null; load(true); } }, el('option', { value: '' }, 'any level'), el('option', { value: 'info' }, 'info'), el('option', { value: 'warn' }, 'warn'), el('option', { value: 'error' }, 'error')));
    content.append(page('Events', 'admin actions and system log', filters, list, more));
    async function load(reset) {
      const r = await api(`/api/admin/events?category=${state.category}&level=${state.level}&limit=100${state.before ? '&before=' + state.before : ''}`);
      if (reset) list.innerHTML = '';
      for (const e of r.items) { const row = el('div', { class: 'evt', onclick: () => { const d = row.querySelector('.d'); if (d) d.remove(); else row.append(el('div', { class: 'd' }, el('pre', {}, JSON.stringify(e.details, null, 2)))); } }, el('span', { class: 'muted tiny' }, fmtTs(e.ts)), el('span', { class: 'chip ' + (e.level === 'warn' ? 'warn' : e.level === 'error' ? 'err' : '') }, e.level), el('span', { class: 'mono tiny' }, e.category), el('span', {}, e.message), el('span', { class: 'muted tiny truncate' }, e.actor)); list.append(row); }
      if (!list.children.length) list.append(el('div', { class: 'muted', style: 'padding:14px' }, 'No events.'));
      more.innerHTML = ''; if (r.next_before) { state.before = r.next_before; more.append(el('button', { class: 'btn', onclick: () => load(false) }, 'Load more')); }
    }
    await load(true);
  }

  // ---------------------------------------------------------------- system
  async function pageSystem(content) {
    const root = page('System', 'refreshes every 15s'); content.append(root);
    const body = el('div', { style: 'display:grid;gap:18px' }); root.append(body);
    async function load() {
      const s = await api('/api/admin/system'); body.innerHTML = '';
      const mem = s.memory || {};
      body.append(el('div', { class: 'stat-row' }, el('div', { class: 'stat' }, el('div', { class: 'v' }, fmtDur(s.uptime_s)), el('div', { class: 'l' }, 'uptime')), el('div', { class: 'stat' }, el('div', { class: 'v' }, fmtBytes(s.process_rss)), el('div', { class: 'l' }, 'process memory')), el('div', { class: 'stat' }, el('div', { class: 'v' }, mem.percent != null ? mem.percent + '%' : '-'), el('div', { class: 'l' }, `system memory used · ${fmtBytes(mem.available)} free`)), el('div', { class: 'stat' }, el('div', { class: 'v' }, fmtBytes(s.db_size)), el('div', { class: 'l' }, 'database')), el('div', { class: 'stat' }, el('div', { class: 'v' }, s.disk.free != null ? fmtBytes(s.disk.free) : '-'), el('div', { class: 'l' }, 'disk free')), el('div', { class: 'stat' }, el('div', { class: 'v' }, s.active_turns), el('div', { class: 'l' }, 'turns running'))));
      const kv = el('dl', { class: 'kv' }); for (const [k, v] of [['version', s.version], ['python', s.python], ['platform', s.platform], ['host', s.hostname], ['pid', s.pid], ['started', fmtTs(s.started_at)], ['bound', `${s.bound.host}:${s.bound.port}${s.bound.token ? ' (token)' : ' (no token)'}`], ['home', s.home], ['config', s.config_path], ['load', s.load ? s.load.map((x) => x.toFixed(2)).join(' ') : 'n/a'], ['totals', `${s.totals.conversations} chats · ${s.totals.messages} messages · ${s.totals.tool_calls} tool calls · ${s.totals.events} events`]]) kv.append(el('dt', {}, k), el('dd', {}, String(v)));
      body.append(el('div', { class: 'card' }, el('h3', {}, 'Process'), kv));
      const logs = el('div', { class: 'card' }, el('h3', {}, 'Log files'));
      const out = el('pre', { class: 'out hidden', style: 'max-height:420px' });
      for (const l of s.logs) logs.append(el('div', { class: 'row', style: 'font-size:13px' }, I('file', 'sm'), el('span', { class: 'mono' }, l.name), el('span', { class: 'muted tiny' }, fmtBytes(l.size) + ' · ' + fmtTs(l.mtime)), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async () => { const r = await api(`/api/admin/logs/${encodeURIComponent(l.name)}?lines=300`); out.classList.remove('hidden'); out.textContent = r.lines.join('\n'); out.scrollTop = out.scrollHeight; } }, 'Tail')));
      if (!s.logs.length) logs.append(el('div', { class: 'muted tiny' }, 'No log files yet (MCP server stderr appears here).'));
      logs.append(out); body.append(logs);
    }
    await load(); poll(load, 15000);
  }

  // ---------------------------------------------------------------- account
  async function pageAccount(content) {
    const root = page('Account', 'admin users'); content.append(root);
    if (S.me?.mustChangePassword) root.append(el('div', { class: 'warnbar' }, I('alert', 'sm'), 'Set your own password before doing anything else.'));
    const cur = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' }); const nw = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' }); const nw2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    root.append(el('div', { class: 'card' }, el('h3', {}, `Change password · ${S.me?.username || ''}`), S.me?.via !== 'cookie' ? el('div', { class: 'muted tiny' }, 'You are signed in with the owner token; password changes need an admin cookie session (sign out and sign in with a username).') : null, field('Current password', cur), el('div', { class: 'grid2' }, field('New password', nw, 'at least 8 characters'), field('Repeat', nw2)), el('div', {}, el('button', { class: 'btn primary', onclick: async () => { if (nw.value !== nw2.value) return toast('passwords differ', true); try { await api('/api/admin/auth/password', { method: 'POST', body: { current_password: cur.value, new_password: nw.value } }); toast('password changed'); S.me.mustChangePassword = false; cur.value = nw.value = nw2.value = ''; render(); } catch (e) { toast(e.message, true); } } }, 'Change password'))));
    const tb = el('tbody'); const users = el('div', { class: 'card' }, el('h3', {}, 'Accounts', el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: addUser }, I('plus', 'sm'), 'Add account')), el('div', { class: 'muted tiny' }, 'admin = everything · user = chat only (sign-ups land here). Sign-up mode and the invite code live in Settings → access.'), el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'username'), el('th', {}, 'role'), el('th', {}, 'created'), el('th', {}, 'last login'), el('th', {}, 'status'), el('th', {}, ''))), tb))); root.append(users);
    async function load() { const rows = await api('/api/admin/users'); tb.innerHTML = ''; for (const u of rows) tb.append(el('tr', {}, el('td', {}, u.username), el('td', {}, el('span', { class: 'chip ' + (u.role === 'admin' ? 'primary' : '') }, u.role || 'admin')), el('td', { class: 'muted tiny' }, fmtTs(u.created_at)), el('td', { class: 'muted tiny' }, u.last_login_at ? fmtTs(u.last_login_at) : 'never'), el('td', {}, u.must_change_password ? el('span', { class: 'chip warn' }, 'generated password') : el('span', { class: 'chip ok' }, 'ok')), el('td', {}, el('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog(`Reset ${u.username}'s password to a new generated one?`, 'Reset')) { const r = await api('/api/admin/users', { method: 'POST', body: { username: u.username } }); modal({ title: 'New password', body: el('pre', { class: 'out' }, r.password) }); load(); } } }, 'Reset'), ' ', el('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog(`Delete account ${u.username}?`)) { try { await api('/api/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' }); load(); } catch (e) { toast(e.message, true); } } } }, 'Delete')))); }
    function addUser() { const d = { username: '', password: '', role: 'user' }; const m = modal({ title: 'Add account', body: [field('Username', el('input', { class: 'input', oninput: (e) => { d.username = e.target.value.trim(); } })), field('Role', el('select', { class: 'select', onchange: (e) => { d.role = e.target.value; } }, el('option', { value: 'user', selected: true }, 'user · chat only'), el('option', { value: 'admin' }, 'admin · everything'))), field('Password (empty = generate)', el('input', { class: 'input', type: 'password', oninput: (e) => { d.password = e.target.value; } }))], footer: [el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => { try { const r = await api('/api/admin/users', { method: 'POST', body: d }); m.close(); if (r.password) modal({ title: 'Generated password', body: el('pre', { class: 'out' }, r.password) }); load(); } catch (e) { toast(e.message, true); } } }, 'Create')] }); }
    await load();
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { const me = await api('/api/admin/auth/me'); if (me.role && me.role !== 'admin') { S.me = null; renderLogin(`${me.username} is a studio account, not an admin. The studio itself is at /.`); return; } S.me = me; if (me.mustChangePassword && S.view !== 'account') S.view = 'account'; render(); }
    catch (e) { if (e.message !== 'unauthorized') renderLogin(e.message); }
  }
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (v && v !== S.view && S.me) { S.view = v; render(); } });
  boot();
})();
