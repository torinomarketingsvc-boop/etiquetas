'use strict';
/**
 * Ponte entre a tela e a API no Supabase.
 *
 * Todas as regras de negócio e permissões ficam no banco (funções etq_* em
 * supabase/migrations). Aqui ficam apenas:
 *  - o envio das chamadas com o token da sessão;
 *  - as ações deste computador: impressora, PDF, leitura de CSV e backup.
 *
 * Níveis de usuário (conferidos no banco):
 *  - admin      → tudo (usuários, andares, configurações, backup)
 *  - supervisor → painel, lotes, etiquetas, distribuição e impressão de qualquer etiqueta
 *  - consulta   → somente leitura: painel, lotes e histórico
 *  - analista   → vê e imprime só as etiquetas distribuídas para ele nos seus andares
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { renderJob } = require('./printing');
const { AppError } = require('./remote');

/** Canal IPC (tela) → função RPC no banco */
const REMOTE = {
  'db:stamp': 'etq_stamp',
  'floors:list': 'etq_floors_list',
  'settings:get': 'etq_settings_get',
  'logs:list': 'etq_logs_list',
  'auth:changePassword': 'etq_change_password',
  'analyst:overview': 'etq_analyst_overview',
  'admin:dashboard': 'etq_dashboard',
  'settings:save': 'etq_settings_save',
  'floors:save': 'etq_floors_save',
  'floors:delete': 'etq_floors_delete',
  'users:list': 'etq_users_list',
  'users:save': 'etq_users_save',
  'users:resetPassword': 'etq_users_reset_password',
  'users:delete': 'etq_users_delete',
  'lots:list': 'etq_lots_list',
  'lots:get': 'etq_lots_get',
  'lots:create': 'etq_lots_create',
  'lots:update': 'etq_lots_update',
  'lots:delete': 'etq_lots_delete',
  'labels:add': 'etq_labels_add',
  'labels:update': 'etq_labels_update',
  'labels:delete': 'etq_labels_delete',
  'labels:resetPrint': 'etq_labels_reset_print',
  'dist:auto': 'etq_dist_auto',
  'dist:assign': 'etq_dist_assign',
  'dist:unassign': 'etq_dist_unassign',
};

const txt = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/**
 * @param ctx   { session: {token, user}, config: {printerName, silentPrint} }
 * @param deps  { app, dialog, shell, remote, saveConfig, serverLabel, getWindow }
 */
function buildHandlers(ctx, deps) {
  const { rpc } = deps.remote;
  const call = (fn, p) => rpc(fn, ctx.session.token, p);
  const win = () => deps.getWindow();
  const clearSession = () => {
    ctx.session = { token: null, user: null };
  };

  const h = {};
  const def = (name, role, fn) => {
    h[name] = { role, fn };
  };

  for (const [channel, fn] of Object.entries(REMOTE)) def(channel, 'any', (p) => call(fn, p));

  /* ------------------------------------------------------------------ */
  /* Público                                                             */
  /* ------------------------------------------------------------------ */
  def('app:info', 'public', async () => {
    const base = {
      version: deps.app.getVersion(),
      host: os.hostname(),
      packaged: deps.app.isPackaged,
      server: deps.serverLabel(),
    };
    try {
      const info = await rpc('etq_public_info', null, {}, 15000);
      return { ...base, companyName: info.companyName, serverError: null };
    } catch (e) {
      return { ...base, companyName: 'Etiquetas 3D', serverError: e.message };
    }
  });

  def('auth:login', 'public', async (p) => {
    const r = await rpc('etq_login', null, {
      username: txt(p.username, 40),
      password: String(p.password || ''),
      host: os.hostname(),
    });
    if (!r || r.error || !r.token) throw new AppError((r && r.error) || 'Não foi possível entrar.');
    ctx.session = { token: r.token, user: r.user };
    return r.user;
  });

  def('auth:me', 'public', async () => {
    if (!ctx.session.token) return null;
    try {
      const me = await call('etq_me');
      ctx.session.user = me.user;
      return me;
    } catch (e) {
      if (e.code === 'AUTH') {
        clearSession();
        return null;
      }
      throw e;
    }
  });

  def('auth:logout', 'any', async () => {
    try {
      await call('etq_logout');
    } catch {
      /* a sessão é encerrada aqui de qualquer forma */
    }
    clearSession();
    return true;
  });

  /* ------------------------------------------------------------------ */
  /* Este computador (impressora)                                        */
  /* ------------------------------------------------------------------ */
  def('config:get', 'any', () => ({
    printerName: ctx.config.printerName,
    silentPrint: ctx.config.silentPrint,
    server: deps.serverLabel(),
  }));

  def('config:setPrinter', 'any', (p) => {
    ctx.config.printerName = txt(p.printerName, 200);
    ctx.config.silentPrint = Boolean(p.silentPrint);
    deps.saveConfig();
    return true;
  });

  def('printers:list', 'any', async () => {
    const list = await win().webContents.getPrintersAsync();
    return list.map((pr) => ({ name: pr.name, displayName: pr.displayName || pr.name }));
  });

  /* ------------------------------------------------------------------ */
  /* Impressão: o banco confere a permissão, o computador imprime        */
  /* ------------------------------------------------------------------ */
  const withDate = (payload) => {
    const date = new Date().toLocaleDateString('pt-BR');
    return { ...payload, labels: payload.labels.map((l) => ({ ...l, date })) };
  };

  def('print:preview', 'any', async (p) =>
    withDate(await call('etq_print_payload', { labelIds: p.labelIds, forPrint: false }))
  );

  let printing = false;
  def('print:run', 'any', async (p) => {
    if (printing) throw new AppError('Já existe uma impressão em andamento.');
    const mode = p.mode === 'pdf' ? 'pdf' : 'print';
    const payload = withDate(await call('etq_print_payload', { labelIds: p.labelIds, forPrint: true }));
    let filePath = null;
    if (mode === 'pdf' && !deps.app.isPackaged && process.env.ETIQUETAS_TEST_PDF) {
      filePath = process.env.ETIQUETAS_TEST_PDF; // somente testes em desenvolvimento
    } else if (mode === 'pdf') {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const r = await deps.dialog.showSaveDialog(win(), {
        title: 'Salvar etiquetas em PDF',
        defaultPath: path.join(deps.app.getPath('documents'), `etiquetas-${stamp}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (r.canceled || !r.filePath) return { cancelled: true };
      filePath = r.filePath;
    }
    printing = true;
    let ok;
    try {
      ok = await renderJob(payload, {
        mode,
        filePath,
        silent: Boolean(ctx.config.silentPrint),
        deviceName: ctx.config.printerName || '',
      });
    } finally {
      printing = false;
    }
    if (!ok) return { cancelled: true };
    const r = await call('etq_mark_printed', { labelIds: p.labelIds, mode });
    return { count: r.count, filePath };
  });

  def('file:openPath', 'any', async (p) => {
    const f = String(p.path || '');
    if (!/\.pdf$/i.test(f) || !fs.existsSync(f)) throw new AppError('Arquivo não encontrado.');
    await deps.shell.openPath(f);
    return true;
  });

  /* ------------------------------------------------------------------ */
  /* Arquivos                                                            */
  /* ------------------------------------------------------------------ */
  def('backup:export', 'any', async () => {
    const data = await call('etq_export'); // só o administrador consegue
    const d = new Date().toISOString().slice(0, 10);
    const r = await deps.dialog.showSaveDialog(win(), {
      title: 'Exportar backup dos dados',
      defaultPath: path.join(deps.app.getPath('documents'), `etiquetas-backup-${d}.json`),
      filters: [{ name: 'Backup JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
    return r.filePath;
  });

  def('file:readCsv', 'any', async () => {
    const r = await deps.dialog.showOpenDialog(win(), {
      title: 'Importar planilha (CSV)',
      filters: [{ name: 'Planilhas CSV / TXT', extensions: ['csv', 'txt', 'tsv'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const buf = fs.readFileSync(file);
    if (buf.length > 30 * 1024 * 1024) throw new AppError('Arquivo muito grande (máx. 30 MB).');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder('windows-1252').decode(buf);
    }
    return { name: path.basename(file), text: text.replace(/^﻿/, '') };
  });

  return h;
}

module.exports = { buildHandlers, AppError, REMOTE };
