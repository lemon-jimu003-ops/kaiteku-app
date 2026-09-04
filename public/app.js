/* ===================================================================
   カイテク就労時間管理アプリ — クライアントロジック（Netlify版）
   共有データはサーバー（Netlify Functions + Netlify Blobs）に保存され、
   /api/db から取得、/api/db-save で保存する。全端末が同じデータを見る。
=================================================================== */
(function () {
  'use strict';

  /* ---------------------------- 定数 ---------------------------- */
  var LS_SESSION = 'kaiteku_session_v1';
  var QUICK_REPUNCH_MINUTES = 5;
  var LONG_SHIFT_MINUTES = 12 * 60;
  var ODD_HOUR_START = 5;   /* 5時より前は深夜早朝扱い */
  var ODD_HOUR_END = 22;    /* 22時より後は深夜扱い */

  var FLAG_LABELS = {
    long_shift: { label: '長時間勤務', tone: 'warn' },
    odd_hours: { label: '深夜・早朝時間帯', tone: 'warn' },
    quick_repunch: { label: '短時間の再打刻', tone: 'danger' },
  };

  /* ---------------------------- 状態 ---------------------------- */
  var DB = null;
  var session = null;
  var busy = false;
  var toastTimer = null;
  var clockTimer = null;
  var pollTimer = null;
  var API_BASE = '/api';

  function nowDate() { return new Date(); }

  /* ---------------------------- 日時ユーティリティ ---------------------------- */
  function pad2(n) { return String(n).padStart(2, '0'); }

  function toJSTISOString(date) {
    var utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
    var jstMs = utcMs + 9 * 3600000;
    var j = new Date(jstMs);
    return j.getFullYear() + '-' + pad2(j.getMonth() + 1) + '-' + pad2(j.getDate()) +
      'T' + pad2(j.getHours()) + ':' + pad2(j.getMinutes()) + ':' + pad2(j.getSeconds()) + '+09:00';
  }

  function jstDateStr(date) {
    return toJSTISOString(date).slice(0, 10);
  }

  function jstHour(iso) {
    var d = new Date(iso);
    return parseInt(new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false }).format(d), 10);
  }

  function fmtDateLong(dateStr) {
    var d = new Date(dateStr + 'T00:00:00+09:00');
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(d);
  }

  function fmtDateShort(dateStr) {
    var d = new Date(dateStr + 'T00:00:00+09:00');
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', weekday: 'short' }).format(d);
  }

  function fmtTime(iso) {
    if (!iso) return '―';
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  }

  function fmtNowClock() {
    var d = nowDate();
    var datePart = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(d);
    var timePart = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
    return datePart + ' ' + timePart;
  }

  function fmtDuration(min) {
    if (min === null || min === undefined || isNaN(min)) return '―';
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    return h + '時間' + m + '分';
  }

  function fmtDecimalHours(min) {
    if (min === null || min === undefined || isNaN(min)) return '―';
    return (min / 60).toFixed(2) + '時間';
  }

  function monthKey(dateStr) { return dateStr.slice(0, 7); }

  function currentMonthKey() { return jstDateStr(nowDate()).slice(0, 7); }

  function fmtMonthLabel(mk) {
    var parts = mk.split('-');
    return parts[0] + '年' + parseInt(parts[1], 10) + '月';
  }

  function addMonths(mk, delta) {
    var parts = mk.split('-').map(Number);
    var d = new Date(Date.UTC(parts[0], parts[1] - 1 + delta, 1));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------------------- セッション（端末ローカル） ---------------------------- */
  function defaultSession() {
    return {
      role: null,
      loginTab: 'worker',
      staffId: null,
      adminUser: null,
      screen: 'login',
      adminScreen: 'dashboard',
      draft: { qrAction: null, targetRecordId: null, selectedUnits: [], selectedJobs: [], jobOtherText: '', breakMinutes: 0, endAt: null, quickWarningAck: false },
      filters: { from: '', to: '', name: '', staffNo: '', unit: '', job: '', flagOnly: false },
      summary: { staffId: '', month: currentMonthKey(), unitMonth: currentMonthKey(), overallMonth: currentMonthKey(), jobMonth: currentMonthKey() },
      staffImport: null,
      loginFilter: { unit: '', name: '' },
      toast: null,
    };
  }

  function loadSession() {
    try {
      var raw = localStorage.getItem(LS_SESSION);
      if (raw) {
        var parsed = JSON.parse(raw);
        var base = defaultSession();
        return Object.assign(base, parsed, { draft: Object.assign(base.draft, parsed.draft || {}), filters: Object.assign(base.filters, parsed.filters || {}), summary: Object.assign(base.summary, parsed.summary || {}), loginFilter: Object.assign(base.loginFilter, parsed.loginFilter || {}) });
      }
    } catch (e) { /* ignore */ }
    return defaultSession();
  }

  function saveSession() {
    try { localStorage.setItem(LS_SESSION, JSON.stringify(session)); } catch (e) { /* ignore */ }
  }

  function go(screen) {
    session.screen = screen;
    saveSession();
    render();
    var root = document.getElementById('root');
    if (root) root.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function goAdmin(screen) {
    session.adminScreen = screen;
    saveSession();
    render();
    window.scrollTo(0, 0);
  }

  function showToast(msg, tone) {
    session.toast = { msg: msg, tone: tone || 'info', id: Date.now() };
    saveSession();
    render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      session.toast = null;
      saveSession();
      render();
    }, 3600);
  }

  /* ---------------------------- DB読み込み ---------------------------- */
  function emptyDb() {
    return { meta: {}, staff: [], units: [], jobTypes: [], admins: [], qr: { checkin: {}, checkout: {}, history: [] }, records: [], auditNotices: [] };
  }

  async function pullDb() {
    var res = await fetch(API_BASE + '/db', { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch failed: ' + res.status);
    return res.json();
  }

  function cloneDb() { return JSON.parse(JSON.stringify(DB)); }

  function findStaff(staffId) { return DB.staff.find(function (s) { return s.id === staffId; }); }
  function findUnit(unitId) { return DB.units.find(function (u) { return u.id === unitId; }); }
  function findJob(jobId) { return DB.jobTypes.find(function (j) { return j.id === jobId; }); }
  function unitNames(ids) { return ids.map(function (id) { var u = findUnit(id); return u ? u.name : id; }); }
  function jobNames(ids, other) {
    var names = ids.map(function (id) { var j = findJob(id); return j ? j.name : id; });
    return names;
  }

  function activeOnDutyRecord(staffId) {
    return DB.records.find(function (r) { return r.staffId === staffId && r.status === 'on_duty'; });
  }

  function activeOnDutyRecordIn(db, staffId) {
    return db.records.find(function (r) { return r.staffId === staffId && r.status === 'on_duty'; });
  }

  function lastCompletedRecord(staffId) {
    var list = DB.records.filter(function (r) { return r.staffId === staffId && r.status === 'completed'; });
    list.sort(function (a, b) { return new Date(b.endAt) - new Date(a.endAt); });
    return list[0];
  }

  /* ---------------------------- 保存（サーバーへ送信）まわり ---------------------------- */
  function setBusy(v) { busy = v; }

  async function pushDb(newDb) {
    try {
      var res = await fetch(API_BASE + '/db-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newDb),
      });
      if (!res.ok) return { ok: false, code: 'server_error' };
      return { ok: true };
    } catch (e) {
      return { ok: false, code: 'offline' };
    }
  }

  async function mutateAndPublish(mutator, opts) {
    opts = opts || {};
    var draft = cloneDb();
    mutator(draft);
    draft.meta.updatedAt = toJSTISOString(nowDate());
    setBusy(true);
    render();
    var res = await pushDb(draft);
    setBusy(false);
    if (res.ok) {
      DB = draft;
      render();
      if (opts.successMsg) showToast(opts.successMsg, 'success');
    } else {
      render();
      if (res.code === 'offline') {
        showToast('サーバーに接続できませんでした。通信環境をご確認のうえ、もう一度お試しください。', 'danger');
      } else {
        showToast('保存に失敗しました。もう一度お試しください。', 'danger');
      }
    }
    if (opts.after) opts.after(res);
    return res;
  }

  /* ---------------------------- 打刻ロジック ---------------------------- */
  function computeStartFlags(staffId, startAt) {
    var flags = [];
    var h = jstHour(startAt);
    if (h < ODD_HOUR_START || h >= ODD_HOUR_END) flags.push('odd_hours');
    var last = lastCompletedRecord(staffId);
    if (last && last.endAt) {
      var diffMin = (new Date(startAt) - new Date(last.endAt)) / 60000;
      if (diffMin >= 0 && diffMin < QUICK_REPUNCH_MINUTES) flags.push('quick_repunch');
    }
    return flags;
  }

  function computeEndFlags(record, endAt, workedMinutes) {
    var flags = (record.flags || []).slice();
    var h = jstHour(endAt);
    if ((h < ODD_HOUR_START || h >= ODD_HOUR_END) && flags.indexOf('odd_hours') === -1) flags.push('odd_hours');
    if (workedMinutes > LONG_SHIFT_MINUTES && flags.indexOf('long_shift') === -1) flags.push('long_shift');
    return flags;
  }

  function quickRepunchWarning(staffId, atDate) {
    var last = lastCompletedRecord(staffId);
    if (!last || !last.endAt) return null;
    var diffMin = (atDate.getTime() - new Date(last.endAt).getTime()) / 60000;
    if (diffMin >= 0 && diffMin < QUICK_REPUNCH_MINUTES) {
      return Math.max(0, Math.round(diffMin));
    }
    return null;
  }

  /* ---------------------------- レンダリング基盤 ---------------------------- */
  function render() {
    var root = document.getElementById('root');
    if (!root) return;
    var html;
    try {
      if (!session.role) {
        html = renderLogin();
      } else if (session.role === 'worker') {
        html = renderWorker();
      } else {
        html = renderAdmin();
      }
    } catch (e) {
      html = '<div class="err-boundary"><p>画面の表示中にエラーが発生しました。</p><pre>' + escapeHtml(e && e.message) + '</pre><button class="btn btn-primary" data-action="reset-app">最初からやり直す</button></div>';
    }
    root.innerHTML = '<div class="toast-layer">' + renderToast() + '</div>' + html;
    bindGlobalActions(root);
  }

  function renderToast() {
    if (!session.toast) return '';
    var tone = session.toast.tone || 'info';
    return '<div class="toast toast-' + tone + '" role="status">' + escapeHtml(session.toast.msg) + '</div>';
  }

  function screenChrome(innerHtml, opts) {
    opts = opts || {};
    var backBtn = opts.onBack ? '<button class="topbar-back" data-go="' + opts.onBack + '" aria-label="戻る">←</button>' : '<span class="topbar-spacer"></span>';
    return (
      '<div class="phone-shell">' +
      '<div class="topbar">' + backBtn + '<h1 class="topbar-title">' + escapeHtml(opts.title || '') + '</h1><span class="topbar-spacer"></span></div>' +
      (opts.steps ? renderSteps(opts.steps, opts.stepIndex) : '') +
      '<div class="phone-body">' + innerHtml + '</div>' +
      '</div>'
    );
  }

  function renderSteps(steps, idx) {
    return '<div class="steps" aria-hidden="true">' + steps.map(function (label, i) {
      var cls = 'step-dot' + (i === idx ? ' is-current' : i < idx ? ' is-done' : '');
      return '<span class="' + cls + '"><i></i><em>' + escapeHtml(label) + '</em></span>';
    }).join('<span class="step-line"></span>') + '</div>';
  }

  /* ---------------------------- ログイン画面 ---------------------------- */
  function renderLogin() {
    var tab = session.loginTab || 'worker';
    var activeStaff = DB.staff.filter(function (s) { return s.status === '利用中' && !s.deleted; });
    var body =
      '<div class="login-hero">' +
      '<div class="brand-mark" aria-hidden="true">介</div>' +
      '<h2 class="login-title">' + escapeHtml(DB.meta && DB.meta.facilityName || 'カイテク就労時間管理') + '</h2>' +
      '<p class="login-sub">スポットワーカー就労実績管理システム（試作版）</p>' +
      '</div>' +
      '<div class="segmented" role="tablist">' +
      '<button role="tab" class="seg-btn' + (tab === 'worker' ? ' is-active' : '') + '" data-action="set-login-tab" data-tab="worker" aria-selected="' + (tab === 'worker') + '">スポットワーカー</button>' +
      '<button role="tab" class="seg-btn' + (tab === 'admin' ? ' is-active' : '') + '" data-action="set-login-tab" data-tab="admin" aria-selected="' + (tab === 'admin') + '">管理者</button>' +
      '</div>';

    if (tab === 'worker') {
      body += '<p class="hint">所属ユニットで絞り込み、氏名をタップしてログインしてください。</p>';
      var lf = session.loginFilter;
      var homeUnits = DB.units.filter(function (u) { return activeStaff.some(function (s) { return s.homeUnit === u.name; }); });
      body += '<div class="login-filter-bar">' +
        '<select class="login-unit-select" data-action="set-login-unit-filter" aria-label="所属ユニットで絞り込み">' +
        '<option value="">所属ユニット：すべて</option>' +
        homeUnits.map(function (u) { return '<option value="' + escapeHtml(u.name) + '"' + (lf.unit === u.name ? ' selected' : '') + '>' + escapeHtml(u.name) + '</option>'; }).join('') +
        '</select>' +
        '<input type="search" class="login-name-search" data-action="set-login-name-filter" placeholder="氏名・ふりがなで検索" value="' + escapeHtml(lf.name) + '">' +
        '</div>';

      var filteredStaff = activeStaff.filter(function (s) {
        if (lf.unit && s.homeUnit !== lf.unit) return false;
        if (lf.name && s.name.indexOf(lf.name) === -1 && s.kana.indexOf(lf.name) === -1) return false;
        return true;
      });

      var byUnitOnly = activeStaff.filter(function (s) { return !lf.unit || s.homeUnit === lf.unit; });
      body += '<div class="staff-pick-list" id="staff-pick-list">' + byUnitOnly.map(function (s) {
        var hiddenByName = lf.name && s.name.indexOf(lf.name) === -1 && s.kana.indexOf(lf.name) === -1;
        return '<button class="staff-pick" data-action="worker-login" data-id="' + s.id + '" data-name="' + escapeHtml(s.name) + '" data-kana="' + escapeHtml(s.kana) + '"' + (hiddenByName ? ' hidden' : '') + '>' +
          '<span class="staff-pick-no">' + escapeHtml(s.staffNo) + '</span>' +
          '<span class="staff-pick-name">' + escapeHtml(s.name) + '<small>' + escapeHtml(s.kana) + (s.homeUnit ? '　' + s.homeUnit : '') + '</small></span>' +
          '<span class="staff-pick-arrow" aria-hidden="true">›</span>' +
          '</button>';
      }).join('') + '</div>';
      if (!activeStaff.length) body += '<p class="empty">利用可能なスタッフが登録されていません。管理者にお問い合わせください。</p>';
      else body += '<p class="empty" id="staff-pick-empty"' + (filteredStaff.length ? ' hidden' : '') + '>条件に一致するスタッフが見つかりません。</p>';
    } else {
      body += '<form class="admin-login-form" data-action="admin-login">' +
        '<label class="field"><span>ユーザー名</span><input type="text" name="username" autocomplete="username" required placeholder="admin"></label>' +
        '<label class="field"><span>パスワード</span><input type="password" name="password" autocomplete="current-password" required placeholder="••••••••"></label>' +
        '<button type="submit" class="btn btn-primary btn-lg">ログイン</button>' +
        '<p class="hint">試作版デモ用アカウント: admin / admin1234</p>' +
        '</form>';
    }
    return screenChrome(body, { title: '' });
  }

  /* ---------------------------- ワーカー画面ルーター ---------------------------- */
  function renderWorker() {
    var staff = findStaff(session.staffId);
    if (!staff) { session.role = null; saveSession(); return renderLogin(); }
    switch (session.screen) {
      case 'w_home': return renderWorkerHome(staff);
      case 'w_qr': return renderWorkerQr(staff);
      case 'w_start': return renderWorkerStart(staff);
      case 'w_unit': return renderWorkerUnit(staff);
      case 'w_job': return renderWorkerJob(staff);
      case 'w_end': return renderWorkerEnd(staff);
      case 'w_confirm': return renderWorkerConfirm(staff);
      default: return renderWorkerHome(staff);
    }
  }

  function workerStatusBadge(rec) {
    if (!rec) return '<span class="badge badge-neutral">未出勤</span>';
    return '<span class="badge badge-on">勤務中</span>';
  }

  function renderWorkerHome(staff) {
    var onDuty = activeOnDutyRecord(staff.id);
    var recent = DB.records.filter(function (r) { return r.staffId === staff.id && r.status === 'completed'; })
      .sort(function (a, b) { return new Date(b.endAt) - new Date(a.endAt); }).slice(0, 5);

    var body = '<div class="worker-card">' +
      '<div class="worker-card-row"><span class="worker-name">' + escapeHtml(staff.name) + '</span>' + workerStatusBadge(onDuty) + '</div>' +
      '<div class="worker-no">スタッフ番号 ' + escapeHtml(staff.staffNo) + '</div>' +
      '<div class="clock" id="home-clock">' + escapeHtml(fmtNowClock()) + '</div>' +
      '</div>';

    if (onDuty) {
      var elapsedMin = Math.round((nowDate().getTime() - new Date(onDuty.startAt).getTime()) / 60000);
      body += '<div class="on-duty-panel">' +
        '<p class="on-duty-label">出勤中 ' + fmtTime(onDuty.startAt) + '〜（経過 ' + fmtDuration(elapsedMin) + '）</p>' +
        (onDuty.units && onDuty.units.length ? '<p class="on-duty-meta">ユニット: ' + escapeHtml(unitNames(onDuty.units).join('、')) + '</p>' : '<p class="on-duty-meta muted">ユニット未選択</p>') +
        '</div>' +
        '<button class="btn btn-primary btn-xl" data-action="start-qr-flow" data-mode="checkout">退勤する（QRコードを読み取る）</button>';
    } else {
      body += '<button class="btn btn-primary btn-xl" data-action="start-qr-flow" data-mode="checkin">出勤する（QRコードを読み取る）</button>';
    }

    body += '<div class="recent-block"><h3>直近の勤務実績</h3>';
    if (!recent.length) {
      body += '<p class="empty">まだ勤務実績がありません。</p>';
    } else {
      body += '<ul class="recent-list">' + recent.map(function (r) {
        return '<li><span class="recent-date">' + escapeHtml(fmtDateShort(r.date)) + '</span>' +
          '<span class="recent-time">' + fmtTime(r.startAt) + '〜' + fmtTime(r.endAt) + '</span>' +
          '<span class="recent-dur">' + fmtDuration(r.workedMinutes) + '</span></li>';
      }).join('') + '</ul>';
    }
    body += '</div>';
    body += '<button class="link-btn" data-action="logout">ログアウト</button>';

    return screenChrome(body, { title: 'ホーム' });
  }

  function renderWorkerQr(staff) {
    var mode = session.draft.qrAction;
    var label = mode === 'checkin' ? '出勤用QRコード' : '退勤用QRコード';
    var body = '<p class="qr-instruction">施設に設置されている「' + label + '」にスマートフォンのカメラをかざしてください。</p>' +
      '<div class="qr-viewfinder" aria-hidden="true"><span class="corner c-tl"></span><span class="corner c-tr"></span><span class="corner c-bl"></span><span class="corner c-br"></span>' +
      '<span class="qr-scan-icon">▦</span></div>' +
      '<button class="btn btn-primary btn-xl" data-action="simulate-scan" ' + (busy ? 'disabled' : '') + '>' + (busy ? '読み取り中…' : 'QRコードを読み取る（試作版）') + '</button>' +
      '<p class="hint center">実機では実際のQRコードをスキャンします。この試作版ではボタン操作で代用します。</p>';
    return screenChrome(body, { title: mode === 'checkin' ? '出勤QR読み取り' : '退勤QR読み取り', onBack: 'w_home' });
  }

  function renderWorkerStart(staff) {
    var warnMin = quickRepunchWarning(staff.id, nowDate());
    var body = '<div class="identity-card">' +
      '<p class="identity-label">氏名</p><p class="identity-value">' + escapeHtml(staff.name) + '</p>' +
      '<p class="identity-label">スタッフ番号</p><p class="identity-value">' + escapeHtml(staff.staffNo) + '</p>' +
      '<p class="identity-label">現在日時</p><p class="identity-value" id="start-clock">' + escapeHtml(fmtNowClock()) + '</p>' +
      '</div>';
    if (warnMin !== null) {
      body += '<div class="alert alert-danger">前回の退勤から' + warnMin + '分しか経っていません。誤って読み取っていないかご確認のうえ、開始してください。</div>';
    }
    body += '<button class="btn btn-primary btn-xl" data-action="confirm-start" ' + (busy ? 'disabled' : '') + '>' + (busy ? '記録中…' : '勤務開始') + '</button>';
    return screenChrome(body, { title: '勤務開始', onBack: 'w_home', steps: ['開始', 'ユニット'], stepIndex: 0 });
  }

  function checkboxGrid(items, selected, name) {
    return '<div class="checkbox-grid">' + items.map(function (it) {
      var checked = selected.indexOf(it.id) !== -1;
      return '<label class="checkbox-item' + (checked ? ' is-checked' : '') + '">' +
        '<input type="checkbox" name="' + name + '" value="' + it.id + '" ' + (checked ? 'checked' : '') + '>' +
        '<span>' + escapeHtml(it.name) + '</span></label>';
    }).join('') + '</div>';
  }

  function renderWorkerUnit(staff) {
    var units = DB.units.filter(function (u) { return u.active; });
    var body = '<p class="hint">勤務するユニットを選択してください（複数選択可）。</p>' +
      '<form data-action="save-units">' +
      checkboxGrid(units, session.draft.selectedUnits, 'unit') +
      '<button type="submit" class="btn btn-primary btn-xl">この内容で勤務を開始する</button>' +
      '</form>';
    return screenChrome(body, { title: 'ユニット選択', onBack: 'w_home', steps: ['開始', 'ユニット'], stepIndex: 1 });
  }

  function renderWorkerJob(staff) {
    var jobs = DB.jobTypes.filter(function (j) { return j.active; });
    var otherSelected = session.draft.selectedJobs.indexOf(jobs.find(function (j) { return j.isOther; }) ? jobs.find(function (j) { return j.isOther; }).id : '__none__') !== -1;
    var body = '<p class="hint">行った仕事内容を選択してください（複数選択可）。</p>' +
      '<form data-action="save-jobs">' +
      checkboxGrid(jobs, session.draft.selectedJobs, 'job') +
      '<label class="field other-field' + (otherSelected ? '' : ' is-hidden') + '"><span>その他の内容</span>' +
      '<input type="text" name="jobOther" maxlength="80" placeholder="具体的な内容を入力してください" value="' + escapeHtml(session.draft.jobOtherText) + '"></label>' +
      '<button type="submit" class="btn btn-primary btn-xl">次へ</button>' +
      '</form>';
    return screenChrome(body, { title: '仕事内容選択', onBack: 'w_home', steps: ['仕事内容', '休憩', '確認'], stepIndex: 0 });
  }

  function renderWorkerEnd(staff) {
    var rec = DB.records.find(function (r) { return r.id === session.draft.targetRecordId; });
    var body = '<div class="identity-card">' +
      '<p class="identity-label">氏名</p><p class="identity-value">' + escapeHtml(staff.name) + '</p>' +
      '<p class="identity-label">始業時間</p><p class="identity-value">' + (rec ? fmtTime(rec.startAt) : '―') + '</p>' +
      '<p class="identity-label">現在日時</p><p class="identity-value" id="end-clock">' + escapeHtml(fmtNowClock()) + '</p>' +
      '</div>' +
      '<label class="field"><span>休憩時間</span>' +
      '<select data-action="set-break">' + [0, 15, 30, 45, 60, 90].map(function (m) {
        return '<option value="' + m + '"' + (session.draft.breakMinutes === m ? ' selected' : '') + '>' + m + '分</option>';
      }).join('') + '</select></label>' +
      '<button class="btn btn-primary btn-xl" data-action="confirm-end">勤務終了</button>';
    return screenChrome(body, { title: '勤務終了', onBack: 'w_job', steps: ['仕事内容', '休憩', '確認'], stepIndex: 1 });
  }

  function renderWorkerConfirm(staff) {
    var rec = DB.records.find(function (r) { return r.id === session.draft.targetRecordId; });
    if (!rec) return renderWorkerHome(staff);
    var endAt = session.draft.endAt || toJSTISOString(nowDate());
    var workedMinutes = Math.round((new Date(endAt) - new Date(rec.startAt)) / 60000) - session.draft.breakMinutes;
    var jobs = session.draft.selectedJobs.map(function (id) { var j = findJob(id); return j ? j.name : id; });
    if (session.draft.jobOtherText) jobs = jobs.map(function (n) { return n === 'その他' ? 'その他（' + session.draft.jobOtherText + '）' : n; });
    var body = '<div class="summary-card">' +
      summaryRow('氏名', staff.name) +
      summaryRow('勤務日', fmtDateLong(rec.date)) +
      summaryRow('始業時間', fmtTime(rec.startAt)) +
      summaryRow('終業時間', fmtTime(endAt)) +
      summaryRow('休憩時間', session.draft.breakMinutes + '分') +
      summaryRow('実働時間', fmtDuration(workedMinutes) + '（' + fmtDecimalHours(workedMinutes) + '）') +
      summaryRow('勤務ユニット', unitNames(rec.units).join('、') || '―') +
      summaryRow('仕事内容', jobs.join('、') || '―') +
      '</div>' +
      (workedMinutes < 0 ? '<div class="alert alert-danger">終業時間が始業時間より前になっています。もう一度お試しいただくか、管理者にご連絡ください。</div>' : '') +
      '<button class="btn btn-primary btn-xl" data-action="finalize-end" ' + (busy || workedMinutes < 0 ? 'disabled' : '') + '>' + (busy ? '保存中…' : '勤務終了を確定する') + '</button>';
    return screenChrome(body, { title: '勤務確認', onBack: 'w_end', steps: ['仕事内容', '休憩', '確認'], stepIndex: 2 });
  }

  function summaryRow(label, value) {
    return '<div class="summary-row"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
  }

  /* ---------------------------- 管理者画面ルーター ---------------------------- */
  var ADMIN_NAV = [
    { group: '概要', items: [{ key: 'dashboard', label: 'ダッシュボード' }] },
    { group: '実績', items: [
      { key: 'records', label: '勤務実績一覧' },
      { key: 'personal', label: '個人別集計' },
      { key: 'unit', label: 'ユニット別集計' },
      { key: 'month', label: '月別集計' },
      { key: 'jobs', label: '仕事内容別集計' },
      { key: 'export', label: 'Excel出力' },
    ] },
    { group: 'マスタ管理', items: [
      { key: 'staff', label: 'スタッフ管理' },
      { key: 'units', label: 'ユニット管理' },
      { key: 'jobtypes', label: '仕事内容管理' },
      { key: 'qr', label: 'QRコード管理' },
    ] },
  ];
  var ADMIN_TITLES = { dashboard: 'ダッシュボード', records: '勤務実績一覧', personal: '個人別集計', unit: 'ユニット別集計', month: '月別集計', jobs: '仕事内容別集計', export: 'Excel出力', staff: 'スタッフ管理', units: 'ユニット管理', jobtypes: '仕事内容管理', qr: 'QRコード管理' };

  function renderAdmin() {
    var admin = DB.admins.find(function (a) { return a.username === session.adminUser; });
    if (!admin) { session.role = null; saveSession(); return renderLogin(); }
    var content;
    switch (session.adminScreen) {
      case 'records': content = renderAdminRecords(); break;
      case 'personal': content = renderAdminPersonal(); break;
      case 'unit': content = renderAdminUnitSummary(); break;
      case 'month': content = renderAdminMonthSummary(); break;
      case 'jobs': content = renderAdminJobSummary(); break;
      case 'export': content = renderAdminExport(); break;
      case 'staff': content = renderAdminStaff(); break;
      case 'units': content = renderAdminUnits(); break;
      case 'jobtypes': content = renderAdminJobTypes(); break;
      case 'qr': content = renderAdminQr(); break;
      default: content = renderAdminDashboard();
    }
    var navHtml = ADMIN_NAV.map(function (grp) {
      return '<div class="admin-nav-group"><p class="admin-nav-caption">' + escapeHtml(grp.group) + '</p>' +
        grp.items.map(function (it) {
          return '<button class="admin-nav-item' + (session.adminScreen === it.key ? ' is-active' : '') + '" data-go-admin="' + it.key + '">' + escapeHtml(it.label) + '</button>';
        }).join('') + '</div>';
    }).join('');

    return '<div class="admin-shell">' +
      '<aside class="admin-sidebar">' +
      '<div class="admin-brand">' + escapeHtml(DB.meta && DB.meta.facilityName || 'カイテク管理') + '</div>' +
      '<nav>' + navHtml + '</nav>' +
      '<div class="admin-user-box"><span>' + escapeHtml(admin.name) + '</span><button class="link-btn" data-action="logout">ログアウト</button></div>' +
      '</aside>' +
      '<main class="admin-main">' +
      '<div class="admin-topbar"><h1>' + escapeHtml(ADMIN_TITLES[session.adminScreen] || '') + '</h1><span class="admin-clock" id="admin-clock">' + escapeHtml(fmtNowClock()) + '</span></div>' +
      '<div class="admin-content">' + content + '</div>' +
      '</main>' +
      '</div>';
  }

  /* --- ダッシュボード --- */
  function statCard(label, value, sub) {
    return '<div class="stat-card"><p class="stat-label">' + escapeHtml(label) + '</p><p class="stat-value">' + value + '</p>' + (sub ? '<p class="stat-sub">' + sub + '</p>' : '') + '</div>';
  }

  function recordsInMonth(mk) {
    return DB.records.filter(function (r) { return monthKey(r.date) === mk && r.status === 'completed'; });
  }

  function renderAdminDashboard() {
    var mk = currentMonthKey();
    var monthRecs = recordsInMonth(mk);
    var totalMin = monthRecs.reduce(function (s, r) { return s + (r.workedMinutes || 0); }, 0);
    var workerSet = {};
    monthRecs.forEach(function (r) { workerSet[r.staffId] = true; });
    var onDutyCount = DB.records.filter(function (r) { return r.status === 'on_duty'; }).length;
    var flagged = DB.records.filter(function (r) { return r.status === 'completed' && r.flags && r.flags.length && !r.reviewed; });

    var unitTotals = {};
    monthRecs.forEach(function (r) { r.units.forEach(function (uidv) { unitTotals[uidv] = (unitTotals[uidv] || 0) + (r.workedMinutes || 0) / r.units.length; }); });
    var topUnits = Object.keys(unitTotals).map(function (id) { return { id: id, name: findUnit(id) ? findUnit(id).name : id, minutes: unitTotals[id] }; })
      .sort(function (a, b) { return b.minutes - a.minutes; }).slice(0, 6);
    var maxUnitMin = Math.max.apply(null, topUnits.map(function (u) { return u.minutes; }).concat([1]));

    var html = '<div class="stat-grid">' +
      statCard('今月の総勤務時間', fmtDuration(totalMin), fmtDecimalHours(totalMin)) +
      statCard('今月の勤務者数', Object.keys(workerSet).length + '人') +
      statCard('現在勤務中', onDutyCount + '人') +
      statCard('要確認の記録', flagged.length + '件') +
      '</div>';

    html += '<div class="dash-grid">';
    html += '<section class="panel"><h2>要確認アラート</h2>';
    if (!flagged.length) {
      html += '<p class="empty">現在、確認が必要な記録はありません。</p>';
    } else {
      html += '<ul class="alert-list">' + flagged.slice(0, 8).map(function (r) {
        var st = findStaff(r.staffId);
        var flagTags = (r.flags || []).map(function (f) { var fl = FLAG_LABELS[f]; return fl ? '<span class="flag-badge flag-' + fl.tone + '">' + fl.label + '</span>' : ''; }).join('');
        return '<li><div class="alert-list-main"><strong>' + escapeHtml(st ? st.name : r.staffId) + '</strong> <span class="muted">' + escapeHtml(fmtDateShort(r.date)) + ' ' + fmtTime(r.startAt) + '〜' + fmtTime(r.endAt) + '</span>' + flagTags + '</div>' +
          '<button class="btn btn-small" data-action="review-record" data-id="' + r.id + '">確認する</button></li>';
      }).join('') + '</ul>';
    }
    html += '</section>';

    html += '<section class="panel"><h2>ユニット別勤務時間（今月・上位）</h2>';
    if (!topUnits.length) {
      html += '<p class="empty">今月の勤務実績はまだありません。</p>';
    } else {
      html += '<div class="bar-list">' + topUnits.map(function (u) {
        var pct = Math.max(4, Math.round((u.minutes / maxUnitMin) * 100));
        return '<div class="bar-row"><span class="bar-label">' + escapeHtml(u.name) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span><span class="bar-value">' + fmtDecimalHours(u.minutes) + '</span></div>';
      }).join('') + '</div>';
    }
    html += '</section>';
    html += '</div>';
    return html;
  }

  /* --- 検索フィルタ共通 --- */
  function filterRecords(f) {
    return DB.records.filter(function (r) {
      if (f.from && r.date < f.from) return false;
      if (f.to && r.date > f.to) return false;
      if (f.unit && r.units.indexOf(f.unit) === -1) return false;
      if (f.job && r.jobs.indexOf(f.job) === -1) return false;
      if (f.flagOnly && (!r.flags || !r.flags.length)) return false;
      var st = findStaff(r.staffId);
      if (f.name && (!st || st.name.indexOf(f.name) === -1 && st.kana.indexOf(f.name) === -1)) return false;
      if (f.staffNo && (!st || st.staffNo.indexOf(f.staffNo) === -1)) return false;
      return true;
    }).sort(function (a, b) { return b.date.localeCompare(a.date) || new Date(b.startAt) - new Date(a.startAt); });
  }

  function searchPanel(f) {
    return '<form class="search-panel" data-action="apply-filters">' +
      '<label class="field"><span>期間（開始）</span><input type="date" name="from" value="' + escapeHtml(f.from) + '"></label>' +
      '<label class="field"><span>期間（終了）</span><input type="date" name="to" value="' + escapeHtml(f.to) + '"></label>' +
      '<label class="field"><span>氏名</span><input type="text" name="name" value="' + escapeHtml(f.name) + '" placeholder="氏名・ふりがな"></label>' +
      '<label class="field"><span>スタッフ番号</span><input type="text" name="staffNo" value="' + escapeHtml(f.staffNo) + '"></label>' +
      '<label class="field"><span>ユニット</span><select name="unit"><option value="">すべて</option>' + DB.units.map(function (u) { return '<option value="' + u.id + '"' + (f.unit === u.id ? ' selected' : '') + '>' + escapeHtml(u.name) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>仕事内容</span><select name="job"><option value="">すべて</option>' + DB.jobTypes.map(function (j) { return '<option value="' + j.id + '"' + (f.job === j.id ? ' selected' : '') + '>' + escapeHtml(j.name) + '</option>'; }).join('') + '</select></label>' +
      '<label class="field checkbox-inline"><input type="checkbox" name="flagOnly" ' + (f.flagOnly ? 'checked' : '') + '><span>要確認のみ</span></label>' +
      '<button type="submit" class="btn btn-primary">検索</button>' +
      '<button type="button" class="btn btn-ghost" data-action="reset-filters">条件クリア</button>' +
      '</form>';
  }

  function recordRowHtml(r, opts) {
    opts = opts || {};
    var st = findStaff(r.staffId);
    var flagTags = (r.flags || []).map(function (f) { var fl = FLAG_LABELS[f]; return fl ? '<span class="flag-badge flag-' + fl.tone + '">' + fl.label + '</span>' : ''; }).join('');
    var jobs = jobNames(r.jobs).join('、') + (r.jobOther ? '（' + r.jobOther + '）' : '');
    return '<tr' + (r.status === 'on_duty' ? ' class="row-on-duty"' : '') + '>' +
      '<td>' + escapeHtml(fmtDateShort(r.date)) + '</td>' +
      '<td>' + escapeHtml(st ? st.staffNo : '') + '</td>' +
      '<td>' + escapeHtml(st ? st.name : r.staffId) + '</td>' +
      '<td>' + fmtTime(r.startAt) + '</td>' +
      '<td>' + (r.status === 'on_duty' ? '<span class="badge badge-on">勤務中</span>' : fmtTime(r.endAt)) + '</td>' +
      '<td class="num">' + (r.status === 'on_duty' ? '―' : fmtDuration(r.workedMinutes) + '<br><small class="muted">' + fmtDecimalHours(r.workedMinutes) + '</small>') + '</td>' +
      '<td>' + escapeHtml(unitNames(r.units).join('、')) + '</td>' +
      '<td>' + escapeHtml(jobs) + '</td>' +
      '<td>' + flagTags + (r.corrections && r.corrections.length ? '<span class="flag-badge flag-neutral">修正済</span>' : '') + '</td>' +
      '<td>' + (r.status === 'completed' ? '<button class="btn btn-small" data-action="edit-record" data-id="' + r.id + '">修正</button>' : '<span class="muted">―</span>') + '</td>' +
      '</tr>';
  }

  function renderAdminRecords() {
    var list = filterRecords(session.filters);
    var html = searchPanel(session.filters);
    html += '<div class="table-toolbar"><span>' + list.length + '件</span><button class="btn btn-ghost" data-action="goto-export">この条件でExcel出力</button></div>';
    html += recordsTable(list);
    html += renderEditModal();
    return html;
  }

  function recordsTable(list) {
    if (!list.length) return '<p class="empty">条件に一致する記録がありません。</p>';
    return '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>日付</th><th>スタッフ番号</th><th>氏名</th><th>始業</th><th>終業</th><th>実働</th><th>ユニット</th><th>仕事内容</th><th>状態</th><th></th>' +
      '</tr></thead><tbody>' + list.map(function (r) { return recordRowHtml(r); }).join('') + '</tbody></table></div>';
  }

  function renderEditModal() {
    if (!session.editingRecordId) return '';
    var r = DB.records.find(function (x) { return x.id === session.editingRecordId; });
    if (!r) return '';
    var st = findStaff(r.staffId);
    var startD = r.startAt.slice(0, 10), startT = r.startAt.slice(11, 16);
    var endD = r.endAt ? r.endAt.slice(0, 10) : startD, endT = r.endAt ? r.endAt.slice(11, 16) : '';
    return '<div class="modal-overlay" data-action="close-modal">' +
      '<div class="modal" data-stop-close>' +
      '<h2>勤務記録の修正 — ' + escapeHtml(st ? st.name : '') + '（' + escapeHtml(fmtDateShort(r.date)) + '）</h2>' +
      '<form data-action="save-correction" data-id="' + r.id + '">' +
      '<div class="modal-grid">' +
      '<label class="field"><span>始業日</span><input type="date" name="startDate" value="' + startD + '" required></label>' +
      '<label class="field"><span>始業時刻</span><input type="time" name="startTime" value="' + startT + '" required></label>' +
      '<label class="field"><span>終業日</span><input type="date" name="endDate" value="' + endD + '" required></label>' +
      '<label class="field"><span>終業時刻</span><input type="time" name="endTime" value="' + endT + '" required></label>' +
      '<label class="field"><span>休憩時間（分）</span><input type="number" name="breakMinutes" min="0" step="5" value="' + r.breakMinutes + '" required></label>' +
      '<label class="field checkbox-inline"><input type="checkbox" name="reviewed" ' + (r.reviewed ? 'checked' : '') + '><span>確認済みにする</span></label>' +
      '</div>' +
      '<label class="field"><span>ユニット</span></label>' + checkboxGrid(DB.units.filter(function (u) { return u.active; }), r.units, 'units') +
      '<label class="field"><span>仕事内容</span></label>' + checkboxGrid(DB.jobTypes.filter(function (j) { return j.active; }), r.jobs, 'jobs') +
      '<label class="field"><span>修正理由（必須）</span><textarea name="reason" rows="2" required placeholder="修正の理由を入力してください"></textarea></label>' +
      (r.corrections && r.corrections.length ? '<div class="correction-history"><h3>修正履歴</h3>' + r.corrections.map(function (c) {
        return '<div class="correction-item"><p>' + fmtTime(c.beforeStart) + '〜' + fmtTime(c.beforeEnd) + ' → ' + fmtTime(c.afterStart) + '〜' + fmtTime(c.afterEnd) + '</p>' +
          '<p class="muted">' + escapeHtml(c.editor) + ' / ' + escapeHtml(c.editedAt.slice(0, 16).replace('T', ' ')) + '</p><p>理由: ' + escapeHtml(c.reason) + '</p></div>';
      }).join('') + '</div>' : '') +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">キャンセル</button><button type="submit" class="btn btn-primary" ' + (busy ? 'disabled' : '') + '>' + (busy ? '保存中…' : '保存する') + '</button></div>' +
      '</form></div></div>';
  }

  /* --- 個人別集計 --- */
  function renderAdminPersonal() {
    var staffId = session.summary.staffId || (DB.staff[0] && DB.staff[0].id) || '';
    var mk = session.summary.month;
    var recs = DB.records.filter(function (r) { return r.staffId === staffId && r.status === 'completed' && monthKey(r.date) === mk; });
    var totalMin = recs.reduce(function (s, r) { return s + r.workedMinutes; }, 0);
    var unitCount = {}; recs.forEach(function (r) { r.units.forEach(function (u) { unitCount[u] = (unitCount[u] || 0) + 1; }); });
    var jobCount = {}; recs.forEach(function (r) { r.jobs.forEach(function (j) { jobCount[j] = (jobCount[j] || 0) + 1; }); });
    var st = findStaff(staffId);

    var html = '<div class="filter-row">' +
      '<label class="field"><span>スタッフ</span><select data-action="set-summary-staff">' + DB.staff.map(function (s) { return '<option value="' + s.id + '"' + (s.id === staffId ? ' selected' : '') + '>' + escapeHtml(s.staffNo + ' ' + s.name) + (s.deleted ? '（削除済み）' : '') + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>対象月</span><input type="month" value="' + mk + '" data-action="set-summary-month"></label>' +
      '</div>';

    if (!st) return html + '<p class="empty">スタッフが登録されていません。</p>';

    html += '<div class="stat-grid">' +
      statCard(st.name + ' — ' + fmtMonthLabel(mk) + ' 勤務日数', recs.length + '日') +
      statCard('合計勤務時間', fmtDuration(totalMin), fmtDecimalHours(totalMin)) +
      '</div>';

    html += '<div class="dash-grid">';
    html += '<section class="panel"><h2>ユニット別内訳</h2>' + breakdownList(unitCount, findUnit) + '</section>';
    html += '<section class="panel"><h2>仕事内容別内訳</h2>' + breakdownList(jobCount, findJob) + '</section>';
    html += '</div>';

    html += '<section class="panel"><h2>勤務履歴</h2>' + recordsTable(recs) + '</section>';
    return html;
  }

  function breakdownList(counts, resolver) {
    var keys = Object.keys(counts);
    if (!keys.length) return '<p class="empty">データがありません。</p>';
    var max = Math.max.apply(null, keys.map(function (k) { return counts[k]; }));
    keys.sort(function (a, b) { return counts[b] - counts[a]; });
    return '<div class="bar-list">' + keys.map(function (k) {
      var item = resolver(k);
      var pct = Math.max(4, Math.round((counts[k] / max) * 100));
      return '<div class="bar-row"><span class="bar-label">' + escapeHtml(item ? item.name : k) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span><span class="bar-value">' + counts[k] + '件</span></div>';
    }).join('') + '</div>';
  }

  /* --- ユニット別集計 --- */
  function renderAdminUnitSummary() {
    var mk = session.summary.unitMonth;
    var recs = recordsInMonth(mk);
    var totals = {};
    DB.units.forEach(function (u) { totals[u.id] = { minutes: 0, shifts: 0, workers: {} }; });
    recs.forEach(function (r) {
      r.units.forEach(function (uidv) {
        if (!totals[uidv]) totals[uidv] = { minutes: 0, shifts: 0, workers: {} };
        totals[uidv].minutes += r.workedMinutes / r.units.length;
        totals[uidv].shifts += 1;
        totals[uidv].workers[r.staffId] = true;
      });
    });
    var rows = DB.units.map(function (u) { return { u: u, t: totals[u.id] || { minutes: 0, shifts: 0, workers: {} } }; })
      .sort(function (a, b) { return b.t.minutes - a.t.minutes; });

    var html = '<div class="filter-row"><label class="field"><span>対象月</span><input type="month" value="' + mk + '" data-action="set-unit-month"></label></div>';
    html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>ユニット</th><th>合計勤務時間</th><th>件数</th><th>勤務者数</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td>' + escapeHtml(row.u.name) + (row.u.active ? '' : '<span class="muted">（無効）</span>') + '</td><td class="num">' + fmtDuration(row.t.minutes) + ' <small class="muted">(' + fmtDecimalHours(row.t.minutes) + ')</small></td><td class="num">' + row.t.shifts + '件</td><td class="num">' + Object.keys(row.t.workers).length + '人</td></tr>';
      }).join('') + '</tbody></table></div>';
    return html;
  }

  /* --- 月別集計 --- */
  function renderAdminMonthSummary() {
    var mk = session.summary.overallMonth;
    var months = [];
    for (var i = 5; i >= 0; i--) months.push(addMonths(mk, -i));
    var maxMin = 1;
    var rows = months.map(function (m) {
      var recs = recordsInMonth(m);
      var totalMin = recs.reduce(function (s, r) { return s + r.workedMinutes; }, 0);
      var workers = {}; recs.forEach(function (r) { workers[r.staffId] = true; });
      maxMin = Math.max(maxMin, totalMin);
      return { m: m, totalMin: totalMin, workers: Object.keys(workers).length, shifts: recs.length };
    });
    var cur = rows[rows.length - 1];

    var html = '<div class="filter-row"><label class="field"><span>基準月</span><input type="month" value="' + mk + '" data-action="set-overall-month"></label></div>';
    html += '<div class="stat-grid">' +
      statCard(fmtMonthLabel(mk) + ' 勤務者数', cur.workers + '人') +
      statCard(fmtMonthLabel(mk) + ' 総勤務時間', fmtDuration(cur.totalMin), fmtDecimalHours(cur.totalMin)) +
      statCard(fmtMonthLabel(mk) + ' 総勤務日数', cur.shifts + '日') +
      '</div>';
    html += '<section class="panel"><h2>直近6か月の推移</h2><div class="bar-list">' + rows.map(function (row) {
      var pct = Math.max(4, Math.round((row.totalMin / maxMin) * 100));
      return '<div class="bar-row"><span class="bar-label">' + escapeHtml(fmtMonthLabel(row.m)) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span><span class="bar-value">' + fmtDecimalHours(row.totalMin) + '</span></div>';
    }).join('') + '</div></section>';
    return html;
  }

  /* --- 仕事内容別集計 --- */
  function renderAdminJobSummary() {
    var mk = session.summary.jobMonth;
    var recs = recordsInMonth(mk);
    var counts = {};
    DB.jobTypes.forEach(function (j) { counts[j.id] = 0; });
    recs.forEach(function (r) { r.jobs.forEach(function (j) { counts[j] = (counts[j] || 0) + 1; }); });
    var html = '<div class="filter-row"><label class="field"><span>対象月</span><input type="month" value="' + mk + '" data-action="set-job-month"></label></div>';
    html += '<section class="panel"><h2>' + fmtMonthLabel(mk) + ' 仕事内容別 実施件数</h2>' + breakdownList(counts, findJob) + '</section>';
    return html;
  }

  /* --- Excel出力 --- */
  function renderAdminExport() {
    var list = filterRecords(session.filters);
    var html = searchPanel(session.filters);
    html += '<div class="table-toolbar"><span>' + list.length + '件を出力対象にしています</span>' +
      '<button class="btn btn-primary" data-action="export-excel" ' + (busy ? 'disabled' : '') + '>' + (busy ? '作成中…' : 'Excelダウンロード') + '</button></div>';
    html += recordsTable(list);
    return html;
  }

  /* --- スタッフ管理 --- */
  var STAFF_IMPORT_HEADERS = ['スタッフ番号', '氏名', 'ふりがな', '電話番号', 'メールアドレス', '利用状態', '所属ユニット'];

  function renderAdminStaff() {
    var visibleStaff = DB.staff.filter(function (s) { return !s.deleted; });
    var deletedCount = DB.staff.length - visibleStaff.length;
    var html = '<div class="table-toolbar"><span>' + visibleStaff.length + '名' + (deletedCount ? '（削除済み ' + deletedCount + '名は非表示）' : '') + '</span><div class="toolbar-actions">' +
      '<button class="btn btn-ghost" data-action="open-staff-import">CSV/Excelインポート</button>' +
      '<button class="btn btn-ghost" data-action="export-staff-excel" ' + (busy ? 'disabled' : '') + '>Excelエクスポート</button>' +
      '<button class="btn btn-primary" data-action="new-staff">＋ スタッフを追加</button></div></div>';
    html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>スタッフ番号</th><th>氏名</th><th>ふりがな</th><th>電話番号</th><th>メール</th><th>所属ユニット</th><th>状態</th><th></th></tr></thead><tbody>' +
      visibleStaff.map(function (s) {
        return '<tr><td>' + escapeHtml(s.staffNo) + '</td><td>' + escapeHtml(s.name) + '</td><td>' + escapeHtml(s.kana) + '</td><td>' + escapeHtml(s.phone || '―') + '</td><td>' + escapeHtml(s.email || '―') + '</td><td>' + escapeHtml(s.homeUnit || '―') + '</td><td><span class="badge badge-' + (s.status === '利用中' ? 'on' : s.status === '停止中' ? 'warn' : 'neutral') + '">' + escapeHtml(s.status) + '</span></td>' +
          '<td class="row-actions"><button class="btn btn-small" data-action="edit-staff" data-id="' + s.id + '">編集</button><button class="btn btn-small btn-danger-ghost" data-action="delete-staff" data-id="' + s.id + '">削除</button></td></tr>';
      }).join('') + '</tbody></table></div>';
    html += renderStaffModal();
    html += renderStaffImportModal();
    html += renderStaffDeleteModal();
    return html;
  }

  function renderStaffDeleteModal() {
    var id = session.deletingStaffId;
    if (!id) return '';
    var s = DB.staff.find(function (x) { return x.id === id; });
    if (!s) return '';
    var recordCount = DB.records.filter(function (r) { return r.staffId === id; }).length;
    var onDuty = activeOnDutyRecord(id);
    var body = '<div class="modal-overlay" data-action="close-delete-modal"><div class="modal" data-stop-close>' +
      '<h2>スタッフを削除 — ' + escapeHtml(s.name) + '</h2>';
    if (onDuty) {
      body += '<div class="alert alert-danger">現在「勤務中」の記録があるため削除できません。先に管理者による勤務記録の修正で退勤処理を行ってから削除してください。</div>' +
        '<div class="modal-actions"><button type="button" class="btn btn-primary" data-action="close-delete-modal">閉じる</button></div>';
    } else {
      body += '<p>スタッフ一覧とログイン画面の選択肢から表示されなくなります。' + (recordCount ? '過去の勤務実績（' + recordCount + '件）はそのまま残り、氏名・スタッフ番号も引き続き表示されます。' : 'このスタッフにはまだ勤務実績がありません。') + '</p>' +
        '<p class="hint">在籍状況を記録として残したいだけであれば、削除の代わりに「利用状態」を退職にすることもできます。削除後にCSV/Excelインポートで同じスタッフ番号を再登録すると、一覧に復帰させることもできます。</p>' +
        '<div class="modal-actions">' +
        '<button type="button" class="btn btn-ghost" data-action="close-delete-modal">キャンセル</button>' +
        '<button type="button" class="btn btn-ghost" data-action="retire-staff" data-id="' + id + '" ' + (busy ? 'disabled' : '') + '>退職にする</button>' +
        '<button type="button" class="btn btn-danger" data-action="confirm-delete-staff" data-id="' + id + '" ' + (busy ? 'disabled' : '') + '>一覧から削除する</button>' +
        '</div>';
    }
    body += '</div></div>';
    return body;
  }

  function renderStaffModal() {
    if (!session.editingStaffId && session.editingStaffId !== 'new') return '';
    var isNew = session.editingStaffId === 'new';
    var s = isNew ? { id: '', staffNo: '', name: '', kana: '', phone: '', email: '', status: '利用中', homeUnit: '' } : DB.staff.find(function (x) { return x.id === session.editingStaffId; });
    if (!s) return '';
    return '<div class="modal-overlay" data-action="close-modal"><div class="modal" data-stop-close>' +
      '<h2>' + (isNew ? 'スタッフを追加' : 'スタッフ編集 — ' + escapeHtml(s.name)) + '</h2>' +
      '<form data-action="save-staff" data-id="' + (isNew ? 'new' : s.id) + '">' +
      '<div class="modal-grid">' +
      '<label class="field"><span>スタッフ番号</span><input type="text" name="staffNo" value="' + escapeHtml(s.staffNo) + '" required></label>' +
      '<label class="field"><span>氏名</span><input type="text" name="name" value="' + escapeHtml(s.name) + '" required></label>' +
      '<label class="field"><span>ふりがな</span><input type="text" name="kana" value="' + escapeHtml(s.kana) + '" required></label>' +
      '<label class="field"><span>電話番号</span><input type="text" name="phone" value="' + escapeHtml(s.phone) + '" placeholder="090-0000-0000"></label>' +
      '<label class="field"><span>メールアドレス</span><input type="email" name="email" value="' + escapeHtml(s.email) + '"></label>' +
      '<label class="field"><span>利用状態</span><select name="status">' + ['利用中', '停止中', '退職'].map(function (opt) { return '<option value="' + opt + '"' + (s.status === opt ? ' selected' : '') + '>' + opt + '</option>'; }).join('') + '</select></label>' +
      '<label class="field"><span>主な所属ユニット</span><select name="homeUnit"><option value=""' + (!s.homeUnit ? ' selected' : '') + '>未設定</option>' + DB.units.map(function (u) { return '<option value="' + escapeHtml(u.name) + '"' + (s.homeUnit === u.name ? ' selected' : '') + '>' + escapeHtml(u.name) + '</option>'; }).join('') + '</select></label>' +
      '</div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">キャンセル</button><button type="submit" class="btn btn-primary" ' + (busy ? 'disabled' : '') + '>保存する</button></div>' +
      '</form></div></div>';
  }

  /* --- スタッフ CSV/Excel インポート --- */
  function renderStaffImportModal() {
    var im = session.staffImport;
    if (!im) return '';
    var body = '<div class="modal-overlay" data-action="close-import-modal"><div class="modal modal-wide" data-stop-close>' +
      '<h2>スタッフ一括インポート</h2>';

    if (im.stage === 'select') {
      body += '<p class="hint">CSVまたはExcel（.xlsx）ファイルから、スタッフ情報をまとめて登録・更新できます。1行目は見出し行にしてください。</p>' +
        '<div class="import-header-hint"><strong>見出し列</strong>: ' + STAFF_IMPORT_HEADERS.map(function (h) { return escapeHtml(h); }).join('、') + '</div>' +
        '<p class="hint">「スタッフ番号」が既存のスタッフと一致する行は情報を更新し、一致しない行は新規登録します。「スタッフ番号」「氏名」「ふりがな」は必須です。CSVはUTF-8形式で保存してください。</p>' +
        '<div class="import-actions">' +
        '<button type="button" class="btn btn-ghost" data-action="download-staff-template">テンプレートをダウンロード</button>' +
        '<label class="btn btn-primary file-btn">ファイルを選択<input type="file" accept=".csv,.xlsx,.xls" data-action="staff-import-file" hidden></label>' +
        '</div>' +
        (im.error ? '<div class="alert alert-danger">' + escapeHtml(im.error) + '</div>' : '') +
        '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="close-import-modal">閉じる</button></div>';
    } else if (im.stage === 'preview') {
      var insertCount = im.rows.filter(function (r) { return r.action === 'insert'; }).length;
      var updateCount = im.rows.filter(function (r) { return r.action === 'update'; }).length;
      var errorCount = im.rows.filter(function (r) { return r.action === 'error'; }).length;
      body += '<p class="hint">ファイル: ' + escapeHtml(im.fileName) + '（全' + im.rows.length + '行）</p>' +
        '<div class="import-summary">' +
        '<span class="flag-badge flag-neutral">新規登録 ' + insertCount + '件</span>' +
        '<span class="flag-badge flag-neutral">更新 ' + updateCount + '件</span>' +
        (errorCount ? '<span class="flag-badge flag-danger">エラー ' + errorCount + '件（スキップされます）</span>' : '') +
        '</div>' +
        '<div class="table-wrap import-preview-table"><table class="data-table"><thead><tr><th>行</th><th>スタッフ番号</th><th>氏名</th><th>ふりがな</th><th>所属ユニット</th><th>状態</th><th>結果</th></tr></thead><tbody>' +
        im.rows.map(function (r) {
          var resultLabel = r.action === 'insert' ? '<span class="flag-badge flag-neutral">新規</span>' : r.action === 'update' ? '<span class="flag-badge flag-warn">更新</span>' : '<span class="flag-badge flag-danger">エラー</span>';
          var allNotes = (r.errors || []).concat(r.notes || []);
          var noteText = allNotes.length ? '<br><small class="' + (r.errors && r.errors.length ? 'text-danger' : 'muted') + '">' + escapeHtml(allNotes.join(' / ')) + '</small>' : '';
          return '<tr><td>' + r.line + '</td><td>' + escapeHtml(r.staffNo) + '</td><td>' + escapeHtml(r.name) + '</td><td>' + escapeHtml(r.kana) + '</td><td>' + escapeHtml(r.homeUnit || '―') + '</td><td>' + escapeHtml(r.status || '') + '</td><td>' + resultLabel + noteText + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="restart-staff-import">別のファイルを選ぶ</button><button type="button" class="btn btn-ghost" data-action="close-import-modal">キャンセル</button>' +
        '<button type="button" class="btn btn-primary" data-action="confirm-staff-import" ' + (busy || (insertCount + updateCount === 0) ? 'disabled' : '') + '>' + (busy ? '取り込み中…' : (insertCount + updateCount) + '件を取り込む') + '</button></div>';
    }
    body += '</div></div>';
    return body;
  }

  function parseStaffSheetRows(sheetRows) {
    var existingByNo = {};
    DB.staff.forEach(function (s) { existingByNo[s.staffNo] = s; });
    var seenInFile = {};
    return sheetRows.map(function (raw, idx) {
      var get = function (key) { return (raw[key] === undefined || raw[key] === null ? '' : String(raw[key])).trim(); };
      var staffNo = get('スタッフ番号');
      var name = get('氏名');
      var kana = get('ふりがな');
      var phone = get('電話番号');
      var email = get('メールアドレス');
      var statusRaw = get('利用状態');
      var homeUnitRaw = get('所属ユニット');
      var errors = [];
      var notes = [];

      if (!staffNo) errors.push('スタッフ番号が空です');
      if (!name) errors.push('氏名が空です');
      if (!kana) errors.push('ふりがなが空です');
      if (staffNo && seenInFile[staffNo]) errors.push('ファイル内でスタッフ番号が重複しています');
      if (staffNo) seenInFile[staffNo] = true;

      var status = '利用中';
      if (statusRaw) {
        if (['利用中', '停止中', '退職'].indexOf(statusRaw) === -1) errors.push('利用状態は「利用中」「停止中」「退職」のいずれかで入力してください');
        else status = statusRaw;
      }

      var homeUnit = '';
      if (homeUnitRaw) {
        var matchedUnit = DB.units.find(function (u) { return u.name === homeUnitRaw; });
        if (matchedUnit) homeUnit = matchedUnit.name;
        else notes.push('ユニット「' + homeUnitRaw + '」は未登録のため空欄にしました');
      }

      var existing = staffNo ? existingByNo[staffNo] : null;
      var action = errors.length ? 'error' : (existing ? 'update' : 'insert');
      if (existing && existing.deleted && !errors.length) notes.push('削除済みのスタッフ番号のため、一覧に復帰させます');

      return {
        line: idx + 2, staffNo: staffNo, name: name, kana: kana, phone: phone, email: email,
        status: status, homeUnit: homeUnit, action: action, errors: errors, notes: notes,
        matchedStaffId: existing ? existing.id : null,
      };
    });
  }

  function sheetToXlsxBlob(ws, sheetName) {
    var wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, sheetName);
    var wbout = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([wbout], { type: 'application/octet-stream' });
  }

  function downloadStaffTemplate() {
    if (!window.XLSX) { showToast('テンプレート生成ライブラリの読み込みに失敗しました。', 'danger'); return; }
    var sample = [
      { 'スタッフ番号': '10099', '氏名': '例）介護太郎', 'ふりがな': 'かいごたろう', '電話番号': '090-0000-0000', 'メールアドレス': '', '利用状態': '利用中', '所属ユニット': DB.units[0] ? DB.units[0].name : '' },
    ];
    var ws = window.XLSX.utils.json_to_sheet(sample, { header: STAFF_IMPORT_HEADERS });
    ws['!cols'] = STAFF_IMPORT_HEADERS.map(function () { return { wch: 16 }; });
    triggerDownload(sheetToXlsxBlob(ws, 'スタッフ'), 'スタッフ登録テンプレート.xlsx');
  }

  async function exportStaffExcel() {
    if (!window.XLSX) { showToast('Excel出力ライブラリの読み込みに失敗しました。', 'danger'); return; }
    setBusy(true); render();
    try {
      var rows = DB.staff.filter(function (s) { return !s.deleted; }).map(function (s) {
        return { 'スタッフ番号': s.staffNo, '氏名': s.name, 'ふりがな': s.kana, '電話番号': s.phone || '', 'メールアドレス': s.email || '', '利用状態': s.status, '所属ユニット': s.homeUnit || '' };
      });
      var ws = window.XLSX.utils.json_to_sheet(rows, { header: STAFF_IMPORT_HEADERS });
      ws['!cols'] = STAFF_IMPORT_HEADERS.map(function () { return { wch: 16 }; });
      triggerDownload(sheetToXlsxBlob(ws, 'スタッフ'), 'スタッフ一覧_' + jstDateStr(nowDate()) + '.xlsx');

      showToast('スタッフ一覧をダウンロードしました。', 'success');
    } catch (e) {
      showToast('エクスポートに失敗しました。', 'danger');
    }
    setBusy(false); render();
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /* --- ユニット管理／仕事内容管理（共通パターン） --- */
  function renderMasterList(kind, list, label) {
    var html = '<div class="table-toolbar"><span>' + list.length + '件</span><form class="inline-add" data-action="add-master" data-kind="' + kind + '"><input type="text" name="name" placeholder="新しい' + label + '名" required><button type="submit" class="btn btn-primary">＋ 追加</button></form></div>';
    html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>' + label + '名</th><th>状態</th><th></th></tr></thead><tbody>' +
      list.map(function (it) {
        return '<tr><td>' + editableNameCell(kind, it) + '</td><td><span class="badge badge-' + (it.active ? 'on' : 'neutral') + '">' + (it.active ? '有効' : '無効') + '</span></td>' +
          '<td><button class="btn btn-small" data-action="toggle-master" data-kind="' + kind + '" data-id="' + it.id + '"' + (it.isOther ? ' disabled title="その他は常に有効です"' : '') + '>' + (it.active ? '無効にする' : '有効にする') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>';
    return html;
  }

  function editableNameCell(kind, it) {
    return '<form class="inline-rename" data-action="rename-master" data-kind="' + kind + '" data-id="' + it.id + '"><input type="text" name="name" value="' + escapeHtml(it.name) + '" ' + (it.isOther ? 'readonly' : '') + '>' + (it.isOther ? '' : '<button type="submit" class="btn btn-small">保存</button>') + '</form>';
  }

  function renderAdminUnits() { return renderMasterList('units', DB.units, 'ユニット'); }
  function renderAdminJobTypes() { return renderMasterList('jobTypes', DB.jobTypes, '仕事内容'); }

  /* --- QRコード管理 --- */
  function renderAdminQr() {
    var qr = DB.qr;
    var html = '<div class="dash-grid">';
    ['checkin', 'checkout'].forEach(function (kind) {
      var t = qr[kind];
      var label = kind === 'checkin' ? '出勤用QRコード' : '退勤用QRコード';
      html += '<section class="panel qr-panel">' +
        '<h2>' + label + '</h2>' +
        '<div class="qr-image" id="qr-img-' + kind + '" data-qr-text="KAITEKU:' + kind.toUpperCase() + ':' + escapeHtml(t.token) + '"></div>' +
        '<p class="mono">' + escapeHtml(t.token) + '</p>' +
        '<p class="muted">発行日: ' + escapeHtml((t.issuedAt || '').slice(0, 10)) + ' ／ 有効期限: ' + escapeHtml((t.expiresAt || '').slice(0, 10)) + '</p>' +
        '<button class="btn btn-primary" data-action="reissue-qr" data-kind="' + kind + '" ' + (busy ? 'disabled' : '') + '>このQRコードを再発行する</button>' +
        '</section>';
    });
    html += '</div>';
    html += '<section class="panel"><h2>発行履歴</h2>';
    if (!qr.history || !qr.history.length) {
      html += '<p class="empty">再発行履歴はありません。</p>';
    } else {
      html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>種別</th><th>トークン</th><th>発行日</th><th>失効日</th><th>発行者</th></tr></thead><tbody>' +
        qr.history.slice().reverse().map(function (h) {
          return '<tr><td>' + (h.type === 'checkin' ? '出勤用' : '退勤用') + '</td><td class="mono">' + escapeHtml(h.token) + '</td><td>' + escapeHtml((h.issuedAt || '').slice(0, 10)) + '</td><td>' + escapeHtml((h.retiredAt || '').slice(0, 10)) + '</td><td>' + escapeHtml(h.issuedBy) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '</section>';
    return html;
  }

  /* ---------------------------- グローバル操作バインド ---------------------------- */
  function bindGlobalActions(root) {
    /* QRコード画像の描画 */
    root.querySelectorAll('[data-qr-text]').forEach(function (el) {
      try {
        el.innerHTML = '';
        if (window.QRCode) {
          new window.QRCode(el, { text: el.getAttribute('data-qr-text'), width: 160, height: 160, correctLevel: window.QRCode.CorrectLevel.M });
        } else {
          el.textContent = '[QR]';
        }
      } catch (e) { el.textContent = '[QR]'; }
    });

    root.querySelectorAll('[data-go]').forEach(function (el) {
      el.addEventListener('click', function () { go(el.getAttribute('data-go')); });
    });
    root.querySelectorAll('[data-go-admin]').forEach(function (el) {
      el.addEventListener('click', function () { session.editingRecordId = null; session.editingStaffId = null; goAdmin(el.getAttribute('data-go-admin')); });
    });

    var loginTabBtns = root.querySelectorAll('[data-action="set-login-tab"]');
    loginTabBtns.forEach(function (el) {
      el.addEventListener('click', function () { session.loginTab = el.getAttribute('data-tab'); saveSession(); render(); });
    });

    var loginUnitSelect = root.querySelector('[data-action="set-login-unit-filter"]');
    if (loginUnitSelect) loginUnitSelect.addEventListener('change', function () {
      session.loginFilter.unit = loginUnitSelect.value; saveSession(); render();
    });
    var loginNameSearch = root.querySelector('[data-action="set-login-name-filter"]');
    if (loginNameSearch) loginNameSearch.addEventListener('input', function () {
      var q = loginNameSearch.value;
      session.loginFilter.name = q; saveSession();
      /* filter in place (no full render) so the input keeps focus while typing */
      var anyVisible = false;
      root.querySelectorAll('#staff-pick-list .staff-pick').forEach(function (btn) {
        var match = !q || btn.getAttribute('data-name').indexOf(q) !== -1 || btn.getAttribute('data-kana').indexOf(q) !== -1;
        btn.hidden = !match;
        if (match) anyVisible = true;
      });
      var emptyMsg = root.querySelector('#staff-pick-empty');
      if (emptyMsg) emptyMsg.hidden = anyVisible;
    });

    root.querySelectorAll('[data-action="worker-login"]').forEach(function (el) {
      el.addEventListener('click', function () {
        session.role = 'worker';
        session.staffId = el.getAttribute('data-id');
        session.draft = defaultSession().draft;
        go('w_home');
      });
    });

    var adminLoginForm = root.querySelector('[data-action="admin-login"]');
    if (adminLoginForm) adminLoginForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var fd = new FormData(adminLoginForm);
      var u = (fd.get('username') || '').trim();
      var p = fd.get('password') || '';
      var admin = DB.admins.find(function (a) { return a.username === u && a.password === p; });
      if (!admin) { showToast('ユーザー名またはパスワードが正しくありません。', 'danger'); return; }
      session.role = 'admin';
      session.adminUser = admin.username;
      session.adminScreen = 'dashboard';
      go('a');
    });

    root.querySelectorAll('[data-action="logout"]').forEach(function (el) {
      el.addEventListener('click', function () {
        session.role = null; session.staffId = null; session.adminUser = null; session.screen = 'login';
        session.draft = defaultSession().draft;
        saveSession(); render();
      });
    });

    root.querySelectorAll('[data-action="start-qr-flow"]').forEach(function (el) {
      el.addEventListener('click', function () {
        var mode = el.getAttribute('data-mode');
        session.draft.qrAction = mode;
        if (mode === 'checkout') {
          var rec = activeOnDutyRecord(session.staffId);
          session.draft.targetRecordId = rec ? rec.id : null; session.draft.selectedJobs = []; session.draft.jobOtherText = ''; session.draft.breakMinutes = 0; session.draft.endAt = null;
        }
        go('w_qr');
      });
    });

    var scanBtn = root.querySelector('[data-action="simulate-scan"]');
    if (scanBtn) scanBtn.addEventListener('click', function () {
      if (busy) return;
      setBusy(true); render();
      setTimeout(function () {
        setBusy(false);
        if (session.draft.qrAction === 'checkin') go('w_start');
        else go('w_job');
      }, 550);
    });

    var startBtn = root.querySelector('[data-action="confirm-start"]');
    if (startBtn) startBtn.addEventListener('click', function () {
      if (busy) return;
      var staffId = session.staffId;
      if (activeOnDutyRecord(staffId)) { showToast('既に勤務中の記録があります。', 'danger'); go('w_home'); return; }
      var startAt = toJSTISOString(nowDate());
      var newId = uid('R');
      var flags = computeStartFlags(staffId, startAt);
      mutateAndPublish(function (draft) {
        draft.records.push({ id: newId, staffId: staffId, date: startAt.slice(0, 10), startAt: startAt, endAt: null, breakMinutes: 0, workedMinutes: null, units: [], jobs: [], jobOther: '', status: 'on_duty', flags: flags, reviewed: false, corrections: [] });
      }, {
        after: function (res) {
          if (!res.ok) return;
          session.draft.targetRecordId = newId;
          session.draft.selectedUnits = []; session.draft.selectedJobs = []; session.draft.jobOtherText = '';
          go('w_unit');
        }
      });
    });

    var unitForm = root.querySelector('[data-action="save-units"]');
    if (unitForm) unitForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var checked = Array.from(unitForm.querySelectorAll('input[name="unit"]:checked')).map(function (el) { return el.value; });
      if (!checked.length) { showToast('ユニットを1つ以上選択してください。', 'warn'); return; }
      session.draft.selectedUnits = checked;
      var recId = session.draft.targetRecordId; mutateAndPublish(function (draft) { var rec = draft.records.find(function (r) { return r.id === recId; }); if (rec) { rec.units = checked; } }, { after: function (res) { if (!res.ok) return; showToast('勤務を開始しました。', 'success'); go('w_home'); } });
    });

    root.querySelectorAll('.checkbox-item input[name="unit"], .checkbox-item input[name="job"]').forEach(function (el) {
      el.addEventListener('change', function () {
        el.closest('.checkbox-item').classList.toggle('is-checked', el.checked);
        if (el.name === 'job') {
          var jobsSel = Array.from(root.querySelectorAll('input[name="job"]:checked')).map(function (x) { return x.value; });
          var otherJob = DB.jobTypes.find(function (j) { return j.isOther; });
          var otherField = root.querySelector('.other-field');
          if (otherField && otherJob) otherField.classList.toggle('is-hidden', jobsSel.indexOf(otherJob.id) === -1);
        }
      });
    });

    var jobForm = root.querySelector('[data-action="save-jobs"]');
    if (jobForm) jobForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var checked = Array.from(jobForm.querySelectorAll('input[name="job"]:checked')).map(function (el) { return el.value; });
      if (!checked.length) { showToast('仕事内容を1つ以上選択してください。', 'warn'); return; }
      var otherJob = DB.jobTypes.find(function (j) { return j.isOther; });
      var otherText = (new FormData(jobForm).get('jobOther') || '').toString().trim();
      if (otherJob && checked.indexOf(otherJob.id) !== -1 && !otherText) { showToast('「その他」の内容を入力してください。', 'warn'); return; }
      session.draft.selectedJobs = checked;
      session.draft.jobOtherText = otherText;
      go('w_end');
    });

    var breakSel = root.querySelector('[data-action="set-break"]');
    if (breakSel) breakSel.addEventListener('change', function () { session.draft.breakMinutes = parseInt(breakSel.value, 10); saveSession(); });

    var endBtn = root.querySelector('[data-action="confirm-end"]');
    if (endBtn) endBtn.addEventListener('click', function () {
      session.draft.endAt = toJSTISOString(nowDate());
      go('w_confirm');
    });

    var finalizeBtn = root.querySelector('[data-action="finalize-end"]');
    if (finalizeBtn) finalizeBtn.addEventListener('click', function () {
      if (busy) return;
      var recId = session.draft.targetRecordId;
      var endAt = session.draft.endAt || toJSTISOString(nowDate());
      var breakMin = session.draft.breakMinutes;
      ;
      var jobs = session.draft.selectedJobs.slice();
      var jobOther = session.draft.jobOtherText;
      mutateAndPublish(function (draft) {
        var rec = draft.records.find(function (r) { return r.id === recId; });
        if (!rec) return;
        var workedMinutes = Math.round((new Date(endAt) - new Date(rec.startAt)) / 60000) - breakMin;
        rec.endAt = endAt; rec.breakMinutes = breakMin; rec.workedMinutes = workedMinutes;
        rec.jobs = jobs; rec.jobOther = jobOther; rec.status = 'completed';
        rec.flags = computeEndFlags(rec, endAt, workedMinutes);
      }, {
        successMsg: '勤務終了を記録しました。お疲れ様でした。',
        after: function (res) {
          if (!res.ok) return;
          session.draft = defaultSession().draft;
          go('w_home');
        }
      });
    });

    /* ---- 管理者：検索フィルタ ---- */
    var filterForm = root.querySelector('[data-action="apply-filters"]');
    if (filterForm) filterForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var fd = new FormData(filterForm);
      session.filters = { from: fd.get('from') || '', to: fd.get('to') || '', name: (fd.get('name') || '').trim(), staffNo: (fd.get('staffNo') || '').trim(), unit: fd.get('unit') || '', job: fd.get('job') || '', flagOnly: !!fd.get('flagOnly') };
      saveSession(); render();
    });
    var resetBtn = root.querySelector('[data-action="reset-filters"]');
    if (resetBtn) resetBtn.addEventListener('click', function () { session.filters = defaultSession().filters; saveSession(); render(); });
    var gotoExport = root.querySelector('[data-action="goto-export"]');
    if (gotoExport) gotoExport.addEventListener('click', function () { goAdmin('export'); });

    root.querySelectorAll('[data-action="edit-record"], [data-action="review-record"]').forEach(function (el) {
      el.addEventListener('click', function () {
        session.editingRecordId = el.getAttribute('data-id');
        if (el.getAttribute('data-action') === 'review-record') goAdmin('records'); else { saveSession(); render(); }
      });
    });

    root.querySelectorAll('[data-action="close-modal"]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        if (ev.target !== el) return;
        session.editingRecordId = null; session.editingStaffId = null; saveSession(); render();
      });
    });
    root.querySelectorAll('[data-stop-close]').forEach(function (el) { el.addEventListener('click', function (ev) { ev.stopPropagation(); }); });

    var correctionForm = root.querySelector('[data-action="save-correction"]');
    if (correctionForm) correctionForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var recId = correctionForm.getAttribute('data-id');
      var fd = new FormData(correctionForm);
      var newStart = fd.get('startDate') + 'T' + fd.get('startTime') + ':00+09:00';
      var newEnd = fd.get('endDate') + 'T' + fd.get('endTime') + ':00+09:00';
      var newBreak = parseInt(fd.get('breakMinutes'), 10) || 0;
      var reason = (fd.get('reason') || '').trim();
      var reviewed = !!fd.get('reviewed');
      var units = Array.from(correctionForm.querySelectorAll('input[name="units"]:checked')).map(function (x) { return x.value; });
      var jobs = Array.from(correctionForm.querySelectorAll('input[name="jobs"]:checked')).map(function (x) { return x.value; });
      if (new Date(newEnd) <= new Date(newStart)) { showToast('終業時刻は始業時刻より後にしてください。', 'danger'); return; }
      if (!reason) { showToast('修正理由を入力してください。', 'warn'); return; }
      var adminUser = session.adminUser;
      mutateAndPublish(function (draft) {
        var rec = draft.records.find(function (r) { return r.id === recId; });
        if (!rec) return;
        var workedMinutes = Math.round((new Date(newEnd) - new Date(newStart)) / 60000) - newBreak;
        rec.corrections = rec.corrections || [];
        rec.corrections.push({ beforeStart: rec.startAt, beforeEnd: rec.endAt, beforeBreak: rec.breakMinutes, afterStart: newStart, afterEnd: newEnd, afterBreak: newBreak, editor: adminUser, editedAt: toJSTISOString(nowDate()), reason: reason });
        rec.startAt = newStart; rec.endAt = newEnd; rec.breakMinutes = newBreak; rec.workedMinutes = workedMinutes;
        rec.date = newStart.slice(0, 10);
        rec.units = units; rec.jobs = jobs; rec.reviewed = reviewed;
        rec.flags = computeEndFlags(rec, newEnd, workedMinutes).filter(function (f) { return f !== 'quick_repunch' || (rec.flags || []).indexOf('quick_repunch') !== -1; });
      }, {
        successMsg: '勤務記録を修正しました。',
        after: function (res) {
          if (!res.ok) return;
          session.editingRecordId = null;
          saveSession(); render();
        }
      });
    });

    /* ---- 管理者：集計フィルタ ---- */
    var staffSel = root.querySelector('[data-action="set-summary-staff"]');
    if (staffSel) staffSel.addEventListener('change', function () { session.summary.staffId = staffSel.value; saveSession(); render(); });
    var monthInput = root.querySelector('[data-action="set-summary-month"]');
    if (monthInput) monthInput.addEventListener('change', function () { session.summary.month = monthInput.value || currentMonthKey(); saveSession(); render(); });
    var unitMonthInput = root.querySelector('[data-action="set-unit-month"]');
    if (unitMonthInput) unitMonthInput.addEventListener('change', function () { session.summary.unitMonth = unitMonthInput.value || currentMonthKey(); saveSession(); render(); });
    var overallMonthInput = root.querySelector('[data-action="set-overall-month"]');
    if (overallMonthInput) overallMonthInput.addEventListener('change', function () { session.summary.overallMonth = overallMonthInput.value || currentMonthKey(); saveSession(); render(); });
    var jobMonthInput = root.querySelector('[data-action="set-job-month"]');
    if (jobMonthInput) jobMonthInput.addEventListener('change', function () { session.summary.jobMonth = jobMonthInput.value || currentMonthKey(); saveSession(); render(); });

    /* ---- Excel出力 ---- */
    var exportBtn = root.querySelector('[data-action="export-excel"]');
    if (exportBtn) exportBtn.addEventListener('click', function () { exportExcel(filterRecords(session.filters)); });

    /* ---- スタッフ管理 ---- */
    var newStaffBtn = root.querySelector('[data-action="new-staff"]');
    if (newStaffBtn) newStaffBtn.addEventListener('click', function () { session.editingStaffId = 'new'; saveSession(); render(); });
    root.querySelectorAll('[data-action="edit-staff"]').forEach(function (el) {
      el.addEventListener('click', function () { session.editingStaffId = el.getAttribute('data-id'); saveSession(); render(); });
    });
    var staffForm = root.querySelector('[data-action="save-staff"]');
    if (staffForm) staffForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var idAttr = staffForm.getAttribute('data-id');
      var fd = new FormData(staffForm);
      var payload = { staffNo: (fd.get('staffNo') || '').trim(), name: (fd.get('name') || '').trim(), kana: (fd.get('kana') || '').trim(), phone: (fd.get('phone') || '').trim(), email: (fd.get('email') || '').trim(), status: fd.get('status'), homeUnit: fd.get('homeUnit') || '' };
      if (!payload.staffNo || !payload.name || !payload.kana) { showToast('スタッフ番号・氏名・ふりがなは必須です。', 'warn'); return; }
      mutateAndPublish(function (draft) {
        if (idAttr === 'new') {
          draft.staff.push(Object.assign({ id: uid('S') }, payload));
        } else {
          var s = draft.staff.find(function (x) { return x.id === idAttr; });
          if (s) Object.assign(s, payload);
        }
      }, {
        successMsg: 'スタッフ情報を保存しました。',
        after: function (res) { if (!res.ok) return; session.editingStaffId = null; saveSession(); render(); }
      });
    });

    root.querySelectorAll('[data-action="delete-staff"]').forEach(function (el) {
      el.addEventListener('click', function () { session.deletingStaffId = el.getAttribute('data-id'); saveSession(); render(); });
    });
    root.querySelectorAll('[data-action="close-delete-modal"]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        if (ev.target !== el) return;
        session.deletingStaffId = null; saveSession(); render();
      });
    });
    var retireBtn = root.querySelector('[data-action="retire-staff"]');
    if (retireBtn) retireBtn.addEventListener('click', function () {
      var id = retireBtn.getAttribute('data-id');
      mutateAndPublish(function (draft) {
        var s = draft.staff.find(function (x) { return x.id === id; });
        if (s) s.status = '退職';
      }, {
        successMsg: '利用状態を「退職」にしました。',
        after: function (res) { if (!res.ok) return; session.deletingStaffId = null; saveSession(); render(); }
      });
    });
    var confirmDeleteBtn = root.querySelector('[data-action="confirm-delete-staff"]');
    if (confirmDeleteBtn) confirmDeleteBtn.addEventListener('click', function () {
      var id = confirmDeleteBtn.getAttribute('data-id');
      mutateAndPublish(function (draft) {
        if (activeOnDutyRecordIn(draft, id)) return; /* safety net; UI already blocks this case */
        /* Soft-delete: keep the record (and its id/name) so past shifts stay fully
           attributed, but hide it from the active staff list and worker login. */
        var s = draft.staff.find(function (x) { return x.id === id; });
        if (s) { s.deleted = true; s.deletedAt = toJSTISOString(nowDate()); }
      }, {
        successMsg: 'スタッフを一覧から削除しました。',
        after: function (res) { if (!res.ok) return; session.deletingStaffId = null; saveSession(); render(); }
      });
    });

    /* ---- スタッフ CSV/Excel インポート・エクスポート ---- */
    var exportStaffBtn = root.querySelector('[data-action="export-staff-excel"]');
    if (exportStaffBtn) exportStaffBtn.addEventListener('click', function () { exportStaffExcel(); });

    var openImportBtn = root.querySelector('[data-action="open-staff-import"]');
    if (openImportBtn) openImportBtn.addEventListener('click', function () { session.staffImport = { stage: 'select', error: null }; saveSession(); render(); });

    root.querySelectorAll('[data-action="close-import-modal"]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        if (ev.target !== el) return;
        session.staffImport = null; saveSession(); render();
      });
    });
    var restartImportBtn = root.querySelector('[data-action="restart-staff-import"]');
    if (restartImportBtn) restartImportBtn.addEventListener('click', function () { session.staffImport = { stage: 'select', error: null }; saveSession(); render(); });

    var templateBtn = root.querySelector('[data-action="download-staff-template"]');
    if (templateBtn) templateBtn.addEventListener('click', function () { downloadStaffTemplate(); });

    var importFileInput = root.querySelector('[data-action="staff-import-file"]');
    if (importFileInput) importFileInput.addEventListener('change', async function () {
      var file = importFileInput.files && importFileInput.files[0];
      if (!file) return;
      if (!window.XLSX) { session.staffImport = { stage: 'select', error: 'ファイル読み込みライブラリの読み込みに失敗しました。ページを再読み込みしてお試しください。' }; saveSession(); render(); return; }
      try {
        var buf = await file.arrayBuffer();
        var wb = window.XLSX.read(new Uint8Array(buf), { type: 'array' });
        var firstSheet = wb.Sheets[wb.SheetNames[0]];
        var sheetRows = window.XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
        if (!sheetRows.length) {
          session.staffImport = { stage: 'select', error: 'ファイルにデータ行が見つかりませんでした。1行目が見出し行になっているかご確認ください。' };
        } else {
          var rows = parseStaffSheetRows(sheetRows);
          session.staffImport = { stage: 'preview', fileName: file.name, rows: rows };
        }
      } catch (e) {
        session.staffImport = { stage: 'select', error: 'ファイルの読み込みに失敗しました。CSVまたはExcel（.xlsx）形式でご用意ください。' };
      }
      saveSession(); render();
    });

    var confirmImportBtn = root.querySelector('[data-action="confirm-staff-import"]');
    if (confirmImportBtn) confirmImportBtn.addEventListener('click', function () {
      var rows = (session.staffImport && session.staffImport.rows) || [];
      var toApply = rows.filter(function (r) { return r.action !== 'error'; });
      if (!toApply.length) return;
      var insertCount = toApply.filter(function (r) { return r.action === 'insert'; }).length;
      var updateCount = toApply.filter(function (r) { return r.action === 'update'; }).length;
      mutateAndPublish(function (draft) {
        toApply.forEach(function (r) {
          var payload = { staffNo: r.staffNo, name: r.name, kana: r.kana, phone: r.phone, email: r.email, status: r.status };
          if (r.action === 'update') {
            var existing = draft.staff.find(function (s) { return s.id === r.matchedStaffId; });
            if (existing) {
              Object.assign(existing, payload);
              if (r.homeUnit) existing.homeUnit = r.homeUnit;
              existing.deleted = false; /* re-importing a staff number revives a deleted entry */
              delete existing.deletedAt;
            }
          } else {
            var created = Object.assign({ id: uid('S'), homeUnit: r.homeUnit || '' }, payload);
            draft.staff.push(created);
          }
        });
      }, {
        successMsg: '新規登録 ' + insertCount + '件、更新 ' + updateCount + '件を取り込みました。',
        after: function (res) { if (!res.ok) return; session.staffImport = null; saveSession(); render(); }
      });
    });

    /* ---- ユニット／仕事内容管理 ---- */
    var addMasterForm = root.querySelector('[data-action="add-master"]');
    if (addMasterForm) addMasterForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var kind = addMasterForm.getAttribute('data-kind');
      var name = (new FormData(addMasterForm).get('name') || '').toString().trim();
      if (!name) return;
      mutateAndPublish(function (draft) {
        draft[kind].push({ id: uid(kind === 'units' ? 'u' : 'j'), name: name, active: true, isOther: false });
      }, { successMsg: '追加しました。' });
    });
    root.querySelectorAll('[data-action="rename-master"]').forEach(function (el) {
      el.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var kind = el.getAttribute('data-kind'), id = el.getAttribute('data-id');
        var name = (new FormData(el).get('name') || '').toString().trim();
        if (!name) return;
        mutateAndPublish(function (draft) {
          var it = draft[kind].find(function (x) { return x.id === id; });
          if (it) it.name = name;
        }, { successMsg: '名称を変更しました。' });
      });
    });
    root.querySelectorAll('[data-action="toggle-master"]').forEach(function (el) {
      el.addEventListener('click', function () {
        var kind = el.getAttribute('data-kind'), id = el.getAttribute('data-id');
        mutateAndPublish(function (draft) {
          var it = draft[kind].find(function (x) { return x.id === id; });
          if (it && !it.isOther) it.active = !it.active;
        }, {});
      });
    });

    /* ---- QRコード管理 ---- */
    root.querySelectorAll('[data-action="reissue-qr"]').forEach(function (el) {
      el.addEventListener('click', function () {
        var kind = el.getAttribute('data-kind');
        var adminUser = session.adminUser;
        mutateAndPublish(function (draft) {
          var old = draft.qr[kind];
          draft.qr.history = draft.qr.history || [];
          draft.qr.history.push({ type: kind, token: old.token, issuedAt: old.issuedAt, retiredAt: toJSTISOString(nowDate()), issuedBy: adminUser });
          var newToken = (kind === 'checkin' ? 'CHK-' : 'CHKOUT-') + Math.random().toString(36).slice(2, 10).toUpperCase();
          var issued = nowDate();
          var expires = new Date(issued.getTime());
          expires.setFullYear(expires.getFullYear() + 1);
          draft.qr[kind] = { token: newToken, issuedAt: toJSTISOString(issued), expiresAt: toJSTISOString(expires) };
        }, { successMsg: 'QRコードを再発行しました。' });
      });
    });

    var resetAppBtn = root.querySelector('[data-action="reset-app"]');
    if (resetAppBtn) resetAppBtn.addEventListener('click', function () {
      session = defaultSession(); saveSession(); render();
    });
  }

  /* ---------------------------- Excel出力（SheetJS） ---------------------------- */
  function exportExcel(list) {
    if (!window.XLSX) { showToast('Excel出力ライブラリの読み込みに失敗しました。', 'danger'); return; }
    setBusy(true); render();
    try {
      var rows = list.map(function (r) {
        var st = findStaff(r.staffId);
        return {
          '勤務日': r.date,
          'スタッフ番号': st ? st.staffNo : '',
          '氏名': st ? st.name : r.staffId,
          '始業時間': fmtTime(r.startAt),
          '終業時間': r.status === 'on_duty' ? '' : fmtTime(r.endAt),
          '休憩時間(分)': r.breakMinutes,
          '実働時間': r.status === 'on_duty' ? '' : fmtDuration(r.workedMinutes),
          '実働時間(時間)': r.status === 'on_duty' ? '' : Number((r.workedMinutes / 60).toFixed(2)),
          '勤務ユニット': unitNames(r.units).join('、'),
          '仕事内容': jobNames(r.jobs).join('、') + (r.jobOther ? '（' + r.jobOther + '）' : ''),
          '状態': r.status === 'on_duty' ? '勤務中' : '完了',
        };
      });
      var ws = window.XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 20 }, { wch: 24 }, { wch: 8 }];
      triggerDownload(sheetToXlsxBlob(ws, '勤務実績'), '勤務実績_' + jstDateStr(nowDate()) + '.xlsx');
      showToast('Excelファイルをダウンロードしました。', 'success');
    } catch (e) {
      showToast('Excel出力に失敗しました。', 'danger');
    }
    setBusy(false); render();
  }

  /* ---------------------------- サーバーからの自動更新（他端末の反映） ---------------------------- */
  function hasOpenEditor() {
    return !!(session.editingStaffId || session.editingRecordId || session.deletingStaffId ||
      (session.staffImport && session.staffImport.stage));
  }

  function userIsTypingInField() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  async function refreshFromServer() {
    if (busy) return;
    try {
      var latest = await pullDb();
      var changed = JSON.stringify(latest) !== JSON.stringify(DB);
      DB = latest;
      if (changed && !hasOpenEditor() && !userIsTypingInField()) render();
    } catch (e) { /* オフライン等。次回のポーリングで再試行する */ }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshFromServer, 5000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refreshFromServer();
    });
    window.addEventListener('online', refreshFromServer);
  }

  /* ---------------------------- ブート ---------------------------- */
  async function boot() {
    var root = document.getElementById('root');
    if (root) root.innerHTML = '<div class="boot-loading"><p>読み込み中…</p></div>';
    session = loadSession();
    var bootFailed = false;
    try {
      DB = await pullDb();
    } catch (e) {
      DB = emptyDb();
      bootFailed = true;
    }
    if (session.role === 'admin' && !DB.admins.find(function (a) { return a.username === session.adminUser; })) session = defaultSession();
    if (session.role === 'worker' && !findStaff(session.staffId)) session = defaultSession();
    render();
    if (bootFailed) showToast('サーバーに接続できませんでした。通信環境をご確認のうえ、ページを再読み込みしてください。', 'danger');
    startPolling();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(function () {
      var c1 = document.getElementById('home-clock');
      if (c1) c1.textContent = fmtNowClock();
      var c2 = document.getElementById('start-clock');
      if (c2) c2.textContent = fmtNowClock();
      var c3 = document.getElementById('end-clock');
      if (c3) c3.textContent = fmtNowClock();
      var c4 = document.getElementById('admin-clock');
      if (c4) c4.textContent = fmtNowClock();
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
