// PDF 글꼴 교체: 내용 스트림의 글자 출력 연산자(Tj/TJ/'/")만 새 글꼴로 바꿔 쓴다.
// 글자 위치(원래 글자 폭), 색, 겹침 순서, 잘라내기, 투명도는 원본 그대로 유지된다.
import { parseContent, applyEdits, fmtNum, hexBytes, pdfName } from './pdf-lexer.js';
import { buildFontInfo } from './pdf-fonts.js';
import { pickSlot } from './classify.js';

const I = [1, 0, 0, 1, 0, 0];
export const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ITALIC_SKEW = Math.tan((11 * Math.PI) / 180);

// 새 글꼴에 없는 글자를 비슷한 글자로
const SUBST = new Map([
  [0x2010, [0x2d]], [0x2011, [0x2d]], [0x00ad, [0x2d]], [0x00a0, [0x20]], [0x202f, [0x20]], [0x2007, [0x20]], [0x2009, [0x20]],
  [0x200a, [0x20]], [0x2002, [0x20]], [0x2003, [0x20]], [0x00b7, [0x2219, 0x22c5, 0x30fb, 0x2027]], [0x2219, [0x00b7, 0x22c5]],
  [0x2027, [0x00b7]], [0x2212, [0x2013, 0x2d]], [0xfeff, [0x20]],
]);

function isPUA(cp) { return (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000; }

export class NewFontSet {
  /** @param fonts {gR,gB,bR,bB} → {font: mupdf.Font, label} */
  constructor(mupdf, doc, fonts) {
    this.mupdf = mupdf;
    this.doc = doc;
    this.fonts = fonts;
    this.refs = {};
    this.cache = { gR: new Map(), gB: new Map(), bR: new Map(), bB: new Map() };
    this.adv = { gR: new Map(), gB: new Map(), bR: new Map(), bB: new Map() };
  }
  has(key) { return !!this.fonts[key]; }
  resolveKey(key) {
    // 슬롯 글꼴이 없으면 같은 계열 다른 굵기 → 다른 계열
    if (this.fonts[key]) return key;
    const alt = [key[0] + (key[1] === 'B' ? 'R' : 'B'), (key[0] === 'g' ? 'b' : 'g') + key[1], (key[0] === 'g' ? 'b' : 'g') + (key[1] === 'B' ? 'R' : 'B')];
    return alt.find((k) => this.fonts[k]) || null;
  }
  gid(key, cp) {
    const c = this.cache[key];
    let g = c.get(cp);
    if (g === undefined) {
      g = this.fonts[key].font.encodeCharacter(cp) || 0;
      c.set(cp, g);
    }
    return g;
  }
  advance(key, gid) {
    const c = this.adv[key];
    let a = c.get(gid);
    if (a === undefined) { a = this.fonts[key].font.advanceGlyph(gid, 0); c.set(gid, a); }
    return a;
  }
  // 자원 사전에는 자리표시 객체를 넣어 두고, 마지막에 줄인(subset) 글꼴로 채운다.
  ref(key) {
    if (!this.refs[key]) this.refs[key] = this.doc.addObject(this.doc.newDictionary());
    return this.refs[key];
  }
  note(key, cps, gids) {
    if (!this.used) this.used = {};
    const u = this.used[key] || (this.used[key] = { cps: new Set(), gids: new Set() });
    for (const c of cps) u.cps.add(c);
    for (const g of gids) u.gids.add(g);
  }
  /** subsetFn(bytes, unicodes, gids) → Uint8Array|null */
  finalize(subsetFn) {
    const sizes = {};
    for (const key of Object.keys(this.refs)) {
      const f = this.fonts[key];
      const u = (this.used && this.used[key]) || { cps: new Set(), gids: new Set() };
      let font = f.font;
      let bytes = null;
      if (subsetFn && f.bytes) {
        try { bytes = subsetFn(f.bytes, u.cps, u.gids); } catch (e) { bytes = null; }
        if (bytes) {
          try {
            const sf = new this.mupdf.Font(f.psname || 'Font', bytes);
            // 줄인 글꼴에서도 같은 글리프 번호인지 확인
            let ok = true;
            for (const cp of [...u.cps].slice(0, 50)) if (sf.encodeCharacter(cp) !== font.encodeCharacter(cp)) { ok = false; break; }
            if (ok) font = sf; else bytes = null;
          } catch (e) { bytes = null; }
        }
      }
      const real = this.doc.addFont(font);
      this.refs[key].writeObject(real.resolve());
      sizes[key] = bytes ? bytes.length : f.bytes ? f.bytes.length : 0;
    }
    return sizes;
  }
  /** 문자열 u를 슬롯 key 글꼴 글리프로. 없으면 다른 계열로, 그래도 없으면 null */
  map(u, key) {
    if (!u) return null;
    const cps = Array.from(u, (ch) => ch.codePointAt(0));
    for (const cp of cps) if (cp < 0x20 || isPUA(cp) || cp === 0xfffd) return null;
    const order = [key, (key[0] === 'g' ? 'b' : 'g') + key[1]].filter((k) => this.fonts[k]);
    for (const k of order) {
      const gids = [];
      let ok = true;
      for (const cp of cps) {
        let g = this.gid(k, cp);
        if (!g && SUBST.has(cp)) for (const s of SUBST.get(cp)) { g = this.gid(k, s); if (g) break; }
        if (!g) { ok = false; break; }
        gids.push(g);
      }
      if (ok) {
        let adv = 0;
        for (const g of gids) adv += this.advance(k, g);
        this.note(k, cps, gids);
        return { key: k, gids, adv };
      }
    }
    return null;
  }
}

/**
 * 문서 전체 글꼴 교체.
 * options: { mode:'keep'|'body'|'all-b'|'all-g', keepMono, italic:true, overrides: {fontName: 'gothic'|'batang'|'keep'|'auto'} }
 */
export class PdfFontSwapper {
  constructor(mupdf, doc, newFonts, options = {}) {
    this.mupdf = mupdf;
    this.doc = doc;
    this.nf = newFonts;
    this.opt = { mode: 'keep', keepMono: true, italic: true, overrides: {}, ...options };
    this.fontInfoCache = new Map(); // objnum → info
    this.fontStats = new Map(); // key → stat
    this.formsDone = new Set();
    this.pageStats = [];
    this.globalSizes = new Map();
  }

  fontInfo(resFonts, resName) {
    if (!resFonts || resFonts.isNull()) return null;
    const ref = resFonts.get(resName);
    if (!ref || ref.isNull()) return null;
    const key = ref.isIndirect() ? 'o' + ref.asIndirect() : null;
    if (key && this.fontInfoCache.has(key)) return this.fontInfoCache.get(key);
    let info;
    try { info = buildFontInfo(this.mupdf, ref); } catch (e) { info = { ok: false, reason: '글꼴 해석 오류', name: resName, cls: { family: 'unknown', bold: false, italic: false } }; }
    info.id = key || 'd' + Math.random().toString(36).slice(2);
    if (key) this.fontInfoCache.set(key, info);
    if (!this.fontStats.has(info.id)) {
      this.fontStats.set(info.id, {
        name: info.name || resName, family: info.cls.family, bold: info.cls.bold, italic: info.cls.italic,
        ok: info.ok, reason: info.reason, embedded: info.embedded, glyphs: 0, replaced: 0, kept: 0, slots: {},
      });
    }
    return info;
  }

  slotFor(info, heading) {
    if (!info.ok) return null;
    const ov = this.opt.overrides[info.name];
    const s = pickSlot(info.cls, { mode: this.opt.mode, heading, keepMono: this.opt.keepMono, override: ov });
    return s ? this.nf.resolveKey(s) : null;
  }

  // 한 내용 스트림을 훑는다. onText(op, st, info, items) → 바꿀 문자열 | null
  walk(ops, resources, onText, onDo) {
    const resFonts = resources && !resources.isNull() ? resources.get('Font') : null;
    let gs = { font: null, Tfs: 0, Tc: 0, Tw: 0, Th: 1, TL: 0, Tr: 0, Ts: 0, ctm: I };
    const stack = [];
    let tm = I, tlm = I, lineX = 0;
    const edits = [];
    const td = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; lineX = 0; };
    for (const op of ops) {
      const a = op.args;
      switch (op.op) {
        case 'q': stack.push({ ...gs }); break;
        case 'Q': if (stack.length) gs = stack.pop(); break;
        case 'cm': if (a.length >= 6) gs.ctm = mul(a.slice(-6), gs.ctm); break;
        case 'BT': tm = I; tlm = I; lineX = 0; break;
        case 'Tf': if (a.length >= 2 && a[0].t === 'name') { gs.font = a[0].v; gs.Tfs = +a[1] || 0; } break;
        case 'Tc': gs.Tc = +a[0] || 0; break;
        case 'Tw': gs.Tw = +a[0] || 0; break;
        case 'Tz': gs.Th = (+a[0] || 0) / 100; break;
        case 'TL': gs.TL = +a[0] || 0; break;
        case 'Tr': gs.Tr = +a[0] || 0; break;
        case 'Ts': gs.Ts = +a[0] || 0; break;
        case 'Td': td(+a[0] || 0, +a[1] || 0); break;
        case 'TD': gs.TL = -(+a[1] || 0); td(+a[0] || 0, +a[1] || 0); break;
        case 'Tm': if (a.length >= 6) { tm = tlm = a.slice(-6).map(Number); lineX = 0; } break;
        case 'T*': td(0, -gs.TL); break;
        case 'Tj': case 'TJ': case "'": case '"': {
          if (op.op === "'") td(0, -gs.TL);
          if (op.op === '"') { gs.Tw = +a[0] || 0; gs.Tc = +a[1] || 0; td(0, -gs.TL); }
          const info = gs.font ? this.fontInfo(resFonts, gs.font) : null;
          let items = [];
          if (op.op === 'TJ') { if (a[0] && a[0].t === 'arr') items = a[0].v; }
          else { const s = a[a.length - 1]; if (s && s.t === 'str') items = [s]; }
          // 글자 단위로 펼치기
          const seq = [];
          let dx = 0;
          for (const it of items) {
            if (typeof it === 'number') { seq.push({ num: it }); dx += (-it / 1000) * gs.Tfs * gs.Th; continue; }
            if (!it || it.t !== 'str') continue;
            if (!info || !info.split) { seq.push({ raw: it.v }); continue; }
            for (const c of info.split(it.v)) {
              const w = info.width(c.code) || 0;
              const sp = info.singleByteSpace(c) ? gs.Tw : 0;
              seq.push({ c, w, sp });
              dx += ((w / 1000) * gs.Tfs + gs.Tc + sp) * gs.Th;
            }
          }
          const st = { ...gs, tm, tlm, lineX };
          const rep = info ? onText(op, st, info, seq) : null;
          if (rep != null) edits.push({ start: op.start, end: op.end, text: rep });
          lineX += dx;
          tm = mul([1, 0, 0, 1, lineX, 0], tlm);
          break;
        }
        case 'Do': if (onDo && a[0] && a[0].t === 'name') onDo(a[0].v, gs); break;
        default: break;
      }
    }
    return edits;
  }

  // 1단계: 크기 통계(제목 판별용)
  sizeStats(ops, resources) {
    const hist = new Map();
    this.walk(ops, resources, (op, st, info, seq) => {
      const M = mul(st.tm, st.ctm);
      const size = Math.abs(st.Tfs) * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
      let n = 0;
      for (const s of seq) if (s.c && s.c.code !== 32) n++;
      if (n && size > 0) {
        const k = Math.round(size * 2) / 2;
        hist.set(k, (hist.get(k) || 0) + n);
        this.globalSizes.set(k, (this.globalSizes.get(k) || 0) + n);
      }
      return null;
    });
    return hist;
  }

  static dominant(hist) {
    let best = 0, bestN = 0, total = 0;
    for (const [k, n] of hist) { total += n; if (n > bestN) { best = k; bestN = n; } }
    return { size: best, total };
  }

  // 2단계: 실제 교체
  rewrite(ops, resources, holderStats, bodySize) {
    const resFonts = resources && !resources.isNull() ? resources.get('Font') : null;
    const usedKeys = new Set();
    const self = this;
    const edits = this.walk(ops, resources, (op, st, info, seq) => {
      const stat = self.fontStats.get(info.id);
      let glyphs = 0;
      for (const s of seq) if (s.c) glyphs++;
      if (stat) stat.glyphs += glyphs;
      const keepAll = () => { if (stat) stat.kept += glyphs; holderStats.kept += glyphs; return null; };
      if (!info.ok || st.Tr >= 3 || !st.Tfs) {
        if (st.Tr === 3 || st.Tr === 7) holderStats.invisible += glyphs;
        return keepAll();
      }
      let heading = false;
      if (self.opt.mode === 'body' && bodySize > 0) {
        const M = mul(st.tm, st.ctm);
        const size = Math.abs(st.Tfs) * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
        heading = size >= bodySize * 1.28 && size >= bodySize + 3;
      }
      const slot = self.slotFor(info, heading);
      if (!slot) return keepAll();
      // 1) 글자 하나하나를 토큰으로: 원래 글꼴 유지 / 새 글꼴 / 숫자(위치 조정)
      const toks = [];
      let x = st.lineX;
      let replaced = 0, kept = 0;
      for (const s of seq) {
        if (s.num !== undefined) {
          const dx = (-s.num / 1000) * st.Tfs * st.Th;
          toks.push({ t: 'num', n: s.num, x0: x, dx });
          x += dx;
          continue;
        }
        if (s.raw) { toks.push({ t: 'orig', bytes: s.raw, x0: x, dx: 0 }); kept++; continue; }
        const dx = ((s.w / 1000) * st.Tfs + st.Tc + s.sp) * st.Th;
        const u = info.uni(s.c.code);
        const m = u ? self.nf.map(u, slot) : null;
        if (!m) { toks.push({ t: 'orig', bytes: s.c.bytes, x0: x, dx }); x += dx; kept++; continue; }
        toks.push({ t: 'new', key: m.key, gids: m.gids, adv: m.adv, w: s.w, sp: s.sp, space: /^\s+$/.test(u), x0: x, dx });
        x += dx;
        replaced++;
        usedKeys.add(m.key);
        if (stat) stat.slots[m.key] = (stat.slots[m.key] || 0) + 1;
      }
      if (stat) { stat.replaced += replaced; stat.kept += kept; }
      holderStats.replaced += replaced;
      holderStats.kept += kept;
      if (!replaced) return null;

      // 2) 묶기: 원래 글꼴 묶음 / 새 글꼴 낱말(띄어쓰기·큰 간격에서 끊음) / 공백 칸 / 간격
      const BIG = 180; // 이보다 큰 TJ 숫자는 띄어쓰기로 본다
      const units = [];
      let cur = null;
      const close = () => { cur = null; };
      for (let i = 0; i < toks.length; i++) {
        const tk = toks[i];
        if (tk.t === 'orig') {
          if (!cur || cur.t !== 'orig') { cur = { t: 'orig', items: [], x0: tk.x0 }; units.push(cur); }
          cur.items.push(tk); cur.x1 = tk.x0 + tk.dx;
          continue;
        }
        if (tk.t === 'num') {
          const nextNew = toks[i + 1] && toks[i + 1].t === 'new' && !toks[i + 1].space;
          if (cur && cur.t === 'word' && Math.abs(tk.n) < BIG && nextNew && toks[i + 1].key === cur.key) { cur.items.push(tk); cur.x1 = tk.x0 + tk.dx; continue; }
          if (cur && cur.t === 'orig') { cur.items.push(tk); cur.x1 = tk.x0 + tk.dx; continue; }
          units.push({ t: 'gap', items: [tk], x0: tk.x0, x1: tk.x0 + tk.dx });
          close();
          continue;
        }
        if (tk.space) { units.push({ t: 'cell', key: tk.key, items: [tk], x0: tk.x0, x1: tk.x0 + tk.dx }); close(); continue; }
        if (!cur || cur.t !== 'word' || cur.key !== tk.key) { cur = { t: 'word', key: tk.key, items: [], x0: tk.x0 }; units.push(cur); }
        cur.items.push(tk); cur.x1 = tk.x0 + tk.dx;
      }

      // 3) 쓰기
      const orig = pdfName(st.font);
      const size = fmtNum(st.Tfs);
      const out = [];
      if (op.op === "'") out.push('T*');
      if (op.op === '"') out.push(`${fmtNum(st.Tw)} Tw ${fmtNum(st.Tc)} Tc T*`);
      let curFont = orig;
      const setFont = (f) => { if (f !== curFont) { out.push(`${f} ${size} Tf`); curFont = f; } };
      const italic = self.opt.italic && info.cls.italic && st.Th !== 0;
      const k1 = 1000 / st.Tfs;
      const hex2 = (gids) => { const b = []; for (const g of gids) b.push(g >> 8, g & 255); return hexBytes(b); };
      const skewAt = (x0) => {
        const t = mul([1, 0, 0, 1, x0, 0], st.tlm);
        return `${fmtNum(t[0])} ${fmtNum(t[1])} ${fmtNum(ITALIC_SKEW * t[0] + t[2])} ${fmtNum(ITALIC_SKEW * t[1] + t[3])} ${fmtNum(t[4])} ${fmtNum(t[5])} Tm`;
      };
      const restoreAt = (x1) => `${st.tlm.map(fmtNum).join(' ')} Tm [${fmtNum((-x1 * 1000) / (st.Tfs * st.Th))}] TJ`;
      for (const u of units) {
        if (u.t === 'orig') {
          setFont(orig);
          const parts = [];
          for (const it of u.items) {
            if (it.t === 'num') parts.push(fmtNum(it.n));
            else if (parts.length && parts[parts.length - 1].startsWith('<')) parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1) + hexBytes(it.bytes).slice(1);
            else parts.push(hexBytes(it.bytes));
          }
          out.push('[' + parts.join(' ') + '] TJ');
          continue;
        }
        if (u.t === 'gap') { out.push(`[${fmtNum(u.items[0].n)}] TJ`); continue; }
        setFont(pdfName(self.resName(u.key)));
        const fake = st.Tr === 2;
        if (fake) out.push('0 Tr');
        if (italic) out.push(skewAt(u.x0));
        if (u.t === 'cell') {
          // 공백 등 한 칸: 원래 칸 가운데에 놓고 원래 폭만큼 진행
          const tk = u.items[0];
          const d = tk.w - tk.adv * 1000;
          out.push(`[${fmtNum(-d / 2)} ${hex2(tk.gids)} ${fmtNum(-d / 2 - tk.sp * k1 + (tk.gids.length - 1) * st.Tc * k1)}] TJ`);
        } else {
          // 낱말: 원래 폭에 맞추되 자간(최대 ±0.05em) → 장평(0.88~1.08) 순으로, 남는 건 낱말 끝 간격으로
          const gids = [];
          for (const it of u.items) if (it.t === 'new') gids.push(...it.gids);
          const W = u.x1 - u.x0;
          let base = 0;
          for (const it of u.items) if (it.t === 'new') for (const g of it.gids) base += (self.nf.advance(it.key, g) * st.Tfs + st.Tc) * st.Th;
          const n = gids.length;
          let ls = 0, sc = 1;
          if (n && st.Th) {
            const diff = W - base;
            ls = diff > 0 ? Math.min(diff / (n * st.Th), 0.05 * st.Tfs) : Math.max(diff / (n * st.Th), -0.03 * st.Tfs);
            const W1 = base + n * ls * st.Th;
            if (W1 > 0) sc = Math.min(1.08, Math.max(0.88, W / W1));
            const resid = W - W1 * sc;
            const thN = st.Th * sc;
            if (Math.abs(sc - 1) > 1e-4) out.push(`${fmtNum(thN * 100)} Tz`);
            if (Math.abs(ls) > 1e-6) out.push(`${fmtNum(st.Tc + ls)} Tc`);
            out.push(`[${hex2(gids)}${Math.abs(resid) > 1e-6 ? ' ' + fmtNum((-resid * 1000) / (st.Tfs * thN)) : ''}] TJ`);
            if (Math.abs(ls) > 1e-6) out.push(`${fmtNum(st.Tc)} Tc`);
            if (Math.abs(sc - 1) > 1e-4) out.push(`${fmtNum(st.Th * 100)} Tz`);
          }
        }
        if (italic) out.push(restoreAt(u.x1));
        if (fake) out.push('2 Tr');
      }
      setFont(orig);
      return out.join(' ');
    });
    // 새 글꼴을 자원 사전에 등록
    if (usedKeys.size) {
      let fonts = resources.get('Font');
      if (!fonts || fonts.isNull()) { fonts = this.doc.newDictionary(); resources.put('Font', fonts); fonts = resources.get('Font'); }
      for (const k of usedKeys) fonts.put(this.resName(k), this.nf.ref(k));
    }
    return edits;
  }

  resName(key) { return 'FSW' + key; }

  // 페이지 + 그 안의 폼 XObject들을 처리
  collectHolders(pageObj) {
    const holders = [];
    const resources = pageObj.getInheritable('Resources');
    holders.push({ kind: 'page', obj: pageObj, resources });
    const visit = (resObj, depth) => {
      if (depth > 12 || !resObj || resObj.isNull()) return;
      const xo = resObj.get('XObject');
      if (!xo || !xo.isDictionary()) return;
      xo.forEach((val) => {
        if (!val.isIndirect()) return;
        const num = val.asIndirect();
        if (this.formsDone.has(num)) return;
        if (!val.isStream() || val.get('Subtype').asName() !== 'Form') return;
        const r = val;
        this.formsDone.add(num);
        let res = r.get('Resources');
        if (!res || res.isNull()) res = resObj;
        holders.push({ kind: 'form', obj: val, resources: res });
        visit(res, depth + 1);
      });
    };
    visit(resources, 0);
    return holders;
  }

  static readContents(pageObj) {
    const c = pageObj.get('Contents');
    if (!c || c.isNull()) return new Uint8Array(0);
    const parts = [];
    if (c.isArray()) { for (let i = 0; i < c.length; i++) { const s = c.get(i); if (s.isStream()) parts.push(s.readStream().asUint8Array()); } }
    else if (c.isStream()) parts.push(c.readStream().asUint8Array());
    let n = 0;
    for (const p of parts) n += p.length + 1;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
    return out;
  }

  holderBytes(h) {
    if (h.kind === 'page') return PdfFontSwapper.readContents(h.obj);
    try { return h.obj.readStream().asUint8Array(); } catch (e) { return new Uint8Array(0); }
  }

  writeHolder(h, bytes) {
    if (h.kind === 'page') {
      const s = this.doc.addStream(bytes, this.doc.newDictionary());
      h.obj.put('Contents', s);
    } else {
      h.obj.writeStream(bytes);
    }
  }

  /** 전체 실행. progress(i, n) */
  run(progress) {
    const n = this.doc.countPages();
    const plan = [];
    // 1단계: 구조 수집 + (본문 모드일 때) 크기 통계
    for (let i = 0; i < n; i++) {
      const pageObj = this.doc.findPage(i);
      const holders = this.collectHolders(pageObj);
      for (const h of holders) {
        h.bytes = this.holderBytes(h);
        h.ops = parseContent(h.bytes);
        if (this.opt.mode === 'body') h.hist = this.sizeStats(h.ops, h.resources);
        else this.walk(h.ops, h.resources, () => null); // 글꼴 정보만 미리 수집
      }
      plan.push(holders);
      progress && progress(i + 1, n, 'scan');
    }
    const globalBody = PdfFontSwapper.dominant(this.globalSizes).size;
    // 2단계: 바꿔 쓰기
    for (let i = 0; i < n; i++) {
      const ps = { page: i, replaced: 0, kept: 0, invisible: 0 };
      for (const h of plan[i]) {
        let body = globalBody;
        if (h.hist) { const d = PdfFontSwapper.dominant(h.hist); if (d.total >= 40) body = d.size; }
        const edits = this.rewrite(h.ops, h.resources, ps, body);
        if (edits.length) this.writeHolder(h, applyEdits(h.bytes, edits));
        h.ops = null; h.bytes = null;
      }
      this.pageStats.push(ps);
      progress && progress(i + 1, n, 'rewrite');
    }
    return { pages: this.pageStats, fonts: [...this.fontStats.values()] };
  }
}
