// Simula su una finta pagina m.youtube.com i tre casi di salvataggio:
//  1. localStorage funzionante
//  2. localStorage pieno (QuotaExceededError) -> deve salvare in IndexedDB e recuperare da lì
//  3. salvataggio bloccato (SecurityError + IndexedDB bloccato) -> avviso nel pannello
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');

const CODE = fs.readFileSync(path.join(__dirname, '../dist/yt-transpose.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function page({ idb, lsMode, lsData }) {
  const dom = new JSDOM('<!doctype html><body><div id="movie_player"><video></video></div></body>', {
    url: 'https://m.youtube.com/watch?v=aqz-KE-bpKQ', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  if (lsData) for (const [k, v] of Object.entries(lsData)) w.localStorage.setItem(k, v);
  if (lsMode) {
    const proto = Object.getPrototypeOf(w.localStorage);
    const orig = proto.setItem;
    proto.setItem = function (k, v) {
      if (lsMode === 'quota') throw new w.DOMException('pieno', 'QuotaExceededError');
      if (lsMode === 'blocked') throw new w.DOMException('vietato', 'SecurityError');
      return orig.call(this, k, v);
    };
  }
  w.indexedDB = idb || undefined;
  w.document.getElementById('movie_player').getVideoData = () => ({ video_id: 'aqz-KE-bpKQ', title: 'Big Buck Bunny', author: 'Blender' });
  w.alert = () => {};
  w.eval(CODE);
  return w;
}
const dbg = (w) => { const d = w.__ytTranspose._debug(); return { store: d.store, semis: d.semis, songs: Object.keys(d.db.songs).length }; };
const panelText = (w) => {
  const r = w.document.getElementById('yt-transpose-host').shadowRoot;
  r.querySelectorAll('.bar button')[3].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  return r.textContent;
};

(async () => {
  const results = [];
  const check = (name, ok, info) => { results.push({ caso: name, esito: ok ? 'OK' : 'FALLITO', ...info }); };

  // 1. tutto funzionante
  {
    const idb = new IDBFactory();
    const w = page({ idb });
    await sleep(300);
    w.__ytTranspose._act.change(3); await sleep(300);
    const d = dbg(w);
    const saved = JSON.parse(w.localStorage.getItem('ytTranspose.v1'));
    check('normale: salva in localStorage', d.store === 'local' && saved.songs['aqz-KE-bpKQ'].s === 3, d);
    w.close();
  }

  // 2. localStorage pieno: salva in IndexedDB, poi una nuova pagina recupera +3 da lì
  {
    const idb = new IDBFactory();
    let w = page({ idb, lsMode: 'quota' });
    await sleep(300);
    w.__ytTranspose._act.change(3); await sleep(400);
    let d = dbg(w);
    const txt = panelText(w);
    check('memoria piena: passa a IndexedDB', d.store === 'idb:quota' && /database del browser/.test(txt), d);
    w.close();
    w = page({ idb, lsMode: 'quota' });
    await sleep(500);
    d = dbg(w);
    check('memoria piena: alla riapertura ritrova +3', d.semis === 3 && d.songs === 1, d);
    w.close();
  }

  // 2b. copia vecchia in localStorage, più recente in IndexedDB: vince la più recente
  {
    const idb = new IDBFactory();
    const old = JSON.stringify({ v: 1, ts: 1, songs: { 'aqz-KE-bpKQ': { t: 'x', a: '', s: -2, u: 1 } }, playlists: [{ id: 'p1', name: 'P', items: [] }], cur: 'p1' });
    let w = page({ idb, lsMode: 'quota', lsData: { 'ytTranspose.v1': old } });
    await sleep(300);
    w.__ytTranspose._act.change(7); await sleep(400); // -2 -> +5, salvato solo in IndexedDB
    w.close();
    w = page({ idb, lsMode: 'quota', lsData: { 'ytTranspose.v1': old } });
    await sleep(500);
    const d = dbg(w);
    check('copia più recente vince su quella vecchia', d.semis === 5, d);
    w.close();
  }

  // 3. tutto bloccato: avviso con la soluzione
  {
    const w = page({ idb: undefined, lsMode: 'blocked' });
    await sleep(300);
    w.__ytTranspose._act.change(2); await sleep(400);
    const d = dbg(w);
    const txt = panelText(w);
    check('bloccato: avviso nel pannello', d.store === 'none:blocked' && /non si salvano/.test(txt) && /leone di Brave/.test(txt), d);
    w.close();
  }

  console.table(results);
  const bad = results.filter((r) => r.esito !== 'OK');
  console.log(bad.length ? `FALLITI: ${bad.length}` : 'Tutti i casi superati');
  process.exit(bad.length ? 1 : 0);
})();
