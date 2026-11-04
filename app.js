// 화면 · 파일 처리 · OCR 연결
import { readFontMeta, guessSlot } from './engine/fontmeta.js';
import { convertPptx, convertDocx } from './engine/office.js';
import { tessToLines } from './engine/ocr-format.js';
import { SLOT_LABEL } from './engine/classify.js';

const $ = (s, el = document) => el.querySelector(s);
const SLOTS = ['bR', 'bB', 'gR', 'gB'];
const SLOT_TEXT = { bR: '바탕 보통', bB: '바탕 굵게', gR: '고딕 보통', gB: '고딕 굵게' };
const SAMPLE = '가나다 혈중농도 Aa 123';
const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------- 작은 도구
const toastEl = $('#toast');
let toastT = 0;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), ms);
}
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');
const fmtNum = (n) => n.toLocaleString('ko-KR');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem('fontswap.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('fontswap.' + k, JSON.stringify(v)); } catch (e) { /* 사생활 보호 모드 등 */ } },
};

// ---------------------------------------------------------------- 글꼴 저장 (IndexedDB)
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open('fontswap', 1); } catch (e) { rej(e); return; }
      req.onupgradeneeded = () => req.result.createObjectStore('fonts');
      req.onsuccess = () => { this.db = req.result; res(this.db); };
      req.onerror = () => rej(req.error);
    });
  },
  async put(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('fonts', 'readwrite'); tx.objectStore('fonts').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  async del(k) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('fonts', 'readwrite'); tx.objectStore('fonts').delete(k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('fonts').objectStore('fonts').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
};

const fonts = {}; // slot → {fileName, bytes(Uint8Array), meta, builtin}
let fontsSaved = true;
// 사이트에 들어 있는 기본 글꼴 — 어느 기기에서 열어도 따로 고를 필요 없음
const DEFAULT_FONTS = {
  bR: 'fonts/KoPubWorld_Batang_Pro_Medium.otf',
  bB: 'fonts/KoPubWorld_Batang_Pro_Bold.otf',
  gR: 'fonts/AppleSDGothicNeo-Medium.ttf',
  gB: 'fonts/AppleSDGothicNeo-SemiBold.ttf',
};
let fontsLoading = false;
let fontsReady = Promise.resolve();
async function loadDefaultFonts() {
  const need = SLOTS.filter((s) => !fonts[s]);
  if (!need.length) return;
  fontsLoading = true;
  renderSlots();
  const failed = [];
  await Promise.all(need.map(async (s) => {
    try {
      const r = await fetch(DEFAULT_FONTS[s]);
      if (!r.ok) throw new Error(r.status);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (!fonts[s]) fonts[s] = { fileName: DEFAULT_FONTS[s].split('/').pop(), bytes, meta: readFontMeta(bytes), builtin: true };
    } catch (e) { failed.push(s); }
  }));
  fontsLoading = false;
  if (failed.length) toast('기본 글꼴 일부를 받지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.', 5000);
}

async function loadSavedFonts() {
  for (const s of SLOTS) {
    try {
      const v = await idb.get(s);
      if (v && v.bytes) fonts[s] = { fileName: v.fileName, bytes: new Uint8Array(v.bytes), meta: readFontMeta(new Uint8Array(v.bytes)), builtin: false };
    } catch (e) { fontsSaved = false; }
  }
}

async function setFont(slot, file, bytes) {
  const meta = readFontMeta(bytes);
  fonts[slot] = { fileName: file.name, bytes, meta, builtin: false };
  try { await idb.put(slot, { fileName: file.name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  catch (e) { fontsSaved = false; }
}

const faceLoaded = {};
async function previewFace(slot) {
  const f = fonts[slot];
  if (!f || typeof FontFace === 'undefined') return null;
  const fam = `fs-${slot}-${f.meta.postscript || 'x'}`.replace(/[^A-Za-z0-9-]/g, '');
  if (faceLoaded[slot] === fam) return fam;
  try {
    const ff = new FontFace(fam, f.bytes);
    await ff.load();
    document.fonts.add(ff);
    faceLoaded[slot] = fam;
    return fam;
  } catch (e) { return null; }
}

async function renderSlots() {
  const box = $('#slots');
  box.textContent = '';
  for (const s of SLOTS) {
    const f = fonts[s];
    const b = el('button', { class: 'slot' + (f ? '' : ' empty'), type: 'button', 'data-slot': s, 'aria-label': `${SLOT_TEXT[s]} 글꼴 ${f ? f.meta.full : '없음'} — 눌러서 바꾸기` },
      el('div', { class: 'lab' }, SLOT_TEXT[s], s === 'bR' ? el('span', { class: 'star', title: '기본 본문' }, '기본 본문') : null),
      el('div', { class: 'sample' }, f ? SAMPLE : fontsLoading ? '기본 글꼴 받는 중…' : '눌러서 글꼴 고르기'),
      el('div', { class: 'fname' }, f ? `${f.meta.koFamily || f.meta.full}${f.builtin ? ' · 기본' : ' · 내가 고름'}` : ''));
    b.addEventListener('click', () => { pendingSlot = s; $('#slotInput').click(); });
    box.append(b);
    if (f) previewFace(s).then((fam) => { if (fam) b.querySelector('.sample').style.fontFamily = `"${fam}", sans-serif`; });
  }
  const mine = SLOTS.filter((s) => fonts[s] && !fonts[s].builtin).length;
  $('#fontSub').textContent = fontsLoading ? '기본 글꼴을 받는 중이에요(처음 한 번만). 그동안 파일을 넣어 둬도 돼요.'
    : mine ? `기본 글꼴에 더해 ${mine}칸은 내가 고른 글꼴(이 기기에만 저장)을 써요.`
    : '기본 글꼴 4개가 들어 있어서 바로 쓰면 돼요. 칸을 누르면 다른 글꼴로 바꿀 수 있어요.';
  $('#resetFonts').hidden = !mine;
  engineFontsDirty = true;
}

let pendingSlot = null;
$('#resetFonts').addEventListener('click', async () => {
  for (const s of SLOTS) {
    if (fonts[s] && !fonts[s].builtin) { delete fonts[s]; delete faceLoaded[s]; try { await idb.del(s); } catch (e) { /* */ } }
  }
  fontsReady = loadDefaultFonts().then(renderSlots);
  await fontsReady;
  toast('기본 글꼴로 되돌렸어요');
});
$('#pickFonts').addEventListener('click', () => $('#fontInput').click());
$('#fontInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const loaded = [];
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const meta = readFontMeta(bytes);
      loaded.push({ f, bytes, meta, g: guessSlot(meta, f.name) });
    } catch (err) { toast(`${f.name}: ${err.message}`); }
  }
  // 자리 정하기: 이름으로 계열·굵기 추측 → 빈 칸 채우기
  const taken = new Set();
  const assign = [];
  for (const L of loaded) {
    if (!L.g.fam) continue;
    const s = L.g.fam + (L.g.bold ? 'B' : 'R');
    if (!taken.has(s)) { taken.add(s); assign.push([s, L]); L.done = true; }
  }
  for (const L of loaded) {
    if (L.done) continue;
    const s = SLOTS.find((x) => !taken.has(x) && (!L.g.fam || x[0] === L.g.fam));
    if (s) { taken.add(s); assign.push([s, L]); }
  }
  for (const [s, L] of assign) await setFont(s, L.f, L.bytes);
  await renderSlots();
  toast(assign.length ? `글꼴 ${assign.length}개를 넣었어요: ` + assign.map(([s]) => SLOT_TEXT[s]).join(', ') : '넣을 수 있는 글꼴이 없어요');
  requestPersist();
});
$('#slotInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !pendingSlot) return;
  try {
    await setFont(pendingSlot, f, new Uint8Array(await f.arrayBuffer()));
    await renderSlots();
    toast(`${SLOT_TEXT[pendingSlot]}: ${fonts[pendingSlot].meta.full}`);
  } catch (err) { toast(err.message); }
  requestPersist();
});
function requestPersist() { try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* */ } }

// ---------------------------------------------------------------- 설정
const settings = Object.assign({ mode: 'keep', ocr: 'auto', italic: true, keepMono: true }, store.get('settings', {}));
function applySettingsUI() {
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === settings.mode;
  for (const r of document.querySelectorAll('input[name=ocr]')) r.checked = r.value === settings.ocr;
  $('#optItalic').checked = settings.italic;
  $('#optMono').checked = settings.keepMono;
  const modeTxt = { keep: '원래 계열 따라', body: '본문 바탕·제목 고딕', 'all-b': '전부 바탕', 'all-g': '전부 고딕' }[settings.mode];
  const ocrTxt = { auto: 'OCR 자동', all: 'OCR 모든 쪽', off: 'OCR 끔' }[settings.ocr];
  $('#settingsNow').textContent = `${modeTxt} · ${ocrTxt}`;
}
document.querySelectorAll('input[name=mode], input[name=ocr], #optItalic, #optMono').forEach((i) => i.addEventListener('change', () => {
  settings.mode = document.querySelector('input[name=mode]:checked').value;
  settings.ocr = document.querySelector('input[name=ocr]:checked').value;
  settings.italic = $('#optItalic').checked;
  settings.keepMono = $('#optMono').checked;
  store.set('settings', settings);
  applySettingsUI();
}));

// ---------------------------------------------------------------- 엔진(워커)
let engine = null;
let engineFontsDirty = true;
let rid = 0;
const replies = new Map();
const progressHandlers = new Map();
function getEngine() {
  if (engine) return engine;
  engine = new Worker(new URL('./engine/worker.js?v=3', import.meta.url), { type: 'module' });
  engine.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'reply') { const r = replies.get(m.rid); replies.delete(m.rid); if (r) (m.ok ? r.res(m.data) : r.rej(new Error(m.error))); }
    else if (m.type === 'progress') { const h = progressHandlers.get(m.id); if (h) h(m); }
    else if (m.type === 'ocr') runOcrJob(m);
  };
  engine.onerror = (e) => { console.error(e); for (const r of replies.values()) r.rej(new Error('처리 엔진을 불러오지 못했어요. 새로고침해 주세요.')); replies.clear(); };
  return engine;
}
function call(type, payload = {}, transfer = []) {
  const w = getEngine();
  return new Promise((res, rej) => {
    const id = ++rid;
    replies.set(id, { res, rej });
    w.postMessage({ type, rid: id, ...payload }, transfer);
  });
}
async function syncEngineFonts() {
  if (!engineFontsDirty) return;
  const list = {};
  for (const s of SLOTS) if (fonts[s]) list[s] = { bytes: fonts[s].bytes.slice(), psname: fonts[s].meta.postscript };
  await call('setFonts', { fonts: list });
  engineFontsDirty = false;
}

// ---------------------------------------------------------------- OCR (Tesseract)
let schedP = null;
function ocrWorkers() {
  const c = navigator.hardwareConcurrency || 4;
  if (isApple) return Math.min(2, c);
  return Math.max(1, Math.min(4, c - 1));
}
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('불러오기 실패: ' + src)); document.head.append(s); });
}
function getScheduler() {
  if (schedP) return schedP;
  schedP = (async () => {
    await loadScript('vendor/tesseract/tesseract.min.js');
    const T = window.Tesseract;
    const sched = T.createScheduler();
    const base = new URL('.', location.href).href;
    const n = ocrWorkers();
    const make = async () => {
      const w = await T.createWorker(['kor', 'eng'], 1, {
        workerPath: base + 'vendor/tesseract/worker.min.js',
        corePath: base + 'vendor/tesseract/core',
        langPath: base + 'ocr/lang',
        gzip: true,
      });
      sched.addWorker(w);
    };
    await make();
    // 나머지는 뒤에서 늘리기
    (async () => { for (let i = 1; i < n; i++) { try { await make(); } catch (e) { break; } } })();
    return sched;
  })();
  schedP.catch(() => { schedP = null; });
  return schedP;
}
async function runOcrJob(m) {
  let data = null;
  try {
    const sched = await getScheduler();
    const blob = new Blob([m.png], { type: 'image/png' });
    const r = await sched.addJob('recognize', blob, {}, { blocks: true, text: true });
    data = tessToLines(r.data, m.img, { minConf: 45 });
  } catch (e) {
    console.warn('OCR 실패', e);
    data = { lines: [], error: e.message };
  }
  engine.postMessage({ type: 'ocrResult', job: m.job, data });
}

// ---------------------------------------------------------------- 파일 처리
const queue = [];
let busy = false;
let fileSeq = 0;
const items = [];

function kindOf(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.pptx')) return 'pptx';
  if (n.endsWith('.docx')) return 'docx';
  return null;
}
function outName(name, kind) {
  const base = name.normalize('NFC').replace(/\.[^.]+$/, '');
  return `${base}_글꼴.${kind}`;
}

function addFiles(list) {
  const files = [...list].filter((f) => kindOf(f.name));
  const skipped = list.length - files.length;
  if (skipped) toast(`${skipped}개는 PDF/PPTX/DOCX가 아니라서 뺐어요`);
  if (!files.length) return;
  for (const f of files) {
    const it = { id: 'f' + ++fileSeq, file: f, kind: kindOf(f.name), name: f.name.normalize('NFC'), state: 'wait', overrides: {} };
    items.push(it);
    it.card = renderItem(it);
    $('#files').prepend(it.card);
    queue.push(it);
  }
  $('#bulk').hidden = false;
  pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  let wake = null;
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
  await fontsReady;
  while (queue.length) {
    const it = queue.shift();
    if (!SLOTS.some((s) => fonts[s])) { it.state = 'error'; it.error = '글꼴을 불러오지 못했어요. 새로고침해 주세요.'; const f = renderItem(it); it.card.replaceWith(f); it.card = f; continue; }
    await processItem(it);
  }
  busy = false;
  try { wake && wake.release(); } catch (e) { /* */ }
  updateBulk();
}

const STAGE = { scan: '글꼴 찾는 중', rewrite: '글꼴 바꾸는 중', ocr: 'OCR', save: '저장 중' };
async function processItem(it) {
  it.state = 'run';
  setStatus(it, '준비 중…', 2);
  const opts = { mode: settings.mode, keepMono: settings.keepMono, italic: settings.italic, overrides: it.overrides, ocr: settings.ocr };
  try {
    const bytes = new Uint8Array(await it.file.arrayBuffer());
    const t0 = performance.now();
    if (it.kind === 'pdf') {
      await syncEngineFonts();
      progressHandlers.set(it.id, (m) => {
        const frac = m.total ? m.done / m.total : 0;
        const pct = m.stage === 'scan' ? 2 + frac * 12 : m.stage === 'rewrite' ? 14 + frac * 26 : m.stage === 'ocr' ? 40 + frac * 52 : 92 + frac * 8;
        setStatus(it, m.stage === 'ocr' ? `OCR ${m.done}/${m.total} 곳` : `${STAGE[m.stage] || m.stage} ${m.total > 1 ? `${m.done}/${m.total}쪽` : ''}`, pct);
      });
      const r = await call('convert', { id: it.id, bytes, options: { ...opts, ocrParallel: ocrWorkers() * 2 } }, [bytes.buffer]);
      progressHandlers.delete(it.id);
      it.out = new Blob([r.pdf], { type: 'application/pdf' });
      it.report = r.report;
      it.origLoaded = false;
      markOpen(it);
    } else {
      const meta = {};
      for (const s of SLOTS) if (fonts[s]) meta[s] = fonts[s].meta;
      for (const s of SLOTS) if (!meta[s]) { const alt = [s[0] + (s[1] === 'B' ? 'R' : 'B'), (s[0] === 'g' ? 'b' : 'g') + s[1]].find((k) => fonts[k]); if (alt) meta[s] = fonts[alt].meta; }
      setStatus(it, '글꼴 이름 바꾸는 중…', 30);
      const env = { JSZip: window.JSZip, DOMParser, XMLSerializer };
      const fn = it.kind === 'pptx' ? convertPptx : convertDocx;
      const r = await fn(env, bytes, meta, opts);
      const mime = it.kind === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      it.out = new Blob([r.bytes], { type: mime });
      it.report = r.report;
    }
    it.ms = performance.now() - t0;
    it.state = 'done';
  } catch (e) {
    console.error(e);
    it.state = 'error';
    it.error = e.message || String(e);
  }
  progressHandlers.delete(it.id);
  const fresh = renderItem(it);
  it.card.replaceWith(fresh);
  it.card = fresh;
}

function setStatus(it, text, pct) {
  const s = it.card.querySelector('.status');
  if (s) s.textContent = text;
  const b = it.card.querySelector('.bar > i');
  if (b && pct != null) b.style.width = Math.min(100, pct).toFixed(1) + '%';
}

function summarize(it) {
  const r = it.report;
  const chips = [];
  if (r.kind === 'pdf') {
    const rep = r.pages.reduce((s, p) => s + p.replaced, 0);
    const kept = r.pages.reduce((s, p) => s + p.kept, 0);
    const ocrPages = r.pages.filter((p) => p.ocr);
    const ocrChunks = ocrPages.reduce((s, p) => s + (p.ocr.chunks || 0), 0);
    const empty = r.pages.filter((p) => !p.searchable).length;
    chips.push(el('span', { class: 'pill ok' }, `글자 ${fmtNum(rep)}개 바뀜`));
    if (kept) chips.push(el('span', { class: 'pill', title: '기호 글꼴, 고정폭, 새 글꼴에 없는 글자, 이미 있던 OCR 글자층 등' }, `${fmtNum(kept)}개 그대로`));
    if (ocrPages.length) {
      const confs = ocrPages.filter((p) => p.ocr.chunks).map((p) => p.ocr.conf);
      const avg = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : 0;
      chips.push(el('span', { class: 'pill acc' }, `OCR ${ocrPages.length}쪽 · ${fmtNum(ocrChunks)}낱말${avg ? ` · 신뢰도 ${avg}%` : ''}`));
    }
    if (empty) chips.push(el('span', { class: 'pill warn' }, `검색 안 되는 쪽 ${empty}`));
    chips.push(el('span', { class: 'pill' }, `${r.pages.length}쪽 · ${fmtSize(r.inSize)} → ${fmtSize(r.outSize)}`));
  } else {
    const changed = r.fonts.reduce((s, f) => s + Object.values(f.slots).reduce((a, b) => a + b, 0), 0);
    chips.push(el('span', { class: 'pill ok' }, `글자 ${fmtNum(changed)}개 바뀜`));
    if (r.kind === 'pptx') chips.push(el('span', { class: 'pill' }, `슬라이드 ${r.slides}장`));
    chips.push(el('span', { class: 'pill' }, fmtSize(it.out.size)));
  }
  return chips;
}

const FAM_LABEL = { gothic: '고딕', batang: '바탕', symbol: '기호', mono: '고정폭', unknown: '모름' };
function fontTable(it) {
  const r = it.report;
  const rows = (r.fonts || []).filter((f) => (f.glyphs || f.count || 0) > 0).sort((a, b) => (b.glyphs || b.count) - (a.glyphs || a.count));
  if (!rows.length) return null;
  const tbl = el('table', { class: 'ftable' },
    el('thead', {}, el('tr', {}, el('th', {}, '원래 글꼴'), el('th', {}, '판별'), el('th', {}, '바뀐 글꼴'), el('th', {}, '바꾸기'))));
  const tb = el('tbody');
  for (const f of rows) {
    const name = f.name;
    const fam = f.family || (f.cls && f.cls.family) || 'unknown';
    const bold = f.bold != null ? f.bold : f.cls && f.cls.bold;
    const slots = Object.entries(f.slots || {}).sort((a, b) => b[1] - a[1]).map(([s]) => SLOT_LABEL[s]).join(', ');
    const sel = el('select', { 'aria-label': `${name} 바꾸기` },
      ...[['auto', '자동'], ['gothic', '고딕으로'], ['batang', '바탕으로'], ['keep', '그대로']].map(([v, t]) => el('option', { value: v }, t)));
    sel.value = it.overrides[name] || 'auto';
    sel.addEventListener('change', () => { it.overrides[name] = sel.value; it.card.querySelector('.redo').hidden = false; });
    const why = f.ok === false ? ` · ${f.reason}` : '';
    tb.append(el('tr', {},
      el('td', { class: 'fn' }, name),
      el('td', {}, `${FAM_LABEL[fam] || fam}${bold ? ' 굵게' : ''}${why}`),
      el('td', {}, slots || '그대로'),
      el('td', {}, sel)));
  }
  tbl.append(tb);
  return tbl;
}

function renderItem(it) {
  const kindLab = it.kind.toUpperCase();
  const card = el('div', { class: 'file' });
  const head = el('div', { class: 'head' },
    el('div', { class: 'kind ' + it.kind }, kindLab),
    el('div', { class: 'meta' }, el('div', { class: 'name' }, it.name), el('div', { class: 'status' + (it.state === 'error' ? ' err' : '') },
      it.state === 'wait' ? '기다리는 중' : it.state === 'run' ? '처리 중…' : it.state === 'error' ? '실패: ' + it.error : `완료 · ${(it.ms / 1000).toFixed(1)}초`)));
  card.append(head);
  if (it.state === 'wait' || it.state === 'run') card.append(el('div', { class: 'bar' }, el('i')));
  if (it.state === 'done') {
    card.append(el('div', { class: 'chips' }, ...summarize(it)));
    const actions = el('div', { class: 'actions' });
    actions.append(el('button', { class: 'btn primary small', type: 'button', onclick: () => download(it) }, '받기'));
    if (canShare(it)) actions.append(el('button', { class: 'btn small', type: 'button', onclick: () => share([it]) }, '공유'));
    if (it.kind === 'pdf') actions.append(el('button', { class: 'btn small', type: 'button', onclick: () => openViewer(it) }, '검사하기'));
    actions.append(el('button', { class: 'btn small redo', type: 'button', hidden: true, onclick: () => redo(it) }, '이 설정으로 다시 변환'));
    card.append(actions);
    const t = fontTable(it);
    if (t) card.append(el('details', {}, el('summary', {}, '글꼴별로 보기 · 바꾸기'), t,
      it.kind !== 'pdf' ? el('p', { class: 'note' }, '파워포인트·워드에서 이 글꼴로 보이려면 그 컴퓨터에 글꼴이 설치돼 있어야 해요.') : null));
  }
  if (it.state === 'error') {
    card.append(el('div', { class: 'actions' }, el('button', { class: 'btn small', type: 'button', onclick: () => redo(it) }, '다시 해 보기')));
  }
  return card;
}

function redo(it) {
  if (it.state === 'run') return;
  it.state = 'wait';
  it.out = null; it.report = null;
  it.workerOpen = false;
  call('close', { id: it.id }).catch(() => {});
  const fresh = renderItem(it);
  it.card.replaceWith(fresh); it.card = fresh;
  queue.push(it);
  pump();
}

function fileOf(it) { return new File([it.out], outName(it.name, it.kind), { type: it.out.type }); }
function canShare(it) {
  try { return !!(navigator.canShare && navigator.canShare({ files: [fileOf(it)] })); } catch (e) { return false; }
}
async function share(list) {
  try { await navigator.share({ files: list.map(fileOf) }); }
  catch (e) { if (e.name !== 'AbortError') toast('공유하지 못했어요: ' + e.message); }
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function download(it) { saveBlob(it.out, outName(it.name, it.kind)); }
function updateBulk() {
  const done = items.filter((i) => i.state === 'done');
  $('#zipAll').disabled = done.length < 2;
  const sh = $('#shareAll');
  sh.hidden = !(done.length > 1 && navigator.canShare && (() => { try { return navigator.canShare({ files: done.map(fileOf) }); } catch (e) { return false; } })());
}
$('#zipAll').addEventListener('click', async () => {
  const done = items.filter((i) => i.state === 'done');
  if (!done.length) return;
  const zip = new window.JSZip();
  const used = new Set();
  for (const it of done) {
    let n = outName(it.name, it.kind), k = 2;
    while (used.has(n)) n = n.replace(/(\.\w+)$/, ` (${k++})$1`);
    used.add(n);
    zip.file(n, it.out);
  }
  toast('ZIP 만드는 중…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  saveBlob(blob, '글꼴바꾼_강의자료.zip');
});
$('#shareAll').addEventListener('click', () => share(items.filter((i) => i.state === 'done')));
$('#clearAll').addEventListener('click', () => {
  for (const it of [...items]) {
    if (it.state === 'run' || it.state === 'wait') continue;
    call('close', { id: it.id }).catch(() => {});
    it.card.remove();
    items.splice(items.indexOf(it), 1);
  }
  if (!items.length) $('#bulk').hidden = true;
});

// 파일 넣기
const drop = $('#drop');
drop.addEventListener('click', () => $('#fileInput').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', async (e) => {
  const list = [];
  const entries = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.some((en) => en.isDirectory)) {
    const walk = async (en) => {
      if (en.isFile) { await new Promise((r) => en.file((f) => { list.push(f); r(); }, r)); return; }
      if (en.isDirectory) {
        const rd = en.createReader();
        let batch;
        do { batch = await new Promise((r) => rd.readEntries(r, () => r([]))); for (const c of batch) await walk(c); } while (batch.length);
      }
    };
    for (const en of entries) await walk(en);
  } else list.push(...e.dataTransfer.files);
  addFiles(list);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// 엔진 안에 열어 둔 결과(미리보기·검색용)는 최근 2개만 — 아이패드 메모리 아끼기
const openIds = [];
function markOpen(it) {
  it.workerOpen = true;
  const k = openIds.indexOf(it);
  if (k >= 0) openIds.splice(k, 1);
  openIds.push(it);
  while (openIds.length > 2) {
    const old = openIds.shift();
    if (old === V.it) { openIds.push(old); continue; }
    old.workerOpen = false;
    call('close', { id: old.id }).catch(() => {});
  }
}
async function ensureOpen(it) {
  if (it.workerOpen) { markOpen(it); return; }
  const out = new Uint8Array(await it.out.arrayBuffer());
  await call('open', { id: it.id, out, report: it.report }, [out.buffer]);
  it.origLoaded = false;
  markOpen(it);
}
async function ensureOrig(it) {
  if (it.origLoaded) return;
  const orig = new Uint8Array(await it.file.arrayBuffer());
  await call('loadOrig', { id: it.id, orig }, [orig.buffer]);
  it.origLoaded = true;
}
async function renderPage(it, page, width) {
  const which = $('#vOrig').checked ? 'orig' : 'out';
  if (which === 'orig') await ensureOrig(it);
  return call('render', { id: it.id, which, page, width });
}

// ---------------------------------------------------------------- 검사 화면
const V = { it: null, page: -1, hits: new Map(), query: '', thumbObs: null, thumbs: [] };
const viewer = $('#viewer');

async function openViewer(it) {
  try { await ensureOpen(it); } catch (e) { toast('결과를 열지 못했어요: ' + e.message); return; }
  V.it = it; V.page = -1; V.hits = new Map(); V.query = '';
  $('#vTitle').textContent = it.name;
  $('#vQuery').value = '';
  $('#vOrig').checked = false;
  viewer.classList.add('open');
  document.body.style.overflow = 'hidden';
  buildGrid();
  showSummary();
  history.pushState({ viewer: true }, '');
}
function closeViewer() {
  viewer.classList.remove('open');
  document.body.style.overflow = '';
  if (V.thumbObs) V.thumbObs.disconnect();
  for (const u of V.thumbs) URL.revokeObjectURL(u);
  V.thumbs = [];
  V.it = null;
}
$('#vBack').addEventListener('click', () => { if (V.page >= 0) showGrid(); else history.back(); });
window.addEventListener('popstate', () => { if (viewer.classList.contains('open')) closeViewer(); });
$('#vDownload').addEventListener('click', () => V.it && download(V.it));
document.addEventListener('keydown', (e) => {
  if (!viewer.classList.contains('open') || V.page < 0 || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') gotoPage(V.page - 1);
  if (e.key === 'ArrowRight') gotoPage(V.page + 1);
  if (e.key === 'Escape') showGrid();
});

function showSummary() {
  const r = V.it.report;
  const s = $('#vSum');
  s.textContent = '';
  const ocrP = r.pages.filter((p) => p.ocr);
  const none = r.pages.filter((p) => !p.searchable).length;
  s.append(el('span', {}, `${r.pages.length}쪽`));
  if (ocrP.length) s.append(el('span', { class: 'pill acc' }, `OCR ${ocrP.length}쪽`));
  if (none) s.append(el('span', { class: 'pill warn' }, `검색되는 글자 없는 쪽 ${none}`));
  if (V.query) {
    const total = [...V.hits.values()].reduce((a, b) => a + b.length, 0);
    s.append(el('span', { class: 'pill ' + (total ? 'ok' : 'err') }, total ? `"${V.query}" ${total}곳 · ${V.hits.size}쪽` : `"${V.query}" 검색 안 됨`));
  } else s.append(el('span', {}, '낱말을 검색해서 실제로 찾아지는지 확인해 보세요.'));
}

function badgesFor(p) {
  const b = [];
  const hits = V.hits.get(p.page);
  if (hits) b.push(el('span', { class: 'pill ok' }, `찾음 ${hits.length}`));
  if (!p.searchable) b.push(el('span', { class: 'pill warn' }, '검색 글자 없음'));
  else b.push(el('span', { class: 'pill' }, `글자 ${fmtNum(p.searchable)}`));
  if (p.ocr) {
    const cls = !p.ocr.chunks ? 'warn' : p.ocr.conf >= 80 ? 'ok' : p.ocr.conf >= 65 ? 'acc' : 'warn';
    b.push(el('span', { class: 'pill ' + cls }, p.ocr.chunks ? `OCR ${p.ocr.chunks} · ${p.ocr.conf}%` : 'OCR 0'));
  }
  return b;
}

function buildGrid() {
  const grid = $('#vGrid');
  grid.textContent = '';
  if (V.thumbObs) V.thumbObs.disconnect();
  V.thumbObs = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (!en.isIntersecting) continue;
      V.thumbObs.unobserve(en.target);
      loadThumb(en.target);
    }
  }, { root: $('#vBody'), rootMargin: '400px' });
  for (const p of V.it.report.pages) {
    const t = el('button', { class: 'thumb', type: 'button', 'data-page': p.page, onclick: () => gotoPage(p.page) },
      el('div', { class: 'pic' }),
      el('div', { class: 'pno' }, el('span', {}, `${p.page + 1}쪽`)),
      el('div', { class: 'badges' }, ...badgesFor(p)));
    grid.append(t);
    V.thumbObs.observe(t);
  }
  showGrid();
}
function refreshBadges() {
  for (const t of $('#vGrid').children) {
    const p = V.it.report.pages[+t.dataset.page];
    const b = t.querySelector('.badges');
    b.textContent = '';
    b.append(...badgesFor(p));
    t.classList.toggle('hit', V.hits.has(p.page));
    t.classList.toggle('dim', !!V.query && !V.hits.has(p.page));
  }
}
async function loadThumb(t) {
  const page = +t.dataset.page;
  const it = V.it;
  try {
    const d = await renderPage(it, page, Math.round(200 * Math.min(2, devicePixelRatio || 1)));
    if (V.it !== it) return;
    const u = URL.createObjectURL(new Blob([d.png], { type: 'image/png' }));
    V.thumbs.push(u);
    const pic = t.querySelector('.pic');
    pic.textContent = '';
    pic.append(el('img', { src: u, alt: `${page + 1}쪽`, loading: 'lazy' }));
  } catch (e) { /* 무시 */ }
}
function showGrid() {
  V.page = -1;
  $('#vGrid').hidden = false;
  $('#vPage').classList.remove('open');
  $('#vBackLabel').textContent = '닫기';
}

async function gotoPage(i) {
  const pages = V.it.report.pages;
  if (i < 0 || i >= pages.length) return;
  V.page = i;
  $('#vGrid').hidden = true;
  $('#vPage').classList.add('open');
  $('#vBackLabel').textContent = '전체';
  $('#pInfo').textContent = `${i + 1} / ${pages.length}쪽`;
  $('#pPrev').disabled = i === 0;
  $('#pNext').disabled = i === pages.length - 1;
  $('#vBody').scrollTop = 0;
  await drawPage();
}
$('#pPrev').addEventListener('click', () => gotoPage(V.page - 1));
$('#pNext').addEventListener('click', () => gotoPage(V.page + 1));
$('#pGrid').addEventListener('click', showGrid);
$('#vOrig').addEventListener('change', () => {
  for (const u of V.thumbs) URL.revokeObjectURL(u);
  V.thumbs = [];
  if (V.page >= 0) drawPage();
  for (const t of $('#vGrid').children) { t.querySelector('.pic').textContent = ''; V.thumbObs.observe(t); }
});
$('#vOcr').addEventListener('change', () => V.page >= 0 && drawOverlay());

let pageUrl = null;
async function drawPage() {
  const it = V.it, i = V.page;
  const stage = $('#pStage');
  const w = Math.round(Math.min(stage.clientWidth || 900, 1400) * Math.min(2, devicePixelRatio || 1));
  const d = await renderPage(it, i, w);
  if (V.it !== it || V.page !== i) return;
  if (pageUrl) URL.revokeObjectURL(pageUrl);
  pageUrl = URL.createObjectURL(new Blob([d.png], { type: 'image/png' }));
  $('#pImg').src = pageUrl;
  V.bounds = d.bounds;
  drawOverlay();
  // 글자
  const pre = $('#pText');
  pre.textContent = '불러오는 중…';
  try { const t = await call('pageText', { id: it.id, page: i }); pre.textContent = t.trim() || '(검색되는 글자가 없어요)'; }
  catch (e) { pre.textContent = '(읽지 못함)'; }
  const p = it.report.pages[i];
  const list = $('#pOcrList');
  list.textContent = '';
  $('#pOcrInfo').textContent = p.ocr ? (p.ocr.chunks ? `${p.ocr.chunks}낱말 · 평균 ${p.ocr.conf}%` : '찾은 글자 없음') : (p.invisibleBefore ? '원래 있던 OCR 사용' : 'OCR 안 함');
  if (p.ocr) for (const l of p.ocr.lines) for (const c of l.chunks) {
    const cl = c.conf >= 80 ? 'hi' : c.conf >= 65 ? 'mid' : 'lo';
    list.append(el('span', { class: cl, title: `신뢰도 ${c.conf}% — 눌러서 검색`, onclick: () => { $('#vQuery').value = c.text; runSearch(c.text, true); } }, c.text));
  }
}
function drawOverlay() {
  const ov = $('#pOv');
  ov.textContent = '';
  const b = V.bounds;
  if (!b) return;
  const W = b[2] - b[0], H = b[3] - b[1];
  const place = (r, cls, title) => {
    const d = el('div', { class: cls, title: title || null });
    d.style.left = ((r[0] - b[0]) / W * 100) + '%';
    d.style.top = ((r[1] - b[1]) / H * 100) + '%';
    d.style.width = ((r[2] - r[0]) / W * 100) + '%';
    d.style.height = ((r[3] - r[1]) / H * 100) + '%';
    ov.append(d);
  };
  const p = V.it.report.pages[V.page];
  if ($('#vOcr').checked && p.ocr && !$('#vOrig').checked) {
    for (const l of p.ocr.lines) for (const c of l.chunks) place(c.box, 'ocrbox ' + (c.conf >= 80 ? 'hi' : c.conf >= 65 ? 'mid' : 'lo'), `${c.text} (${c.conf}%)`);
  }
  const hits = V.hits.get(V.page);
  if (hits && !$('#vOrig').checked) for (const group of hits) for (const r of group) place(r, 'hlbox');
}

async function runSearch(q, stay) {
  q = q.trim();
  V.query = q;
  V.hits = new Map();
  if (q) {
    const res = await call('search', { id: V.it.id, query: q });
    for (const h of res) V.hits.set(h.page, h.quads);
  }
  showSummary();
  refreshBadges();
  if (V.page >= 0) drawOverlay();
  if (!stay && q && V.hits.size && V.page >= 0 && !V.hits.has(V.page)) gotoPage([...V.hits.keys()][0]);
}
$('#vSearch').addEventListener('submit', (e) => { e.preventDefault(); $('#vQuery').blur(); runSearch($('#vQuery').value); });

// ---------------------------------------------------------------- 시작
applySettingsUI();
(async () => {
  try { await loadSavedFonts(); } catch (e) { fontsSaved = false; }
  fontsReady = loadDefaultFonts().then(renderSlots);
  await fontsReady;
})();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}
