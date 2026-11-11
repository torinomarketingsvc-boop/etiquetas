/**
 * Leitura de linhas coladas do Excel (TAB) ou CSV (; ou ,).
 * Colunas padrão: Código | Descrição | Endereço | Quantidade | Andar
 * Se a primeira linha for um cabeçalho, as colunas são identificadas pelo nome.
 */
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const key = (s) => norm(s).replace(/[^a-z0-9]/g, '');

function splitLine(line, d) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === '') { q = true; cur = ''; }
    else if (c === d) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const HEADERS = {
  code: ['codigo', 'cod', 'sku', 'codproduto', 'codigodoproduto', 'referencia', 'ref', 'item', 'etiqueta'],
  description: ['descricao', 'desc', 'produto', 'nome', 'descricaodoproduto', 'material'],
  address: ['endereco', 'end', 'local', 'localizacao', 'posicao', 'enderecamento', 'rua'],
  qty: ['quantidade', 'qtd', 'qtde', 'quant', 'qt', 'volume', 'volumes'],
  floor: ['andar', 'piso', 'pavimento', 'nivel'],
};

export function parseTable(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { header: false, rows: [] };
  const first = lines[0];
  const count = (ch) => first.split(ch).length - 1;
  const d = count('\t') ? '\t' : count(';') ? ';' : count(',') ? ',' : '\t';
  let rows = lines.map((l) => splitLine(l, d));

  let map = { code: 0, description: 1, address: 2, qty: 3, floor: 4 };
  let header = false;
  const h = rows[0].map(key);
  const found = {};
  for (const [field, names] of Object.entries(HEADERS)) {
    const i = h.findIndex((x) => names.includes(x));
    if (i >= 0) found[field] = i;
  }
  if (Object.keys(found).length >= 2 || (found.code !== undefined && rows.length > 1)) {
    header = true;
    map = {
      code: found.code ?? 0,
      description: found.description ?? -1,
      address: found.address ?? -1,
      qty: found.qty ?? -1,
      floor: found.floor ?? -1,
    };
    rows = rows.slice(1);
  }
  const get = (r, i) => (i >= 0 && i < r.length ? r[i] : '');
  return {
    header,
    rows: rows.map((r) => ({
      code: get(r, map.code),
      description: get(r, map.description),
      address: get(r, map.address),
      qty: get(r, map.qty),
      floor: get(r, map.floor),
    })),
  };
}

export function resolveFloor(raw, floors) {
  const k = key(raw);
  if (!k) return null;
  let f = floors.find((x) => key(x.name) === k || key(x.code) === k);
  if (f) return f;
  if (k.startsWith('terreo') || k === 't' || k === '0' || k === 'terr') {
    f = floors.find((x) => key(x.name).startsWith('terreo') || key(x.code) === 't');
    if (f) return f;
  }
  const digits = k.replace(/\D/g, '');
  if (digits) {
    f = floors.find((x) => key(x.code) === digits || key(x.name).replace(/\D/g, '') === digits);
    if (f) return f;
  }
  return null;
}
