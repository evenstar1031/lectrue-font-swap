// 글꼴 파일(OTF/TTF)에서 이름·굵기 읽기 (name, OS/2, head 표)

function u16(d, o) { return (d[o] << 8) | d[o + 1]; }
function u32(d, o) { return ((d[o] << 24) >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3]; }

export function readFontMeta(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const tag = String.fromCharCode(d[0], d[1], d[2], d[3]);
  let base = 0;
  if (tag === 'ttcf') base = u32(d, 12);
  const sfnt = String.fromCharCode(d[base], d[base + 1], d[base + 2], d[base + 3]);
  if (!(sfnt === 'OTTO' || sfnt === 'true' || u32(d, base) === 0x00010000)) throw new Error('지원하지 않는 글꼴 형식이에요 (TTF/OTF만 가능)');
  const numTables = u16(d, base + 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const r = base + 12 + i * 16;
    const t = String.fromCharCode(d[r], d[r + 1], d[r + 2], d[r + 3]);
    tables[t] = { off: u32(d, r + 8), len: u32(d, r + 12) };
  }
  const names = {};
  if (tables.name) {
    const o = tables.name.off;
    const count = u16(d, o + 2), strOff = o + u16(d, o + 4);
    const pick = {};
    for (let i = 0; i < count; i++) {
      const r = o + 6 + i * 12;
      const pid = u16(d, r), eid = u16(d, r + 2), lid = u16(d, r + 4), nid = u16(d, r + 6), len = u16(d, r + 8), off = u16(d, r + 10);
      let s = null;
      const at = strOff + off;
      if (pid === 3 || pid === 0) {
        s = '';
        for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(u16(d, at + k));
      } else if (pid === 1 && eid === 0) {
        s = '';
        for (let k = 0; k < len; k++) s += String.fromCharCode(d[at + k]);
      }
      if (s == null) continue;
      // 우선순위: 윈도우 영어 > 윈도우 한국어 > 그 외
      const score = pid === 3 && lid === 0x409 ? 3 : pid === 3 && lid === 0x412 ? 2 : pid === 3 ? 1.5 : 1;
      if (!pick[nid] || pick[nid].score < score) pick[nid] = { s, score };
      if (pid === 3 && lid === 0x412) names['ko' + nid] = s;
    }
    for (const k of Object.keys(pick)) names[k] = pick[k].s;
  }
  let weight = 400, fsSelection = 0, macStyle = 0;
  if (tables['OS/2']) { weight = u16(d, tables['OS/2'].off + 4); fsSelection = u16(d, tables['OS/2'].off + 62); }
  if (tables.head) macStyle = u16(d, tables.head.off + 44);
  const family = names[1] || names[16] || names[4] || '';
  return {
    family,                       // 오피스 문서에 쓰는 이름 (nameID 1)
    subfamily: names[2] || '',
    full: names[4] || family,
    postscript: (names[6] || family).replace(/[^\x21-\x7e]/g, '').replace(/[[\](){}<>/%]/g, ''),
    typoFamily: names[16] || family,
    typoSub: names[17] || names[2] || '',
    koFamily: names.ko1 || names.ko16 || '',
    weight,
    styleLinkedBold: !!(fsSelection & 0x20) || !!(macStyle & 1),
    cff: !!tables['CFF '],
  };
}

/** 파일 이름·글꼴 정보로 슬롯 추측 */
export function guessSlot(meta, fileName) {
  const s = `${meta.full} ${meta.family} ${meta.typoFamily} ${meta.subfamily} ${fileName}`.toLowerCase().replace(/[\s_-]+/g, '');
  const fam = /(batang|바탕|myeong|myung|명조|mincho|serif|궁서|gungsuh)/.test(s) && !/sans(?!serif)/.test(s) ? 'b'
    : /(gothic|고딕|sans|돋움|dotum|굴림|gulim|pretendard|spoqa|noto ?sans|nanumsquare)/.test(s) ? 'g' : null;
  const bold = meta.weight >= 600 || /(semibold|demibold|extrabold|bold|black|heavy|sb00|eb00|b00|h00)/.test(s);
  return { fam, bold };
}
