'use strict';
/**
 * Gera as etiquetas em uma janela oculta e envia para a impressora
 * (ou salva em PDF). Cada etiqueta ocupa exatamente uma página do
 * tamanho configurado pelo administrador (em milímetros).
 */
const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

async function renderJob(payload, opts) {
  const W = payload.settings.labelWidth;
  const H = payload.settings.labelHeight;
  const w = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  try {
    await w.loadFile(path.join(__dirname, '..', 'print', 'print.html'));
    await w.webContents.executeJavaScript(`window.__render(${JSON.stringify(payload)})`, true);

    if (opts.mode === 'pdf') {
      const pdf = await w.webContents.printToPDF({
        pageSize: { width: W / 25.4, height: H / 25.4 },
        margins: { marginType: 'none' },
        printBackground: true,
        preferCSSPageSize: true,
      });
      fs.writeFileSync(opts.filePath, pdf);
      return true;
    }

    const printOpts = {
      silent: Boolean(opts.silent),
      printBackground: true,
      margins: { marginType: 'none' },
      pageSize: { width: Math.round(W * 1000), height: Math.round(H * 1000) },
    };
    if (opts.deviceName) printOpts.deviceName = opts.deviceName;

    return await new Promise((resolve, reject) => {
      w.webContents.print(printOpts, (success, reason) => {
        if (success) resolve(true);
        else if (/cancel/i.test(String(reason || ''))) resolve(false);
        else reject(new Error('Falha na impressão: ' + (reason || 'erro desconhecido')));
      });
    });
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

module.exports = { renderJob };
