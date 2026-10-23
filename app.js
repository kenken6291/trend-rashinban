/* =========================================================
 *  トレンド羅針盤 app.js
 *  認証 / 4象限マップ / ドリルダウン / 性格診断 / 記録・カレンダー / 傾向分析
 * ========================================================= */
(function () {
  'use strict';

  const C = window.APP_CONFIG || {};
  const GEM = C.GEMINI || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
  };
  const KEY = { token: 'trs_token', me: 'trs_me', genre: 'trs_genre', help: 'trs_help_hide' };
  const STATUS = ['気になる', 'チェックした', '体験した', '日記'];
  const STATUS_CLASS = { '気になる': 'st-like', 'チェックした': 'st-check', '体験した': 'st-done', '日記': 'st-diary' };

  /* ---------- 小さな道具 ---------- */
  function loadJSON(k, d) { try { const v = store.get(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function trunc(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function quadOf(x, y) { return x >= 0 ? (y >= 0 ? 'q1' : 'q4') : (y >= 0 ? 'q2' : 'q3'); }
  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
  function nearest(items, x, y, n, exclude) {
    return items
      .filter(i => !exclude || !exclude.has(i.id))
      .map(i => ({ i, d: dist(i.x, i.y, x, y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map(o => o.i);
  }
  function jpDate(ds) {
    const [y, m, d] = ds.split('-').map(Number);
    const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
    return `${y}年${m}月${d}日（${w}）`;
  }
  function compact(it) { return { id: it.id, name: it.name, summary: it.summary, x: it.x, y: it.y }; }

  /* ---------- 状態 ---------- */
  const state = {
    token: store.get(KEY.token),
    user: null,
    genre: store.get(KEY.genre) || (C.GENRES && C.GENRES[0]) || 'ドラマ',
    isOther: false,
    trend: null,
    trendDate: '',
    trendCached: false,
    me: loadJSON(KEY.me, {}),
    probe: null,
    drill: null,
    drillSeq: 0,
    deep: null,
    earthIdx: 0,
    earthAssets: [],
    month: ymd(new Date()).slice(0, 7),
    day: null,
    history: [],
    report: null,
    reportLoaded: false,
    audio: null,
    audioBtn: null,
    audioCache: new Map(),
    pwForced: false,
    diag: null,
    recordTarget: null
  };

  /* ---------- 読み込み表示・通知 ---------- */
  let loadingCount = 0;
  function showLoading(msg) {
    loadingCount++;
    $('#loading-msg').textContent = msg || '処理しています';
    $('#loading').hidden = false;
  }
  function hideLoading() {
    loadingCount = Math.max(0, loadingCount - 1);
    if (!loadingCount) $('#loading').hidden = true;
  }
  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (type || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = 'toast'; }, 4200);
  }

  /* ---------- API ---------- */
  async function api(action, payload, opt) {
    opt = opt || {};
    if (!C.GAS_URL || C.GAS_URL.indexOf('XXXX') >= 0) {
      throw new Error('config.js の GAS_URL を設定してください');
    }
    if (opt.loading) showLoading(opt.loading);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), C.REQUEST_TIMEOUT_MS || 150000);
    try {
      const res = await fetch(C.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, token: state.token }, payload || {})),
        signal: ctrl.signal
      });
      const data = await res.json();
      if (!data.ok) {
        const err = new Error(data.message || 'エラーが発生しました');
        err.code = data.error;
        if (data.error === 'AUTH' && action !== 'login') handleExpired(data.message);
        else if (data.error === 'MUST_CHANGE') openPwModal(true);
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('通信に時間がかかりすぎました。もう一度お試しください');
      if (err instanceof SyntaxError) throw new Error('サーバーの応答を読み取れませんでした。GASのデプロイ設定（アクセスできるユーザー：全員）を確認してください');
      if (err instanceof TypeError) throw new Error('サーバーにつながりませんでした。通信状況と config.js の GAS_URL を確認してください');
      throw err;
    } finally {
      clearTimeout(timer);
      if (opt.loading) hideLoading();
    }
  }

  /* =========================================================
   *  パスワード表示切り替え
   * ========================================================= */
  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/><path d="M3.3 2l18.7 18.7-1.4 1.4L1.9 3.4z"/></svg>';

  function initPwToggles() {
    $$('.pw-toggle').forEach(b => { b.innerHTML = EYE; b.setAttribute('aria-pressed', 'false'); });
    document.addEventListener('click', e => {
      const b = e.target.closest('.pw-toggle');
      if (!b) return;
      const inp = b.parentElement.querySelector('input');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = show ? EYE_OFF : EYE;
      b.setAttribute('aria-pressed', String(show));
      b.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    });
  }
  function resetPwVisibility(root) {
    $$('.pw-wrap input', root).forEach(i => { i.type = 'password'; });
    $$('.pw-toggle', root).forEach(b => { b.innerHTML = EYE; b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', 'パスワードを表示'); });
  }

  /* =========================================================
   *  認証
   * ========================================================= */
  function switchAuthTab(name, keepNotice) {
    $$('[data-auth-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.authTab === name)));
    $$('[data-auth-panel]').forEach(p => { p.hidden = p.dataset.authPanel !== name; });
    if (!keepNotice) $('#auth-notice').hidden = true;
    resetPwVisibility($('#auth-screen'));
  }
  function authNotice(text, type, tempPw) {
    const n = $('#auth-notice');
    n.className = 'notice' + (type ? ' ' + type : '');
    n.textContent = text;
    if (tempPw) {
      const s = document.createElement('span');
      s.className = 'temp-pw';
      s.textContent = tempPw;
      n.appendChild(s);
    }
    n.hidden = false;
  }

  function bindAuth() {
    $$('[data-auth-tab]').forEach(b => b.addEventListener('click', () => switchAuthTab(b.dataset.authTab)));

    $('#login-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      try {
        const r = await api('login', { email: f.email.value.trim(), password: f.password.value }, { loading: 'ログインしています' });
        state.token = r.token;
        store.set(KEY.token, r.token);
        f.password.value = '';
        $('#auth-notice').hidden = true;
        onLoggedIn(r.user);
      } catch (err) {
        authNotice(err.message, 'error');
      }
    });

    $('#register-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const email = f.email.value.trim();
      try {
        const r = await api('register', { email, nickname: f.nickname.value.trim() }, { loading: '仮パスワードを発行しています' });
        f.reset();
        $('#login-form').email.value = email;
        switchAuthTab('login', true);
        authNotice(r.message + (r.tempPassword ? ' 仮パスワード：' : ''), '', r.tempPassword);
        $('#login-form').password.focus();
      } catch (err) {
        authNotice(err.message, 'error');
      }
    });

    $('#forgot-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const email = f.email.value.trim();
      try {
        const r = await api('resetPassword', { email }, { loading: '仮パスワードを再発行しています' });
        f.reset();
        $('#login-form').email.value = email;
        switchAuthTab('login', true);
        authNotice(r.message + (r.tempPassword ? ' 仮パスワード：' : ''), '', r.tempPassword);
      } catch (err) {
        authNotice(err.message, 'error');
      }
    });
  }

  function showAuth() {
    $('#app').hidden = true;
    $('#auth-screen').hidden = false;
  }

  function onLoggedIn(user) {
    state.user = user;
    $('#auth-screen').hidden = true;
    $('#app').hidden = false;
    $('#user-name').textContent = (user.nickname || '') + ' さん';
    renderGenres();
    renderMap();
    if (user.mustChange) openPwModal(true);
    else maybeShowHelp();
  }

  function handleExpired(msg) {
    store.del(KEY.token);
    state.token = null;
    state.user = null;
    $$('dialog[open]').forEach(d => { state.pwForced = false; d.close(); });
    closeDrill();
    showAuth();
    switchAuthTab('login');
    authNotice(msg || 'ログインの有効期限が切れました。もう一度ログインしてください', 'error');
  }

  async function logout() {
    try { await api('logout', {}); } catch (e) { /* noop */ }
    store.del(KEY.token);
    state.token = null;
    state.user = null;
    state.trend = null;
    state.reportLoaded = false;
    stopAudio();
    closeDrill();
    showAuth();
    switchAuthTab('login');
    authNotice('ログアウトしました');
  }

  /* ---------- パスワード変更 ---------- */
  function openPwModal(forced) {
    state.pwForced = !!forced;
    const dlg = $('#pw-modal');
    const f = $('#pw-form');
    f.reset();
    resetPwVisibility(f);
    $('#pw-lead').textContent = forced
      ? '仮パスワードでログインしました。続けるには、新しいパスワードを設定してください。'
      : '現在のパスワードと、新しいパスワードを入力してください。';
    $('#pw-cancel').hidden = !!forced;
    if (!dlg.open) dlg.showModal();
    setTimeout(() => f.elements.current.focus(), 60);
  }

  async function onPwSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const cur = f.elements.current.value;
    const nx = f.elements.next.value;
    const cf = f.elements.confirm.value;
    if (nx !== cf) { toast('確認用のパスワードが一致しません', 'error'); return; }
    if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(nx)) { toast('8文字以上で、英字と数字を両方含めてください', 'error'); return; }
    try {
      await api('changePassword', { current: cur, next: nx }, { loading: 'パスワードを変更しています' });
      const wasForced = state.pwForced;
      state.pwForced = false;
      if (state.user) state.user.mustChange = false;
      $('#pw-modal').close();
      toast('パスワードを変更しました');
      if (wasForced) maybeShowHelp();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* =========================================================
   *  使い方
   * ========================================================= */
  function openHelp(sectionId) {
    const dlg = $('#help-modal');
    $('#help-hide-next').checked = store.get(KEY.help) === '1';
    $$('#help-modal details').forEach(d => { d.open = false; });
    const target = sectionId ? document.getElementById(sectionId) : null;
    if (target) target.open = true;
    if (!dlg.open) dlg.showModal();
    const body = $('.help-body', dlg);
    if (target) setTimeout(() => body.scrollTo({ top: target.offsetTop - body.offsetTop - 8 }), 30);
    else body.scrollTop = 0;
  }
  function maybeShowHelp() {
    if (store.get(KEY.help) !== '1') openHelp('help-make');
  }

  /* =========================================================
   *  画面切り替え
   * ========================================================= */
  function showView(v) {
    $$('[data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
    ['map', 'calendar', 'report'].forEach(n => { $('#view-' + n).hidden = n !== v; });
    stopAudio();
    if (v !== 'map') closeDrill();
    if (v === 'calendar') loadMonth();
    if (v === 'report' && !state.reportLoaded) loadLatestReport();
    window.scrollTo(0, 0);
  }

  /* =========================================================
   *  ジャンル
   * ========================================================= */
  function renderGenres() {
    const list = (C.GENRES || []).concat(['その他']);
    if (!state.isOther && (C.GENRES || []).indexOf(state.genre) < 0) {
      state.isOther = true;
      $('#genre-other-input').value = state.genre;
    }
    $('#genre-chips').innerHTML = list.map(g => {
      const sel = g === 'その他' ? state.isOther : (!state.isOther && state.genre === g);
      return `<button type="button" class="chip" role="radio" aria-checked="${sel}" data-genre="${esc(g)}">${esc(g)}</button>`;
    }).join('');
    $('#genre-other').hidden = !state.isOther;
    $('#genre-datalist').innerHTML = (C.GENRES || []).map(g => `<option value="${esc(g)}">`).join('');
  }
  function selectGenre(g) {
    if (g === 'その他') {
      state.isOther = true;
      renderGenres();
      $('#genre-other-input').focus();
    } else {
      state.isOther = false;
      state.genre = g;
      renderGenres();
    }
  }
  function currentGenre() {
    return state.isOther ? $('#genre-other-input').value.trim() : state.genre;
  }

  /* =========================================================
   *  トレンド取得
   * ========================================================= */
  async function loadTrend(refresh, genreArg) {
    const genre = genreArg || currentGenre();
    if (!genre) { toast('ジャンルを選ぶか、入力してください', 'error'); return; }
    stopAudio();
    try {
      const r = await api('trends', { genre, refresh: !!refresh, items: GEM.TREND_ITEMS }, {
        loading: `「${genre}」のいまの流行を調べています。20〜60秒ほどお待ちください`
      });
      state.trend = r.trend;
      state.trendDate = r.date;
      state.trendCached = !!r.cached;
      state.genre = genre;
      store.set(KEY.genre, genre);
      state.probe = null;
      closeDrill();
      renderTrendHead();
      renderMap();
      renderItemList();
      renderMeReco();
      $('#btn-refresh').disabled = false;
      $('#map-head').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderTrendHead() {
    const t = state.trend;
    $('#map-head').hidden = !t;
    $('#map-hint').hidden = !t;
    if (!t) return;
    $('#map-date').textContent = state.trendDate + ' 時点' + (state.trendCached ? '（今日作った地図を表示しています）' : '');
    $('#map-title').textContent = `${state.genre}のいま`;
    $('#map-headline').textContent = t.headline || '';
    $('#map-overview').textContent = t.overview || '';
  }

  /* =========================================================
   *  4象限マップ（SVG）
   * ========================================================= */
  const G = { S: 600, P: 22 };
  G.R = (G.S - 2 * G.P) / 2;
  G.CX = G.S / 2;
  G.CY = G.S / 2;
  function toPx(x, y) { return [G.CX + x / 100 * G.R, G.CY - y / 100 * G.R]; }
  function starPath(cx, cy, r1, r2) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? r2 : r1;
      const a = Math.PI / 5 * i - Math.PI / 2;
      d += (i ? 'L' : 'M') + (cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1);
    }
    return d + 'Z';
  }
  function svgText(x, y, text, anchor, cls) {
    return `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(text)}</text>`;
  }
  function recoSets(me) {
    const items = state.trend ? state.trend.items : [];
    const near = nearest(items, me.x, me.y, 3);
    const diag = nearest(items, -me.x, -me.y, 3, new Set(near.map(i => i.id)));
    return { near, diag };
  }

  function renderMap() {
    const svg = $('#map');
    const t = state.trend;
    const { S, P, R, CX, CY } = G;
    let h = '';
    h += `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow-head"/></marker></defs>`;
    h += `<rect class="q2" x="${P}" y="${P}" width="${R}" height="${R}"/>`;
    h += `<rect class="q1" x="${CX}" y="${P}" width="${R}" height="${R}"/>`;
    h += `<rect class="q3" x="${P}" y="${CY}" width="${R}" height="${R}"/>`;
    h += `<rect class="q4" x="${CX}" y="${CY}" width="${R}" height="${R}"/>`;
    for (let v = -75; v <= 75; v += 25) {
      if (v === 0) continue;
      const gx = toPx(v, 0)[0];
      const gy = toPx(0, v)[1];
      h += `<line class="grid" x1="${gx}" y1="${P}" x2="${gx}" y2="${S - P}"/><line class="grid" x1="${P}" y1="${gy}" x2="${S - P}" y2="${gy}"/>`;
    }
    h += `<line class="axis" x1="${P + 4}" y1="${CY}" x2="${S - P - 4}" y2="${CY}" marker-start="url(#arrow)" marker-end="url(#arrow)"/>`;
    h += `<line class="axis" x1="${CX}" y1="${S - P - 4}" x2="${CX}" y2="${P + 4}" marker-start="url(#arrow)" marker-end="url(#arrow)"/>`;

    if (!t) {
      svg.innerHTML = h;
      $('#map-empty').hidden = false;
      return;
    }
    $('#map-empty').hidden = true;

    const ax = t.axes;
    const qn = t.quadrants;
    h += svgText(P + 12, CY - 12, ax.x.neg, 'start', 'axis-label');
    h += svgText(S - P - 12, CY - 12, ax.x.pos, 'end', 'axis-label');
    h += svgText(CX + 12, P + 26, ax.y.pos, 'start', 'axis-label');
    h += svgText(CX + 12, S - P - 14, ax.y.neg, 'start', 'axis-label');
    h += svgText(S - P - 14, P + 26, qn.q1, 'end', 'quad-name q1n');
    h += svgText(P + 14, P + 26, qn.q2, 'start', 'quad-name q2n');
    h += svgText(P + 14, S - P - 14, qn.q3, 'start', 'quad-name q3n');
    h += svgText(S - P - 14, S - P - 14, qn.q4, 'end', 'quad-name q4n');

    if (state.probe) {
      const [px, py] = toPx(state.probe.x, state.probe.y);
      const zr = (C.NEAR_RADIUS || 30) / 100 * R;
      h += `<circle class="probe-zone" cx="${px}" cy="${py}" r="${zr}"/><circle class="probe" cx="${px}" cy="${py}" r="8"/>`;
      h += `<line class="probe" x1="${px - 16}" y1="${py}" x2="${px + 16}" y2="${py}"/><line class="probe" x1="${px}" y1="${py - 16}" x2="${px}" y2="${py + 16}"/>`;
    }

    const me = state.me[state.genre];
    let nearSet = new Set();
    let diagSet = new Set();
    if (me) {
      const rs = recoSets(me);
      nearSet = new Set(rs.near.map(i => i.id));
      diagSet = new Set(rs.diag.map(i => i.id));
    }
    const selId = state.drill && state.drill.focus ? state.drill.focus.id : null;

    // ラベルの重なりを避ける配置（右→左→上下にずらす）
    const dots = t.items.map(it => toPx(it.x, it.y));
    const placed = [];
    const overlap = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
    const labelPos = (px, py, text) => {
      const w = text.length * 15 + 4;
      const cands = [[18, 5, 'start'], [-18, 5, 'end'], [18, -15, 'start'], [-18, -15, 'end'], [18, 25, 'start'], [-18, 25, 'end']];
      let best = null;
      for (const [dx, dy, anchor] of cands) {
        const x1 = anchor === 'start' ? px + dx : px + dx - w;
        const box = { x1, x2: x1 + w, y1: py + dy - 15, y2: py + dy + 4 };
        if (box.x1 < P || box.x2 > S - P) continue;
        const hit = placed.some(b => overlap(b, box)) ||
          dots.some(([dx2, dy2]) => !(dx2 === px && dy2 === py) && overlap(box, { x1: dx2 - 13, x2: dx2 + 13, y1: dy2 - 13, y2: dy2 + 13 }));
        const c = { x: px + dx, y: py + dy, anchor, box };
        if (!hit) { best = c; break; }
        if (!best) best = c;
      }
      if (!best) best = { x: px + 18, y: py + 5, anchor: 'start', box: { x1: px, x2: px, y1: py, y2: py } };
      placed.push(best.box);
      return best;
    };

    t.items.forEach((it, idx) => {
      const [px, py] = toPx(it.x, it.y);
      const q = quadOf(it.x, it.y);
      const label = trunc(it.name, 11);
      const lp = labelPos(px, py, label);
      const cls = ['item', q];
      if (nearSet.has(it.id)) cls.push('is-near');
      if (diagSet.has(it.id)) cls.push('is-diag');
      if (selId === it.id) cls.push('is-selected');
      h += `<g class="${cls.join(' ')}" data-id="${esc(it.id)}" tabindex="0" role="button" aria-label="${idx + 1}. ${esc(it.name)}">`;
      h += `<circle class="hit" cx="${px}" cy="${py}" r="22"/>`;
      if (nearSet.has(it.id)) h += `<circle class="ring-near" cx="${px}" cy="${py}" r="20"/>`;
      if (diagSet.has(it.id)) h += `<circle class="ring-diag" cx="${px}" cy="${py}" r="20"/>`;
      h += `<circle class="dot" cx="${px}" cy="${py}" r="13"/>`;
      h += `<text class="num" x="${px}" y="${py + 5}" text-anchor="middle">${idx + 1}</text>`;
      h += `<text class="item-label" x="${lp.x}" y="${lp.y}" text-anchor="${lp.anchor}">${esc(label)}</text>`;
      h += `</g>`;
    });

    if (me) {
      const [sx, sy] = toPx(me.x, me.y);
      const ly = sy < P + 50 ? sy + 40 : sy - 24;
      h += `<g class="me" aria-label="あなたの現在地"><path class="star" d="${starPath(sx, sy, 19, 8)}"/>`;
      h += `<text class="me-label" x="${sx}" y="${ly}" text-anchor="middle">あなたの現在地</text></g>`;
    }
    svg.innerHTML = h;
  }

  function svgPoint(e) {
    const svg = $('#map');
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = svg.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const q = p.matrixTransform(ctm.inverse());
    return { x: (q.x - G.CX) / G.R * 100, y: (G.CY - q.y) / G.R * 100 };
  }

  function onMapClick(e) {
    if (!state.trend) return;
    const g = e.target.closest('.item');
    if (g) { openItem(g.dataset.id); return; }
    const p = svgPoint(e);
    if (!p || Math.abs(p.x) > 100 || Math.abs(p.y) > 100) return;
    openArea(p.x, p.y);
  }

  function renderItemList() {
    const t = state.trend;
    $('#side-list').hidden = !t;
    if (!t) return;
    $('#item-list').innerHTML = t.items.map((it, i) => {
      const q = quadOf(it.x, it.y);
      return `<li class="${q}"><button type="button" data-act="open-item" data-id="${esc(it.id)}"><span class="n">${i + 1}</span><span><span class="t">${esc(it.name)}</span><span class="s">${esc(t.quadrants[q])}｜${esc(it.summary)}</span></span></button></li>`;
    }).join('');
    const src = t.sources || [];
    $('#sources').innerHTML = src.length
      ? `参考にした情報<ul>${src.map(s => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul>`
      : '';
  }

  /* =========================================================
   *  ドリルダウン
   * ========================================================= */
  function openItem(id) {
    const t = state.trend;
    const it = t && t.items.find(i => i.id === id);
    if (!it) return;
    const others = nearest(t.items, it.x, it.y, 2, new Set([id]));
    state.probe = null;
    openDrill({ focus: it, items: [it].concat(others), x: it.x, y: it.y });
  }

  function openArea(x, y) {
    const t = state.trend;
    const r = C.NEAR_RADIUS || 30;
    let items = t.items.filter(i => dist(i.x, i.y, x, y) <= r).sort((a, b) => dist(a.x, a.y, x, y) - dist(b.x, b.y, x, y));
    if (items.length < 2) items = nearest(t.items, x, y, 3);
    state.probe = { x, y };
    openDrill({ focus: null, items: items.slice(0, 5), x, y });
  }

  function trendCard(it) {
    const q = quadOf(it.x, it.y);
    const isFocus = state.drill && state.drill.focus && state.drill.focus.id === it.id;
    const idx = state.trend.items.indexOf(it) + 1;
    return `<article class="trend-card ${q}${isFocus ? ' is-focus' : ''}">
      <h3>${idx}. ${esc(it.name)}</h3>
      <p>${esc(it.summary)}</p>
      ${it.keywords && it.keywords.length ? `<p class="tags">${it.keywords.map(k => `<span>#${esc(k)}</span>`).join('')}</p>` : ''}
      <div class="rec-row" role="group" aria-label="${esc(it.name)}を記録">
        ${['気になる', 'チェックした', '体験した'].map(s => `<button type="button" class="rec-btn ${STATUS_CLASS[s]}" data-act="record" data-id="${esc(it.id)}" data-status="${s}">${s}</button>`).join('')}
      </div>
    </article>`;
  }

  function openDrill(ctx) {
    stopAudio();
    state.drill = ctx;
    state.deep = null;
    state.earthIdx = 0;
    state.earthAssets = [];
    const seq = ++state.drillSeq;
    const t = state.trend;
    const q = quadOf(ctx.x, ctx.y);
    const title = ctx.focus ? ctx.focus.name : 'この周辺の流行';
    const pos = `${t.quadrants[q] || ''}（横 ${Math.round(ctx.x)}／縦 ${Math.round(ctx.y)}）`;

    $('#drill-body').innerHTML = `
      <header class="drill-head ${q}">
        <div><p class="drill-pos">${esc(pos)}</p><h2 id="drill-title" tabindex="-1">${esc(title)}</h2></div>
        <button type="button" class="icon-btn" data-act="close-drill" aria-label="閉じる">×</button>
      </header>
      <div class="drill-inner">
        ${ctx.items.map(trendCard).join('')}
        <section id="deep" class="deep"><div class="thinking"><span class="pulse"></span>AIがこのあたりを深掘りしています…</div></section>
        <section id="earth" class="earth" hidden></section>
      </div>`;

    const d = $('#drill');
    d.hidden = false;
    d.scrollTop = 0;
    if (window.matchMedia('(max-width: 959px)').matches) {
      document.body.classList.add('drill-open');
    } else {
      $('.side-col').scrollTop = 0;
    }
    renderMap();
    renderEarth();
    $('#drill-title').focus({ preventScroll: true });
    fetchDeep(seq);
  }

  function closeDrill() {
    state.drill = null;
    state.probe = null;
    $('#drill').hidden = true;
    document.body.classList.remove('drill-open');
    stopAudio();
    if (state.trend) renderMap();
  }

  async function fetchDeep(seq) {
    const ctx = state.drill;
    const t = state.trend;
    if (!ctx || !t) return;
    const box = $('#deep');
    if (box) box.innerHTML = '<div class="thinking"><span class="pulse"></span>AIがこのあたりを深掘りしています…</div>';
    try {
      const r = await api('drilldown', {
        genre: state.genre,
        axes: t.axes,
        quadrants: t.quadrants,
        x: Math.round(ctx.x),
        y: Math.round(ctx.y),
        focus: ctx.focus ? compact(ctx.focus) : null,
        items: ctx.items.map(compact)
      });
      if (seq !== state.drillSeq) return;
      state.deep = r.deep;
      renderDeep();
      renderEarth(r.assets || []);
    } catch (err) {
      if (seq !== state.drillSeq) return;
      const b = $('#deep');
      if (b) b.innerHTML = `<p class="error-text">${esc(err.message)}</p><button type="button" class="btn ghost small" data-act="retry-deep">もう一度深掘りする</button>`;
    }
  }

  function renderDeep() {
    const d = state.deep;
    const box = $('#deep');
    if (!d || !box) return;
    let h = `<h3 class="deep-title">${esc(d.title || '深掘りガイド')}</h3>`;
    if (d.lead) h += `<p class="lead">${esc(d.lead)}</p>`;
    if (d.ttsScript) h += `<button type="button" class="btn ghost small" data-act="tts-deep">▶ 音声で聞く</button>`;
    if (d.picks && d.picks.length) {
      h += `<h4>おすすめ</h4><ul class="picks">${d.picks.map((p, i) => `
        <li>
          <p class="pick-name">${esc(p.name)}</p>
          ${p.why ? `<p>${esc(p.why)}</p>` : ''}
          ${p.firstStep ? `<p class="first-step"><span>はじめの一歩</span>${esc(p.firstStep)}</p>` : ''}
          <button type="button" class="btn ghost small" data-act="record-pick" data-idx="${i}">記録する</button>
        </li>`).join('')}</ul>`;
    }
    if (d.keywords && d.keywords.length) {
      h += `<h4>関連キーワード</h4><p class="kw-list">${d.keywords.map(k => `<span>${esc(k)}</span>`).join('')}</p>`;
    }
    if (d.deepDive && d.deepDive.length) {
      h += `<h4>もっと深く楽しむには</h4><ul class="deep-list">${d.deepDive.map(k => `<li>${esc(k)}</li>`).join('')}</ul>`;
    }
    if (d.sources && d.sources.length) {
      h += `<div class="sources">参考にした情報<ul>${d.sources.map(s => `<li><a href="${esc(s.uri)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul></div>`;
    }
    box.innerHTML = h;
  }

  /* ---------- Google Earth / Earth Studio プレビュー ---------- */
  function earthUrl(p) {
    const e = C.EARTH || {};
    return `https://earth.google.com/web/@${p.lat},${p.lng},300a,${e.RANGE || 2500}d,35y,0h,${e.TILT || 60}t,0r`;
  }

  function renderEarth(assets) {
    const ctx = state.drill;
    const sec = $('#earth');
    if (!ctx || !sec) return;
    if (assets) state.earthAssets = assets;
    const places = ctx.items.filter(i => i.place);
    const as = state.earthAssets || [];
    if (!places.length && !as.length) { sec.hidden = true; return; }
    sec.hidden = false;

    let h = '<h3 class="earth-title">現地を空から見る</h3>';
    as.forEach(a => {
      h += `<figure class="earth-frame"><iframe src="https://drive.google.com/file/d/${encodeURIComponent(a.driveFileId)}/preview" allow="autoplay; fullscreen" allowfullscreen loading="lazy" title="${esc(a.keyword)}の映像"></iframe><figcaption>${esc(a.note || a.keyword)}</figcaption></figure>`;
    });
    if (places.length) {
      const idx = Math.min(state.earthIdx, places.length - 1);
      const p = places[idx].place;
      if (places.length > 1) {
        h += `<div class="earth-tabs" role="group" aria-label="地点を選ぶ">${places.map((it, i) => `<button type="button" data-act="earth-tab" data-idx="${i}" aria-pressed="${i === idx}">${esc(trunc(it.place.name, 14))}</button>`).join('')}</div>`;
      }
      h += `<figure class="earth-frame"><iframe src="https://maps.google.com/maps?q=${p.lat},${p.lng}&t=k&z=15&output=embed" loading="lazy" title="${esc(p.name)}の航空写真"></iframe><figcaption>${esc(p.name)}</figcaption></figure>`;
      h += `<div class="earth-actions">
          <a class="btn ghost small" href="${earthUrl(p)}" target="_blank" rel="noopener">Google Earthで見る</a>
          <button type="button" class="btn ghost small" data-act="kml">地点をKMLで保存</button>
          <a class="btn ghost small" href="https://earth.google.com/studio/" target="_blank" rel="noopener">Earth Studioを開く</a>
        </div>
        <p class="hint">保存したKMLは Google Earth Studio や Google Earth に読み込んで、フライスルー映像づくりに使えます。</p>`;
    }
    sec.innerHTML = h;
  }

  function downloadKml() {
    const ctx = state.drill;
    if (!ctx) return;
    const places = ctx.items.filter(i => i.place);
    if (!places.length) return;
    const e = C.EARTH || {};
    const x = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const marks = places.map(it => `
    <Placemark>
      <name>${x(it.place.name)}</name>
      <description>${x(it.name + '：' + it.summary)}</description>
      <LookAt><longitude>${it.place.lng}</longitude><latitude>${it.place.lat}</latitude><altitude>0</altitude><heading>0</heading><tilt>${e.TILT || 60}</tilt><range>${e.RANGE || 2500}</range></LookAt>
      <Point><coordinates>${it.place.lng},${it.place.lat},0</coordinates></Point>
    </Placemark>`).join('');
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${x(state.genre + 'の流行スポット')}</name>${marks}
  </Document>
</kml>`;
    const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trend_${state.genre}_${ymd(new Date())}.kml`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* =========================================================
   *  音声読み上げ（Gemini TTS）
   * ========================================================= */
  function pcmToWav(b64, mime) {
    const bin = atob(b64);
    const len = bin.length;
    const pcm = new Uint8Array(len);
    for (let i = 0; i < len; i++) pcm[i] = bin.charCodeAt(i);
    if (/wav|mpeg|mp3|ogg/.test(mime || '')) return new Blob([pcm], { type: mime });
    const m = /rate=(\d+)/.exec(mime || '');
    const rate = m ? Number(m[1]) : 24000;
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + len, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, len, true);
    return new Blob([header, pcm], { type: 'audio/wav' });
  }

  async function playTts(text, btn) {
    if (!text || !btn) return;
    if (state.audioBtn === btn && state.audio) { stopAudio(); return; }
    stopAudio();
    const orig = btn.dataset.label || btn.textContent;
    btn.dataset.label = orig;
    btn.disabled = true;
    btn.textContent = '音声を準備中…';
    try {
      let url = state.audioCache.get(text);
      if (!url) {
        const r = await api('tts', { text, voice: GEM.TTS_VOICE });
        url = URL.createObjectURL(pcmToWav(r.audio, r.mimeType));
        state.audioCache.set(text, url);
      }
      const a = new Audio(url);
      state.audio = a;
      state.audioBtn = btn;
      a.addEventListener('ended', stopAudio);
      await a.play();
      btn.textContent = '■ 止める';
    } catch (err) {
      state.audio = null;
      state.audioBtn = null;
      btn.textContent = orig;
      toast(err.message || '音声を再生できませんでした', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function stopAudio() {
    if (state.audio) { state.audio.pause(); state.audio = null; }
    if (state.audioBtn) { state.audioBtn.textContent = state.audioBtn.dataset.label || '▶ 音声で聞く'; state.audioBtn = null; }
  }

  /* =========================================================
   *  性格診断
   * ========================================================= */
  function fallbackQuestions(axes) {
    const opts = (a, key) => [-80, -35, 35, 80].map((v, i) => {
      const label = [`「${a.neg}」にとても惹かれる`, `どちらかといえば「${a.neg}」`, `どちらかといえば「${a.pos}」`, `「${a.pos}」にとても惹かれる`][i];
      const o = { label, x: 0, y: 0 };
      o[key] = v;
      return o;
    });
    return [
      { q: `いまの気分に近いのはどちら？（${axes.x.name}）`, options: opts(axes.x, 'x') },
      { q: `いまの気分に近いのはどちら？（${axes.y.name}）`, options: opts(axes.y, 'y') },
      { q: '友だちにすすめるとしたら、どちら寄りのものを選びますか？', options: opts(axes.x, 'x') },
      { q: '休日にじっくり楽しむなら、どちら寄りがいいですか？', options: opts(axes.y, 'y') }
    ];
  }

  async function openDiag() {
    if (!state.trend) { toast('先に流行の地図を作ってください', 'error'); return; }
    stopAudio();
    const dlg = $('#diag-modal');
    $('#diag-body').innerHTML = '<div class="thinking"><span class="pulse"></span>あなたへの質問を用意しています…</div>';
    if (!dlg.open) dlg.showModal();
    state.diag = { questions: [], answers: [], i: 0, genre: state.genre };
    let qs = null;
    try {
      const r = await api('diagQuestions', { genre: state.genre, axes: state.trend.axes });
      qs = r.questions;
    } catch (err) {
      if (err.code === 'AUTH') return;
    }
    if (!qs || !qs.length) qs = fallbackQuestions(state.trend.axes);
    if (!state.diag) return;
    state.diag.questions = qs;
    renderDiagStep();
  }

  function renderDiagStep() {
    const d = state.diag;
    const q = d.questions[d.i];
    $('#diag-body').innerHTML = `
      <p class="diag-progress">質問 ${d.i + 1} / ${d.questions.length}</p>
      <div class="diag-bar"><span style="width:${d.i / d.questions.length * 100}%"></span></div>
      <h3 class="diag-q">${esc(q.q)}</h3>
      <div class="diag-options">${q.options.map((o, i) => `<button type="button" class="diag-opt" data-act="diag-answer" data-idx="${i}">${esc(o.label)}</button>`).join('')}</div>
      ${d.i > 0 ? '<button type="button" class="btn ghost small" data-act="diag-back">ひとつ前の質問に戻る</button>' : ''}`;
    const first = $('.diag-opt');
    if (first) first.focus();
  }

  async function answerDiag(idx) {
    const d = state.diag;
    if (!d) return;
    const q = d.questions[d.i];
    const o = q.options[idx];
    d.answers[d.i] = { q: q.q, label: o.label, x: o.x, y: o.y };
    d.i++;
    if (d.i < d.questions.length) { renderDiagStep(); return; }
    await finishDiag();
  }

  async function finishDiag() {
    const d = state.diag;
    const t = state.trend;
    d.answers = d.answers.slice(0, d.questions.length);
    $('#diag-body').innerHTML = '<div class="thinking"><span class="pulse"></span>あなたの現在地を計算しています…</div>';
    let res;
    try {
      const r = await api('diagnose', { genre: d.genre, axes: t.axes, quadrants: t.quadrants, items: t.items.map(compact), answers: d.answers });
      res = r.result;
    } catch (err) {
      if (err.code === 'AUTH') return;
      const avg = k => Math.round(d.answers.reduce((s, a) => s + a[k], 0) / d.answers.length);
      res = { x: avg('x'), y: avg('y'), typeName: '', mood: '', comment: '', nearReason: '', diagonalReason: '' };
      toast('診断コメントを作れませんでした。現在地だけ表示します', 'error');
    }
    state.me[d.genre] = {
      x: res.x, y: res.y, typeName: res.typeName, mood: res.mood, comment: res.comment,
      nearReason: res.nearReason, diagonalReason: res.diagonalReason, at: ymd(new Date())
    };
    store.set(KEY.me, JSON.stringify(state.me));
    renderDiagResult();
    renderMap();
    renderMeReco();
  }

  function renderDiagResult() {
    const me = state.me[state.genre];
    if (!me) return;
    const { near, diag } = recoSets(me);
    $('#diag-body').innerHTML = `
      <div class="diag-result">
        <div class="me-star" aria-hidden="true">★</div>
        <p class="me-type">${esc(me.typeName || 'あなたの現在地')}</p>
        ${me.mood ? `<p class="me-mood">${esc(me.mood)}</p>` : ''}
        ${me.comment ? `<p class="comment">${esc(me.comment)}</p>` : ''}
        <div class="reco-cols">
          <div class="reco-near"><h3>あなたに近い流行</h3><ul>${near.map(recoBtn).join('')}</ul></div>
          <div class="reco-diag"><h3>あえて対角線の流行</h3><ul>${diag.map(recoBtn).join('')}</ul></div>
        </div>
        <div class="modal-actions">
          ${me.comment ? '<button type="button" class="btn ghost" data-act="tts-diag">▶ 結果を聞く</button>' : ''}
          <button type="button" class="btn primary" data-act="close-modal">地図で確かめる</button>
        </div>
      </div>`;
  }

  function recoBtn(it) {
    const idx = state.trend.items.indexOf(it) + 1;
    return `<li><button type="button" class="reco-btn" data-act="open-item" data-id="${esc(it.id)}">${idx}. ${esc(it.name)}</button></li>`;
  }

  function renderMeReco() {
    const box = $('#me-reco');
    const me = state.trend && state.me[state.genre];
    if (!me) { box.hidden = true; return; }
    const { near, diag } = recoSets(me);
    box.hidden = false;
    box.innerHTML = `
      <div class="me-head">
        <span class="me-star" aria-hidden="true">★</span>
        <div><p class="me-type">${esc(me.typeName || 'あなたの現在地')}</p>${me.mood ? `<p class="me-mood">${esc(me.mood)}</p>` : ''}</div>
      </div>
      ${me.comment ? `<p>${esc(me.comment)}</p>` : ''}
      <div class="reco-cols">
        <div class="reco-near"><h3>あなたに近い流行</h3>${me.nearReason ? `<p class="hint">${esc(me.nearReason)}</p>` : ''}<ul>${near.map(recoBtn).join('')}</ul></div>
        <div class="reco-diag"><h3>あえて対角線の流行</h3>${me.diagonalReason ? `<p class="hint">${esc(me.diagonalReason)}</p>` : ''}<ul>${diag.map(recoBtn).join('')}</ul></div>
      </div>
      <button type="button" class="btn ghost small" data-act="rediag">診断をやり直す</button>`;
  }

  /* =========================================================
   *  記録（気になる・チェックした・体験した）
   * ========================================================= */
  function openRecord(target, status) {
    state.recordTarget = target;
    const f = $('#record-form');
    f.reset();
    $('#record-item').textContent = target.itemName;
    const radio = f.querySelector(`input[name="status"][value="${status || '気になる'}"]`);
    if (radio) radio.checked = true;
    f.elements.date.value = ymd(new Date());
    $('#record-modal').showModal();
    setTimeout(() => f.elements.memo.focus(), 60);
  }

  async function onRecordSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const t = state.recordTarget;
    if (!t) return;
    const status = (f.querySelector('input[name="status"]:checked') || {}).value || '気になる';
    try {
      await api('saveHistory', Object.assign({}, t, { status, date: f.elements.date.value, memo: f.elements.memo.value.trim() }), { loading: '記録しています' });
      $('#record-modal').close();
      toast(`「${trunc(t.itemName, 16)}」を${status}として記録しました`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* =========================================================
   *  カレンダー
   * ========================================================= */
  async function loadMonth() {
    try {
      const r = await api('history', { month: state.month }, { loading: '記録を読み込んでいます' });
      state.history = r.entries || [];
    } catch (err) {
      toast(err.message, 'error');
      state.history = [];
    }
    renderCalendar();
    renderDay();
  }

  function shiftMonth(delta) {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    state.month = d.getFullYear() + '-' + pad(d.getMonth() + 1);
    loadMonth();
  }

  function renderCalendar() {
    const [Y, M] = state.month.split('-').map(Number);
    $('#cal-title').textContent = `${Y}年${M}月`;
    const first = new Date(Y, M - 1, 1).getDay();
    const days = new Date(Y, M, 0).getDate();
    const today = ymd(new Date());
    const byDay = {};
    state.history.forEach(e => { (byDay[e.date] = byDay[e.date] || []).push(e); });
    let h = '';
    for (let i = 0; i < first; i++) h += '<div class="cal-cell empty" aria-hidden="true"></div>';
    for (let d = 1; d <= days; d++) {
      const ds = `${Y}-${pad(M)}-${pad(d)}`;
      const es = byDay[ds] || [];
      const wd = (first + d - 1) % 7;
      const cls = ['cal-cell'];
      if (ds === today) cls.push('is-today');
      if (ds === state.day) cls.push('is-sel');
      if (wd === 0) cls.push('sun');
      if (wd === 6) cls.push('sat');
      h += `<button type="button" class="${cls.join(' ')}" data-act="day" data-date="${ds}" aria-label="${M}月${d}日、記録${es.length}件"${ds === state.day ? ' aria-current="date"' : ''}>
        <span class="cal-num">${d}</span>
        ${es.length ? `<span class="cal-count">${es.length}</span>` : ''}
        <span class="cal-dots">${es.slice(0, 6).map(e => `<i class="${STATUS_CLASS[e.status] || ''}"></i>`).join('')}</span>
      </button>`;
    }
    $('#cal-grid').innerHTML = h;
  }

  function entryCard(e) {
    const cls = STATUS_CLASS[e.status] || '';
    return `<article class="entry ${cls}" data-id="${esc(e.id)}">
      <div class="entry-head"><span class="badge ${cls}">${esc(e.status)}</span>${e.genre ? `<span class="entry-genre">${esc(e.genre)}</span>` : ''}</div>
      <h4>${esc(e.itemName || '（無題）')}</h4>
      ${e.summary ? `<p class="entry-sum">${esc(e.summary)}</p>` : ''}
      <label>状態
        <select data-field="status">${STATUS.map(s => `<option${s === e.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
      </label>
      <label>メモ・日記
        <textarea data-field="memo" rows="3" maxlength="1000">${esc(e.memo)}</textarea>
      </label>
      <div class="entry-actions">
        <button type="button" class="btn ghost small danger" data-act="entry-delete" data-id="${esc(e.id)}">削除</button>
        <button type="button" class="btn primary small" data-act="entry-save" data-id="${esc(e.id)}">変更を保存</button>
      </div>
    </article>`;
  }

  function renderDay() {
    const box = $('#cal-day');
    const ds = state.day;
    if (!ds || ds.slice(0, 7) !== state.month) {
      box.innerHTML = '<p class="empty-msg">日付を選ぶと、その日の記録を見たり、日記を書き足したりできます。</p>';
      return;
    }
    const es = state.history.filter(e => e.date === ds);
    box.innerHTML = `
      <h3>${jpDate(ds)}</h3>
      ${es.length ? es.map(entryCard).join('') : '<p class="empty-msg">この日の記録はまだありません。</p>'}
      <form id="day-form" class="day-form stack">
        <h4>この日の記録を書き足す</h4>
        <label>タイトル<input name="itemName" maxlength="80" placeholder="例：話題の映画を観た"></label>
        <label>ジャンル<input name="genre" maxlength="40" list="genre-datalist" value="${esc(state.genre || '')}"></label>
        <label>状態<select name="status">${STATUS.map(s => `<option${s === '日記' ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>メモ・日記<textarea name="memo" rows="4" maxlength="1000"></textarea></label>
        <button class="btn primary" type="submit">この日に記録</button>
      </form>`;
    $('#day-form').addEventListener('submit', onDayFormSubmit);
  }

  async function onDayFormSubmit(e) {
    e.preventDefault();
    const f = e.target;
    const itemName = f.elements.itemName.value.trim();
    const memo = f.elements.memo.value.trim();
    if (!itemName && !memo) { toast('タイトルかメモを入力してください', 'error'); return; }
    try {
      const r = await api('saveHistory', {
        date: state.day, genre: f.elements.genre.value.trim(), itemName,
        status: f.elements.status.value, memo
      }, { loading: '記録しています' });
      state.history.push(r.entry);
      renderCalendar();
      renderDay();
      toast('記録しました');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function saveEntry(id, btn) {
    const card = btn.closest('.entry');
    const status = card.querySelector('[data-field="status"]').value;
    const memo = card.querySelector('[data-field="memo"]').value;
    try {
      const r = await api('updateHistory', { id, status, memo }, { loading: '保存しています' });
      const i = state.history.findIndex(e => e.id === id);
      if (i >= 0) state.history[i] = r.entry;
      renderCalendar();
      renderDay();
      toast('変更を保存しました');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function deleteEntry(id) {
    if (!window.confirm('この記録を削除しますか？元には戻せません。')) return;
    try {
      await api('deleteHistory', { id }, { loading: '削除しています' });
      state.history = state.history.filter(e => e.id !== id);
      renderCalendar();
      renderDay();
      toast('記録を削除しました');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* =========================================================
   *  傾向分析レポート
   * ========================================================= */
  async function loadLatestReport() {
    try {
      const r = await api('latestReport', {}, { loading: '分析レポートを読み込んでいます' });
      state.reportLoaded = true;
      state.report = r.report;
      renderStats(r.stats);
      renderReport();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function runReport() {
    stopAudio();
    try {
      const r = await api('analyze', {}, { loading: '記録をもとに、関心の傾向を分析しています（20秒ほど）' });
      state.reportLoaded = true;
      state.report = r.report;
      renderStats(r.stats);
      renderReport();
      toast('分析レポートを作りました');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function renderStats(s) {
    const box = $('#report-stats');
    if (!s || !s.total) {
      box.innerHTML = '<p class="empty-msg">まだ記録がありません。マップの流行を「気になる」などで記録すると、ここに集計されます。</p>';
      return;
    }
    const maxS = Math.max.apply(null, STATUS.map(k => s.byStatus[k] || 0).concat([1]));
    const genres = (s.byGenre || []).slice(0, 6);
    const maxG = Math.max.apply(null, genres.map(g => g[1]).concat([1]));
    box.innerHTML = `
      <p class="stat-total">${s.total}<small>件の記録（今月 ${s.thisMonth || 0}件）</small></p>
      <h3>状態別</h3>
      <ul class="bars">${STATUS.map(k => {
        const v = s.byStatus[k] || 0;
        return `<li class="${STATUS_CLASS[k]}"><span>${k}</span><span class="bar"><span style="width:${v / maxS * 100}%"></span></span><span class="v">${v}</span></li>`;
      }).join('')}</ul>
      <h3>よく記録しているジャンル</h3>
      <ul class="bars">${genres.map(g => `<li><span>${esc(g[0])}</span><span class="bar"><span style="width:${g[1] / maxG * 100}%"></span></span><span class="v">${g[1]}</span></li>`).join('')}</ul>`;
  }

  function renderReport() {
    const box = $('#report-body');
    const r = state.report;
    if (!r) {
      box.innerHTML = '<p class="empty-msg">まだ分析レポートはありません。記録が3件以上たまったら「傾向を分析する」を押してください。</p>';
      return;
    }
    box.innerHTML = `
      <h2 class="report-headline">${esc(r.headline)}</h2>
      <p>${esc(r.tendency)}</p>
      ${r.ttsScript ? '<p style="margin-top:12px"><button type="button" class="btn ghost small" data-act="tts-report">▶ レポートを聞く</button></p>' : ''}
      ${r.keywords && r.keywords.length ? `<h3>いまの関心キーワード</h3><p class="kw-list">${r.keywords.map(k => `<span>${esc(k)}</span>`).join('')}</p>` : ''}
      ${r.nextGenres && r.nextGenres.length ? `<h3>次に挑戦したいジャンル</h3><div class="next-genres">${r.nextGenres.map(g => `
        <article>
          <h4>${esc(g.genre)}</h4>
          <p>${esc(g.reason)}</p>
          ${g.idea ? `<p class="idea">${esc(g.idea)}</p>` : ''}
          <button type="button" class="btn ghost small" data-act="goto-genre" data-genre="${esc(g.genre)}">この地図を見る</button>
        </article>`).join('')}</div>` : ''}
      ${r.surprise && r.surprise.title ? `<h3>意外なおすすめ</h3><div class="surprise"><h4>${esc(r.surprise.title)}</h4><p>${esc(r.surprise.reason)}</p></div>` : ''}
      ${r.message ? `<p class="report-message">${esc(r.message)}</p>` : ''}
      <p class="report-meta">${esc(r.createdAt || '')} 作成／記録 ${r.count || 0}件をもとに分析</p>`;
  }

  function gotoGenre(g) {
    showView('map');
    if ((C.GENRES || []).indexOf(g) >= 0) {
      state.isOther = false;
      state.genre = g;
    } else {
      state.isOther = true;
      $('#genre-other-input').value = g;
    }
    renderGenres();
    loadTrend(false, g);
  }

  /* =========================================================
   *  クリック操作のまとめ
   * ========================================================= */
  function onAction(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const t = state.trend;

    switch (act) {
      case 'close-modal': {
        const dlg = el.closest('dialog');
        if (dlg && !(dlg.id === 'pw-modal' && state.pwForced)) dlg.close();
        break;
      }
      case 'close-drill': closeDrill(); break;
      case 'help': openHelp(el.dataset.section); break;
      case 'open-item': {
        const dlg = el.closest('dialog');
        if (dlg) dlg.close();
        openItem(el.dataset.id);
        break;
      }
      case 'record': {
        const it = t && t.items.find(i => i.id === el.dataset.id);
        if (it) openRecord({ itemName: it.name, summary: it.summary, genre: state.genre, x: it.x, y: it.y }, el.dataset.status);
        break;
      }
      case 'record-pick': {
        const p = state.deep && state.deep.picks[Number(el.dataset.idx)];
        const ctx = state.drill;
        if (p && ctx) openRecord({ itemName: p.name, summary: p.why, genre: state.genre, x: Math.round(ctx.x), y: Math.round(ctx.y) }, '気になる');
        break;
      }
      case 'retry-deep': fetchDeep(state.drillSeq); break;
      case 'tts-deep': if (state.deep) playTts(state.deep.ttsScript, el); break;
      case 'tts-diag': {
        const me = state.me[state.genre];
        if (me) playTts([me.typeName, me.mood, me.comment].filter(Boolean).join('。'), el);
        break;
      }
      case 'tts-report': if (state.report) playTts(state.report.ttsScript, el); break;
      case 'earth-tab': state.earthIdx = Number(el.dataset.idx) || 0; renderEarth(); break;
      case 'kml': downloadKml(); break;
      case 'diag-answer': answerDiag(Number(el.dataset.idx)); break;
      case 'diag-back': if (state.diag && state.diag.i > 0) { state.diag.i--; renderDiagStep(); } break;
      case 'rediag': openDiag(); break;
      case 'month-prev': shiftMonth(-1); break;
      case 'month-next': shiftMonth(1); break;
      case 'month-today': state.month = ymd(new Date()).slice(0, 7); state.day = ymd(new Date()); loadMonth(); break;
      case 'day': state.day = el.dataset.date; renderCalendar(); renderDay(); if (window.matchMedia('(max-width: 959px)').matches) $('#cal-day').scrollIntoView({ behavior: 'smooth' }); break;
      case 'entry-save': saveEntry(el.dataset.id, el); break;
      case 'entry-delete': deleteEntry(el.dataset.id); break;
      case 'goto-genre': gotoGenre(el.dataset.genre); break;
      default: break;
    }
  }

  /* =========================================================
   *  起動
   * ========================================================= */
  function bindApp() {
    $$('[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    $('#genre-chips').addEventListener('click', e => {
      const b = e.target.closest('[data-genre]');
      if (b) selectGenre(b.dataset.genre);
    });
    $('#genre-other-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); loadTrend(false); }
    });
    $('#btn-analyze').addEventListener('click', () => loadTrend(false));
    $('#btn-refresh').addEventListener('click', () => {
      if (window.confirm('最新の情報で地図を作り直します。少し時間がかかりますがよろしいですか？')) loadTrend(true, state.genre);
    });
    $('#btn-diag').addEventListener('click', openDiag);
    $('#btn-tts-summary').addEventListener('click', e => {
      const t = state.trend;
      if (t) playTts(`${state.genre}のいま。${t.headline}。${t.overview}`, e.currentTarget);
    });

    const svg = $('#map');
    svg.addEventListener('click', onMapClick);
    svg.addEventListener('keydown', e => {
      const g = e.target.closest && e.target.closest('.item');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openItem(g.dataset.id); }
    });

    $('#btn-logout').addEventListener('click', logout);
    $('#btn-pw').addEventListener('click', () => openPwModal(false));
    $('#pw-form').addEventListener('submit', onPwSubmit);
    $('#pw-modal').addEventListener('cancel', e => { if (state.pwForced) e.preventDefault(); });
    $('#diag-modal').addEventListener('close', () => { stopAudio(); state.diag = null; });
    $('#record-form').addEventListener('submit', onRecordSubmit);
    $('#help-hide-next').addEventListener('change', e => {
      if (e.target.checked) store.set(KEY.help, '1'); else store.del(KEY.help);
    });
    $('#btn-run-report').addEventListener('click', runReport);

    document.addEventListener('click', onAction);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('#drill').hidden && !document.querySelector('dialog[open]')) closeDrill();
    });
    // スマホのシート背景タップで閉じる
    document.addEventListener('click', e => {
      if (!document.body.classList.contains('drill-open')) return;
      if (e.target === document.body || e.target === document.documentElement) closeDrill();
    });
  }

  async function boot() {
    $('#version').textContent = C.VERSION || '';
    document.title = C.APP_NAME || document.title;
    initPwToggles();
    bindAuth();
    bindApp();
    renderMap();

    if (state.token) {
      try {
        const r = await api('me', {}, { loading: 'ログイン状態を確認しています' });
        onLoggedIn(r.user);
        return;
      } catch (err) {
        if (err.code !== 'AUTH') {
          showAuth();
          authNotice(err.message, 'error');
          return;
        }
      }
    }
    showAuth();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
