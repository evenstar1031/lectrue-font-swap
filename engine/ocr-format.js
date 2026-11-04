// Tesseract 결과(blocks → paragraphs → lines → words)를 "줄 → 덩어리(띄어쓰기 단위)"로 정리.
// Tesseract의 낱말 상자는 한글에서 음절 단위로 잘게 쪼개지는 경우가 많아서,
// 줄 텍스트(line.text)에 실제 띄어쓰기가 있는 곳에서만 끊는다.

export function tessToLines(data, img, { minConf = 60 } = {}) {
  const T = (bb) => [img.origin[0] + bb.x0 / img.scale, img.origin[1] + bb.y0 / img.scale, img.origin[0] + bb.x1 / img.scale, img.origin[1] + bb.y1 / img.scale];
  const lines = [];
  let total = 0, kept = 0, confSum = 0;
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const words = (l.words || []).filter((w) => w.text && w.text.trim());
    if (!words.length) continue;
    const lt = (l.text || '').replace(/\n/g, ' ');
    let pos = 0;
    const chunks = [];
    let cur = null;
    for (const w of words) {
      const t = w.text.trim();
      const at = lt.indexOf(t, pos);
      const between = at >= 0 ? lt.slice(pos, at) : ' ';
      if (at >= 0) pos = at + t.length;
      const spaced = !cur || /\s/.test(between);
      const box = T(w.bbox);
      if (spaced) { cur = { text: t, box, confs: [w.confidence] }; chunks.push(cur); }
      else { cur.text += t; cur.box = [Math.min(cur.box[0], box[0]), Math.min(cur.box[1], box[1]), Math.max(cur.box[2], box[2]), Math.max(cur.box[3], box[3])]; cur.confs.push(w.confidence); }
    }
    const good = [];
    for (const c of chunks) {
      total++;
      const avg = c.confs.reduce((s, x) => s + x, 0) / c.confs.length;
      const min = Math.min(...c.confs);
      c.conf = avg;
      if (avg >= minConf && min >= minConf - 25 && /[\p{L}\p{N}]/u.test(c.text)) { good.push(c); kept++; confSum += avg; }
    }
    if (!good.length) continue;
    const bl = l.baseline && (l.baseline.has_baseline === undefined || l.baseline.has_baseline)
      ? img.origin[1] + ((l.baseline.y0 + l.baseline.y1) / 2) / img.scale : null;
    lines.push({ box: T(l.bbox), baseline: bl, chunks: good, text: good.map((c) => c.text).join(' ') });
  }
  return { lines, total, kept, avgConf: kept ? confSum / kept : 0 };
}
