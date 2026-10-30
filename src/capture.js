/*
 * Modalità iPhone: cattura dell'audio di YouTube.
 *
 * Su iPhone WebKit non passa a Web Audio l'audio dei video in streaming
 * (createMediaElementSource restituisce silenzio). YouTube però costruisce il
 * flusso nella pagina: scarica i pezzi e li consegna al lettore con
 * SourceBuffer.appendBuffer(). Qui intercettiamo quei pezzi per la traccia
 * audio (WebM/Opus), li separiamo in "cluster", li decodifichiamo con
 * decodeAudioData e teniamo una linea temporale di PCM pronta da leggere alla
 * posizione corrente del video.
 *
 * Continuità: ogni cluster viene decodificato insieme al precedente (se
 * contiguo) e poi si scarta la parte del precedente. Così il decodificatore
 * Opus arriva "caldo" al confine e non ci sono click tra un pezzo e l'altro.
 */
function CaptureStream(onEvent) {
  var ID_EBML = 0x1A45DFA3, ID_SEGMENT = 0x18538067, ID_INFO = 0x1549A966,
      ID_TCSCALE = 0x2AD7B1, ID_CLUSTER = 0x1F43B675, ID_TIMECODE = 0xE7;

  var ctx = null;
  var tracker = null;        // traccia audio corrente
  var segs = [];             // {start, end, L, R} ordinati per start
  var queue = [];            // cluster in attesa di decodifica
  var busy = false;
  var gen = 0;               // cambia a ogni nuova traccia: scarta le decodifiche vecchie
  var stats = { appended: 0, clusters: 0, decoded: 0, errors: 0, lastError: '', mime: '', unsupported: '' };
  var installed = false;

  function emit(type, data) { try { if (onEvent) onEvent(type, data); } catch (e) { /* ignora */ } }

  /* ---------- lettura EBML ---------- */
  function readId(b, p) {
    if (p >= b.length) return null;
    var c = b[p], len = c & 0x80 ? 1 : c & 0x40 ? 2 : c & 0x20 ? 3 : c & 0x10 ? 4 : 0;
    if (!len || p + len > b.length) return null;
    var v = 0;
    for (var i = 0; i < len; i++) v = v * 256 + b[p + i];
    return { id: v, len: len };
  }
  function readSize(b, p) {
    if (p >= b.length) return null;
    var c = b[p], len = 1, mask = 0x80;
    while (len <= 8 && !(c & mask)) { mask >>= 1; len++; }
    if (len > 8 || p + len > b.length) return null;
    var v = c & (mask - 1), allOnes = v === mask - 1;
    for (var i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xFF) allOnes = false; }
    return { size: allOnes ? -1 : v, len: len };
  }
  function readUint(b, p, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; }
  function findId(b, from, id) {
    var b0 = (id >>> 24) & 255, b1 = (id >>> 16) & 255, b2 = (id >>> 8) & 255, b3 = id & 255;
    for (var i = from; i + 3 < b.length; i++) {
      if (b[i] === b0 && b[i + 1] === b1 && b[i + 2] === b2 && b[i + 3] === b3) return i;
    }
    return -1;
  }
  function concat(list) {
    var n = 0, i;
    for (i = 0; i < list.length; i++) n += list[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }

  // Intestazione: tutto ciò che precede il primo cluster. La dimensione del
  // Segment diventa "sconosciuta", così i decodificatori non si aspettano un
  // file intero e accettano cluster presi da qualunque punto.
  function parseInit(t, bytes) {
    var c = findId(bytes, 0, ID_CLUSTER);
    var head = c < 0 ? bytes : bytes.subarray(0, c);
    var init = new Uint8Array(head);
    var s = findId(init, 0, ID_SEGMENT);
    if (s >= 0) {
      var sz = readSize(init, s + 4);
      if (sz) {
        init[s + 4] = 0xFF >> (sz.len - 1);
        for (var i = 1; i < sz.len; i++) init[s + 4 + i] = 0xFF;
      }
    }
    var info = findId(init, 0, ID_INFO);
    if (info >= 0) {
      var ts = findId(init, info, ID_TCSCALE);
      if (ts >= 0 && ts < info + 200) {
        var tsz = readSize(init, ts + 3);
        if (tsz) t.tcScale = readUint(init, ts + 3 + tsz.len, tsz.size);
      }
    }
    t.init = init;
    return c < 0 ? null : bytes.subarray(c);
  }

  function clusterTime(t, cl) {
    var hdr = readSize(cl, 4);
    var p = 4 + hdr.len;
    for (var guard = 0; guard < 8 && p < cl.length; guard++) {
      var id = readId(cl, p); if (!id) break;
      var sz = readSize(cl, p + id.len); if (!sz) break;
      var body = p + id.len + sz.len;
      if (id.id === ID_TIMECODE) return readUint(cl, body, sz.size) * t.tcScale / 1e9;
      if (sz.size < 0) break;
      p = body + sz.size;
    }
    return null;
  }

  // Separa i cluster completi dai byte accumulati.
  function drain(t) {
    for (;;) {
      var b = t.pend;
      if (b.length < 12) return;
      if (readUint(b, 0, 4) !== ID_CLUSTER) {
        var c = findId(b, 1, ID_CLUSTER);
        if (c < 0) { if (b.length > 4) t.pend = b.subarray(b.length - 3); return; }
        t.pend = b = b.subarray(c);
      }
      var sz = readSize(b, 4);
      if (!sz) return;
      var end;
      if (sz.size >= 0) {
        end = 4 + sz.len + sz.size;
        if (b.length < end) return;
      } else {
        end = findId(b, 4 + sz.len, ID_CLUSTER);
        if (end < 0) return;
      }
      var cl = new Uint8Array(b.subarray(0, end));
      t.pend = b.subarray(end);
      var start = clusterTime(t, cl);
      if (start == null) continue;
      stats.clusters++;
      var prev = t.last && !t.broken && start > t.last.start && start - t.last.start < 20 ? t.last : null;
      queue.push({ gen: t.gen, init: t.init, start: start, bytes: cl, prev: prev });
      t.last = { start: start, bytes: cl };
      t.broken = false;
      pump();
    }
  }

  /* ---------- decodifica ---------- */
  function decode(ab) {
    return new Promise(function (res, rej) {
      try {
        var p = ctx.decodeAudioData(ab, res, function (e) { rej(e || new Error('decodifica non riuscita')); });
        if (p && p.then) p.then(res, function (e) { rej(e || new Error('decodifica non riuscita')); });
      } catch (e) { rej(e); }
    });
  }

  function insertSeg(s) {
    // toglie ciò che si sovrappone (stessa zona ricaricata dopo una ricerca)
    segs = segs.filter(function (x) { return x.end <= s.start + 0.001 || x.start >= s.end - 0.001; });
    var i = 0;
    while (i < segs.length && segs[i].start < s.start) i++;
    segs.splice(i, 0, s);
  }

  function pump() {
    if (busy || !ctx || !queue.length) return;
    var job = queue.shift();
    if (job.gen !== gen) { pump(); return; }
    busy = true;
    var parts = job.prev ? [job.init, job.prev.bytes, job.bytes] : [job.init, job.bytes];
    var all = concat(parts);
    decode(all.buffer).then(function (buf) {
      if (job.gen !== gen) return;
      var sr = buf.sampleRate;
      // Opus scarta all'inizio di ogni decodifica il proprio ritardo (~6,5 ms), quindi il pezzo
      // precedente finisce un attimo prima del cluster successivo. Partiamo esattamente dalla
      // fine del pezzo già in linea: i campioni mancanti sono nella parte sovrapposta che
      // abbiamo appena decodificato, così la giunzione non ha buchi né click.
      var startT = job.start;
      if (job.prev) {
        for (var k = 0; k < segs.length; k++) {
          var ps = segs[k];
          if (ps.start < job.start && Math.abs(ps.end - job.start) < 0.05) { startT = ps.end; break; }
        }
      }
      var skip = job.prev ? Math.round((startT - job.prev.start) * sr) : 0;
      if (skip < 0 || skip >= buf.length) { skip = job.prev ? Math.round((job.start - job.prev.start) * sr) : 0; startT = job.start; }
      if (skip >= buf.length) { skip = 0; startT = job.start; }
      var n = buf.length - skip;
      if (n <= 0) return;
      var L = buf.getChannelData(0).slice(skip);
      var R = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice(skip) : L;
      insertSeg({ start: startT, end: startT + n / sr, L: L, R: R, sr: sr });
      stats.decoded++;
      emit('segment', job.start);
    }, function (e) {
      stats.errors++;
      stats.lastError = (e && (e.name || e.message)) || 'errore';
      emit('error', stats.lastError);
    }).then(function () { busy = false; pump(); });
  }

  /* ---------- aggancio ai SourceBuffer di YouTube ---------- */
  function newTracker(sb, mime) {
    var t = { sb: sb, mime: mime, init: null, pend: new Uint8Array(0), tcScale: 1e6, last: null, broken: false, gen: 0 };
    return t;
  }

  function onAppend(t, data) {
    if (t !== tracker) return;
    var u;
    try {
      u = data instanceof ArrayBuffer ? new Uint8Array(data.slice(0))
        : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } catch (e) { return; }
    stats.appended += u.length;
    if (readUint(u, 0, 4) === ID_EBML) {
      // nuova intestazione: possibile cambio di qualità o di brano, si riparte da zero
      var rest = parseInit(t, u);
      gen++; t.gen = gen; segs = []; queue = []; cursor = 0;
      t.pend = new Uint8Array(0);
      t.last = null;
      emit('track', t.mime);
      if (rest && rest.length) { t.pend = new Uint8Array(rest); drain(t); }
      return;
    }
    if (!t.init) return; // aggancio arrivato a metà: aspettiamo una nuova intestazione
    t.pend = t.pend.length ? concat([t.pend, u]) : u;
    drain(t);
  }

  function wrapBuffer(sb, mime) {
    var isAudio = /^audio\//i.test(mime || '');
    if (!isAudio) return;
    stats.mime = mime;
    if (!/webm/i.test(mime)) {
      stats.unsupported = mime;
      emit('unsupported', mime);
      return;
    }
    var t = newTracker(sb, mime);
    gen++; t.gen = gen;
    tracker = t; segs = []; queue = []; stats.unsupported = '';
    emit('track', mime);
    var app = sb.appendBuffer;
    sb.appendBuffer = function (d) {
      onAppend(t, d);
      return app.apply(sb, arguments);
    };
    var ab = sb.abort;
    if (typeof ab === 'function') {
      sb.abort = function () { t.pend = new Uint8Array(0); t.broken = true; return ab.apply(sb, arguments); };
    }
    var ct = sb.changeType;
    if (typeof ct === 'function') {
      sb.changeType = function (m) { t.init = null; t.pend = new Uint8Array(0); t.last = null; return ct.apply(sb, arguments); };
    }
  }

  function install() {
    if (installed) return;
    installed = true;
    [window.ManagedMediaSource, window.MediaSource].forEach(function (MS) {
      if (!MS || !MS.prototype || !MS.prototype.addSourceBuffer || MS.prototype.__ytTransposeHook) return;
      var add = MS.prototype.addSourceBuffer;
      MS.prototype.addSourceBuffer = function (mime) {
        var sb = add.apply(this, arguments);
        try { wrapBuffer(sb, String(mime)); } catch (e) { /* non interferire con YouTube */ }
        return sb;
      };
      MS.prototype.__ytTransposeHook = 1;
    });
  }

  /* ---------- lettura per la riproduzione ---------- */
  var cursor = 0;
  function segAt(t) {
    if (cursor < segs.length) {
      var c = segs[cursor];
      if (t >= c.start && t < c.end) return c;
      if (cursor + 1 < segs.length) { var nx = segs[cursor + 1]; if (t >= nx.start && t < nx.end) { cursor++; return nx; } }
    }
    for (var i = 0; i < segs.length; i++) {
      if (t >= segs[i].start && t < segs[i].end) { cursor = i; return segs[i]; }
      if (segs[i].start > t) break;
    }
    return null;
  }

  // Riempie outL/outR con n campioni a partire dal tempo t (secondi del video),
  // avanzando di inc secondi per campione. Restituisce quanti campioni erano disponibili.
  function read(t, inc, outL, outR, n) {
    var got = 0;
    var s = null;
    for (var i = 0; i < n; i++) {
      if (!s || t < s.start || t >= s.end) s = segAt(t);
      if (s) {
        var x = (t - s.start) * s.sr, i0 = x | 0, f = x - i0, i1 = i0 + 1 < s.L.length ? i0 + 1 : i0;
        outL[i] = s.L[i0] + (s.L[i1] - s.L[i0]) * f;
        outR[i] = s.R[i0] + (s.R[i1] - s.R[i0]) * f;
        got++;
      } else { outL[i] = 0; outR[i] = 0; }
      t += inc;
    }
    return got;
  }

  function has(t) { return !!segAt(t); }

  // Libera la memoria lontana dalla posizione corrente.
  function evict(t) {
    var before = segs.length;
    segs = segs.filter(function (s) { return s.end > t - 20 && s.start < t + 180; });
    if (segs.length !== before) cursor = 0;
  }

  return {
    install: install,
    setContext: function (c) { ctx = c; pump(); },
    read: read,
    has: has,
    evict: evict,
    hasTrack: function () { return !!tracker; },
    bufferedAhead: function (t) {
      var end = t;
      for (var i = 0; i < segs.length; i++) if (segs[i].start <= end + 0.05 && segs[i].end > end) end = segs[i].end;
      return end - t;
    },
    stats: function () { return { appended: stats.appended, clusters: stats.clusters, decoded: stats.decoded, errors: stats.errors, lastError: stats.lastError, mime: stats.mime, unsupported: stats.unsupported, segs: segs.length, queue: queue.length }; },
    _internals: { parseInit: parseInit, drain: drain, newTracker: newTracker, segs: function () { return segs; } }
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { CaptureStream: CaptureStream };
