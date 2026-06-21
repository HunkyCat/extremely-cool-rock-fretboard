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
  const songProps = document.getElementById("songProps");
  const playBtn = document.getElementById("playBtn");
  const timeNowEl = document.getElementById("timeNow");
  const timeTotalEl = document.getElementById("timeTotal");
  const timeline = document.getElementById("timeline");
  const densityCanvas = document.getElementById("densityCanvas");
  const sectionsEl = document.getElementById("sections");
  const playheadEl = document.getElementById("playhead");
  const loopRegionEl = document.getElementById("loopRegion");
  const loopMidEl = document.getElementById("loopMid");
  const loopHandleAEl = document.getElementById("loopHandleA");
  const loopHandleBEl = document.getElementById("loopHandleB");
  const canvas = document.getElementById("songCanvas");
  const highway = document.getElementById("highwayCanvas");
  const sourceSel = document.getElementById("sourceSel");
  const tempoSel = document.getElementById("tempoSel");
  const pitchKeep = document.getElementById("pitchKeep");
  const loopAbtn = document.getElementById("loopAbtn");
  const loopBbtn = document.getElementById("loopBbtn");
  const loopSecBtn = document.getElementById("loopSecBtn");
  const loopToggle = document.getElementById("loopToggle");
  const loopClear = document.getElementById("loopClear");
  const invHwBtn = document.getElementById("invHwBtn");
  const invBoardBtn = document.getElementById("invBoardBtn");
  const invHwState = document.getElementById("invHwState");
  const invBoardState = document.getElementById("invBoardState");
  const scaleRibbon = document.getElementById("scaleRibbon");
  const lyricsEl = document.getElementById("lyrics");
  const lyricLine = document.getElementById("lyricLine");
  const lyricBall = document.getElementById("lyricBall");
  const volumeSlider = document.getElementById("volume");
  const scaleNowName = document.getElementById("scaleNowName");
  const scaleStrip = document.getElementById("scaleStrip");
  const infoSection = document.getElementById("infoSection");
  const infoNotes = document.getElementById("infoNotes");
  const infoBeat = document.getElementById("infoBeat");
  const infoSource = document.getElementById("infoSource");
  const statusEl = document.getElementById("songStatus");

  let song = null;
  let arr = null;
  let frets = 22;
  let minFret = 0;
  let songTabActive = false;
  let rafId = null;
  let invertHW = false;    // tab/highway orientation
  let invertBoard = false; // fretboard orientation

  function orientText(inv) { return inv ? "1→6 (тонкая сверху)" : "6→1 (толстая сверху)"; }
  function updateOrientUI() {
    invHwState.textContent = orientText(invertHW);
    invBoardState.textContent = orientText(invertBoard);
    invHwBtn.classList.toggle("is-on", invertHW);
    invBoardBtn.classList.toggle("is-on", invertBoard);
  }

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
  let rate = 1;          // playback speed (1 = 100%)
  let loopA = null;
  let loopB = null;
  let loopOn = false;

  // Real-track ("original") source: decode .wem -> Ogg -> AudioBuffer, played through
  // SoundTouch (Web Audio) for pitch-preserved slowdown. Works cross-browser (incl. Firefox).
  let source = "synth";  // "synth" | "original"
  let audioBuffer = null;
  let stNode = null, stGain = null, stFilter = null, stPipe = null, stSource = null;
  let originalReady = false;
  let originalPromise = null;
  let codebooksPromise = null;
  let preservePitch = true;
  let volume = 0.8;

  function ensureCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function songTime() {
    return playing ? startPos + (audioCtx.currentTime - startCtxTime) * rate : pausedPos;
  }
  function songLength() { return song ? song.length : 0; }

  function fetchCodebooks() {
    if (!codebooksPromise) {
      codebooksPromise = fetch("./packed_codebooks_aoTuV_603.bin")
        .then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));
    }
    return codebooksPromise;
  }

  function resetOriginal() {
    originalReady = false;
    originalPromise = null;
    stopOriginal();
    audioBuffer = null;
    source = "synth";
    sourceSel.value = "synth";
    infoSource.textContent = "Синтезатор";
  }

  function ensureOriginal(silent) {
    if (originalReady) return Promise.resolve(true);
    if (originalPromise) return originalPromise;
    if (!song || !song.audioWem) { if (!silent) statusEl.textContent = "В этом psarc нет аудиодорожки"; return Promise.resolve(false); }
    if (!window.WemToOgg) { if (!silent) statusEl.textContent = "Конвертер аудио не загружен"; return Promise.resolve(false); }
    if (!window.SoundTouchLib) { if (!silent) statusEl.textContent = "Движок звука не загружен"; return Promise.resolve(false); }
    if (!silent) statusEl.textContent = "Декодирую оригинал… (несколько секунд)";
    originalPromise = (async () => {
      try {
        const cb = await fetchCodebooks();
        const ogg = window.WemToOgg.convert(song.audioWem, cb);
        const ctx = ensureCtx();
        audioBuffer = await ctx.decodeAudioData(ogg.buffer.slice(ogg.byteOffset, ogg.byteOffset + ogg.byteLength));
        originalReady = true;
        statusEl.textContent = "";
        return true;
      } catch (e) {
        if (!silent) statusEl.textContent = "Не удалось декодировать оригинал: " + e.message;
        originalPromise = null; // allow retry
        return false;
      }
    })();
    return originalPromise;
  }

  // ---- SoundTouch playback engine for the original track ----
  function applyStRate() {
    if (!stPipe) return;
    if (preservePitch) { stPipe.tempo = rate; stPipe.pitch = 1; stPipe.rate = 1; }
    else { stPipe.tempo = 1; stPipe.pitch = 1; stPipe.rate = rate; } // varispeed (pitch drops)
  }
  function startOriginal(fromPos) {
    if (!audioBuffer || !window.SoundTouchLib) return;
    const ctx = audioCtx;
    const ST = window.SoundTouchLib;
    stSource = new ST.WebAudioBufferSource(audioBuffer);
    stPipe = new ST.SoundTouch();
    applyStRate();
    stFilter = new ST.SimpleFilter(stSource, stPipe);
    stFilter.sourcePosition = Math.floor(clamp(fromPos, 0, songLength()) * audioBuffer.sampleRate);
    stNode = ST.getWebAudioNode(ctx, stFilter);
    stGain = ctx.createGain();
    stGain.gain.value = volume;
    stNode.connect(stGain);
    stGain.connect(ctx.destination);
  }
  function stopOriginal() {
    if (stNode) { try { stNode.disconnect(); } catch (_) {} stNode = null; }
    if (stGain) { try { stGain.disconnect(); } catch (_) {} stGain = null; }
    stFilter = null; stSource = null; stPipe = null;
  }

  function reanchor() {
    // call when changing rate while playing
    if (!playing) return;
    startPos = clamp(songTime(), 0, songLength());
    startCtxTime = audioCtx.currentTime;
    if (source === "original") {
      applyStRate();
    } else {
      stopVoices();
      amp = buildAmp(audioCtx);
      schedIdx = firstNoteIdx(startPos);
    }
  }

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
    const master = ctx.createGain(); master.gain.value = 0.16 * volume;
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
    if (source === "original" && !originalReady) {
      ensureOriginal();
      statusEl.textContent = originalPromise ? "Декодирую оригинал… нажми Play через секунду" : "Оригинал недоступен";
      return;
    }
    await ctx.resume();
    if (pausedPos >= songLength() - 0.05) pausedPos = 0;
    startPos = pausedPos;
    startCtxTime = ctx.currentTime;
    if (source === "original") startOriginal(startPos);
    else { amp = buildAmp(ctx); schedIdx = firstNoteIdx(startPos); }
    playing = true;
    playBtn.textContent = "❚❚";
    statusEl.textContent = "";
    startLoop();
  }
  function pause() {
    if (!playing) return;
    pausedPos = clamp(songTime(), 0, songLength());
    playing = false;
    if (source === "original") stopOriginal(); else stopVoices();
    playBtn.textContent = "▶";
  }
  function seek(t) {
    t = clamp(t, 0, songLength());
    if (playing) {
      startPos = t;
      startCtxTime = audioCtx.currentTime;
      if (source === "original") { stopOriginal(); startOriginal(t); }
      else { stopVoices(); amp = buildAmp(audioCtx); schedIdx = firstNoteIdx(t); }
    } else {
      pausedPos = t;
    }
    renderFrame();
  }

  function scheduleAhead() {
    if (!playing) return;
    const horizon = songTime() + SCHED_AHEAD * rate;
    const a = arr.notes;
    const limit = loopOn && loopB != null ? Math.min(horizon, loopB) : horizon;
    while (schedIdx < a.length && a[schedIdx].t <= limit) {
      const n = a[schedIdx];
      const when = startCtxTime + (n.t - startPos) / rate;
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

  function updateLoopUI() {
    loopToggle.classList.toggle("is-on", loopOn);
    loopToggle.setAttribute("aria-pressed", String(loopOn));
    loopAbtn.classList.toggle("is-on", loopA != null);
    loopBbtn.classList.toggle("is-on", loopB != null);
    if (loopA != null && loopB != null && loopB > loopA && song) {
      loopRegionEl.hidden = false;
      const l = pctOf(loopA);
      loopRegionEl.style.left = `${l}%`;
      loopRegionEl.style.width = `${pctOf(loopB) - l}%`;
    } else {
      loopRegionEl.hidden = true;
    }
  }
  function resetLoop() { loopA = null; loopB = null; loopOn = false; updateLoopUI(); }

  tempoSel.addEventListener("change", () => {
    rate = parseFloat(tempoSel.value) || 1;
    reanchor();
    renderFrame();
  });

  pitchKeep.addEventListener("change", () => {
    preservePitch = pitchKeep.checked;
    if (source === "original") applyStRate();
  });

  volumeSlider.addEventListener("input", () => {
    volume = clamp((parseInt(volumeSlider.value, 10) || 0) / 100, 0, 1);
    if (stGain) stGain.gain.value = volume;
    if (amp && amp.master) amp.master.gain.value = 0.16 * volume;
  });

  sourceSel.addEventListener("change", async () => {
    const want = sourceSel.value;
    const wasPlaying = playing;
    const t = songTime();
    pause();
    if (want === "original") {
      source = "original";                 // switch immediately so Play won't fall back to synth
      infoSource.textContent = "Оригинал";
      const ok = await ensureOriginal();
      if (!ok) {                           // decode failed -> fall back to synth
        source = "synth"; sourceSel.value = "synth"; infoSource.textContent = "Синтезатор";
        pausedPos = clamp(t, 0, songLength());
        if (wasPlaying) play();
        return;
      }
      if (source !== "original") return;   // user switched back while decoding
      pausedPos = clamp(t, 0, songLength());
      if (wasPlaying) play();
    } else {
      source = "synth";
      infoSource.textContent = "Синтезатор";
      pausedPos = clamp(t, 0, songLength());
      if (wasPlaying) play();
    }
    renderFrame();
  });

  loopAbtn.addEventListener("click", () => { loopA = songTime(); if (loopB != null && loopB <= loopA) loopB = null; updateLoopUI(); });
  loopBbtn.addEventListener("click", () => { loopB = songTime(); if (loopA != null && loopA >= loopB) loopA = null; updateLoopUI(); });
  loopSecBtn.addEventListener("click", () => {
    const idx = currentSectionIndex(songTime());
    if (idx < 0) return;
    loopA = arr.sections[idx].t;
    loopB = arr.sections[idx].end != null ? arr.sections[idx].end : songLength();
    loopOn = true;
    updateLoopUI();
  });
  loopToggle.addEventListener("click", () => { loopOn = !loopOn; updateLoopUI(); });
  loopClear.addEventListener("click", resetLoop);

  invHwBtn.addEventListener("click", () => { invertHW = !invertHW; updateOrientUI(); renderFrame(); });
  invBoardBtn.addEventListener("click", () => { invertBoard = !invertBoard; updateOrientUI(); renderFrame(); });

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
      resetOriginal();
      pausedPos = 0;
      buildSong();
      songTab.classList.add("song-loaded");
      // The stage was hidden during buildSong, so canvases measured 0 width and
      // rendered blurry. Re-measure + redraw once layout has actually flushed.
      const redraw = () => { if (arr) { resizeCanvas(); layoutTimeline(); renderFrame(); } };
      requestAnimationFrame(redraw);
      setTimeout(redraw, 120);
      setTimeout(redraw, 350);
      dropStatus.textContent = "";
    } catch (err) {
      dropStatus.textContent = "Не удалось разобрать: " + err.message;
    }
  }

  function buildSong() {
    titleEl.textContent = song.title || "—";
    metaEl.textContent = [song.artist, song.album, song.year].filter(Boolean).join(" · ");
    arrSelect.innerHTML = "";
    const labels = { lead: "Lead", rhythm: "Rhythm", rhythm2: "Rhythm 2", lead2: "Lead 2", bass: "Bass", combo: "Combo" };
    for (const key of Object.keys(song.arrangements)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = labels[key] || key;
      arrSelect.appendChild(opt);
    }
    arrSelect.value = song.arrangements.lead ? "lead" : Object.keys(song.arrangements)[0];
    resetLoop();
    buildLyrics();
    selectArrangement(arrSelect.value);
    timeTotalEl.textContent = fmtTime(song.length);
  }

  arrSelect.addEventListener("change", () => { const wasPlaying = playing; const t = songTime(); selectArrangement(arrSelect.value); seek(t); if (wasPlaying) { /* keep position */ } });

  const TECH_LABELS = {
    palmMutes: "палм-мьюты", harmonics: "флажолеты", pinchHarmonics: "пинч-гармоники",
    hopo: "hammer/pull", tapping: "тэппинг", slides: "слайды", bends: "бенды",
    tremolo: "тремоло", vibrato: "вибрато", powerChords: "квинты", barreChords: "барре",
    openChords: "открытые аккорды", doubleStops: "даблстопы", fretHandMutes: "мьюты",
    dropDPower: "drop-D", twoFingerPicking: "пальцами", slapPop: "слэп",
  };

  function selectArrangement(key) {
    arr = song.arrangements[key];
    const ts = arr.timeSig ? `${arr.timeSig.num}/${arr.timeSig.den}` : "";
    tuningEl.textContent = `Строй: ${arr.tuningName}${arr.capo ? " · капо " + arr.capo : ""}${ts ? " · " + ts : ""}`;
    if (songProps) {
      const used = Object.keys(TECH_LABELS).filter((k) => arr.props && arr.props[k]).map((k) => TECH_LABELS[k]);
      songProps.textContent = used.length ? "Приёмы: " + used.join(", ") : "";
    }
    let maxFret = 12;
    for (const n of arr.notes) if (n.f > maxFret) maxFret = n.f;
    frets = clamp(maxFret + 1, 12, 24);
    precomputeSectionScales();
    viewStart = 0; viewEnd = 0; // reset zoom to full song
    layoutTimeline();
    buildScaleRibbon();
    resizeCanvas();
    renderFrame();
  }

  function scaleColorFor(scale) {
    if (!scale) return "hsl(0 0% 40%)";
    const hue = (scale.root * 30 + (scale.name.includes("мажор") ? 0 : 200)) % 360;
    return `hsl(${hue} 60% 62%)`;
  }
  function scaleShort(scale) {
    if (!scale) return "—";
    const short = scale.name
      .replace("натуральный минор", "minor")
      .replace("гармонический минор", "harm.min")
      .replace("минорная пентатоника", "min.pent")
      .replace("фригийский доминантный", "phryg.dom")
      .replace("фригийский", "phrygian")
      .replace("дорийский", "dorian")
      .replace("мажор", "major");
    return `${NOTE_NAMES_SHARP[scale.root]} ${short}`;
  }

  function buildScaleRibbon() {
    scaleRibbon.innerHTML = "";
    arr.sections.forEach((sec, i) => {
      const end = sec.end != null ? sec.end : song.length;
      const scale = arr._scales[i];
      const seg = document.createElement("div");
      seg.className = "ribbon-seg";
      seg.dataset.idx = String(i);
      seg.style.flexGrow = String(Math.max(0.0001, end - sec.t));
      seg.style.background = scaleColorFor(scale);
      seg.textContent = scaleShort(scale);
      seg.title = `${sec.name}: ${scale ? NOTE_NAMES_SHARP[scale.root] + " " + scale.name : "—"}`;
      seg.addEventListener("click", () => seek(sec.t));
      scaleRibbon.appendChild(seg);
    });
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

  // ============ Timeline (zoomable) ============
  let viewStart = 0;
  let viewEnd = 0; // <=viewStart means "full song"
  function vStart() { return viewEnd > viewStart ? viewStart : 0; }
  function vSpan() { return (viewEnd > viewStart ? viewEnd - viewStart : songLength()) || 1; }
  function pctOf(t) { return ((t - vStart()) / vSpan()) * 100; }
  function timeAtClientX(clientX) {
    const rect = timeline.getBoundingClientRect();
    return clamp(vStart() + ((clientX - rect.left) / rect.width) * vSpan(), 0, songLength());
  }
  function resetZoom() { viewStart = 0; viewEnd = songLength(); layoutTimeline(); }
  function layoutTimeline() { drawDensity(); drawSections(); updateLoopUI(); }

  function drawDensity() {
    const w = densityCanvas.clientWidth || timeline.clientWidth || 600;
    const h = densityCanvas.clientHeight || 88;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    densityCanvas.width = Math.floor(w * dpr);
    densityCanvas.height = Math.floor(h * dpr);
    const ctx = densityCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const vs = vStart(), sp = vSpan();

    // measure ticks (bar divisions); numbers when zoomed in enough
    if (arr.measures && arr.measures.length) {
      const pxPerMeasure = (w / sp) * (sp / Math.max(1, arr.measures.length)) * 0; // placeholder
      const avgBeatSec = 60 / Math.max(1, arr.tempo);
      const measSec = avgBeatSec * (arr.timeSig ? arr.timeSig.num : 4);
      const pxPerMeas = (measSec / sp) * w;
      ctx.font = "700 10px Rajdhani, Segoe UI, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      for (const m of arr.measures) {
        if (m.t < vs - 0.01 || m.t > vs + sp) continue;
        const x = ((m.t - vs) / sp) * w;
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.fillRect(x, 0, 1, h);
        if (pxPerMeas > 34 || m.measure % 4 === 0) {
          ctx.fillStyle = "rgba(200,210,225,0.55)";
          ctx.fillText(String(m.measure), x + 2, 2);
        }
      }
    }

    // note density for the visible window
    const cols = Math.max(60, Math.floor(w / 3));
    const buckets = new Array(cols).fill(0);
    for (const n of arr.notes) {
      if (n.t < vs || n.t > vs + sp) continue;
      buckets[clamp(Math.floor(((n.t - vs) / sp) * cols), 0, cols - 1)] += 1;
    }
    const peak = Math.max(1, ...buckets);
    const bw = w / cols;
    for (let c = 0; c < cols; c += 1) {
      const bh = (buckets[c] / peak) * (h - 18);
      ctx.fillStyle = "rgba(255, 138, 61, 0.35)";
      ctx.fillRect(c * bw, h - bh, Math.max(1, bw - 0.5), bh);
    }
  }

  function drawSections() {
    sectionsEl.innerHTML = "";
    const vs = vStart(), sp = vSpan();
    for (const sec of arr.sections) {
      const left = ((sec.t - vs) / sp) * 100;
      if (left < -5 || left > 105) continue;
      const seg = document.createElement("div");
      seg.className = "seg";
      seg.style.left = `${left}%`;
      const label = document.createElement("span");
      label.textContent = sec.name;
      seg.appendChild(label);
      sectionsEl.appendChild(seg);
    }
  }

  function seekFromClientX(clientX) { seek(timeAtClientX(clientX)); }

  let dragging = false;
  let panning = false;
  let panStartX = 0, panStartView = 0;
  let loopDragMode = null; // "create" | "a" | "b" | "mid"
  timeline.addEventListener("pointerdown", (e) => {
    if (!song) return;
    if (e.shiftKey) {
      // Shift+drag = select loop region
      loopDragMode = "create";
      loopA = timeAtClientX(e.clientX); loopB = loopA;
      timeline.setPointerCapture(e.pointerId);
      return;
    }
    if (e.ctrlKey && viewEnd > viewStart) {
      // Ctrl+drag = pan (when zoomed)
      panning = true; panStartX = e.clientX; panStartView = vStart();
      timeline.setPointerCapture(e.pointerId);
      return;
    }
    dragging = true; timeline.setPointerCapture(e.pointerId); seekFromClientX(e.clientX); startLoop();
  });
  timeline.addEventListener("pointermove", (e) => {
    if (loopDragMode === "create") {
      loopB = timeAtClientX(e.clientX);
      if (loopB < loopA) { const t = loopA; loopA = loopB; loopB = t; }
      loopOn = true; updateLoopUI();
    } else if (panning) {
      const rect = timeline.getBoundingClientRect();
      const dt = ((e.clientX - panStartX) / rect.width) * vSpan();
      let ns = clamp(panStartView - dt, 0, songLength() - vSpan());
      viewStart = ns; viewEnd = ns + vSpan(); layoutTimeline();
    } else if (dragging) {
      seekFromClientX(e.clientX);
    }
  });
  timeline.addEventListener("pointerup", (e) => {
    dragging = false; panning = false; loopDragMode = null;
    try { timeline.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  // wheel = zoom around cursor
  timeline.addEventListener("wheel", (e) => {
    if (!song) return;
    e.preventDefault();
    const len = songLength();
    const cursorT = timeAtClientX(e.clientX);
    const sp = vSpan();
    const newSpan = clamp(sp * (e.deltaY < 0 ? 0.8 : 1.25), 3, len);
    let ns = cursorT - (cursorT - vStart()) * (newSpan / sp);
    let ne = ns + newSpan;
    if (ns < 0) { ns = 0; ne = newSpan; }
    if (ne > len) { ne = len; ns = len - newSpan; }
    if (newSpan >= len - 0.01) { viewStart = 0; viewEnd = len; } else { viewStart = Math.max(0, ns); viewEnd = Math.min(len, ne); }
    layoutTimeline();
  }, { passive: false });

  timeline.addEventListener("dblclick", () => { if (song) resetZoom(); });

  // ---- draggable loop handles (#6) ----
  let loopMidStartX = 0, loopMidA = 0, loopMidB = 0;
  function bindLoopHandle(el, mode) {
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      loopDragMode = mode;
      if (mode === "mid") { loopMidStartX = e.clientX; loopMidA = loopA; loopMidB = loopB; }
      el.setPointerCapture(e.pointerId);
      loopOn = true;
    });
    el.addEventListener("pointermove", (e) => {
      if (loopDragMode !== mode) return;
      if (mode === "a") { loopA = Math.min(timeAtClientX(e.clientX), (loopB ?? songLength()) - 0.1); }
      else if (mode === "b") { loopB = Math.max(timeAtClientX(e.clientX), (loopA ?? 0) + 0.1); }
      else if (mode === "mid") {
        const rect = timeline.getBoundingClientRect();
        const dt = ((e.clientX - loopMidStartX) / rect.width) * vSpan();
        const span = loopMidB - loopMidA;
        let na = clamp(loopMidA + dt, 0, songLength() - span);
        loopA = na; loopB = na + span;
      }
      updateLoopUI();
    });
    el.addEventListener("pointerup", (e) => { loopDragMode = null; try { el.releasePointerCapture(e.pointerId); } catch (_) {} });
  }
  bindLoopHandle(loopHandleAEl, "a");
  bindLoopHandle(loopHandleBEl, "b");
  bindLoopHandle(loopMidEl, "mid");

  // Drag the highway left/right to scrub smoothly through the song
  let hwDrag = false, hwDragX = 0, hwDragT = 0, hwMoved = false;
  highway.addEventListener("pointerdown", (e) => {
    if (!arr) return;
    hwDrag = true; hwMoved = false; hwDragX = e.clientX; hwDragT = songTime();
    try { highway.setPointerCapture(e.pointerId); } catch (_) {}
    startLoop();
  });
  highway.addEventListener("pointermove", (e) => {
    if (!hwDrag) return;
    const dx = e.clientX - hwDragX;
    if (Math.abs(dx) > 2) hwMoved = true;
    const dt = -(dx / (hwTrackW || 1)) * HW_WINDOW; // drag left = advance
    seek(clamp(hwDragT + dt, 0, songLength()));
  });
  const endHwDrag = (e) => { hwDrag = false; try { highway.releasePointerCapture(e.pointerId); } catch (_) {} };
  highway.addEventListener("pointerup", endHwDrag);
  highway.addEventListener("pointercancel", endHwDrag);

  // Click the fretboard to hear a note (respects the board inversion)
  let clickFlash = null;
  function playClickedNoteSong(s, f) {
    if (s < 0 || s > 5 || !arr) return;
    const ctx = ensureCtx();
    ctx.resume();
    const midi = arr.openMidi[s] + f;
    const freq = midiToFreq(midi);
    const now = ctx.currentTime + 0.01;
    const a = buildAmp(ctx);
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const tone = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = "sawtooth"; osc2.type = "sawtooth";
    osc.frequency.value = freq; osc2.frequency.value = freq; osc2.detune.value = 6;
    tone.type = "lowpass"; tone.frequency.value = 3000;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.26, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    osc.connect(tone); osc2.connect(tone); tone.connect(g); g.connect(a.input);
    osc.start(now); osc2.start(now); osc.stop(now + 0.6); osc2.stop(now + 0.6);
    setTimeout(() => { a.nodes.forEach((n) => { try { n.disconnect(); } catch (_) {} }); }, 900);
  }
  canvas.addEventListener("click", (e) => {
    if (!arr || !cssW) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const L = layout();
    const row = clamp(Math.round((y - L.sTop) / L.gap), 0, 5);
    const s = invertBoard ? 5 - row : row;
    const f = x < L.left - 2 ? 0 : clamp(Math.round((x - L.left) / L.fw + 0.5), 1, frets);
    clickFlash = { s, f, t0: performance.now() };
    playClickedNoteSong(s, f);
    renderFrame();
    setTimeout(() => { clickFlash = null; renderFrame(); }, 480);
  });

  // ============ Board rendering ============
  let cssW = 0, cssH = 0;
  let hwW = 0, hwH = 0;
  let hwTrackW = 1;
  function resizeCanvas() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, Math.floor(rect.width));
    cssH = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);

    const hr = highway.getBoundingClientRect();
    hwW = Math.max(1, Math.floor(hr.width));
    hwH = Math.max(1, Math.floor(hr.height));
    highway.width = Math.floor(hwW * dpr);
    highway.height = Math.floor(hwH * dpr);
    highway.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function layout() {
    const left = 74, right = cssW - 150, top = 46, bottom = cssH - 34;
    const fw = (right - left) / Math.max(1, frets);
    const sTop = top + 10, sBottom = bottom - 10, gap = (sBottom - sTop) / 5;
    return { left, right, top, bottom, fw, sTop, sBottom, gap };
  }
  const xFretLine = (L, f) => L.left + f * L.fw;
  // Open-string notes sit in a fixed column left of the nut (not fw-proportional,
  // so they don't slide off-screen when fret width is large).
  const xNote = (L, f) => (f === 0 ? L.left - 28 : L.left + (f - 0.5) * L.fw);
  const yString = (L, s) => L.sTop + L.gap * (invertBoard ? 5 - s : s);

  function techGlyph(n) {
    if (n.mute) return "✕";
    if (n.harm || n.pinch) return "◇";
    if (n.tap) return "T";
    if (n.slideTo != null) return n.slideTo > n.f ? "／" : "＼";
    if (n.ho) return "H";
    if (n.po) return "P";
    if (n.bend) return "↗";
    return null;
  }

  // Detect whether the notes around time t sit inside a single ~5-fret position (CAGED-ish box).
  // Uses a tight window around "now" so a position change is picked up quickly; open strings
  // (fret 0) are ignored since they don't pin a hand position.
  // Position box: anchor on the note nearest to "now", then include only notes within a
  // hand span of it. This tracks the current hand position and jumps quickly to the next
  // even across fast neck-spanning transitions (outliers in another position are ignored).
  function detectBox(t) {
    const win = [];
    let i = firstNoteIdx(t - 0.5);
    if (i < 0) i = 0;
    for (; i < arr.notes.length; i += 1) {
      const n = arr.notes[i];
      if (n.t > t + 1.0) break;
      if (n.f > 0 && n.s >= 0 && n.s <= 5) win.push(n);
    }
    if (!win.length) return null;
    let anchor = win[0];
    let best = Infinity;
    for (const n of win) {
      const d = Math.abs(n.t - t);
      if (d < best) { best = d; anchor = n; }
    }
    const near = win.filter((n) => Math.abs(n.f - anchor.f) <= 4);
    let lo = Math.min(...near.map((n) => n.f));
    let hi = Math.max(...near.map((n) => n.f));
    if (hi - lo > 5) hi = lo + 5;
    return { lo, hi };
  }

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

    // Current position box (CAGED-ish): shade the fret window if the riff sits in one position
    const box = detectBox(t);
    if (box) {
      const x0 = xFretLine(L, Math.max(0, box.lo - 1));
      const x1 = xFretLine(L, Math.min(frets, box.hi));
      ctx.fillStyle = "rgba(56,189,248,0.10)";
      ctx.fillRect(x0, L.sTop - L.gap * 0.5, x1 - x0, (L.sBottom - L.sTop) + L.gap);
      ctx.strokeStyle = "rgba(56,189,248,0.5)"; ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, L.sTop - L.gap * 0.5, x1 - x0, (L.sBottom - L.sTop) + L.gap);
      ctx.fillStyle = "#7dd3fc"; ctx.font = "700 12px Rajdhani, Segoe UI, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText(`позиция ${box.lo}–${box.hi} лад`, x0 + 6, L.sTop - L.gap * 0.5 - 4);
    }

    // Scale notes across the whole board (what's available in the current key)
    const dotR = clamp(Math.min(L.fw, L.gap) * 0.28, 7, 12);
    if (scaleSet) {
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let s = 0; s < 6; s += 1) {
        const y = yString(L, s);
        for (let f = 0; f <= frets; f += 1) {
          const pc = (arr.openMidi[s] + f) % 12;
          if (!scaleSet.has(pc)) continue;
          const isRoot = pc === scale.root;
          const x = xNote(L, f);
          ctx.beginPath(); ctx.arc(x, y, isRoot ? dotR + 1 : dotR, 0, Math.PI * 2);
          ctx.fillStyle = isRoot ? "rgba(245,158,11,0.85)" : "rgba(59,130,246,0.4)";
          ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = isRoot ? "#fde68a" : "rgba(147,197,253,0.6)"; ctx.stroke();
          ctx.fillStyle = isRoot ? "#3b2406" : "rgba(226,232,240,0.92)";
          ctx.font = `700 ${dotR}px Rajdhani, Segoe UI, sans-serif`;
          ctx.fillText(NOTE_NAMES_SHARP[pc], x, y);
        }
      }
    }

    const { active } = notesActiveAt(t);
    const r = clamp(Math.min(L.fw, L.gap) * 0.36, 10, 16);

    // Only the notes sounding right now. Green = in the current scale, orange = outside it.
    for (const n of active) {
      if (n.s < 0 || n.s > 5) continue;
      const x = xNote(L, n.f), y = yString(L, n.s);
      const inScale = scaleSet ? scaleSet.has(n.pc) : true;
      const fill = inScale ? "#22c55e" : "#fb923c";
      const glowC = inScale ? "rgba(34,197,94,0.85)" : "rgba(251,146,60,0.85)";
      const glow = ctx.createRadialGradient(x, y, 2, x, y, r + 18);
      glow.addColorStop(0, glowC); glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r + 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = fill; ctx.strokeStyle = "#fff7ed"; ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#0b1220"; ctx.font = `800 ${r + 1}px Rajdhani, Segoe UI, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(n.f), x, y);
      const g = techGlyph(n);
      if (g) {
        ctx.fillStyle = "#fde68a"; ctx.font = "700 12px Rajdhani, Segoe UI, sans-serif";
        ctx.fillText(g, x + r + 8, y - r);
      }
    }

    // click-to-play flash
    if (clickFlash && performance.now() - clickFlash.t0 < 480 && clickFlash.s >= 0 && clickFlash.s <= 5) {
      const x = xNote(L, clickFlash.f), y = yString(L, clickFlash.s);
      ctx.strokeStyle = "#fef3c7"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.fillStyle = "#94a3b8"; ctx.font = "600 11px Rajdhani, Segoe UI, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("0", xNote(L, 0), L.bottom + 16);
    for (let f = 1; f <= frets; f += 1) ctx.fillText(String(f), xNote(L, f), L.bottom + 16);

    renderHighway(t);
    renderLyrics(t);
    updateInfo(t, secIdx, scale, active);
    // auto-follow the playhead when zoomed in and playing
    if (playing && viewEnd > viewStart) {
      const sp = vSpan();
      if (t < viewStart + sp * 0.05 || t > viewStart + sp * 0.85) {
        let ns = clamp(t - sp * 0.3, 0, songLength() - sp);
        if (Math.abs(ns - viewStart) > 0.01) { viewStart = ns; viewEnd = ns + sp; layoutTimeline(); }
      }
    }
    playheadEl.style.left = `${clamp(pctOf(t), 0, 100)}%`;
    timeNowEl.textContent = fmtTime(t);
  }

  const HW_WINDOW = 3.0; // seconds of upcoming notes visible in the highway
  function renderHighway(t) {
    if (!hwW) return;
    const ctx = highway.getContext("2d");
    ctx.clearRect(0, 0, hwW, hwH);
    const bg = ctx.createLinearGradient(0, 0, hwW, 0);
    bg.addColorStop(0, "#0c1322"); bg.addColorStop(1, "#0a0f18");
    ctx.fillStyle = bg; ctx.fillRect(0, 0, hwW, hwH);

    const strikeX = 78;
    const rowH = hwH / 6;
    const trackW = hwW - strikeX - 12;
    hwTrackW = trackW; // for drag-scrub
    const head = Math.min(rowH * 0.82, 50);
    const rowOf = (s) => (invertHW ? 5 - s : s);
    const yFor = (s) => (rowOf(s) + 0.5) * rowH;
    const timeToX = (tt) => strikeX + ((tt - t) / HW_WINDOW) * trackW;

    // row guides + string labels (number + open note)
    for (let s = 0; s < 6; s += 1) {
      const y = yFor(s);
      ctx.strokeStyle = "rgba(148,163,184,0.16)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(strikeX, y); ctx.lineTo(hwW, y); ctx.stroke();
      ctx.fillStyle = STRING_COLORS[s];
      ctx.font = "800 14px Rajdhani, Segoe UI, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(`${6 - s} ${NOTE_NAMES_SHARP[arr.openMidi[s] % 12]}`, 8, y);
    }

    // beat grid lines + measure numbers for orientation
    ctx.textBaseline = "top";
    for (const b of arr.beats) {
      if (b.t < t - 0.1) continue;
      if (b.t > t + HW_WINDOW) break;
      const bx = timeToX(b.t);
      const downbeat = b.measure != null;
      ctx.strokeStyle = downbeat ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.06)";
      ctx.lineWidth = downbeat ? 1.5 : 1;
      ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, hwH); ctx.stroke();
      if (downbeat && bx >= strikeX - 4) {
        ctx.fillStyle = "rgba(15,20,30,0.65)";
        ctx.fillRect(bx + 2, 2, 26, 20);
        ctx.fillStyle = "#fde68a";
        ctx.font = "800 17px Rajdhani, Segoe UI, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(String(b.measure), bx + 5, 3);
      }
    }

    // strike line
    ctx.fillStyle = "rgba(255,124,34,0.9)"; ctx.fillRect(strikeX - 1.5, 0, 3, hwH);
    ctx.fillStyle = "rgba(255,124,34,0.16)"; ctx.fillRect(strikeX - 12, 0, 12, hwH);

    const a = arr.notes;
    // start early so long sustains keep their tail while still ringing
    let i = firstNoteIdx(t - 6);
    if (i < 0) i = 0;
    for (; i < a.length; i += 1) {
      const n = a[i];
      if (n.t > t + HW_WINDOW) break;
      if (n.s < 0 || n.s > 5) continue;
      const susEff = Math.max(n.sus, 0);
      const xHead = timeToX(n.t);
      const xTail = timeToX(n.t + susEff);
      if (xTail < 0 || xHead > hwW) continue; // fully off-screen
      const y = yFor(n.s);
      const color = STRING_COLORS[n.s];
      const dim = n.pm ? 0.68 : 1;

      // sustain trail (head -> tail), clipped to visible area
      if (xTail - xHead > 3) {
        const tl = Math.max(xHead, 0), tr = Math.min(xTail, hwW);
        ctx.globalAlpha = 0.45 * dim;
        ctx.fillStyle = color;
        roundRect(ctx, tl, y - rowH * 0.16, tr - tl, rowH * 0.32, 5); ctx.fill();
        ctx.globalAlpha = 1;
      }

      // head gem — visible while approaching / at the strike, gone once played
      if (xHead >= strikeX - head * 0.6 && xHead <= hwW + head) {
        const hit = n.t <= t + 0.02 && t <= n.t + Math.max(susEff, 0.08);
        ctx.globalAlpha = dim;
        ctx.fillStyle = color;
        roundRect(ctx, xHead - head / 2, y - head / 2, head, head, 9); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = hit ? 4 : (n.acc ? 3 : 1.5);
        ctx.strokeStyle = hit ? "#fff7ed" : (n.acc ? "#fde68a" : "rgba(0,0,0,0.35)");
        roundRect(ctx, xHead - head / 2, y - head / 2, head, head, 9); ctx.stroke();
        // fret number — white with a dark outline so it reads on any square (incl. dim palm-mute)
        const fs = Math.round(head * 0.58);
        ctx.font = `800 ${fs}px Rajdhani, Segoe UI, sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.lineWidth = Math.max(3, fs * 0.2);
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(6,10,18,0.92)";
        ctx.strokeText(String(n.f), xHead, y + 1);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(String(n.f), xHead, y + 1);
        // technique badge (top-right corner of gem)
        const g = techGlyph(n);
        if (g) {
          ctx.fillStyle = "#0b1220"; ctx.globalAlpha = 0.8;
          ctx.beginPath(); ctx.arc(xHead + head * 0.42, y - head * 0.42, head * 0.24, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1; ctx.fillStyle = "#fde68a";
          ctx.font = `800 ${Math.round(head * 0.32)}px Rajdhani, Segoe UI, sans-serif`;
          ctx.fillText(g, xHead + head * 0.42, y - head * 0.4);
        }
        if (n.pm) {
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.font = "700 9px Rajdhani, Segoe UI, sans-serif";
          ctx.fillText("PM", xHead, y + head * 0.42);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  let ribbonCurrent = -1;
  function updateInfo(t, secIdx, scale, active) {
    infoSection.textContent = secIdx >= 0 ? arr.sections[secIdx].name : "—";
    scaleNowName.textContent = scale ? `${NOTE_NAMES_SHARP[scale.root]} ${scale.name} (${Math.round(scale.coverage * 100)}%)` : "—";
    renderScaleStrip(scale, active);
    if (secIdx !== ribbonCurrent) {
      ribbonCurrent = secIdx;
      Array.from(scaleRibbon.children).forEach((el, i) => el.classList.toggle("is-current", i === secIdx));
    }
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
    const ts = arr.timeSig ? `${arr.timeSig.num}/${arr.timeSig.den}` : "";
    infoBeat.textContent = `${measure != null ? "такт " + measure : "—"}${ts ? " · " + ts : ""} · ${Math.round(arr.tempo)} BPM`;
  }

  let stripSig = "";
  let scaleCells = [];
  function renderScaleStrip(scale, active) {
    const sig = scale ? scale.root + "|" + scale.name : "none";
    if (sig !== stripSig) {
      stripSig = sig;
      scaleStrip.innerHTML = "";
      scaleCells = [];
      const inSet = scale ? new Set(DETECT_SCALES.find((s) => s.name === scale.name).ivals.map((iv) => (scale.root + iv) % 12)) : null;
      for (let pc = 0; pc < 12; pc += 1) {
        const cell = document.createElement("div");
        cell.className = "scale-cell";
        const note = document.createElement("span");
        note.textContent = NOTE_NAMES_SHARP[pc];
        cell.appendChild(note);
        if (inSet && inSet.has(pc)) {
          cell.classList.add("in-scale");
          if (pc === scale.root) cell.classList.add("is-root");
          const deg = document.createElement("span");
          deg.className = "deg";
          deg.textContent = DEGREE_LABELS[((pc - scale.root) % 12 + 12) % 12];
          cell.appendChild(deg);
        }
        scaleStrip.appendChild(cell);
        scaleCells.push(cell);
      }
    }
    const playing = new Set(active.map((n) => n.pc));
    for (let pc = 0; pc < 12; pc += 1) scaleCells[pc].classList.toggle("playing", playing.has(pc));
  }

  // ============ Lyrics (vocals, synced) ============
  let lyricLines = [];
  let lyricLineIdx = -1;
  function buildLyrics() {
    lyricLines = [];
    lyricLineIdx = -1;
    lyricLine.innerHTML = "";
    lyricBall.style.opacity = "0";
    const v = song && song.vocals;
    if (!v || !v.length) { lyricsEl.hidden = true; return; }
    let cur = [];
    for (const ev of v) {
      cur.push(ev);
      if (ev.lineBreak) { lyricLines.push(cur); cur = []; }
    }
    if (cur.length) lyricLines.push(cur);
    lyricLines = lyricLines.map((words) => ({
      t: words[0].t,
      end: words[words.length - 1].t + (words[words.length - 1].len || 0.3),
      words,
    }));
    lyricsEl.hidden = false;
  }

  const LYRIC_LEAD = 0.4; // switch to the next line this many seconds before it starts
  function renderLyrics(t) {
    if (!lyricLines.length) return;
    // Current line = the last line that has started (minus a small lead). This switches
    // promptly to the new line instead of lingering on the old one.
    let idx = -1;
    for (let i = 0; i < lyricLines.length; i += 1) {
      if (lyricLines[i].t <= t + LYRIC_LEAD) idx = i; else break;
    }
    if (idx === -1) idx = 0;
    const L = lyricLines[idx];

    if (idx !== lyricLineIdx) {
      lyricLineIdx = idx;
      lyricLine.innerHTML = "";
      L.words.forEach((w, j) => {
        const span = document.createElement("span");
        span.className = "word";
        span.textContent = w.text + (w.joinNext || j === L.words.length - 1 ? "" : " ");
        lyricLine.appendChild(span);
      });
    }

    const spans = lyricLine.children;
    let activeIdx = -1;
    let nextIdx = -1;
    for (let j = 0; j < L.words.length; j += 1) {
      const w = L.words[j];
      const span = spans[j];
      if (!span) continue;
      const dur = Math.max(w.len, 0.15);
      const isActive = t >= w.t && t < w.t + dur;
      span.classList.toggle("active", isActive);
      span.classList.toggle("sung", t >= w.t + dur);
      if (isActive) activeIdx = j;
      if (nextIdx === -1 && t < w.t) nextIdx = j;
    }

    // bouncing ball over the current (or upcoming) word
    const ballIdx = activeIdx >= 0 ? activeIdx : nextIdx;
    const lineLive = t >= L.t - LYRIC_LEAD && t <= L.end + 0.4;
    if (ballIdx >= 0 && spans[ballIdx] && lineLive) {
      const span = spans[ballIdx];
      lyricBall.style.left = (span.offsetLeft + span.offsetWidth / 2) + "px";
      lyricBall.style.opacity = "1";
    } else {
      lyricBall.style.opacity = "0";
    }
  }

  // ============ Loop ============
  function loop() {
    if (!songTabActive) { rafId = null; return; }
    if (playing) {
      const t = songTime();
      if (loopOn && loopA != null && loopB != null && loopB > loopA && t >= loopB) {
        seek(loopA);
        rafId = requestAnimationFrame(loop);
        return;
      }
      if (source === "synth") scheduleAhead();
      if (t >= songLength()) {
        if (loopOn && loopA != null) { seek(loopA); rafId = requestAnimationFrame(loop); return; }
        pause(); pausedPos = songLength(); renderFrame(); return;
      }
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
    resizeCanvas(); layoutTimeline(); renderFrame();
  });

  bindDrop();
  updateOrientUI();

  // Redraw canvases whenever the stage gets/changes size (fixes blurry first paint
  // when the song stage was still hidden at load time).
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (!songTabActive || !arr) return;
      resizeCanvas(); layoutTimeline(); renderFrame();
    });
    ro.observe(timeline);
    ro.observe(canvas);
  }

  console.info("[fretboard] song analyzer build 17");
})();
