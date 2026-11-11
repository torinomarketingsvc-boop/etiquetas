// Gera o instalador no seu computador (pasta release/).
// Se o campo "repository" do package.json apontar para o GitHub, o
// instalador já sai configurado para se atualizar a partir dele.
const builder = require('electron-builder');
const pkg = require('../package.json');

const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
const m = url && url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
const config = { ...pkg.build };
if (m) {
  config.publish = [{ provider: 'github', owner: m[1], repo: m[2], releaseType: 'release' }];
  console.log(`Atualização automática: github.com/${m[1]}/${m[2]}`);
} else {
  config.publish = null;
  console.log('Sem "repository" no package.json: instalador local SEM atualização automática.');
}

builder
  .build({
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
    config,
    publish: 'never',
  })
  .then((files) => console.log('Gerado:\n' + files.join('\n')))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
