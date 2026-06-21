/* Client-side Wwise .wem (Vorbis) -> Ogg Vorbis converter.
   A faithful JS port of ww2ogg (hcs) for the RS2014 variant:
   no-granule 2-byte packet headers, stripped setup header, external
   codebooks (packed_codebooks_aoTuV_603.bin), modified Vorbis packets.
   Additionally recomputes Ogg granule positions (like revorb) so the
   result has a correct duration and seeks cleanly in <audio>.

   window.WemToOgg.convert(wemBytes: Uint8Array, codebooks: Uint8Array) -> Uint8Array */
(() => {
  "use strict";

  // ---- Ogg CRC (Tremor table) ----
  const CRC = new Uint32Array(256);
  (function buildCrc() {
    for (let n = 0; n < 256; n++) {
      let r = n << 24;
      for (let k = 0; k < 8; k++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
      CRC[n] = r >>> 0;
    }
  })();
  function oggChecksum(buf, len) {
    let crc = 0;
    for (let i = 0; i < len; i++) crc = ((crc << 8) ^ CRC[((crc >>> 24) & 0xff) ^ buf[i]]) >>> 0;
    return crc >>> 0;
  }

  // ---- LSB-first bit reader over a byte array ----
  class BitReader {
    constructor(bytes, byteOffset) {
      this.b = bytes;
      this.pos = byteOffset;
      this.cur = 0;
      this.bit = 8; // force load on first read
      this.total = 0;
    }
    getBit() {
      if (this.bit === 8) { this.cur = this.b[this.pos++] | 0; this.bit = 0; }
      const v = (this.cur >> this.bit) & 1;
      this.bit++;
      this.total++;
      return v;
    }
    read(n) {
      let v = 0;
      for (let i = 0; i < n; i++) if (this.getBit()) v |= (1 << i);
      return v >>> 0;
    }
  }

  // ---- LSB-first bit writer with Ogg page assembly ----
  class OggWriter {
    constructor() {
      this.out = [];           // array of Uint8Array chunks (finished pages)
      this.buf = 0;
      this.stored = 0;
      this.payload = [];       // current page payload bytes
      this.first = true;
      this.continued = false;
      this.granule = 0;
      this.seqno = 0;
    }
    putBit(bit) {
      if (bit) this.buf |= (1 << this.stored);
      this.stored++;
      if (this.stored === 8) { this.payload.push(this.buf); this.buf = 0; this.stored = 0; }
    }
    write(val, n) { for (let i = 0; i < n; i++) this.putBit((val >> i) & 1); }
    writeBig(valHi, valLo) { /* not needed */ }
    setGranule(g) { this.granule = g >>> 0; }
    flushBits() {
      if (this.stored !== 0) { this.payload.push(this.buf); this.buf = 0; this.stored = 0; }
    }
    flushPage(nextContinued = false, last = false) {
      this.flushBits();
      const payload = this.payload;
      if (payload.length === 0) return;
      let segments = Math.floor((payload.length + 255) / 255);
      if (segments === 256) segments = 255;

      const headerBytes = 27;
      const page = new Uint8Array(headerBytes + segments + payload.length);
      page[0] = 0x4f; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53; // OggS
      page[4] = 0;
      page[5] = (this.continued ? 1 : 0) | (this.first ? 2 : 0) | (last ? 4 : 0);
      // granule (64-bit LE; we use low 32, high 32 = 0 unless 0xFFFFFFFF)
      const g = this.granule >>> 0;
      page[6] = g & 0xff; page[7] = (g >>> 8) & 0xff; page[8] = (g >>> 16) & 0xff; page[9] = (g >>> 24) & 0xff;
      const gh = (g === 0xffffffff) ? 0xffffffff : 0;
      page[10] = gh & 0xff; page[11] = (gh >>> 8) & 0xff; page[12] = (gh >>> 16) & 0xff; page[13] = (gh >>> 24) & 0xff;
      // serial = 1
      page[14] = 1; page[15] = 0; page[16] = 0; page[17] = 0;
      // seqno
      const s = this.seqno >>> 0;
      page[18] = s & 0xff; page[19] = (s >>> 8) & 0xff; page[20] = (s >>> 16) & 0xff; page[21] = (s >>> 24) & 0xff;
      // checksum placeholder
      page[22] = 0; page[23] = 0; page[24] = 0; page[25] = 0;
      page[26] = segments;
      // lacing
      let left = payload.length;
      for (let i = 0; i < segments; i++) {
        if (left >= 255) { page[27 + i] = 255; left -= 255; }
        else page[27 + i] = left;
      }
      // payload
      page.set(payload, headerBytes + segments);
      // checksum
      const crc = oggChecksum(page, page.length);
      page[22] = crc & 0xff; page[23] = (crc >>> 8) & 0xff; page[24] = (crc >>> 16) & 0xff; page[25] = (crc >>> 24) & 0xff;

      this.out.push(page);
      this.seqno++;
      this.first = false;
      this.continued = nextContinued;
      this.payload = [];
    }
    finish() {
      let total = 0;
      for (const p of this.out) total += p.length;
      const merged = new Uint8Array(total);
      let o = 0;
      for (const p of this.out) { merged.set(p, o); o += p.length; }
      return merged;
    }
  }

  // ---- helpers from Tremor ----
  function ilog(v) { let r = 0; while (v) { r++; v >>= 1; } return r; }
  function bookMaptype1Quantvals(entries, dimensions) {
    const bits = ilog(entries);
    let vals = entries >> (((bits - 1) * (dimensions - 1)) / dimensions | 0);
    for (;;) {
      let acc = 1, acc1 = 1;
      for (let i = 0; i < dimensions; i++) { acc *= vals; acc1 *= vals + 1; }
      if (acc <= entries && acc1 > entries) return vals;
      if (acc > entries) vals--; else vals++;
    }
  }

  // ---- external codebook library ----
  class CodebookLibrary {
    constructor(bytes) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const fileSize = bytes.length;
      const offsetOffset = dv.getUint32(fileSize - 4, true);
      this.count = (fileSize - offsetOffset) / 4;
      this.data = bytes;
      this.offsets = new Array(this.count);
      for (let i = 0; i < this.count; i++) this.offsets[i] = dv.getUint32(offsetOffset + i * 4, true);
    }
    codebookRange(i) {
      if (i < 0 || i >= this.count - 1) throw new Error("invalid codebook id " + i);
      return [this.offsets[i], this.offsets[i + 1]];
    }
    rebuild(i, os) {
      const [start, end] = this.codebookRange(i);
      const cbSize = end - start;
      const bis = new BitReader(this.data, start);
      rebuildCodebook(bis, cbSize, os);
    }
  }

  // port of codebook_library::rebuild(Bit_stream, cb_size, Bit_oggstream)
  function rebuildCodebook(bis, cbSize, os) {
    const dimensions = bis.read(4);
    const entries = bis.read(14);
    os.write(0x564342, 24);          // 'BCV'
    os.write(dimensions, 16);
    os.write(entries, 24);

    const ordered = bis.read(1);
    os.write(ordered, 1);
    if (ordered) {
      const initialLength = bis.read(5);
      os.write(initialLength, 5);
      let current = 0;
      while (current < entries) {
        const nbits = ilog(entries - current);
        const number = bis.read(nbits);
        os.write(number, nbits);
        current += number;
      }
      if (current > entries) throw new Error("current_entry out of range");
    } else {
      const cwLenLen = bis.read(3);
      const sparse = bis.read(1);
      if (cwLenLen === 0 || cwLenLen > 5) throw new Error("nonsense codeword length");
      os.write(sparse, 1);
      for (let i = 0; i < entries; i++) {
        let present = 1;
        if (sparse) { present = bis.read(1); os.write(present, 1); }
        if (present) {
          const cwLen = bis.read(cwLenLen);
          os.write(cwLen, 5);
        }
      }
    }

    const lookupType = bis.read(1);
    os.write(lookupType, 4);
    if (lookupType === 0) {
      // none
    } else if (lookupType === 1) {
      const min = bis.read(32);
      const max = bis.read(32);
      const valueLength = bis.read(4);
      const sequenceFlag = bis.read(1);
      os.write(min, 32); os.write(max, 32); os.write(valueLength, 4); os.write(sequenceFlag, 1);
      const quantvals = bookMaptype1Quantvals(entries, dimensions);
      for (let i = 0; i < quantvals; i++) {
        const val = bis.read(valueLength + 1);
        os.write(val, valueLength + 1);
      }
    } else {
      throw new Error("invalid/unsupported lookup type " + lookupType);
    }

    if (cbSize !== 0 && ((bis.total / 8 | 0) + 1) !== cbSize) {
      throw new Error("codebook size mismatch: " + cbSize + " vs " + ((bis.total / 8 | 0) + 1));
    }
  }

  // ---- RIFF/WEM parse (RS2014 variant: fmt 0x42, no vorb chunk) ----
  function parseWem(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (tag(0) !== "RIFF") throw new Error("not a RIFF wem");
    if (tag(8) !== "WAVE") throw new Error("missing WAVE");
    const riffSize = dv.getUint32(4, true) + 8;

    let fmtOff = -1, fmtSize = -1, dataOff = -1, dataSize = -1, vorbOff = -1, vorbSize = -1;
    let off = 12;
    while (off < riffSize) {
      const ct = tag(off);
      const cs = dv.getUint32(off + 4, true);
      if (ct === "fmt ") { fmtOff = off + 8; fmtSize = cs; }
      else if (ct === "data") { dataOff = off + 8; dataSize = cs; }
      else if (ct === "vorb") { vorbOff = off + 8; vorbSize = cs; }
      off += 8 + cs;
    }
    if (fmtOff < 0 || dataOff < 0) throw new Error("missing fmt/data");
    if (vorbOff < 0 && fmtSize !== 0x42) throw new Error("expected 0x42 fmt if vorb missing");
    if (vorbOff < 0) vorbOff = fmtOff + 0x18;

    if (dv.getUint16(fmtOff, true) !== 0xffff) throw new Error("not Wwise Vorbis (bad codec id)");
    const channels = dv.getUint16(fmtOff + 2, true);
    const sampleRate = dv.getUint32(fmtOff + 4, true);
    const avgBytes = dv.getUint32(fmtOff + 8, true);

    // vorb fields for the no-vorb-chunk (size -1) / 0x2A layout
    const sampleCount = dv.getUint32(vorbOff + 0x00, true);
    const modSignal = dv.getUint32(vorbOff + 0x04, true);
    let modPackets = true;
    if (modSignal === 0x4a || modSignal === 0x4b || modSignal === 0x69 || modSignal === 0x70) modPackets = false;
    const setupPacketOffset = dv.getUint32(vorbOff + 0x10, true);
    const firstAudioPacketOffset = dv.getUint32(vorbOff + 0x14, true);
    const blocksize0Pow = bytes[vorbOff + 0x28];
    const blocksize1Pow = bytes[vorbOff + 0x29];

    return {
      dv, bytes, channels, sampleRate, avgBytes, dataOff, dataSize,
      sampleCount, modPackets, setupPacketOffset, firstAudioPacketOffset,
      blocksize0Pow, blocksize1Pow, noGranule: true,
    };
  }

  // 2-byte packet header (no granule)
  function readPacket(dv, offset) {
    const size = dv.getUint16(offset, true);
    return { size, payloadOffset: offset + 2, nextOffset: offset + 2 + size };
  }

  function generateHeader(w, info, codebooks, modeInfo) {
    const { channels, sampleRate, avgBytes, dataOff, setupPacketOffset, firstAudioPacketOffset, blocksize0Pow, blocksize1Pow } = info;
    const dv = info.dv;

    // identification packet
    w.write(1, 8);
    for (const c of "vorbis") w.write(c.charCodeAt(0), 8);
    w.write(0, 32);                 // version
    w.write(channels, 8);
    w.write(sampleRate, 32);
    w.write(0, 32);                 // bitrate max
    w.write((avgBytes * 8) >>> 0, 32); // bitrate nominal
    w.write(0, 32);                 // bitrate min
    w.write(blocksize0Pow, 4);
    w.write(blocksize1Pow, 4);
    w.write(1, 1);                  // framing
    w.flushPage();

    // comment packet
    w.write(3, 8);
    for (const c of "vorbis") w.write(c.charCodeAt(0), 8);
    const vendor = "converted from Audiokinetic Wwise (in-browser)";
    w.write(vendor.length, 32);
    for (let i = 0; i < vendor.length; i++) w.write(vendor.charCodeAt(i), 8);
    w.write(0, 32);                 // user comment count
    w.write(1, 1);                  // framing
    w.flushPage();

    // setup packet (stripped, external codebooks)
    w.write(5, 8);
    for (const c of "vorbis") w.write(c.charCodeAt(0), 8);

    const setupPkt = readPacket(dv, dataOff + setupPacketOffset);
    const ss = new BitReader(info.bytes, setupPkt.payloadOffset);

    const codebookCountLess1 = ss.read(8);
    const codebookCount = codebookCountLess1 + 1;
    w.write(codebookCountLess1, 8);

    const cbl = new CodebookLibrary(codebooks);
    for (let i = 0; i < codebookCount; i++) {
      const id = ss.read(10);
      cbl.rebuild(id, w);
    }

    // time domain transforms placeholder
    w.write(0, 6);
    w.write(0, 16);

    // floors
    const floorCountLess1 = ss.read(6);
    const floorCount = floorCountLess1 + 1;
    w.write(floorCountLess1, 6);
    for (let i = 0; i < floorCount; i++) {
      w.write(1, 16); // floor type 1
      const partitions = ss.read(5); w.write(partitions, 5);
      const partitionClassList = new Array(partitions);
      let maxClass = 0;
      for (let j = 0; j < partitions; j++) {
        const pc = ss.read(4); w.write(pc, 4);
        partitionClassList[j] = pc;
        if (pc > maxClass) maxClass = pc;
      }
      const classDims = new Array(maxClass + 1);
      for (let j = 0; j <= maxClass; j++) {
        const dimLess1 = ss.read(3); w.write(dimLess1, 3);
        classDims[j] = dimLess1 + 1;
        const subclasses = ss.read(2); w.write(subclasses, 2);
        if (subclasses !== 0) { const mb = ss.read(8); w.write(mb, 8); }
        for (let k = 0; k < (1 << subclasses); k++) { const sb = ss.read(8); w.write(sb, 8); }
      }
      const multLess1 = ss.read(2); w.write(multLess1, 2);
      const rangebits = ss.read(4); w.write(rangebits, 4);
      for (let j = 0; j < partitions; j++) {
        const cls = partitionClassList[j];
        for (let k = 0; k < classDims[cls]; k++) { const X = ss.read(rangebits); w.write(X, rangebits); }
      }
    }

    // residues
    const residueCountLess1 = ss.read(6);
    const residueCount = residueCountLess1 + 1;
    w.write(residueCountLess1, 6);
    for (let i = 0; i < residueCount; i++) {
      const residueType = ss.read(2);
      w.write(residueType, 16);
      if (residueType > 2) throw new Error("invalid residue type");
      const begin = ss.read(24), end = ss.read(24), partSizeLess1 = ss.read(24);
      const classifLess1 = ss.read(6), classbook = ss.read(8);
      const classifications = classifLess1 + 1;
      w.write(begin, 24); w.write(end, 24); w.write(partSizeLess1, 24); w.write(classifLess1, 6); w.write(classbook, 8);
      const cascade = new Array(classifications);
      for (let j = 0; j < classifications; j++) {
        let highBits = 0;
        const lowBits = ss.read(3); w.write(lowBits, 3);
        const bitflag = ss.read(1); w.write(bitflag, 1);
        if (bitflag) { highBits = ss.read(5); w.write(highBits, 5); }
        cascade[j] = highBits * 8 + lowBits;
      }
      for (let j = 0; j < classifications; j++) {
        for (let k = 0; k < 8; k++) {
          if (cascade[j] & (1 << k)) { const rb = ss.read(8); w.write(rb, 8); }
        }
      }
    }

    // mappings
    const mappingCountLess1 = ss.read(6);
    const mappingCount = mappingCountLess1 + 1;
    w.write(mappingCountLess1, 6);
    for (let i = 0; i < mappingCount; i++) {
      w.write(0, 16); // mapping type 0
      const submapsFlag = ss.read(1); w.write(submapsFlag, 1);
      let submaps = 1;
      if (submapsFlag) { const sl = ss.read(4); submaps = sl + 1; w.write(sl, 4); }
      const squarePolar = ss.read(1); w.write(squarePolar, 1);
      if (squarePolar) {
        const couplingLess1 = ss.read(8); const couplingSteps = couplingLess1 + 1; w.write(couplingLess1, 8);
        const bits = ilog(channels - 1);
        for (let j = 0; j < couplingSteps; j++) {
          const mag = ss.read(bits), ang = ss.read(bits);
          w.write(mag, bits); w.write(ang, bits);
        }
      }
      const reserved = ss.read(2); w.write(reserved, 2);
      if (reserved !== 0) throw new Error("mapping reserved nonzero");
      if (submaps > 1) {
        for (let j = 0; j < channels; j++) { const mux = ss.read(4); w.write(mux, 4); }
      }
      for (let j = 0; j < submaps; j++) {
        const tc = ss.read(8); w.write(tc, 8);
        const fn = ss.read(8); w.write(fn, 8);
        const rn = ss.read(8); w.write(rn, 8);
      }
    }

    // modes
    const modeCountLess1 = ss.read(6);
    const modeCount = modeCountLess1 + 1;
    w.write(modeCountLess1, 6);
    modeInfo.blockflag = new Array(modeCount);
    modeInfo.bits = ilog(modeCount - 1);
    for (let i = 0; i < modeCount; i++) {
      const blockFlag = ss.read(1); w.write(blockFlag, 1);
      modeInfo.blockflag[i] = blockFlag;
      w.write(0, 16); // windowtype
      w.write(0, 16); // transformtype
      const mapping = ss.read(8); w.write(mapping, 8);
    }
    w.write(1, 1); // framing
    w.flushPage();
  }

  function convert(wemBytes, codebooks, opts) {
    const computeGranule = !opts || opts.computeGranule !== false;
    const info = parseWem(wemBytes);
    const dv = info.dv;
    const w = new OggWriter();
    const modeInfo = { blockflag: null, bits: 0 };
    generateHeader(w, info, codebooks, modeInfo);

    const bs0 = 1 << info.blocksize0Pow;
    const bs1 = 1 << info.blocksize1Pow;
    let granpos = 0;
    let lastBs = 0;
    let prevBlockflag = 0;

    const dataEnd = info.dataOff + info.dataSize;
    let offset = info.dataOff + info.firstAudioPacketOffset;

    while (offset < dataEnd) {
      const pkt = readPacket(dv, offset);
      const size = pkt.size;
      const payloadOffset = pkt.payloadOffset;
      const nextOffset = pkt.nextOffset;
      if (payloadOffset > dataEnd) throw new Error("packet header truncated");

      // determine this packet's window (long/short) from its mode number
      let modeNumber = 0;
      let blockflag = 0;
      if (info.modPackets) {
        const ss = new BitReader(info.bytes, payloadOffset);
        modeNumber = ss.read(modeInfo.bits);
        blockflag = modeInfo.blockflag[modeNumber];
      }

      // ---- write packet ----
      if (info.modPackets) {
        const ss = new BitReader(info.bytes, payloadOffset);
        w.write(0, 1); // packet type = audio
        const mn = ss.read(modeInfo.bits);
        w.write(mn, modeInfo.bits);
        const remainder = ss.read(8 - modeInfo.bits);
        if (modeInfo.blockflag[mn]) {
          // long window: peek next packet's blockflag
          let nextBlockflag = 0;
          if (nextOffset + 2 <= dataEnd) {
            const np = readPacket(dv, nextOffset);
            if (np.size > 0) {
              const ns = new BitReader(info.bytes, np.payloadOffset);
              const nmode = ns.read(modeInfo.bits);
              nextBlockflag = modeInfo.blockflag[nmode];
            }
          }
          w.write(prevBlockflag, 1);
          w.write(nextBlockflag, 1);
        }
        prevBlockflag = modeInfo.blockflag[mn];
        w.write(remainder, 8 - modeInfo.bits);
        // remaining bytes of packet (from payloadOffset+1)
        for (let i = 1; i < size; i++) w.write(info.bytes[payloadOffset + i], 8);
      } else {
        for (let i = 0; i < size; i++) w.write(info.bytes[payloadOffset + i], 8);
      }

      // ---- granule position (revorb-equivalent) ----
      if (computeGranule) {
        const bs = blockflag ? bs1 : bs0;
        if (lastBs) granpos += (lastBs + bs) / 4;
        lastBs = bs;
        w.setGranule(granpos >>> 0);
      } else {
        w.setGranule(0);
      }

      offset = nextOffset;
      w.flushPage(false, offset >= dataEnd);
    }

    return w.finish();
  }

  window.WemToOgg = { convert, parseWem };
})();
