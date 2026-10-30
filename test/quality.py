"""Analizza i file .f32 prodotti da quality-test.js.

Per ogni caso misura:
- f0: frequenza fondamentale stimata (picco interpolato)
- errore in cent rispetto all'attesa
- purezza: quota di energia entro ±4 Hz dalla fondamentale attesa, rispetto
  all'energia entro ±60 Hz (1.0 = tono pulito, valori bassi = tremolio/ronzio)
"""
import sys, glob, os
import numpy as np

SR = 48000
d = sys.argv[1]
rows = []
for f in sorted(glob.glob(os.path.join(d, '*.f32'))):
    name = os.path.basename(f)[:-4]
    eng, kind, st = name.split('_')
    st = int(st)
    y = np.fromfile(f, dtype=np.float32)[SR // 2:]
    y = y[: 2 * SR]
    w = np.hanning(len(y))
    Y = np.abs(np.fft.rfft(y * w, n=len(y) * 4)) ** 2
    fr = np.fft.rfftfreq(len(y) * 4, 1 / SR)
    base = 440 if kind == 'sine' else 220
    exp = base * 2 ** (st / 12)
    band = (fr > exp - 60) & (fr < exp + 60)
    core = (fr > exp - 4) & (fr < exp + 4)
    i = np.argmax(np.where(band, Y, 0))
    f0 = fr[i]
    purity = Y[core].sum() / Y[band].sum()
    cents = 1200 * np.log2(f0 / exp)
    rows.append((eng, kind, st, exp, f0, cents, purity))

print(f"{'motore':7} {'segnale':6} {'st':>4} {'atteso':>8} {'misurato':>9} {'cent':>6} {'purezza':>8}")
for r in sorted(rows, key=lambda r: (r[1], r[2], r[0])):
    print(f"{r[0]:7} {r[1]:6} {r[2]:>4} {r[3]:>8.2f} {r[4]:>9.2f} {r[5]:>6.1f} {r[6]:>8.3f}")
for eng in ('core',):
    p = [r[6] for r in rows if r[0] == eng]
    c = [abs(r[5]) for r in rows if r[0] == eng]
    print(f"{eng}: purezza media {np.mean(p):.3f}, errore max {max(c):.1f} cent")
