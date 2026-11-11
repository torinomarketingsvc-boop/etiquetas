import { renderLabelHTML, drawBarcodes } from '../renderer/label.js';

window.__render = async (payload) => {
  const { settings, labels } = payload;
  const W = Number(settings.labelWidth) || 100;
  const H = Number(settings.labelHeight) || 50;
  document.getElementById('page-style').textContent = `@page { size: ${W}mm ${H}mm; margin: 0; }`;
  const root = document.getElementById('root');
  root.innerHTML = labels.map((l) => renderLabelHTML(l, settings)).join('');
  drawBarcodes(root);
  await new Promise((r) => setTimeout(r, 80));
  return true;
};
