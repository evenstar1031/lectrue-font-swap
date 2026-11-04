// PDF 내용 스트림(content stream) 토크나이저. 연산자마다 바이트 위치를 함께 돌려줘서
// 원본 바이트는 그대로 두고 필요한 연산자만 잘라 바꿀 수 있게 한다.

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX[48 + i] = i;
for (let i = 0; i < 6; i++) { HEX[65 + i] = 10 + i; HEX[97 + i] = 10 + i; }

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const latin1 = (bytes, a, b) => {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/**
 * @param {Uint8Array} bytes
 * @returns {Array<{op:string,args:any[],start:number,end:number}>}
 *   args 원소: number | {t:'name',v} | {t:'str',v:Uint8Array} | {t:'arr',v:[]} | {t:'kw',v} | {t:'dict'}
 */
export function parseContent(bytes) {
  const n = bytes.length;
  const ops = [];
  let i = 0;
  let stack = [];
  let argStart = -1;
  const arrStack = [];
  let dictDepth = 0;

  const push = (tok, start) => {
    if (arrStack.length) { arrStack[arrStack.length - 1].v.push(tok); return; }
    if (stack.length === 0 && argStart < 0) argStart = start;
    stack.push(tok);
  };

  while (i < n) {
    const c = bytes[i];
    if (WS[c]) { i++; continue; }
    if (c === 0x25) { // % 주석
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
      continue;
    }
    const start = i;
    if (c === 0x28) { // ( 문자열 )
      i++;
      let depth = 1;
      const out = [];
      while (i < n) {
        const b = bytes[i];
        if (b === 0x5c) {
          i++;
          const e = bytes[i];
          if (e === 110) { out.push(10); i++; }
          else if (e === 114) { out.push(13); i++; }
          else if (e === 116) { out.push(9); i++; }
          else if (e === 98) { out.push(8); i++; }
          else if (e === 102) { out.push(12); i++; }
          else if (e >= 48 && e <= 55) {
            let v = 0, k = 0;
            while (k < 3 && bytes[i] >= 48 && bytes[i] <= 55) { v = v * 8 + (bytes[i] - 48); i++; k++; }
            out.push(v & 255);
          } else if (e === 13) { i++; if (bytes[i] === 10) i++; }
          else if (e === 10) { i++; }
          else if (e !== undefined) { out.push(e); i++; }
          continue;
        }
        if (b === 0x28) depth++;
        else if (b === 0x29) { depth--; if (depth === 0) { i++; break; } }
        out.push(b);
        i++;
      }
      push({ t: 'str', v: Uint8Array.from(out) }, start);
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) { i += 2; dictDepth++; push({ t: 'dict<' }, start); continue; }
      i++;
      const out = [];
      let hi = -1;
      while (i < n && bytes[i] !== 0x3e) {
        const h = HEX[bytes[i]];
        if (h >= 0) { if (hi < 0) hi = h; else { out.push(hi * 16 + h); hi = -1; } }
        i++;
      }
      if (hi >= 0) out.push(hi * 16);
      i++;
      push({ t: 'str', v: Uint8Array.from(out), hex: true }, start);
      continue;
    }
    if (c === 0x3e) { // >>
      i += bytes[i + 1] === 0x3e ? 2 : 1;
      if (dictDepth > 0) dictDepth--;
      push({ t: '>dict' }, start);
      continue;
    }
    if (c === 0x5b) { i++; arrStack.push({ t: 'arr', v: [], start }); continue; }
    if (c === 0x5d) {
      i++;
      const a = arrStack.pop();
      if (a) push(a, a.start);
      continue;
    }
    if (c === 0x7b || c === 0x7d) { i++; continue; }
    if (c === 0x2f) { // /이름
      i++;
      const s0 = i;
      while (i < n && !WS[bytes[i]] && !DELIM[bytes[i]]) i++;
      let v = latin1(bytes, s0, i);
      if (v.includes('#')) v = v.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      push({ t: 'name', v }, start);
      continue;
    }
    // 숫자 또는 키워드
    const s0 = i;
    while (i < n && !WS[bytes[i]] && !DELIM[bytes[i]]) i++;
    if (i === s0) { i++; continue; } // 알 수 없는 바이트
    const word = latin1(bytes, s0, i);
    if (NUM_RE.test(word)) { push(parseFloat(word), start); continue; }
    if (word === 'true' || word === 'false' || word === 'null') { push({ t: 'kw', v: word }, start); continue; }
    if (arrStack.length || dictDepth > 0) { push({ t: 'kw', v: word }, start); continue; }
    // 연산자
    if (word === 'ID') {
      // 인라인 이미지 데이터 건너뛰기: 공백 1바이트 다음부터 'EI' (앞뒤 공백) 까지
      let j = i + 1;
      let found = -1;
      while (j < n - 1) {
        if (bytes[j] === 0x45 && bytes[j + 1] === 0x49 && WS[bytes[j - 1]] && (j + 2 >= n || WS[bytes[j + 2]] || DELIM[bytes[j + 2]])) { found = j; break; }
        j++;
      }
      const end = found >= 0 ? found + 2 : n;
      ops.push({ op: 'BI', args: stack, start: argStart >= 0 ? argStart : s0, end, inline: true });
      stack = []; argStart = -1;
      i = end;
      continue;
    }
    ops.push({ op: word, args: stack, start: argStart >= 0 ? argStart : s0, end: i });
    stack = [];
    argStart = -1;
  }
  return ops;
}

// ---- 내용 스트림에 다시 쓰기 위한 직렬화 도우미 ----
export function fmtNum(x) {
  if (!Number.isFinite(x)) return '0';
  if (Math.abs(x) < 1e-6) return '0';
  let s = x.toFixed(4);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}
const HEXCH = '0123456789abcdef';
export function hexBytes(arr) {
  let s = '<';
  for (const b of arr) s += HEXCH[b >> 4] + HEXCH[b & 15];
  return s + '>';
}
export function pdfName(n) {
  return '/' + n.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

// 바이트 편집(splice) 적용
export function applyEdits(bytes, edits) {
  if (!edits.length) return bytes;
  edits.sort((a, b) => a.start - b.start);
  const enc = new TextEncoder();
  const parts = [];
  let pos = 0;
  let total = 0;
  for (const e of edits) {
    if (e.start < pos) continue; // 겹치면 무시(방어)
    const seg = bytes.subarray(pos, e.start);
    const rep = enc.encode(' ' + e.text + ' ');
    parts.push(seg, rep);
    total += seg.length + rep.length;
    pos = e.end;
  }
  const tail = bytes.subarray(pos);
  parts.push(tail);
  total += tail.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
