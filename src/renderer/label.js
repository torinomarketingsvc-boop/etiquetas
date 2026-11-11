/**
 * Layout da etiqueta — usado tanto na pré-visualização quanto na impressão,
 * garantindo que o que aparece na tela é exatamente o que sai na impressora.
 */
export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function renderLabelHTML(l, s) {
  const W = num(s.labelWidth, 100);
  const H = num(s.labelHeight, 50);
  return `<div class="label" style="width:${W}mm;height:${H}mm;--h:${H}mm;--w:${W}mm">
  <div class="lb-top"><span class="lb-company">${esc(s.companyName)}</span><span class="lb-lot">LOTE ${esc(l.lotCode)}</span></div>
  <div class="lb-mid">
    <div class="lb-floor"><div class="lb-floor-code">${esc(l.floorCode)}</div><div class="lb-floor-name">${esc(l.floorName)}</div></div>
    <div class="lb-info">
      <div class="lb-code">${esc(l.code)}</div>
      ${l.description ? `<div class="lb-desc">${esc(l.description)}</div>` : ''}
      <div class="lb-meta">${l.address ? `<span>END: <b>${esc(l.address)}</b></span>` : ''}${l.qty ? `<span>QTD: <b>${esc(l.qty)}</b></span>` : ''}</div>
    </div>
  </div>
  <svg class="lb-barcode" data-barcode="${esc(l.code)}"></svg>
  <div class="lb-bottom"><span>${esc(l.code)}</span><span>${esc(l.date)}${l.analystName ? ` · ${esc(l.analystName)}` : ''}</span></div>
</div>`;
}

export function drawBarcodes(root) {
  root.querySelectorAll('svg[data-barcode]').forEach((svg) => {
    const value = svg.getAttribute('data-barcode');
    try {
      window.JsBarcode(svg, value, {
        format: 'CODE128',
        displayValue: false,
        margin: 0,
        height: 60,
        width: 2,
        background: 'transparent',
        lineColor: '#000',
      });
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    } catch {
      const div = document.createElement('div');
      div.className = 'lb-nobar';
      div.textContent = 'Código sem barras (caracteres especiais)';
      svg.replaceWith(div);
    }
  });
}
