// PDF 처리 담당 (백그라운드). MuPDF(WebAssembly) + 글꼴 교체 + OCR 글자층 + 미리보기/검색
import { NewFontSet, PdfFontSwapper } from './pdf-swap.js';
import { analyzePage, ocrRegions, renderWithoutText, addInvisibleText, searchDoc } from './pdf-pages.js';
import { initSubsetter, subsetFont } from './subset.js';

let mupdf = null;
let fonts = {}; // slot → {bytes, psname, font}
const results = new Map(); // id → {out, orig, report}
const pendingOcr = new Map(); // job → resolve

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function ensureEngine() {
  if (mupdf) return;
  mupdf = await import('../vendor/mupdf/mupdf.js');
  await initSubsetter(new URL('../vendor/hb/harfbuzz-subset.wasm', import.meta.url).href);
}

function setFonts(list) {
  fonts = {};
  for (const [slot, f] of Object.entries(list || {})) {
    if (!f || !f.bytes) continue;
    const bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    const tag = 'FSW' + slot.toUpperCase().padEnd(3, 'X');
    const ps = (f.psname || 'Font').replace(/[^A-Za-z0-9_-]/g, '') || 'Font';
    fonts[slot] = { bytes, psname: `${tag.slice(0, 6)}+${ps}`, font: new mupdf.Font(ps, bytes) };
  }
}

function openPdf(bytes) {
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  if (doc.needsPassword()) throw new Error('암호가 걸린 PDF예요. 암호를 푼 뒤 넣어 주세요.');
  const pdf = doc.asPDF();
  if (!pdf) throw new Error('PDF로 열 수 없어요.');
  return pdf;
}

function fontSummary(stats) {
  return stats.map((f) => ({ name: f.name, family: f.family, bold: f.bold, italic: f.italic, ok: f.ok, reason: f.reason, glyphs: f.glyphs, replaced: f.replaced, kept: f.kept, slots: f.slots }));
}

async function analyze(id, bytes, options) {
  await ensureEngine();
  const doc = openPdf(bytes);
  const nf = new NewFontSet(mupdf, doc, fonts);
  const sw = new PdfFontSwapper(mupdf, doc, nf, { ...options });
  // 바꿔 쓰기까지 해 보되 저장은 하지 않음 → 글꼴별 실제 교체 수를 미리 알 수 있다
  const rep = sw.run();
  return { pages: doc.countPages(), fonts: fontSummary(rep.fonts) };
}

let inflight = 0;
const waiters = [];
const acquire = (max) => new Promise((res) => { if (inflight < max) { inflight++; res(); } else waiters.push(res); });
const release = () => { inflight--; const w = waiters.shift(); if (w) { inflight++; w(); } };

let jobSeq = 0;
function requestOcr(id, page, img, why) {
  const job = ++jobSeq;
  return new Promise((resolve) => {
    pendingOcr.set(job, resolve);
    post({ type: 'ocr', id, job, page, why, png: img.png, img: { origin: img.origin, scale: img.scale, width: img.width, height: img.height } }, [img.png.buffer]);
  });
}

async function convert(id, bytes, options) {
  await ensureEngine();
  const t0 = Date.now();
  const opt = { mode: 'keep', keepMono: true, italic: true, overrides: {}, ocr: 'auto', ocrParallel: 2, ...options };
  const progress = (stage, done, total) => post({ type: 'progress', id, stage, done, total });
  const doc = openPdf(bytes);
  const n = doc.countPages();
  const nf = new NewFontSet(mupdf, doc, fonts);
  const sw = new PdfFontSwapper(mupdf, doc, nf, opt);
  const rep = sw.run((i, total, stage) => progress(stage, i, total));
  const pages = rep.pages.map((p) => ({ ...p, ocr: null }));

  // OCR
  if (opt.ocr !== 'off') {
    const tasks = [];
    let regionsTotal = 0, regionsDone = 0;
    const pageLines = new Map();
    const pageBoxes = new Map();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const info = analyzePage(mupdf, page);
      pages[i].visible = info.visible;
      pages[i].invisibleBefore = info.invisible;
      pages[i].images = info.images.length;
      const regs = ocrRegions(info, opt.ocr);
      if (!regs.length) continue;
      pageBoxes.set(i, info.glyphBoxes.filter((g) => !g.inv).map((g) => g.r));
      pages[i].ocr = { regions: regs.length, why: regs[0].why, lines: [], chunks: 0, conf: 0 };
      regionsTotal += regs.length;
      for (const rg of regs) {
        await acquire(Math.max(1, opt.ocrParallel));
        let img;
        try { img = renderWithoutText(mupdf, page, rg.r); } catch (e) { release(); continue; }
        progress('ocr', regionsDone, regionsTotal);
        tasks.push(requestOcr(id, i, img, rg.why).then((res) => {
          release();
          regionsDone++;
          progress('ocr', regionsDone, regionsTotal);
          if (res && res.lines) {
            const arr = pageLines.get(i) || [];
            arr.push(...res.lines);
            pageLines.set(i, arr);
          }
        }));
      }
    }
    await Promise.all(tasks);
    progress('ocr', regionsTotal, regionsTotal);
    for (const [i, lines] of pageLines) {
      const page = doc.loadPage(i);
      const added = addInvisibleText(mupdf, doc, doc.findPage(i), page, nf, lines, pageBoxes.get(i) || []);
      const chunks = lines.flatMap((l) => l.chunks);
      pages[i].ocr.lines = lines.map((l) => ({ box: l.box, chunks: l.chunks.map((c) => ({ text: c.text, conf: Math.round(c.conf), box: c.box })) }));
      pages[i].ocr.chunks = added;
      pages[i].ocr.conf = chunks.length ? Math.round(chunks.reduce((s, c) => s + c.conf, 0) / chunks.length) : 0;
    }
  }

  progress('save', 0, 1);
  const sizes = nf.finalize(subsetFont);
  const out = doc.saveToBuffer('garbage=compact,compress').asUint8Array().slice();
  progress('save', 1, 1);
  // 미리보기·검색용으로 결과와 원본을 열어 둔다
  closeResult(id);
  const outDoc = mupdf.Document.openDocument(out, 'application/pdf');
  // 결과 쪽 글자 수 (검색 가능한 글자)
  for (let i = 0; i < n; i++) {
    try {
      const t = outDoc.loadPage(i).toStructuredText('preserve-whitespace').asText();
      pages[i].searchable = t.replace(/\s+/g, '').length;
    } catch (e) { pages[i].searchable = 0; }
  }
  const report = { kind: 'pdf', pages, fonts: fontSummary(rep.fonts), sizes, ms: Date.now() - t0, inSize: bytes.length, outSize: out.length };
  results.set(id, { out: outDoc, orig: null, report }); // 원본은 '원본 보기'를 누를 때 연다
  return { pdf: out, report };
}

function closeResult(id) {
  const r = results.get(id);
  if (!r) return;
  try { r.out.destroy(); } catch (e) { /* */ }
  try { r.orig && r.orig.destroy(); } catch (e) { /* */ }
  results.delete(id);
}

function render(id, which, pageNo, width) {
  const r = results.get(id);
  if (!r) throw new Error('결과가 없어요');
  if (which === 'orig' && !r.orig) throw new Error('need-orig');
  const doc = which === 'orig' ? r.orig : r.out;
  const page = doc.loadPage(pageNo);
  const b = page.getBounds();
  const s = width / (b[2] - b[0]);
  const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = pix.asPNG();
  return { png, w: pix.getWidth(), h: pix.getHeight(), scale: s, bounds: b };
}

function pageText(id, pageNo) {
  const r = results.get(id);
  if (!r) throw new Error('결과가 없어요');
  return r.out.loadPage(pageNo).toStructuredText('preserve-whitespace').asText();
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init': await ensureEngine(); setFonts(m.fonts); post({ type: 'reply', rid: m.rid, ok: true }); break;
      case 'setFonts': await ensureEngine(); setFonts(m.fonts); post({ type: 'reply', rid: m.rid, ok: true }); break;
      case 'analyze': post({ type: 'reply', rid: m.rid, ok: true, data: await analyze(m.id, m.bytes, m.options) }); break;
      case 'convert': {
        const r = await convert(m.id, m.bytes, m.options);
        post({ type: 'reply', rid: m.rid, ok: true, data: r }, [r.pdf.buffer]);
        break;
      }
      case 'ocrResult': { const f = pendingOcr.get(m.job); pendingOcr.delete(m.job); if (f) f(m.data); break; }
      case 'render': { const d = render(m.id, m.which, m.page, m.width); post({ type: 'reply', rid: m.rid, ok: true, data: d }, [d.png.buffer]); break; }
      case 'search': { const r = results.get(m.id); post({ type: 'reply', rid: m.rid, ok: true, data: r ? searchDoc(r.out, m.query) : [] }); break; }
      case 'pageText': post({ type: 'reply', rid: m.rid, ok: true, data: pageText(m.id, m.page) }); break;
      case 'loadOrig': { await ensureEngine(); const r = results.get(m.id); if (r && !r.orig) r.orig = mupdf.Document.openDocument(m.orig, 'application/pdf'); post({ type: 'reply', rid: m.rid, ok: true }); break; }
      case 'close': closeResult(m.id); post({ type: 'reply', rid: m.rid, ok: true }); break;
      case 'open': {
        // 메모리를 아끼려고 닫아 둔 결과를 검사하려고 다시 열기
        await ensureEngine();
        closeResult(m.id);
        results.set(m.id, { out: mupdf.Document.openDocument(m.out, 'application/pdf'), orig: null, report: m.report });
        post({ type: 'reply', rid: m.rid, ok: true });
        break;
      }
      default: post({ type: 'reply', rid: m.rid, ok: false, error: 'unknown ' + m.type });
    }
  } catch (e) {
    post({ type: 'reply', rid: m.rid, ok: false, error: (e && e.message) || String(e) });
  }
};
