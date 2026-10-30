/*
 * Motore di alta qualità: "harmonizer" con giunte allineate per correlazione.
 *
 * L'audio entra in un buffer circolare e viene riletto a velocità r = 2^(st/12).
 * Quando il puntatore di lettura si avvicina troppo (o si allontana troppo) dal
 * punto di scrittura, salta indietro (o avanti) di circa un periodo del segnale.
 * L'ampiezza del salto viene scelta cercando il punto in cui la forma d'onda è
 * più simile a quella corrente (correlazione normalizzata), poi i due flussi
 * vengono sfumati in ~12 ms. Le fasi coincidono, quindi niente "tremolio".
 *
 * Questa funzione viene usata due volte:
 *  - dentro l'AudioWorklet (thread audio del browser);
 *  - nei test Node, per misurare la qualità senza un browser.
 */
function PitchCore(sr) {
  var B = 65536, mask = B - 1;
  var bufL = new Float32Array(B), bufR = new Float32Array(B), mono = new Float32Array(B);
  var w = 0;            // indice del prossimo campione da scrivere
  var r = 1;            // rapporto di lettura
  var d = 64;           // ritardo corrente (campioni, frazionario)
  var dOld = 0, xf = 0; // flusso vecchio durante la dissolvenza
  var F = Math.round(0.012 * sr);   // durata dissolvenza
  var Wc = Math.round(0.010 * sr);  // finestra di confronto
  var J0 = Math.round(0.012 * sr);  // salto minimo
  var J1 = Math.round(0.040 * sr);  // salto massimo
  var Jmin = J0, Dmin = 8, Dmax = J1 + 64;

  function hermite(buf, pos) {
    var i = Math.floor(pos), t = pos - i;
    var xm = buf[(i - 1) & mask], x0 = buf[i & mask], x1 = buf[(i + 1) & mask], x2 = buf[(i + 2) & mask];
    var c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + x0;
  }

  // dir = -1: cerca indietro (dati più vecchi), dir = +1: avanti (più recenti)
  function bestJump(p, dir, jLo, jHi) {
    var p0 = Math.floor(p), n, aa = 0;
    for (n = 0; n < Wc; n += 2) { var a = mono[(p0 - n) & mask]; aa += a * a; }
    var mid = Math.round((jLo + jHi) / 2);
    if (aa < 1e-9 || jHi <= jLo) return mid;
    var best = -Infinity, bestJ = mid;
    for (var J = jLo; J <= jHi; J++) {
      var q0 = p0 + dir * J, ab = 0, bb = 0;
      for (n = 0; n < Wc; n += 2) {
        var x = mono[(p0 - n) & mask], y = mono[(q0 - n) & mask];
        ab += x * y; bb += y * y;
      }
      var s = ab / Math.sqrt(bb + 1e-12);
      if (s > best) { best = s; bestJ = J; }
    }
    return bestJ;
  }

  function setRatio(nr) {
    r = nr;
    var k = Math.abs(r - 1);
    Jmin = Math.max(J0, Math.ceil(F * k) + 16);
    Dmin = Math.ceil(F * Math.max(0, r - 1)) + 8;
    Dmax = Math.max(Dmin + J1 + 64, J1 + 64);
    if (d < Dmin) d = Dmin + (J1 + Jmin) / 2;
    if (d > B - F - 8) d = Dmax;
  }

  function process(input, output) {
    var inL = input && input[0], inR = input && (input[1] || input[0]);
    var outL = output[0], outR = output[1] || null;
    var n = outL.length;
    for (var i = 0; i < n; i++) {
      var l = inL ? inL[i] : 0, rr = inR ? inR[i] : 0;
      var wi = w & mask;
      bufL[wi] = l; bufR[wi] = rr; mono[wi] = 0.5 * (l + rr);
      w++;
      var head = w - 1;

      // rilevamento giunta
      if (xf === 0) {
        if (r > 1 && d < Dmin) {
          var p = head - d;
          var J = bestJump(p, -1, Jmin, J1);
          dOld = d; d = d + J; xf = F;
        } else if (r < 1 && d > Dmax) {
          var p2 = head - d;
          var hi = Math.min(J1, Math.floor(d - Dmin - 4));
          var J2 = bestJump(p2, +1, Math.min(Jmin, hi), hi);
          dOld = d; d = d - J2; xf = F;
        }
      }

      var pos = head - d;
      var oL = hermite(bufL, pos), oR = hermite(bufR, pos);
      if (xf > 0) {
        var a = 1 - xf / F;
        var po = head - dOld;
        oL = oL * a + hermite(bufL, po) * (1 - a);
        oR = oR * a + hermite(bufR, po) * (1 - a);
        dOld += 1 - r;
        xf--;
      }
      outL[i] = oL;
      if (outR) outR[i] = oR;
      d += 1 - r;
      if (d < 2) d = 2; // sicurezza: mai leggere oltre la scrittura
    }
  }

  return {
    setSemitones: function (st) { setRatio(Math.pow(2, st / 12)); },
    process: process
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { PitchCore: PitchCore };
