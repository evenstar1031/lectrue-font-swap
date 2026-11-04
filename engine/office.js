// PPTX / DOCX 글꼴 교체 (XML 안의 글꼴 이름을 바꾼다)
import { classifyFont, pickSlot } from './classify.js';

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/package/2006/relationships',
};
const REL_LAYOUT = /\/slideLayout$/, REL_MASTER = /\/slideMaster$/, REL_THEME = /\/theme$/;

function kids(el, ns, name) {
  const out = [];
  if (!el) return out;
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.namespaceURI === ns && c.localName === name) out.push(c);
  return out;
}
const kid = (el, ns, name) => kids(el, ns, name)[0] || null;
function all(el, ns, name) { return el ? Array.from(el.getElementsByTagNameNS(ns, name)) : []; }
function path(el, steps) {
  let cur = el;
  for (const [ns, n] of steps) { cur = kid(cur, ns, n); if (!cur) return null; }
  return cur;
}

class XmlPart {
  constructor(env, name, text) {
    this.env = env; this.name = name; this.text = text;
    this.decl = (/^\s*<\?xml[^>]*\?>/.exec(text) || ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'])[0].trim();
    this.doc = new env.DOMParser().parseFromString(text, 'application/xml');
    this.dirty = false;
  }
  toString() {
    let s = new this.env.XMLSerializer().serializeToString(this.doc);
    if (!/^\s*<\?xml/.test(s)) s = this.decl + '\r\n' + s;
    return s;
  }
}

function relsOf(zip, partName) {
  const i = partName.lastIndexOf('/');
  return partName.slice(0, i) + '/_rels/' + partName.slice(i + 1) + '.rels';
}
function resolveTarget(partName, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = partName.split('/'); parts.pop();
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
}

/** 공통: 새 글꼴 정보 → 슬롯별 이름 */
function slotFace(meta, slot) { return meta[slot] ? meta[slot].family : null; }

// ---------------------------------------------------------------- PPTX
export async function convertPptx(env, bytes, meta, options = {}) {
  const { JSZip } = env;
  const opt = { mode: 'keep', keepMono: true, overrides: {}, ...options };
  const zip = await JSZip.loadAsync(bytes);
  const parts = new Map();
  const load = async (name) => {
    if (parts.has(name)) return parts.get(name);
    const f = zip.file(name);
    if (!f) return null;
    const p = new XmlPart(env, name, await f.async('string'));
    parts.set(name, p);
    return p;
  };
  const rels = async (name) => {
    const r = await load(relsOf(zip, name));
    if (!r) return [];
    return all(r.doc.documentElement, NS.r, 'Relationship').map((e) => ({ type: e.getAttribute('Type'), target: resolveTarget(name, e.getAttribute('Target')), mode: e.getAttribute('TargetMode') }));
  };
  const relTarget = async (name, re) => { const r = (await rels(name)).find((x) => re.test(x.type) && x.mode !== 'External'); return r ? r.target : null; };

  const stats = new Map(); // 원래 글꼴 이름 → {count, slot}
  const note = (name, slot, n = 1) => {
    const k = name || '(기본)';
    const s = stats.get(k) || { name: k, cls: classifyFont(k), count: 0, slots: {} };
    s.count += n;
    if (slot) s.slots[slot] = (s.slots[slot] || 0) + n;
    stats.set(k, s);
  };
  const decide = (face, bold, heading) => {
    const cls = { ...classifyFont(face), bold: !!bold };
    const slot = pickSlot(cls, { mode: opt.mode, heading, keepMono: opt.keepMono, override: opt.overrides[cls.name] });
    return slot && meta[slot] ? slot : null;
  };

  // 테마 (원래 이름 보관)
  const themeInfo = new Map();
  const readTheme = (p) => {
    if (themeInfo.has(p.name)) return themeInfo.get(p.name);
    const fs = all(p.doc.documentElement, NS.a, 'fontScheme')[0];
    const get = (which) => {
      const el = fs ? kid(fs, NS.a, which) : null;
      const o = { lt: '', ea: '', cs: '', scripts: {} };
      if (!el) return o;
      o.lt = (kid(el, NS.a, 'latin') || { getAttribute: () => '' }).getAttribute('typeface') || '';
      o.ea = (kid(el, NS.a, 'ea') || { getAttribute: () => '' }).getAttribute('typeface') || '';
      o.cs = (kid(el, NS.a, 'cs') || { getAttribute: () => '' }).getAttribute('typeface') || '';
      for (const f of kids(el, NS.a, 'font')) o.scripts[f.getAttribute('script')] = f.getAttribute('typeface');
      if (!o.ea) o.ea = o.scripts.Hang || o.scripts.Kore || '맑은 고딕';
      return o;
    };
    const info = { mj: get('majorFont'), mn: get('minorFont') };
    themeInfo.set(p.name, info);
    return info;
  };
  const themeFace = (theme, ref, script) => {
    // ref: '+mj-lt' / '+mn-ea' ...
    const m = /^\+(mj|mn)-(lt|ea|cs)$/.exec(ref);
    if (!m || !theme) return ref;
    return theme[m[1]][m[2]] || '';
  };

  // 마스터/레이아웃 체인
  const chainCache = new Map();
  const getChain = async (slideName) => {
    const layoutName = await relTarget(slideName, REL_LAYOUT);
    const layout = layoutName ? await load(layoutName) : null;
    const masterName = layoutName ? await relTarget(layoutName, REL_MASTER) : null;
    const key = masterName + '|' + layoutName;
    if (chainCache.has(key)) return chainCache.get(key);
    const master = masterName ? await load(masterName) : null;
    const themeName = masterName ? await relTarget(masterName, REL_THEME) : null;
    const themeP = themeName ? await load(themeName) : null;
    const c = { layout, master, theme: themeP ? readTheme(themeP) : null };
    chainCache.set(key, c);
    return c;
  };
  const pres = await load('ppt/presentation.xml');
  const defaultTextStyle = pres ? kid(pres.doc.documentElement, NS.p, 'defaultTextStyle') : null;

  const phOf = (sp) => {
    const nv = kid(sp, NS.p, 'nvSpPr') || kid(sp, NS.p, 'nvGraphicFramePr') || kid(sp, NS.p, 'nvPicPr');
    const nvPr = nv ? kid(nv, NS.p, 'nvPr') : null;
    const ph = nvPr ? kid(nvPr, NS.p, 'ph') : null;
    if (!ph) return null;
    return { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') };
  };
  const findPh = (part, ph) => {
    if (!part || !ph) return null;
    const sps = all(part.doc.documentElement, NS.p, 'sp');
    let byIdx = null, byType = null;
    for (const sp of sps) {
      const q = phOf(sp);
      if (!q) continue;
      if (ph.idx != null && q.idx === ph.idx) byIdx = byIdx || sp;
      const t1 = ph.type === 'ctrTitle' ? 'title' : ph.type === 'subTitle' ? 'body' : ph.type;
      const t2 = q.type === 'ctrTitle' ? 'title' : q.type === 'subTitle' ? 'body' : q.type;
      if (t1 === t2) byType = byType || sp;
    }
    return byIdx || byType;
  };
  const lvlDef = (lstStyle, lvl) => {
    if (!lstStyle) return null;
    const l = kid(lstStyle, NS.a, `lvl${lvl}pPr`);
    return l ? kid(l, NS.a, 'defRPr') : null;
  };
  const txStyle = (master, ph, inTable) => {
    if (!master) return null;
    const ts = path(master.doc.documentElement, [[NS.p, 'txStyles']]);
    if (!ts) return null;
    if (!ph || inTable) return kid(ts, NS.p, 'otherStyle');
    if (ph.type === 'title' || ph.type === 'ctrTitle') return kid(ts, NS.p, 'titleStyle');
    if (['body', 'subTitle', 'obj'].includes(ph.type) || ph.type == null) return kid(ts, NS.p, 'bodyStyle');
    return kid(ts, NS.p, 'otherStyle');
  };
  const effFrom = (chainEls, attrName, childName) => {
    for (const el of chainEls) {
      if (!el) continue;
      if (attrName) { const v = el.getAttribute(attrName); if (v != null && v !== '') return v; }
      if (childName) { const c = kid(el, NS.a, childName); if (c && c.getAttribute('typeface') != null) return c.getAttribute('typeface'); }
    }
    return null;
  };

  const RPR_ORDER = ['ln', 'noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'effectLst', 'effectDag', 'highlight', 'uLnTx', 'uLn', 'uFillTx', 'uFill', 'latin', 'ea', 'cs', 'sym', 'hlinkClick', 'hlinkMouseOver', 'rtl', 'extLst'];
  const setFace = (rPr, which, face) => {
    let el = kid(rPr, NS.a, which);
    if (!el) {
      el = rPr.ownerDocument.createElementNS(NS.a, 'a:' + which);
      const myIdx = RPR_ORDER.indexOf(which);
      let before = null;
      for (let c = rPr.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && RPR_ORDER.indexOf(c.localName) > myIdx) { before = c; break; }
      }
      rPr.insertBefore(el, before);
    }
    el.setAttribute('typeface', face);
    for (const a of ['panose', 'pitchFamily', 'charset']) el.removeAttribute(a);
  };

  let runsChanged = 0;
  // 슬라이드의 글자 단위(run) 처리
  const doSlide = async (slideName) => {
    const sp = await load(slideName);
    if (!sp) return;
    const chain = await getChain(slideName);
    const root = sp.doc.documentElement;
    const shapes = [...all(root, NS.p, 'sp'), ...all(root, NS.p, 'graphicFrame')];
    // 크기 통계 (본문 모드에서 큰 글씨 판별)
    const sizes = [];
    const jobs = [];
    for (const shape of shapes) {
      const ph = phOf(shape);
      const inTable = shape.localName === 'graphicFrame';
      const bodies = inTable ? all(shape, NS.a, 'txBody') : [kid(shape, NS.p, 'txBody')].filter(Boolean);
      const lph = findPh(chain.layout, ph), mph = findPh(chain.master, ph);
      const lLst = lph ? path(lph, [[NS.p, 'txBody'], [NS.a, 'lstStyle']]) : null;
      const mLst = mph ? path(mph, [[NS.p, 'txBody'], [NS.a, 'lstStyle']]) : null;
      const tStyle = txStyle(chain.master, ph, inTable);
      for (const body of bodies) {
        const lst = kid(body, NS.a, 'lstStyle');
        for (const p of kids(body, NS.a, 'p')) {
          const pPr = kid(p, NS.a, 'pPr');
          const lvl = (pPr && +pPr.getAttribute('lvl') || 0) + 1;
          const base = [lvlDef(lst, lvl), lvlDef(lLst, lvl), lvlDef(mLst, lvl), lvlDef(tStyle, lvl), lvlDef(defaultTextStyle, lvl)];
          const runs = [...kids(p, NS.a, 'r'), ...kids(p, NS.a, 'fld')];
          for (const r of runs) {
            let rPr = kid(r, NS.a, 'rPr');
            const chainEls = [rPr, ...base];
            const sz = +(effFrom(chainEls, 'sz') || 1800);
            const tEl = kid(r, NS.a, 't');
            const n = tEl && tEl.textContent ? tEl.textContent.length : 0;
            sizes.push([sz, n]);
            jobs.push({ r, chainEls, ph, sz, n });
          }
          const end = kid(p, NS.a, 'endParaRPr');
          if (end) jobs.push({ r: null, rPr: end, chainEls: [end, ...base], ph, sz: +(effFrom([end, ...base], 'sz') || 1800), n: 0 });
        }
      }
    }
    // 가장 흔한 크기
    const hist = new Map();
    for (const [s, n] of sizes) hist.set(s, (hist.get(s) || 0) + n);
    let body = 1800, best = -1;
    for (const [s, n] of hist) if (n > best) { best = n; body = s; }
    for (const j of jobs) {
      const bold = ['1', 'true'].includes(effFrom(j.chainEls, 'b') || '0');
      const heading = (j.ph && (j.ph.type === 'title' || j.ph.type === 'ctrTitle')) || (j.sz >= body * 1.35 && j.sz >= 2400);
      let rPr = j.r ? kid(j.r, NS.a, 'rPr') : j.rPr;
      const plan = {};
      for (const [which, child] of [['latin', 'latin'], ['ea', 'ea'], ['cs', 'cs']]) {
        let face = effFrom(j.chainEls, null, child) || (which === 'latin' ? '+mn-lt' : which === 'ea' ? '+mn-ea' : '+mn-cs');
        face = themeFace(chain.theme, face, which);
        if (which === 'cs' && !face) continue;
        const slot = decide(face, bold, heading);
        if (j.n) note(face, slot, j.n);
        if (slot) plan[which] = slot;
      }
      if (!Object.keys(plan).length) continue;
      if (!rPr) {
        rPr = j.r.ownerDocument.createElementNS(NS.a, 'a:rPr');
        j.r.insertBefore(rPr, j.r.firstChild);
      }
      for (const [which, slot] of Object.entries(plan)) setFace(rPr, which, slotFace(meta, slot));
      // 따로 된 굵은 글꼴(스타일 연결 안 됨)은 '굵게'를 끄지 않으면 이중으로 굵어진다
      const slots = Object.values(plan);
      if (bold && slots.length && slots.every((s) => s[1] === 'B' && meta[s] && !meta[s].styleLinkedBold)) rPr.setAttribute('b', '0');
      if (j.r) runsChanged++;
      sp.dirty = true;
    }
  };

  // 요소 단위 바꾸기 (마스터·레이아웃·노트·차트·스마트아트 등의 기본값)
  const newNames = new Set(Object.values(meta).filter(Boolean).map((m) => m.family));
  const doDefaults = (part, theme, isTitleish) => {
    const root = part.doc.documentElement;
    for (const which of ['latin', 'ea', 'cs']) {
      for (const el of all(root, NS.a, which)) {
        const parent = el.parentNode;
        if (!parent || parent.localName === 'majorFont' || parent.localName === 'minorFont') continue;
        let face = el.getAttribute('typeface');
        if (face == null || face === '' || face.startsWith('+') || newNames.has(face)) continue;
        const bold = ['1', 'true'].includes(parent.getAttribute && parent.getAttribute('b'));
        const slot = decide(face, bold, isTitleish(el));
        if (!slot) continue;
        el.setAttribute('typeface', slotFace(meta, slot));
        for (const a of ['panose', 'pitchFamily', 'charset']) el.removeAttribute(a);
        part.dirty = true;
      }
    }
  };
  const inTitleStyle = (el) => {
    for (let c = el; c; c = c.parentNode) if (c.localName === 'titleStyle') return true;
    return false;
  };

  // 1) 슬라이드
  const files = Object.keys(zip.files);
  const slides = files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  for (const s of slides) await doSlide(s);
  // 2) 나머지 XML (레이아웃·마스터·노트·차트·다이어그램)
  const others = files.filter((f) => /^ppt\/(slideLayouts|slideMasters|notesSlides|notesMasters|handoutMasters|charts|diagrams|slides)\/[^/]+\.xml$/.test(f) || f === 'ppt/presentation.xml');
  for (const f of others) {
    const p = await load(f);
    if (p) doDefaults(p, null, opt.mode === 'body' ? inTitleStyle : () => false);
  }
  // 3) 테마
  for (const f of files.filter((x) => /^ppt\/theme\/theme\d+\.xml$/.test(x))) {
    const p = await load(f);
    readTheme(p);
    const fsEl = all(p.doc.documentElement, NS.a, 'fontScheme')[0];
    if (!fsEl) continue;
    for (const which of ['majorFont', 'minorFont']) {
      const el = kid(fsEl, NS.a, which);
      if (!el) continue;
      const heading = which === 'majorFont';
      for (const t of ['latin', 'ea', 'cs']) {
        const c = kid(el, NS.a, t);
        let face = c ? c.getAttribute('typeface') : '';
        if (t === 'ea' && !face) face = themeInfo.get(f)[heading ? 'mj' : 'mn'].ea;
        if (!face) continue;
        const slot = decide(face, false, heading);
        if (!slot) continue;
        if (c) c.setAttribute('typeface', slotFace(meta, slot));
        for (const a of ['panose', 'pitchFamily', 'charset']) c && c.removeAttribute(a);
        p.dirty = true;
      }
      for (const f2 of kids(el, NS.a, 'font')) {
        const sc = f2.getAttribute('script');
        if (!['Hang', 'Hani', 'Kore', 'Jpan', 'Hans', 'Hant'].includes(sc)) continue;
        const slot = decide(f2.getAttribute('typeface'), false, heading);
        if (slot) { f2.setAttribute('typeface', slotFace(meta, slot)); p.dirty = true; }
      }
    }
  }
  for (const p of parts.values()) if (p.dirty) zip.file(p.name, p.toString());
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { bytes: out, report: { kind: 'pptx', slides: slides.length, runs: runsChanged, fonts: [...stats.values()] } };
}

// ---------------------------------------------------------------- DOCX
export async function convertDocx(env, bytes, meta, options = {}) {
  const { JSZip } = env;
  const opt = { mode: 'keep', keepMono: true, overrides: {}, ...options };
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.keys(zip.files);
  const parts = new Map();
  const load = async (name) => {
    if (parts.has(name)) return parts.get(name);
    const f = zip.file(name);
    if (!f) return null;
    const p = new XmlPart(env, name, await f.async('string'));
    parts.set(name, p);
    return p;
  };
  const W = NS.w;
  const wa = (el, n) => (el ? el.getAttributeNS(W, n) || el.getAttribute('w:' + n) : null);
  const setWa = (el, n, v) => el.setAttributeNS(W, 'w:' + n, v);
  const delWa = (el, n) => { el.removeAttributeNS(W, n); el.removeAttribute('w:' + n); };
  const onOff = (el) => { if (!el) return null; const v = wa(el, 'val'); return !(v === '0' || v === 'false' || v === 'off'); };

  // 테마 글꼴
  const theme = await load('word/theme/theme1.xml');
  const tf = { major: { latin: '', ea: '', cs: '' }, minor: { latin: '', ea: '', cs: '' } };
  if (theme) {
    const fsEl = all(theme.doc.documentElement, NS.a, 'fontScheme')[0];
    for (const [k, tag] of [['major', 'majorFont'], ['minor', 'minorFont']]) {
      const el = fsEl ? kid(fsEl, NS.a, tag) : null;
      if (!el) continue;
      for (const t of ['latin', 'ea', 'cs']) { const c = kid(el, NS.a, t); tf[k][t] = c ? c.getAttribute('typeface') || '' : ''; }
      if (!tf[k].ea) { const h = kids(el, NS.a, 'font').find((f) => f.getAttribute('script') === 'Hang'); tf[k].ea = h ? h.getAttribute('typeface') : '맑은 고딕'; }
    }
  }
  const themeName = (v) => {
    if (!v) return null;
    const major = /^major/.test(v);
    const t = /EastAsia/.test(v) ? 'ea' : /Bidi/.test(v) ? 'cs' : 'latin';
    return tf[major ? 'major' : 'minor'][t];
  };

  // 스타일
  const stylesP = await load('word/styles.xml');
  const styles = new Map();
  let defaults = null;
  if (stylesP) {
    const root = stylesP.doc.documentElement;
    const dd = kid(root, W, 'docDefaults');
    defaults = dd ? path(dd, [[W, 'rPrDefault'], [W, 'rPr']]) : null;
    for (const s of kids(root, W, 'style')) styles.set(wa(s, 'styleId'), s);
  }
  const styleChain = (id, seen = new Set()) => {
    const out = [];
    while (id && styles.has(id) && !seen.has(id)) {
      seen.add(id);
      const s = styles.get(id);
      out.push(kid(s, W, 'rPr'));
      const b = kid(s, W, 'basedOn');
      id = b ? wa(b, 'val') : null;
    }
    return out;
  };
  const headingStyle = (id) => {
    let cur = id;
    const seen = new Set();
    while (cur && styles.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      const s = styles.get(cur);
      const nm = (wa(kid(s, W, 'name'), 'val') || '').toLowerCase();
      if (/^(heading \d|title|subtitle)$/.test(nm) || /^(제목|부제)/.test(nm)) return true;
      if (path(s, [[W, 'pPr'], [W, 'outlineLvl']])) return true;
      const b = kid(s, W, 'basedOn');
      cur = b ? wa(b, 'val') : null;
    }
    return false;
  };
  const effFonts = (chain) => {
    const r = { ascii: null, eastAsia: null, cs: null, b: null };
    for (const rPr of chain) {
      if (!rPr) continue;
      const f = kid(rPr, W, 'rFonts');
      if (f) {
        if (r.ascii == null) r.ascii = themeName(wa(f, 'asciiTheme')) || wa(f, 'ascii');
        if (r.eastAsia == null) r.eastAsia = themeName(wa(f, 'eastAsiaTheme')) || wa(f, 'eastAsia');
        if (r.cs == null) r.cs = themeName(wa(f, 'cstheme')) || wa(f, 'cs');
      }
      if (r.b == null) { const b = kid(rPr, W, 'b'); if (b) r.b = onOff(b); }
    }
    if (!r.ascii) r.ascii = tf.minor.latin || 'Calibri';
    if (!r.eastAsia) r.eastAsia = tf.minor.ea || '맑은 고딕';
    return r;
  };

  const stats = new Map();
  const note = (name, slot, n) => {
    const k = name || '(기본)';
    const s = stats.get(k) || { name: k, cls: classifyFont(k), count: 0, slots: {} };
    s.count += n;
    if (slot) s.slots[slot] = (s.slots[slot] || 0) + n;
    stats.set(k, s);
  };
  const decide = (face, bold, heading) => {
    const cls = { ...classifyFont(face), bold: !!bold };
    const slot = pickSlot(cls, { mode: opt.mode, heading, keepMono: opt.keepMono, override: opt.overrides[cls.name] });
    return slot && meta[slot] ? slot : null;
  };
  const RPR_FIRST = ['rStyle'];
  const ensureRFonts = (rPr) => {
    let f = kid(rPr, W, 'rFonts');
    if (!f) {
      f = rPr.ownerDocument.createElementNS(W, 'w:rFonts');
      let before = rPr.firstChild;
      while (before && before.nodeType === 1 && RPR_FIRST.includes(before.localName)) before = before.nextSibling;
      while (before && before.nodeType !== 1) before = before.nextSibling;
      rPr.insertBefore(f, before && before.localName === 'rStyle' ? before.nextSibling : before);
    }
    return f;
  };
  const apply = (rPr, plan, bold) => {
    const f = ensureRFonts(rPr);
    if (plan.ascii) { setWa(f, 'ascii', meta[plan.ascii].family); setWa(f, 'hAnsi', meta[plan.ascii].family); delWa(f, 'asciiTheme'); delWa(f, 'hAnsiTheme'); }
    if (plan.eastAsia) { setWa(f, 'eastAsia', meta[plan.eastAsia].family); delWa(f, 'eastAsiaTheme'); }
    if (plan.cs) { setWa(f, 'cs', meta[plan.cs].family); delWa(f, 'cstheme'); }
    const slots = Object.values(plan);
    if (bold && slots.length && slots.every((s) => s[1] === 'B' && !meta[s].styleLinkedBold)) {
      let b = kid(rPr, W, 'b');
      if (!b) { b = rPr.ownerDocument.createElementNS(W, 'w:b'); const after = kid(rPr, W, 'rFonts'); rPr.insertBefore(b, after ? after.nextSibling : rPr.firstChild); }
      setWa(b, 'val', '0');
    }
  };

  let runsChanged = 0;
  const contentParts = files.filter((f) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(f));
  for (const name of contentParts) {
    const p = await load(name);
    const root = p.doc.documentElement;
    for (const para of all(root, W, 'p')) {
      const pPr = kid(para, W, 'pPr');
      const pStyle = pPr ? wa(kid(pPr, W, 'pStyle'), 'val') : null;
      const pChain = styleChain(pStyle || 'Normal');
      const heading = headingStyle(pStyle);
      for (const r of kids(para, W, 'r').concat(all(para, W, 'hyperlink').flatMap((h) => kids(h, W, 'r')))) {
        let rPr = kid(r, W, 'rPr');
        const rStyle = rPr ? wa(kid(rPr, W, 'rStyle'), 'val') : null;
        const chain = [rPr, ...styleChain(rStyle), ...pChain, defaults];
        const e = effFonts(chain);
        const t = all(r, W, 't').map((x) => x.textContent).join('');
        const n = t.length;
        if (!n) continue;
        const plan = {};
        const sA = decide(e.ascii, e.b, heading); note(e.ascii, sA, n); if (sA) plan.ascii = sA;
        const sE = decide(e.eastAsia, e.b, heading); if (/[ㄱ-힣一-鿿]/.test(t)) note(e.eastAsia, sE, n); if (sE) plan.eastAsia = sE;
        if (e.cs) { const sC = decide(e.cs, e.b, heading); if (sC) plan.cs = sC; }
        if (!Object.keys(plan).length) continue;
        if (!rPr) { rPr = p.doc.createElementNS(W, 'w:rPr'); r.insertBefore(rPr, r.firstChild); }
        apply(rPr, plan, e.b);
        runsChanged++;
        p.dirty = true;
      }
    }
  }
  // 스타일·기본값
  if (stylesP) {
    const targets = [defaults, ...[...styles.values()].map((s) => kid(s, W, 'rPr'))].filter(Boolean);
    for (const rPr of targets) {
      const f = kid(rPr, W, 'rFonts');
      if (!f) continue;
      const style = rPr.parentNode && rPr.parentNode.localName === 'style' ? rPr.parentNode : null;
      const heading = style ? headingStyle(wa(style, 'styleId')) : false;
      const bold = onOff(kid(rPr, W, 'b'));
      const plan = {};
      for (const [k, th] of [['ascii', 'asciiTheme'], ['eastAsia', 'eastAsiaTheme'], ['cs', 'cstheme']]) {
        const face = wa(f, th) ? null : wa(f, k);
        if (!face) continue;
        const s = decide(face, bold, heading);
        if (s) plan[k] = s;
      }
      if (Object.keys(plan).length) { apply(rPr, plan, bold); stylesP.dirty = true; }
    }
  }
  // 테마
  if (theme) {
    const fsEl = all(theme.doc.documentElement, NS.a, 'fontScheme')[0];
    for (const [k, tag] of [['major', 'majorFont'], ['minor', 'minorFont']]) {
      const el = fsEl ? kid(fsEl, NS.a, tag) : null;
      if (!el) continue;
      for (const t of ['latin', 'ea', 'cs']) {
        const c = kid(el, NS.a, t);
        const face = tf[k][t];
        if (!c || !face) continue;
        const s = decide(face, false, k === 'major');
        if (s) { c.setAttribute('typeface', meta[s].family); theme.dirty = true; }
      }
      for (const f2 of kids(el, NS.a, 'font')) {
        if (!['Hang', 'Hani', 'Kore'].includes(f2.getAttribute('script'))) continue;
        const s = decide(f2.getAttribute('typeface'), false, k === 'major');
        if (s) { f2.setAttribute('typeface', meta[s].family); theme.dirty = true; }
      }
    }
  }
  for (const p of parts.values()) if (p.dirty) zip.file(p.name, p.toString());
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { bytes: out, report: { kind: 'docx', runs: runsChanged, fonts: [...stats.values()] } };
}
