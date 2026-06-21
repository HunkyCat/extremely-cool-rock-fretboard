/* Song breakdown tab: drop a .psarc, parse it in-browser, play it on a synth,
   and visualise it on the fretboard with live scale analysis.
   Nothing is uploaded or stored — the file lives only in this page's memory. */
(() => {
  "use strict";

  const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const STRING_COLORS = ["#dc2626", "#facc15", "#2563eb", "#f97316", "#16a34a", "#7c3aed"];
  const INLAY_FRETS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21]);
  const LOOKAHEAD = 1.4;
  const MIN_FLASH = 0.14;
  const SCHED_AHEAD = 0.3;

  const DETECT_SCALES = [
    { name: "натуральный минор", ivals: [0, 2, 3, 5, 7, 8, 10] },
    { name: "мажор", ivals: [0, 2, 4, 5, 7, 9, 11] },
    { name: "гармонический минор", ivals: [0, 2, 3, 5, 7, 8, 11] },
    { name: "дорийский", ivals: [0, 2, 3, 5, 7, 9, 10] },
    { name: "фригийский", ivals: [0, 1, 3, 5, 7, 8, 10] },
    { name: "фригийский доминантный", ivals: [0, 1, 4, 5, 7, 8, 10] },
    { name: "минорная пентатоника", ivals: [0, 3, 5, 7, 10] },
  ];
  const DEGREE_LABELS = ["1", "b2", "2", "b3", "3", "4", "b5", "5", "b6", "6", "b7", "7"];

  // ---- DOM ----
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));
  const songTab = document.getElementById("tab-song");
  const dropZone = document.getElementById("dropZone");
  const fileBtn = document.getElementById("fileBtn");
  const fileInput = document.getElementById("fileInput");
  const dropStatus = document.getElementById("dropStatus");
  const reloadBtn = document.getElementById("reloadBtn");
  const titleEl = document.getElementById("songTitle");
  const metaEl = document.getElementById("songMeta");
  const arrSelect = document.getElementById("arrSelect");
  const tuningEl = document.getElementById("songTuning");
  const playBtn = document.getElementById("playBtn");
  const timeNowEl = document.getElementById("timeNow");
  const timeTotalEl = document.getElementById("timeTotal");
  const timeline = document.getElementById("timeline");
  const densityCanvas = document.getElementById("densityCanvas");
  const sectionsEl = document.getElementById("sections");
  const playheadEl = document.getElementById("playhead");
  const canvas = document.getElementById("songCanvas");
  const infoSection = document.getElementById("infoSection");
  const infoScale = document.getElementById("infoScale");
  const infoNotes = document.getElementById("infoNotes");
  const infoBeat = document.getElementById("infoBeat");
  const statusEl = document.getElementById("songStatus");

  let song = null;
  let arr = null;
  let frets = 22;
  let songTabActive = false;
  let rafId = null;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmtTime(s) {
    if (!Number.isFinite(s)) s = 0;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  // ============ Transport (Web Audio clock + synth) ============
  let audioCtx = null;
  let playing = false;
  let pausedPos = 0;
  let startCtxTime = 0;
  let startPos = 0;
  let schedIdx = 0;
  let amp = null;
  let voices = []; // { node, end }
  let distCurve = null;

  function ensureCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function songTime() {
    return playing ? startPos + (audioCtx.currentTime - startCtxTime) : pausedPos;
  }
  function songLength() { return song ? song.length : 0; }

  function buildDistortion(amount) {
    const n = 44100;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; i += 1) {
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  function buildAmp(ctx) {
    if (!distCurve) distCurve = buildDistortion(360);
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 60;
    const drive = ctx.createWaveShaper(); drive.curve = distCurve; drive.oversample = "4x";
    const pre = ctx.createGain(); pre.gain.value = 1.5;
    const cab = ctx.createBiquadFilter(); cab.type = "lowpass"; cab.frequency.value = 3400; cab.Q.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    const master = ctx.createGain(); master.gain.value = 0.16;
    hp.connect(pre); pre.connect(drive); drive.connect(cab); cab.connect(comp); comp.connect(master);
    master.connect(ctx.destination);
    return { input: hp, master, nodes: [hp, pre, drive, cab, comp, master] };
  }

  function midiToFreq(m) { return 440 * 2 ** ((m - 69) / 12); }

  function scheduleNote(n, when) {
    if (n.s < 0 || n.s > 5) return;
    const ctx = audioCtx;
    const midi = arr.openMidi[n.s] + n.f;
    const freq = midiToFreq(midi);
    const dur = Math.max(0.12, Math.min(n.sus || 0, 1.6) || 0.18);
    const pm = !!n.pm;

    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const tone = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = "sawtooth"; osc2.type = "sawtooth";
    osc.frequency.value = freq; osc2.frequency.value = freq;
    osc2.detune.value = 6;
    tone.type = "lowpass";
    tone.frequency.value = pm ? 1400 : 3200;
    const peak = pm ? 0.16 : 0.24;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.006);
    g.gain.exponentialRampToValueAtTime(pm ? 0.06 : 0.12, when + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur + (pm ? 0.06 : 0.18));
    osc.connect(tone); osc2.connect(tone); tone.connect(g); g.connect(amp.input);
    const end = when + dur + 0.2;
    osc.start(when); osc2.start(when); osc.stop(end); osc2.stop(end);
    voices.push({ node: osc, end }, { node: osc2, end });
  }

  function stopVoices() {
    for (const v of voices) {
      try { v.node.stop(); } catch (_) {}
      try { v.node.disconnect(); } catch (_) {}
    }
    voices = [];
    if (amp) { amp.nodes.forEach((nd) => { try { nd.disconnect(); } catch (_) {} }); amp = null; }
  }

  function firstNoteIdx(t) {
    const a = arr.notes;
    let lo = 0, hi = a.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  async function play() {
    if (!arr || playing) return;
    const ctx = ensureCtx();
    await ctx.resume();
    if (pausedPos >= songLength() - 0.05) pausedPos = 0;
    amp = buildAmp(ctx);
    startPos = pausedPos;
    startCtxTime = ctx.currentTime;
    schedIdx = firstNoteIdx(startPos);
    playing = true;
    playBtn.textContent = "❚❚";
    startLoop();
  }
  function pause() {
    if (!playing) return;
    pausedPos = clamp(songTime(), 0, songLength());
    playing = false;
    stopVoices();
    playBtn.textContent = "▶";
  }
  function seek(t) {
    t = clamp(t, 0, songLength());
    if (playing) {
      stopVoices();
      amp = buildAmp(audioCtx);
      startPos = t;
      startCtxTime = audioCtx.currentTime;
      schedIdx = firstNoteIdx(t);
    } else {
      pausedPos = t;
    }
    renderFrame();
  }

  function scheduleAhead() {
    if (!playing) return;
    const horizon = songTime() + SCHED_AHEAD;
    const a = arr.notes;
    while (schedIdx < a.length && a[schedIdx].t <= horizon) {
      const n = a[schedIdx];
      const when = startCtxTime + (n.t - startPos);
      if (when >= audioCtx.currentTime - 0.02) scheduleNote(n, Math.max(when, audioCtx.currentTime));
      schedIdx += 1;
    }
    // prune finished voices
    if (voices.length > 64) {
      const now = audioCtx.currentTime;
      voices = voices.filter((v) => v.end > now);
    }
  }

  playBtn.addEventListener("click", () => { if (playing) pause(); else play(); });

  // ============ Loading ============
  function bindDrop() {
    ["dragenter", "dragover"].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((ev) =>
      dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); }));
    dropZone.addEventListener("drop", (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(f);
    });
    fileBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
    reloadBtn.addEventListener("click", () => {
      pause();
      songTab.classList.remove("song-loaded");
      dropStatus.textContent = "";
    });
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/\.psarc$/i.test(file.name)) { dropStatus.textContent = "Нужен файл .psarc"; return; }
    dropStatus.textContent = `Разбираю «${file.name}»…`;
    try {
      const buf = await file.arrayBuffer();
      song = await window.RSParse.parsePsarc(buf);
      pause();
      pausedPos = 0;
      buildSong();
      songTab.classList.add("song-loaded");
      resizeCanvas();
      renderFrame();
      dropStatus.textContent = "";
    } catch (err) {
      dropStatus.textContent = "Не удалось разобрать: " + err.message;
    }
  }

  function buildSong() {
    titleEl.textContent = song.title || "—";
    metaEl.textContent = [song.artist, song.album, song.year].filter(Boolean).join(" · ");
    arrSelect.innerHTML = "";
    const labels = { lead: "Lead", rhythm: "Rhythm", lead2: "Lead 2", bass: "Bass", combo: "Combo" };
    for (const key of Object.keys(song.arrangements)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = labels[key] || key;
      arrSelect.appendChild(opt);
    }
    arrSelect.value = song.arrangements.lead ? "lead" : Object.keys(song.arrangements)[0];
    selectArrangement(arrSelect.value);
    timeTotalEl.textContent = fmtTime(song.length);
  }

  arrSelect.addEventListener("change", () => { const wasPlaying = playing; const t = songTime(); selectArrangement(arrSelect.value); seek(t); if (wasPlaying) { /* keep position */ } });

  function selectArrangement(key) {
    arr = song.arrangements[key];
    tuningEl.textContent = `Строй: ${arr.tuningName}${arr.capo ? " · капо " + arr.capo : ""}`;
    let maxFret = 12;
    for (const n of arr.notes) if (n.f > maxFret) maxFret = n.f;
    frets = clamp(maxFret + 1, 12, 24);
    precomputeSectionScales();
    drawDensity();
    drawSections();
    resizeCanvas();
    renderFrame();
  }

  // ============ Scale detection ============
  function bestScale(hist) {
    let total = 0; for (const w of hist) total += w;
    if (total === 0) return null;
    let best = null;
    for (let root = 0; root < 12; root += 1) {
      for (const sc of DETECT_SCALES) {
        const inSet = new Set(sc.ivals.map((iv) => (root + iv) % 12));
        let inside = 0;
        for (let pc = 0; pc < 12; pc += 1) if (inSet.has(pc)) inside += hist[pc];
        const score = inside / total - sc.ivals.length * 0.012;
        if (!best || score > best.score) best = { root, name: sc.name, score, coverage: inside / total };
      }
    }
    return best;
  }
  function histFor(t0, t1) {
    const h = new Array(12).fill(0);
    for (const n of arr.notes) if (n.t >= t0 && n.t < t1) h[n.pc] += 1 + Math.min(n.sus, 1);
    return h;
  }
  function precomputeSectionScales() {
    arr._scales = arr.sections.map((sec) => bestScale(histFor(sec.t, sec.end != null ? sec.end : song.length)));
  }
  function currentSectionIndex(t) {
    for (let i = arr.sections.length - 1; i >= 0; i -= 1) if (t >= arr.sections[i].t) return i;
    return -1;
  }

  // ============ Timeline ============
  function drawDensity() {
    const w = densityCanvas.clientWidth || timeline.clientWidth || 600;
    const h = densityCanvas.clientHeight || 54;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    densityCanvas.width = Math.floor(w * dpr);
    densityCanvas.height = Math.floor(h * dpr);
    const ctx = densityCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cols = Math.max(60, Math.floor(w / 3));
    const buckets = new Array(cols).fill(0);
    for (const n of arr.notes) buckets[clamp(Math.floor((n.t / song.length) * cols), 0, cols - 1)] += 1;
    const peak = Math.max(1, ...buckets);
    const bw = w / cols;
    for (let c = 0; c < cols; c += 1) {
      const bh = (buckets[c] / peak) * (h - 6);
      ctx.fillStyle = "rgba(255, 138, 61, 0.35)";
      ctx.fillRect(c * bw, h - bh, Math.max(1, bw - 0.5), bh);
    }
  }
  function drawSections() {
    sectionsEl.innerHTML = "";
    for (const sec of arr.sections) {
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.style.left = `${(sec.t / song.length) * 100}%`;
      const label = document.createElement("span");
      label.textContent = sec.name;
      seg.appendChild(label);
      sectionsEl.appendChild(seg);
    }
  }
  function seekFromClientX(clientX) {
    const rect = timeline.getBoundingClientRect();
    seek(clamp((clientX - rect.left) / rect.width, 0, 1) * song.length);
  }
  let dragging = false;
  timeline.addEventListener("pointerdown", (e) => { dragging = true; timeline.setPointerCapture(e.pointerId); seekFromClientX(e.clientX); startLoop(); });
  timeline.addEventListener("pointermove", (e) => { if (dragging) seekFromClientX(e.clientX); });
  timeline.addEventListener("pointerup", (e) => { dragging = false; try { timeline.releasePointerCapture(e.pointerId); } catch (_) {} });

  // ============ Board rendering ============
  let cssW = 0, cssH = 0;
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, Math.floor(rect.width));
    cssH = Math.max(1, Math.floor(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function layout() {
    const left = 54, right = cssW - 150, top = 46, bottom = cssH - 34;
    const fw = (right - left) / Math.max(1, frets);
    const sTop = top + 10, sBottom = bottom - 10, gap = (sBottom - sTop) / 5;
    return { left, right, top, bottom, fw, sTop, sBottom, gap };
  }
  const xFretLine = (L, f) => L.left + f * L.fw;
  const xNote = (L, f) => (f === 0 ? L.left - L.fw * 0.3 : L.left + (f - 0.5) * L.fw);
  const yString = (L, s) => L.sTop + L.gap * s;

  function notesActiveAt(t) {
    const active = [], upcoming = [];
    for (const n of arr.notes) {
      if (n.t > t + LOOKAHEAD) break;
      const dur = Math.max(n.sus, MIN_FLASH);
      if (t >= n.t && t <= n.t + dur) active.push(n);
      else if (n.t > t && n.t <= t + LOOKAHEAD) upcoming.push(n);
    }
    return { active, upcoming };
  }

  function renderFrame() {
    if (!arr || !cssW) return;
    const t = songTime();
    const ctx = canvas.getContext("2d");
    const L = layout();
    ctx.clearRect(0, 0, cssW, cssH);
    const bg = ctx.createLinearGradient(0, 0, 0, cssH);
    bg.addColorStop(0, "#0b1220"); bg.addColorStop(1, "#111827");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cssW, cssH);

    const secIdx = currentSectionIndex(t);
    const scale = secIdx >= 0 ? arr._scales[secIdx] : null;
    const scaleSet = scale ? new Set(DETECT_SCALES.find((s) => s.name === scale.name).ivals.map((iv) => (scale.root + iv) % 12)) : null;

    for (let f = 0; f <= frets; f += 1) {
      const x = xFretLine(L, f);
      ctx.strokeStyle = f === 0 ? "#e2e8f0" : "rgba(148,163,184,0.45)";
      ctx.lineWidth = f === 0 ? 4 : 1.2;
      ctx.beginPath(); ctx.moveTo(x, L.sTop - L.gap * 0.5); ctx.lineTo(x, L.sBottom + L.gap * 0.5); ctx.stroke();
      if (INLAY_FRETS.has(f)) {
        ctx.fillStyle = "rgba(56,189,248,0.18)";
        ctx.beginPath(); ctx.arc(xNote(L, f), (L.sTop + L.sBottom) / 2, 6, 0, Math.PI * 2); ctx.fill();
      }
    }

    for (let s = 0; s < 6; s += 1) {
      const y = yString(L, s);
      ctx.strokeStyle = STRING_COLORS[s]; ctx.globalAlpha = 0.9; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(xFretLine(L, 0), y); ctx.lineTo(xFretLine(L, frets), y); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = STRING_COLORS[s]; ctx.font = "700 12px Rajdhani, Segoe UI, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(`${6 - s} (${NOTE_NAMES_SHARP[arr.openMidi[s] % 12]})`, L.right + 10, y);
    }

    if (scaleSet) {
      for (let s = 0; s < 6; s += 1) {
        const y = yString(L, s);
        for (let f = 0; f <= frets; f += 1) {
          const pc = (arr.openMidi[s] + f) % 12;
          if (!scaleSet.has(pc)) continue;
          const isRoot = pc === scale.root;
          ctx.fillStyle = isRoot ? "rgba(245,158,11,0.28)" : "rgba(147,197,253,0.14)";
          ctx.beginPath(); ctx.arc(xNote(L, f), y, isRoot ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    const { active, upcoming } = notesActiveAt(t);
    const r = clamp(Math.min(L.fw, L.gap) * 0.34, 9, 15);

    for (const n of upcoming) {
      if (n.s < 0 || n.s > 5) continue;
      const prox = 1 - (n.t - t) / LOOKAHEAD;
      const x = xNote(L, n.f), y = yString(L, n.s);
      ctx.globalAlpha = 0.18 + prox * 0.5;
      ctx.fillStyle = "#1f2937"; ctx.strokeStyle = "#93c5fd"; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(x, y, r * (0.55 + prox * 0.45), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const n of active) {
      if (n.s < 0 || n.s > 5) continue;
      const x = xNote(L, n.f), y = yString(L, n.s);
      const glow = ctx.createRadialGradient(x, y, 2, x, y, r + 16);
      glow.addColorStop(0, "rgba(251,146,60,0.7)"); glow.addColorStop(1, "rgba(251,146,60,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r + 16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = n.pm ? "#b45309" : "#f59e0b"; ctx.strokeStyle = "#fde68a"; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#111827"; ctx.font = `700 ${r}px Rajdhani, Segoe UI, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(n.f), x, y);
    }

    ctx.fillStyle = "#94a3b8"; ctx.font = "600 11px Rajdhani, Segoe UI, sans-serif"; ctx.textAlign = "center";
    for (let f = 1; f <= frets; f += 1) ctx.fillText(String(f), xNote(L, f), L.bottom + 16);

    updateInfo(t, secIdx, scale, active);
    playheadEl.style.left = `${clamp(t / song.length, 0, 1) * 100}%`;
    timeNowEl.textContent = fmtTime(t);
  }

  function updateInfo(t, secIdx, scale, active) {
    infoSection.textContent = secIdx >= 0 ? arr.sections[secIdx].name : "—";
    infoScale.textContent = scale ? `${NOTE_NAMES_SHARP[scale.root]} ${scale.name} (${Math.round(scale.coverage * 100)}%)` : "—";
    if (active.length) {
      const chord = active.find((n) => n.chord);
      if (chord && chord.chord) infoNotes.textContent = chord.chord;
      else {
        const names = [...new Set(active.map((n) => NOTE_NAMES_SHARP[n.pc]))];
        const degs = scale ? [...new Set(active.map((n) => DEGREE_LABELS[((n.pc - scale.root) % 12 + 12) % 12]))] : [];
        infoNotes.textContent = names.join(" ") + (degs.length ? `  ·  ступени ${degs.join(" ")}` : "");
      }
    } else infoNotes.textContent = "—";
    let measure = null;
    for (const b of arr.beats) { if (b.t > t) break; if (b.measure != null) measure = b.measure; }
    infoBeat.textContent = `${measure != null ? "такт " + measure : "—"} · ${Math.round(arr.tempo)} BPM`;
  }

  // ============ Loop ============
  function loop() {
    if (!songTabActive) { rafId = null; return; }
    if (playing) {
      scheduleAhead();
      if (songTime() >= songLength()) { pause(); pausedPos = songLength(); renderFrame(); return; }
    }
    renderFrame();
    if (playing || dragging) rafId = requestAnimationFrame(loop);
    else rafId = null;
  }
  function startLoop() { if (rafId == null) rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } }

  // ============ Tabs ============
  function activateTab(name) {
    tabs.forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
    panels.forEach((p) => { const on = p.id === "tab-" + name; p.classList.toggle("is-active", on); p.hidden = !on; });
    songTabActive = name === "song";
    if (songTabActive) { if (arr) { resizeCanvas(); renderFrame(); if (playing) startLoop(); } }
    else { pause(); stopLoop(); }
  }
  tabs.forEach((b) => b.addEventListener("click", () => activateTab(b.dataset.tab)));

  window.addEventListener("resize", () => {
    if (!songTabActive || !arr) return;
    resizeCanvas(); drawDensity(); renderFrame();
  });

  bindDrop();
})();
