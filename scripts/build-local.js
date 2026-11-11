// Gera o instalador no seu computador (pasta release/).
// Se o campo "repository" do package.json apontar para o GitHub, o
// instalador já sai configurado para se atualizar a partir dele.
const builder = require('electron-builder');
const pkg = require('../package.json');

const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
const m = url && url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);

const options = {
  targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
  publish: 'never',
};
if (m) {
  // Usa o "build" do package.json como está: o electron-builder lê owner/repo do "repository".
  console.log(`Atualização automática: github.com/${m[1]}/${m[2]}`);
} else {
  options.config = { ...pkg.build, publish: null };
  console.log('Sem "repository" no package.json: instalador local SEM atualização automática.');
}

builder
  .build(options)
  .then((files) => console.log('Gerado:\n' + files.join('\n')))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
