'use strict';
/**
 * Atualização automática pelo GitHub Releases.
 * Fluxo: push no GitHub -> GitHub Actions gera o instalador e publica uma
 * Release -> este módulo detecta a nova versão, baixa em segundo plano e
 * instala ao reiniciar (ou quando o usuário clicar em "Reiniciar e atualizar").
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const CHECK_EVERY_MS = 30 * 60 * 1000;

function createUpdater(send) {
  let status = { state: app.isPackaged ? 'idle' : 'dev', version: null, percent: 0, message: '' };
  let autoUpdater = null;

  const set = (patch) => {
    status = { ...status, ...patch };
    send(status);
  };

  const hasFeed = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  if (app.isPackaged && !hasFeed) status = { ...status, state: 'unconfigured' };

  if (hasFeed) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.on('checking-for-update', () => set({ state: 'checking', message: '' }));
      autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }));
      autoUpdater.on('update-not-available', () => set({ state: 'idle', checkedAt: new Date().toISOString() }));
      autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent || 0) }));
      autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, percent: 100 }));
      autoUpdater.on('error', (err) => set({ state: 'error', message: String((err && err.message) || err).slice(0, 300) }));
    } catch (e) {
      autoUpdater = null;
      status = { state: 'error', message: 'Módulo de atualização indisponível: ' + e.message };
    }
  }

  const check = async () => {
    if (!autoUpdater) return status;
    if (status.state === 'downloading' || status.state === 'ready') return status;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      set({ state: 'error', message: String(e.message || e).slice(0, 300) });
    }
    return status;
  };

  const start = () => {
    if (!autoUpdater) return;
    setTimeout(check, 8000);
    setInterval(check, CHECK_EVERY_MS);
  };

  const install = () => {
    if (autoUpdater && status.state === 'ready') {
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return true;
    }
    return false;
  };

  return { start, check, install, getStatus: () => status };
}

module.exports = { createUpdater };
