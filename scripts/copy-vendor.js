// Copia as bibliotecas de front-end para dentro do app (funciona 100% offline).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const vendor = path.join(root, 'src', 'renderer', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
const files = [
  ['node_modules/three/build/three.module.js', 'three.module.js'],
  ['node_modules/three/build/three.core.js', 'three.core.js'],
  ['node_modules/jsbarcode/dist/JsBarcode.all.min.js', 'JsBarcode.all.min.js'],
];
for (const [src, dest] of files) {
  const from = path.join(root, src);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(vendor, dest));
}
