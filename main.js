'use strict';
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildHandlers, AppError } = require('./src/main/service');
const { createRemote, DEFAULT_API } = require('./src/main/remote');
const { createUpdater } = require('./src/main/updater');

app.setAppUserModelId('br.com.etiquetas3d.app');

// Apenas para testes em desenvolvimento: usa uma pasta de perfil separada
if (!app.isPackaged && process.env.ETIQUETAS_PROFILE_DIR) {
  app.setPath('userData', process.env.ETIQUETAS_PROFILE_DIR);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
const ctx = { session: { token: null, user: null }, config: null };

/* Configuração local deste computador (impressora; servidor opcional) */
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  const defaults = { printerName: '', silentPrint: false, api: null };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(configFile(), 'utf8')) };
  } catch {
    return defaults;
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(ctx.config, null, 2));
}

/** Servidor em uso: variável de ambiente (só em desenvolvimento) > config.json > padrão embutido */
function apiConfig() {
  if (!app.isPackaged && process.env.ETIQUETAS_API_URL && process.env.ETIQUETAS_API_KEY) {
    return { url: process.env.ETIQUETAS_API_URL, key: process.env.ETIQUETAS_API_KEY };
  }
  const c = ctx.config && ctx.config.api;
  if (c && typeof c.url === 'string' && /^https:\/\//.test(c.url) && typeof c.key === 'string' && c.key) return c;
  return DEFAULT_API;
}
const serverLabel = () => apiConfig().url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

const remote = createRemote(apiConfig, (url, opts) => net.fetch(url, opts));

const sendToRenderer = (channel, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
};

const updater = createUpdater((status) => sendToRenderer('update:status', status));

function registerIpc() {
  const handlers = buildHandlers(ctx, {
    app, dialog, shell, remote, saveConfig, serverLabel,
    getWindow: () => mainWindow,
  });

  handlers['update:status'] = { role: 'public', fn: () => updater.getStatus() };
  handlers['update:check'] = { role: 'public', fn: () => updater.check() };
  handlers['update:install'] = { role: 'public', fn: () => updater.install() };

  for (const [channel, def] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false, error: 'Origem inválida.' };
      try {
        // As permissões de cada perfil são conferidas no servidor; aqui só exigimos a sessão.
        if (def.role !== 'public' && !ctx.session.token) {
          throw new AppError('Sessão encerrada. Faça login novamente.', 'AUTH');
        }
        const data = await def.fn(payload || {}, ctx.session.user);
        return { ok: true, data };
      } catch (e) {
        if (e.code === 'AUTH') ctx.session = { token: null, user: null };
        return { ok: false, error: e.message || String(e), code: e.code };
      }
    });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#050816',
    title: 'Etiquetas 3D',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#050816', symbolColor: '#cbd5e1', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (!app.isPackaged && input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools();
    if (!app.isPackaged && input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r') mainWindow.reload();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ctx.config = loadConfig();
  registerIpc();
  createWindow();
  updater.start();
});

app.on('window-all-closed', () => app.quit());
