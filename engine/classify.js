// 글꼴 이름 → 계열(고딕/바탕/기호/고정폭/모름) + 굵기 판별. PDF·PPTX·DOCX 공통.

const SYMBOL = [
  'symbol', 'wingding', 'webding', 'dingbat', 'zapf', 'marlett', 'mtextra', 'mathematicalpi', 'euclid',
  'cambriamath', 'stix', 'mathjax', 'cmsy', 'cmex', 'msam', 'msbm', 'emoji', 'fontawesome', 'materialicons',
  'materialsymbols', 'segoeuisymbol', 'segoemdl2', 'segoefluent', 'msreferencespecialty', 'monotypesorts', 'bookshelfsymbol',
  'opensymbol', 'starsymbol', 'holtwood', 'glyphicons', 'icomoon', 'pictos', 'mtsymbol', 'symbolmt',
];
const MONO = [
  'courier', 'consola', 'menlo', 'monaco', 'mono', 'lucidaconsole', 'lucidatypewriter', 'andalemono', 'd2coding',
  'sourcecode', 'firacode', 'inconsolata', 'jetbrains', 'cascadia', 'typewriter', 'ocr-a', 'ocrb', 'letter gothic',
  'lettergothic', 'fixedsys', 'cmtt', 'nimbusmono',
];
// 바탕(명조·세리프) 계열
const SERIF = [
  'batang', '바탕', 'myeongjo', 'myungjo', 'myeongcho', 'mincho', '명조', 'gungsuh', 'gungseo', '궁서', 'sinmyeong', 'shinmyeong',
  '신명조', 'hysinmyeongjo', 'hymyeongjo', 'hcrbatang', '함초롬바탕', '한컴바탕', 'kopubbatang', 'kopubworldbatang', 'nanummyeongjo',
  '나눔명조', 'mapobackpacking', 'jeju myeongjo', 'jejumyeongjo', '제주명조', 'chosun', '조선일보명조', 'hanbatang', 'unbatang', '은바탕',
  'songti', 'simsun', 'nsimsun', 'mingliu', 'pmingliu', 'serif', 'times', 'georgia', 'garamond', 'cambria', 'constantia',
  'palatino', 'palatin', 'bookantiqua', 'bookman', 'centuryschoolbook', 'newcentury', 'baskerville', 'bodoni', 'didot', 'minion',
  'caslon', 'utopia', 'charter', 'sabon', 'janson', 'plantin', 'perpetua', 'goudy', 'cochin', 'hoefler', 'iowan', 'lora',
  'merriweather', 'playfair', 'ptserif', 'notoserif', 'sourceserif', 'sourcehanserif', '본명조', 'libertine', 'linux libertine',
  'cmr', 'cmbx', 'cmti', 'lmroman', 'latinmodernroman', 'nimbusroman', 'texgyretermes', 'texgyrepagella', 'stixtwo', 'dejavuserif',
  'liberationserif', 'gelasio', 'tinos', 'bell mt', 'bellmt', 'californian', 'calisto', 'centaur', 'elephant', 'footlight', 'rockwell',
  'bernard', 'modern no', 'high tower', 'informal roman', 'sylfaen',
  'yumincho', 'msmincho', 'kozuka mincho', 'kozminpro', 'adobemyungjo', 'adobemingstd', 'adobesongstd', 'smmyeongjo', 'sm신명조',
  'sandollmyeongjo', '산돌명조', '윤명조', 'yoonmyeongjo', 'yunmyeongjo', 'kbiz한마음명조', 'kbizhanmaeummyungjo', 'ridibatang', '리디바탕',
  'maruburi', '마루부리', 'gowunbatang', '고운바탕', 'songmyung', '송명', 'hahmlet', '함렛', 'nanumgarunjung', 'iropke', '이롭게바탕',
];
// 고딕(돋움·산세리프) 계열
const SANS = [
  'gothic', '고딕', 'malgun', '맑은', 'dotum', '돋움', 'gulim', '굴림', 'nanumgothic', 'nanumsquare', 'nanumbarun', '나눔고딕',
  '나눔스퀘어', '나눔바른', 'nanumbarunpen', 'nanumpen', 'notosans', 'sourcehansans', '본고딕', 'pretendard', 'spoqa', 'applesd', 'applegothic',
  'appleneo', 'sdgothic', 'sd산돌고딕', 'kopubdotum', 'kopubworlddotum', 'hcrdotum', '함초롬돋움', '한컴돋움', 'hygothic', 'hy견고딕',
  'hy중고딕', 'hyheadline', 'hy헤드라인', 'hygraphic', 'hy그래픽', '견고딕', '중고딕', '신고딕', '윤고딕', 'yoongothic', 'yungothic', '헤드라인',
  'arial', 'helvetica', 'calibri', 'candara', 'corbel', 'segoe', 'verdana', 'tahoma', 'trebuchet', 'futura', 'avenir', 'gillsans',
  'franklin', 'lato', 'roboto', 'opensans', 'montserrat', 'myriad', 'frutiger', 'univers', 'din', 'sans', 'inter', 'sfpro',
  'sanfrancisco', 'ubuntu', 'dejavusans', 'liberationsans', 'arimo', 'carlito', 'selawik', 'aptos', 'grandview', 'seaford',
  'tenorite', 'bahnschrift', 'leelawadee', 'nirmala', 'gadugi', 'ebrima', 'microsoftyahei', 'yahei', 'jhenghei', 'meiryo',
  'yugothic', 'msgothic', 'mspgothic', 'hiragino kaku', 'hiraginokaku', 'hiraginosans', 'heiti', 'simhei', 'pingfang', 'dengxian',
  'scdream', 's-coredream', '에스코어드림', 'gmarket', 'g마켓', 'tmoney', '티머니', 'ibmplexsans', 'ibm plex sans', 'nexon', '넥슨',
  'suit', 'wanted', '원티드', 'paperlogy', '페이퍼로지', 'escoredream', 'elice', '엘리스', 'jalnan', '잘난', 'baemin', '배민', 'binggrae',
  '빙그레', 'kbiz한마음고딕', 'kbizhanmaeumgothic', 'gowundodum', '고운돋움', 'suite', 'ownglyph', 'cafe24', 'oneshinhan', 'tway',
  'lineseed', 'lgsmart', 'lg스마트', 'sandollgothic', '산돌고딕', 'sandollneo', 'neo고딕', 'neogothic', 'hangeul nuri', '한글누리',
  'humanist', 'optima', 'lucidasans', 'lucidagrande', 'microsoftsansserif', 'mssansserif', 'agency', 'eras', 'berlinsans', 'tw cen',
  'twcen', 'century gothic', 'centurygothic', 'gotham', 'proxima', 'fira sans', 'firasans', 'nunito', 'poppins', 'raleway', 'oswald',
  'pt sans', 'ptsans', 'source sans', 'sourcesans', 'droidsans', 'sinhala', 'nimbussans', 'texgyreheros', 'cmss', 'lmsans',
  'seoul', '서울남산', '서울한강', 'seoulnamsan', 'seoulhangang', 'kopubworld돋움', 'kopub돋움',
];
const BOLD = /(extra|ultra|semi|demi)?bold|black|heavy|bd$|[a-z]b$|eb$|hv$|blk$|w[6-9]$|굵은|볼드|헤비|블랙|견고딕|헤드라인|headline|extra$/;
const LIGHTISH = /(light|thin|hairline|book|regular|medium|roman|normal|semilight|demilight|lt$)/;

// PDF 이름(#xx 탈출, 깨진 EUC-KR/UTF-8)을 사람이 읽을 수 있게.
export function decodeFontName(raw) {
  if (!raw) return '';
  let s = String(raw);
  if (s.includes('#')) s = s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  if (/[\x80-\xff]/.test(s) && !/[^\x00-\xff]/.test(s)) {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
    for (const enc of ['utf-8', 'euc-kr']) {
      try {
        const d = new TextDecoder(enc, { fatal: true }).decode(bytes);
        if (/[가-힣]/.test(d) || enc === 'euc-kr') { s = d; break; }
      } catch (e) { /* 다음 인코딩 */ }
    }
  }
  return s.replace(/^[A-Z]{6}\+/, '');
}

function squash(s) {
  return s.toLowerCase().replace(/[\s_\-.,]+/g, '');
}

function hasAny(sq, low, list) {
  for (const k of list) {
    const kk = squash(k);
    if (sq.includes(kk) || low.includes(k)) return true;
  }
  return false;
}

/**
 * @param {string} rawName  글꼴 이름(BaseFont/typeface)
 * @param {object} hint     {serif, symbolic, fixed, bold, italic, weight} — PDF FontDescriptor 등에서 얻은 단서
 * @returns {{name, family:'gothic'|'batang'|'symbol'|'mono'|'unknown', bold:boolean, italic:boolean, why:string}}
 */
export function classifyFont(rawName, hint = {}) {
  const name = decodeFontName(rawName);
  const low = name.toLowerCase();
  const sq = squash(name);
  let family = 'unknown';
  let why = '이름';
  if (hasAny(sq, low, SYMBOL) && !/arialunicode/.test(sq)) { family = 'symbol'; why = '기호 글꼴'; }
  else if (/^(gulimche|dotumche|batangche|gungsuhche|굴림체|돋움체|바탕체|궁서체)/.test(sq) || hasAny(sq, low, MONO)) { family = 'mono'; why = '고정폭'; }
  else if (/sansserif/.test(sq)) family = 'gothic';
  else if (/serif/.test(sq) && !/sans/.test(sq)) family = 'batang';
  else if (/sans/.test(sq)) family = 'gothic';
  else if (/centurygothic/.test(sq)) family = 'gothic';
  else if (/(바탕|명조|궁서|batang|myeongjo|myungjo|mincho|gungsuh)/.test(sq)) family = 'batang';
  else if (/(고딕|돋움|굴림|gothic|dotum|gulim)/.test(sq)) family = 'gothic';
  else if (hasAny(sq, low, SANS)) family = 'gothic';
  else if (hasAny(sq, low, SERIF)) family = 'batang';
  if (family === 'unknown') {
    if (hint.fixed) { family = 'mono'; why = '고정폭 표시'; }
    else if (hint.serif === true) { family = 'batang'; why = '세리프 표시'; }
    else why = '판별 불가';
  }
  const tail = sq.replace(/(mt|ps|std|pro|pr6n|pr6|ttf|otf)$/g, '');
  let bold = BOLD.test(tail) || /(sb|eb|h|b)00$/.test(tail);
  if (/semilight|demilight/.test(tail)) bold = false;
  if (!bold && (hint.bold || (hint.weight && hint.weight >= 600))) bold = true;
  if (bold && LIGHTISH.test(tail) && !/bold|black|heavy|견고딕|헤드라인|headline|(sb|eb|h|b)00$/.test(tail)) bold = false;
  const italic = /italic|oblique|kursiv|-it$|[a-z]it$|,i$/.test(tail) || !!hint.italic;
  return { name, family, bold, italic, why };
}

/**
 * 계열 + 굵기 + 역할 → 바꿀 글꼴 슬롯
 * mode 'keep'  : 원래 고딕은 고딕, 바탕은 바탕, 판별 못 하면 기본(바탕)
 * mode 'body'  : 본문은 모두 바탕, 제목(큰 글씨)만 고딕
 * mode 'all-b' / 'all-g' : 전부 바탕 / 전부 고딕
 * @returns {'gR'|'gB'|'bR'|'bB'|null}  null = 바꾸지 않음
 */
export function pickSlot(cls, { mode = 'keep', heading = false, keepMono = true, override = null } = {}) {
  let fam = override && override !== 'auto' ? override : cls.family;
  if (fam === 'keep') return null;
  if (fam === 'symbol') return null;
  if (fam === 'mono') { if (keepMono) return null; fam = 'gothic'; }
  if (!override || override === 'auto') {
    if (mode === 'body') fam = heading ? 'gothic' : 'batang';
    else if (mode === 'all-b') fam = 'batang';
    else if (mode === 'all-g') fam = 'gothic';
    else if (fam === 'unknown') fam = 'batang';
  } else if (fam === 'unknown') fam = 'batang';
  return (fam === 'gothic' ? 'g' : 'b') + (cls.bold ? 'B' : 'R');
}

export const SLOT_LABEL = { gR: '고딕 보통', gB: '고딕 굵게', bR: '바탕 보통', bB: '바탕 굵게' };
