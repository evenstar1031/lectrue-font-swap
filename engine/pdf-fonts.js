// PDF 글꼴 사전(font dict) 해석: 코드 나누기, 코드→유니코드, 코드→글자 폭(1/1000 em)
import { parseContent } from './pdf-lexer.js';
import { classifyFont, decodeFontName } from './classify.js';

// ---- 인코딩 표 ----
const AGL = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  quoteright: '’', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', colon: ':',
  semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`', quoteleft: '‘', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  bullet: '•', endash: '–', emdash: '—', ellipsis: '…', quotedblleft: '“', quotedblright: '”',
  quotesinglbase: '‚', quotedblbase: '„', dagger: '†', daggerdbl: '‡', perthousand: '‰', trademark: '™',
  copyright: '©', registered: '®', degree: '°', plusminus: '±', multiply: '×', divide: '÷', mu: 'µ',
  micro: 'µ', periodcentered: '·', middot: '·', section: '§', paragraph: '¶', cent: '¢', sterling: '£',
  yen: '¥', Euro: '€', euro: '€', minus: '−', fraction: '⁄', onehalf: '½', onequarter: '¼',
  threequarters: '¾', twosuperior: '²', threesuperior: '³', onesuperior: '¹', ordfeminine: 'ª', ordmasculine: 'º',
  guillemotleft: '«', guillemotright: '»', guilsinglleft: '‹', guilsinglright: '›', exclamdown: '¡',
  questiondown: '¿', logicalnot: '¬', brokenbar: '¦', dieresis: '¨', macron: '¯', acute: '´',
  cedilla: '¸', circumflex: 'ˆ', tilde: '˜', breve: '˘', dotaccent: '˙', ring: '˚', hungarumlaut: '˝',
  ogonek: '˛', caron: 'ˇ', fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ', dotlessi: 'ı',
  germandbls: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', oslash: 'ø', Oslash: 'Ø', lslash: 'ł',
  Lslash: 'Ł', eth: 'ð', Eth: 'Ð', thorn: 'þ', Thorn: 'Þ', nbspace: ' ', nonbreakingspace: ' ',
  sfthyphen: '­', softhyphen: '­', florin: 'ƒ', arrowright: '→', arrowleft: '←', arrowup: '↑',
  arrowdown: '↓', arrowboth: '↔', arrowdblright: '⇒', arrowdblleft: '⇐', arrowdblboth: '⇔', infinity: '∞',
  lessequal: '≤', greaterequal: '≥', notequal: '≠', approxequal: '≈', similar: '∼', proportional: '∝',
  partialdiff: '∂', summation: '∑', product: '∏', radical: '√', integral: '∫', Delta: 'Δ', Omega: 'Ω',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Alpha: 'Α',
  Beta: 'Β', Gamma: 'Γ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ',
  lozenge: '◊', circle: '○', filledbox: '■', H18533: '●', H18543: '▪', H18551: '▫', triagrt: '►',
  checkmark: '✓', uni00A0: ' ',
};
// Latin-1 악센트 글자 이름 (Aacute 등)
const ACC = { acute: '́', grave: '̀', circumflex: '̂', tilde: '̃', dieresis: '̈', ring: '̊', cedilla: '̧', caron: '̌' };

export function glyphNameToUnicode(name) {
  if (!name) return null;
  if (AGL[name] !== undefined) return AGL[name];
  const base = name.split('.')[0].split('_')[0];
  if (AGL[base] !== undefined) return AGL[base];
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(base);
  if (m) {
    let s = '';
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  if (/^[A-Za-z]$/.test(base)) return base;
  m = /^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|ring|cedilla|caron)$/.exec(base);
  if (m) return (m[1] + ACC[m[2]]).normalize('NFC');
  return null;
}

let _cp1252, _macRoman;
function decodeSingle(enc, code) {
  if (enc === 'MacRomanEncoding') {
    if (!_macRoman) { try { _macRoman = new TextDecoder('macintosh'); } catch (e) { _macRoman = null; } }
    if (code < 128) return String.fromCharCode(code);
    return _macRoman ? _macRoman.decode(Uint8Array.of(code)) : null;
  }
  if (enc === 'StandardEncoding') {
    if (code === 0x27) return '’';
    if (code === 0x60) return '‘';
    if (code < 128) return String.fromCharCode(code);
    const STD = { 0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa5: '¥', 0xa7: '§', 0xa9: "'", 0xaa: '“', 0xab: '«', 0xae: 'ﬁ', 0xaf: 'ﬂ', 0xb1: '–', 0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿', 0xd0: '—', 0xe1: 'Æ', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß' };
    return STD[code] || null;
  }
  // WinAnsiEncoding (기본)
  if (!_cp1252) _cp1252 = new TextDecoder('windows-1252');
  if (code < 32) return null;
  if (code === 0x7f) return null;
  if (code === 0xa0) return ' ';
  if (code === 0xad) return '-';
  return _cp1252.decode(Uint8Array.of(code));
}

// ---- CMap 해석 (ToUnicode / 내장 Encoding CMap) ----
function bytesToInt(b) { let v = 0; for (const x of b) v = v * 256 + x; return v; }
function utf16be(b) {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]);
  return s;
}

export function parseCMap(bytes) {
  const ops = parseContent(bytes);
  const res = { codespace: [], uni: new Map(), cid: [], cidchar: new Map(), usecmap: null };
  for (let k = 0; k < ops.length; k++) {
    const { op, args } = ops[k];
    if (op === 'endcodespacerange') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const lo = args[i].v, hi = args[i + 1].v;
        if (lo && hi) res.codespace.push({ n: lo.length, lo: Array.from(lo), hi: Array.from(hi) });
      }
    } else if (op === 'endbfchar') {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const src = args[i], dst = args[i + 1];
        if (src && src.v && dst) res.uni.set(bytesToInt(src.v), dst.t === 'name' ? (glyphNameToUnicode(dst.v) || '') : utf16be(dst.v));
      }
    } else if (op === 'endbfrange') {
      for (let i = 0; i + 2 < args.length; i += 3) {
        const lo = bytesToInt(args[i].v), hi = bytesToInt(args[i + 1].v), dst = args[i + 2];
        if (hi - lo > 65535) continue;
        if (dst.t === 'arr') {
          for (let c = lo, j = 0; c <= hi && j < dst.v.length; c++, j++) if (dst.v[j].v) res.uni.set(c, utf16be(dst.v[j].v));
        } else if (dst.v) {
          const d = Array.from(dst.v);
          for (let c = lo; c <= hi; c++) {
            res.uni.set(c, utf16be(d));
            // 마지막 바이트 증가 (올림 포함)
            for (let p = d.length - 1; p >= 0; p--) { if (d[p] < 255) { d[p]++; break; } d[p] = 0; }
          }
        }
      }
    } else if (op === 'endcidrange') {
      for (let i = 0; i + 2 < args.length; i += 3) {
        if (args[i].v && args[i + 1].v) res.cid.push({ lo: bytesToInt(args[i].v), hi: bytesToInt(args[i + 1].v), n: args[i].v.length, cid: args[i + 2] });
      }
    } else if (op === 'endcidchar') {
      for (let i = 0; i + 1 < args.length; i += 2) if (args[i].v) res.cidchar.set(bytesToInt(args[i].v), args[i + 1]);
    } else if (op === 'usecmap') {
      const a = args[args.length - 1];
      if (a && a.t === 'name') res.usecmap = a.v;
    }
  }
  return res;
}

function splitWithCodespace(bytes, ranges) {
  const out = [];
  let i = 0;
  const lens = [...new Set(ranges.map((r) => r.n))].sort((a, b) => a - b);
  while (i < bytes.length) {
    let took = 0;
    for (const n of lens) {
      if (i + n > bytes.length) continue;
      for (const r of ranges) {
        if (r.n !== n) continue;
        let ok = true;
        for (let k = 0; k < n; k++) { const b = bytes[i + k]; if (b < r.lo[k] || b > r.hi[k]) { ok = false; break; } }
        if (ok) { took = n; break; }
      }
      if (took) break;
    }
    if (!took) took = Math.min(lens[0] || 1, bytes.length - i);
    out.push({ code: bytesToInt(bytes.subarray(i, i + took)), n: took, bytes: bytes.subarray(i, i + took) });
    i += took;
  }
  return out;
}

const KOREAN_CMAPS = /^(KSC|KSCms|KSCpc|UniKS)/;

function nameOf(o) { return o && o.isName() ? o.asName() : null; }
function num(o, d = 0) { return o && o.isNumber() ? o.asNumber() : d; }

function readStreamBytes(o) {
  try { return o.readStream().asUint8Array(); } catch (e) { return null; }
}

/**
 * 폰트 사전 → 정보 객체
 *  - split(bytes) → [{code,n,bytes}]
 *  - uni(code) → 문자열 | null
 *  - width(code) → 1/1000 em
 *  - ok: 교체 가능한 구조인지 (아니면 reason)
 */
export function buildFontInfo(mupdf, fontObj) {
  const f = fontObj.resolve ? fontObj.resolve() : fontObj;
  const subtype = nameOf(f.get('Subtype')) || '';
  const rawName = nameOf(f.get('BaseFont')) || '';
  const info = { subtype, rawName, name: decodeFontName(rawName), ok: true, reason: '', vertical: false };
  let desc = null;
  let descendant = null;
  if (subtype === 'Type0') {
    const d = f.get('DescendantFonts');
    descendant = d && d.isArray() ? d.get(0).resolve() : null;
    if (descendant) desc = descendant.get('FontDescriptor');
    if (!info.rawName && descendant) { info.rawName = nameOf(descendant.get('BaseFont')) || ''; info.name = decodeFontName(info.rawName); }
  } else {
    desc = f.get('FontDescriptor');
  }
  if (desc && desc.isNull()) desc = null;
  const flags = desc ? num(desc.get('Flags')) : 0;
  const weight = desc ? num(desc.get('FontWeight')) : 0;
  info.hint = {
    fixed: !!(flags & 1), serif: flags & 2 ? true : undefined, symbolic: !!(flags & 4), nonsymbolic: !!(flags & 32),
    italic: !!(flags & 64) || (desc && Math.abs(num(desc.get('ItalicAngle'))) > 3), bold: !!(flags & (1 << 18)), weight,
  };
  info.embedded = !!(desc && (desc.get('FontFile').isStream() || desc.get('FontFile2').isStream() || desc.get('FontFile3').isStream()));
  info.cls = classifyFont(info.rawName || info.name, info.hint);

  // ToUnicode
  let toUni = null;
  const tu = f.get('ToUnicode');
  if (tu && tu.isStream()) {
    const b = readStreamBytes(tu);
    if (b) { try { toUni = parseCMap(b).uni; } catch (e) { toUni = null; } }
  }

  if (subtype === 'Type3') {
    // Type3: 폭 = Widths × FontMatrix. 회전/기울어진 FontMatrix는 건너뜀
    const fm = f.get('FontMatrix');
    const m = fm && fm.isArray() ? [0, 1, 2, 3].map((k) => num(fm.get(k))) : [0.001, 0, 0, 0.001];
    // 글리프 좌표가 아래로 향하는 경우(m[3]<0, 예: 크롬 PDF)는 괜찮다. 1em≈1000 단위인 글꼴만 바꾼다.
    const okScale = (v) => Math.abs(v) >= 0.0005 && Math.abs(v) <= 0.002;
    if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9 || m[0] <= 0 || !okScale(m[0]) || !okScale(m[3])) { info.ok = false; info.reason = 'Type3 글꼴(특수 좌표)'; return info; }
    if (!info.rawName && desc) { const fnm = desc.get('FontName'); if (fnm && fnm.isName()) { info.rawName = fnm.asName(); info.name = decodeFontName(info.rawName); info.cls = classifyFont(info.rawName, info.hint); } }
    const first3 = num(f.get('FirstChar'), 0);
    const w3 = f.get('Widths');
    const widths3 = new Float64Array(256);
    if (w3 && w3.isArray()) for (let k = 0; k < w3.length && first3 + k < 256; k++) widths3[first3 + k] = num(w3.get(k)) * m[0] * 1000;
    const enc3 = f.get('Encoding');
    const diffs3 = new Map();
    const d3 = enc3 && enc3.isDictionary() ? enc3.get('Differences') : null;
    if (d3 && d3.isArray()) {
      let code = 0;
      for (let k = 0; k < d3.length; k++) { const o = d3.get(k); if (o.isNumber()) code = o.asNumber(); else if (o.isName()) { diffs3.set(code, o.asName()); code++; } }
    }
    info.split = (bytes) => Array.from(bytes, (b, i) => ({ code: b, n: 1, bytes: bytes.subarray(i, i + 1) }));
    info.width = (code) => widths3[code];
    info.uni = (code) => (toUni && toUni.has(code) ? toUni.get(code) : diffs3.has(code) ? glyphNameToUnicode(diffs3.get(code)) : null);
    info.singleByteSpace = (c) => c.code === 32;
    info.type3 = true;
    if (!toUni && !diffs3.size) { info.ok = false; info.reason = 'Type3 글꼴(유니코드 정보 없음)'; }
    return info;
  }

  if (subtype === 'Type0') {
    const encObj = f.get('Encoding');
    const encName = nameOf(encObj);
    let split, cidOf;
    let predefUni = null;
    if (encName === 'Identity-H' || encName === 'Identity-V') {
      info.vertical = encName === 'Identity-V';
      split = (bytes) => splitWithCodespace(bytes, [{ n: 2, lo: [0, 0], hi: [255, 255] }]);
      cidOf = (c) => c;
    } else if (encName && KOREAN_CMAPS.test(encName)) {
      info.vertical = /-V$/.test(encName);
      if (/UCS2|UTF16/.test(encName)) {
        split = (bytes) => splitWithCodespace(bytes, [{ n: 2, lo: [0, 0], hi: [255, 255] }]);
        predefUni = (c) => String.fromCharCode(c);
      } else {
        // KSC-EUC / KSCms-UHC: 1바이트(<0x80) 또는 2바이트
        split = (bytes) => splitWithCodespace(bytes, [{ n: 1, lo: [0], hi: [0x80] }, { n: 2, lo: [0x81, 0x41], hi: [0xfe, 0xfe] }]);
        const dec = new TextDecoder('euc-kr');
        predefUni = (c) => (c < 0x80 ? String.fromCharCode(c) : dec.decode(Uint8Array.of(c >> 8, c & 255)));
      }
      cidOf = null; // CID를 알 수 없음 → 폭은 W가 없을 때만 계산 가능
    } else if (encObj && encObj.isStream()) {
      const b = readStreamBytes(encObj);
      const cm = b ? parseCMap(b) : null;
      if (!cm || !cm.codespace.length || cm.usecmap) { info.ok = false; info.reason = '해석할 수 없는 인코딩'; }
      else {
        const wm = encObj.get('WMode');
        info.vertical = num(wm) === 1;
        split = (bytes) => splitWithCodespace(bytes, cm.codespace);
        cidOf = (c) => {
          if (cm.cidchar.has(c)) return cm.cidchar.get(c);
          for (const r of cm.cid) if (c >= r.lo && c <= r.hi) return r.cid + (c - r.lo);
          return 0;
        };
      }
    } else {
      info.ok = false; info.reason = `인코딩 ${encName || '?'}`;
    }
    if (!info.ok) return info;
    // 폭
    const dw = descendant ? num(descendant.get('DW'), 1000) : 1000;
    const wmap = new Map();
    const W = descendant ? descendant.get('W') : null;
    if (W && W.isArray()) {
      const n = W.length;
      let i = 0;
      while (i < n) {
        const a = W.get(i);
        const b = W.get(i + 1);
        if (b && b.isArray()) {
          const start = num(a);
          for (let k = 0; k < b.length; k++) wmap.set(start + k, num(b.get(k)));
          i += 2;
        } else {
          const lo = num(a), hi = num(b), w = num(W.get(i + 2));
          if (hi - lo < 70000) for (let c = lo; c <= hi; c++) wmap.set(c, w);
          i += 3;
        }
      }
    }
    if (!cidOf && wmap.size) { info.ok = false; info.reason = '폭 정보를 알 수 없는 CMap'; return info; }
    info.split = split;
    info.width = (code) => { const cid = cidOf ? cidOf(code) : -1; return wmap.has(cid) ? wmap.get(cid) : dw; };
    info.uni = (code) => {
      if (toUni && toUni.has(code)) return toUni.get(code);
      if (predefUni) return predefUni(code);
      return null;
    };
    info.singleByteSpace = (c) => c.n === 1 && c.code === 32;
    if (!toUni && !predefUni) { info.ok = false; info.reason = '유니코드 정보 없음'; }
    if (info.vertical) { info.ok = false; info.reason = '세로쓰기'; }
    return info;
  }

  // ---- 단순 글꼴 (Type1 / TrueType / MMType1) ----
  const first = num(f.get('FirstChar'), 0);
  const widthsObj = f.get('Widths');
  const missing = desc ? num(desc.get('MissingWidth'), 0) : 0;
  let widths = null;
  if (widthsObj && widthsObj.isArray()) {
    widths = new Float64Array(256).fill(missing);
    for (let k = 0; k < widthsObj.length && first + k < 256; k++) widths[first + k] = num(widthsObj.get(k), missing);
  }
  // 인코딩
  const encObj = f.get('Encoding');
  let baseEnc = nameOf(encObj);
  const diffs = new Map();
  if (encObj && encObj.isDictionary()) {
    baseEnc = nameOf(encObj.get('BaseEncoding'));
    const d = encObj.get('Differences');
    if (d && d.isArray()) {
      let code = 0;
      for (let k = 0; k < d.length; k++) {
        const o = d.get(k);
        if (o.isNumber()) code = o.asNumber();
        else if (o.isName()) { diffs.set(code, o.asName()); code++; }
      }
    }
  }
  const symbolic = info.hint.symbolic && !info.hint.nonsymbolic;
  info.uni = (code) => {
    if (toUni && toUni.has(code)) return toUni.get(code);
    if (diffs.has(code)) return glyphNameToUnicode(diffs.get(code));
    if (symbolic && !baseEnc) return null;
    return decodeSingle(baseEnc || 'WinAnsiEncoding', code);
  };
  info.split = (bytes) => Array.from(bytes, (b, i) => ({ code: b, n: 1, bytes: bytes.subarray(i, i + 1) }));
  if (widths) info.width = (code) => widths[code];
  else {
    // 기본 14 글꼴 (폭 배열 없음) → MuPDF 내장 글꼴 폭
    let base = null;
    try { base = new mupdf.Font(info.name.replace(/,/g, '-')); } catch (e) { base = null; }
    if (!base) { info.ok = false; info.reason = '폭 정보 없음'; return info; }
    info.width = (code) => {
      const u = info.uni(code);
      if (!u) return 0;
      const g = base.encodeCharacter(u.codePointAt(0));
      return base.advanceGlyph(g, 0) * 1000;
    };
  }
  info.singleByteSpace = (c) => c.code === 32;
  return info;
}
