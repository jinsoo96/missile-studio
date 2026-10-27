/* missile-studio admin console. Cookie session (login below) or the owner token from the main UI. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v === undefined || v === null || v === false) continue; if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k === 'style') n.style.cssText = v; else if (k === 'value') n.value = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v); } for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k))); return n; };
  const I = (n, c) => window.icon(n, c);
  const LOC = () => (i18n.lang === 'ko' ? 'ko-KR' : 'en-US');  // dates and times follow the UI language
  const T = window.T;  // UI text: written in English here, other languages live in i18n.js
  // a translated sentence with elements (code, links) in its {slots}
  const rich = (s, parts) => s.split(/(\{\w+\})/).map((x) => { const k = x.match(/^\{(\w+)\}$/); return k && parts[k[1]] !== undefined ? parts[k[1]] : x; });
  const LANG_NAME = { en: 'English', ko: '한국어' };
  const fmtBytes = (b) => b == null ? '-' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
  const fmtDur = (s) => { s = Math.floor(s || 0); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? T('{d}d {h}h', { d, h }) : h ? T('{h}h {m}m', { h, m }) : T('{m}m {s}s', { m, s: s % 60 }); };
  const fmtTs = (t) => t ? new Date(t * 1000).toLocaleString(LOC()) : '-';
  const fmtMs = (ms) => ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  let toastTimer; function toast(msg, isErr) { $('.toast')?.remove(); const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg); document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200); }
  function modal({ title, body, footer, wide }) { const bd = el('div', { class: 'backdrop', onclick: (e) => { if (e.target === bd) close(); } }); const m = el('div', { class: 'modal', style: wide ? 'width:min(900px,100%)' : '' }, el('header', {}, el('h3', {}, title), el('span', { class: 'spacer' }), el('button', { class: 'btn quiet icon sm', onclick: () => close() }, I('x', 'sm'))), el('div', { class: 'body' }, body), footer ? el('footer', {}, footer) : null); bd.append(m); $('#layer').append(bd); function close() { bd.remove(); } return { close, root: m }; }
  const confirmDialog = (text, ok = T('Confirm')) => new Promise((res) => { const m = modal({ title: T('Are you sure?'), body: el('p', { style: 'margin:0' }, text), footer: [el('button', { class: 'btn', onclick: () => { m.close(); res(false); } }, T('Cancel')), el('button', { class: 'btn danger', onclick: () => { m.close(); res(true); } }, ok)] }); });
  const switchEl = (checked, onchange) => { const b = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!checked), onclick: () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onchange(v); } }); return b; };
  const field = (label, control, help) => el('div', { class: 'field' }, el('label', {}, label), control, help ? el('div', { class: 'help' }, help) : null);
  const page = (title, sub, ...kids) => el('div', { class: 'page' }, el('h1', {}, T(title), sub ? el('small', {}, T(sub)) : null), ...kids);

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
    const u = el('input', { class: 'input', placeholder: T('Username'), autocomplete: 'username', value: 'admin' });
    const p = el('input', { class: 'input', type: 'password', placeholder: T('Password'), autocomplete: 'current-password' });
    const err = el('div', { class: 'tiny', style: 'color:var(--destructive);min-height:1.2em' }, msg || '');
    const form = el('form', { onsubmit: async (e) => { e.preventDefault(); try { const r = await api('/api/admin/auth/login', { method: 'POST', body: { username: u.value.trim(), password: p.value } }); S.me = { username: r.username, mustChangePassword: r.mustChangePassword }; if (r.mustChangePassword) { S.view = 'account'; } await boot(); } catch (e2) { err.textContent = e2.message === 'rate_limited' ? T('Too many attempts. Try again in a minute.') : T('Wrong username or password.'); } } },
      el('h1', {}, el('span', { class: 'logo', style: 'width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--fg);color:var(--bg);font-weight:700' }, 'M'), T('Admin console')),
      el('p', { class: 'muted', style: 'margin:0' }, ...rich(T('Sign in with an admin account. The first password was printed by {serve} and can be reset with {reset}.'), { serve: el('code', {}, 'ms serve'), reset: el('code', {}, 'ms admin reset-password') })),
      field(T('Username'), u), field(T('Password'), p), el('button', { class: 'btn primary', type: 'submit' }, T('Sign in')), err,
      el('div', { class: 'row tiny muted' }, el('a', { href: '/' }, '← ' + T('Back to the studio')), el('span', { class: 'spacer' }), langLink()));
    app.append(el('div', { class: 'login' }, form));
    setTimeout(() => p.focus(), 0);
  }

  // ---------------------------------------------------------------- shell
  function render() {
    S.timers.forEach(clearInterval); S.timers = [];
    const app = $('#app'); app.innerHTML = '';
    const nav = el('div', { class: 'anav' }, el('div', { class: 'brand' }, el('div', { class: 'logo', style: 'background:transparent;box-shadow:none;padding:0', html: window.logoMark(30) }), el('div', {}, el('div', { class: 't' }, S.me?.studio_name || 'missile-studio'), el('div', { class: 's' }, T('admin console')))));
    for (const [id, label, icon] of NAV) nav.append(el('button', { class: S.view === id ? 'active' : '', onclick: () => { S.view = id; location.hash = id; render(); } }, I(icon, 'sm'), T(label)));
    const other = i18n.lang === 'ko' ? 'en' : 'ko';
    nav.append(el('div', { class: 'foot' }, el('button', { onclick: () => { window.open('/', '_blank'); } }, I('chat', 'sm'), T('Open studio')), el('button', { title: T('Language'), onclick: () => { i18n.set(other); render(); } }, I('globe', 'sm'), LANG_NAME[other]), el('button', { onclick: () => { S.view = 'account'; render(); } }, I('users', 'sm'), S.me?.username || 'admin'), el('button', { onclick: async () => { await api('/api/admin/auth/logout', { method: 'POST' }).catch(() => {}); if (ownerToken) { localStorage.removeItem('missile_token'); } S.me = null; renderLogin(T('Signed out.')); } }, I('power', 'sm'), T('Sign out'))));
    const content = el('div', { class: 'acontent' });
    app.append(el('div', { class: 'admin' }, nav, content));
    ({ dashboard: pageDashboard, chats: pageChats, tokens: pageTokens, settings: pageSettings, events: pageEvents, system: pageSystem, account: pageAccount }[S.view] || pageDashboard)(content);
  }
  const poll = (fn, ms) => { S.timers.push(setInterval(fn, ms)); };
  // the login screen switches language in place
  const langLink = () => { const other = i18n.lang === 'ko' ? 'en' : 'ko'; return el('a', { href: '#', onclick: (e) => { e.preventDefault(); i18n.set(other); if (S.me) render(); else renderLogin(); } }, LANG_NAME[other]); };
  // dashboard warnings come with a code; known ones are shown in the UI language
  const WARN = { default_admin_password: 'An admin account still uses its generated password.', no_providers: 'No model provider is set up, so chats cannot start.', provider_no_key: "The provider '{id}' has no API key.", mcp_failed: "The MCP server '{name}' failed: {error}", public_no_token: 'The server can be reached from other machines without an access token.', maintenance_mode: 'Maintenance mode is on. Chat is off for everyone except admins.', weak_admin_password: "The admin account '{user}' has a weak password. Change it.", backup_off: 'Automatic backups are off.', backup_failed: 'The last backup failed: {error}', user_model_unknown: "Studio-user models name a provider that does not exist: '{item}'" };

  // ---------------------------------------------------------------- dashboard
  async function pageDashboard(content) {
    const root = page('Dashboard', 'Refreshes every 10 seconds'); content.append(root);
    const body = el('div', { style: 'display:grid;gap:18px' }); root.append(body);
    async function load() {
      let o; try { o = await api('/api/admin/overview'); } catch (e) { body.innerHTML = ''; body.append(el('div', { class: 'error-line' }, e.message)); return; }
      body.innerHTML = '';
      if (S.me?.mustChangePassword) body.append(el('div', { class: 'warnbar' }, I('alert', 'sm'), T('You are using the generated password. Change it now.'), el('button', { class: 'btn sm', onclick: () => { S.view = 'account'; render(); } }, T('Account'))));
      for (const w of o.warnings) body.append(el('div', { class: 'warnbar' }, I('alert', 'sm'), WARN[w.code] && w.params ? T(WARN[w.code], w.params) : WARN[w.code] && !/\{\w+\}/.test(WARN[w.code]) ? T(WARN[w.code]) : w.text, el('button', { class: 'btn sm', onclick: () => { S.view = w.fix === 'settings' ? 'settings' : w.fix === 'account' ? 'account' : 'system'; render(); } }, T('Go'))));
      const d = o.day; const ok = d.tool_calls ? Math.round(100 * (d.tool_calls - d.tool_errors) / d.tool_calls) : 100;
      body.append(el('div', { class: 'stat-row' }, stat(d.user_messages, T('messages · 24h')), stat(d.tool_calls, T('tool calls · 24h')), stat(ok + '%', T('tool success · 24h')), stat(d.tool_denied + d.tool_blocked, T('denied / blocked · 24h')), stat(o.active_turns, T('turns running')), stat(o.pending_approvals, T('approvals waiting')), stat(fmtDur(o.uptime_s), T('uptime'))));
      // chart
      const max = Math.max(1, ...o.hourly.map((h) => h.messages + h.tool_calls));
      const chart = el('div', { class: 'chart' });
      o.hourly.forEach((h, i) => { const col = el('div', { class: 'col', title: T('{h}:00 · {m} messages · {t} tool calls · {e} errors', { h: new Date(h.hour * 1000).getHours(), m: h.messages, t: h.tool_calls, e: h.errors }) }); col.append(el('div', { class: 'e', style: `height:${100 * h.errors / max}%` }), el('div', { class: 't', style: `height:${100 * (h.tool_calls - h.errors) / max}%` }), el('div', { class: 'm', style: `height:${100 * h.messages / max}%` })); if (i % 4 === 0) col.append(el('span', { class: 'lbl' }, T('{h}h', { h: new Date(h.hour * 1000).getHours() }))); chart.append(col); });
      body.append(el('div', { class: 'card' }, el('h3', {}, T('Last 24 hours')), chart, el('div', { class: 'legend' }, el('span', { class: 'm' }, T('user messages')), el('span', { class: 't' }, T('tool calls')), el('span', { class: 'e' }, T('tool errors')))));
      const two = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:18px' });
      // providers + mcp
      const health = el('div', { class: 'card' }, el('h3', {}, T('Providers & MCP')));
      for (const p of o.providers) health.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (p.enabled === false ? '' : (p.has_key || p.kind === 'agentserver' ? 'ok' : 'warn')) }), el('b', {}, p.label || p.id), el('span', { class: 'chip' }, p.kind), el('span', { class: 'muted tiny' }, T('{n} models', { n: p.models })), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { const r = await api(`/api/admin/providers/${encodeURIComponent(p.id)}/test`, { method: 'POST' }); toast(r.ok ? `${p.id}: ${T('OK, {n} models', { n: r.count })}` : `${p.id}: ${r.error}`, !r.ok); } catch (err) { toast(err.message, true); } e.target.disabled = false; } }, T('Test'))));
      for (const s of o.mcp) health.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'err' : 'warn') }), el('b', {}, s.name), el('span', { class: 'chip' }, T(s.status)), el('span', { class: 'muted tiny' }, T('{n} tools', { n: s.tool_count })), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async () => { await api(`/api/admin/mcp/${encodeURIComponent(s.name)}/restart`, { method: 'POST' }); toast(T('Restarting')); setTimeout(load, 2000); } }, T('Restart'))));
      for (const b of o.bridges) health.append(el('div', { class: 'row' }, el('span', { class: 'dot ' + (b.status === 'connected' ? 'ok' : 'warn') }), el('b', {}, T('Bridge') + ' ' + b.provider_id), el('span', { class: 'chip' }, T(b.status)), el('span', { class: 'muted tiny' }, `${T('{n} tools', { n: b.tool_count })} · ${T('{n} calls', { n: b.calls })}`)));
      if (!o.providers.length && !o.mcp.length) health.append(el('div', { class: 'muted tiny' }, T('Nothing set up yet.')));
      two.append(health);
      // top tools + models
      const tools = el('div', { class: 'card' }, el('h3', {}, T('Top tools · 7 days')));
      const tmax = Math.max(1, ...o.top_tools.map((t) => t.n));
      const bars = el('div', { class: 'bars' }); for (const t of o.top_tools) bars.append(el('div', { class: 'b' }, el('span', { class: 'mono truncate', title: t.tool }, t.tool), el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${100 * t.n / tmax}%` })), el('span', { class: 'muted' }, `${t.n}${t.errors ? ' · ' + T('{n} errors', { n: t.errors }) : ''}`)));
      if (!o.top_tools.length) bars.append(el('div', { class: 'muted tiny' }, T('No tool calls yet.')));
      tools.append(bars, el('div', { class: 'sect' }, T('Models · 7 days')));
      for (const m of o.usage_by_model) tools.append(el('div', { class: 'row', style: 'font-size:13px' }, el('span', { class: 'mono truncate', style: 'max-width:60%' }, m.key), el('span', { class: 'spacer' }), el('span', { class: 'muted' }, `${T('{n} turns', { n: m.turns })} · ${m.input_tokens}↑ ${m.output_tokens}↓`)));
      if (!o.usage_by_model.length) tools.append(el('div', { class: 'muted tiny' }, T('No turns yet.')));
      two.append(tools);
      body.append(two);
      const who = el('div', { class: 'card' }, el('h3', {}, T('Accounts · 7 days')));
      for (const u of o.usage_by_user || []) who.append(el('div', { class: 'row', style: 'font-size:13px' }, el('b', { class: 'truncate', style: 'max-width:40%' }, u.owner || T('admins')), el('span', { class: 'spacer' }), el('span', { class: 'muted' }, `${T('{n} turns', { n: u.turns })} · ${u.input_tokens}↑ ${u.output_tokens}↓ · ${T('{n} chats', { n: u.chats })} · ${fmtBytes(u.bytes)}`)));
      if (!(o.usage_by_user || []).length) who.append(el('div', { class: 'muted tiny' }, T('No turns yet.')));
      body.append(who);
      const ev = el('div', { class: 'card' }, el('h3', {}, T('Recent events'), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: () => { S.view = 'events'; render(); } }, T('All events'))));
      for (const e of o.recent_events) ev.append(el('div', { class: 'row', style: 'font-size:13px' }, el('span', { class: 'muted tiny', style: 'width:150px' }, fmtTs(e.ts)), el('span', { class: 'chip ' + (e.level === 'warn' ? 'warn' : e.level === 'error' ? 'err' : '') }, e.category), el('span', {}, e.message), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, e.actor)));
      body.append(ev);
    }
    const stat = (v, l) => el('div', { class: 'stat' }, el('div', { class: 'v' }, v), el('div', { class: 'l' }, l));
    await load(); poll(load, 10000);
  }

  // ---------------------------------------------------------------- chats
  async function pageChats(content) {
    const state = { q: '', offset: 0, limit: 30 };
    const search = el('input', { class: 'input', placeholder: T('Search titles'), style: 'max-width:320px', oninput: (e) => { state.q = e.target.value; state.offset = 0; load(); } });
    const tb = el('tbody'); const pager = el('div', { class: 'row' });
    content.append(page('Chats', 'Every conversation on this studio', el('div', { class: 'row' }, search), el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, T('Updated')), el('th', {}, T('Title')), el('th', {}, T('Assistant')), el('th', {}, T('Model')), el('th', {}, T('Messages')), el('th', {}, ''))), tb)), pager));
    async function load() {
      const r = await api(`/api/admin/conversations?q=${encodeURIComponent(state.q)}&limit=${state.limit}&offset=${state.offset}`);
      tb.innerHTML = '';
      for (const c of r.items) tb.append(el('tr', { style: 'cursor:pointer', onclick: () => openConv(c.id) }, el('td', { class: 'muted tiny' }, fmtTs(c.updated_at)), el('td', {}, c.title || T('New chat'), c.owner ? el('span', { class: 'chip', style: 'margin-left:6px', title: T('Made by a studio user') }, c.owner) : null), el('td', {}, c.assistant_id), el('td', { class: 'mono' }, (c.model || '').split('|').pop()), el('td', {}, c.message_count), el('td', {}, el('button', { class: 'btn quiet icon sm', onclick: async (e) => { e.stopPropagation(); if (await confirmDialog(T('Delete this conversation?'), T('Delete'))) { await api('/api/admin/conversations/' + c.id, { method: 'DELETE' }); load(); } } }, I('trash', 'xs')))));
      if (!r.items.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, T('No conversations.'))));
      pager.innerHTML = ''; const pages = Math.max(1, Math.ceil(r.total / state.limit)); const cur = Math.floor(state.offset / state.limit) + 1;
      pager.append(el('span', { class: 'muted tiny' }, T('{n} total · page {cur} / {pages}', { n: r.total, cur, pages })), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', disabled: cur <= 1, onclick: () => { state.offset -= state.limit; load(); } }, T('Previous')), el('button', { class: 'btn sm', disabled: cur >= pages, onclick: () => { state.offset += state.limit; load(); } }, T('Next')));
    }
    async function openConv(id) {
      const c = await api('/api/admin/conversations/' + id);
      const body = el('div', { style: 'display:grid;gap:10px;max-height:70vh;overflow:auto' });
      for (const m of c.messages) { const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content); body.append(el('div', { style: 'display:grid;gap:4px' }, el('div', { class: 'row' }, el('span', { class: 'chip ' + (m.role === 'user' ? 'primary' : m.role === 'tool' ? (m.is_error ? 'err' : 'ok') : '') }, m.role + (m.name ? ' · ' + m.name : '')), m.meta?.model ? el('span', { class: 'muted tiny' }, m.meta.model) : null, m.decision ? el('span', { class: 'muted tiny' }, m.decision) : null), el('pre', { class: 'out', style: 'max-height:200px' }, text.slice(0, 4000)))); }
      modal({ title: c.title || T('New chat'), body, wide: true, footer: [el('span', { class: 'muted tiny' }, `${T('{n} messages', { n: c.messages.length })} · ${T('{n} tool calls', { n: c.audit.length })} · ${c.provider_id} / ${(c.model || '').split('|').pop()}`)] });
    }
    await load();
  }

  // ---------------------------------------------------------------- tokens
  async function pageTokens(content) {
    const tb = el('tbody');
    const root = page('Access tokens', 'API tokens for scripts, other devices and people', el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: createToken }, I('plus', 'sm'), T('New token')), el('span', { class: 'muted tiny' }, T('The "chat" scope can talk and manage its own conversations; "admin" can also change settings. The owner token in config.json is always admin.'))), el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, T('Name')), el('th', {}, T('Scope')), el('th', {}, T('Created')), el('th', {}, T('Last used')), el('th', {}, T('Status')), el('th', {}, ''))), tb)));
    content.append(root);
    async function load() {
      const rows = await api('/api/admin/tokens'); tb.innerHTML = '';
      for (const t of rows) tb.append(el('tr', {}, el('td', {}, t.name, el('div', { class: 'muted tiny mono' }, t.id)), el('td', {}, el('span', { class: 'chip ' + (t.scopes === 'admin' ? 'warn' : 'info') }, t.scopes)), el('td', { class: 'muted tiny' }, fmtTs(t.created_at) + (t.created_by ? ' · ' + t.created_by : '')), el('td', { class: 'muted tiny' }, t.last_used_at ? fmtTs(t.last_used_at) : T('never')), el('td', {}, t.revoked_at ? el('span', { class: 'chip err' }, T('revoked')) : el('span', { class: 'chip ok' }, T('active'))), el('td', {}, t.revoked_at ? null : el('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog(T('Revoke the token "{name}"? Clients using it stop working right away.', { name: t.name }), T('Revoke'))) { await api('/api/admin/tokens/' + t.id, { method: 'DELETE' }); load(); } } }, T('Revoke')))));
      if (!rows.length) tb.append(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, T('No tokens yet.'))));
    }
    function createToken() {
      const d = { name: '', scopes: 'chat' };
      const m = modal({ title: T('New access token'), body: [field(T('Name'), el('input', { class: 'input', placeholder: T('laptop · scripts · phone'), oninput: (e) => { d.name = e.target.value; } })), field(T('Scope'), el('select', { class: 'select', onchange: (e) => { d.scopes = e.target.value; } }, el('option', { value: 'chat' }, T('chat (conversations, tools, approvals)')), el('option', { value: 'admin' }, T('admin (everything, including settings)'))))], footer: [el('button', { class: 'btn', onclick: () => m.close() }, T('Cancel')), el('button', { class: 'btn primary', onclick: async () => { try { const r = await api('/api/admin/tokens', { method: 'POST', body: d }); m.close(); modal({ title: T('Copy this token now'), body: [el('p', { class: 'muted', style: 'margin:0' }, ...rich(T('It is shown only once. Send it as {header} or paste it on the studio sign-in screen.'), { header: el('code', {}, 'Authorization: Bearer …') })), el('pre', { class: 'out' }, r.token), el('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(r.token).then(() => toast(T('Copied'))) }, I('copy', 'sm'), T('Copy'))] }); load(); } catch (e) { toast(e.message, true); } } }, T('Create'))] });
    }
    await load();
  }

  // ---------------------------------------------------------------- settings
  async function pageSettings(content) {
    const GROUP = { general: 'General', models: 'Models', tools: 'Tools & policy', access: 'Access', users: 'Studio users', retention: 'Retention & backups' };
    const LABEL = { studio_name: 'Studio name', maintenance_mode: 'Maintenance mode', default_provider: 'Default provider', default_model: 'Default model', policy_default: 'Tools that write or run', policy_read_only_default: 'Read-only tools', builtin_shell: 'Local shell tool', builtin_filesystem: 'Local file tools', builtin_web: 'Local web fetch', workspace: 'Workspace folder', server_token: 'Owner API token', login_rate_limit: 'Login attempts / minute', signup_mode: 'Sign-up mode', signup_invite_code: 'Invite code', signup_max_users: 'Most sign-ups', user_models: 'Studio user models', user_tools: 'Studio user tools', user_daily_turns: 'Messages per user · 24h', user_concurrent_turns: 'Answers running per user', user_storage_mb: 'Space per user (MB)', upload_max_mb: 'Max upload (MB)', retention_days: 'Delete chats after (days)', event_retention_days: 'Delete events after (days)', audit_retention_days: 'Delete tool audit after (days)', backup_interval_hours: 'Back up every (hours)', backup_keep: 'Backups to keep', backup_dir: 'Backup folder' };
    const draft = {}; let items = [];
    const root = page('Settings', 'Saved values apply right away'); content.append(root);
    const head = el('div', { class: 'row' }); const body = el('div', { style: 'display:grid;gap:18px' }); root.append(head, body);
    function renderHead() { head.innerHTML = ''; const n = Object.keys(draft).length; head.append(el('span', { class: 'muted tiny' }, n ? T(n === 1 ? '1 unsaved change' : '{n} unsaved changes', { n }) : T('No unsaved changes')), el('span', { class: 'spacer' }), el('button', { class: 'btn', disabled: !n, onclick: () => { for (const k in draft) delete draft[k]; renderAll(); } }, T('Revert')), el('button', { class: 'btn primary', disabled: !n, onclick: save }, T('Save ({n})', { n }))); }
    async function save() { try { const r = await api('/api/admin/settings', { method: 'PUT', body: { changes: draft } }); for (const k in draft) delete draft[k]; items = r.items; toast(r.changed.length ? T('Saved: {keys}', { keys: r.changed.map((k) => T(LABEL[k] || k)).join(', ') }) : T('Nothing changed')); renderAll(); } catch (e) { toast(e.message, true); } }
    function control(it) {
      const cur = it.key in draft ? draft[it.key] : it.value;
      const set = (v) => { if (v === it.value || (it.kind === 'secret' && v === '')) delete draft[it.key]; else draft[it.key] = v; renderHead(); row.querySelector('.changed')?.remove(); if (it.key in draft) row.querySelector('.k').append(el('span', { class: 'changed' }, T('changed'))); };
      let c;
      if (it.kind === 'bool') c = switchEl(cur, set);
      else if (it.kind === 'enum') c = el('select', { class: 'select', onchange: (e) => set(e.target.value) }, ...(it.choices || []).map((v) => el('option', { value: v, selected: v === cur }, v ? (it.key.startsWith('policy') || it.key === 'signup_mode' || it.key === 'user_tools' ? T(v) : v) : T('(none)'))));
      else if (it.kind === 'int') c = el('input', { class: 'input', type: 'number', value: cur, min: it.min ?? undefined, max: it.max ?? undefined, oninput: (e) => set(parseInt(e.target.value || '0', 10)) });
      else if (it.kind === 'secret') c = el('div', { class: 'row', style: 'flex:1' }, el('input', { class: 'input', type: 'password', placeholder: it.hasValue ? T('Set ({value}) · type to replace', { value: it.value }) : T('Not set'), oninput: (e) => set(e.target.value) }), el('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog(T('Rotate the owner token? Every browser and script using the old one must sign in again.'), T('Rotate'))) { try { const r = await api('/api/admin/settings', { method: 'PUT', body: { changes: { server_token: 'rotate' } } }); items = r.items; toast(T('Token rotated. Find it in config.json or with `ms config show`.')); renderAll(); } catch (e) { toast(e.message, true); } } } }, T('Rotate')));
      else c = el('input', { class: 'input', value: cur || '', oninput: (e) => set(e.target.value) });
      const row = el('div', { class: 'setting-row' }, el('div', {}, el('div', { class: 'k' }, T(LABEL[it.key] || it.key), it.key in draft ? el('span', { class: 'changed' }, T('changed')) : null), el('div', { class: 'h' }, T(it.help))), el('div', { class: 'c' }, c));
      return row;
    }
    function renderAll() {
      renderHead(); body.innerHTML = '';
      for (const g of ['general', 'models', 'tools', 'access', 'users', 'retention']) { const card = el('div', { class: 'card', style: 'gap:0' }, el('h3', { style: 'margin-bottom:6px' }, T(GROUP[g]))); for (const it of items.filter((x) => x.group === g)) card.append(control(it)); body.append(card); }
      body.append(el('div', { class: 'card' }, el('h3', {}, T('Data')), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const r = await api('/api/admin/data/prune', { method: 'POST' }); toast(T('Cleaned up: {c} chats, {e} events, {a} audit rows', { c: r.conversations, e: r.events, a: r.audit })); } }, T('Run retention now')), el('button', { class: 'btn', onclick: async () => { const r = await api('/api/admin/data/vacuum', { method: 'POST' }); toast(T('Database compacted: {before} → {after}', { before: fmtBytes(r.before), after: fmtBytes(r.after) })); } }, T('Compact the database')), el('a', { class: 'btn', href: '/api/admin/data/export', target: '_blank' }, I('download', 'sm'), T('Export config without secrets')))));
    }
    try { items = (await api('/api/admin/settings')).items; renderAll(); } catch (e) { body.append(el('div', { class: 'error-line' }, e.message)); }
  }

  // ---------------------------------------------------------------- events
  async function pageEvents(content) {
    const state = { category: '', level: '', before: null };
    const list = el('div', { class: 'table-wrap' }); const more = el('div', { class: 'row' });
    const cats = ['', 'auth', 'settings', 'access', 'data', 'system'];
    const filters = el('div', { class: 'filters' }, ...cats.map((c) => el('button', { class: 'btn sm' + (state.category === c ? ' primary' : ''), onclick: (e) => { state.category = c; state.before = null; filters.querySelectorAll('button').forEach((b) => b.classList.remove('primary')); e.target.classList.add('primary'); load(true); } }, T(c || 'all'))), el('select', { class: 'select', style: 'width:auto', onchange: (e) => { state.level = e.target.value; state.before = null; load(true); } }, el('option', { value: '' }, T('Any level')), el('option', { value: 'info' }, T('info')), el('option', { value: 'warn' }, T('warn')), el('option', { value: 'error' }, T('error'))));
    content.append(page('Events', 'Admin actions and the system log', filters, list, more));
    async function load(reset) {
      const r = await api(`/api/admin/events?category=${state.category}&level=${state.level}&limit=100${state.before ? '&before=' + state.before : ''}`);
      if (reset) list.innerHTML = '';
      for (const e of r.items) { const row = el('div', { class: 'evt', onclick: () => { const d = row.querySelector('.d'); if (d) d.remove(); else row.append(el('div', { class: 'd' }, el('pre', {}, JSON.stringify(e.details, null, 2)))); } }, el('span', { class: 'muted tiny' }, fmtTs(e.ts)), el('span', { class: 'chip ' + (e.level === 'warn' ? 'warn' : e.level === 'error' ? 'err' : '') }, T(e.level)), el('span', { class: 'mono tiny' }, e.category), el('span', {}, e.message), el('span', { class: 'muted tiny truncate' }, e.actor)); list.append(row); }
      if (!list.children.length) list.append(el('div', { class: 'muted', style: 'padding:14px' }, T('No events.')));
      more.innerHTML = ''; if (r.next_before) { state.before = r.next_before; more.append(el('button', { class: 'btn', onclick: () => load(false) }, T('Load more'))); }
    }
    await load(true);
  }

  // ---------------------------------------------------------------- system
  async function pageSystem(content) {
    const root = page('System', 'Refreshes every 15 seconds'); content.append(root);
    const body = el('div', { style: 'display:grid;gap:18px' }); root.append(body);
    async function load() {
      const s = await api('/api/admin/system'); body.innerHTML = '';
      const mem = s.memory || {};
      body.append(el('div', { class: 'stat-row' }, el('div', { class: 'stat' }, el('div', { class: 'v' }, fmtDur(s.uptime_s)), el('div', { class: 'l' }, T('uptime'))), el('div', { class: 'stat' }, el('div', { class: 'v' }, fmtBytes(s.process_rss)), el('div', { class: 'l' }, T('process memory'))), el('div', { class: 'stat' }, el('div', { class: 'v' }, mem.percent != null ? mem.percent + '%' : '-'), el('div', { class: 'l' }, T('system memory used · {free} free', { free: fmtBytes(mem.available) }))), el('div', { class: 'stat' }, el('div', { class: 'v' }, fmtBytes(s.db_size)), el('div', { class: 'l' }, T('database'))), el('div', { class: 'stat' }, el('div', { class: 'v' }, s.disk.free != null ? fmtBytes(s.disk.free) : '-'), el('div', { class: 'l' }, T('disk free'))), el('div', { class: 'stat' }, el('div', { class: 'v' }, s.active_turns), el('div', { class: 'l' }, T('turns running')))));
      const kv = el('dl', { class: 'kv' }); for (const [k, v] of [['version', s.version], ['python', s.python], ['platform', s.platform], ['host', s.hostname], ['pid', s.pid], ['started', fmtTs(s.started_at)], ['bound', `${s.bound.host}:${s.bound.port} (${s.bound.token ? T('token') : T('no token')})`], ['home', s.home], ['config', s.config_path], ['load', s.load ? s.load.map((x) => x.toFixed(2)).join(' ') : 'n/a'], ['totals', [T('{n} chats', { n: s.totals.conversations }), T('{n} messages', { n: s.totals.messages }), T('{n} tool calls', { n: s.totals.tool_calls }), T('{n} events', { n: s.totals.events })].join(' · ')]]) kv.append(el('dt', {}, T(k)), el('dd', {}, String(v)));
      body.append(el('div', { class: 'card' }, el('h3', {}, T('Process')), kv));
      const logs = el('div', { class: 'card' }, el('h3', {}, T('Log files')));
      const out = el('pre', { class: 'out hidden', style: 'max-height:420px' });
      for (const l of s.logs) logs.append(el('div', { class: 'row', style: 'font-size:13px' }, I('file', 'sm'), el('span', { class: 'mono' }, l.name), el('span', { class: 'muted tiny' }, fmtBytes(l.size) + ' · ' + fmtTs(l.mtime)), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async () => { const r = await api(`/api/admin/logs/${encodeURIComponent(l.name)}?lines=300`); out.classList.remove('hidden'); out.textContent = r.lines.join('\n'); out.scrollTop = out.scrollHeight; } }, T('Tail'))));
      if (!s.logs.length) logs.append(el('div', { class: 'muted tiny' }, T('No log files yet. MCP server error output appears here.')));
      logs.append(out); body.append(logs);
      const b = s.backups || { items: [] }; const last = b.last || null;
      const bk = el('div', { class: 'card' }, el('h3', {}, T('Backups'), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { const r = await api('/api/admin/data/backup', { method: 'POST' }); toast(r.ok ? T('Backed up: {path}', { path: r.path }) : r.error, !r.ok); load(); } catch (err) { toast(err.message, true); } e.target.disabled = false; } }, T('Back up now'))),
        el('div', { class: 'muted tiny' }, (b.interval_hours ? T('Every {n} hours: the database, config.json and secret.key, into {dir}', { n: b.interval_hours, dir: b.dir }) : T('Automatic backups are off.')) + (last ? ' · ' + (last.ok ? T('last {when}', { when: fmtTs(last.at) }) : T('last failed: {error}', { error: last.error })) : '')));
      for (const x of b.items) bk.append(el('div', { class: 'row', style: 'font-size:13px' }, I('file', 'sm'), el('span', { class: 'mono' }, x.name), el('span', { class: 'spacer' }), el('span', { class: 'muted tiny' }, fmtBytes(x.size) + ' · ' + fmtTs(x.mtime))));
      if (!b.items.length) bk.append(el('div', { class: 'muted tiny' }, T('No backups yet.')));
      body.append(bk);
    }
    await load(); poll(load, 15000);
  }

  // ---------------------------------------------------------------- account
  async function pageAccount(content) {
    const root = page('Account', 'Admin users'); content.append(root);
    if (S.me?.mustChangePassword) root.append(el('div', { class: 'warnbar' }, I('alert', 'sm'), T('Set your own password before doing anything else.')));
    const cur = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' }); const nw = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' }); const nw2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    root.append(el('div', { class: 'card' }, el('h3', {}, `${T('Change password')} · ${S.me?.username || ''}`), S.me?.via !== 'cookie' ? el('div', { class: 'muted tiny' }, T('You are signed in with the owner token. Changing a password needs an admin account session: sign out, then sign in with a username.')) : null, field(T('Current password'), cur), el('div', { class: 'grid2' }, field(T('New password'), nw, T('At least 8 characters')), field(T('Repeat'), nw2)), el('div', {}, el('button', { class: 'btn primary', onclick: async () => { if (nw.value !== nw2.value) return toast(T('The passwords do not match.'), true); try { await api('/api/admin/auth/password', { method: 'POST', body: { current_password: cur.value, new_password: nw.value } }); toast(T('Password changed')); S.me.mustChangePassword = false; cur.value = nw.value = nw2.value = ''; render(); } catch (e) { toast(e.message, true); } } }, T('Change password')))));
    const tb = el('tbody'); const users = el('div', { class: 'card' }, el('h3', {}, T('Accounts'), el('span', { class: 'spacer' }), el('button', { class: 'btn sm', onclick: addUser }, I('plus', 'sm'), T('Add account'))), el('div', { class: 'muted tiny' }, T('admin: everything · user: chat only, where sign-ups land. The sign-up mode, invite code and what users get are in Settings → Studio users.')), el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, T('Username')), el('th', {}, T('Role')), el('th', {}, T('Created')), el('th', {}, T('Last sign-in')), el('th', {}, T('Status')), el('th', {}, ''))), tb))); root.append(users);
    async function load() { const rows = await api('/api/admin/users'); tb.innerHTML = ''; for (const u of rows) tb.append(el('tr', {}, el('td', {}, u.username), el('td', {}, el('span', { class: 'chip ' + (u.role === 'admin' ? 'primary' : '') }, T(u.role || 'admin'))), el('td', { class: 'muted tiny' }, fmtTs(u.created_at)), el('td', { class: 'muted tiny' }, u.last_login_at ? fmtTs(u.last_login_at) : T('never')), el('td', {}, u.disabled ? el('span', { class: 'chip err' }, T('locked')) : u.must_change_password ? el('span', { class: 'chip warn' }, T('generated password')) : u.weak_password ? el('span', { class: 'chip warn' }, T('weak password')) : el('span', { class: 'chip ok' }, T('ok'))), el('td', {}, el('button', { class: 'btn sm', onclick: async () => { try { await api(`/api/admin/users/${encodeURIComponent(u.username)}/disabled`, { method: 'POST', body: { disabled: !u.disabled } }); toast(u.disabled ? T('{user} can sign in again', { user: u.username }) : T('{user} is locked out', { user: u.username })); load(); } catch (e) { toast(e.message, true); } } }, u.disabled ? T('Unlock') : T('Lock')), ' ', el('button', { class: 'btn sm', title: T('End every session of this account; the password stays'), onclick: async () => { try { await api(`/api/admin/users/${encodeURIComponent(u.username)}/signout`, { method: 'POST' }); toast(T('{user} is signed out everywhere', { user: u.username })); } catch (e) { toast(e.message, true); } } }, T('Sign out everywhere')), ' ', el('button', { class: 'btn sm', onclick: async () => { if (await confirmDialog(T("Reset {user}'s password to a new generated one?", { user: u.username }), T('Reset'))) { const r = await api('/api/admin/users', { method: 'POST', body: { username: u.username } }); modal({ title: T('New password'), body: el('pre', { class: 'out' }, r.password) }); load(); } } }, T('Reset')), ' ', el('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDialog(T('Delete the account {user}?', { user: u.username }), T('Delete'))) { try { await api('/api/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' }); load(); } catch (e) { toast(e.message, true); } } } }, T('Delete'))))); }
    function addUser() { const d = { username: '', password: '', role: 'user' }; const m = modal({ title: T('Add account'), body: [field(T('Username'), el('input', { class: 'input', oninput: (e) => { d.username = e.target.value.trim(); } })), field(T('Role'), el('select', { class: 'select', onchange: (e) => { d.role = e.target.value; } }, el('option', { value: 'user', selected: true }, T('user · chat only')), el('option', { value: 'admin' }, T('admin · everything')))), field(T('Password (leave empty to generate one)'), el('input', { class: 'input', type: 'password', oninput: (e) => { d.password = e.target.value; } }))], footer: [el('button', { class: 'btn', onclick: () => m.close() }, T('Cancel')), el('button', { class: 'btn primary', onclick: async () => { try { const r = await api('/api/admin/users', { method: 'POST', body: d }); m.close(); if (r.password) modal({ title: T('Generated password'), body: el('pre', { class: 'out' }, r.password) }); load(); } catch (e) { toast(e.message, true); } } }, T('Create'))] }); }
    await load();
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { const me = await api('/api/admin/auth/me'); if (me.role && me.role !== 'admin') { S.me = null; renderLogin(T('{user} is a studio account, not an admin. The studio is at /.', { user: me.username })); return; } S.me = me; if (me.mustChangePassword && S.view !== 'account') S.view = 'account'; render(); }
    catch (e) { if (e.message !== 'unauthorized') renderLogin(e.message); }
  }
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (v && v !== S.view && S.me) { S.view = v; render(); } });
  boot();
})();
