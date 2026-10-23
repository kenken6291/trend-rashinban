/**
 * =========================================================
 *  トレンド羅針盤（trend-rashinban） - Google Apps Script バックエンド
 *  Version: v1.2.0
 *
 *  ・doPost(JSON / Content-Type: text/plain) で全APIを受け付け
 *  ・DB: Google スプレッドシート（Users / Trends / History / Profiles / Reports / Assets）
 *  ・保存: Google Drive（トレンドJSON・分析レポートJSON）
 *  ・AI: Gemini API（トレンド抽出・ドリルダウン・性格診断・傾向分析）/ Gemini TTS
 *
 *  初回は setup() を実行し、スクリプトプロパティ GEMINI_API_KEY を設定してください。
 *  コードを変更したら「デプロイを管理 → 編集 → 新バージョン」で再デプロイが必要です。
 * =========================================================
 */

const APP_NAME = 'トレンド羅針盤';
const APP_VERSION = 'v1.2.0';
const TZ = 'Asia/Tokyo';

const SHEET_HEADERS = {
  Users:    ['email', 'nickname', 'salt', 'hash', 'mustChange', 'failCount', 'lockUntil', 'status', 'createdAt', 'updatedAt', 'lastLoginAt'],
  Trends:   ['date', 'genre', 'json', 'createdAt', 'createdBy'],
  History:  ['id', 'email', 'date', 'genre', 'itemName', 'summary', 'status', 'memo', 'x', 'y', 'createdAt', 'updatedAt'],
  Profiles: ['id', 'email', 'genre', 'x', 'y', 'typeName', 'mood', 'comment', 'answers', 'createdAt'],
  Reports:  ['id', 'email', 'json', 'createdAt'],
  Assets:   ['keyword', 'genre', 'driveFileId', 'type', 'note']
};

const GENRE_LIST = ['ドラマ', '映画', '音楽', '本', '小説', 'スポーツ', 'アウトドア', '旅行', '料理', '服', '化粧', 'ヘアスタイル', '会話ネタ', 'お笑い', '演劇'];
const STATUSES = ['気になる', 'チェックした', '体験した', '日記'];

const SESSION_TTL = 21600;   // 6時間（CacheService の上限）
const MAX_FAIL = 5;          // ログイン失敗の上限
const LOCK_MINUTES = 30;     // ロック時間（分）
const HASH_ROUNDS = 100;

/* =========================================================
 *  エントリポイント
 * ========================================================= */
function doGet(e) {
  return jsonOut({ ok: true, app: APP_NAME, version: APP_VERSION, time: nowStr() });
}

function doPost(e) {
  let req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut({ ok: false, error: 'BAD_REQUEST', message: 'リクエストの形式が正しくありません' });
  }

  const routes = {
    ping: function () { return { app: APP_NAME }; },
    register: actRegister,
    login: actLogin,
    logout: actLogout,
    me: actMe,
    changePassword: actChangePassword,
    resetPassword: actResetPassword,
    trends: actTrends,
    drilldown: actDrilldown,
    tts: actTts,
    diagQuestions: actDiagQuestions,
    diagnose: actDiagnose,
    saveHistory: actSaveHistory,
    history: actHistory,
    updateHistory: actUpdateHistory,
    deleteHistory: actDeleteHistory,
    analyze: actAnalyze,
    latestReport: actLatestReport
  };

  try {
    const fn = routes[req.action];
    if (!fn) fail('UNKNOWN_ACTION', '不明な操作です: ' + req.action);
    const result = fn(req) || {};
    return jsonOut(Object.assign({ ok: true, version: APP_VERSION }, result));
  } catch (err) {
    console.error('[' + req.action + '] ' + ((err && err.stack) || err));
    return jsonOut({
      ok: false,
      error: err.code || 'SERVER_ERROR',
      message: err.userMessage || ('サーバーでエラーが発生しました: ' + (err.message || err))
    });
  }
}

/* =========================================================
 *  初期セットアップ（エディタから一度だけ実行）
 * ========================================================= */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) ss = SpreadsheetApp.create(APP_NAME + ' DB');
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }

  Object.keys(SHEET_HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const cols = SHEET_HEADERS[name].length;
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, cols).setValues([SHEET_HEADERS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    // 日付などの自動変換を防ぐため書式をテキストに
    sh.getRange(1, 1, sh.getMaxRows(), cols).setNumberFormat('@');
  });

  ['シート1', 'Sheet1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
  });

  if (!props.getProperty('PEPPER')) {
    props.setProperty('PEPPER', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }
  if (!props.getProperty('DRIVE_FOLDER_ID')) {
    const folder = DriveApp.createFolder(APP_NAME + '_data');
    props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  }

  const defaults = {
    GEMINI_MODEL: 'gemini-2.5-flash',
    GEMINI_TTS_MODEL: 'gemini-2.5-flash-preview-tts',
    TTS_VOICE: 'Kore',
    USE_SEARCH_GROUNDING: 'true',
    SHOW_TEMP_PASSWORD: 'false',
    TREND_ITEMS: '14',
    APP_URL: ''
  };
  Object.keys(defaults).forEach(function (k) {
    if (props.getProperty(k) === null) props.setProperty(k, defaults[k]);
  });

  Logger.log('セットアップ完了: ' + ss.getUrl());
  Logger.log('Driveフォルダ: https://drive.google.com/drive/folders/' + props.getProperty('DRIVE_FOLDER_ID'));
  if (!props.getProperty('GEMINI_API_KEY')) Logger.log('★ スクリプトプロパティ GEMINI_API_KEY を設定してください');
}

/** 動作確認用：Gemini が呼べるかテスト */
function testGemini() {
  const r = gemini('「こんにちは」とだけ返してください。', { temperature: 0 });
  Logger.log(r.text);
}

/* =========================================================
 *  共通ヘルパー
 * ========================================================= */
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail(code, msg) {
  const e = new Error(msg);
  e.code = code;
  e.userMessage = msg;
  throw e;
}
function prop(key, def) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? def : v;
}
function nowStr() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function todayStr() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function normDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '').slice(0, 10);
}
function normDateTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  return String(v || '');
}
function str(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 500); }
function num(v, def) { const n = Number(v); return isFinite(n) ? n : def; }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function isTrue(v) { return String(v).toUpperCase() === 'TRUE'; }
function coord(v) { return clamp(Math.round(num(v, 0)), -100, 100); }
function quadKey(x, y) { return x >= 0 ? (y >= 0 ? 'q1' : 'q4') : (y >= 0 ? 'q2' : 'q3'); }

let _ss = null;
function getSS() {
  if (_ss) return _ss;
  const id = prop('SPREADSHEET_ID', '');
  _ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) fail('CONFIG', 'スプレッドシートが見つかりません。setup() を実行してください');
  return _ss;
}
function sheet(name) {
  const sh = getSS().getSheetByName(name);
  if (!sh) fail('CONFIG', 'シート「' + name + '」がありません。setup() を実行してください');
  return sh;
}
function rowsOf(name) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  const h = values.shift() || [];
  return { sh: sh, h: h, rows: values };
}
function rowObj(h, r) {
  const o = {};
  h.forEach(function (k, i) { o[k] = r[i]; });
  return o;
}
function objRow(name, o) {
  return SHEET_HEADERS[name].map(function (k) { return (o[k] === undefined || o[k] === null) ? '' : o[k]; });
}
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- Drive ---------- */
function driveFolder(sub) {
  const id = prop('DRIVE_FOLDER_ID', '');
  if (!id) return null;
  const root = DriveApp.getFolderById(id);
  if (!sub) return root;
  const it = root.getFoldersByName(sub);
  return it.hasNext() ? it.next() : root.createFolder(sub);
}
function saveJsonToDrive(sub, name, obj) {
  try {
    const f = driveFolder(sub);
    if (!f) return '';
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
    return f.createFile(safe, JSON.stringify(obj, null, 2), 'application/json').getId();
  } catch (e) {
    console.warn('Drive保存に失敗: ' + e);
    return '';
  }
}

/* =========================================================
 *  会員認証
 * ========================================================= */
function hashPw(pw, salt) {
  let s = salt + ':' + pw + ':' + prop('PEPPER', '');
  for (let i = 0; i < HASH_ROUNDS; i++) {
    s = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
  }
  return s;
}
function genTempPassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = letters + digits;
  let pw = '';
  for (let i = 0; i < 10; i++) pw += all.charAt(Math.floor(Math.random() * all.length));
  // 英字と数字を必ず含める
  pw = letters.charAt(Math.floor(Math.random() * letters.length)) + pw.slice(1, 9) + digits.charAt(Math.floor(Math.random() * digits.length));
  return pw;
}
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function validNewPassword(pw) { return /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(pw); }

function findUser(email) {
  const d = rowsOf('Users');
  for (let i = 0; i < d.rows.length; i++) {
    if (String(d.rows[i][0]).trim().toLowerCase() === email) {
      return { sh: d.sh, row: i + 2, u: rowObj(d.h, d.rows[i]) };
    }
  }
  return null;
}
function saveUser(f) {
  f.u.updatedAt = nowStr();
  f.sh.getRange(f.row, 1, 1, SHEET_HEADERS.Users.length).setValues([objRow('Users', f.u)]);
}
function publicUser(u) {
  return { email: u.email, nickname: u.nickname, mustChange: isTrue(u.mustChange) };
}
function newSession(email) {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  CacheService.getScriptCache().put('s_' + token, email, SESSION_TTL);
  return token;
}
function requireUser(req, allowMustChange) {
  const token = str(req.token, 100);
  if (!token) fail('AUTH', 'ログインしてください');
  const cache = CacheService.getScriptCache();
  const email = cache.get('s_' + token);
  if (!email) fail('AUTH', 'ログインの有効期限が切れました。もう一度ログインしてください');
  const f = findUser(email);
  if (!f || f.u.status === 'disabled') fail('AUTH', 'このアカウントは利用できません');
  if (isTrue(f.u.mustChange) && !allowMustChange) fail('MUST_CHANGE', 'パスワードの変更が必要です');
  cache.put('s_' + token, email, SESSION_TTL);
  return { email: email, user: f.u, f: f, token: token };
}
function sendMailSafe(to, subject, body) {
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: APP_NAME });
    return true;
  } catch (e) {
    console.warn('メール送信失敗: ' + e);
    return false;
  }
}
function tempPwMail(nickname, pw, isReset) {
  const url = prop('APP_URL', '');
  return [
    nickname + ' さん',
    '',
    isReset ? APP_NAME + ' の仮パスワードを再発行しました。' : APP_NAME + ' へのご登録ありがとうございます。',
    '',
    '仮パスワード：' + pw,
    url ? 'ログイン：' + url : '',
    '',
    'ログイン後、新しいパスワードへの変更をお願いします。',
    'このメールに心当たりがない場合は、破棄してください。'
  ].join('\n');
}

function actRegister(req) {
  const email = str(req.email, 120).toLowerCase();
  const nickname = str(req.nickname, 20);
  if (!validEmail(email)) fail('INPUT', 'メールアドレスの形式が正しくありません');
  if (!nickname) fail('INPUT', 'ニックネームを入力してください');

  const pw = genTempPassword();
  withLock(function () {
    if (findUser(email)) fail('EXISTS', 'このメールアドレスはすでに登録されています。ログインするか、パスワードの再発行をご利用ください');
    const salt = Utilities.getUuid();
    const u = {
      email: email, nickname: nickname, salt: salt, hash: hashPw(pw, salt),
      mustChange: 'TRUE', failCount: 0, lockUntil: '', status: 'active',
      createdAt: nowStr(), updatedAt: nowStr(), lastLoginAt: ''
    };
    sheet('Users').appendRow(objRow('Users', u));
  });

  const sent = sendMailSafe(email, '【' + APP_NAME + '】仮パスワードのお知らせ', tempPwMail(nickname, pw, false));
  const res = {
    mailSent: sent,
    message: sent
      ? '仮パスワードをメールで送りました。メールに書かれた仮パスワードでログインしてください。'
      : 'メールを送れなかったため、仮パスワードを画面に表示します。必ず控えてからログインしてください。'
  };
  if (!sent || prop('SHOW_TEMP_PASSWORD', 'false') === 'true') res.tempPassword = pw;
  return res;
}

function actLogin(req) {
  const email = str(req.email, 120).toLowerCase();
  const pw = String(req.password || '');
  if (!email || !pw) fail('INPUT', 'メールアドレスとパスワードを入力してください');

  return withLock(function () {
    const f = findUser(email);
    const ng = 'メールアドレスかパスワードが違います';
    if (!f) fail('LOGIN', ng);
    if (f.u.status === 'disabled') fail('LOGIN', 'このアカウントは利用停止中です');

    const lu = f.u.lockUntil;
    const lockUntil = lu instanceof Date ? lu : (lu ? new Date(String(lu).replace(' ', 'T') + '+09:00') : null);
    if (lockUntil && lockUntil.getTime() > Date.now()) {
      const min = Math.ceil((lockUntil.getTime() - Date.now()) / 60000);
      fail('LOCKED', 'ログインに続けて失敗したため、ロック中です。約' + min + '分後にお試しください');
    }

    if (hashPw(pw, f.u.salt) !== f.u.hash) {
      const cnt = num(f.u.failCount, 0) + 1;
      f.u.failCount = cnt;
      if (cnt >= MAX_FAIL) {
        f.u.lockUntil = Utilities.formatDate(new Date(Date.now() + LOCK_MINUTES * 60000), TZ, 'yyyy-MM-dd HH:mm:ss');
        f.u.failCount = 0;
        saveUser(f);
        fail('LOCKED', 'ログインに' + MAX_FAIL + '回失敗したため、' + LOCK_MINUTES + '分間ロックしました');
      }
      saveUser(f);
      fail('LOGIN', ng + '（あと' + (MAX_FAIL - cnt) + '回でロックされます）');
    }

    f.u.failCount = 0;
    f.u.lockUntil = '';
    f.u.lastLoginAt = nowStr();
    saveUser(f);
    return { token: newSession(email), user: publicUser(f.u) };
  });
}

function actLogout(req) {
  const token = str(req.token, 100);
  if (token) CacheService.getScriptCache().remove('s_' + token);
  return {};
}

function actMe(req) {
  const s = requireUser(req, true);
  return { user: publicUser(s.user) };
}

function actChangePassword(req) {
  const s = requireUser(req, true);
  const cur = String(req.current || '');
  const next = String(req.next || '');
  if (hashPw(cur, s.user.salt) !== s.user.hash) fail('INPUT', '現在のパスワード（仮パスワード）が違います');
  if (!validNewPassword(next)) fail('INPUT', '新しいパスワードは8文字以上で、英字と数字を両方含めてください');
  if (next === cur) fail('INPUT', '今と違うパスワードを設定してください');
  withLock(function () {
    const f = findUser(s.email);
    f.u.salt = Utilities.getUuid();
    f.u.hash = hashPw(next, f.u.salt);
    f.u.mustChange = 'FALSE';
    f.u.failCount = 0;
    f.u.lockUntil = '';
    saveUser(f);
  });
  return { message: 'パスワードを変更しました' };
}

function actResetPassword(req) {
  const email = str(req.email, 120).toLowerCase();
  if (!validEmail(email)) fail('INPUT', 'メールアドレスの形式が正しくありません');
  const msg = '登録済みのメールアドレスであれば、仮パスワードを送りました。メールをご確認ください。';
  const res = { message: msg };
  withLock(function () {
    const f = findUser(email);
    if (!f || f.u.status === 'disabled') return;
    const pw = genTempPassword();
    f.u.salt = Utilities.getUuid();
    f.u.hash = hashPw(pw, f.u.salt);
    f.u.mustChange = 'TRUE';
    f.u.failCount = 0;
    f.u.lockUntil = '';
    saveUser(f);
    sendMailSafe(email, '【' + APP_NAME + '】仮パスワード再発行のお知らせ', tempPwMail(f.u.nickname, pw, true));
    // 第三者による乗っ取りを防ぐため、再発行時の画面表示は SHOW_TEMP_PASSWORD=true のときだけ
    if (prop('SHOW_TEMP_PASSWORD', 'false') === 'true') res.tempPassword = pw;
  });
  return res;
}

/* =========================================================
 *  Gemini 呼び出し
 * ========================================================= */
function callGemini(model, body) {
  const key = prop('GEMINI_API_KEY', '');
  if (!key) fail('CONFIG', 'GEMINI_API_KEY が設定されていません（スクリプトプロパティ）');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  let lastErr = '';
  let lastCode = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    lastCode = res.getResponseCode();
    if (lastCode === 200) return JSON.parse(res.getContentText());
    lastErr = res.getContentText().slice(0, 400);
    if (lastCode === 429 || lastCode >= 500) {
      Utilities.sleep(1500 * (attempt + 1));
      continue;
    }
    break;
  }
  console.error('Gemini error ' + lastCode + ': ' + lastErr);
  if (lastCode === 429) fail('AI_BUSY', 'AIが混み合っています。少し時間をおいてからお試しください');
  fail('AI', 'AIの呼び出しに失敗しました（' + lastCode + '）');
}

function gemini(prompt, opts) {
  opts = opts || {};
  const model = opts.model || prop('GEMINI_MODEL', 'gemini-2.5-flash');
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: (opts.temperature === undefined ? 0.8 : opts.temperature) }
  };
  if (opts.json) body.generationConfig.responseMimeType = 'application/json';
  if (opts.search) body.tools = [{ google_search: {} }];
  const tb = prop('THINKING_BUDGET', '');
  if (tb !== '') body.generationConfig.thinkingConfig = { thinkingBudget: Number(tb) };

  const data = callGemini(model, body);
  const cand = (data.candidates && data.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map(function (p) { return p.text || ''; }).join('');
  const sources = [];
  const gm = cand.groundingMetadata;
  if (gm && gm.groundingChunks) {
    gm.groundingChunks.forEach(function (c) {
      if (c.web && c.web.uri) sources.push({ title: str(c.web.title, 80) || 'ウェブ', uri: c.web.uri });
    });
  }
  if (!text) fail('AI', 'AIから回答が得られませんでした。もう一度お試しください');
  return { text: text, sources: sources };
}

function parseJson(text) {
  let t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

/** 検索グラウンディング → 失敗時はJSONモードで再試行 */
function geminiJson(prompt, opts) {
  opts = opts || {};
  const useSearch = opts.search && prop('USE_SEARCH_GROUNDING', 'true') === 'true';
  if (useSearch) {
    try {
      const r = gemini(prompt, { search: true, temperature: opts.temperature });
      return { data: parseJson(r.text), sources: r.sources };
    } catch (e) {
      if (e.code === 'CONFIG' || e.code === 'AI_BUSY') throw e;
      console.warn('検索モード失敗、JSONモードで再試行: ' + e);
    }
  }
  const r2 = gemini(prompt, { json: true, temperature: opts.temperature });
  return { data: parseJson(r2.text), sources: [] };
}

function cleanTts(s) {
  return String(s || '')
    .replace(/[#*_`>|~]/g, '')
    .replace(/（[^）]*(声|トーン|口調|BGM|効果音|間を)[^）]*）/g, '')
    .replace(/\([^)]*(声|トーン|口調|BGM|効果音)[^)]*\)/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function sanitizeAxes(a) {
  a = a || {};
  function one(o, nm, dn, dp) {
    o = o || {};
    return { name: str(o.name, 20) || nm, neg: str(o.neg, 20) || dn, pos: str(o.pos, 20) || dp };
  }
  return { x: one(a.x, 'X軸', '王道', 'ニッチ'), y: one(a.y, 'Y軸', 'ライト', 'ディープ') };
}
function sanitizeQuadrants(q) {
  q = q || {};
  return { q1: str(q.q1, 16) || '右上', q2: str(q.q2, 16) || '左上', q3: str(q.q3, 16) || '左下', q4: str(q.q4, 16) || '右下' };
}
function compactItems(list, max) {
  return (Array.isArray(list) ? list : []).slice(0, max || 30).map(function (it) {
    return { id: str(it.id, 10), name: str(it.name, 40), summary: str(it.summary, 160), x: coord(it.x), y: coord(it.y) };
  }).filter(function (it) { return it.name; });
}
function nearestItems(items, x, y, n, exclude) {
  return items
    .filter(function (i) { return !exclude || exclude.indexOf(i.id) < 0; })
    .map(function (i) { return { i: i, d: Math.sqrt(Math.pow(i.x - x, 2) + Math.pow(i.y - y, 2)) }; })
    .sort(function (a, b) { return a.d - b.d; })
    .slice(0, n)
    .map(function (o) { return o.i; });
}

/* =========================================================
 *  トレンド抽出（4象限マップ）
 * ========================================================= */
function trendPrompt(genre, today, n, search) {
  return [
    'あなたは日本の生活者トレンドに詳しいアナリストです。今日は' + today + 'です。',
    'ジャンル「' + genre + '」について、いま日本で話題・流行しているもの（作品、人物、商品、スタイル、スポット、話題など）を' + n + '件選び、',
    'このジャンルを最もうまく切り分けられる直交2軸を設計して、4象限のポジショニングマップを作ってください。',
    search ? 'Google検索で直近の話題を確認し、実在する最新の固有名詞を優先してください。' : '',
    '',
    'ルール:',
    '- X軸・Y軸はこのジャンルに合った意味のある対立概念にする（例：王道⇔ニッチ、ライト⇔ディープ、伝統的⇔前衛的）。互いに相関しにくい2軸を選ぶ。',
    '- 各アイテムの x, y は -100〜100 の整数。4つの象限すべてにアイテムが入るように散らし、0付近に集中させない。',
    '- quadrants の q1 は x>0かつy>0、q2 は x<0かつy>0、q3 は x<0かつy<0、q4 は x>0かつy<0 の領域の呼び名（10文字以内）。',
    '- summary は各40〜80文字、keywords は3〜5個。',
    '- ロケ地、アウトドアのスポット、旅行先・観光地、聖地、会場など場所と結びつくものは place に代表地点の名称と緯度経度を入れる。場所と関係なければ place は null。',
    '- 架空のもの、確信の持てない情報は入れない。',
    '- 出力はJSONのみ。前置き、説明、コードブロック記号は書かない。',
    '',
    '出力形式:',
    '{"genre":"","headline":"このジャンルのいまを一言で（30文字以内）","overview":"全体の傾向（120〜200文字）",',
    '"axes":{"x":{"name":"軸名","neg":"左端の意味","pos":"右端の意味"},"y":{"name":"軸名","neg":"下端の意味","pos":"上端の意味"}},',
    '"quadrants":{"q1":"","q2":"","q3":"","q4":""},',
    '"items":[{"name":"","summary":"","x":0,"y":0,"keywords":[""],"place":{"name":"","lat":0,"lng":0}}]}'
  ].join('\n');
}

function normalizeTrend(d, genre) {
  d = d || {};
  const seen = {};
  const items = (Array.isArray(d.items) ? d.items : []).map(function (it) {
    it = it || {};
    const name = str(it.name, 40);
    if (!name || seen[name]) return null;
    seen[name] = true;
    let place = null;
    if (it.place && typeof it.place === 'object') {
      const lat = Number(it.place.lat), lng = Number(it.place.lng);
      if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
        place = { name: str(it.place.name, 40) || name, lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
      }
    }
    return {
      name: name,
      summary: str(it.summary, 160),
      x: coord(it.x),
      y: coord(it.y),
      keywords: (Array.isArray(it.keywords) ? it.keywords : []).map(function (k) { return str(k, 20); }).filter(String).slice(0, 5),
      place: place
    };
  }).filter(Boolean);
  items.forEach(function (it, i) { it.id = 't' + (i + 1); });

  return {
    genre: genre,
    headline: str(d.headline, 60),
    overview: str(d.overview, 400),
    axes: sanitizeAxes(d.axes),
    quadrants: sanitizeQuadrants(d.quadrants),
    items: items
  };
}

function findTrendCache(genre, today) {
  const d = rowsOf('Trends');
  for (let i = d.rows.length - 1; i >= 0; i--) {
    const r = rowObj(d.h, d.rows[i]);
    if (normDate(r.date) === today && String(r.genre) === genre) {
      try { return JSON.parse(r.json); } catch (e) { return null; }
    }
  }
  return null;
}

function actTrends(req) {
  const s = requireUser(req);
  const genre = str(req.genre, 40);
  if (!genre) fail('INPUT', 'ジャンルを指定してください');
  const today = todayStr();

  if (!req.refresh) {
    const cached = findTrendCache(genre, today);
    if (cached && cached.items && cached.items.length) return { trend: cached, cached: true, date: today };
  }

  const n = clamp(Math.round(num(req.items, num(prop('TREND_ITEMS', '14'), 14))), 8, 20);
  const useSearch = prop('USE_SEARCH_GROUNDING', 'true') === 'true';
  const r = geminiJson(trendPrompt(genre, today, n, useSearch), { search: true, temperature: 0.7 });
  const trend = normalizeTrend(r.data, genre);
  trend.sources = (r.sources || []).slice(0, 8);
  if (trend.items.length < 3) fail('AI', '流行アイテムをうまく取り出せませんでした。もう一度お試しください');

  const json = JSON.stringify(trend);
  if (json.length < 49000) sheet('Trends').appendRow([today, genre, json, nowStr(), s.email]);
  saveJsonToDrive('trends', today + '_' + genre + '.json', trend);
  return { trend: trend, cached: false, date: today };
}

/* =========================================================
 *  ドリルダウン（周辺の深掘り）
 * ========================================================= */
function findAssets(genre, names) {
  try {
    const d = rowsOf('Assets');
    const out = [];
    d.rows.forEach(function (r) {
      const a = rowObj(d.h, r);
      const kw = str(a.keyword, 60);
      const id = str(a.driveFileId, 120);
      if (!kw || !id) return;
      const genreOk = !a.genre || String(a.genre) === genre;
      if (!genreOk) return;
      const hit = kw === '*' || names.some(function (n) { return n && (n.indexOf(kw) >= 0 || kw.indexOf(n) >= 0); });
      if (hit) out.push({ keyword: kw, driveFileId: id, type: str(a.type, 10) || 'video', note: str(a.note, 100) });
    });
    return out.slice(0, 3);
  } catch (e) {
    return [];
  }
}

function actDrilldown(req) {
  requireUser(req);
  const genre = str(req.genre, 40);
  const axes = sanitizeAxes(req.axes);
  const quads = sanitizeQuadrants(req.quadrants);
  const x = coord(req.x), y = coord(req.y);
  const items = compactItems(req.items, 8);
  const focus = req.focus ? str(req.focus.name, 40) : '';
  const qname = quads[quadKey(x, y)];

  const prompt = [
    'ジャンル「' + genre + '」の流行マップがあります。今日は' + todayStr() + 'です。',
    'X軸：' + axes.x.neg + '(-100) ⇔ ' + axes.x.pos + '(+100)、Y軸：' + axes.y.neg + '(-100) ⇔ ' + axes.y.pos + '(+100)',
    '利用者は座標(' + x + ', ' + y + ')付近、象限「' + qname + '」を見ています。',
    focus ? '注目しているアイテム：' + focus : '特定のアイテムではなく、この周辺のエリア全体に関心があります。',
    '周辺のアイテム：',
    items.map(function (i) { return '- ' + i.name + '（' + i.x + ', ' + i.y + '）：' + i.summary; }).join('\n'),
    '',
    'この人に向けた「深掘りガイド」を作ってください。',
    '- picks は3〜4件。周辺アイテムそのもの、または同じ位置づけの実在する作品・商品・スポット・人物など。',
    '- keywords は5〜8個、deepDive は3件（もっと深く楽しむための視点）。',
    '- ttsScript は読み上げ用の話し言葉の原稿（200〜320文字）。記号、絵文字、見出し、括弧書きのト書き、「〜の声で」などの演出指示は一切入れない。',
    '- 出力はJSONのみ。',
    '{"title":"","lead":"このあたりの特徴（80〜150文字）","picks":[{"name":"","why":"おすすめの理由（60文字程度）","firstStep":"今日からできるはじめの一歩（40文字程度）"}],"keywords":[""],"deepDive":[""],"ttsScript":""}'
  ].join('\n');

  const r = geminiJson(prompt, { search: true, temperature: 0.8 });
  const d = r.data || {};
  const deep = {
    title: str(d.title, 40),
    lead: str(d.lead, 300),
    picks: (Array.isArray(d.picks) ? d.picks : []).slice(0, 5).map(function (p) {
      p = p || {};
      return { name: str(p.name, 50), why: str(p.why, 160), firstStep: str(p.firstStep, 100) };
    }).filter(function (p) { return p.name; }),
    keywords: (Array.isArray(d.keywords) ? d.keywords : []).map(function (k) { return str(k, 20); }).filter(String).slice(0, 8),
    deepDive: (Array.isArray(d.deepDive) ? d.deepDive : []).map(function (k) { return str(k, 160); }).filter(String).slice(0, 5),
    ttsScript: cleanTts(d.ttsScript),
    sources: (r.sources || []).slice(0, 6)
  };
  const assets = findAssets(genre, [focus].concat(items.map(function (i) { return i.name; })));
  return { deep: deep, assets: assets };
}

/* =========================================================
 *  TTS（Gemini 音声合成）
 * ========================================================= */
function actTts(req) {
  requireUser(req);
  const text = cleanTts(str(req.text, 1500));
  if (!text) fail('INPUT', '読み上げる文章がありません');
  const model = prop('GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  const voice = str(req.voice, 30) || prop('TTS_VOICE', 'Kore');
  const body = {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
    }
  };
  const data = callGemini(model, body);
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  let audio = null;
  parts.forEach(function (p) { if (!audio && p.inlineData && p.inlineData.data) audio = p.inlineData; });
  if (!audio) fail('AI', '音声を作れませんでした。もう一度お試しください');
  return { audio: audio.data, mimeType: audio.mimeType || 'audio/L16;codec=pcm;rate=24000' };
}

/* =========================================================
 *  性格診断
 * ========================================================= */
function fallbackQuestions(axes) {
  function opts(axis, key) {
    const strong = [-80, -35, 35, 80];
    const labels = [
      '「' + axis.neg + '」にとても惹かれる',
      'どちらかといえば「' + axis.neg + '」',
      'どちらかといえば「' + axis.pos + '」',
      '「' + axis.pos + '」にとても惹かれる'
    ];
    return labels.map(function (l, i) {
      const o = { label: l, x: 0, y: 0 };
      o[key] = strong[i];
      return o;
    });
  }
  return [
    { q: 'いまの気分に近いのはどちら？（' + axes.x.name + '）', options: opts(axes.x, 'x') },
    { q: 'いまの気分に近いのはどちら？（' + axes.y.name + '）', options: opts(axes.y, 'y') },
    { q: '友だちにすすめるとしたら、どちら寄りのものを選びますか？', options: opts(axes.x, 'x') },
    { q: '休日にじっくり楽しむなら、どちら寄りがいいですか？', options: opts(axes.y, 'y') }
  ];
}

function actDiagQuestions(req) {
  requireUser(req);
  const genre = str(req.genre, 40);
  const axes = sanitizeAxes(req.axes);
  const prompt = [
    'ジャンル「' + genre + '」の流行マップの軸：',
    'X軸：' + axes.x.neg + '(-100) ⇔ ' + axes.x.pos + '(+100)',
    'Y軸：' + axes.y.neg + '(-100) ⇔ ' + axes.y.pos + '(+100)',
    '利用者の性格傾向と今の気分から、このマップ上の現在地を推定するための簡単な質問を4問作ってください。',
    '- ジャンルに詳しくない人でも答えられる、日常の行動や気分についての質問にする（「どちらの軸が好き？」と直接は聞かない）。',
    '- 各問に選択肢を4つ。各選択肢に、その答えが示す x, y（-100〜100の整数）を付ける。',
    '- 4問全体で X軸とY軸の両方をバランスよく測る。',
    '- 出力はJSONのみ：{"questions":[{"q":"質問文","options":[{"label":"選択肢","x":0,"y":0}]}]}'
  ].join('\n');
  try {
    const r = geminiJson(prompt, { search: false, temperature: 0.9 });
    const qs = ((r.data && r.data.questions) || []).map(function (q) {
      q = q || {};
      return {
        q: str(q.q, 120),
        options: (Array.isArray(q.options) ? q.options : []).slice(0, 5).map(function (o) {
          o = o || {};
          return { label: str(o.label, 60), x: coord(o.x), y: coord(o.y) };
        }).filter(function (o) { return o.label; })
      };
    }).filter(function (q) { return q.q && q.options.length >= 2; }).slice(0, 5);
    if (qs.length >= 3) return { questions: qs, source: 'ai' };
  } catch (e) {
    if (e.code === 'CONFIG') throw e;
    console.warn('診断質問の生成に失敗: ' + e);
  }
  return { questions: fallbackQuestions(axes), source: 'basic' };
}

function actDiagnose(req) {
  const s = requireUser(req);
  const genre = str(req.genre, 40);
  const axes = sanitizeAxes(req.axes);
  const quads = sanitizeQuadrants(req.quadrants);
  const items = compactItems(req.items, 30);
  const answers = (Array.isArray(req.answers) ? req.answers : []).slice(0, 8).map(function (a) {
    a = a || {};
    return { q: str(a.q, 120), label: str(a.label, 60), x: coord(a.x), y: coord(a.y) };
  });
  if (!answers.length) fail('INPUT', '回答がありません');

  const x = coord(answers.reduce(function (t, a) { return t + a.x; }, 0) / answers.length);
  const y = coord(answers.reduce(function (t, a) { return t + a.y; }, 0) / answers.length);
  const near = nearestItems(items, x, y, 3);
  const diag = nearestItems(items, -x, -y, 3, near.map(function (i) { return i.id; }));

  function side(v, axis) {
    const a = Math.abs(v);
    const deg = a >= 60 ? 'かなり' : a >= 25 ? 'やや' : 'ほぼ中間で少し';
    return deg + (v >= 0 ? axis.pos : axis.neg) + '寄り';
  }

  let result = {
    typeName: '', mood: '', comment: '', nearReason: '', diagonalReason: ''
  };
  try {
    const prompt = [
      'ジャンル「' + genre + '」の流行マップで性格診断を行いました。',
      '現在地：X=' + x + '（' + side(x, axes.x) + '）、Y=' + y + '（' + side(y, axes.y) + '）、象限「' + quads[quadKey(x, y)] + '」',
      '回答：',
      answers.map(function (a) { return '- ' + a.q + ' → ' + a.label; }).join('\n'),
      '現在地に近い流行：' + near.map(function (i) { return i.name; }).join('、'),
      '対角線上の流行：' + diag.map(function (i) { return i.name; }).join('、'),
      '',
      'やさしく前向きな語り口で、本人に向けた結果を作ってください。出力はJSONのみ。',
      '{"typeName":"タイプ名（12文字以内、親しみやすく）","mood":"今の気分を一言で（20文字以内）","comment":"性格と気分の解説（100〜160文字）","nearReason":"近い流行が合う理由（60文字程度）","diagonalReason":"あえて対角線の流行を試す価値（60文字程度）"}'
    ].join('\n');
    const r = geminiJson(prompt, { search: false, temperature: 0.9 });
    const d = r.data || {};
    result = {
      typeName: str(d.typeName, 24),
      mood: str(d.mood, 40),
      comment: str(d.comment, 300),
      nearReason: str(d.nearReason, 120),
      diagonalReason: str(d.diagonalReason, 120)
    };
  } catch (e) {
    if (e.code === 'CONFIG') throw e;
    console.warn('診断コメント生成に失敗: ' + e);
    result.typeName = quads[quadKey(x, y)] + 'タイプ';
    result.comment = 'いまのあなたは、' + side(x, axes.x) + '、' + side(y, axes.y) + 'の気分です。';
  }

  result.x = x;
  result.y = y;
  result.nearIds = near.map(function (i) { return i.id; });
  result.diagonalIds = diag.map(function (i) { return i.id; });

  sheet('Profiles').appendRow(objRow('Profiles', {
    id: Utilities.getUuid(), email: s.email, genre: genre, x: x, y: y,
    typeName: result.typeName, mood: result.mood, comment: result.comment,
    answers: JSON.stringify(answers), createdAt: nowStr()
  }));
  return { result: result };
}

/* =========================================================
 *  履歴・日記・カレンダー
 * ========================================================= */
function historyObj(h, r) {
  const o = rowObj(h, r);
  return {
    id: String(o.id), date: normDate(o.date), genre: String(o.genre || ''), itemName: String(o.itemName || ''),
    summary: String(o.summary || ''), status: String(o.status || ''), memo: String(o.memo || ''),
    x: o.x === '' ? null : num(o.x, null), y: o.y === '' ? null : num(o.y, null),
    createdAt: normDateTime(o.createdAt), updatedAt: normDateTime(o.updatedAt), email: String(o.email || '')
  };
}
function stripEmail(e) { const c = Object.assign({}, e); delete c.email; return c; }
function validDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }

function actSaveHistory(req) {
  const s = requireUser(req);
  const date = validDate(str(req.date, 10)) ? str(req.date, 10) : todayStr();
  const status = STATUSES.indexOf(req.status) >= 0 ? req.status : '気になる';
  const itemName = str(req.itemName, 80);
  const memo = str(req.memo, 1000);
  if (!itemName && !memo) fail('INPUT', 'タイトルかメモを入力してください');
  const e = {
    id: Utilities.getUuid(), email: s.email, date: date, genre: str(req.genre, 40),
    itemName: itemName || '日記', summary: str(req.summary, 200), status: status, memo: memo,
    x: (req.x === null || req.x === undefined || req.x === '') ? '' : coord(req.x),
    y: (req.y === null || req.y === undefined || req.y === '') ? '' : coord(req.y),
    createdAt: nowStr(), updatedAt: nowStr()
  };
  sheet('History').appendRow(objRow('History', e));
  e.x = e.x === '' ? null : e.x;
  e.y = e.y === '' ? null : e.y;
  return { entry: stripEmail(e) };
}

function actHistory(req) {
  const s = requireUser(req);
  const month = str(req.month, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) fail('INPUT', '月の指定が正しくありません');
  const d = rowsOf('History');
  const entries = d.rows
    .map(function (r) { return historyObj(d.h, r); })
    .filter(function (e) { return e.email === s.email && e.date.slice(0, 7) === month; })
    .sort(function (a, b) { return (a.date + a.createdAt) < (b.date + b.createdAt) ? -1 : 1; })
    .map(stripEmail);
  return { entries: entries };
}

function findHistoryRow(email, id) {
  const d = rowsOf('History');
  for (let i = 0; i < d.rows.length; i++) {
    if (String(d.rows[i][0]) === id && String(d.rows[i][1]) === email) {
      return { sh: d.sh, row: i + 2, h: d.h, e: rowObj(d.h, d.rows[i]) };
    }
  }
  return null;
}

function actUpdateHistory(req) {
  const s = requireUser(req);
  const id = str(req.id, 60);
  return withLock(function () {
    const f = findHistoryRow(s.email, id);
    if (!f) fail('NOT_FOUND', '記録が見つかりません');
    if (req.status !== undefined && STATUSES.indexOf(req.status) >= 0) f.e.status = req.status;
    if (req.memo !== undefined) f.e.memo = str(req.memo, 1000);
    if (req.itemName !== undefined && str(req.itemName, 80)) f.e.itemName = str(req.itemName, 80);
    if (req.date !== undefined && validDate(str(req.date, 10))) f.e.date = str(req.date, 10);
    f.e.date = normDate(f.e.date);
    f.e.createdAt = normDateTime(f.e.createdAt);
    f.e.updatedAt = nowStr();
    f.sh.getRange(f.row, 1, 1, SHEET_HEADERS.History.length).setValues([objRow('History', f.e)]);
    return { entry: stripEmail(historyObj(SHEET_HEADERS.History, objRow('History', f.e))) };
  });
}

function actDeleteHistory(req) {
  const s = requireUser(req);
  const id = str(req.id, 60);
  return withLock(function () {
    const f = findHistoryRow(s.email, id);
    if (!f) fail('NOT_FOUND', '記録が見つかりません');
    f.sh.deleteRow(f.row);
    return { id: id };
  });
}

/* =========================================================
 *  AI評価・パーソナライズ
 * ========================================================= */
function myHistory(email) {
  const d = rowsOf('History');
  return d.rows
    .map(function (r) { return historyObj(d.h, r); })
    .filter(function (e) { return e.email === email; })
    .sort(function (a, b) { return (a.date + a.createdAt) > (b.date + b.createdAt) ? -1 : 1; });
}
function calcStats(list) {
  const byStatus = {};
  const byGenre = {};
  const thisMonth = todayStr().slice(0, 7);
  let monthCount = 0;
  list.forEach(function (e) {
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    const g = e.genre || '未分類';
    byGenre[g] = (byGenre[g] || 0) + 1;
    if (e.date.slice(0, 7) === thisMonth) monthCount++;
  });
  const genres = Object.keys(byGenre).map(function (g) { return [g, byGenre[g]]; }).sort(function (a, b) { return b[1] - a[1]; });
  return { total: list.length, thisMonth: monthCount, byStatus: byStatus, byGenre: genres };
}

function actAnalyze(req) {
  const s = requireUser(req);
  const list = myHistory(s.email);
  if (list.length < 3) fail('NOT_ENOUGH', '記録が3件以上たまると分析できます。マップやカレンダーから記録してみてください');

  const recent = list.slice(0, 150);
  const pd = rowsOf('Profiles');
  const profiles = pd.rows.map(function (r) { return rowObj(pd.h, r); })
    .filter(function (p) { return p.email === s.email; })
    .slice(-10);
  const stats = calcStats(list);

  const prompt = [
    '以下は「' + APP_NAME + '」の利用者の記録（新しい順）と性格診断の履歴です。今日は' + todayStr() + 'です。',
    '【記録】日付 / ジャンル / 状態 / アイテム / メモ',
    recent.map(function (e) {
      return '- ' + e.date + ' / ' + (e.genre || '-') + ' / ' + e.status + ' / ' + e.itemName + (e.memo ? ' / ' + e.memo.slice(0, 80) : '');
    }).join('\n'),
    '【性格診断】',
    profiles.length ? profiles.map(function (p) { return '- ' + p.genre + '：' + p.typeName + '（' + p.x + ', ' + p.y + '）' + (p.mood ? ' 気分：' + p.mood : ''); }).join('\n') : '- なし',
    '【ジャンル別件数】' + stats.byGenre.map(function (g) { return g[0] + ':' + g[1]; }).join('、'),
    '',
    'これらを分析し、本人に向けたやさしく前向きなレポートを作ってください。',
    '- nextGenres は3件。次の候補から、最近あまり記録のないジャンルを優先して選ぶ：' + GENRE_LIST.join('、'),
    '- idea には、そのジャンルで今まさに試すと良さそうな具体的な流行やアイテムを書く。',
    '- ttsScript は読み上げ原稿（220〜320文字）。記号、絵文字、括弧書きのト書き、演出指示は入れない。',
    '- 出力はJSONのみ。',
    '{"headline":"最近のあなたを一言で（30文字以内）","tendency":"関心傾向の分析（150〜250文字）","keywords":[""],',
    '"nextGenres":[{"genre":"","reason":"","idea":""}],"surprise":{"title":"意外性のあるおすすめ","reason":""},',
    '"message":"背中を押すひとこと（60文字程度）","ttsScript":""}'
  ].join('\n');

  const r = geminiJson(prompt, { search: false, temperature: 0.8 });
  const d = r.data || {};
  const report = {
    headline: str(d.headline, 60),
    tendency: str(d.tendency, 500),
    keywords: (Array.isArray(d.keywords) ? d.keywords : []).map(function (k) { return str(k, 20); }).filter(String).slice(0, 8),
    nextGenres: (Array.isArray(d.nextGenres) ? d.nextGenres : []).slice(0, 3).map(function (g) {
      g = g || {};
      return { genre: str(g.genre, 20), reason: str(g.reason, 160), idea: str(g.idea, 160) };
    }).filter(function (g) { return g.genre; }),
    surprise: { title: str(d.surprise && d.surprise.title, 60), reason: str(d.surprise && d.surprise.reason, 200) },
    message: str(d.message, 160),
    ttsScript: cleanTts(d.ttsScript),
    createdAt: nowStr(),
    count: list.length
  };
  const id = Utilities.getUuid();
  sheet('Reports').appendRow([id, s.email, JSON.stringify(report), report.createdAt]);
  saveJsonToDrive('reports', todayStr() + '_' + s.email.split('@')[0] + '_' + id.slice(0, 8) + '.json', report);
  return { report: report, stats: stats };
}

function actLatestReport(req) {
  const s = requireUser(req);
  const stats = calcStats(myHistory(s.email));
  const d = rowsOf('Reports');
  let report = null;
  for (let i = d.rows.length - 1; i >= 0; i--) {
    if (String(d.rows[i][1]) === s.email) {
      try { report = JSON.parse(d.rows[i][2]); } catch (e) { report = null; }
      break;
    }
  }
  return { report: report, stats: stats };
}
