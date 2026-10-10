// ==UserScript==
// @name         QuarkAutoAssistant
// @namespace    quark-auto-save
// @version      5.2.4
// @description  夸克网盘平台层：UI + DOM 工具 + 下载流程 + 保存原语 + 对比清理失效记录
// @match        https://pan.quark.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const PREFIX = '[夸克助手]';
  const GM_DL_RECORDS = 'quark_auto_dl_records';
  const DL_TTL   = 24 * 60 * 60 * 1000;      // 记录保留时长（仅用于置灰判定）
  const THROTTLE = 5000;
  const BUSY_KEY = 'acgrip_bridge_busy';

  const log   = (...a) => console.log(PREFIX, ...a);
  const warn  = (...a) => console.warn(PREFIX, ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, delay = 200, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = await fn();
      if (r) return r;
      await sleep(delay);
    }
    return null;
  }

  function gmGet(key, def) {
    try {
      const v = GM_getValue(key);
      if (v == null || v === '') return def;
      return typeof v === 'string' ? JSON.parse(v) : v;
    } catch { return def; }
  }
  function gmSet(key, val) { try { GM_setValue(key, JSON.stringify(val)); } catch {} }

  /* ============================================================
   *  页面识别
   * ============================================================ */
  function isListPage()  { return location.pathname.startsWith('/list'); }
  function isSharePage() { return /^\/s\/[a-zA-Z0-9]+/.test(location.pathname); }

  /* ============================================================
   *  面板（按需挂载）
   * ============================================================ */
  let uiRefs = null;
  let _builtinActions = [];
  let _externalActions = [];

  function mountPanel() {
    if (uiRefs) return uiRefs;
    if (!document.body) return null;
    const panel = document.createElement('div');
    panel.id = 'quark-auto-panel';
    panel.innerHTML = `
      <div class="qap-header">
        <span class="qap-title">夸克助手</span>
        <span class="qap-toggle" title="折叠/展开">−</span>
      </div>
      <div class="qap-body">
        <div class="qap-row"><span class="qap-label">状态</span><span class="qap-status">待机</span></div>
        <div class="qap-row"><span class="qap-label">进度</span><span class="qap-progress">-</span></div>
        <div class="qap-actions" id="qap-actions"></div>
      </div>`;
    const style = document.createElement('style');
    style.textContent = `
      #quark-auto-panel{position:fixed;right:20px;bottom:20px;width:260px;background:#fff;border:1px solid #e0e0e0;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.12);font-family:"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;color:#333;z-index:2147483646;user-select:none;overflow:hidden}
      #quark-auto-panel.collapsed .qap-body{display:none}
      #quark-auto-panel .qap-header{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#09AAFF;color:#fff;font-weight:600}
      #quark-auto-panel .qap-toggle{cursor:pointer;padding:0 6px;font-weight:700}
      #quark-auto-panel .qap-body{padding:10px 12px}
      #quark-auto-panel .qap-row{display:flex;justify-content:space-between;padding:3px 0;line-height:1.6}
      #quark-auto-panel .qap-label{color:#888}
      #quark-auto-panel .qap-status{font-weight:600}
      #quark-auto-panel .qap-status.running{color:#09AAFF}
      #quark-auto-panel .qap-status.done{color:#52c41a}
      #quark-auto-panel .qap-status.error{color:#cc3235}
      #quark-auto-panel .qap-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      #quark-auto-panel .qap-actions:empty{display:none}
      #quark-auto-panel .qap-btn{flex:1 1 46%;padding:6px 0;border:none;border-radius:5px;cursor:pointer;font-size:12px;color:#fff;background:#09AAFF}
      #quark-auto-panel .qap-btn:hover{opacity:.85}
      .qap-grayed .filename-text,.qap-grayed .filename-text *,.qap-grayed .file-name,.qap-grayed .file-name *{color:#999!important;opacity:.65!important}
      .qap-grayed .file-icon,.qap-grayed .file-icon *,.qap-grayed img{filter:grayscale(1)!important;opacity:.5!important}
      #quark-share-progress{position:fixed;right:24px;top:100px;z-index:2147483645;padding:8px 14px;background:rgba(0,0,0,0.75);color:#fff;border-radius:6px;font-size:13px;font-family:"PingFang SC","Microsoft YaHei",sans-serif;pointer-events:none;user-select:none;display:none}
      #quark-share-progress .num{color:#52c41a;font-weight:700;font-size:15px;margin:0 3px}
      #quark-share-progress.all-done .num{color:#faad14}
    `;
    document.head.appendChild(style);
    document.body.appendChild(panel);

    uiRefs = {
      panel,
      status:   panel.querySelector('.qap-status'),
      progress: panel.querySelector('.qap-progress'),
      actions:  panel.querySelector('#qap-actions'),
      toggle:   panel.querySelector('.qap-toggle'),
    };
    uiRefs.toggle.onclick = () => {
      panel.classList.toggle('collapsed');
      uiRefs.toggle.textContent = panel.classList.contains('collapsed') ? '+' : '−';
    };
    renderActions();
    return uiRefs;
  }

  function setStatus(text, cls = '') {
    if (!uiRefs) return;
    uiRefs.status.textContent = text;
    uiRefs.status.className = 'qap-status ' + cls;
  }
  function setProgress(p) {
    if (!uiRefs) return;
    uiRefs.progress.textContent = p;
  }
  function renderActions() {
    if (!uiRefs) return;
    uiRefs.actions.innerHTML = '';
    const all = [..._builtinActions, ..._externalActions];
    for (const a of all) {
      const btn = document.createElement('button');
      btn.className = 'qap-btn';
      btn.textContent = a.label || '动作';
      if (a.color) btn.style.background = a.color;
      if (a.title) btn.title = a.title;
      btn.onclick = () => { try { a.onclick && a.onclick(); } catch (e) { warn('按钮出错', e); } };
      uiRefs.actions.appendChild(btn);
    }
  }
  function setActions(list) { _externalActions = list || []; renderActions(); }
  function addBuiltinAction(a) { _builtinActions.push(a); renderActions(); }
  function clearBuiltinActions() { _builtinActions = []; renderActions(); }

  /* ============================================================
   *  悬浮进度条
   * ============================================================ */
  let progressEl = null;
  function ensureProgressEl() {
    if (progressEl && progressEl.isConnected) return progressEl;
    progressEl = document.createElement('div');
    progressEl.id = 'quark-share-progress';
    document.body.appendChild(progressEl);
    return progressEl;
  }
  function showProgress(existing, total, label = '已处理') {
    const el = ensureProgressEl();
    if (!total || total <= 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.classList.toggle('all-done', existing >= total);
    el.innerHTML = `${label} <span class="num">${existing}</span> / <span class="num">${total}</span>`;
  }
  function hideProgress() {
    const el = ensureProgressEl();
    el.style.display = 'none';
  }

  /* ============================================================
   *  DOM 工具
   * ============================================================ */
  function isVisible(el) {
    if (!el) return false;
    try {
      if (el.classList && el.classList.contains('out-screen')) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      return true;
    } catch { return false; }
  }

  function getVisibleText(doc = document) {
    let out = '';
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) { out += node.nodeValue + ' '; return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      try {
        if (node.classList && node.classList.contains('out-screen')) return;
        const cs = (node.ownerDocument.defaultView || window).getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      } catch {}
      for (const c of node.childNodes) walk(c);
    };
    walk(doc.body);
    return out;
  }

  function realClick(el) {
    if (!el || !el.isConnected) return false;
    const win = el.ownerDocument.defaultView || window;
    const base = { bubbles: true, cancelable: true, view: win, button: 0, buttons: 1 };
    const up   = { ...base, buttons: 0 };
    try {
      el.dispatchEvent(new win.PointerEvent('pointerdown', base));
      el.dispatchEvent(new win.MouseEvent('mousedown', base));
      el.dispatchEvent(new win.PointerEvent('pointerup', up));
      el.dispatchEvent(new win.MouseEvent('mouseup', up));
      el.dispatchEvent(new win.MouseEvent('click', up));
    } catch { try { el.click?.(); } catch { return false; } }
    return true;
  }

  function getFileIconSig(row) {
    const iconEl = row.querySelector('.file-icon');
    if (!iconEl) return '';
    const useEl = iconEl.querySelector('use');
    if (useEl) {
      const href = useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '';
      if (href) return 'svg:' + href;
    }
    const img = iconEl.querySelector('img');
    if (img && img.src) return 'img:' + String(img.src).split('?')[0];
    const html = iconEl.innerHTML || '';
    const m = html.match(/url\(["']?([^"')]+)["']?\)/);
    if (m) return 'url:' + m[1].split('?')[0].slice(0, 80);
    const cls = (iconEl.className || '').trim();
    return cls ? 'cls:' + cls : '';
  }

  function scanFileRows(doc = document) {
    const out = [];
    const seen = new Set();
    const rows = doc.querySelectorAll('tr.ant-table-row, [data-row-key]');
    for (const row of rows) {
      if (row.querySelector('[class*="folder"],[class*="Folder"]')) continue;
      const nameEl = row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
      if (!nameEl) continue;
      const name = (nameEl.getAttribute('title') || nameEl.textContent || '').trim();
      if (!name || seen.has(name)) continue;
      let sizeStr = '';
      const tds = row.querySelectorAll('td');
      if (tds.length >= 3) sizeStr = (tds[2].textContent || '').trim();
      const fid = row.getAttribute('data-row-key') || '';
      const cb = row.querySelector('input.ant-checkbox-input, input[type="checkbox"]');
      const checked =
            !!(cb && cb.checked) || row.classList.contains('ant-table-row-selected');
      out.push({ name, sizeStr, fid, iconSig: getFileIconSig(row), row, checked });
      seen.add(name);
    }
    return out;
  }

  /* ============================================================
   *  下载记录（GM） —— 只读，TTL 过滤交给 isFidDownloaded
   * ============================================================ */
  function loadDlRecords() {
    return gmGet(GM_DL_RECORDS, {}) || {};
  }
  function saveDlRecords(recs) { gmSet(GM_DL_RECORDS, recs); }
  function isFidDownloaded(fid) {
    if (!fid) return false;
    const recs = loadDlRecords();
    const r = recs[fid];
    if (!r) return false;
    const ts = typeof r === 'number' ? r : (r.ts || 0);
    return ts > 0 && Date.now() - ts <= DL_TTL;
  }
  function markFidDownloaded(fid, info = {}) {
    if (!fid) return;
    const recs = loadDlRecords();
    recs[fid] = {
      ts: Date.now(),
      name: info.name || '',
      sizeStr: info.sizeStr || '',
      iconSig: info.iconSig || '',
    };
    saveDlRecords(recs);
  }
  function clearDlRecordsFids(fids) {
    const recs = loadDlRecords();
    for (const fid of fids) delete recs[fid];
    saveDlRecords(recs);
  }
  function clearAllDlRecords() { saveDlRecords({}); }

  /* 返回"已过期"的所有 fid（不改存储） */
  function pickExpiredFids() {
    const recs = loadDlRecords();
    const now = Date.now();
    const out = [];
    for (const k of Object.keys(recs)) {
      const r = recs[k];
      const ts = typeof r === 'number' ? r : (r && r.ts || 0);
      if (!ts || now - ts > DL_TTL) out.push(k);
    }
    return out;
  }

  /* ============================================================
   *  置灰 + 进度
   * ============================================================ */
  let _grayEnabled = false;
  let _grayPredicate = () => false;
  let _progressLabel = '已处理';

  function setGrayPredicate(fn) {
    if (typeof fn === 'function') { _grayPredicate = fn; _grayEnabled = true; }
    else { _grayPredicate = () => false; _grayEnabled = false; }
    refreshGray();
  }
  function setProgressLabel(label) { _progressLabel = label || '已处理'; }

  function refreshGray(doc = document) {
    const files = scanFileRows(doc);
    let grayed = 0;
    for (const f of files) {
      let hit = false;
      if (_grayEnabled) {
        try { hit = !!_grayPredicate(f); } catch {}
      } else if (isListPage()) {
        hit = isFidDownloaded(f.fid);
      }
      if (hit) { f.row.classList.add('qap-grayed'); grayed++; }
      else f.row.classList.remove('qap-grayed');
    }
    if (doc === document && files.length > 0 && (_grayEnabled || isListPage())) {
      showProgress(grayed, files.length, _progressLabel);
      if (uiRefs) uiRefs.progress.textContent = `${grayed} / ${files.length}`;
    }
    return { grayed, total: files.length };
  }

  function startGrayPolling() {
    const tick = () => { try { refreshGray(); } catch {} };
    setInterval(tick, 800);
    let moTimer = null;
    const mo = new MutationObserver(() => {
      if (moTimer) return;
      moTimer = setTimeout(() => { moTimer = null; tick(); }, 200);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    tick();
  }

  /* ============================================================
   *  分享页保存原语
   * ============================================================ */
  function findSaveButton(doc = document) {
    const sels = ['.share-save', 'button[class*="share-save"]', '.save-btn', 'button[class*="save"]'];
    for (const sel of sels) {
      try {
        for (const el of doc.querySelectorAll(sel)) {
          const text = (el.textContent || '').trim();
          if (/保存到.*网盘/.test(text) || /保存/.test(text)) return el;
        }
      } catch {}
    }
    try {
      for (const el of doc.querySelectorAll('button')) {
        const text = (el.textContent || '').trim();
        if (text === '保存到网盘' || text === '保存到我的网盘' || text === '保存到夸克网盘') return el;
      }
    } catch {}
    return null;
  }

  async function clickSaveButton(doc = document) {
    const btn = findSaveButton(doc);
    if (!btn) throw new Error('未找到"保存到网盘"按钮');
    realClick(btn);
    return true;
  }

  function findVisibleModal(doc = document) {
    const sels = [
      '.ant-modal:not(.ant-modal-hidden)',
      '.save-share-file-modal',
      '[class*="save-share"][class*="modal"]',
      '[class*="saveShare"][class*="modal"]',
      '[role="dialog"]',
    ];
    for (const sel of sels) {
      try {
        for (const el of doc.querySelectorAll(sel)) {
          if (isVisible(el)) return el;
        }
      } catch {}
    }
    return null;
  }

  async function waitForSaveDialog(doc = document, timeout = 8000) {
    return await until(() => {
      const modal = findVisibleModal(doc);
      if (!modal) return null;
      const cbs = modal.querySelectorAll('input[type="checkbox"], input.ant-checkbox-input');
      return cbs.length ? modal : null;
    }, 200, timeout);
  }

  async function clickConfirmInDialog(doc = document, timeout = 6000) {
    const modal = findVisibleModal(doc);
    const scope = modal || doc;
    const texts = ['保存到此处', '确定保存', '确认保存', '确定', '确认'];
    const ok = await until(() => {
      for (const t of texts) {
        for (const el of scope.querySelectorAll('button')) {
          const txt = (el.textContent || '').trim();
          if (txt === t && isVisible(el)) { realClick(el); return true; }
        }
      }
      return false;
    }, 200, timeout);
    return !!ok;
  }

  function closeDialog(doc = document) {
    const sels = ['.ant-modal-close', '.swal2-close', '[class*="modal-close"]'];
    for (const sel of sels) {
      try {
        for (const el of doc.querySelectorAll(sel)) {
          if (isVisible(el)) { realClick(el); return true; }
        }
      } catch {}
    }
    return false;
  }

  const P = {
    space: [/空间不足/, /容量不足/, /存储空间.*不足/, /剩余空间.*不足/, /空间.*已满/, /请先扩容/],
    over:  [/已超过.*(每日|当天|今日).*(转存|保存)/, /(每日|当天|今日).*(转存|保存).*(次数|上限|限额)/, /转存次数.*已达/],
    fail:  [/保存失败/, /转存失败/, /分享链接.*失效/, /链接已失效/, /分享已失效/, /文件.*不存在/],
    ok:    [/保存成功/, /已保存/, /转存成功/, /已添加.*网盘/, /已存入/],
  };
  function classify(text) {
    if (!text) return 'unknown';
    for (const p of P.space) if (p.test(text)) return 'space';
    for (const p of P.over)  if (p.test(text)) return 'over_limit';
    for (const p of P.fail)  if (p.test(text)) return 'fail';
    for (const p of P.ok)    if (p.test(text)) return 'success';
    return 'unknown';
  }

  async function waitResult(doc = document, timeout = 8000) {
    const k = await until(() => {
      let text = '';
      try {
        for (const sel of ['.swal2-popup', '.ant-message-notice', '.ant-notification-notice', '.ant-modal']) {
          for (const el of doc.querySelectorAll(sel)) {
            if (isVisible(el)) text += ' ' + (el.textContent || '');
          }
        }
      } catch {}
      if (!text.trim()) text = getVisibleText(doc);

      const k = classify(text);
      if (k === 'success' || k === 'space' || k === 'over_limit' || k === 'fail') {
        log('waitResult 判定:', k, '| 命中：', text.slice(0, 200).replace(/\s+/g, ' '));
        return k;
      }
      return null;
    }, 300, timeout);
    return k || 'unknown';
  }

  /* ============================================================
   *  下载流程
   * ============================================================ */
  let downloadRunning = false;

  async function triggerApiDownload() {
    const btnEl = document.querySelector('.quark-button.pl-button');
    if (!btnEl) throw new Error('找不到"下载助手"按钮');
    const win = btnEl.ownerDocument.defaultView || window;

    for (const t of ['mouseenter', 'mouseover']) {
      try { btnEl.dispatchEvent(new win.MouseEvent(t, { bubbles: true, view: win })); } catch {}
    }

    // ★ 轮询等菜单项出现（hover 后才渲染）
    const itemEl = await until(
      () => document.querySelector('.pl-button-mode[data-mode="api"]'),
      100, 3000
    );
    if (!itemEl) throw new Error('找不到 API 下载菜单项');

    const $ = win.jQuery || win.$;
    const popupShown = () => !!document.querySelector('.swal2-popup');

    if ($) {
      try { $(itemEl).trigger('click'); } catch {}
      if (await until(popupShown, 100, 800)) return;
    }
    if (popupShown()) return;

    if (itemEl.isConnected) {
      realClick(itemEl);
      if (await until(popupShown, 100, 800)) return;
    }
    if (popupShown()) return;

    if (itemEl.isConnected) {
      try { itemEl.click(); } catch {}
    }
  }

  async function handleApiDialog() {
    const popup = await until(() => document.querySelector('.swal2-popup'), 250, 5000);
    if (!popup) throw new Error('未弹出 API 下载对话框');
    const link = await until(() => {
      const el = document.querySelector('.listener-link-api');
      if (el) return el;
      const err = document.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning');
      if (err) throw new Error('弹窗返回错误');
      return null;
    }, 250, 8000);
    const dlink = link.dataset.link || '';
    const fname = link.dataset.filename || '';

    if (!dlink || /失败|提示|请先|异常/.test(dlink)) {
      const closeBtn = document.querySelector('.swal2-close');
      if (closeBtn && isVisible(closeBtn)) realClick(closeBtn);
      await until(() => !document.querySelector('.swal2-popup'), 100, 1500);
      throw new Error('链接无效: ' + dlink.slice(0, 80));
    }

    log(`  触发下载: ${fname}`);
    realClick(link);

    // ★ 轮询：弹窗存在且关闭按钮可点时点掉；超时则按"无关闭按钮"处理
    await until(() => {
      if (!document.querySelector('.swal2-popup')) return true;
      const btn = document.querySelector('.swal2-close');
      if (btn && isVisible(btn)) realClick(btn);
      return false;
    }, 100, 2000);

    // 轮询等弹窗彻底消失
    await until(() => !document.querySelector('.swal2-popup'), 150, 3000);
  }

  async function downloadOneRow(row) {
    const fid = row.getAttribute('data-row-key') || '';

    // 取消其它行勾选
    const allRows = document.querySelectorAll('tr.ant-table-row, [data-row-key]');
    for (const r of allRows) {
      if (r === row) continue;
      if (r.classList.contains('ant-table-row-selected')) {
        const lbl = r.querySelector('label.ant-checkbox-wrapper');
        if (lbl) realClick(lbl);
      }
    }

    // ★ 轮询：等其它行全部取消选中（最多 2s，超时继续）
    await until(() => {
      for (const r of document.querySelectorAll('tr.ant-table-row-selected')) {
        if (r !== row && (r.getAttribute('data-row-key') || '') !== fid) return false;
      }
      return true;
    }, 100, 2000);

    const isChecked = () => {
      const input = row.querySelector('input.ant-checkbox-input');
      if (input && input.checked) return true;
      return row.classList.contains('ant-table-row-selected');
    };

    // ★ 轮询：第一次点击勾选
    if (!isChecked()) {
      const lbl = row.querySelector('label.ant-checkbox-wrapper');
      if (!lbl) throw new Error('找不到 checkbox');
      realClick(lbl);
      await until(isChecked, 80, 1200);
    }
    // ★ 轮询：仍没勾上就再点一次（保留原有"重试一次"语义）
    if (!isChecked()) {
      const lbl = row.querySelector('label.ant-checkbox-wrapper');
      if (lbl) {
        realClick(lbl);
        await until(isChecked, 80, 1200);
      }
    }

    await triggerApiDownload();
    await handleApiDialog();
  }

  function waitForApiReady() {
    return until(() => document.querySelector('.quark-button.pl-button'), 500, 20000);
  }

  function clickRefresh() {
    const sels = ['.fl-refresh', '.fl-refresh img', '[class*="fl-refresh"]', '[class*="refresh"]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) { realClick(el); return true; }
    }
    return false;
  }

  async function autoDownloadWorkflow(opts = {}) {
    const { maxRounds = 3, throttle = THROTTLE } = opts;
    if (downloadRunning) { log('下载任务已在运行'); return; }
    if (!isListPage()) { warn('当前不是列表页，跳过下载'); return; }
    downloadRunning = true;
    log('===== 开始自动下载 =====');
    try {
      setStatus('等待下载助手...', 'running');
      const ok = await waitForApiReady();
      if (!ok) { warn('下载助手未就绪'); return; }

      // ★ 轮询等文件行渲染出来（最多 5s；无文件也继续，下面会 break）
      await until(() => scanFileRows().length > 0, 200, 5000);

      for (let round = 1; round <= maxRounds; round++) {
        const files = scanFileRows();
        const pending = files.filter(f => f.fid && !isFidDownloaded(f.fid));
        log(`第 ${round} 轮：待下载 ${pending.length} / 共 ${files.length}`);
        if (!pending.length) { log('  无待下载文件'); break; }

        for (let i = 0; i < pending.length; i++) {
          const f = pending[i];
          setStatus('下载中...', 'running');
          setProgress(`第${round}轮 ${i + 1}/${pending.length}`);
          try {
            await downloadOneRow(f.row);
            markFidDownloaded(f.fid, { name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig });
            refreshGray();
          } catch (e) {
            warn(`  下载失败: ${e.message}`);
            const cb = document.querySelector('.swal2-close');
            if (cb && isVisible(cb)) realClick(cb);
            await until(() => !document.querySelector('.swal2-popup'), 100, 1000);
          }
          if (i < pending.length - 1) await sleep(throttle);
        }
        clickRefresh();

        // ★ 轮询等列表刷新稳定（行数连续 3 次相同，最多 5s）
        let lastN = -1, hits = 0;
        await until(() => {
          const n = scanFileRows().length;
          if (n > 0 && n === lastN) {
            if (++hits >= 3) return true;
          } else {
            hits = 0;
          }
          lastN = n;
          return false;
        }, 200, 5000);
      }
      log('===== 下载完成 =====');
      setStatus('下载完成', 'done');
      setProgress('-');
    } finally {
      downloadRunning = false;
    }
  }

  /* ============================================================
   *  ★ 对比清理失效记录（主逻辑）
   *  记录里存在、但当前页文件列表里已无对应 fid → 视为失效，清掉记录
   * ============================================================ */
  function purgeMissingRecords() {
    if (!isListPage()) return 0;
    const files = scanFileRows();
    if (!files.length) { log('对比清理：当前页无文件，跳过'); return 0; }

    const pageFids = new Set(files.map(f => f.fid).filter(Boolean));
    if (!pageFids.size) { log('对比清理：当前页无 fid，跳过'); return 0; }

    const recs = loadDlRecords();
    const stale = [];
    for (const fid of Object.keys(recs)) {
      if (!pageFids.has(fid)) stale.push(fid);
    }
    if (!stale.length) { log('对比清理：无失效记录'); return 0; }

    clearDlRecordsFids(stale);
    log(`★ 对比清理：移除 ${stale.length} 条失效记录（本页 ${pageFids.size} 个文件）`);
    return stale.length;
  }

  /* ============================================================
   *  底层 UI 删除工具（保留为可选 API，自动流程不再调用）
   * ============================================================ */

  /* 取消勾选所有行 */
  async function clearAllSelection() {
    const rows = document.querySelectorAll('tr.ant-table-row, [data-row-key]');
    for (const row of rows) {
      if (!row.classList.contains('ant-table-row-selected')) continue;
      const lbl = row.querySelector('label.ant-checkbox-wrapper');
      if (!lbl) continue;
      realClick(lbl);
      // ★ 轮询等这一行取消选中（最多 800ms，超时继续下一行）
      await until(() => {
        const i = row.querySelector('input.ant-checkbox-input');
        return !(i && i.checked) && !row.classList.contains('ant-table-row-selected');
      }, 50, 800);
    }
  }

  /* 顶栏"删除"按钮（异步等待出现；勾选后才会被渲染） */
  async function clickDeleteButton(timeout = 6000) {
    const btn = await until(() => {
      for (const el of document.querySelectorAll('.btn-group button.btn-file, .btn-group button.ant-btn')) {
        const txt = (el.textContent || '').replace(/\s+/g, '');
        if (txt === '删除' && isVisible(el)) return el;
      }
      for (const el of document.querySelectorAll('button.btn-file, button.ant-btn')) {
        const txt = (el.textContent || '').replace(/\s+/g, '');
        if (txt === '删除' && isVisible(el)) return el;
      }
      return null;
    }, 150, timeout);
    if (!btn) return false;
    realClick(btn);
    return true;
  }

  /* 确认删除弹窗：优先 .ant-btn-primary（"确认删除"） */
  async function confirmDeleteDialog(timeout = 6000) {
    const btn = await until(() => {
      const modal =
            document.querySelector('.base-confirm-modal .ant-modal') ||
            document.querySelector('.ant-modal-root .ant-modal-wrap[role="dialog"] .ant-modal') ||
            findVisibleModal();
      if (!modal || !isVisible(modal)) return null;

      const primary = modal.querySelector('.ant-modal-footer .ant-btn-primary');
      if (primary && isVisible(primary)) {
        const txt = (primary.textContent || '').replace(/\s+/g, '');
        if (/确认删除|确定删除|^删除$|^确定$|^确认$/.test(txt)) return primary;
      }
      for (const b of modal.querySelectorAll('.ant-modal-footer button')) {
        if (!isVisible(b)) continue;
        const txt = (b.textContent || '').replace(/\s+/g, '');
        if (/确认删除|确定删除|^删除$|^确定$|^确认$/.test(txt)) return b;
      }
      return null;
    }, 200, timeout);
    if (!btn) return false;
    realClick(btn);
    return true;
  }

  /* 等删除结果 */
  async function waitDeleteResult(timeout = 8000) {
    const r = await until(() => {
      let text = '';
      try {
        for (const sel of ['.ant-message-notice', '.ant-notification-notice', '.swal2-popup']) {
          for (const el of document.querySelectorAll(sel)) {
            if (isVisible(el)) text += ' ' + (el.textContent || '');
          }
        }
      } catch {}
      if (/删除成功|已删除|删除完成/.test(text)) return 'success';
      if (/删除失败|操作失败|无法删除/.test(text)) return 'fail';
      const stillConfirm = document.querySelector('.base-confirm-modal');
      if (!stillConfirm || !isVisible(stillConfirm)) return 'success';
      return null;
    }, 300, timeout);
    return r || 'unknown';
  }

  /* 用复选框删除指定 fid 集合（仅当前页能匹配到的） */
  async function deleteRowsByFids(fids) {
    if (!fids || !fids.length) return 0;
    const fidSet = new Set(fids);

    await clearAllSelection();

    const rows = document.querySelectorAll('tr.ant-table-row[data-row-key]');
    let picked = 0;
    for (const row of rows) {
      const fid = row.getAttribute('data-row-key');
      if (!fid || !fidSet.has(fid)) continue;
      const lbl = row.querySelector('label.ant-checkbox-wrapper');
      if (!lbl) continue;
      const input = row.querySelector('input.ant-checkbox-input');
      if (!input || !input.checked) {
        realClick(lbl);
        // ★ 轮询等勾选生效
        await until(() => {
          const i = row.querySelector('input.ant-checkbox-input');
          return i && i.checked;
        }, 80, 800);
      }
      const recheck = row.querySelector('input.ant-checkbox-input');
      if (recheck && recheck.checked) picked++;
    }
    if (!picked) { log('  目标 fid 在当前页未匹配到可勾选行'); return 0; }

    if (!await clickDeleteButton()) { warn('  未找到顶栏删除按钮'); return 0; }
    if (!await confirmDeleteDialog()) { warn('  未找到删除确认按钮'); return 0; }
    const r = await waitDeleteResult();
    log('  删除结果:', r);

    // ★ 轮询等确认弹窗从 DOM 消失（最多 800ms）
    await until(() => !document.querySelector('.base-confirm-modal'), 100, 800);
    return picked;
  }

  /* ============================================================
   *  ★ 启动自动流程：先对比清理失效记录 → 再自动下载
   * ============================================================ */
  async function tryAutoDownloadOnBoot() {
    if (downloadRunning) { log('★ 自动流程：已有任务，跳过'); return; }
    if (sessionStorage.getItem(BUSY_KEY) === '1') {
      log('★ 自动流程：桥接脚本转存中，跳过');
      return;
    }

    // ★ 先对比清理：记录里存在但当前页已无对应文件
    purgeMissingRecords();

    log('★ 自动下载检查启动...');

    const ok = await until(() => document.querySelector('.quark-button.pl-button'), 500, 20000);
    if (!ok) { log('  下载助手未就绪，跳过'); return; }

    let files = [];
    const t0 = Date.now();
    let lastCount = -1, stableHits = 0;
    while (Date.now() - t0 < 20000) {
      files = scanFileRows();
      if (files.length > 0 && files.length === lastCount) {
        stableHits++;
        if (stableHits >= 2) break;
      } else {
        stableHits = 0;
      }
      lastCount = files.length;
      await sleep(400);
    }
    if (!files.length) { log('  列表无文件，跳过下载'); return; }

    const pending = files.filter(f => f.fid && !isFidDownloaded(f.fid));
    log(`  列表 ${files.length} 个文件，未下载 ${pending.length} 个`);
    if (pending.length) {
      log(`★ 启动自动下载（${pending.length} 个）`);
      await autoDownloadWorkflow({ maxRounds: 3 });
      log('★ 自动下载完成');
    } else {
      log('  无需下载，跳过');
    }
  }

  /* ============================================================
   *  ★ 标记勾选的文件为已下载
   * ============================================================ */
  function markSelectedAsDownloaded() {
    if (!isListPage()) { alert('当前不是列表页'); return 0; }

    const files = scanFileRows();
    const picked = files.filter(f => f.checked && f.fid);

    if (!picked.length) {
      alert('未勾选任何文件（或勾选的文件无有效 fid）');
      return 0;
    }

    for (const f of picked) {
      markFidDownloaded(f.fid, {
        name: f.name,
        sizeStr: f.sizeStr,
        iconSig: f.iconSig,
      });
    }

    log(`★ 标记选中为已下载：${picked.length} 个`);
    refreshGray();
    alert(`已标记 ${picked.length} 个文件为已下载`);
    return picked.length;
  }

  /* ============================================================
   *  个人页按钮
   * ============================================================ */
  function clearDlRecordsFlow() {
    if (!isListPage()) { alert('当前不是列表页'); return; }
    const files = scanFileRows();
    const dl = loadDlRecords();

    // ① 有勾选 → 只清勾选文件的记录
    const checked = files.filter(f => f.checked && f.fid);
    if (checked.length) {
      const hitIds = checked.filter(f => dl[f.fid]).map(f => f.fid);
      if (!hitIds.length) {
        alert(`勾选 ${checked.length} 个文件，但均无下载记录`);
        return;
      }
      if (!confirm(`清除勾选的 ${hitIds.length} 条下载记录？`)) return;
      clearDlRecordsFids(hitIds);
      alert(`已清除 ${hitIds.length} 条（勾选）`);
      refreshGray();
      return;
    }

    // ② 无勾选、当前页无文件 → 清全部
    if (!files.length) {
      const n = Object.keys(dl).length;
      if (!n) { alert('无下载记录可清除'); return; }
      if (!confirm(`当前页面无文件，清除全部 ${n} 条下载记录？`)) return;
      clearAllDlRecords();
      alert(`已清全部 ${n} 条`);
      refreshGray();
      return;
    }

    // ③ 无勾选、当前页有文件 → 清当前页全部
    const ids = files.map(f => f.fid).filter(Boolean);
    const hit = ids.filter(id => dl[id]).length;
    if (!hit) { alert('本页无下载记录'); return; }
    if (!confirm(`未勾选文件，清除本页 ${hit} 条下载记录？`)) return;
    clearDlRecordsFids(ids);
    alert(`已清除 ${hit} 条（本页）`);
    refreshGray();
  }

  function installListPageActions() {
    addBuiltinAction({
      label: '⬇️ 下载', color: '#52c41a',
      title: '下载本页未下载过的文件',
      onclick: () => autoDownloadWorkflow(),
    });
    addBuiltinAction({
      label: '✅ 标记已下载', color: '#1677ff',
      title: '把当前勾选的文件标记为已下载（置灰，不再被自动下载）',
      onclick: () => markSelectedAsDownloaded(),
    });
    addBuiltinAction({
      label: '🔍 清理失效记录', color: '#d46b08',
      title: '对比本页实际文件，清掉"记录存在但文件已不存在"的下载记录',
      onclick: () => {
        const n = purgeMissingRecords();
        refreshGray();
        alert(`已清理 ${n} 条失效记录`);
      },
    });
    addBuiltinAction({
      label: '🗑️ 清除下载记录', color: '#8c2f1f',
      title: '清除本页/全部下载记录（只删记录，不删文件）',
      onclick: () => clearDlRecordsFlow(),
    });
  }

  /* ============================================================
   *  对外 API
   * ============================================================ */
  unsafeWindow.quarkAssistant = {
    version: '5.2.4',
    isReady: () => true,
    isListPage, isSharePage,

    mountPanel, setStatus, setProgress, setActions,
    addBuiltinAction, clearBuiltinActions,

    setGrayPredicate, refreshGray, setProgressLabel,
    showProgress, hideProgress,

    isVisible, getVisibleText, realClick, sleep, until,
    scanFileRows, getFileIconSig,

    findSaveButton, clickSaveButton,
    waitForSaveDialog, clickConfirmInDialog, closeDialog,
    classify, waitResult,

    loadDlRecords, saveDlRecords, isFidDownloaded,
    markFidDownloaded, clearDlRecordsFids, clearAllDlRecords,
    pickExpiredFids,

    autoDownloadWorkflow, triggerApiDownload, handleApiDialog,
    waitForApiReady, clickRefresh,

    // 对比清理（推荐入口）
    purgeMissingRecords,

    // 标记勾选文件为已下载
    markSelectedAsDownloaded,

    // 底层 UI 删除工具（自动流程不调用，可独立使用）
    clearAllSelection, clickDeleteButton,
    confirmDeleteDialog, waitDeleteResult,
    deleteRowsByFids,
  };

  /* ============================================================
   *  启动
   * ============================================================ */
  (async function boot() {
    if (!document.body) await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));

    if (isListPage()) {
      mountPanel();
      setProgressLabel('已下载');
      installListPageActions();
      setStatus('待机（个人页）');
      log('平台层就绪（个人页）v5.2.4');

      // 启动后：先对比清理失效记录 → 再走自动下载
      setTimeout(() => { tryAutoDownloadOnBoot(); }, 3000);
    } else if (isSharePage()) {
      log('平台层就绪（分享页，等待桥接 mountPanel）v5.2.4');
    } else {
      log('平台层就绪（其他页）v5.2.4');
    }

    startGrayPolling();
  })();
})();