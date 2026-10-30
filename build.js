// Genera dist/yt-transpose.js (leggibile), dist/yt-transpose.min.js e
// dist/bookmarklet.txt (la riga "javascript:..." da incollare nel preferito).
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

(async () => {
  const core = fs.readFileSync(path.join(__dirname, 'src/pitchcore.js'), 'utf8')
    .replace(/\nif \(typeof module[^\n]*\n?/, '\n');
  const main = fs.readFileSync(path.join(__dirname, 'src/main.js'), 'utf8');
  // main.js è già una IIFE: ci mettiamo dentro PitchCore come funzione locale.
  const marker = "  'use strict';\n";
  if (!main.includes(marker)) throw new Error('marker non trovato in main.js');
  const full = main.replace(marker, marker + core.split('\n').map(l => '  ' + l).join('\n') + '\n');

  const out = path.join(__dirname, 'dist');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'yt-transpose.js'), full);

  const min = await minify(full, {
    ecma: 2017,
    compress: { passes: 2, unsafe_arrows: false },
    mangle: true,
    format: { ascii_only: true, comments: false }
  });
  fs.writeFileSync(path.join(out, 'yt-transpose.min.js'), min.code);
  const bm = 'javascript:' + encodeURIComponent(min.code);
  fs.writeFileSync(path.join(out, 'bookmarklet.txt'), bm);
  const version = (main.match(/var VERSION = '([^']+)'/) || [])[1] || '?';
  if (/[<>&"]/.test(bm)) throw new Error('il bookmarklet contiene caratteri da escapare in HTML');
  const tpl = fs.readFileSync(path.join(__dirname, 'src/install.template.html'), 'utf8');
  const page = tpl
    .replace('{{BOOKMARKLET}}', () => bm)
    .replace('{{VERSION}}', version)
    .replace('{{SIZE}}', bm.length.toLocaleString('it-IT'));
  // dist/install.html: frammento per l'artifact di Claude (lo scheletro HTML lo aggiunge la piattaforma)
  fs.writeFileSync(path.join(out, 'install.html'), page);

  // docs/index.html: pagina completa per GitHub Pages
  const split = page.indexOf('<div class="page">');
  if (split < 0) throw new Error('struttura del template inattesa');
  const docs = path.join(__dirname, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'index.html'),
    '<!doctype html>\n<html lang="it">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}</style>\n' +
    page.slice(0, split).trim() + '\n</head>\n<body>\n' + page.slice(split) + '\n</body>\n</html>\n');
  console.log(`leggibile ${full.length} B · minificato ${min.code.length} B · bookmarklet ${bm.length} caratteri`);
})();
