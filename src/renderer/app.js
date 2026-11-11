import { esc, icon, cube, toast, openModal, confirmDialog, formData, tilt, fmtDT, fmtD, fmtN, pct, initials, debounce } from './ui.js';
import { createLoginScene, createTower } from './scene3d.js';
import { renderLabelHTML, drawBarcodes } from './label.js';
import { parseTable, resolveFloor } from './importer.js';

const app = document.getElementById('app');
const state = {
  info: null,
  user: null,
  floors: [],
  route: null,
  params: {},
  shellCleanups: [],
  viewCleanups: [],
  stamp: null,
  poll: null,
  vs: {},
  renderToken: 0,
  update: null,
  busy: false,
};

/* ------------------------------------------------------------------ */
/* Infra                                                               */
/* ------------------------------------------------------------------ */
async function api(channel, payload) {
  const r = await window.api.call(channel, payload);
  if (!r || !r.ok) {
    const err = new Error((r && r.error) || 'Erro inesperado.');
    err.code = r && r.code;
    if (err.code === 'AUTH' && state.user) {
      state.user = null;
      toast(err.message, 'warn');
      showLogin();
    }
    throw err;
  }
  return r.data;
}

/* Perfis de usuário (as permissões reais são conferidas no processo principal) */
const ROLE_INFO = {
  admin: { name: 'Administrador', tone: 'violet', panel: 'Painel administrativo', desc: 'Acesso total: usuários, andares, configurações, lotes e impressão.' },
  supervisor: { name: 'Supervisor', tone: 'pink', panel: 'Painel do supervisor', desc: 'Cria e distribui lotes e imprime qualquer etiqueta. Não altera usuários, andares nem configurações.' },
  consulta: { name: 'Consulta', tone: 'gray', panel: 'Painel de consulta', desc: 'Somente leitura: vê painel, lotes e histórico. Não imprime nem altera nada.' },
  analista: { name: 'Analista', tone: 'cyan', panel: 'Painel do analista', desc: 'Vê e imprime somente as etiquetas distribuídas para ele nos andares marcados.' },
};
const roleInfo = (r) => ROLE_INFO[r] || { name: r, tone: 'gray', panel: '', desc: '' };
const rolePill = (r) => `<span class="pill ${roleInfo(r).tone}">${esc(roleInfo(r).name)}</span>`;
const isAdmin = () => state.user?.role === 'admin';
const canManage = () => ['admin', 'supervisor'].includes(state.user?.role);
const seesAll = () => ['admin', 'supervisor', 'consulta'].includes(state.user?.role);

const cleanup = (list) => {
  while (list.length) {
    try { list.pop()(); } catch {}
  }
};
const viewState = (key, init) => (state.vs[key] ||= init());
const normText = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const bindGo = (el) => el.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go)));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0];

const progress = (a, b, color) =>
  `<div class="bar"><i style="width:${pct(a, b)}%;${color ? `--c:${esc(color)}` : ''}"></i></div>`;
const floorTag = (f) =>
  f
    ? `<span class="floor-tag"><span class="sq" style="background:${esc(f.color)}">${esc(f.code)}</span>${esc(f.name)}</span>`
    : '<span class="pill amber">Sem andar</span>';
const statCard = (label, value, sub, ic, tone) => `<div class="stat tone-${tone}" data-tilt>
  <div class="stat-icon">${icon(ic, 22)}</div>
  <div class="stat-body"><div class="stat-value">${fmtN(value)}</div><div class="stat-label">${esc(label)}</div><div class="stat-sub">${esc(sub)}</div></div>
</div>`;
const emptyBox = (ic, title, text, action = '') =>
  `<div class="empty">${icon(ic, 38)}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
const STATUS_TONE = { 'Concluído': 'green', 'Distribuído': 'cyan', 'Parcial': 'violet', 'Aguardando distribuição': 'amber', 'Vazio': 'gray' };
const statusPill = (s) => `<span class="pill ${STATUS_TONE[s] || 'gray'}">${esc(s)}</span>`;
const ACT_ICONS = {
  'Impressão': 'printer', 'Reimpressão': 'printer', 'PDF gerado': 'file', 'Login': 'user', 'Logout': 'logout',
  'Lote criado': 'package', 'Lote excluído': 'trash', 'Distribuição automática': 'shuffle', 'Distribuição manual': 'shuffle',
  'Etiquetas adicionadas': 'barcode', 'Usuário criado': 'users', 'Andar criado': 'layers', 'Reimpressão liberada': 'refresh',
};
const actRow = (l) => `<div class="act-row">
  <div class="act-ic">${icon(ACT_ICONS[l.action] || 'info', 16)}</div>
  <div style="min-width:0"><b>${esc(l.userName)}</b> · ${esc(l.action)}<div class="det" title="${esc(l.details)}">${esc(l.details)}</div></div>
  <time>${fmtDT(l.at)}</time>
</div>`;

function mountTower(ctx, el, opts) {
  try {
    const t = createTower(el, { ...opts, silent: ctx.silent });
    ctx.onCleanup(() => t.dispose());
  } catch {
    el.innerHTML = '<div class="tower-empty">Visualização 3D indisponível neste computador.</div>';
  }
}

/* ------------------------------------------------------------------ */
/* Atualização automática (GitHub)                                     */
/* ------------------------------------------------------------------ */
function renderUpdateBanner() {
  const el = document.getElementById('update-banner');
  const s = state.update;
  if (!s || (s.state !== 'ready' && s.state !== 'downloading')) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (s.state === 'downloading') {
    el.innerHTML = `${icon('cloud', 20)}<div class="ub-text"><b>Baixando atualização ${esc(s.version || '')}</b><span>${s.percent || 0}% · você pode continuar trabalhando</span></div>`;
  } else {
    el.innerHTML = `${icon('sparkle', 20)}<div class="ub-text"><b>Nova versão ${esc(s.version || '')} pronta</b><span>Será instalada automaticamente ao fechar o sistema.</span></div>
      <button class="btn primary sm" id="ub-install">${icon('refresh', 14)} Reiniciar e atualizar</button>`;
    el.querySelector('#ub-install').onclick = () => api('update:install');
  }
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */
async function showLogin() {
  stopPolling();
  cleanup(state.viewCleanups);
  cleanup(state.shellCleanups);
  state.user = null;
  state.vs = {};
  document.body.classList.add('on-login');
  document.getElementById('tb-right').innerHTML = '';
  try {
    state.info = await api('app:info');
  } catch (e) {
    state.info = { serverError: e.message, version: '', server: '', host: '' };
  }
  const info = state.info;
  const offline = Boolean(info.serverError);

  app.innerHTML = `
  <div class="login">
    <canvas id="scene"></canvas>
    <div class="login-overlay">
      <section class="hero">
        <img class="brand-logo" src="assets/torino-logo.png" alt="Torino">
        <h1>Etiquetas <span>3D</span></h1>
        <p>Distribuição de lotes e impressão de etiquetas por andar de estoque.</p>
        <ul>
          <li>${icon('building')} Cada analista imprime somente as etiquetas dos seus andares</li>
          <li>${icon('shuffle')} Administrador e supervisor distribuem os lotes em poucos cliques</li>
          <li>${icon('clock')} Histórico completo de impressões e reimpressões</li>
        </ul>
      </section>
      <div class="login-card" id="card">
        <div class="lc-head">
          <h2>Entrar no sistema</h2>
          <p>Use o usuário e a senha fornecidos pelo administrador.</p>
        </div>
        <form id="login-form" autocomplete="off" novalidate>
          ${offline ? `<div class="login-error">${icon('alert', 16)}<span>${esc(info.serverError)}
            <br><button type="button" class="btn ghost sm" id="retry" style="margin-top:8px">${icon('refresh', 14)} Tentar novamente</button></span></div>` : ''}
          <div class="login-error" id="err" hidden></div>
          <label class="field">Usuário<div class="input-icon">${icon('user', 16)}<input type="text" name="username" maxlength="40" autocomplete="username"></div></label>
          <label class="field">Senha<div class="input-icon">${icon('lock', 16)}<input type="password" name="password" id="pw" maxlength="100" autocomplete="current-password"><button type="button" class="icon-btn" id="eye" aria-label="Mostrar senha">${icon('eye', 16)}</button></div></label>
          <button class="btn primary lg block" type="submit" ${offline ? 'disabled' : ''}>
            <span>Entrar</span>${icon('arrow', 18)}
          </button>
        </form>
      </div>
    </div>
    <footer class="login-foot">
      <span>Versão ${esc(info.version)} · ${esc(info.host)}</span>
    </footer>
  </div>`;

  try {
    const scene = createLoginScene(app.querySelector('#scene'));
    state.shellCleanups.push(() => scene.dispose());
  } catch {
    app.querySelector('#scene').style.background = 'radial-gradient(circle at 60% 40%, #13204a, #050816)';
  }

  const card = app.querySelector('#card');
  tilt(card, 5);
  const form = app.querySelector('#login-form');
  const errEl = app.querySelector('#err');
  const pw = app.querySelector('#pw');
  app.querySelector('#eye').onclick = () => {
    pw.type = pw.type === 'password' ? 'text' : 'password';
    app.querySelector('#eye').innerHTML = icon(pw.type === 'password' ? 'eye' : 'eyeOff', 16);
  };
  const showErr = (msg) => {
    errEl.innerHTML = `${icon('alert', 16)}<span>${esc(msg)}</span>`;
    errEl.hidden = false;
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  };
  form.querySelector('input')?.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    errEl.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.classList.add('loading');
    btn.disabled = true;
    try {
      await api('auth:login', d);
      card.classList.add('leaving');
      await new Promise((r) => setTimeout(r, 380));
      await enterApp();
    } catch (err) {
      showErr(err.message);
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  };
  app.querySelector('#retry')?.addEventListener('click', () => showLogin());
}

async function enterApp() {
  const me = await api('auth:me');
  if (!me) return showLogin();
  state.user = me.user;
  state.floors = me.floors || [];
  if (!state.info) state.info = await api('app:info');
  showShell();
}

/* ------------------------------------------------------------------ */
/* Estrutura principal                                                 */
/* ------------------------------------------------------------------ */
function showShell() {
  cleanup(state.viewCleanups);
  cleanup(state.shellCleanups);
  document.body.classList.remove('on-login');
  const u = state.user;
  const analyst = u.role === 'analista';
  const NAV = {
    admin: [['dashboard', 'layout', 'Painel'], ['lots', 'package', 'Lotes'], ['users', 'users', 'Usuários'], ['floors', 'layers', 'Andares'], ['history', 'clock', 'Histórico'], ['settings', 'sliders', 'Configurações']],
    supervisor: [['dashboard', 'layout', 'Painel'], ['lots', 'package', 'Lotes'], ['history', 'clock', 'Histórico'], ['settings', 'sliders', 'Configurações']],
    consulta: [['dashboard', 'layout', 'Painel'], ['lots', 'package', 'Lotes'], ['history', 'clock', 'Histórico'], ['settings', 'sliders', 'Configurações']],
    analista: [['myfloor', 'building', state.floors.length > 1 ? 'Meus andares' : 'Meu andar'], ['history', 'clock', 'Histórico'], ['settings', 'sliders', 'Configurações']],
  };
  const nav = NAV[u.role] || NAV.consulta;

  app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="side-brand"><img class="side-logo" src="assets/torino-logo.png" alt="Torino"><div><b>Etiquetas 3D</b><small>${esc(roleInfo(u.role).panel)}</small></div></div>
      <div class="side-user" id="side-user"></div>
      <div class="nav-label">Menu</div>
      <nav class="nav">${nav.map(([r, ic, label]) => `<button data-route="${r}">${icon(ic, 18)}<span>${label}</span></button>`).join('')}</nav>
      <div class="side-spacer"></div>
      <div class="side-foot">
        <button class="btn ghost block" id="logout">${icon('logout', 16)} Sair</button>
        <div class="ver">Versão ${esc(state.info?.version || '')}</div>
      </div>
    </aside>
    <main class="content" id="content"><div class="content-inner" id="view"></div></main>
  </div>`;
  updateSideUser();
  document.getElementById('tb-right').innerHTML = `<span class="tb-chip">${icon('user', 12)} ${esc(u.name)} · ${esc(roleInfo(u.role).name)}</span>`;
  app.querySelectorAll('.nav button').forEach((b) => (b.onclick = () => go(b.dataset.route)));
  app.querySelector('#logout').onclick = async () => {
    try { await api('auth:logout'); } catch {}
    showLogin();
  };
  startPolling();
  go(analyst ? 'myfloor' : 'dashboard');
}

function updateSideUser() {
  const el = document.getElementById('side-user');
  if (!el || !state.user) return;
  const u = state.user;
  const fl = state.floors;
  let sub = esc(roleInfo(u.role).name);
  if (u.role === 'analista') {
    sub = fl.length
      ? `${fl.map((f) => `<i class="dot" style="background:${esc(f.color)}"></i>`).join('')}${fl.length === 1 ? esc(fl[0].name) : `${fl.length} andares`}`
      : '<i class="dot" style="background:#64748b"></i>Sem andar';
  }
  el.innerHTML = `<div class="avatar">${esc(initials(u.name))}</div>
    <div class="who"><b>${esc(u.name)}</b><span title="${esc(fl.map((f) => f.name).join(', '))}">${sub}</span></div>`;
}

const VIEWS = {
  dashboard: viewDashboard,
  lots: viewLots,
  lot: viewLot,
  users: viewUsers,
  floors: viewFloors,
  history: viewHistory,
  settings: viewSettings,
  myfloor: viewMyFloor,
};

async function go(route, params = {}) {
  state.route = route;
  state.params = params;
  const r = route === 'lot' ? 'lots' : route;
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.route === r));
  await render();
}

function captureFocus(view) {
  const a = document.activeElement;
  if (!a || !view.contains(a) || !a.id) return null;
  return { id: a.id, start: a.selectionStart, end: a.selectionEnd };
}
function restoreFocus(view, f) {
  if (!f) return;
  const el = view.querySelector('#' + CSS.escape(f.id));
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(f.start, f.end); } catch {}
}

async function render({ silent = false } = {}) {
  const view = document.getElementById('view');
  if (!view || !VIEWS[state.route]) return;
  const token = ++state.renderToken;
  const scroller = document.getElementById('content');
  const scroll = scroller.scrollTop;
  const focus = captureFocus(view);
  const ctx = {
    el: view,
    silent,
    stale: () => token !== state.renderToken,
    mount(html) {
      if (token !== state.renderToken) return false;
      cleanup(state.viewCleanups);
      view.innerHTML = html;
      return true;
    },
    onCleanup: (fn) => state.viewCleanups.push(fn),
  };
  if (!silent) {
    cleanup(state.viewCleanups);
    view.classList.remove('enter');
    view.innerHTML = `<div class="loading-view">${cube(46)}</div>`;
  }
  try {
    await VIEWS[state.route](ctx, state.params);
    if (ctx.stale()) return;
    view.querySelectorAll('[data-tilt]').forEach((el) => tilt(el, 6));
    if (silent) {
      scroller.scrollTop = scroll;
      restoreFocus(view, focus);
    } else {
      scroller.scrollTop = 0;
      void view.offsetWidth;
      view.classList.add('enter');
    }
  } catch (e) {
    if (ctx.stale() || e.code === 'AUTH' || silent) return;
    ctx.mount(emptyBox('alert', 'Não foi possível carregar', e.message, `<button class="btn primary" id="retry">${icon('refresh', 16)} Tentar novamente</button>`));
    view.querySelector('#retry').onclick = () => render();
  }
}

async function refresh() {
  try { state.stamp = await api('db:stamp'); } catch {}
  await render({ silent: true });
}

function startPolling() {
  stopPolling();
  api('db:stamp').then((s) => (state.stamp = s)).catch(() => {});
  state.poll = setInterval(async () => {
    if (document.hidden || !state.user) return;
    try {
      const s = await api('db:stamp');
      if (state.stamp && s !== state.stamp) {
        if (document.querySelector('.modal-back') || state.busy) return;
        state.stamp = s;
        render({ silent: true });
      } else state.stamp = s;
    } catch {}
  }, 4000);
}
function stopPolling() {
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

/* ------------------------------------------------------------------ */
/* ADMIN · Painel                                                      */
/* ------------------------------------------------------------------ */
const floorRow = (f) => `<div class="floor-row" data-id="${esc(f.id)}">
  <div class="floor-cube" style="--c:${esc(f.color)}">${esc(f.code)}</div>
  <div class="fr-main">
    <div class="fr-top"><b>${esc(f.name)}</b><span class="muted small">${fmtN(f.assigned)} distribuída(s)</span></div>
    ${progress(f.printed, f.total, f.color)}
    <div class="fr-chips">${f.analysts.length
      ? f.analysts.map((a) => `<span class="chip">${icon('user', 11)} ${esc(a)}</span>`).join('')
      : '<span class="chip" style="color:var(--amber)">Nenhum analista</span>'}</div>
  </div>
  <div class="fr-num"><b>${fmtN(f.printed)}/${fmtN(f.total)}</b><span>impressas</span></div>
</div>`;

async function viewDashboard(ctx) {
  const d = await api('admin:dashboard');
  const t = d.totals;
  const manage = canManage();
  const admin = isAdmin();
  const title = { admin: 'Painel do administrador', supervisor: 'Painel do supervisor' }[state.user.role] || 'Painel de consulta';
  const ok = ctx.mount(`
    <div class="page-head">
      <div><h1>${esc(title)}</h1><p>Visão geral dos lotes, andares e impressões, atualizada automaticamente.${manage ? '' : ' Modo somente leitura.'}</p></div>
      <div class="actions">
        <button class="btn ghost" data-go="lots">${icon('package', 16)} Ver lotes</button>
        ${manage ? `<button class="btn primary" id="new-lot">${icon('plus', 16)} Novo lote</button>` : ''}
      </div>
    </div>
    <div class="stats">
      ${statCard('Lotes em andamento', t.activeLots, `${fmtN(t.lots)} lote(s) no total`, 'package', 'cyan')}
      ${statCard('Etiquetas cadastradas', t.labels, `${fmtN(t.unassigned)} aguardando distribuição`, 'barcode', 'violet')}
      ${statCard('Impressas', t.printed, `${fmtN(t.printedToday)} impressa(s) hoje`, 'printer', 'green')}
      ${statCard('Pendentes', t.pending, `${fmtN(t.analysts)} analista(s) ativo(s)`, 'clock', 'amber')}
    </div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>${icon('building')} Prédio de estoque</h2><span class="muted small">Clique em um andar · arraste para girar</span></div>
        <div class="tower-wrap" id="tower"></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>${icon('layers')} Andares e analistas</h2>${admin ? `<button class="btn ghost sm" data-go="users">${icon('users', 14)} Usuários</button>` : ''}</div>
        <div class="floor-list">${d.floors.length
          ? d.floors.slice().reverse().map(floorRow).join('')
          : emptyBox('layers', 'Nenhum andar cadastrado', admin ? 'Cadastre os andares do estoque.' : 'O administrador ainda não cadastrou os andares.',
            admin ? '<button class="btn primary" data-go="floors">Cadastrar andares</button>' : '')}</div>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h2>${icon('clock')} Atividade recente</h2><button class="btn ghost sm" data-go="history">Ver histórico completo</button></div>
      ${d.recent.length ? `<div class="activity">${d.recent.map(actRow).join('')}</div>` : emptyBox('clock', 'Sem atividade ainda', '')}
    </section>`);
  if (!ok) return;
  bindGo(ctx.el);
  ctx.el.querySelector('#new-lot')?.addEventListener('click', newLotModal);
  mountTower(ctx, ctx.el.querySelector('#tower'), {
    floors: d.floors,
    onSelect: (f) => {
      ctx.el.querySelectorAll('.floor-row').forEach((r) => r.classList.toggle('active', r.dataset.id === f.id));
      ctx.el.querySelector(`.floor-row[data-id="${CSS.escape(f.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  });
}

/* ------------------------------------------------------------------ */
/* ADMIN · Lotes                                                       */
/* ------------------------------------------------------------------ */
async function viewLots(ctx) {
  const lots = await api('lots:list');
  const vs = viewState('lots', () => ({ q: '' }));
  const manage = canManage();
  const ok = ctx.mount(`
    <div class="page-head">
      <div><h1>Lotes</h1><p>${manage
        ? 'Crie lotes, importe as etiquetas e distribua para os analistas de cada andar.'
        : 'Acompanhe os lotes, a distribuição e o andamento das impressões (somente leitura).'}</p></div>
      ${manage ? `<div class="actions"><button class="btn primary" id="new-lot">${icon('plus', 16)} Novo lote</button></div>` : ''}
    </div>
    <section class="card">
      <div class="toolbar">
        <div class="input-icon">${icon('search', 16)}<input type="search" id="lots-q" placeholder="Buscar lote..." value="${esc(vs.q)}"></div>
        <div class="grow"></div><span class="muted small">${fmtN(lots.length)} lote(s)</span>
      </div>
      <div id="lots-table"></div>
    </section>`);
  if (!ok) return;
  const paint = () => {
    const q = normText(vs.q);
    const rows = lots.filter((l) => !q || normText(`${l.code} ${l.description}`).includes(q));
    const box = ctx.el.querySelector('#lots-table');
    if (!lots.length) {
      box.innerHTML = manage
        ? emptyBox('package', 'Nenhum lote ainda', 'Crie o primeiro lote para começar a importar etiquetas.',
          `<button class="btn primary" id="empty-new">${icon('plus', 16)} Criar lote</button>`)
        : emptyBox('package', 'Nenhum lote ainda', 'Os lotes criados pelo administrador ou supervisor aparecerão aqui.');
      box.querySelector('#empty-new')?.addEventListener('click', newLotModal);
      return;
    }
    if (!rows.length) {
      box.innerHTML = emptyBox('search', 'Nenhum lote encontrado', '');
      return;
    }
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Lote</th><th>Descrição</th><th>Criado em</th><th class="num">Etiquetas</th><th class="num">Distribuídas</th><th>Impressão</th><th>Status</th></tr></thead>
      <tbody>${rows.map((l) => `<tr class="clickable" data-id="${esc(l.id)}">
        <td class="code">${esc(l.code)}</td>
        <td class="desc">${esc(l.description || '—')}</td>
        <td class="nowrap">${fmtDT(l.createdAt)}</td>
        <td class="num">${fmtN(l.stats.total)}</td>
        <td class="num">${fmtN(l.stats.assigned)}</td>
        <td><div class="prog">${progress(l.stats.printed, l.stats.total)}<span>${pct(l.stats.printed, l.stats.total)}%</span></div></td>
        <td>${statusPill(l.stats.status)}</td>
      </tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => go('lot', { id: tr.dataset.id })));
  };
  paint();
  ctx.el.querySelector('#lots-q').oninput = (e) => {
    vs.q = e.target.value;
    paint();
  };
  ctx.el.querySelector('#new-lot')?.addEventListener('click', newLotModal);
}

function newLotModal() {
  openModal({
    title: 'Novo lote',
    body: `<form class="form">
      <label>Código do lote <small>Deixe em branco para gerar automaticamente</small><input type="text" name="code" maxlength="40" placeholder="Ex.: L20261111-01"></label>
      <label>Descrição<input type="text" name="description" maxlength="200" placeholder="Ex.: Recebimento fornecedor ABC"></label>
      <button type="submit" hidden></button>
    </form>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Criar lote', kind: 'primary', icon: 'check',
        onClick: async (m) => {
          const lot = await api('lots:create', formData(m.body.querySelector('form')));
          toast(`Lote ${lot.code} criado. Agora adicione as etiquetas.`, 'success');
          setTimeout(async () => {
            await go('lot', { id: lot.id });
            addLabelsModal(lot.id);
          }, 50);
        },
      },
    ],
  });
}

function editLotModal(lot) {
  openModal({
    title: 'Editar lote',
    body: `<form class="form">
      <label>Código do lote<input type="text" name="code" maxlength="40" value="${esc(lot.code)}"></label>
      <label>Descrição<input type="text" name="description" maxlength="200" value="${esc(lot.description)}"></label>
      <button type="submit" hidden></button>
    </form>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar', kind: 'primary', icon: 'check',
        onClick: async (m) => {
          await api('lots:update', { id: lot.id, ...formData(m.body.querySelector('form')) });
          toast('Lote atualizado.', 'success');
          refresh();
        },
      },
    ],
  });
}

/** Uma opção por (analista, andar): o andar escolhido é o destino das etiquetas que estão em um andar que ele não atende. */
function analystOptions(floors, analysts) {
  return floors
    .map((f) => {
      const list = analysts.filter((a) => (a.floorIds || []).includes(f.id));
      if (!list.length) return '';
      return `<optgroup label="${esc(f.name)}">${list.map((a) => `<option value="${esc(a.id)}|${esc(f.id)}">${esc(a.name)} — ${esc(f.name)}</option>`).join('')}</optgroup>`;
    })
    .join('');
}

async function viewLot(ctx, { id }) {
  const d = await api('lots:get', { id });
  const { lot, stats, labels, floors, users } = d;
  const vs = viewState('lot:' + id, () => ({ floor: '', status: '', q: '', sel: new Set(), limit: 300 }));
  const lmap = new Map(labels.map((l) => [l.id, l]));
  for (const s of [...vs.sel]) if (!lmap.has(s)) vs.sel.delete(s);
  const fmap = new Map(floors.map((f) => [f.id, f]));
  const umap = new Map(users.map((u) => [u.id, u]));
  const analysts = users.filter((u) => u.role === 'analista' && u.active);
  const manage = canManage();

  const perFloor = new Map();
  const perAnalyst = new Map();
  for (const l of labels) {
    const k = l.floorId || '';
    const s = perFloor.get(k) || { total: 0, assigned: 0, printed: 0 };
    s.total++;
    if (l.analystId) {
      s.assigned++;
      perAnalyst.set(l.analystId, (perAnalyst.get(l.analystId) || 0) + 1);
    }
    if (l.printCount > 0) s.printed++;
    perFloor.set(k, s);
  }
  const distCards = floors
    .filter((f) => perFloor.has(f.id))
    .map((f) => {
      const s = perFloor.get(f.id);
      const fa = analysts.filter((a) => a.floorIds.includes(f.id));
      const done = s.assigned === s.total;
      return `<div class="dist-card">
        <div class="dc-top">${floorTag(f)}<span class="pill ${done ? 'green' : 'amber'}">${done ? 'Distribuído' : `${fmtN(s.total - s.assigned)} a distribuir`}</span></div>
        <div class="dc-nums"><div><b>${fmtN(s.total)}</b>etiquetas</div><div><b>${fmtN(s.assigned)}</b>distribuídas</div><div><b>${fmtN(s.printed)}</b>impressas</div></div>
        ${progress(s.printed, s.total, f.color)}
        ${fa.length
          ? `<div class="fr-chips">${fa.map((a) => `<span class="chip">${icon('user', 11)} ${esc(a.name)} · ${fmtN(perAnalyst.get(a.id) || 0)}</span>`).join('')}</div>`
          : `<div class="warn">${icon('alert', 14)} Nenhum analista ativo neste andar</div>`}
      </div>`;
    });
  if (perFloor.has('')) {
    const s = perFloor.get('');
    distCards.push(`<div class="dist-card">
      <div class="dc-top"><span class="pill amber">${icon('alert', 12)} Sem andar definido</span><button class="btn ghost sm" id="filter-nofloor">Ver</button></div>
      <div class="dc-nums"><div><b>${fmtN(s.total)}</b>etiquetas</div><div><b>${fmtN(s.assigned)}</b>distribuídas</div></div>
      <div class="warn">${manage ? 'Selecione essas etiquetas e atribua a um analista, ou edite o andar delas.' : 'Essas etiquetas ainda precisam de um andar.'}</div>
    </div>`);
  }

  const ok = ctx.mount(`
    <button class="back-link" id="back">${icon('back', 16)} Lotes</button>
    <div class="page-head">
      <div><h1>Lote ${esc(lot.code)} ${statusPill(stats.status)}</h1>
        <p>${esc(lot.description || 'Sem descrição')} · criado em ${fmtDT(lot.createdAt)}${lot.createdBy ? ` por ${esc(lot.createdBy)}` : ''}</p></div>
      ${manage ? `<div class="actions">
        <button class="btn ghost" id="edit-lot">${icon('edit', 16)} Editar</button>
        <button class="btn ghost" id="del-lot">${icon('trash', 16)} Excluir</button>
        <button class="btn ghost" id="add">${icon('upload', 16)} Adicionar etiquetas</button>
        <button class="btn primary" id="auto" ${labels.length ? '' : 'disabled'}>${icon('shuffle', 16)} Distribuir por andar</button>
      </div>` : ''}
    </div>
    <div class="stats">
      ${statCard('Etiquetas no lote', stats.total, `${fmtN(perFloor.get('')?.total || 0)} sem andar definido`, 'barcode', 'violet')}
      ${statCard('Distribuídas', stats.assigned, `${fmtN(stats.total - stats.assigned)} aguardando`, 'shuffle', 'cyan')}
      ${statCard('Impressas', stats.printed, `${pct(stats.printed, stats.total)}% concluído`, 'printer', 'green')}
      ${statCard('Pendentes', stats.pending, 'ainda não impressas', 'clock', 'amber')}
    </div>
    ${labels.length ? `<section class="card">
      <div class="card-head"><h2>${icon('layers')} Distribuição por andar</h2>
        ${manage ? '<span class="muted small">"Distribuir por andar" envia cada etiqueta ao(s) analista(s) do andar dela, equilibrando a quantidade.</span>' : ''}</div>
      <div class="dist-grid">${distCards.join('')}</div>
    </section>` : ''}
    <section class="card">
      <div class="card-head"><h2>${icon('barcode')} Etiquetas</h2></div>
      ${labels.length ? `
        <div class="toolbar">
          <div class="input-icon">${icon('search', 16)}<input type="search" id="lot-q" placeholder="Buscar código, descrição..." value="${esc(vs.q)}"></div>
          <select id="lot-floor"><option value="">Todos os andares</option>${floors.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}<option value="__none">Sem andar</option></select>
          <select id="lot-status"><option value="">Todos os status</option><option value="unassigned">Sem distribuição</option><option value="pending">Pendentes</option><option value="printed">Impressas</option></select>
          <div class="grow"></div><span class="muted small" id="lot-count"></span>
        </div>
        <div id="bulk"></div>
        <div id="lot-table"></div>`
        : manage
          ? emptyBox('barcode', 'Nenhuma etiqueta neste lote', 'Cole as linhas do Excel ou importe um arquivo CSV.', `<button class="btn primary" id="empty-add">${icon('upload', 16)} Adicionar etiquetas</button>`)
          : emptyBox('barcode', 'Nenhuma etiqueta neste lote', '')}
    </section>`);
  if (!ok) return;

  const $ = (s) => ctx.el.querySelector(s);
  $('#back').onclick = () => go('lots');
  if (manage) {
    $('#edit-lot').onclick = () => editLotModal(lot);
    $('#add').onclick = () => addLabelsModal(id);
    $('#empty-add')?.addEventListener('click', () => addLabelsModal(id));
    $('#del-lot').onclick = async () => {
      const yes = await confirmDialog({
        title: 'Excluir lote',
        message: `Excluir o lote ${lot.code} e suas ${fmtN(labels.length)} etiqueta(s)?\nEssa ação não pode ser desfeita.`,
        okLabel: 'Excluir lote', danger: true,
      });
      if (!yes) return;
      try {
        await api('lots:delete', { id });
        toast('Lote excluído.', 'success');
        go('lots');
      } catch (e) { toast(e.message, 'error'); }
    };
    $('#auto').onclick = async () => {
      const btn = $('#auto');
      btn.classList.add('loading');
      btn.disabled = true;
      try {
        const r = await api('dist:auto', { lotId: id });
        toast(r.assigned ? `${fmtN(r.assigned)} etiqueta(s) distribuída(s) para os analistas.` : 'Nenhuma etiqueta nova para distribuir.', r.assigned ? 'success' : 'info');
        if (r.noFloor) toast(`${fmtN(r.noFloor)} etiqueta(s) sem andar definido — atribua manualmente.`, 'warn', 7000);
        if (r.missingFloors.length) {
          toast(`Sem analista ativo em: ${r.missingFloors.map((m) => `${m.name} (${m.count})`).join(', ')}. Cadastre um analista nesse andar.`, 'warn', 8000);
        }
        await refresh();
      } catch (e) {
        toast(e.message, 'error');
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    };
  }
  $('#filter-nofloor')?.addEventListener('click', () => {
    vs.floor = '__none';
    $('#lot-floor').value = '__none';
    paintTable();
    $('#lot-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  if (!labels.length) return;

  $('#lot-floor').value = vs.floor;
  $('#lot-status').value = vs.status;

  const filtered = () => {
    const q = normText(vs.q);
    return labels.filter(
      (l) =>
        (!vs.floor || (vs.floor === '__none' ? !l.floorId : l.floorId === vs.floor)) &&
        (!vs.status || (vs.status === 'unassigned' ? !l.analystId : vs.status === 'pending' ? !(l.printCount > 0) : l.printCount > 0)) &&
        (!q || normText(`${l.code} ${l.description} ${l.address}`).includes(q))
    );
  };

  const statusCell = (l) =>
    l.printCount > 0
      ? `<span class="status-printed">${icon('check', 14)} Impressa ${fmtDT(l.printedAt)}${l.printCount > 1 ? ` (${l.printCount}x)` : ''}</span>`
      : l.analystId
        ? '<span class="status-pending">Pendente</span>'
        : '<span class="pill amber">Sem distribuição</span>';
  const analystCell = (l) => {
    if (!l.analystId) return '<span class="muted">—</span>';
    const a = umap.get(l.analystId);
    if (!a) return '<span class="muted">Usuário removido</span>';
    const warn = !a.active || !(a.floorIds || []).includes(l.floorId);
    return `${esc(a.name)}${warn ? ` <span title="Analista inativo ou que não atende este andar" style="color:var(--amber)">${icon('alert', 13)}</span>` : ''}`;
  };

  function paintBulk() {
    const el = $('#bulk');
    const n = vs.sel.size;
    if (!n || !manage) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<div class="bulkbar">
      <b>${fmtN(n)} selecionada(s)</b>
      <select id="assign-to"><option value="">Atribuir ao analista...</option>${analystOptions(floors, analysts)}</select>
      <button class="btn primary sm" id="b-assign">${icon('check', 14)} Atribuir</button>
      <button class="btn ghost sm" id="b-unassign">${icon('undo', 14)} Remover distribuição</button>
      <button class="btn ghost sm" id="b-reset">${icon('refresh', 14)} Voltar para pendente</button>
      <button class="btn ghost sm" id="b-print">${icon('printer', 14)} Imprimir</button>
      <button class="btn ghost sm" id="b-del">${icon('trash', 14)} Excluir</button>
      <div class="grow"></div>
      <button class="btn ghost sm" id="b-clear">Limpar seleção</button>
    </div>`;
    const sel = () => [...vs.sel];
    el.querySelector('#b-clear').onclick = () => {
      vs.sel.clear();
      paintTable();
    };
    el.querySelector('#b-assign').onclick = async () => {
      const [aid, targetFloor] = el.querySelector('#assign-to').value.split('|');
      if (!aid) return toast('Escolha o analista na lista.', 'warn');
      const a = analysts.find((x) => x.id === aid);
      const moving = sel().filter((i) => {
        const l = lmap.get(i);
        return l.floorId && !a.floorIds.includes(l.floorId);
      }).length;
      if (moving) {
        const yes = await confirmDialog({
          title: 'Mudar o andar das etiquetas?',
          message: `${moving} etiqueta(s) selecionada(s) estão em um andar que ${a.name} não atende.\nAo atribuir, elas passarão para o ${fmap.get(targetFloor)?.name || 'andar escolhido'}.`,
          okLabel: 'Atribuir mesmo assim',
        });
        if (!yes) return;
      }
      try {
        const r = await api('dist:assign', { labelIds: sel(), analystId: aid, floorId: targetFloor });
        toast(`${fmtN(r.count)} etiqueta(s) atribuída(s) para ${r.analyst}.`, 'success');
        vs.sel.clear();
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
    el.querySelector('#b-unassign').onclick = async () => {
      try {
        const r = await api('dist:unassign', { labelIds: sel() });
        toast(`${fmtN(r.count)} etiqueta(s) voltaram para distribuição.`, 'success');
        vs.sel.clear();
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
    el.querySelector('#b-reset').onclick = async () => {
      const yes = await confirmDialog({
        title: 'Voltar para pendente',
        message: 'As etiquetas selecionadas voltarão a ficar pendentes, permitindo que o analista imprima novamente.',
        okLabel: 'Voltar para pendente',
      });
      if (!yes) return;
      try {
        const r = await api('labels:resetPrint', { ids: sel() });
        toast(`${fmtN(r.reset)} etiqueta(s) liberada(s) para nova impressão.`, 'success');
        vs.sel.clear();
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
    el.querySelector('#b-print').onclick = () => printFlow(sel(), 'print', () => vs.sel.clear());
    el.querySelector('#b-del').onclick = async () => {
      const yes = await confirmDialog({
        title: 'Excluir etiquetas',
        message: `Excluir ${fmtN(n)} etiqueta(s) deste lote? Essa ação não pode ser desfeita.`,
        okLabel: 'Excluir', danger: true,
      });
      if (!yes) return;
      try {
        const r = await api('labels:delete', { ids: sel() });
        toast(`${fmtN(r.removed)} etiqueta(s) excluída(s).`, 'success');
        vs.sel.clear();
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  function paintTable() {
    const rows = filtered();
    const shown = rows.slice(0, vs.limit);
    $('#lot-count').textContent = `${fmtN(rows.length)} de ${fmtN(labels.length)} etiqueta(s)`;
    const allSel = rows.length > 0 && rows.every((r) => vs.sel.has(r.id));
    $('#lot-table').innerHTML = rows.length
      ? `<div class="table-wrap tall"><table class="table">
        <thead><tr>
          ${manage ? `<th class="w-check"><input type="checkbox" id="sel-all" ${allSel ? 'checked' : ''} title="Selecionar todas as filtradas"></th>` : ''}
          <th>Código</th><th>Descrição</th><th>Endereço</th><th class="num">Qtd</th><th>Andar</th><th>Analista</th><th>Status</th>${manage ? '<th></th>' : ''}
        </tr></thead>
        <tbody>${shown.map((l) => `<tr class="${manage ? 'clickable' : ''} ${vs.sel.has(l.id) ? 'sel' : ''}" data-id="${esc(l.id)}">
          ${manage ? `<td><input type="checkbox" data-sel ${vs.sel.has(l.id) ? 'checked' : ''}></td>` : ''}
          <td class="code">${esc(l.code)}</td>
          <td class="desc" title="${esc(l.description)}">${esc(l.description || '—')}</td>
          <td class="nowrap">${esc(l.address || '—')}</td>
          <td class="num">${esc(l.qty || '—')}</td>
          <td>${floorTag(fmap.get(l.floorId))}</td>
          <td class="nowrap">${analystCell(l)}</td>
          <td>${statusCell(l)}</td>
          ${manage ? `<td class="actions-cell"><button class="icon-btn" data-edit title="Editar etiqueta">${icon('edit', 15)}</button></td>` : ''}
        </tr>`).join('')}</tbody></table>
        ${rows.length > shown.length ? `<div class="more-row"><button class="btn ghost sm" id="more">Mostrar mais (${fmtN(rows.length - shown.length)} restantes)</button></div>` : ''}
        </div>`
      : emptyBox('search', 'Nenhuma etiqueta com esses filtros', '');
    $('#sel-all')?.addEventListener('change', (e) => {
      rows.forEach((r) => (e.target.checked ? vs.sel.add(r.id) : vs.sel.delete(r.id)));
      paintTable();
    });
    $('#more')?.addEventListener('click', () => {
      vs.limit += 500;
      paintTable();
    });
    paintBulk();
  }

  $('#lot-table').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || !manage) return;
    const l = lmap.get(tr.dataset.id);
    if (e.target.closest('[data-edit]')) return editLabelModal(l, floors);
    if (e.target.matches('input[data-sel]')) {
      e.target.checked ? vs.sel.add(l.id) : vs.sel.delete(l.id);
    } else {
      vs.sel.has(l.id) ? vs.sel.delete(l.id) : vs.sel.add(l.id);
    }
    paintTable();
  });
  $('#lot-q').oninput = debounce((e) => {
    vs.q = e.target.value;
    paintTable();
  }, 150);
  $('#lot-floor').onchange = (e) => {
    vs.floor = e.target.value;
    paintTable();
  };
  $('#lot-status').onchange = (e) => {
    vs.status = e.target.value;
    paintTable();
  };
  paintTable();
}

function editLabelModal(l, floors) {
  openModal({
    title: `Editar etiqueta ${l.code}`,
    body: `<form class="form cols-2">
      <label>Código *<input type="text" name="code" maxlength="60" value="${esc(l.code)}"></label>
      <label>Quantidade<input type="text" name="qty" maxlength="20" value="${esc(l.qty)}"></label>
      <label class="span-2">Descrição<input type="text" name="description" maxlength="160" value="${esc(l.description)}"></label>
      <label>Endereço<input type="text" name="address" maxlength="60" value="${esc(l.address)}"></label>
      <label>Andar<select name="floorId"><option value="">— sem andar —</option>${floors.map((f) => `<option value="${esc(f.id)}" ${f.id === l.floorId ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <p class="help span-2">${icon('info', 13)} Se o andar mudar para um que o analista atual não atende, a etiqueta volta para "sem distribuição".</p>
      <button type="submit" hidden></button>
    </form>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Salvar', kind: 'primary', icon: 'check',
        onClick: async (m) => {
          await api('labels:update', { id: l.id, ...formData(m.body.querySelector('form')) });
          toast('Etiqueta atualizada.', 'success');
          refresh();
        },
      },
    ],
  });
}

async function addLabelsModal(lotId) {
  let floors;
  try {
    floors = await api('floors:list');
  } catch (e) {
    return toast(e.message, 'error');
  }
  const opts = `<option value="">— nenhum —</option>${floors.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}`;
  const manual = [];
  let built = { valid: [], invalid: 0, header: false };

  const m = openModal({
    title: 'Adicionar etiquetas ao lote',
    size: 'xl',
    body: `
      <div class="import-help">${icon('info', 14)} Copie as linhas no Excel e cole abaixo (Ctrl+V) ou importe um arquivo CSV.
        Ordem das colunas: <b>Código · Descrição · Endereço · Quantidade · Andar</b>.
        Se a primeira linha tiver os nomes das colunas, a ordem pode ser qualquer uma.</div>
      <div class="import-row">
        <button type="button" class="btn ghost sm" id="csv">${icon('upload', 14)} Importar arquivo CSV</button>
        <button type="button" class="btn ghost sm" id="example">${icon('file', 14)} Inserir exemplo</button>
        <div class="grow"></div>
        <label class="small muted" style="display:flex;gap:8px;align-items:center">Andar para linhas sem andar: <select id="def-floor">${opts}</select></label>
      </div>
      <textarea id="paste" rows="8" placeholder="SKU-001;Parafuso sextavado 5mm;A-01-02;100;2º Andar"></textarea>
      <details class="manual"><summary>Adicionar uma etiqueta manualmente</summary>
        <div class="mrow">
          <input type="text" id="m-code" placeholder="Código *" maxlength="60">
          <input type="text" id="m-desc" placeholder="Descrição" maxlength="160">
          <input type="text" id="m-addr" placeholder="Endereço" maxlength="60">
          <input type="text" id="m-qty" placeholder="Qtd" maxlength="20">
          <select id="m-floor">${opts}</select>
          <button type="button" class="btn ghost sm" id="m-add">${icon('plus', 14)} Incluir</button>
        </div>
      </details>
      <div id="preview"></div>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Adicionar etiquetas', kind: 'primary', icon: 'check',
        onClick: async () => {
          if (!built.valid.length) {
            toast('Nenhuma linha válida para adicionar (o código é obrigatório).', 'warn');
            return false;
          }
          const r = await api('labels:add', {
            lotId,
            rows: built.valid.map((x) => ({ code: x.code, description: x.description, address: x.address, qty: x.qty, floorId: x.floor ? x.floor.id : null })),
          });
          toast(`${fmtN(r.added)} etiqueta(s) adicionada(s) ao lote.`, 'success');
          refresh();
        },
      },
    ],
  });

  const $ = (s) => m.body.querySelector(s);
  const primaryLabel = m.el.querySelector('[data-act="1"] span');

  const build = () => {
    const parsed = parseTable($('#paste').value);
    const def = floors.find((f) => f.id === $('#def-floor').value) || null;
    const all = [...parsed.rows, ...manual];
    const valid = [];
    let invalid = 0;
    for (const r of all) {
      if (!String(r.code || '').trim()) {
        invalid++;
        continue;
      }
      const floor = r.floorId ? floors.find((f) => f.id === r.floorId) : r.floor ? resolveFloor(r.floor, floors) : def;
      valid.push({ ...r, floor: floor || (r.floor ? null : def), unknownFloor: r.floor && !floor ? r.floor : '' });
    }
    return { valid, invalid, header: parsed.header };
  };

  const paint = () => {
    built = build();
    const v = built.valid;
    primaryLabel.textContent = v.length ? `Adicionar ${fmtN(v.length)} etiqueta(s)` : 'Adicionar etiquetas';
    if (!v.length && !built.invalid) {
      $('#preview').innerHTML = '';
      return;
    }
    const byFloor = new Map();
    let noFloor = 0;
    let unknown = 0;
    for (const r of v) {
      if (r.floor) byFloor.set(r.floor.id, (byFloor.get(r.floor.id) || 0) + 1);
      else noFloor++;
      if (r.unknownFloor) unknown++;
    }
    $('#preview').innerHTML = `
      <div class="preview-summary">
        <span class="pill cyan">${fmtN(v.length)} etiqueta(s) válida(s)</span>
        ${[...byFloor.entries()].map(([fid, n]) => {
          const f = floors.find((x) => x.id === fid);
          return `<span class="chip"><i style="width:8px;height:8px;border-radius:50%;background:${esc(f.color)};display:inline-block"></i> ${esc(f.name)}: ${fmtN(n)}</span>`;
        }).join('')}
        ${noFloor ? `<span class="pill amber">${fmtN(noFloor)} sem andar</span>` : ''}
        ${unknown ? `<span class="pill red">${fmtN(unknown)} com andar não reconhecido</span>` : ''}
        ${built.invalid ? `<span class="pill red">${fmtN(built.invalid)} linha(s) sem código (ignoradas)</span>` : ''}
        ${built.header ? '<span class="chip">Cabeçalho detectado</span>' : ''}
      </div>
      <div class="table-wrap preview-table"><table class="table">
        <thead><tr><th>Código</th><th>Descrição</th><th>Endereço</th><th class="num">Qtd</th><th>Andar</th></tr></thead>
        <tbody>${v.slice(0, 80).map((r) => `<tr>
          <td class="code">${esc(r.code)}</td><td class="desc">${esc(r.description || '—')}</td><td>${esc(r.address || '—')}</td>
          <td class="num">${esc(r.qty || '—')}</td>
          <td>${r.floor ? floorTag(r.floor) : r.unknownFloor ? `<span class="pill red" title="Cadastre esse andar ou corrija o nome">"${esc(r.unknownFloor)}" não encontrado</span>` : floorTag(null)}</td>
        </tr>`).join('')}</tbody></table></div>
      ${v.length > 80 ? `<p class="muted small center" style="margin-top:8px">Mostrando 80 de ${fmtN(v.length)} linhas.</p>` : ''}`;
  };
  const paintSoon = debounce(paint, 200);

  $('#paste').addEventListener('input', paintSoon);
  $('#def-floor').addEventListener('change', paint);
  $('#csv').onclick = async () => {
    try {
      const r = await api('file:readCsv');
      if (!r) return;
      $('#paste').value = r.text;
      paint();
      toast(`Arquivo "${r.name}" carregado.`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#example').onclick = () => {
    const names = floors.length ? floors.map((f) => f.name) : ['Térreo'];
    const items = [
      ['Parafuso sextavado 5mm', 'A-01-01', '100'], ['Porca autotravante M6', 'A-01-02', '250'],
      ['Arruela lisa 8mm', 'A-02-01', '500'], ['Abraçadeira nylon 20cm', 'B-01-03', '80'],
      ['Fita isolante 19mm', 'B-02-02', '40'], ['Luva de vaqueta', 'C-01-01', '24'],
      ['Disjuntor 20A', 'C-03-02', '12'], ['Cabo flexível 2,5mm', 'D-01-01', '6'],
    ];
    const lines = ['Código;Descrição;Endereço;Quantidade;Andar'];
    items.forEach((it, i) => lines.push(`SKU-${1001 + i};${it[0]};${it[1]};${it[2]};${names[i % names.length]}`));
    $('#paste').value = lines.join('\n');
    paint();
  };
  $('#m-add').onclick = () => {
    const code = $('#m-code').value.trim();
    if (!code) {
      toast('Informe o código da etiqueta.', 'warn');
      $('#m-code').focus();
      return;
    }
    manual.push({
      code, description: $('#m-desc').value.trim(), address: $('#m-addr').value.trim(), qty: $('#m-qty').value.trim(),
      floor: '', floorId: $('#m-floor').value || null,
    });
    ['#m-code', '#m-desc', '#m-addr', '#m-qty'].forEach((s) => ($(s).value = ''));
    $('#m-code').focus();
    paint();
  };
  setTimeout(() => $('#paste').focus(), 80);
}

/* ------------------------------------------------------------------ */
/* ADMIN · Usuários                                                    */
/* ------------------------------------------------------------------ */
async function viewUsers(ctx) {
  const [users, floors] = await Promise.all([api('users:list'), api('floors:list')]);
  const fmap = new Map(floors.map((f) => [f.id, f]));
  const ok = ctx.mount(`
    <div class="page-head">
      <div><h1>Usuários</h1><p>Quatro níveis de acesso: Administrador, Supervisor, Consulta e Analista.</p></div>
      <div class="actions"><button class="btn primary" id="new-user">${icon('plus', 16)} Novo usuário</button></div>
    </div>
    <div class="role-legend">${['admin', 'supervisor', 'consulta', 'analista'].map((r) => `<div class="rl-item">${rolePill(r)}<span>${esc(roleInfo(r).desc)}</span></div>`).join('')}</div>
    <section class="card">
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Nome</th><th>Perfil</th><th>Andares</th><th class="num">Pendentes</th><th>Último acesso</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr data-id="${esc(u.id)}">
          <td><div style="display:flex;align-items:center;gap:10px"><div class="avatar" style="width:32px;height:32px;font-size:11px;border-radius:10px">${esc(initials(u.name))}</div>
            <div><b>${esc(u.name)}</b>${u.id === state.user.id ? ' <span class="chip">você</span>' : ''}<div class="muted small mono">${esc(u.username)}</div></div></div></td>
          <td>${rolePill(u.role)}</td>
          <td>${u.role === 'analista'
            ? `<div class="floor-tags">${(u.floorIds || []).map((fid) => fmap.get(fid)).filter(Boolean).map(floorTag).join('') || floorTag(null)}</div>`
            : '<span class="muted">Todos</span>'}</td>
          <td class="num">${u.role === 'analista' ? fmtN(u.pending) : '—'}</td>
          <td class="nowrap">${fmtDT(u.lastLoginAt)}</td>
          <td>${u.active ? '<span class="pill green">Ativo</span>' : '<span class="pill gray">Inativo</span>'}</td>
          <td class="actions-cell">
            <button class="icon-btn" data-a="edit" title="Editar">${icon('edit', 15)}</button>
            <button class="icon-btn" data-a="pass" title="Redefinir senha">${icon('key', 15)}</button>
            <button class="icon-btn" data-a="toggle" title="${u.active ? 'Desativar' : 'Ativar'}">${icon('power', 15)}</button>
            <button class="icon-btn danger" data-a="del" title="Excluir">${icon('trash', 15)}</button>
          </td>
        </tr>`).join('')}</tbody></table></div>
    </section>`);
  if (!ok) return;
  ctx.el.querySelector('#new-user').onclick = () => userModal(null, floors);
  ctx.el.querySelector('tbody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const u = users.find((x) => x.id === b.closest('tr').dataset.id);
    const a = b.dataset.a;
    if (a === 'edit') return userModal(u, floors);
    if (a === 'pass') return passwordModal(u);
    if (a === 'toggle') {
      if (u.active) {
        const yes = await confirmDialog({
          title: 'Desativar usuário',
          message: `${u.name} não poderá mais entrar no sistema.${u.pending ? `\nAs ${u.pending} etiqueta(s) pendente(s) dele voltarão para distribuição.` : ''}`,
          okLabel: 'Desativar', danger: true,
        });
        if (!yes) return;
      }
      try {
        await api('users:save', { ...u, active: !u.active });
        toast(u.active ? 'Usuário desativado.' : 'Usuário ativado.', 'success');
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    }
    if (a === 'del') {
      const yes = await confirmDialog({
        title: 'Excluir usuário',
        message: `Excluir ${u.name}? O histórico de impressões dele é mantido.${u.pending ? `\nAs ${u.pending} etiqueta(s) pendente(s) voltarão para distribuição.` : ''}`,
        okLabel: 'Excluir', danger: true,
      });
      if (!yes) return;
      try {
        await api('users:delete', { id: u.id });
        toast('Usuário excluído.', 'success');
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    }
  });
}

function userModal(u, floors) {
  const isNew = !u;
  const role = u ? u.role : 'analista';
  const mine = new Set(u?.floorIds || []);
  openModal({
    title: isNew ? 'Novo usuário' : `Editar ${u.name}`,
    body: `<form class="form cols-2">
      <label class="span-2">Nome completo<input type="text" name="name" maxlength="80" value="${esc(u?.name)}"></label>
      <label>Usuário (login) <small>minúsculas, sem espaços</small><input type="text" name="username" maxlength="40" value="${esc(u?.username)}" placeholder="ex.: ana.souza"></label>
      <label>Perfil<select name="role" id="role">
        ${['analista', 'supervisor', 'consulta', 'admin'].map((r) => `<option value="${r}" ${role === r ? 'selected' : ''}>${esc(roleInfo(r).name)}</option>`).join('')}
      </select></label>
      <p class="help span-2" id="role-desc"></p>
      <fieldset class="span-2 floor-picks" id="floor-field">
        <legend>Andares de estoque <small>o analista só verá e imprimirá as etiquetas dos andares marcados</small></legend>
        ${floors.length
          ? floors.map((f) => `<label class="floor-pick"><input type="checkbox" data-floor value="${esc(f.id)}" ${mine.has(f.id) ? 'checked' : ''}>${floorTag(f)}</label>`).join('')
          : '<span class="muted small">Nenhum andar cadastrado. Cadastre os andares primeiro.</span>'}
      </fieldset>
      ${isNew ? '<label class="span-2">Senha inicial <small>mínimo 6 caracteres</small><input type="password" name="password" maxlength="100"></label>' : ''}
      <label class="switch span-2"><input type="checkbox" name="active" ${!u || u.active ? 'checked' : ''}> Usuário ativo</label>
      <button type="submit" hidden></button>
    </form>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: isNew ? 'Criar usuário' : 'Salvar', kind: 'primary', icon: 'check',
        onClick: async (m) => {
          const form = m.body.querySelector('form');
          const d = formData(form);
          d.username = String(d.username || '').trim().toLowerCase();
          d.floorIds = [...form.querySelectorAll('input[data-floor]:checked')].map((i) => i.value);
          await api('users:save', { ...d, id: u?.id });
          toast(isNew ? 'Usuário criado.' : 'Usuário atualizado.', 'success');
          refresh();
        },
      },
    ],
    onMount: (m) => {
      const sync = () => {
        const r = m.body.querySelector('#role').value;
        m.body.querySelector('#floor-field').hidden = r !== 'analista';
        m.body.querySelector('#role-desc').innerHTML = `${icon('info', 13)} ${esc(roleInfo(r).desc)}`;
      };
      m.body.querySelector('#role').onchange = sync;
      sync();
    },
  });
}

function passwordModal(u) {
  openModal({
    title: `Redefinir senha · ${u.name}`,
    body: `<form class="form">
      <label>Nova senha <small>mínimo 6 caracteres</small><input type="password" name="password" maxlength="100"></label>
      <label>Confirmar nova senha<input type="password" name="confirm" maxlength="100"></label>
      <button type="submit" hidden></button>
    </form>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Redefinir senha', kind: 'primary', icon: 'key',
        onClick: async (m) => {
          const d = formData(m.body.querySelector('form'));
          if (d.password !== d.confirm) throw new Error('As senhas não conferem.');
          await api('users:resetPassword', { id: u.id, password: d.password });
          toast('Senha redefinida.', 'success');
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* ADMIN · Andares                                                     */
/* ------------------------------------------------------------------ */
async function viewFloors(ctx) {
  const d = await api('admin:dashboard');
  const floors = d.floors;
  const ok = ctx.mount(`
    <div class="page-head">
      <div><h1>Andares do estoque</h1><p>Cada analista é vinculado a um ou mais andares. O código curto aparece em destaque na etiqueta impressa.</p></div>
      <div class="actions"><button class="btn primary" id="new-floor">${icon('plus', 16)} Novo andar</button></div>
    </div>
    ${floors.length ? `<div class="floor-cards">${floors.map((f) => `<div class="floor-card" data-tilt style="--c:${esc(f.color)}" data-id="${esc(f.id)}">
      <div class="fc-top"><div class="floor-cube" style="--c:${esc(f.color)}">${esc(f.code)}</div><div><b>${esc(f.name)}</b><span class="muted small">Ordem ${esc(f.order)} · código ${esc(f.code)}</span></div></div>
      <div class="fc-stats">
        <div><b>${fmtN(f.analysts.length)}</b><span>analista(s)</span></div>
        <div><b>${fmtN(f.total)}</b><span>etiqueta(s)</span></div>
        <div><b>${fmtN(f.total - f.printed)}</b><span>pendente(s)</span></div>
        <div><b>${pct(f.printed, f.total)}%</b><span>impresso</span></div>
      </div>
      <div class="fc-actions">
        <button class="btn ghost sm" data-a="edit">${icon('edit', 14)} Editar</button>
        <button class="btn ghost sm" data-a="del">${icon('trash', 14)}</button>
      </div>
    </div>`).join('')}</div>` : `<section class="card">${emptyBox('layers', 'Nenhum andar cadastrado', 'Cadastre os andares do estoque para vincular os analistas.')}</section>`}`);
  if (!ok) return;
  ctx.el.querySelector('#new-floor').onclick = () => floorModal(null, floors.length);
  ctx.el.querySelectorAll('.floor-card').forEach((card) => {
    const f = floors.find((x) => x.id === card.dataset.id);
    card.querySelector('[data-a="edit"]').onclick = () => floorModal(f);
    card.querySelector('[data-a="del"]').onclick = async () => {
      const yes = await confirmDialog({ title: 'Excluir andar', message: `Excluir o andar "${f.name}"?`, okLabel: 'Excluir', danger: true });
      if (!yes) return;
      try {
        await api('floors:delete', { id: f.id });
        toast('Andar excluído.', 'success');
        refresh();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function floorModal(f, nextOrder = 0) {
  const colors = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#fb923c', '#60a5fa', '#e879f9'];
  openModal({
    title: f ? `Editar ${f.name}` : 'Novo andar',
    body: `<form class="form cols-2">
      <label class="span-2">Nome<input type="text" name="name" maxlength="40" value="${esc(f?.name)}" placeholder="Ex.: 4º Andar, Mezanino"></label>
      <label>Código curto <small>até 6 caracteres</small><input type="text" name="code" maxlength="6" value="${esc(f?.code)}" placeholder="Ex.: 4, M"></label>
      <label>Ordem (de baixo p/ cima)<input type="number" name="order" value="${esc(f?.order ?? nextOrder)}"></label>
      <label class="span-2">Cor<input type="color" name="color" value="${esc(f?.color || colors[nextOrder % colors.length])}"></label>
      <button type="submit" hidden></button>
    </form>`,
    actions: [
      { label: 'Cancelar' },
      {
        label: f ? 'Salvar' : 'Criar andar', kind: 'primary', icon: 'check',
        onClick: async (m) => {
          await api('floors:save', { ...formData(m.body.querySelector('form')), id: f?.id });
          toast(f ? 'Andar atualizado.' : 'Andar criado.', 'success');
          refresh();
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Histórico                                                           */
/* ------------------------------------------------------------------ */
async function viewHistory(ctx) {
  const admin = seesAll();
  const vs = viewState('history', () => ({ q: '' }));
  const logs = await api('logs:list', { q: vs.q });
  const ok = ctx.mount(`
    <div class="page-head">
      <div><h1>Histórico</h1><p>${admin ? 'Todas as ações registradas no sistema (impressões, distribuições, acessos...).' : 'Suas impressões e acessos.'}</p></div>
    </div>
    <section class="card">
      <div class="toolbar">
        <div class="input-icon">${icon('search', 16)}<input type="search" id="hist-q" placeholder="Buscar por usuário, ação, lote..." value="${esc(vs.q)}"></div>
        <div class="grow"></div><span class="muted small">${logs.length >= 500 ? 'Últimos 500 registros' : `${fmtN(logs.length)} registro(s)`}</span>
      </div>
      ${logs.length ? `<div class="table-wrap tall"><table class="table">
        <thead><tr><th>Data/hora</th>${admin ? '<th>Usuário</th>' : ''}<th>Ação</th><th>Detalhes</th><th>Computador</th></tr></thead>
        <tbody>${logs.map((l) => `<tr>
          <td class="nowrap">${fmtDT(l.at)}</td>
          ${admin ? `<td class="nowrap"><b>${esc(l.userName)}</b></td>` : ''}
          <td class="nowrap"><span style="display:inline-flex;gap:7px;align-items:center">${icon(ACT_ICONS[l.action] || 'info', 14)} ${esc(l.action)}</span></td>
          <td>${esc(l.details)}</td>
          <td class="muted small nowrap">${esc(l.host || '')}</td>
        </tr>`).join('')}</tbody></table></div>` : emptyBox('clock', 'Nenhum registro encontrado', '')}
    </section>`);
  if (!ok) return;
  ctx.el.querySelector('#hist-q').oninput = debounce((e) => {
    vs.q = e.target.value;
    render({ silent: true });
  }, 300);
}

/* ------------------------------------------------------------------ */
/* Configurações                                                       */
/* ------------------------------------------------------------------ */
const UPDATE_TEXT = {
  dev: 'Modo de desenvolvimento — a atualização automática funciona apenas na versão instalada.',
  unconfigured: 'Esta instalação não foi gerada pelo GitHub. Instale pelo instalador do GitHub Releases para receber atualizações automáticas.',
  idle: 'Você está usando a versão mais recente.',
  checking: 'Verificando se há uma nova versão...',
  downloading: 'Baixando nova versão em segundo plano...',
  ready: 'Nova versão baixada e pronta para instalar.',
  error: 'Não foi possível verificar atualizações agora.',
};

async function viewSettings(ctx) {
  const admin = isAdmin();
  const prints = state.user.role !== 'consulta';
  const [cfg, printers, settings, upd] = await Promise.all([
    api('config:get'),
    prints ? api('printers:list').catch(() => []) : [],
    api('settings:get'),
    api('update:status').catch(() => ({ state: 'error' })),
  ]);
  const sampleLabel = {
    code: 'SKU-1001', description: 'Parafuso sextavado 5mm zincado', address: 'A-01-02', qty: '100',
    floorName: state.floors[0]?.name || '2º Andar', floorCode: state.floors[0]?.code || '2', lotCode: 'L20261111-01',
    analystName: state.user.name, date: new Date().toLocaleDateString('pt-BR'),
  };

  const ok = ctx.mount(`
    <div class="page-head"><div><h1>Configurações</h1><p>${admin ? 'Etiqueta, impressora, dados e atualizações.' : prints ? 'Impressora deste computador e sua senha.' : 'Sua senha e as atualizações do sistema.'}</p></div></div>
    <div class="settings-grid">
      <div class="settings-col">
        ${admin ? `<section class="card">
          <div class="card-head"><h2>${icon('barcode')} Modelo da etiqueta</h2></div>
          <form class="form cols-2" id="label-form">
            <label class="span-2">Nome da empresa (aparece na etiqueta)<input type="text" name="companyName" maxlength="60" value="${esc(settings.companyName)}"></label>
            <label>Largura (mm)<input type="number" name="labelWidth" min="30" max="200" value="${esc(settings.labelWidth)}"></label>
            <label>Altura (mm)<input type="number" name="labelHeight" min="20" max="200" value="${esc(settings.labelHeight)}"></label>
            <div class="span-2" style="display:flex;gap:8px;flex-wrap:wrap">${[[100, 50], [100, 70], [100, 150], [80, 40], [60, 40], [50, 30]]
              .map(([w, h]) => `<button type="button" class="btn ghost sm" data-size="${w}x${h}">${w}×${h}</button>`).join('')}</div>
            <label class="switch span-2"><input type="checkbox" name="allowReprint" ${settings.allowReprint ? 'checked' : ''}> Permitir que o analista reimprima etiquetas já impressas</label>
            <div class="span-2 label-sample" id="sample"></div>
            <div class="span-2" style="display:flex;justify-content:flex-end"><button class="btn primary" type="submit">${icon('check', 16)} Salvar modelo</button></div>
          </form>
        </section>` : ''}
        ${prints ? `<section class="card">
          <div class="card-head"><h2>${icon('printer')} Impressora deste computador</h2></div>
          <form class="form" id="printer-form">
            <label>Impressora<select name="printerName">
              <option value="">Perguntar a cada impressão (janela do Windows)</option>
              ${printers.map((p) => `<option value="${esc(p.name)}" ${p.name === cfg.printerName ? 'selected' : ''}>${esc(p.displayName)}</option>`).join('')}
              ${cfg.printerName && !printers.some((p) => p.name === cfg.printerName) ? `<option value="${esc(cfg.printerName)}" selected>${esc(cfg.printerName)} (não encontrada)</option>` : ''}
            </select></label>
            <label class="switch"><input type="checkbox" name="silentPrint" ${cfg.silentPrint ? 'checked' : ''}> Imprimir direto, sem abrir a janela de impressão</label>
            <p class="help">Com "imprimir direto" ligado, as etiquetas vão para a impressora escolhida acima (ou para a impressora padrão do Windows). Para impressoras térmicas (Zebra, Elgin, Argox), configure no driver o mesmo tamanho de etiqueta definido pelo administrador.</p>
            <div style="display:flex;justify-content:flex-end"><button class="btn primary" type="submit">${icon('check', 16)} Salvar impressora</button></div>
          </form>
        </section>` : ''}
      </div>
      <div class="settings-col">
        <section class="card">
          <div class="card-head"><h2>${icon('cloud')} Dados</h2></div>
          <div class="path-box">${icon('cloud', 16)}<span>${esc(cfg.server || '')}</span></div>
          <p class="help" style="margin-top:10px">Os dados ficam no <b>banco de dados do servidor</b>. Todos os computadores com o sistema instalado usam as mesmas informações automaticamente — basta ter internet.</p>
          ${admin ? `<div class="row-actions">
            <button class="btn ghost" id="backup">${icon('download', 16)} Exportar backup (JSON)</button>
          </div>` : ''}
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon('cloud')} Atualizações</h2></div>
          <dl class="kv">
            <dt>Versão instalada</dt><dd><b>${esc(state.info?.version || '')}</b></dd>
            <dt>Situação</dt><dd id="upd-text">${esc(UPDATE_TEXT[upd.state] || '')}${upd.state === 'error' && upd.message ? `<div class="muted small">${esc(upd.message)}</div>` : ''}</dd>
          </dl>
          <p class="help" style="margin-top:10px">As novas versões são publicadas no GitHub. O sistema verifica automaticamente a cada 30 minutos, baixa em segundo plano e instala ao ser fechado.</p>
          <div class="row-actions">
            <button class="btn ghost" id="upd-check" ${upd.state === 'dev' || upd.state === 'unconfigured' ? 'disabled' : ''}>${icon('refresh', 16)} Verificar agora</button>
            ${upd.state === 'ready' ? `<button class="btn primary" id="upd-install">${icon('sparkle', 16)} Reiniciar e atualizar</button>` : ''}
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>${icon('key')} Minha senha</h2></div>
          <form class="form" id="pass-form">
            <label>Senha atual<input type="password" name="current" maxlength="100"></label>
            <label>Nova senha <small>mínimo 6 caracteres</small><input type="password" name="next" maxlength="100"></label>
            <label>Confirmar nova senha<input type="password" name="confirm" maxlength="100"></label>
            <div style="display:flex;justify-content:flex-end"><button class="btn primary" type="submit">${icon('check', 16)} Alterar senha</button></div>
          </form>
        </section>
      </div>
    </div>`);
  if (!ok) return;
  const $ = (s) => ctx.el.querySelector(s);

  if (admin) {
    const lf = $('#label-form');
    const paintSample = () => {
      const d = formData(lf);
      const s = {
        companyName: d.companyName || 'Minha Empresa',
        labelWidth: Math.min(200, Math.max(30, Number(d.labelWidth) || 100)),
        labelHeight: Math.min(200, Math.max(20, Number(d.labelHeight) || 50)),
      };
      $('#sample').innerHTML = `<div class="label-3d">${renderLabelHTML(sampleLabel, s)}</div>`;
      drawBarcodes($('#sample'));
    };
    paintSample();
    lf.addEventListener('input', debounce(paintSample, 150));
    lf.querySelectorAll('[data-size]').forEach((b) => (b.onclick = () => {
      const [w, h] = b.dataset.size.split('x');
      lf.labelWidth.value = w;
      lf.labelHeight.value = h;
      paintSample();
    }));
    lf.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('settings:save', formData(lf));
        toast('Modelo de etiqueta salvo para todos os computadores.', 'success');
        refresh();
      } catch (err) { toast(err.message, 'error'); }
    };
    $('#backup').onclick = async () => {
      try {
        const f = await api('backup:export');
        if (f) toast('Backup exportado.', 'success');
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  if (prints) $('#printer-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('config:setPrinter', formData(e.target));
      toast('Impressora salva para este computador.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#pass-form').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.next !== d.confirm) return toast('As senhas não conferem.', 'error');
    try {
      await api('auth:changePassword', d);
      toast('Senha alterada.', 'success');
      e.target.reset();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#upd-check').onclick = async () => {
    const b = $('#upd-check');
    b.classList.add('loading');
    b.disabled = true;
    try {
      const s = await api('update:check');
      state.update = s;
      renderUpdateBanner();
      $('#upd-text').textContent = UPDATE_TEXT[s.state] || '';
      if (s.state === 'error') toast(s.message || 'Erro ao verificar atualizações.', 'error');
    } finally {
      b.classList.remove('loading');
      b.disabled = false;
    }
  };
  $('#upd-install')?.addEventListener('click', () => api('update:install'));
}

/* ------------------------------------------------------------------ */
/* ANALISTA · Meu andar                                                */
/* ------------------------------------------------------------------ */
async function viewMyFloor(ctx) {
  const d = await api('analyst:overview');
  const vs = viewState('myfloor', () => ({ status: 'pending', q: '', floor: '', sel: new Set() }));
  const myFloors = d.myFloors;
  const sig = (list) => list.map((f) => `${f.id}:${f.name}:${f.color}`).join('|');
  if (sig(myFloors) !== sig(state.floors)) {
    const navChanged = (myFloors.length > 1) !== (state.floors.length > 1);
    state.floors = myFloors.map(({ id, name, code, color, order }) => ({ id, name, code, color, order }));
    updateSideUser();
    if (navChanged) {
      const b = document.querySelector('.nav button[data-route="myfloor"] span');
      if (b) b.textContent = myFloors.length > 1 ? 'Meus andares' : 'Meu andar';
    }
  }
  if (vs.floor && !myFloors.some((f) => f.id === vs.floor)) vs.floor = '';
  const multi = myFloors.length > 1;
  const fmap = new Map(myFloors.map((f) => [f.id, f]));
  const allow = d.settings.allowReprint;
  const main = myFloors[0] || { name: 'Sem andar', code: '-', color: '#64748b' };
  const all = d.lots.flatMap((l) => l.labels);
  const byId = new Map(all.map((l) => [l.id, l]));
  const selectable = (l) => !(l.printCount > 0) || allow;
  for (const s of [...vs.sel]) if (!byId.has(s) || !selectable(byId.get(s))) vs.sel.delete(s);
  const t = d.totals;
  const floorNames = myFloors.map((f) => `<b style="color:${esc(f.color)}">${esc(f.name)}</b>`);
  const namesText = floorNames.length > 1 ? `${floorNames.slice(0, -1).join(', ')} e ${floorNames[floorNames.length - 1]}` : floorNames[0] || '<b>Sem andar</b>';

  const ok = ctx.mount(`
    <div class="page-head">
      <div><h1>Olá, ${esc(firstName(state.user.name))}</h1>
        <p>Aqui aparecem somente as etiquetas ${multi ? 'dos andares' : 'do'} ${namesText} distribuídas para você.</p></div>
      <div class="actions"><button class="btn ghost" id="reload">${icon('refresh', 16)} Atualizar</button></div>
    </div>
    <div class="hello">
      <section class="card">
        <div class="card-head"><h2>${icon('building')} ${multi ? 'Seus andares' : 'Seu andar'} no prédio</h2>
          <div class="floor-hero">${multi
            ? myFloors.map((f) => `<div class="floor-cube sm" style="--c:${esc(f.color)}" title="${esc(f.name)}: ${fmtN(f.printed)} de ${fmtN(f.total)} impressas">${esc(f.code)}</div>`).join('')
            : `<div class="floor-cube" style="--c:${esc(main.color)}">${esc(main.code)}</div><div><b>${esc(main.name)}</b><div class="muted small">${fmtN(t.printed)} de ${fmtN(t.total)} impressas</div></div>`}</div></div>
        <div class="tower-wrap sm" id="tower"></div>
      </section>
      <div class="stats">
        ${statCard('Pendentes para imprimir', t.pending, t.pending ? 'aguardando você' : 'tudo em dia', 'clock', 'amber')}
        ${statCard('Impressas hoje', t.printedToday, 'por você', 'printer', 'green')}
        ${statCard('Total distribuído para você', t.total, `${fmtN(d.lots.length)} lote(s)`, 'barcode', 'cyan')}
      </div>
    </div>
    <section class="card">
      <div class="toolbar">
        <div class="seg" id="seg">
          <button data-s="pending">Pendentes <span class="n">${fmtN(t.pending)}</span></button>
          <button data-s="printed">Impressas <span class="n">${fmtN(t.printed)}</span></button>
          <button data-s="">Todas <span class="n">${fmtN(t.total)}</span></button>
        </div>
        ${multi ? `<select id="my-floor" title="Filtrar por andar"><option value="">Todos os meus andares</option>${myFloors.map((f) => `<option value="${esc(f.id)}" ${vs.floor === f.id ? 'selected' : ''}>${esc(f.name)} (${fmtN(f.total - f.printed)} pend.)</option>`).join('')}</select>` : ''}
        <div class="input-icon">${icon('search', 16)}<input type="search" id="my-q" placeholder="Buscar código, descrição..." value="${esc(vs.q)}"></div>
        <div class="grow"></div>
        <button class="btn ghost" id="sel-visible">${icon('check', 16)} Selecionar visíveis</button>
        <button class="btn ghost" id="pdf">${icon('file', 16)} Salvar PDF</button>
        <button class="btn primary" id="print">${icon('printer', 16)}<span>Imprimir selecionadas (<b id="sel-n">0</b>)</span></button>
      </div>
      ${!allow ? `<p class="help" style="margin:-2px 0 4px">${icon('lock', 13)} A reimpressão está bloqueada pelo administrador: etiquetas já impressas não podem ser impressas novamente.</p>` : ''}
    </section>
    <div id="lots" style="margin-top:14px"></div>`);
  if (!ok) return;
  const $ = (s) => ctx.el.querySelector(s);

  mountTower(ctx, $('#tower'), { floors: d.floors, highlightIds: myFloors.map((f) => f.id) });

  const visible = (l) => {
    const q = normText(vs.q);
    return (!vs.status || (vs.status === 'pending' ? !(l.printCount > 0) : l.printCount > 0)) &&
      (!vs.floor || l.floorId === vs.floor) &&
      (!q || normText(`${l.code} ${l.description} ${l.address}`).includes(q));
  };

  function paintSel() {
    $('#sel-n').textContent = fmtN(vs.sel.size);
    $('#print').disabled = !vs.sel.size;
    $('#pdf').disabled = !vs.sel.size;
  }

  function paintLots() {
    ctx.el.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.s === vs.status));
    const box = $('#lots');
    if (!all.length) {
      box.innerHTML = `<section class="card">${emptyBox('package', 'Nenhuma etiqueta para você ainda',
        `Quando um lote for distribuído para ${multi ? 'os seus andares' : 'o seu andar'}, as etiquetas aparecerão aqui automaticamente.`)}</section>`;
      paintSel();
      return;
    }
    const blocks = d.lots
      .map((lot) => ({ lot, rows: lot.labels.filter(visible) }))
      .filter((b) => b.rows.length);
    if (!blocks.length) {
      box.innerHTML = `<section class="card">${vs.status === 'pending' && !vs.q
        ? emptyBox('check', 'Tudo impresso!', vs.floor ? `Não há etiquetas pendentes no ${fmap.get(vs.floor)?.name || 'andar'}.` : `Não há etiquetas pendentes ${multi ? 'nos seus andares' : 'no seu andar'}.`)
        : emptyBox('search', 'Nenhuma etiqueta encontrada', '')}</section>`;
      paintSel();
      return;
    }
    box.innerHTML = blocks.map(({ lot, rows }) => {
      const printed = lot.labels.filter((l) => l.printCount > 0).length;
      const pending = lot.labels.length - printed;
      const sel = rows.filter(selectable);
      const allSel = sel.length > 0 && sel.every((l) => vs.sel.has(l.id));
      return `<section class="card lot-block" data-lot="${esc(lot.id)}">
        <div class="lot-head">
          <div class="lh-title"><b>${icon('package', 18)} Lote ${esc(lot.code)}</b><span>${esc(lot.description || 'Sem descrição')} · ${fmtD(lot.createdAt)}</span></div>
          <div class="lh-prog"><span>${fmtN(printed)} de ${fmtN(lot.labels.length)} impressas</span>${progress(printed, lot.labels.length, main.color)}</div>
          <button class="btn primary sm" data-print-lot ${pending ? '' : 'disabled'}>${icon('printer', 14)} Imprimir pendentes (${fmtN(pending)})</button>
        </div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th class="w-check"><input type="checkbox" data-all ${allSel ? 'checked' : ''} ${sel.length ? '' : 'disabled'}></th>
            <th>Código</th><th>Descrição</th><th>Endereço</th><th class="num">Qtd</th>${multi ? '<th>Andar</th>' : ''}<th>Status</th></tr></thead>
          <tbody>${rows.map((l) => {
            const can = selectable(l);
            return `<tr class="${can ? 'clickable' : ''} ${vs.sel.has(l.id) ? 'sel' : ''}" data-id="${esc(l.id)}">
              <td>${can ? `<input type="checkbox" data-sel ${vs.sel.has(l.id) ? 'checked' : ''}>` : `<span class="lock-note" title="Reimpressão bloqueada">${icon('lock', 14)}</span>`}</td>
              <td class="code">${esc(l.code)}</td>
              <td class="desc" title="${esc(l.description)}">${esc(l.description || '—')}</td>
              <td class="nowrap">${esc(l.address || '—')}</td>
              <td class="num">${esc(l.qty || '—')}</td>
              ${multi ? `<td>${floorTag(fmap.get(l.floorId))}</td>` : ''}
              <td>${l.printCount > 0
                ? `<span class="status-printed">${icon('check', 14)} Impressa ${fmtDT(l.printedAt)}${l.printCount > 1 ? ` (${l.printCount}x)` : ''}</span>`
                : `<span class="status-pending">${icon('clock', 14)} Pendente</span>`}</td>
            </tr>`;
          }).join('')}</tbody></table></div>
      </section>`;
    }).join('');
    paintSel();
  }

  $('#lots').addEventListener('click', (e) => {
    const block = e.target.closest('[data-lot]');
    if (!block) return;
    const lot = d.lots.find((l) => l.id === block.dataset.lot);
    if (e.target.closest('[data-print-lot]')) {
      const ids = lot.labels.filter((l) => !(l.printCount > 0)).map((l) => l.id);
      return printFlow(ids, 'print', () => ids.forEach((i) => vs.sel.delete(i)));
    }
    if (e.target.matches('input[data-all]')) {
      lot.labels.filter(visible).filter(selectable).forEach((l) => (e.target.checked ? vs.sel.add(l.id) : vs.sel.delete(l.id)));
      return paintLots();
    }
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const l = byId.get(tr.dataset.id);
    if (!selectable(l)) return;
    if (e.target.matches('input[data-sel]')) e.target.checked ? vs.sel.add(l.id) : vs.sel.delete(l.id);
    else vs.sel.has(l.id) ? vs.sel.delete(l.id) : vs.sel.add(l.id);
    paintLots();
  });
  ctx.el.querySelectorAll('#seg button').forEach((b) => (b.onclick = () => {
    vs.status = b.dataset.s;
    paintLots();
  }));
  $('#my-q').oninput = debounce((e) => {
    vs.q = e.target.value;
    paintLots();
  }, 150);
  $('#my-floor')?.addEventListener('change', (e) => {
    vs.floor = e.target.value;
    paintLots();
  });
  $('#sel-visible').onclick = () => {
    const vis = all.filter(visible).filter(selectable);
    const allOn = vis.length && vis.every((l) => vs.sel.has(l.id));
    vis.forEach((l) => (allOn ? vs.sel.delete(l.id) : vs.sel.add(l.id)));
    paintLots();
  };
  const ordered = () => all.filter((l) => vs.sel.has(l.id)).map((l) => l.id);
  $('#print').onclick = () => printFlow(ordered(), 'print', () => vs.sel.clear());
  $('#pdf').onclick = () => printFlow(ordered(), 'pdf', () => vs.sel.clear());
  $('#reload').onclick = () => refresh();
  paintLots();
}

/* ------------------------------------------------------------------ */
/* Impressão (pré-visualização 3D + envio)                             */
/* ------------------------------------------------------------------ */
async function printFlow(ids, mode = 'print', after) {
  if (!ids.length) return toast('Selecione ao menos uma etiqueta.', 'warn');
  let prev, cfg;
  try {
    [prev, cfg] = await Promise.all([api('print:preview', { labelIds: ids }), api('config:get')]);
  } catch (e) {
    return toast(e.message, 'error');
  }
  const MAX = 12;
  const show = prev.labels.slice(0, MAX);
  const reprints = prev.labels.filter((l) => l.printCount > 0).length;
  const W = prev.settings.labelWidth;
  const H = prev.settings.labelHeight;
  const dest = mode === 'pdf'
    ? 'Arquivo PDF'
    : cfg.printerName
      ? `${cfg.printerName}${cfg.silentPrint ? ' · direto' : ''}`
      : cfg.silentPrint ? 'Impressora padrão do Windows · direto' : 'Escolher na janela de impressão';
  state.busy = true;
  openModal({
    title: mode === 'pdf' ? 'Salvar etiquetas em PDF' : 'Imprimir etiquetas',
    size: 'xl',
    body: `<div class="print-summary">${icon('printer', 18)}<span><b>${fmtN(ids.length)}</b> etiqueta(s)</span>
        <span class="chip">${esc(W)} × ${esc(H)} mm</span>
        <span class="chip">${icon(mode === 'pdf' ? 'file' : 'printer', 11)} ${esc(dest)}</span>
        ${reprints ? `<span class="pill amber">${fmtN(reprints)} reimpressão(ões)</span>` : ''}</div>
      <div class="label-stage">${show.map((l, i) => `<div class="label-3d" style="animation-delay:${i * 45}ms">${renderLabelHTML(l, prev.settings)}</div>`).join('')}</div>
      ${prev.labels.length > MAX ? `<p class="muted center small" style="margin-top:10px">+ ${fmtN(prev.labels.length - MAX)} etiqueta(s) não exibida(s) na pré-visualização</p>` : ''}`,
    actions: [
      { label: 'Cancelar' },
      {
        label: mode === 'pdf' ? 'Salvar PDF' : 'Imprimir agora',
        kind: 'primary',
        icon: mode === 'pdf' ? 'download' : 'printer',
        onClick: async () => {
          const r = await api('print:run', { labelIds: ids, mode });
          if (r.cancelled) {
            toast('Impressão cancelada. Nenhuma etiqueta foi marcada como impressa.', 'info');
            return;
          }
          if (mode === 'pdf') {
            toast(`${fmtN(r.count)} etiqueta(s) salvas em PDF.`, 'success');
            api('file:openPath', { path: r.filePath }).catch(() => {});
          } else toast(`${fmtN(r.count)} etiqueta(s) enviada(s) para a impressora.`, 'success');
          if (after) after();
          refresh();
        },
      },
    ],
    onMount: (m) => drawBarcodes(m.body),
    onClose: () => {
      state.busy = false;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Início                                                              */
/* ------------------------------------------------------------------ */
async function boot() {
  window.api.onUpdate((s) => {
    state.update = s;
    renderUpdateBanner();
  });
  api('update:status').then((s) => {
    state.update = s;
    renderUpdateBanner();
  }).catch(() => {});
  try {
    state.info = await api('app:info');
    const me = await api('auth:me');
    if (me) {
      state.user = me.user;
      state.floors = me.floors || [];
      return showShell();
    }
  } catch {}
  showLogin();
}

boot();
