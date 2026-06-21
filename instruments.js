/* Shared instrument voices for the synth playback and click-to-play.
   Pure Web Audio synthesis (no samples). window.Instruments.playNote(ctx, dest, p, id). */
(() => {
  "use strict";

  const list = [
    { id: "eguitar", name: "Электрогитара (дист)" },
    { id: "guitar", name: "Чистая гитара" },
    { id: "piano", name: "Пианино" },
    { id: "synth", name: "Синтезатор" },
  ];

  let distCurve = null;
  function getDist(ctx) {
    if (distCurve) return distCurve;
    const n = 32768, c = new Float32Array(n), deg = Math.PI / 180, amt = 340;
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((3 + amt) * x * 20 * deg) / (Math.PI + amt * Math.abs(x)); }
    distCurve = c;
    return c;
  }

  // Karplus-Strong plucked string -> AudioBuffer (cached by freq/dur/decay)
  const ksCache = new Map();
  function ksBuffer(ctx, freq, dur, decay) {
    const sr = ctx.sampleRate;
    const key = Math.round(freq) + ":" + Math.round(dur * 10) + ":" + Math.round(decay * 1000);
    if (ksCache.has(key)) return ksCache.get(key);
    const N = Math.max(2, Math.round(sr / freq));
    const len = Math.max(1, Math.floor(sr * dur));
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const ring = new Float32Array(N);
    for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const idx = i % N;
      const cur = (ring[idx] + prev) * 0.5 * decay;
      ring[idx] = cur; prev = cur; d[i] = cur;
    }
    if (ksCache.size > 240) ksCache.clear();
    ksCache.set(key, buf);
    return buf;
  }

  function playSynth(ctx, dest, p, when, dur, vol) {
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), t = ctx.createBiquadFilter(), g = ctx.createGain();
    o1.type = "sawtooth"; o2.type = "sawtooth"; o1.frequency.value = p.freq; o2.frequency.value = p.freq; o2.detune.value = 6;
    t.type = "lowpass"; t.frequency.value = p.palmMute ? 1400 : 3200;
    const peak = (p.accent ? 0.27 : 0.22) * vol;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur + (p.palmMute ? 0.07 : 0.18));
    o1.connect(t); o2.connect(t); t.connect(g); g.connect(dest);
    const end = when + dur + 0.3; o1.start(when); o2.start(when); o1.stop(end); o2.stop(end);
    return [o1, o2];
  }

  function playEGuitar(ctx, dest, p, when, dur, vol) {
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), o3 = ctx.createOscillator();
    const pre = ctx.createGain(); pre.gain.value = 1.7;
    const drive = ctx.createWaveShaper(); drive.curve = getDist(ctx); drive.oversample = "2x";
    const cab = ctx.createBiquadFilter(); cab.type = "lowpass"; cab.frequency.value = p.palmMute ? 1600 : 3400; cab.Q.value = 0.7;
    const g = ctx.createGain();
    o1.type = "sawtooth"; o2.type = "sawtooth"; o3.type = "triangle";
    o1.frequency.value = p.freq; o2.frequency.value = p.freq; o3.frequency.value = p.freq * 0.5;
    o1.detune.value = 4; o2.detune.value = -7;
    const peak = (p.accent ? 0.3 : 0.22) * vol;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.005);
    g.gain.exponentialRampToValueAtTime(p.palmMute ? 0.05 * vol : 0.1 * vol, when + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur + (p.palmMute ? 0.08 : 0.22));
    o1.connect(pre); o2.connect(pre); o3.connect(pre); pre.connect(drive); drive.connect(cab); cab.connect(g); g.connect(dest);
    const end = when + dur + 0.35; [o1, o2, o3].forEach((o) => { o.start(when); o.stop(end); });
    return [o1, o2, o3];
  }

  function playPiano(ctx, dest, p, when, dur, vol) {
    const partials = [[1, 1], [2, 0.55], [3, 0.33], [4, 0.2], [5, 0.12], [6, 0.07]];
    const ring = Math.min(2.6, dur * 2.2 + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.26 * vol, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + ring);
    g.connect(dest);
    const oscs = [];
    for (const [h, amp] of partials) {
      const o = ctx.createOscillator(), pg = ctx.createGain();
      o.type = "sine"; o.frequency.value = p.freq * h * (1 + 0.0007 * h * h);
      pg.gain.value = amp; o.connect(pg); pg.connect(g);
      o.start(when); o.stop(when + ring + 0.1); oscs.push(o);
    }
    return oscs;
  }

  function playGuitar(ctx, dest, p, when, dur, vol) {
    const ring = Math.min(3, Math.max(dur + 0.4, 0.7));
    const decay = p.palmMute ? 0.9 : 0.996;
    const src = ctx.createBufferSource();
    src.buffer = ksBuffer(ctx, p.freq, ring, decay);
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = p.palmMute ? 2200 : 5200;
    const g = ctx.createGain(); g.gain.value = (p.accent ? 0.95 : 0.72) * vol;
    src.connect(lp); lp.connect(g); g.connect(dest);
    src.start(when);
    return [src];
  }

  function playNote(ctx, dest, p, id) {
    const when = (p.when != null ? p.when : ctx.currentTime);
    const dur = Math.max(0.08, p.dur || 0.3);
    const vol = (p.gain != null ? p.gain : 1);
    const np = { freq: p.freq, accent: !!p.accent, palmMute: !!p.palmMute };
    if (id === "guitar") return playGuitar(ctx, dest, np, when, dur, vol);
    if (id === "piano") return playPiano(ctx, dest, np, when, dur, vol);
    if (id === "eguitar") return playEGuitar(ctx, dest, np, when, dur, vol);
    return playSynth(ctx, dest, np, when, dur, vol);
  }

  window.Instruments = { list, playNote };
})();
