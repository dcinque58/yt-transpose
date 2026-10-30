# YT Transpose

Bookmarklet per iPhone (Brave o Safari) che traspone l'audio dei video di YouTube di ±12 semitoni mantenendo la velocità, ricorda la tonalità di ogni video e gestisce playlist con avanzamento automatico.

## Come funziona

- **Aggancio audio**: `AudioContext.createMediaElementSource()` sul `<video>` di m.youtube.com. Il video viene collegato solo quando il contesto audio è attivo, altrimenti su iOS resterebbe muto.
- **Motore di pitch shift** (`src/pitchcore.js`): buffer circolare riletto a velocità `2^(st/12)`; quando il puntatore deve saltare, l'ampiezza del salto è scelta per massima correlazione con la forma d'onda corrente, poi sfumata in 12 ms. Errore misurato < 1 cent, nessun tremolio sui toni stazionari (`test/`).
- **Esecuzione**: la CSP di YouTube blocca gli AudioWorklet da `blob:`/`data:`, quindi sul sito il motore gira in un `ScriptProcessorNode` (stesso algoritmo). Il tentativo con AudioWorklet resta per altri contesti.
- **Interfaccia**: Shadow DOM, nessun `innerHTML` (YouTube applica i Trusted Types), stili tramite constructable stylesheet.
- **Dati**: `localStorage` di youtube.com (chiave `ytTranspose.v1`) più una copia in IndexedDB (database `ytTranspose`), che ha uno spazio separato: YouTube riempie spesso il `localStorage` fino al limite. All'avvio vince la copia più recente; se il browser blocca entrambi, il pannello spiega come sbloccarlo. Backup/ripristino come testo JSON dal pannello.
- **Playlist**: cambio brano con `movie_player.loadVideoById()` senza ricaricare la pagina; dopo il cambio il video viene smutato (YouTube lo riavvia muto senza un tocco). Se l'API non c'è, ricarica la pagina e riprende la posizione al tocco successivo del preferito.

## Struttura

```
src/pitchcore.js            motore DSP (usato anche dai test)
src/main.js                 pannello, memoria, playlist, aggancio audio
src/install.template.html   pagina di installazione
build.js                    genera dist/
dist/bookmarklet.txt        la riga javascript:… da incollare nel preferito
dist/install.html           pagina di installazione (frammento)
docs/index.html             pagina di installazione completa, per GitHub Pages
dist/yt-transpose.js        sorgente unito, leggibile
test/quality-test.js        misura pitch e purezza (+ test/quality.py)
test/storage-test.js        salvataggio nei casi normale, memoria piena, bloccato
```

## Installazione

Apri la pagina di installazione dall'iPhone (cartella `docs/`, pubblicabile con GitHub Pages: Settings → Pages → branch `main`, cartella `/docs`), tocca **Copia il codice** e segui i passi per creare il preferito in Brave o Safari.

## Build e test

```
npm install
npm run build
node test/quality-test.js /tmp/q && python3 test/quality.py /tmp/q
npm run test:storage   # salvataggio: normale, memoria piena, bloccato
```

## Limiti noti

- Il preferito va ritoccato dopo ogni caricamento completo della pagina di YouTube.
- In background l'elaborazione gira sul thread della pagina: la tenuta a schermo bloccato dipende da Brave/iOS.
- Latenza audio rispetto al video: circa 0,1 s.

## Licenza

MIT, vedi `LICENSE`.
