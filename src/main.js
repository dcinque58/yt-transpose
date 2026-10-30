/*
 * YT Transpose — pannello per trasporre i video di YouTube, pensato per
 * iPhone (Brave o Safari) e avviato come bookmarklet dai preferiti.
 * Richiede PitchCore (pitchcore.js), concatenato prima di questo file.
 */
(function () {
  'use strict';
  var VERSION = '2.0.0';
  var NS = '__ytTranspose';

  if (window[NS]) { window[NS].toggle(); return; }
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) {
    alert('YT Transpose funziona su YouTube.\nApri un video su m.youtube.com e poi tocca di nuovo il preferito.');
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Archivio, solo su questo dispositivo.                               */
  /* Primo posto: localStorage di youtube.com. Siccome YouTube lo riempie */
  /* spesso fino al limite (circa 5 MB su iPhone), ogni salvataggio va   */
  /* anche in IndexedDB, che ha uno spazio separato e molto più grande.  */
  /* All'avvio vince la copia più recente delle due.                     */
  /* ------------------------------------------------------------------ */
  var KEY = 'ytTranspose.v1';
  function emptyDb() {
    return { v: 1, ts: 0, songs: {}, playlists: [{ id: 'p' + Date.now().toString(36), name: 'La mia playlist', items: [] }], cur: null, loop: false, pos: 'bottom', pending: null };
  }
  function validDb(d) { return !!(d && d.v === 1 && d.songs && Array.isArray(d.playlists)); }
  function fixDb(d) {
    if (!d.playlists.length) d.playlists = emptyDb().playlists;
    if (!d.cur || !d.playlists.some(function (p) { return p.id === d.cur; })) d.cur = d.playlists[0].id;
    return d;
  }
  function loadDb() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY));
      if (validDb(d)) return d;
    } catch (e) { /* archivio assente, illeggibile o bloccato */ }
    return emptyDb();
  }
  var db = fixDb(loadDb());

  // store.mode: 'local' (tutto ok) · 'idb' (localStorage rifiuta, IndexedDB funziona) · 'none' (niente si salva)
  var store = { mode: 'local', reason: '' };
  var idbConn = null;
  function idbOpen() {
    if (idbConn) return idbConn;
    idbConn = new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('IndexedDB non disponibile')); return; }
      var r;
      try { r = indexedDB.open('ytTranspose', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('apertura non riuscita')); };
      r.onblocked = function () { rej(new Error('database bloccato')); };
    });
    idbConn.catch(function () { idbConn = null; });
    return idbConn;
  }
  function idbGet() {
    return idbOpen().then(function (d) {
      return new Promise(function (res, rej) {
        var q = d.transaction('kv', 'readonly').objectStore('kv').get('db');
        q.onsuccess = function () { res(q.result || null); };
        q.onerror = function () { rej(q.error); };
      });
    });
  }
  function idbPut(txt) {
    return idbOpen().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(txt, 'db');
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error || new Error('scrittura annullata')); };
      });
    });
  }
  function reasonOf(e) {
    var n = e && e.name;
    if (n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
    if (n === 'SecurityError') return 'blocked';
    return 'other';
  }
  function setStore(mode, err) {
    var reason = err ? reasonOf(err) : '';
    if (mode === store.mode && reason === store.reason) return;
    var wasNone = store.mode === 'none';
    store.mode = mode; store.reason = reason;
    if (mode === 'none' && !wasNone && typeof toast === 'function') {
      toast(reason === 'blocked'
        ? 'Brave blocca il salvataggio per YouTube: le tonalità non verranno ricordate. Apri ☰ per la soluzione.'
        : 'Il browser non riesce a salvare: le tonalità non verranno ricordate. Apri ☰ per la soluzione.');
    }
    dirty = true;
    try { refresh(); } catch (e) { /* interfaccia non ancora pronta */ }
  }
  function save() {
    db.ts = Date.now();
    var txt = JSON.stringify(db), lsErr = null;
    try { localStorage.setItem(KEY, txt); } catch (e) { lsErr = e; }
    if (!lsErr) setStore('local');
    idbPut(txt).then(function () {
      if (lsErr) setStore('idb', lsErr);
    }, function (e2) {
      if (lsErr) setStore('none', reasonOf(lsErr) === 'blocked' ? lsErr : e2);
    });
  }
  // Recupera la copia in IndexedDB se è più recente di quella in localStorage.
  function loadFromIdb() {
    return idbGet().then(function (txt) {
      if (!txt) return false;
      var d = JSON.parse(txt);
      if (!validDb(d) || (d.ts || 0) <= (db.ts || 0)) return false;
      db = fixDb(d);
      return true;
    }).catch(function () { return false; });
  }
  function plById(id) { for (var i = 0; i < db.playlists.length; i++) if (db.playlists[i].id === id) return db.playlists[i]; return null; }
  function curPl() { return plById(db.cur) || db.playlists[0]; }
  function inAnyPlaylist(id) { return db.playlists.some(function (p) { return p.items.indexOf(id) >= 0; }); }

  /* ------------------------------------------------------------------ */
  /* Audio                                                               */
  /* ------------------------------------------------------------------ */
  var ctx = null, engine = null, dry = null, wet = null, analyser = null, master = null, outMeter = null;
  var engineKind = '', audioErr = '';
  var sources = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var curEl = null, curSrc = null;
  var semis = 0;
  var starting = null;
  var silentTicks = 0, lastTime = -1, stuckTicks = 0, warn = '';

  // Modalità iPhone: WebKit non passa a Web Audio l'audio dei video in streaming,
  // quindi catturiamo i pezzi audio che YouTube consegna al lettore (capture.js),
  // li suoniamo noi trasposti e teniamo muto il video. Su computer si usa invece
  // l'aggancio diretto al <video>, più semplice.
  var CAPTURE = !!window[NS + 'ForceCapture'] || (!!window.ManagedMediaSource && !window.MediaSource);
  var cap = null, capHealthyAt = 0, capSickTicks = 0, mutedByUs = false, capNote = '';
  if (CAPTURE) {
    cap = CaptureStream(function (type, data) {
      if (type === 'unsupported') { capNote = 'Formato audio non gestito (' + data + '): per questo video la tonalità resta quella originale.'; dirty = true; }
      if (type === 'track') { capNote = ''; dirty = true; }
    });
    cap.install();
  }

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error('timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }

  var WORKLET_TAIL =
    'class YtPitch extends AudioWorkletProcessor{constructor(){super();this.c=PC(sampleRate);' +
    'this.port.onmessage=e=>{var d=e.data;if(d&&typeof d.st==="number")this.c.setSemitones(d.st)}}' +
    'process(i,o){this.c.process(i[0],o[0]);return true}}' +
    'registerProcessor("yt-pitch-v1",YtPitch);';

  function createEngine() {
    var code = 'var PC=' + PitchCore.toString() + ';\n' + WORKLET_TAIL;
    var urls = [];
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try { urls.push(URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))); } catch (e) { /* ignora */ }
      urls.push('data:text/javascript;charset=utf-8,' + encodeURIComponent(code));
    }
    var i = 0;
    function next() {
      if (i >= urls.length) return Promise.resolve(scriptEngine());
      var u = urls[i++];
      return withTimeout(ctx.audioWorklet.addModule(u), 5000).then(function () {
        var node = new AudioWorkletNode(ctx, 'yt-pitch-v1', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        return { kind: 'worklet', input: node, output: node, set: function (st) { node.port.postMessage({ st: st }); } };
      }).catch(next);
    }
    return next();
  }

  // Ripiego: stesso algoritmo, eseguito sul thread della pagina.
  function scriptEngine() {
    var sp = ctx.createScriptProcessor(2048, 2, 2);
    var core = PitchCore(ctx.sampleRate);
    sp.onaudioprocess = function (e) {
      var ib = e.inputBuffer, ob = e.outputBuffer;
      var l = ib.getChannelData(0), r = ib.numberOfChannels > 1 ? ib.getChannelData(1) : l;
      core.process([l, r], [ob.getChannelData(0), ob.getChannelData(1)]);
    };
    return { kind: 'script', input: sp, output: sp, set: function (st) { core.setSemitones(st); } };
  }

  // Motore della modalità iPhone: legge l'audio catturato alla posizione del
  // video (con un piccolo anticipo che compensa il ritardo d'uscita), corregge
  // la deriva con variazioni minime di velocità e passa tutto al PitchCore.
  function captureEngine() {
    var N = 4096;
    var sp = ctx.createScriptProcessor(N, 1, 2);
    var core = PitchCore(ctx.sampleRate);
    var sr = ctx.sampleRate;
    var tmpL = new Float32Array(N), tmpR = new Float32Array(N);
    var pos = null, fade = 0;
    // ScriptProcessor su alcuni WebKit gira solo se ha un ingresso collegato
    var feed = ctx.createBufferSource();
    feed.buffer = ctx.createBuffer(1, 128, sr); feed.loop = true;
    feed.connect(sp); feed.start();
    function lead() { return N / sr + (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + 0.02; }
    sp.onaudioprocess = function (e) {
      var ob = e.outputBuffer, oL = ob.getChannelData(0), oR = ob.getChannelData(1);
      var v = curEl, i;
      var playing = v && !v.paused && !v.seeking && !v.ended && v.readyState >= 2;
      if (!playing) {
        pos = null;
        for (i = 0; i < N; i++) { tmpL[i] = 0; tmpR[i] = 0; }
      } else {
        var target = v.currentTime + lead();
        if (pos === null || Math.abs(target - pos) > 0.25) { pos = target; fade = 0; }
        var drift = target - pos;
        var rate = (v.playbackRate || 1) * (1 + Math.max(-0.02, Math.min(0.02, drift * 0.5)));
        var inc = rate / sr;
        cap.read(pos, inc, tmpL, tmpR, N);
        pos += inc * N;
        if (fade < 512) { for (i = 0; i < N && fade < 512; i++, fade++) { var g = fade / 512; tmpL[i] *= g; tmpR[i] *= g; } }
        // il video originale deve restare muto mentre suona il nostro audio
        if (ctx.state === 'running' && cap.has(v.currentTime + 0.05) && !v.muted) { v.muted = true; mutedByUs = true; }
      }
      core.process([tmpL, tmpR], [oL, oR]);
    };
    return { kind: 'capture', input: null, output: sp, set: function (st) { core.setSemitones(st); } };
  }

  // Va chiamata dentro un tocco dell'utente: iOS sblocca l'audio solo così.
  // Il grafo si costruisce anche a contesto sospeso; il <video> viene
  // agganciato solo quando il contesto gira davvero (vedi attach).
  function startAudio() {
    if (ctx) { resumeIfNeeded(); return starting.then(function (ok) { attach(); refresh(); return ok; }); }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* non supportato */ }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { audioErr = 'Questo browser non supporta Web Audio'; refresh(); return Promise.resolve(false); }
    try { ctx = new AC({ latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    ctx.onstatechange = function () { attach(); refresh(); };
    resumeIfNeeded(); // subito, finché siamo dentro il gesto
    if (CAPTURE) {
      cap.setContext(ctx);
      starting = Promise.resolve().then(function () {
        engine = captureEngine(); engineKind = engine.kind;
        master = ctx.createGain(); master.gain.value = window[NS + 'Mute'] ? 0 : 1; // usato solo nei test
        engine.output.connect(master); master.connect(ctx.destination);
        outMeter = ctx.createAnalyser(); outMeter.fftSize = 2048;
        engine.output.connect(outMeter);
        engine.set(semis);
        attach(); refresh();
        return true;
      }).catch(function (e) {
        audioErr = 'Avvio audio non riuscito: ' + (e && e.message || e);
        refresh();
        return false;
      });
      return starting;
    }
    starting = createEngine().then(function (eng) {
      engine = eng; engineKind = eng.kind;
      dry = ctx.createGain(); wet = ctx.createGain();
      dry.gain.value = semis === 0 ? 1 : 0; wet.gain.value = semis === 0 ? 0 : 1;
      master = ctx.createGain(); master.gain.value = window[NS + 'Mute'] ? 0 : 1; // usato solo nei test
      engine.output.connect(wet);
      dry.connect(master); wet.connect(master); master.connect(ctx.destination);
      outMeter = ctx.createAnalyser(); outMeter.fftSize = 2048; // misura l'uscita (diagnostica)
      dry.connect(outMeter); wet.connect(outMeter);
      analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
      var sink = ctx.createGain(); sink.gain.value = 0;
      analyser.connect(sink); sink.connect(ctx.destination);
      engine.set(semis);
      attach(); refresh();
      return true;
    }).catch(function (e) {
      audioErr = 'Avvio audio non riuscito: ' + (e && e.message || e);
      refresh();
      return false;
    });
    return starting;
  }

  function resumeIfNeeded() {
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
      try { var p = ctx.resume(); if (p && p.then) p.then(function () { attach(); refresh(); }, function () { /* serve un tocco */ }); }
      catch (e) { /* ignora */ }
    }
  }

  function getVideo() {
    return document.querySelector('#movie_player video') ||
      document.querySelector('.html5-video-player video') ||
      document.querySelector('video');
  }

  // Collega il <video> al nostro grafo, solo quando l'audio è attivo:
  // agganciarlo a un contesto sospeso lo renderebbe muto.
  function attach() {
    if (CAPTURE) {
      var cv = getVideo();
      if (cv && cv !== curEl) {
        cv.addEventListener('ended', onEnded);
        cv.addEventListener('play', resumeIfNeeded);
        cv.addEventListener('playing', resumeIfNeeded);
        curEl = cv; stuckTicks = 0;
      }
      return;
    }
    if (!engine || !ctx || ctx.state !== 'running') return;
    var v = getVideo();
    if (!v || v === curEl) return;
    var src = sources && sources.get(v);
    if (!src) {
      try { src = ctx.createMediaElementSource(v); }
      catch (e) { audioErr = 'Non riesco ad agganciare l\'audio del video: ' + (e && e.message || e); refresh(); return; }
      if (sources) sources.set(v, src);
      v.addEventListener('ended', onEnded);
      v.addEventListener('play', resumeIfNeeded);
      v.addEventListener('playing', resumeIfNeeded);
    }
    if (curSrc) { try { curSrc.disconnect(); } catch (e) { /* ignora */ } }
    src.connect(dry); src.connect(engine.input); src.connect(analyser);
    curEl = v; curSrc = src; silentTicks = 0; stuckTicks = 0; warn = '';
  }

  function applySemis(st, opts) {
    st = Math.max(-12, Math.min(12, Math.round(st)));
    semis = st;
    if (engine) engine.set(st);
    if (engine && dry) {
      var t = ctx.currentTime;
      dry.gain.setTargetAtTime(st === 0 ? 1 : 0, t, 0.015);
      wet.gain.setTargetAtTime(st === 0 ? 0 : 1, t, 0.015);
    }
    if (!opts || opts.save !== false) remember();
    refresh();
  }

  function changeSemis(delta) {
    var p = startAudio();
    applySemis(semis + delta);
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Video corrente e memoria per brano                                  */
  /* ------------------------------------------------------------------ */
  function player() { return document.getElementById('movie_player') || document.querySelector('.html5-video-player'); }

  function currentVideo() {
    var p = player();
    try {
      var d = p && typeof p.getVideoData === 'function' && p.getVideoData();
      if (d && d.video_id) return { id: d.video_id, title: d.title || '', author: d.author || '' };
    } catch (e) { /* API del player non disponibile */ }
    var m = location.href.match(/[?&]v=([\w-]{11})/) || location.pathname.match(/\/shorts\/([\w-]{11})/);
    if (!m) return null;
    return { id: m[1], title: document.title.replace(/\s*-\s*YouTube\s*$/, ''), author: '' };
  }

  var cur = null; // {id, title, author}

  function remember() {
    if (!cur) return;
    var s = db.songs[cur.id];
    if (semis === 0 && !inAnyPlaylist(cur.id)) { if (s) { delete db.songs[cur.id]; save(); } return; }
    db.songs[cur.id] = { t: cur.title || (s && s.t) || cur.id, a: cur.author || (s && s.a) || '', s: semis, u: Date.now() };
    save();
  }

  function ensureSong(id, title, author) {
    if (!db.songs[id]) db.songs[id] = { t: title || id, a: author || '', s: id === (cur && cur.id) ? semis : 0, u: Date.now() };
    return db.songs[id];
  }

  function onVideoChange() {
    var s = cur && db.songs[cur.id];
    applySemis(s ? s.s : 0, { save: false });
    if (play && cur) {
      var pl = plById(play.pid);
      var expected = pl && pl.items[play.i];
      if (cur.id !== expected) {
        if (Date.now() - play.at < 8000 && !play.retried) { play.retried = true; loadVideo(expected); }
        else { play = null; toast('Playlist interrotta: hai aperto un altro video'); }
      }
    }
    dirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* Riproduzione playlist                                               */
  /* ------------------------------------------------------------------ */
  var play = null; // {pid, i, at, retried}

  function loadVideo(id) {
    var p = player();
    if (p && typeof p.loadVideoById === 'function') {
      try {
        var v = getVideo();
        var wantSound = !(v && v.muted) && !(p.isMuted && p.isMuted());
        p.loadVideoById(id);
        // Senza un tocco dell'utente YouTube fa partire il video successivo muto:
        // se prima si sentiva, togliamo il muto e ci assicuriamo che suoni.
        if (wantSound || CAPTURE) keepSound(p, 12);
        setTimeout(function () {
          var c = currentVideo();
          if (play && (!c || c.id !== id)) navigateTo(id);
        }, 4000);
        return;
      } catch (e) { /* passa al ripiego */ }
    }
    navigateTo(id);
  }

  function keepSound(p, tries) {
    setTimeout(function () {
      try {
        var v = getVideo();
        if (!CAPTURE) {
          if (p.isMuted && p.isMuted()) p.unMute();
          if (v && v.muted) v.muted = false;
        }
        if (v && v.paused && p.playVideo) p.playVideo();
        resumeIfNeeded();
      } catch (e) { /* riprova al giro dopo */ }
      // continua a controllare per qualche secondo: YouTube può rimettere il muto dopo il caricamento
      if (tries > 1) keepSound(p, tries - 1);
    }, 500);
  }

  // Ripiego: ricarica la pagina sul nuovo video. Il bookmarklet va ritoccato,
  // ma la posizione nella playlist viene ripresa automaticamente.
  function navigateTo(id) {
    if (play) { db.pending = { pid: play.pid, i: play.i, id: id, ts: Date.now() }; save(); }
    location.href = location.origin + '/watch?v=' + id;
  }

  function playAt(pid, i) {
    var pl = plById(pid);
    if (!pl || !pl.items.length) { toast('La playlist è vuota'); return; }
    if (i >= pl.items.length) { if (db.loop) i = 0; else { stopPlay(); toast('Fine playlist'); return; } }
    if (i < 0) i = 0;
    startAudio();
    play = { pid: pid, i: i, at: Date.now(), retried: false };
    var id = pl.items[i];
    var s = db.songs[id];
    if (s) applySemis(s.s, { save: false });
    loadVideo(id);
    setMediaSession();
    dirty = true; refresh();
  }
  function nextTrack() { if (play) playAt(play.pid, play.i + 1); }
  function prevTrack() { if (play) playAt(play.pid, Math.max(0, play.i - 1)); }
  function stopPlay() { play = null; clearMediaSession(); dirty = true; refresh(); }
  function onEnded() { if (play) nextTrack(); }

  function setMediaSession() {
    if (!play || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
      navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
    } catch (e) { /* non supportato */ }
  }
  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('nexttrack', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
    } catch (e) { /* non supportato */ }
  }

  /* ------------------------------------------------------------------ */
  /* Ciclo di controllo                                                  */
  /* ------------------------------------------------------------------ */
  var dirty = true;
  var tickBuf = null;

  function tick() {
    var c = currentVideo();
    if (c && (!cur || c.id !== cur.id)) { cur = c; onVideoChange(); }
    else if (c && cur && c.title && c.title !== cur.title) {
      cur.title = c.title; cur.author = c.author || cur.author;
      if (db.songs[cur.id] && db.songs[cur.id].t !== c.title) { db.songs[cur.id].t = c.title; save(); }
      dirty = true;
    } else if (!c && cur) { cur = null; dirty = true; }

    attach();
    if (play) setMediaSession();
    if (curEl && play && curEl.ended && Date.now() - play.at > 5000) onEnded();
    if (CAPTURE) checkCapture(); else checkSilence();
    refresh();
  }

  // Modalità iPhone: se l'audio trasposto non è pronto (inizio, ricerca nel video,
  // errore), ridà voce al video originale invece di lasciare silenzio.
  function checkCapture() {
    var v = curEl;
    if (!v) return;
    cap.evict(v.currentTime);
    var playing = !v.paused && !v.ended;
    var ready = !!(ctx && ctx.state === 'running' && cap.has(v.currentTime + 0.05));
    if (ready) { capSickTicks = 0; capHealthyAt = Date.now(); }
    else if (playing) capSickTicks++;
    if (!ready && playing && capSickTicks >= 3 && mutedByUs && v.muted) { v.muted = false; mutedByUs = false; }
    var w = '';
    if (capNote) w = capNote;
    else if (playing && !cap.hasTrack()) w = 'Audio di YouTube non ancora agganciato: tocca il preferito su un video appena aperto, oppure ricarica la pagina.';
    else if (playing && capSickTicks >= 3 && ctx && ctx.state === 'running') w = 'Preparo l\'audio trasposto… Intanto senti l\'audio originale.';
    if (w !== warn) { warn = w; dirty = true; }
  }

  // Diagnostica: se il video avanza ma dal grafo non arriva suono, avvisa.
  function checkSilence() {
    var v = curEl;
    if (!v || !analyser || !ctx || ctx.state !== 'running') return;
    if (v.paused || v.muted || v.volume === 0) { silentTicks = 0; stuckTicks = 0; return; }
    if (!tickBuf) tickBuf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(tickBuf);
    var m = 0;
    for (var i = 0; i < tickBuf.length; i++) { var a = Math.abs(tickBuf[i]); if (a > m) m = a; }
    silentTicks = m < 1e-5 ? silentTicks + 1 : 0;
    stuckTicks = v.currentTime === lastTime ? stuckTicks + 1 : 0;
    lastTime = v.currentTime;
    var w = '';
    if (stuckTicks >= 5) w = 'Il video sembra bloccato. Se non riparte, ricarica la pagina.';
    else if (silentTicks >= 6) w = 'Dal video non arriva audio. Ricarica la pagina e riprova; alcuni video potrebbero non permettere l\'aggancio dell\'audio.';
    if (w !== warn) { warn = w; dirty = true; }
  }

  /* ------------------------------------------------------------------ */
  /* Interfaccia (Shadow DOM, niente innerHTML per i Trusted Types)      */
  /* ------------------------------------------------------------------ */
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) for (var k in props) {
      var v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;-webkit-tap-highlight-color:transparent}',
    '.wrap{--bg:#16181d;--bg2:#22252c;--bg3:#2e323b;--fg:#f2f3f5;--mut:#9aa0ab;--acc:#ffb020;--ok:#3ecf8e;--bad:#ff5d5d;color:var(--fg)}',
    '.bar{position:fixed;right:10px;z-index:2147483646;display:flex;align-items:center;gap:2px;background:var(--bg);border:1px solid #3a3f4a;border-radius:999px;padding:4px;box-shadow:0 6px 24px rgba(0,0,0,.45)}',
    '.bar.bottom{bottom:calc(env(safe-area-inset-bottom,0px) + 72px)}.bar.top{top:calc(env(safe-area-inset-top,0px) + 60px)}',
    'button{appearance:none;-webkit-appearance:none;border:0;background:var(--bg2);color:var(--fg);font-size:15px;font-weight:600;border-radius:999px;min-width:40px;height:40px;padding:0 12px;cursor:pointer;touch-action:manipulation}',
    'button:active{background:var(--bg3)}',
    '.bar button{background:transparent;min-width:42px;font-size:20px;padding:0 8px}',
    '.bar .val{font-size:16px;min-width:64px;font-variant-numeric:tabular-nums}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--mut);display:inline-block;margin-right:6px;vertical-align:middle}',
    '.dot.on{background:var(--ok)}.dot.warn{background:var(--acc)}.dot.bad{background:var(--bad)}',
    '.sheet{position:fixed;left:0;right:0;bottom:0;max-height:78vh;overflow-y:auto;-webkit-overflow-scrolling:touch;z-index:2147483647;background:var(--bg);border-top:1px solid #3a3f4a;border-radius:18px 18px 0 0;padding:14px 16px calc(env(safe-area-inset-bottom,0px) + 18px);box-shadow:0 -10px 40px rgba(0,0,0,.5);font-size:15px;line-height:1.35}',
    '.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}',
    '.hdr b{font-size:17px}',
    '.mut{color:var(--mut);font-size:13px}',
    '.warn{background:#3a2a10;color:#ffd38a;border-radius:10px;padding:8px 10px;margin:8px 0;font-size:13px}',
    '.err{background:#3a1515;color:#ffb3b3;border-radius:10px;padding:8px 10px;margin:8px 0;font-size:13px}',
    'h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:18px 0 8px;font-weight:700}',
    '.title{font-size:15px;font-weight:600;margin:2px 0 10px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.big{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--bg2);border-radius:16px;padding:8px}',
    '.big button{width:64px;height:56px;font-size:28px;background:var(--bg3);border-radius:12px}',
    '.big .n{flex:1;text-align:center}.big .n div:first-child{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1}',
    '.acc{background:var(--acc);color:#1b1300}.acc:active{background:#e09a10}',
    '.ghost{background:transparent;border:1px solid #3a3f4a}',
    'select{appearance:none;-webkit-appearance:none;background:var(--bg2);color:var(--fg);border:1px solid #3a3f4a;border-radius:10px;height:40px;padding:0 12px;font-size:15px;flex:1;min-width:0}',
    'ol{list-style:none;margin:8px 0 0;padding:0}',
    'li{display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid #262a32}',
    'li .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:6px 0}',
    'li .t small{display:block;color:var(--mut);font-size:12px}',
    'li.now .t{color:var(--acc)}',
    'li button{min-width:36px;height:36px;padding:0 8px;font-size:15px;background:var(--bg2)}',
    '.badge{font-variant-numeric:tabular-nums;font-size:13px;background:var(--bg3);border-radius:999px;padding:3px 8px;min-width:36px;text-align:center}',
    '.badge.z{color:var(--mut)}',
    'textarea{width:100%;min-height:110px;background:var(--bg2);color:var(--fg);border:1px solid #3a3f4a;border-radius:10px;padding:8px;font:12px ui-monospace,Menlo,monospace}',
    '.toast{position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 14px);z-index:2147483647;background:#000c;color:#fff;padding:10px 14px;border-radius:12px;font-size:14px;max-width:90vw;text-align:center}',
    '.empty{color:var(--mut);font-size:13px;padding:8px 0}',
    '.mt8{margin-top:8px}.mt10{margin-top:10px}.mt14{margin-top:14px}'
  ].join('\n');

  var host = h('div', { id: 'yt-transpose-host' });
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  try {
    var sheetCss = new CSSStyleSheet();
    sheetCss.replaceSync(CSS);
    root.adoptedStyleSheets = [sheetCss];
  } catch (e) {
    var st = document.createElement('style'); st.textContent = CSS; root.appendChild(st);
  }
  var wrap = h('div', { class: 'wrap' });
  root.appendChild(wrap);
  (document.body || document.documentElement).appendChild(host);

  var visible = true, sheetOpen = false, showStored = false, showBackup = false;
  var barEl = null, sheetEl = null, toastEl = null, toastT = null;

  function fmt(st) { return st > 0 ? '+' + st : String(st); }
  function stateDot() {
    if (audioErr) return 'bad';
    if (warn) return 'warn';
    if (ctx && ctx.state === 'running' && curEl) return 'on';
    return '';
  }

  function toast(msg) {
    if (toastEl) toastEl.remove();
    toastEl = h('div', { class: 'toast', text: msg });
    wrap.appendChild(toastEl);
    clearTimeout(toastT);
    toastT = setTimeout(function () { if (toastEl) { toastEl.remove(); toastEl = null; } }, 2600);
  }

  // Ogni pulsante: azione + sblocco audio (siamo dentro il tocco).
  function act(fn) { return function (e) { e.preventDefault(); e.stopPropagation(); resumeIfNeeded(); fn(e); }; }

  function buildBar() {
    return h('div', { class: 'bar ' + (db.pos === 'top' ? 'top' : 'bottom') },
      h('button', { 'aria-label': 'Abbassa di un semitono', text: '−', onclick: act(function () { changeSemis(-1); }) }),
      h('button', { class: 'val', 'aria-label': 'Apri pannello', onclick: act(function () { startAudio(); sheetOpen = !sheetOpen; dirty = true; refresh(); }) },
        h('span', { class: 'dot ' + stateDot() }), fmt(semis)),
      h('button', { 'aria-label': 'Alza di un semitono', text: '+', onclick: act(function () { changeSemis(1); }) }),
      h('button', { 'aria-label': 'Playlist e impostazioni', text: '☰', onclick: act(function () { startAudio(); sheetOpen = !sheetOpen; dirty = true; refresh(); }) })
    );
  }

  function statusText() {
    if (audioErr) return audioErr;
    if (!ctx) return 'Tocca − o + per attivare l\'audio.';
    if (ctx.state !== 'running') return 'Audio in pausa: tocca un pulsante per riattivarlo.';
    if (!curEl) return 'In attesa del video…';
    if (CAPTURE) return cap.has(curEl.currentTime + 0.05) ? 'Attivo · modalità iPhone' : 'Modalità iPhone · in attesa dell\'audio';
    return 'Attivo';
  }

  function songLabel(id) {
    var s = db.songs[id];
    return { t: (s && s.t) || id, a: (s && s.a) || '', s: s ? s.s : 0 };
  }

  function buildSheet() {
    var pl = curPl();
    var playingHere = play && play.pid === pl.id;

    var items = pl.items.map(function (id, i) {
      var L = songLabel(id);
      var now = playingHere && play.i === i;
      return h('li', { class: now ? 'now' : '' },
        h('span', { class: 'badge' + (L.s === 0 ? ' z' : ''), text: fmt(L.s) }),
        h('div', { class: 't', onclick: act(function () { playAt(pl.id, i); }) }, (now ? '▶ ' : '') + L.t, L.a ? h('small', { text: L.a }) : null),
        h('button', { 'aria-label': 'Sposta su', text: '↑', disabled: i === 0, onclick: act(function () { move(pl, i, -1); }) }),
        h('button', { 'aria-label': 'Sposta giù', text: '↓', disabled: i === pl.items.length - 1, onclick: act(function () { move(pl, i, 1); }) }),
        h('button', { 'aria-label': 'Togli dalla playlist', text: '✕', onclick: act(function () { removeItem(pl, i); }) })
      );
    });

    var stored = Object.keys(db.songs).sort(function (a, b) { return (db.songs[b].u || 0) - (db.songs[a].u || 0); });

    return h('div', { class: 'sheet' },
      h('div', { class: 'hdr' },
        h('div', null, h('b', { text: 'YT Transpose' }), ' ', h('span', { class: 'mut' }, h('span', { class: 'dot ' + stateDot() }), statusText())),
        h('button', { class: 'ghost', text: 'Chiudi', onclick: act(function () { sheetOpen = false; dirty = true; refresh(); }) })
      ),
      warn ? h('div', { class: 'warn', text: warn }) : null,

      h('h3', { text: 'Brano attuale' }),
      h('div', { class: 'title', text: cur ? (cur.title || cur.id) : 'Nessun video aperto' }),
      h('div', { class: 'big' },
        h('button', { 'aria-label': 'Giù di un semitono', text: '−', onclick: act(function () { changeSemis(-1); }) }),
        h('div', { class: 'n' }, h('div', { text: fmt(semis) }), h('div', { class: 'mut', text: semis === 0 ? 'tonalità originale' : (Math.abs(semis) === 1 ? 'semitono' : 'semitoni') })),
        h('button', { 'aria-label': 'Su di un semitono', text: '+', onclick: act(function () { changeSemis(1); }) })
      ),
      h('div', { class: 'row mt10' },
        h('button', { text: 'Originale (0)', onclick: act(function () { startAudio(); applySemis(0); }) }),
        h('button', { class: 'acc', text: '＋ Aggiungi a “' + pl.name + '”', disabled: !cur, onclick: act(addCurrent) })
      ),
      cur && db.songs[cur.id] ? h('div', { class: 'mut mt8', text: 'Memorizzato: riaprendo questo video tornerà a ' + fmt(db.songs[cur.id].s) + '.' }) : null,

      h('h3', { text: 'Playlist' }),
      h('div', { class: 'row' },
        h('select', { onchange: function (e) { db.cur = e.target.value; save(); dirty = true; refresh(); } },
          db.playlists.map(function (p) { var o = h('option', { value: p.id, text: p.name + ' (' + p.items.length + ')' }); if (p.id === pl.id) o.selected = true; return o; })),
        h('button', { text: 'Nuova', onclick: act(newPlaylist) }),
        h('button', { text: '✎', 'aria-label': 'Rinomina playlist', onclick: act(renamePlaylist) }),
        h('button', { text: '🗑', 'aria-label': 'Elimina playlist', onclick: act(deletePlaylist) })
      ),
      h('div', { class: 'row mt8' },
        playingHere
          ? [h('button', { text: '⏮', 'aria-label': 'Precedente', onclick: act(prevTrack) }),
             h('button', { text: '⏭', 'aria-label': 'Successivo', onclick: act(nextTrack) }),
             h('button', { text: '■ Stop', onclick: act(stopPlay) })]
          : h('button', { class: 'acc', text: '▶ Riproduci', disabled: !pl.items.length, onclick: act(function () { playAt(pl.id, 0); }) }),
        h('button', { class: db.loop ? 'acc' : '', text: '🔁 ' + (db.loop ? 'Ripeti: sì' : 'Ripeti: no'), onclick: act(function () { db.loop = !db.loop; save(); dirty = true; refresh(); }) })
      ),
      pl.items.length ? h('ol', null, items) : h('div', { class: 'empty', text: 'Vuota. Apri un video, scegli la tonalità e tocca “Aggiungi”.' }),

      h('h3', { text: 'Brani memorizzati (' + stored.length + ')' }),
      h('button', { class: 'ghost', text: showStored ? 'Nascondi elenco' : 'Mostra elenco', onclick: act(function () { showStored = !showStored; dirty = true; refresh(); }) }),
      showStored ? (stored.length ? h('ol', null, stored.map(function (id) {
        var L = songLabel(id);
        return h('li', null,
          h('span', { class: 'badge' + (L.s === 0 ? ' z' : ''), text: fmt(L.s) }),
          h('div', { class: 't', onclick: act(function () { startAudio(); play = null; applySemis(L.s, { save: false }); loadVideo(id); }) }, L.t, L.a ? h('small', { text: L.a }) : null),
          h('button', { text: '＋', 'aria-label': 'Aggiungi alla playlist', onclick: act(function () { addToPl(curPl(), id); }) }),
          h('button', { text: '✕', 'aria-label': 'Dimentica', onclick: act(function () { forget(id); }) })
        );
      })) : h('div', { class: 'empty', text: 'Nessun brano: cambia tonalità a un video e verrà ricordata.' })) : null,

      h('h3', { text: 'Backup e opzioni' }),
      h('div', { class: 'row' },
        h('button', { text: 'Copia backup', onclick: act(exportBackup) }),
        h('button', { text: 'Ripristina…', onclick: act(function () { showBackup = !showBackup; dirty = true; refresh(); }) }),
        h('button', { text: db.pos === 'top' ? 'Barra in basso' : 'Barra in alto', onclick: act(function () { db.pos = db.pos === 'top' ? 'bottom' : 'top'; save(); dirty = true; refresh(); }) }),
        h('button', { class: 'ghost', text: 'Nascondi tutto', onclick: act(function () { hide(); toast('Tocca di nuovo il preferito per riaprire'); }) })
      ),
      showBackup ? h('div', { class: 'mt8' },
        h('div', { class: 'mut', text: 'Incolla qui il testo del backup (sostituisce i dati attuali).' }),
        h('textarea', { id: 'bk', placeholder: '{"v":1,…}' }),
        h('button', { class: 'acc mt8', text: 'Ripristina dal testo', onclick: act(importBackup) })
      ) : null,
      storeNotice(),
      h('div', { class: 'mut mt14', text: 'v' + VERSION + ' · i dati restano su questo iPhone, in questo browser.' })
    );
  }

  function storeNotice() {
    if (store.mode === 'local') return h('div', { class: 'mut mt8', text: 'Salvataggio attivo.' });
    if (store.mode === 'idb') return h('div', { class: 'mut mt8', text: 'Salvataggio attivo nel database del browser (la memoria normale di YouTube è piena: va bene così).' });
    return h('div', { class: 'warn' },
      h('b', { text: 'Le tonalità e le playlist non si salvano.' }), ' ',
      store.reason === 'blocked'
        ? 'Brave blocca i dati dei siti per YouTube. Su YouTube tocca l\'icona del leone di Brave e consenti i cookie (o abbassa gli Shields) per youtube.com; controlla anche che in Impostazioni → Shields e privacy non sia attivo «Blocca tutti i cookie». Poi ricarica la pagina e tocca di nuovo il preferito.'
        : 'Lo spazio del browser per YouTube è pieno. Nelle impostazioni di Brave cancella i dati di navigazione (cookie e dati dei siti), poi riapri YouTube e tocca di nuovo il preferito.',
      ' Intanto, prima di chiudere, usa «Copia backup».');
  }

  var lastBarKey = '';
  function refresh() {
    if (!visible) return;
    var key = semis + '|' + stateDot() + '|' + db.pos;
    if (!barEl || key !== lastBarKey) {
      var nb = buildBar();
      if (barEl) barEl.replaceWith(nb); else wrap.appendChild(nb);
      barEl = nb; lastBarKey = key;
      if (sheetOpen) dirty = true; // lo stato appare anche nel pannello
    }
    if (!sheetOpen) { if (sheetEl) { sheetEl.remove(); sheetEl = null; } return; }
    if (!dirty && sheetEl) return;
    var scroll = sheetEl ? sheetEl.scrollTop : 0;
    var keep = sheetEl && root.getElementById ? root.getElementById('bk') : null;
    var keepVal = keep ? keep.value : '';
    var ns = buildSheet();
    if (sheetEl) sheetEl.replaceWith(ns); else wrap.appendChild(ns);
    sheetEl = ns; sheetEl.scrollTop = scroll; dirty = false;
    if (keepVal) { var t = root.getElementById('bk'); if (t) t.value = keepVal; }
  }

  /* ------------------------------------------------------------------ */
  /* Azioni playlist / memoria / backup                                  */
  /* ------------------------------------------------------------------ */
  function addToPl(pl, id) {
    if (pl.items.indexOf(id) >= 0) { toast('Già presente in “' + pl.name + '”'); return; }
    pl.items.push(id);
    save(); dirty = true; refresh();
    toast('Aggiunto a “' + pl.name + '”');
  }
  function addCurrent() {
    if (!cur) return;
    var s = ensureSong(cur.id, cur.title, cur.author);
    s.s = semis; s.t = cur.title || s.t; s.u = Date.now();
    addToPl(curPl(), cur.id);
  }
  function move(pl, i, dir) {
    var j = i + dir;
    if (j < 0 || j >= pl.items.length) return;
    var x = pl.items[i]; pl.items[i] = pl.items[j]; pl.items[j] = x;
    if (play && play.pid === pl.id) { if (play.i === i) play.i = j; else if (play.i === j) play.i = i; }
    save(); dirty = true; refresh();
  }
  function removeItem(pl, i) {
    var id = pl.items[i];
    pl.items.splice(i, 1);
    if (play && play.pid === pl.id) { if (play.i === i) stopPlay(); else if (play.i > i) play.i--; }
    var s = db.songs[id];
    if (s && s.s === 0 && !inAnyPlaylist(id)) delete db.songs[id];
    save(); dirty = true; refresh();
  }
  function forget(id) {
    if (inAnyPlaylist(id)) { db.songs[id].s = 0; toast('È in una playlist: tonalità riportata a 0'); }
    else delete db.songs[id];
    if (cur && cur.id === id) applySemis(0, { save: false });
    save(); dirty = true; refresh();
  }
  function newPlaylist() {
    var name = prompt('Nome della nuova playlist', 'Playlist ' + (db.playlists.length + 1));
    if (!name) return;
    var p = { id: 'p' + Date.now().toString(36), name: name.trim().slice(0, 60) || 'Playlist', items: [] };
    db.playlists.push(p); db.cur = p.id;
    save(); dirty = true; refresh();
  }
  function renamePlaylist() {
    var pl = curPl();
    var name = prompt('Nuovo nome', pl.name);
    if (!name) return;
    pl.name = name.trim().slice(0, 60) || pl.name;
    save(); dirty = true; refresh();
  }
  function deletePlaylist() {
    var pl = curPl();
    if (!confirm('Eliminare la playlist “' + pl.name + '”? I brani restano memorizzati.')) return;
    if (play && play.pid === pl.id) stopPlay();
    db.playlists = db.playlists.filter(function (p) { return p.id !== pl.id; });
    if (!db.playlists.length) db.playlists = emptyDb().playlists;
    db.cur = db.playlists[0].id;
    save(); dirty = true; refresh();
  }
  function exportBackup() {
    var txt = JSON.stringify(db);
    var done = function () { toast('Backup copiato: incollalo in Note per conservarlo'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt); });
    } else fallbackCopy(txt);
  }
  function fallbackCopy(txt) {
    showBackup = true; dirty = true; refresh();
    var t = root.getElementById ? root.getElementById('bk') : null;
    if (t) { t.value = txt; t.focus(); t.select(); try { document.execCommand('copy'); toast('Backup copiato'); } catch (e) { toast('Seleziona il testo e copialo'); } }
  }
  function importBackup() {
    var t = root.getElementById ? root.getElementById('bk') : null;
    if (!t || !t.value.trim()) { toast('Incolla prima il testo del backup'); return; }
    try {
      var d = JSON.parse(t.value);
      if (!d || d.v !== 1 || !d.songs || !Array.isArray(d.playlists)) throw new Error('formato');
      if (!confirm('Sostituire tutti i dati attuali con il backup?')) return;
      db = d;
      if (!db.playlists.length) db.playlists = emptyDb().playlists;
      if (!plById(db.cur)) db.cur = db.playlists[0].id;
      save(); play = null; showBackup = false; dirty = true;
      var s = cur && db.songs[cur.id];
      applySemis(s ? s.s : 0, { save: false });
      toast('Backup ripristinato');
    } catch (e) { toast('Testo non valido: non sembra un backup di YT Transpose'); }
  }

  function hide() { visible = false; wrap.style.display = 'none'; }
  function show() { visible = true; wrap.style.display = ''; dirty = true; barEl = null; lastBarKey = ''; while (wrap.firstChild) wrap.removeChild(wrap.firstChild); sheetEl = null; refresh(); }

  /* ------------------------------------------------------------------ */
  /* Avvio                                                               */
  /* ------------------------------------------------------------------ */
  window[NS] = {
    version: VERSION,
    toggle: function () {
      if (!document.getElementById('yt-transpose-host')) (document.body || document.documentElement).appendChild(host);
      if (visible) { sheetOpen = !sheetOpen; dirty = true; refresh(); } else show();
      startAudio();
    },
    _debug: function () {
      function peak(an) {
        if (!an) return 0;
        var b = new Float32Array(an.fftSize), m = 0; an.getFloatTimeDomainData(b);
        for (var i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i]));
        return m;
      }
      return { capture: cap ? cap.stats() : null, ahead: cap && curEl ? +cap.bufferedAhead(curEl.currentTime).toFixed(2) : null, mutedByUs: mutedByUs, store: store.mode + (store.reason ? ':' + store.reason : ''), ctx: ctx && ctx.state, engine: engineKind, semis: semis, cur: cur, play: play, warn: warn, err: audioErr, attached: !!curEl, inLevel: peak(analyser), outLevel: peak(outMeter), db: db };
    },
    _cap: cap,
    _act: { change: changeSemis, playAt: playAt, next: nextTrack, add: addCurrent }
  };

  document.addEventListener('visibilitychange', resumeIfNeeded);

  cur = currentVideo();
  if (cur && db.songs[cur.id]) semis = db.songs[cur.id].s;
  refresh();
  startAudio(); // funziona se il tocco sul preferito conta come gesto; altrimenti basta toccare un pulsante
  if (CAPTURE) {
    // Il flusso audio è già partito prima dell'aggancio: ricarichiamo lo stesso video
    // dallo stesso punto, così YouTube rimanda anche l'intestazione che serve a decodificarlo.
    (function () {
      var p = player(), v = getVideo(), c = currentVideo();
      if (p && typeof p.loadVideoById === 'function' && c) {
        try { p.loadVideoById(c.id, v ? v.currentTime : 0); keepSound(p, 8); } catch (e) { /* ignora */ }
      }
    })();
  }
  setInterval(tick, 1000);

  // Dopo il primo disegno: recupera l'eventuale copia più recente da IndexedDB,
  // riprende una playlist interrotta da un ricaricamento, poi verifica che il salvataggio funzioni.
  loadFromIdb().then(function (replaced) {
    if (replaced && cur) applySemis(db.songs[cur.id] ? db.songs[cur.id].s : 0, { save: false });
    if (db.pending && cur && db.pending.id === cur.id && Date.now() - db.pending.ts < 10 * 60 * 1000 && plById(db.pending.pid)) {
      play = { pid: db.pending.pid, i: db.pending.i, at: Date.now(), retried: true };
      setMediaSession();
      toast('Playlist ripresa');
    } else if (semis !== 0) {
      toast('Tonalità memorizzata per questo video: ' + fmt(semis));
    }
    db.pending = null;
    save(); // fa anche da prova: se il browser rifiuta, il pannello lo spiega
    dirty = true; refresh();
  });
})();
