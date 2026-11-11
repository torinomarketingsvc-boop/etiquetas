// Executado pelo GitHub Actions antes de gerar o instalador:
//  - versão = major.minor do package.json + número da execução (ex.: 1.0.57)
//  - define em qual repositório do GitHub as versões são publicadas
//    (o próprio repositório, ou RELEASES_REPO se você usar um repositório
//     público separado só para os instaladores).
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));

const run = process.env.GITHUB_RUN_NUMBER;
const [major, minor] = pkg.version.split('.');
if (run) pkg.version = `${major}.${minor}.${run}`;

const target = (process.env.RELEASES_REPO || process.env.GITHUB_REPOSITORY || '').trim();
if (target) {
  const [owner, repo] = target.split('/');
  pkg.build.publish = [{ provider: 'github', owner, repo, releaseType: 'release' }];
  pkg.repository = { type: 'git', url: `https://github.com/${target}.git` };
}

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Versão ${pkg.version} · publicação em: ${target || '(não definido)'}`);
