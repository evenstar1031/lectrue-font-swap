// 페이지 분석(글자·이미지 위치), 글자를 뺀 렌더링(OCR용), 보이지 않는 OCR 글자층 넣기
import { mul } from './pdf-swap.js';
import { fmtNum, hexBytes, pdfName } from './pdf-lexer.js';
import { PdfFontSwapper } from './pdf-swap.js';

function rectOfMatrix(m) {
  // 단위 정사각형을 m으로 옮긴 경계 상자
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/** 페이지 안의 글자/이미지 정보 (MuPDF 화면 좌표: 왼쪽 위 원점) */
export function analyzePage(mupdf, page) {
  const bounds = page.getBounds();
  const res = { bounds, visible: 0, invisible: 0, images: [], glyphBoxes: [], paths: 0 };
  const pageArea = area(bounds);
  const textWalk = (text, ctm, store) => {
    text.walk({
      showGlyph(font, trm, glyph, unicode) {
        const m = mul(trm, ctm);
        if (store === 'v') res.visible++; else res.invisible++;
        if (res.glyphBoxes.length < 20000) {
          let adv = 0.5;
          try { adv = font.advanceGlyph(glyph, 0) || 0.5; } catch (e) { /* */ }
          // 글리프 공간 [0,-0.2]~[adv,0.9] → 화면
          const g = [adv, 0, 0, 1.1, 0, -0.2];
          res.glyphBoxes.push({ r: rectOfMatrix(mul(g, m)), inv: store !== 'v', u: unicode });
        }
      },
    });
  };
  const dev = new mupdf.Device({
    fillText(text, ctm) { textWalk(text, ctm, 'v'); },
    strokeText(text, stroke, ctm) { textWalk(text, ctm, 'v'); },
    ignoreText(text, ctm) { textWalk(text, ctm, 'i'); },
    fillImage(image, ctm) {
      const r = inter(rectOfMatrix(ctm), bounds);
      if (area(r) > 0) res.images.push({ r, w: image.getWidth(), h: image.getHeight() });
    },
    fillImageMask(image, ctm) {
      const r = inter(rectOfMatrix(ctm), bounds);
      if (area(r) > 0) res.images.push({ r, w: image.getWidth(), h: image.getHeight(), mask: true });
    },
    fillPath() { res.paths++; },
    strokePath() { res.paths++; },
  });
  try { page.runPageContents(dev, mupdf.Matrix.identity); } finally { dev.close(); }
  res.imageArea = res.images.reduce((s, im) => s + area(im.r), 0) / pageArea;
  return res;
}

/** OCR 할 영역 고르기. mode: 'auto' | 'all' | 'off' */
export function ocrRegions(info, mode) {
  if (mode === 'off') return [];
  const b = info.bounds;
  const W = b[2] - b[0], H = b[3] - b[1];
  if (mode !== 'all-force' && info.invisible >= 20) return []; // 이미 OCR 글자층이 있음
  if (mode === 'all' || mode === 'all-force') return [{ r: b, why: 'all' }];
  if (info.visible < 15 && (info.imageArea > 0.15 || info.paths > 200)) return [{ r: b, why: 'scan' }];
  // 크기가 어느 정도 되는 이미지만
  const boxes = info.images
    .filter((im) => (im.r[2] - im.r[0]) >= Math.min(40, W * 0.06) && (im.r[3] - im.r[1]) >= Math.min(24, H * 0.04) && im.w >= 60 && im.h >= 24)
    .map((im) => [...im.r]);
  // 겹치거나 가까운 상자 합치기
  const pad = 6;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], c = boxes[j];
        if (a[0] - pad < c[2] && c[0] - pad < a[2] && a[1] - pad < c[3] && c[1] - pad < a[3]) {
          boxes[i] = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])];
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes.map((r) => ({ r: [Math.max(b[0], r[0] - 2), Math.max(b[1], r[1] - 2), Math.min(b[2], r[2] + 2), Math.min(b[3], r[3] + 2)], why: 'image' }));
}

/** 글자는 빼고(그림·도형만) 영역을 회색조 PNG로 */
export function renderWithoutText(mupdf, page, rect, maxPixels = 6e6, preferScale = 3) {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  let s = preferScale;
  if (w * h * s * s > maxPixels) s = Math.sqrt(maxPixels / (w * h));
  s = Math.max(1, s);
  const bbox = [Math.floor(rect[0] * s), Math.floor(rect[1] * s), Math.ceil(rect[2] * s), Math.ceil(rect[3] * s)];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, bbox, false);
  pix.clear(255);
  const draw = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
  const fwd = new mupdf.Device({
    fillPath: (p, eo, ctm, cs, c, a) => draw.fillPath(p, eo, ctm, cs, c, a),
    strokePath: (p, st, ctm, cs, c, a) => draw.strokePath(p, st, ctm, cs, c, a),
    clipPath: (p, eo, ctm) => draw.clipPath(p, eo, ctm),
    clipStrokePath: (p, st, ctm) => draw.clipStrokePath(p, st, ctm),
    clipText: (t, ctm) => draw.clipText(t, ctm),
    clipStrokeText: (t, st, ctm) => draw.clipStrokeText(t, st, ctm),
    fillShade: (sh, ctm, a) => draw.fillShade(sh, ctm, a),
    fillImage: (im, ctm, a) => draw.fillImage(im, ctm, a),
    fillImageMask: (im, ctm, cs, c, a) => draw.fillImageMask(im, ctm, cs, c, a),
    clipImageMask: (im, ctm) => draw.clipImageMask(im, ctm),
    popClip: () => draw.popClip(),
    beginMask: (r, l, cs, c) => draw.beginMask(r, l, cs, c),
    endMask: () => draw.endMask(),
    beginGroup: (r, cs, i, k, bm, a) => draw.beginGroup(r, cs, i, k, bm, a),
    endGroup: () => draw.endGroup(),
    beginTile: (ar, v, xs, ys, ctm, id, did) => draw.beginTile(ar, v, xs, ys, ctm, id, did),
    endTile: () => draw.endTile(),
  });
  try { page.runPageContents(fwd, mupdf.Matrix.scale(s, s)); }
  finally { fwd.close(); draw.close(); }
  const png = pix.asPNG();
  return { png, scale: s, origin: [bbox[0] / s, bbox[1] / s], width: pix.getWidth(), height: pix.getHeight() };
}

/**
 * OCR 줄 → 보이지 않는 글자(렌더 모드 3)로 페이지에 넣기
 * lines: [{box:[x0,y0,x1,y1], baseline:number|null, chunks:[{text, conf, box}]}]  (MuPDF 화면 좌표)
 * 한 줄 안의 덩어리는 같은 기준선·크기로 넣고, 덩어리 사이에 공백 글자를 넣는다.
 */
export function addInvisibleText(mupdf, doc, pageObj, page, nf, lines, skipBoxes = []) {
  const key = nf.resolveKey('bR');
  if (!key || !lines.length) return 0;
  const inv = mupdf.Matrix.invert(page.getTransform());
  const parts = [];
  let added = 0;
  const sp = nf.map(' ', key);
  for (const line of lines) {
    const ws = line.chunks.filter((w) => {
      if (!w.text || !w.text.trim()) return false;
      const [x0, y0, x1, y1] = w.box;
      if (x1 - x0 <= 0.5 || y1 - y0 <= 0.5) return false;
      for (const g of skipBoxes) {
        const r = inter(g, w.box);
        if (area(r) > 0.4 * Math.min(area(g), area(w.box))) return false;
      }
      return true;
    });
    if (!ws.length) continue;
    const lh = Math.max(1, line.box[3] - line.box[1]);
    const size = lh * 0.9;
    const baseline = line.baseline != null ? line.baseline : line.box[3] - lh * 0.16;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      const text = w.text.replace(/\s+/g, '');
      const gids = [];
      let adv = 0;
      for (const ch of text) {
        const m = nf.map(ch, key);
        if (!m || m.key !== key) continue;
        gids.push(...m.gids);
        adv += m.adv;
      }
      if (!gids.length || adv <= 0) continue;
      const next = ws[i + 1];
      const bw = w.box[2] - w.box[0];
      const sx = bw / (adv * size);
      const M = mul([size * sx, 0, 0, -size, w.box[0], baseline], inv);
      const b = [];
      for (const g of gids) b.push(g >> 8, g & 255);
      if (next && sp) for (const g of sp.gids) b.push(g >> 8, g & 255);
      parts.push(`${M.map(fmtNum).join(' ')} Tm ${hexBytes(b)} Tj`);
      added++;
    }
  }
  if (!parts.length) return 0;
  const name = 'FSWocr';
  const res = pageObj.getInheritable('Resources');
  let fonts = res.get('Font');
  if (!fonts || fonts.isNull()) { res.put('Font', doc.newDictionary()); fonts = res.get('Font'); }
  fonts.put(name, nf.ref(key));
  const old = PdfFontSwapper.readContents(pageObj);
  const enc = new TextEncoder();
  const head = enc.encode('q\n');
  const tail = enc.encode(`\nQ\nq BT 3 Tr ${pdfName(name)} 1 Tf\n${parts.join('\n')}\nET Q\n`);
  const out = new Uint8Array(head.length + old.length + tail.length);
  out.set(head, 0); out.set(old, head.length); out.set(tail, head.length + old.length);
  pageObj.put('Contents', doc.addStream(out, doc.newDictionary()));
  return added;
}

/** 출력 PDF의 검색: 낱말 → 페이지별 사각형 */
export function searchDoc(doc, needle, maxPerPage = 50) {
  const n = doc.countPages();
  const hits = [];
  for (let i = 0; i < n; i++) {
    const p = doc.loadPage(i);
    let q = [];
    try { q = p.search(needle); } catch (e) { q = []; }
    if (q && q.length) hits.push({ page: i, quads: q.map((group) => group.map((qq) => [Math.min(qq[0], qq[4]), Math.min(qq[1], qq[3]), Math.max(qq[2], qq[6]), Math.max(qq[5], qq[7])])) });
  }
  return hits;
}
