// ==UserScript==
// @name         QuarkAutoAssistant
// @namespace    quark-auto-save
// @version      5.3.8
// @description  夸克网盘平台层：UI + DOM 工具 + 批量下载 + 下载记录 + 暂停控制 + 底层删除工具（转存逻辑交给桥接脚本）
// @match        https://pan.quark.cn/*
// @downloadURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/quarkAutoAssistant.user.js
// @updateURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/quarkAutoAssistant.user.js
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
  const DL_TTL   = 24 * 60 * 60 * 1000;
  const THROTTLE = 5000;
  const BUSY_KEY = 'acgrip_bridge_busy';
  const PAUSE_KEY = 'quark_auto_pause_state';

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

  /* 直接存原生类型，GM 自己序列化；读取时兼容旧的 JSON 字符串 */
  function gmGet(key, def) {
    try {
      const v = GM_getValue(key);
      if (v == null || v === '') return def;
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    } catch { return def; }
  }
  function gmSet(key, val) { try { GM_setValue(key, val); } catch {} }

  /* ===== 暂停控制 ===== */
  function isPaused() {
    try { return GM_getValue(PAUSE_KEY) === '1'; } catch { return false; }
  }
  function setPaused(v) {
    try { GM_setValue(PAUSE_KEY, v ? '1' : '0'); } catch {}
    log(v ? '⏸ 暂停标志已写入' : '▶ 恢复标志已写入');
  }
  async function waitWhilePaused() {
    if (!isPaused()) return;
    setStatus('已暂停', 'running');
    log('⏸ 已暂停，等待恢复...');
    while (isPaused()) await sleep(400);
    setStatus('继续中...', 'running');
    log('▶ 已恢复');
  }

  /* ===== 页面识别 ===== */
  function isListPage()  { return location.pathname.startsWith('/list'); }
  function isSharePage() { return /^\/s\/[a-zA-Z0-9]+/.test(location.pathname); }

  /* ===== 面板 ===== */
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
      const label = typeof a.label === 'function' ? a.label() : (a.label || '动作');
      btn.textContent = label;
      if (a.color) btn.style.background = a.color;
      if (a.title) btn.title = a.title;
      btn.onclick = () => { try { a.onclick && a.onclick(); } catch (e) { warn('按钮出错', e); } };
      uiRefs.actions.appendChild(btn);
    }
  }
  function setActions(list) { _externalActions = list || []; renderActions(); }
  function addBuiltinAction(a) { _builtinActions.push(a); renderActions(); }
  function clearBuiltinActions() { _builtinActions = []; renderActions(); }

  /* ===== 悬浮进度条 ===== */
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

  /* ===== DOM 工具 ===== */
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

  /* ===== 下载记录（GM） =====
     记录带 scope（所属目录），清理只作用于同目录，避免误删其它目录或尚未渲染的记录。 */
  function currentListScope() {
    try {
      const h = String(location.hash || '');
      /* /list#/list/all/<folderId>/ */
      const m = h.match(/#\/list\/[^/]+\/([^/?#]+)/);
      if (m && m[1]) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
      const m2 = h.match(/#\/list\/([^/?#]+)/);
      if (m2 && m2[1]) { try { return decodeURIComponent(m2[1]); } catch { return m2[1]; } }
    } catch {}
    return '';
  }

  function loadDlRecords() { return gmGet(GM_DL_RECORDS, {}) || {}; }
  function saveDlRecords(recs) { gmSet(GM_DL_RECORDS, recs); }

  function recordTs(r) { return typeof r === 'number' ? r : (r && r.ts || 0); }

  function isFidDownloaded(fid) {
    if (!fid) return false;
    const recs = loadDlRecords();
    const r = recs[fid];
    if (!r) return false;
    const ts = recordTs(r);
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
      scope: info.scope || currentListScope(),
    };
    saveDlRecords(recs);
  }

  function clearDlRecordsFids(fids) {
    if (!fids || !fids.length) return 0;
    const recs = loadDlRecords();
    let n = 0;
    for (const fid of fids) { if (recs[fid]) { delete recs[fid]; n++; } }
    saveDlRecords(recs);
    return n;
  }

  function clearAllDlRecords() {
    saveDlRecords({});
  }

  function pickExpiredFids() {
    const recs = loadDlRecords();
    const now = Date.now();
    const out = [];
    for (const k of Object.keys(recs)) {
      const ts = recordTs(recs[k]);
      if (ts > 0 && now - ts > DL_TTL) out.push(k);
    }
    return out;
  }

  /* ===== 个人页置灰 + 进度 ===== */
  let _progressLabel = '已处理';

  function setProgressLabel(label) { _progressLabel = label || '已处理'; }

  function refreshGray(doc = document) {
    if (!isListPage()) return { grayed: 0, total: 0 };
    const files = scanFileRows(doc);
    let grayed = 0;
    for (const f of files) {
      if (isFidDownloaded(f.fid)) { f.row.classList.add('qap-grayed'); grayed++; }
      else f.row.classList.remove('qap-grayed');
    }
    if (doc === document && files.length > 0) {
      showProgress(grayed, files.length, _progressLabel);
      if (uiRefs) uiRefs.progress.textContent = `${grayed} / ${files.length}`;
    }
    return { grayed, total: files.length };
  }

  function startGrayPolling() {
    if (!isListPage()) return;
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

  /* ===== 通用模态框查找（供内部 confirmDeleteDialog 使用） ===== */
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

  /* ===== 下载流程 ===== */
  let downloadRunning = false;

  async function triggerApiDownload() {
    const btnEl = document.querySelector('.quark-button.pl-button');
    if (!btnEl) throw new Error('找不到"下载助手"按钮');
    const win = btnEl.ownerDocument.defaultView || window;

    for (const t of ['mouseenter', 'mouseover']) {
      try { btnEl.dispatchEvent(new win.MouseEvent(t, { bubbles: true, view: win })); } catch {}
    }

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

    await until(() => {
      if (!document.querySelector('.swal2-popup')) return true;
      const btn = document.querySelector('.swal2-close');
      if (btn && isVisible(btn)) realClick(btn);
      return false;
    }, 100, 2000);

    await until(() => !document.querySelector('.swal2-popup'), 150, 3000);
  }

  async function collectApiLinks(timeout = 15000) {
    const popup = await until(() => {
      const p = document.querySelector('.swal2-popup');
      if (!p) return null;
      if (p.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning')) return p;
      if (p.querySelector('.listener-link-api')) return p;
      return null;
    }, 200, timeout);

    if (!popup) return null;
    if (popup.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning')) return null;

    const links = [...popup.querySelectorAll('.listener-link-api')];
    return links.map(a => ({
      el: a,
      fid: a.dataset.fid || '',
      filename: a.dataset.filename || '',
      link: a.dataset.link || '',
    }));
  }

  async function downloadOneRow(row) {
    const fid = row.getAttribute('data-row-key') || '';

    const allRows = document.querySelectorAll('tr.ant-table-row, [data-row-key]');
    for (const r of allRows) {
      if (r === row) continue;
      if (r.classList.contains('ant-table-row-selected')) {
        const lbl = r.querySelector('label.ant-checkbox-wrapper');
        if (lbl) realClick(lbl);
      }
    }

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

    if (!isChecked()) {
      const lbl = row.querySelector('label.ant-checkbox-wrapper');
      if (!lbl) throw new Error('找不到 checkbox');
      realClick(lbl);
      await until(isChecked, 80, 1200);
    }
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

  async function clearRowSelection() {
    const rows = document.querySelectorAll('tr.ant-table-row, [data-row-key]');
    for (const row of rows) {
      if (!row.classList.contains('ant-table-row-selected')) continue;
      const lbl = row.querySelector('label.ant-checkbox-wrapper');
      if (!lbl) continue;
      realClick(lbl);
      await until(() => {
        const i = row.querySelector('input.ant-checkbox-input');
        return !(i && i.checked) && !row.classList.contains('ant-table-row-selected');
      }, 50, 800);
    }
  }

  async function selectRow(row, timeout = 1500) {
    const isChecked = () => {
      const i = row.querySelector('input.ant-checkbox-input');
      return !!(i && i.checked) || row.classList.contains('ant-table-row-selected');
    };
    if (isChecked()) return true;
    const lbl = row.querySelector('label.ant-checkbox-wrapper');
    if (!lbl) return false;
    realClick(lbl);
    await until(isChecked, 80, timeout);
    if (!isChecked()) {
      realClick(lbl);
      await until(isChecked, 80, timeout);
    }
    return isChecked();
  }

  /* ===== 批量下载流程 ===== */
  async function autoDownloadWorkflow(opts = {}) {
    const { throttle = THROTTLE } = opts;

    if (downloadRunning) { log('下载任务已在运行'); return; }
    if (!isListPage()) { warn('当前不是列表页，跳过下载'); return; }
    if (isPaused()) {
      log('⏸ 已处于暂停状态，取消启动');
      setStatus('已暂停', 'running');
      return;
    }

    downloadRunning = true;
    log('===== 开始批量自动下载 =====');

    try {
      setStatus('等待下载助手...', 'running');
      const ok = await waitForApiReady();
      if (!ok) { warn('下载助手未就绪'); setStatus('未就绪', 'error'); return; }

      await until(() => scanFileRows().length > 0, 200, 5000);

      const files = scanFileRows();
      const pending = files.filter(f => f.fid && !isFidDownloaded(f.fid));
      log(`批量下载：共 ${files.length} 个文件，待下载 ${pending.length} 个`);

      if (!pending.length) {
        log('  无待下载文件');
        setStatus('无待下载', 'done');
        setProgress('-');
        return;
      }

      setStatus('批量勾选中...', 'running');
      setProgress(`选中 0/${pending.length}`);
      await clearRowSelection();

      let selected = 0;
      for (const f of pending) {
        await waitWhilePaused();
        if (!f.row.isConnected) continue;
        const done = await selectRow(f.row);
        if (done) selected++;
        setProgress(`选中 ${selected}/${pending.length}`);
      }
      log(`已勾选 ${selected} 个文件`);

      if (!selected) {
        warn('没有文件被勾选，终止');
        setStatus('勾选失败', 'error');
        return;
      }

      await waitWhilePaused();
      setStatus('获取链接中...', 'running');
      await triggerApiDownload();

      const links = await collectApiLinks(15000);
      if (!links || !links.length) {
        const err = document.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning');
        if (err) {
          const cb = document.querySelector('.swal2-close');
          if (cb && isVisible(cb)) realClick(cb);
          throw new Error('API 下载弹窗返回错误');
        }
        throw new Error('未获取到下载链接');
      }
      log(`★ 获取到 ${links.length} 个下载链接`);

      let done = 0;
      for (let i = 0; i < links.length; i++) {
        await waitWhilePaused();
        const l = links[i];

        if (l.fid && isFidDownloaded(l.fid)) {
          log(`  [${i + 1}/${links.length}] 跳过（已下载）: ${l.filename}`);
          done++;
          continue;
        }

        setStatus('下载中...', 'running');
        setProgress(`${i + 1}/${links.length}  ${l.filename || ''}`);

        try {
          if (!l.el || !l.el.isConnected) {
            warn(`  链接元素已失效: ${l.filename}`);
            continue;
          }
          log(`  [${i + 1}/${links.length}] 下载: ${l.filename}`);
          realClick(l.el);
          if (l.fid) {
            markFidDownloaded(l.fid, { name: l.filename, link: l.link });
          }
          done++;
          refreshGray();
        } catch (e) {
          warn(`  下载失败 ${l.filename}: ${e.message}`);
        }

        if (i < links.length - 1) await sleep(throttle);
      }

      const cb = document.querySelector('.swal2-close');
      if (cb && isVisible(cb)) realClick(cb);
      await until(() => !document.querySelector('.swal2-popup'), 100, 3000);

      log(`===== 批量下载完成（${done}/${links.length}）=====`);
      setStatus('下载完成', 'done');
      setProgress('-');
    } catch (e) {
      warn('批量下载出错:', e.message);
      setStatus('出错: ' + e.message, 'error');
      const cb = document.querySelector('.swal2-close');
      if (cb && isVisible(cb)) realClick(cb);
    } finally {
      downloadRunning = false;
    }
  }

  /* ===== 对比清理失效记录 =====
     只清理当前目录(scope)内的记录，且要求列表已加载完；看不到某行 ≠ 该记录失效（虚拟滚动/未渲染完/别的目录）。 */
  /* 加载中判定（依据夸克实际 DOM）：.ant-table-wrapper > .ant-spin-nested-loading 下的
     .table-loading-wrap / .ant-table-spin-holder.ant-spin-spinning / .ant-spin-container.ant-spin-blur */
  function isLoadingAnimPresent() {
    /* 全文档匹配：页面可能有多个 .ant-table-wrapper（隐藏表格/弹窗），只看第一个会漏掉真正的加载动画，
       把"加载中"当成"加载完"。 */
    return !!(
      document.querySelector('.table-loading-wrap') ||
      document.querySelector('.ant-table-spin-holder.ant-spin-spinning') ||
      document.querySelector('.ant-spin-nested-loading .ant-spin-spinning') ||
      document.querySelector('.ant-spin-container.ant-spin-blur')
    );
  }

  /* "确实没有文件"的空态：.table-empty-wrap 在加载期间同样存在但 opacity:0，必须靠 opacity 区分。
     本函数不参与"是否加载完"的判断，只在删除时作为匹配依据（列表为空即该目录没有任何文件，其记录全部不匹配）；判定不出来时一律"不算空"（fail closed）。 */
  function isEmptyUiVisible() {
    if (isLoadingAnimPresent()) return false;

    const wrap = document.querySelector('.ant-table-placeholder .table-empty-wrap')
      || document.querySelector('.table-empty-wrap');
    if (!wrap) return false;

    let op = '';
    try { op = getComputedStyle(wrap).opacity; } catch {}
    if (op === '' || op == null) op = (wrap.style && wrap.style.opacity) || '';
    if (op === '') return false;              /* 拿不到 opacity 就不认为是空目录 */
    const n = Number(op);
    if (!Number.isFinite(n)) return false;
    return n > 0.01;
  }

  /* 列表是否已加载完：只看还有没有加载动画（空列表判定不参与，见 isEmptyUiVisible）。 */
  function isListLoaded() {
    return !isLoadingAnimPresent();
  }

  /* 列表是否为虚拟滚动（DOM 里只有可见行）：这种快照天然不完整，自动清理会把未渲染的记录当"失效"删掉。 */
  function isTableVirtual() {
    const body = document.querySelector('.ant-table-wrapper .ant-table-body');
    if (!body) return false;
    const inner = body.firstElementChild;
    if (!inner) return false;
    const innerH = inner.getBoundingClientRect().height
      || parseFloat(getComputedStyle(inner).height) || 0;
    /* 取不到高度（如加载态 vt 容器 height:0）时按"虚拟"从宽处理 */
    if (!innerH) return true;
    return innerH > body.clientHeight + 50;
  }

  /* 该目录的行是否"全部在 DOM 里"（自动清理的硬前提）：还能滚动就可能有视窗外的未渲染行，此时自动清理必然误删。 */
  function isWholeListRendered() {
    const body = document.querySelector('.ant-table-wrapper .ant-table-body');
    if (!body) return true;
    if (body.scrollHeight > body.clientHeight + 50) return false;
    return !isTableVirtual();
  }

  function purgeMissingRecords(opts = {}) {
    const manual = opts.manual === true;
    if (!isListPage()) return 0;

    /* 确认列表已加载完：只看加载动画是否还在 */
    if (!isListLoaded()) { log('对比清理：列表尚未加载完（仍有加载动画），跳过（避免误删）'); return 0; }

    const files = scanFileRows();
    const pageFids = new Set(files.map(f => f.fid).filter(Boolean));
    /* 空列表只在这里作为"匹配依据"：没有文件行、且空态 UI 确实显示，才认为该目录没有文件，
       其记录全部不匹配；否则跳过。 */
    const emptyUi = !pageFids.size && isEmptyUiVisible();

    /* 有文件行就用 fid 对比；确认的空目录则其记录全部视为失效 */
    if (!pageFids.size && !emptyUi) {
      log('对比清理：本页无可用 fid，且不是"没有文件"空态，跳过');
      return 0;
    }

    const scope = currentListScope();
    /* 识别不出当前目录就无法判断记录归属，一律不动（避免跨目录误删） */
    if (!scope) { log('对比清理：无法识别当前目录，跳过'); return 0; }

    const recs = loadDlRecords();
    const stale = [];
    for (const fid of Object.keys(recs)) {
      const r = recs[fid];
      const s = (r && typeof r === 'object') ? String(r.scope || '') : '';
      /* scope 为空的记录归属未知，一律不动 */
      if (!s) continue;
      /* 其它目录的记录一律不动 */
      if (s !== scope) continue;
      if (!pageFids.has(fid)) stale.push(fid);
    }
    if (!stale.length) { log('对比清理：无失效记录'); return 0; }

    if (manual) {
      const notWhole = !emptyUi && !isWholeListRendered();
      const ok = confirm(
        `将清理目录「${scope}」中 ${stale.length} 条“文件已不存在”的下载记录` +
        (emptyUi ? '（当前目录为空）' : '') + `。\n` +
        (notWhole
          ? '⚠️ 当前列表可滚动 / 为虚拟滚动，DOM 里只有部分行；未被渲染的行也会被算作“不存在”。\n'
          : '') +
        `（其它目录的记录不受影响）\n\n继续？`
      );
      if (!ok) return 0;
    } else if (!emptyUi && !isWholeListRendered()) {
      /* 列表还能滚动或为虚拟滚动，DOM 里只有部分行，自动清理必然误删 */
      log(`对比清理：列表仍可滚动或为虚拟滚动（DOM 仅 ${files.length} 行，非全量），`
        + '自动清理会误删未渲染记录，跳过（如需清理请手动点击，会先确认再执行）');
      return 0;
    } else if (!emptyUi && stale.length > Math.max(20, files.length)) {
      /* 自动路径：待删数量远超本页可见行，极可能是快照不完整，放弃 */
      log(`对比清理：自动清理疑似误删（待删 ${stale.length} > 本页 ${files.length}），跳过`);
      return 0;
    }

    const n = clearDlRecordsFids(stale);
    log(`★ 对比清理：移除 ${n} 条失效记录（目录 ${scope}，`
      + (emptyUi ? '空目录' : `本页 ${pageFids.size} 个文件`) + '）');
    return n;
  }

  /* ===== 底层 UI 删除工具 ===== */
  async function clearAllSelection() {
    const rows = document.querySelectorAll('tr.ant-table-row, [data-row-key]');
    for (const row of rows) {
      if (!row.classList.contains('ant-table-row-selected')) continue;
      const lbl = row.querySelector('label.ant-checkbox-wrapper');
      if (!lbl) continue;
      realClick(lbl);
      await until(() => {
        const i = row.querySelector('input.ant-checkbox-input');
        return !(i && i.checked) && !row.classList.contains('ant-table-row-selected');
      }, 50, 800);
    }
  }

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

    await until(() => !document.querySelector('.base-confirm-modal'), 100, 800);
    return picked;
  }

  /* ===== 启动自动流程 ===== */
  async function tryAutoDownloadOnBoot() {
    if (downloadRunning) { log('★ 自动流程：已有任务，跳过'); return; }
    if (isPaused()) { log('★ 自动流程：当前处于暂停状态，跳过'); return; }
    if (sessionStorage.getItem(BUSY_KEY) === '1') {
      log('★ 自动流程：桥接脚本转存中，跳过');
      return;
    }

    /* 自动对比清理前先确认列表已加载完（只看加载动画）：仍有加载动画说明只是部分渲染，
       超时则本次跳过，绝不拿半截快照去删记录；空列表不参与"是否加载完"，只在实际删除时作匹配依据。 */
    const listLoaded = await until(() => isListLoaded(), 300, 20000);
    if (!listLoaded) {
      log('★ 对比清理：等待列表加载完成超时，本次跳过（避免误删）');
    } else {
      purgeMissingRecords();
    }

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
      await autoDownloadWorkflow({ throttle: THROTTLE });
      log('★ 自动下载完成');
    } else {
      log('  无需下载，跳过');
    }
  }

  /* ===== 标记勾选的文件为已下载 ===== */
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

  /* ===== 清除下载记录 ===== */
  function clearDlRecordsFlow() {
    if (!isListPage()) { alert('当前不是列表页'); return; }
    const files = scanFileRows();
    const dl = loadDlRecords();

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

    if (!files.length) {
      const n = Object.keys(dl).length;
      if (!n) { alert('无下载记录可清除'); return; }
      if (!confirm(`当前页面无文件，清除全部 ${n} 条下载记录？`)) return;
      clearAllDlRecords();
      alert(`已清全部 ${n} 条`);
      refreshGray();
      return;
    }

    const ids = files.map(f => f.fid).filter(Boolean);
    const hit = ids.filter(id => dl[id]).length;
    if (!hit) { alert('本页无下载记录'); return; }
    if (!confirm(`未勾选文件，清除本页 ${hit} 条下载记录？`)) return;
    clearDlRecordsFids(ids);
    alert(`已清除 ${hit} 条（本页）`);
    refreshGray();
  }

  /* ===== 个人页按钮 ===== */
  function installListPageActions() {
    addBuiltinAction({
      label: '⬇️ 下载',
      color: '#52c41a',
      title: '批量下载本页未下载过的文件（一次获取全部链接，间隔逐个下载）',
      onclick: () => autoDownloadWorkflow(),
    });
    addBuiltinAction({
      get label() { return isPaused() ? '▶️ 继续下载' : '⏸️ 暂停下载'; },
      get color() { return isPaused() ? '#52c41a' : '#faad14'; },
      title: '暂停/继续自动下载（状态持久化，刷新后保持）',
      onclick: () => {
        const next = !isPaused();
        setPaused(next);
        log(next ? '⏸ 已暂停自动下载' : '▶ 已继续自动下载');
        setStatus(next ? '已暂停' : '待机（个人页）', next ? 'running' : '');
        renderActions();
      },
    });
    addBuiltinAction({
      label: '✅ 标记已下载',
      color: '#1677ff',
      title: '把当前勾选的文件标记为已下载（置灰，不再被自动下载）',
      onclick: () => markSelectedAsDownloaded(),
    });
    addBuiltinAction({
      label: '🔍 清理失效记录',
      color: '#d46b08',
      title: '只清理「当前目录」中"记录存在但文件已不存在"的记录（需列表加载完；其它目录不受影响）',
      onclick: () => {
        const n = purgeMissingRecords({ manual: true });
        refreshGray();
        alert(n > 0
          ? `已清理 ${n} 条失效记录`
          : '没有可清理的记录（若列表仍在加载，本次已跳过以避免误删）');
      },
    });
    addBuiltinAction({
      label: '🗑️ 清除下载记录',
      color: '#8c2f1f',
      title: '清除本页/全部下载记录（只删记录，不删文件）',
      onclick: () => clearDlRecordsFlow(),
    });
  }

  /* ===== 对外 API ===== */
  unsafeWindow.quarkAssistant = {
    version: '5.3.8',
    isReady: () => true,
    isListPage, isSharePage,

    mountPanel, setStatus, setProgress, setActions,
    addBuiltinAction, clearBuiltinActions,

    refreshGray, setProgressLabel,
    showProgress, hideProgress,

    isVisible, getVisibleText, realClick, sleep, until,
    scanFileRows, getFileIconSig,

    findVisibleModal,

    loadDlRecords, saveDlRecords, isFidDownloaded,
    markFidDownloaded, clearDlRecordsFids, clearAllDlRecords,
    pickExpiredFids,
    currentListScope,
    isLoadingAnimPresent, isEmptyUiVisible, isListLoaded, isTableVirtual, isWholeListRendered,

    isPaused, setPaused, waitWhilePaused,

    autoDownloadWorkflow,
    collectApiLinks,

    triggerApiDownload, handleApiDialog, downloadOneRow,
    waitForApiReady, clickRefresh,

    purgeMissingRecords,
    markSelectedAsDownloaded,

    clearAllSelection, clickDeleteButton,
    confirmDeleteDialog, waitDeleteResult,
    deleteRowsByFids,
  };

  /* ===== 启动 ===== */
  (async function boot() {
    if (!document.body) await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));

    if (isListPage()) {
      mountPanel();
      setProgressLabel('已下载');
      installListPageActions();
      if (isPaused()) {
        setStatus('已暂停', 'running');
        log('平台层就绪（个人页，暂停中）v5.3.8');
      } else {
        setStatus('待机（个人页）');
        log('平台层就绪（个人页）v5.3.8');
      }

      setTimeout(() => { tryAutoDownloadOnBoot(); }, 3000);
    } else if (isSharePage()) {
      log('平台层就绪（分享页，等待桥接 mountPanel）v5.3.8');
    } else {
      log('平台层就绪（其他页）v5.3.8');
    }

    startGrayPolling();
  })();
})();