// Verifica la separazione in cluster di capture.js su un vero file WebM/Opus,
// consegnato a pezzi di dimensione casuale come fa YouTube.
// Il file di prova si genera con ffmpeg (vedi README) e si passa come argomento.
const fs = require('fs');
const { execFileSync } = require('child_process');
const { CaptureStream } = require('../src/capture.js');

const file = process.argv[2];
const data = new Uint8Array(fs.readFileSync(file));

// tempi attesi dei cluster, letti con ffprobe dai pacchetti (inizio di ogni cluster = keyframe audio non c'è:
// usiamo invece il parser stesso su file intero come riferimento e confrontiamo con la consegna a pezzi)
function run(chunks) {
  const decoded = [];
  // finto ambiente: un MediaSource con addSourceBuffer e un AudioContext che "decodifica"
  // restituendo la durata ricavata dal numero di byte (ci interessano ordine e tempi)
  class SB { appendBuffer() {} }
  global.window = { ManagedMediaSource: class { addSourceBuffer() { return new SB(); } } };
  const events = [];
  const cs = CaptureStream((t, d) => events.push([t, d]));
  cs.install();
  const sb = new window.ManagedMediaSource().addSourceBuffer('audio/webm; codecs="opus"');
  cs.setContext({
    decodeAudioData(ab, ok) {
      const u = new Uint8Array(ab);
      decoded.push(u.length);
      ok({ sampleRate: 48000, numberOfChannels: 2, length: 48000 * 30, getChannelData: () => new Float32Array(48000 * 30) });
    }
  });
  for (const c of chunks) sb.appendBuffer(c);
  return new Promise((r) => setTimeout(() => r({ stats: cs.stats(), segs: events.filter((e) => e[0] === 'segment').map((e) => e[1]), events }), 200));
}

function randomChunks(buf, seed) {
  let x = seed, out = [], p = 0;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  while (p < buf.length) { const n = 1 + Math.floor(rnd() * 60000); out.push(buf.slice(p, p + n)); p += n; }
  return out;
}

(async () => {
  const whole = await run([data]);
  const results = [{ prova: 'file intero', cluster: whole.stats.clusters, segmenti: whole.segs.length, primi: whole.segs.slice(0, 4).map((t) => t.toFixed(2)).join(' ') }];
  let ok = whole.stats.clusters > 3;
  for (const seed of [1, 7, 42, 99]) {
    const r = await run(randomChunks(data, seed));
    const same = JSON.stringify(r.segs) === JSON.stringify(whole.segs);
    ok = ok && same && r.stats.clusters === whole.stats.clusters;
    results.push({ prova: 'pezzi casuali #' + seed, cluster: r.stats.clusters, segmenti: r.segs.length, primi: r.segs.slice(0, 4).map((t) => t.toFixed(2)).join(' '), uguale: same });
  }
  // tempi dei cluster attesi: crescenti e distanziati in modo regolare
  const gaps = whole.segs.slice(1).map((t, i) => t - whole.segs[i]);
  ok = ok && gaps.every((g) => g > 0);
  console.table(results);
  console.log('distanza tra cluster (s):', [...new Set(gaps.map((g) => g.toFixed(2)))].join(', '));
  console.log(ok ? 'OK: separazione identica con qualsiasi taglio' : 'FALLITO');
  process.exit(ok ? 0 : 1);
})();
