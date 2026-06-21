/* Client-side Rocksmith 2014 .psarc parser.
   Parses entirely in the browser — nothing is uploaded or stored.
   Exposes window.RSParse.parsePsarc(ArrayBuffer) -> Promise<songObject>. */
(() => {
  "use strict";

  const PSARC_KEY_HEX =
    "C53DB23870A1A2F71CAE64061FDD0E1157309DC85204D4C5BFDF25090DF2572C";

  const STANDARD_MIDI = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4 (string 0 = low E)
  const NOTE_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  function hexToBytes(hex) {
    const a = new Uint8Array(hex.length / 2);
    for (let i = 0; i < a.length; i += 1) a[i] = parseInt(hex.substr(i * 2, 2), 16);
    return a;
  }

  function beInt(view, off, n) {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = v * 256 + view.getUint8(off + i);
    return v;
  }

  // Full-block AES-256-CFB decrypt (IV = zeros), built from Web Crypto AES-CTR.
  // For each block: P_i = C_i XOR E(C_{i-1}); E(x) = CTR-encrypt of 16 zero bytes with counter=x.
  async function aesCfbDecrypt(keyBytes, data) {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, ["encrypt"]);
    const nBlocks = Math.ceil(data.length / 16);
    const out = new Uint8Array(data.length);
    const zero = new Uint8Array(16);
    const tasks = [];
    for (let i = 0; i < nBlocks; i += 1) {
      const counter = new Uint8Array(16);
      if (i > 0) counter.set(data.subarray((i - 1) * 16, (i - 1) * 16 + 16));
      tasks.push(
        crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, zero).then((ksBuf) => {
          const ks = new Uint8Array(ksBuf);
          const base = i * 16;
          for (let j = 0; j < 16 && base + j < out.length; j += 1) out[base + j] = data[base + j] ^ ks[j];
        })
      );
    }
    await Promise.all(tasks);
    return out;
  }

  async function inflate(u8) {
    const ds = new DecompressionStream("deflate");
    const blob = new Blob([u8]);
    const stream = blob.stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function readPsarc(arrayBuffer) {
    const raw = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);

    if (raw[0] !== 0x50 || raw[1] !== 0x53 || raw[2] !== 0x41 || raw[3] !== 0x52) {
      throw new Error("Это не PSARC-файл");
    }
    const tocSize = beInt(view, 12, 4);
    const numFiles = beInt(view, 20, 4);
    const blockSizeAlloc = beInt(view, 24, 4);
    const archiveFlags = beInt(view, 28, 4);

    let toc = raw.subarray(32, tocSize);
    if (archiveFlags & 4) {
      toc = await aesCfbDecrypt(hexToBytes(PSARC_KEY_HEX), toc);
    }
    const tv = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);

    const entries = [];
    let p = 0;
    for (let i = 0; i < numFiles; i += 1) {
      entries.push({
        zipIndex: beInt(tv, p + 16, 4),
        length: beInt(tv, p + 20, 5),
        offset: beInt(tv, p + 25, 5),
      });
      p += 30;
    }

    const bw = blockSizeAlloc <= 0x10000 ? 2 : blockSizeAlloc <= 0x1000000 ? 3 : 4;
    const blockSizes = [];
    while (p + bw <= toc.length) {
      blockSizes.push(beInt(tv, p, bw));
      p += bw;
    }

    async function extract(entry) {
      const parts = [];
      let idx = entry.zipIndex;
      let off = entry.offset;
      let remaining = entry.length;
      while (remaining > 0) {
        const bsize = blockSizes[idx];
        if (bsize === 0) {
          const chunk = raw.subarray(off, off + blockSizeAlloc);
          parts.push(chunk);
          off += blockSizeAlloc;
          remaining -= chunk.length;
        } else {
          const chunk = raw.subarray(off, off + bsize);
          off += bsize;
          let dec;
          if (chunk[0] === 0x78) dec = await inflate(chunk);
          else dec = chunk;
          parts.push(dec);
          remaining -= dec.length;
        }
        idx += 1;
      }
      let total = 0;
      for (const part of parts) total += part.length;
      const merged = new Uint8Array(total);
      let o = 0;
      for (const part of parts) { merged.set(part, o); o += part.length; }
      return merged;
    }

    const namelist = new TextDecoder("utf-8").decode(await extract(entries[0]));
    const names = namelist.split("\n").map((s) => s.trim()).filter(Boolean);

    const files = {};
    names.forEach((name, i) => { files[name] = entries[i + 1]; });

    return { names, files, extract };
  }

  // ---- XML arrangement parsing ----
  const num = (v, d = 0) => {
    const f = parseFloat(v);
    return Number.isFinite(f) ? f : d;
  };
  const int = (v, d = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  const r3 = (x) => Math.round(x * 1000) / 1000;

  function tuningName(offsets) {
    if (new Set(offsets).size === 1) {
      const o = offsets[0];
      if (o === 0) return "Standard (E)";
      const base = NOTE_SHARP[((STANDARD_MIDI[0] + o) % 12 + 12) % 12];
      return `${base} Standard`;
    }
    return "Custom";
  }

  function parseArrangement(xmlDoc) {
    const root = xmlDoc.documentElement;
    const get = (tag) => {
      const el = root.querySelector(":scope > " + tag);
      return el ? el.textContent : null;
    };

    const tn = root.querySelector(":scope > tuning");
    const offsets = [];
    for (let k = 0; k < 6; k += 1) offsets.push(tn ? int(tn.getAttribute("string" + k)) : 0);
    const capo = int(get("capo"));
    const openMidi = offsets.map((o, k) => STANDARD_MIDI[k] + o + capo);

    const chordTpl = {};
    root.querySelectorAll(":scope > chordTemplates > chordTemplate").forEach((c, idx) => {
      const frets = [];
      for (let k = 0; k < 6; k += 1) frets.push(int(c.getAttribute("fret" + k), -1));
      chordTpl[idx] = { name: c.getAttribute("chordName") || c.getAttribute("displayName") || "", frets };
    });

    const beats = [];
    root.querySelectorAll(":scope > ebeats > ebeat").forEach((b) => {
      const m = int(b.getAttribute("measure"), -1);
      beats.push({ t: r3(num(b.getAttribute("time"))), measure: m >= 0 ? m : null });
    });

    const rawSec = [];
    root.querySelectorAll(":scope > sections > section").forEach((s) => {
      rawSec.push({ name: s.getAttribute("name"), t: r3(num(s.getAttribute("startTime"))) });
    });
    rawSec.sort((a, b) => a.t - b.t);
    const sections = rawSec.map((s, n) => ({ ...s, end: n + 1 < rawSec.length ? rawSec[n + 1].t : null }));

    const mkNote = (el, chordName) => {
      const s = int(el.getAttribute("string"));
      const fret = int(el.getAttribute("fret"));
      const pc = s >= 0 && s < 6 ? ((openMidi[s] + fret) % 12 + 12) % 12 : 0;
      const n = { t: r3(num(el.getAttribute("time"))), s, f: fret, sus: r3(num(el.getAttribute("sustain"))), pc };
      if (el.getAttribute("palmMute") === "1") n.pm = 1;
      if (el.getAttribute("hopo") === "1" || el.getAttribute("hammerOn") === "1" || el.getAttribute("pullOff") === "1") n.hopo = 1;
      if (int(el.getAttribute("slideTo"), -1) >= 0) n.slideTo = int(el.getAttribute("slideTo"));
      const bend = el.getAttribute("bend");
      if (bend && bend !== "0") n.bend = 1;
      if (chordName) n.chord = chordName;
      return n;
    };

    const notes = [];
    let track = root.querySelector(":scope > transcriptionTrack");
    if (!track) {
      // fall back to highest-difficulty level
      let best = null;
      let bestD = -2;
      root.querySelectorAll(":scope > levels > level").forEach((lv) => {
        const d = int(lv.getAttribute("difficulty"), -1);
        if (d > bestD) { bestD = d; best = lv; }
      });
      track = best;
    }
    if (track) {
      track.querySelectorAll(":scope > notes > note").forEach((el) => notes.push(mkNote(el)));
      track.querySelectorAll(":scope > chords > chord").forEach((ch) => {
        const cid = int(ch.getAttribute("chordId"), -1);
        const cname = (chordTpl[cid] && chordTpl[cid].name) || null;
        const cnotes = ch.querySelectorAll(":scope > chordNote");
        if (cnotes.length) {
          cnotes.forEach((el) => notes.push(mkNote(el, cname)));
        } else if (chordTpl[cid]) {
          const t = r3(num(ch.getAttribute("time")));
          chordTpl[cid].frets.forEach((fr, s) => {
            if (fr >= 0) notes.push({ t, s, f: fr, sus: 0, pc: ((openMidi[s] + fr) % 12 + 12) % 12, chord: cname });
          });
        }
      });
    }
    notes.sort((a, b) => a.t - b.t || a.s - b.s);

    return {
      arrangement: get("arrangement"),
      tuningOffsets: offsets,
      capo,
      tuningName: tuningName(offsets),
      openMidi,
      tempo: r3(num(get("averageTempo"), 120)),
      beats,
      sections,
      notes,
      noteCount: notes.length,
    };
  }

  async function parsePsarc(arrayBuffer) {
    const arc = await readPsarc(arrayBuffer);
    const xmlNames = arc.names.filter(
      (n) => n.endsWith(".xml") && n.includes("/arr/") && !n.includes("showlight")
    );
    if (xmlNames.length === 0) {
      throw new Error(
        "В этом psarc нет arrangement-XML (вероятно, официальный DLC с бинарными .sng). Пока поддерживаются CDLC с XML."
      );
    }

    const parser = new DOMParser();
    let meta = null;
    const arrangements = {};
    for (const name of xmlNames) {
      const bytes = await arc.extract(arc.files[name]);
      const text = new TextDecoder("utf-8").decode(bytes);
      const doc = parser.parseFromString(text, "application/xml");
      if (doc.querySelector("parsererror")) continue;
      const rootEl = doc.documentElement;
      if (!meta) {
        meta = {
          title: rootEl.querySelector(":scope > title")?.textContent || "—",
          artist: rootEl.querySelector(":scope > artistName")?.textContent || "",
          album: rootEl.querySelector(":scope > albumName")?.textContent || "",
          year: int(rootEl.querySelector(":scope > albumYear")?.textContent),
          length: r3(num(rootEl.querySelector(":scope > songLength")?.textContent)),
        };
      }
      const base = name.split("/").pop().replace(".xml", "");
      const key = base.split("_").pop();
      arrangements[key] = parseArrangement(doc);
    }

    if (!meta || Object.keys(arrangements).length === 0) {
      throw new Error("Не удалось разобрать партии из psarc");
    }
    return { ...meta, arrangements };
  }

  window.RSParse = { parsePsarc, readPsarc };
})();
