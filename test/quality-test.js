// Misura il motore su un sinusoide e su un tono ricco di armoniche.
// Scrive i risultati in file .f32 che analizza quality.py.
const fs = require('fs');
const path = require('path');


const { PitchCore } = require('../src/pitchcore.js');

const SR = 48000, DUR = 3.0, N = SR * DUR;
const OUT = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

function makeSignal(kind) {
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    if (kind === 'sine') x[i] = 0.5 * Math.sin(2 * Math.PI * 440 * t);
    else { // 220 Hz con 8 armoniche, simile a una voce/strumento
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * 220 * h * t + h) / h;
      x[i] = 0.3 * v;
    }
  }
  return x;
}

function runCore(x, st) {
  const core = PitchCore(SR); core.setSemitones(st);
  const y = new Float32Array(N);
  for (let off = 0; off < N; off += 128) {
    const inp = [x.subarray(off, off + 128)];
    const oL = new Float32Array(128), oR = new Float32Array(128);
    core.process(inp, [oL, oR]);
    y.set(oL.subarray(0, Math.min(128, N - off)), off);
  }
  return y;
}

(async () => {
  for (const kind of ['sine', 'rich']) {
    const x = makeSignal(kind);
    for (const st of [-12, -5, -2, -1, 1, 2, 5, 12]) {
      fs.writeFileSync(path.join(OUT, `core_${kind}_${st}.f32`), Buffer.from(runCore(x, st).buffer));
    }
  }
  // tempo CPU del motore alta qualità: secondi di calcolo per secondo di audio
  const x = makeSignal('rich'); const t = process.hrtime.bigint();
  for (const st of [-12, -5, 5, 12]) runCore(x, st);
  const sec = Number(process.hrtime.bigint() - t) / 1e9;
  console.log(`CPU motore HQ: ${(sec / (4 * DUR) * 100).toFixed(2)}% di un core (Node, desktop)`);
})();
