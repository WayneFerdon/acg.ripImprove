// ==UserScript==
// @name         QuarkAutoAssistant
// @namespace    quark-auto-save
// @version      5.7.7
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
  const DL_TTL = 24 * 60 * 60 * 1000;
  const THROTTLE = 5000;
  const BUSY_KEY = 'acgrip_bridge_busy';
  const PAUSE_KEY = 'quark_auto_pause_state';

  const log = (...a) => console.log(PREFIX, ...a);
  const warn = (...a) => console.warn(PREFIX, ...a);
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

  function isBridgeBusy() {
    try { return sessionStorage.getItem(BUSY_KEY) === '1'; } catch { return false; }
  }

 /* ===== 页面识别 ===== */
  function isListPage() { return location.pathname.startsWith('/list'); }
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

  function realClick(el) {
    if (!el || !el.isConnected) return false;
    const win = el.ownerDocument.defaultView || window;
    const base = { bubbles: true, cancelable: true, view: win, button: 0, buttons: 1 };
    const up = { ...base, buttons: 0 };
    try {
      el.dispatchEvent(new win.PointerEvent('pointerdown', base));
      el.dispatchEvent(new win.MouseEvent('mousedown', base));
      el.dispatchEvent(new win.PointerEvent('pointerup', up));
      el.dispatchEvent(new win.MouseEvent('mouseup', up));
      el.dispatchEvent(new win.MouseEvent('click', up));
    } catch { try { el.click?.(); } catch { return false; } }
    return true;
  }

  function readBgImageUrl(el) {
    if (!el) return '';
    try {
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const bg = win.getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) return m[1];
      }
    } catch {}
    const inline = el.getAttribute && el.getAttribute('style');
    if (inline) {
      const m = String(inline).match(/background(?:-image)?\s*:\s*[^;]*url\(["']?(.*?)["']?\)/i);
      if (m && m[1]) return m[1];
    }
    return '';
  }

  function getFileIconSig(row) {
    let iconEl = row.querySelector('.file-icon, [class*="file-icon"], [class*="FileIcon"]');
    if (!iconEl) {
      const cand = row.querySelector('img[src*="thumbnail"], [style*="thumbnail"], [style*="fid="], [class*="thumb"]');
      if (cand && cand !== row && !/^(TD|TR|TBODY|TABLE)$/.test(cand.tagName)) iconEl = cand;
    }
    if (!iconEl) return '';
    const scope = iconEl;

    const img = scope.querySelector('img');
    if (img) {
      const u = img.currentSrc || img.src || img.getAttribute('src') || '';
      if (u && /^(https?:)?\/\//.test(u)) return 'img:' + u;
    }

    const bgSelf = readBgImageUrl(scope);
    if (bgSelf && /^(https?:)?\/\//.test(bgSelf)) return 'bg:' + bgSelf;
    for (const child of scope.querySelectorAll('div,span,i')) {
      const u = readBgImageUrl(child);
      if (u && /^(https?:)?\/\//.test(u)) return 'bg:' + u;
    }

    const useEl = scope.querySelector('use');
    if (useEl) {
      const href = useEl.getAttribute('xlink:href') || useEl.getAttribute('href') || '';
      if (href) return 'svg:' + href;
    }
    const cls = (scope.className || '').trim();
    return cls ? 'cls:' + cls : '';
  }

  function getRowMtimeStr(row) {
    if (!row || typeof row.querySelectorAll !== 'function') return '';
    const tds = row.querySelectorAll('td');
    for (let i = tds.length - 1; i >= 0; i--) {
      const t = (tds[i].textContent || '').trim();
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) return t;
    }
    return '';
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
      const checked = !!(cb && cb.checked) || row.classList.contains('ant-table-row-selected');
      out.push({
        name, sizeStr, fid,
        mtime: getRowMtimeStr(row),
        iconSig: getFileIconSig(row),
        row, checked,
      });
      seen.add(name);
    }
    return out;
  }

 /* ===== 下载记录 ===== */
  function currentListScope() {
    try {
      const h = String(location.hash || '');
      const m = h.match(/#\/list\/[^/]+\/([^/?#]+)/);
      if (m && m[1]) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
      const m2 = h.match(/#\/list\/([^/?#]+)/);
      if (m2 && m2[1]) { try { return decodeURIComponent(m2[1]); } catch { return m2[1]; } }
    } catch {}
    return '';
  }

  /* 读取页面"共 N 个"提示（列表页/个人页）。没有则返回 null。 */
  function getListFileCountHint() {
    try {
      const sels = ['.info-stat span', '.list-info-stat span', '.share-info .info-stat span'];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent || '').trim();
          const m = t.match(/共\s*(\d+)\s*个/);
          if (m) return Number(m[1]);
        }
      }
    } catch {}
    return null;
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

 /* keepTs=true（手动标记）：不覆盖已有 ts；不存在则用当前时间
   * keepTs=false（自动下载完成）：ts=当前时间
   * 其它字段（name/sizeStr/iconSig/mtime/scope）：新值非空才覆盖，否则保留旧值 */
  function markFidDownloaded(fid, info = {}, opts = {}) {
    if (!fid) return;
    const keepTs = opts.keepTs === true;
    const recs = loadDlRecords();
    const prev = recs[fid];
    const next = { ...(prev || {}) };

    if (!keepTs || !prev || !prev.ts) next.ts = Date.now();

    if (info.name) next.name = info.name;
    if (info.sizeStr) next.sizeStr = info.sizeStr;
    if (info.iconSig) next.iconSig = info.iconSig;
    if (info.mtime) next.mtime = info.mtime;
    if (info.link) next.link = info.link;
    if (info.scope) next.scope = info.scope;
    else if (!next.scope) next.scope = currentListScope();

    recs[fid] = next;
    saveDlRecords(recs);
    log(`★ 标记已下载 fid=${String(fid).slice(0, 8)} "${next.name || ''}" sizeStr="${next.sizeStr || '-'}"`
        + ` keepTs=${keepTs} ${prev ? '覆盖旧条目（保留原 ts=' + (keepTs ? (prev.ts || next.ts) : next.ts) + '）' : '新条目'}`);
  }

  function clearDlRecordsFids(fids) {
    if (!fids || !fids.length) return 0;
    const recs = loadDlRecords();
    let n = 0;
    for (const fid of fids) { if (recs[fid]) { delete recs[fid]; n++; } }
    saveDlRecords(recs);
    return n;
  }

  function clearAllDlRecords() { saveDlRecords({}); }

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
  /* 修复夸克 download_url 中 filename 参数里的 +（x-www-form-urlencoded 空格）
  * 只动 filename= 这一段，其他 query 参数的 + 保留原样 */
  function fixFilenamePlusInUrl(url) {
    if (!url) return url;
    try {
      return String(url).replace(/([?&]filename=)([^&#]*)/gi, (m, prefix, value) => {
        return prefix + value.replace(/\+/g, '%20');
      });
    } catch { return url; }
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
    return links.map(a => {
      const original = a.dataset.link || '';
      const fixed = fixFilenamePlusInUrl(original);
      /* 关键：在 realClick 之前把 <a> 上的 URL 也改掉，
      * 直链助手的 handler 读的是 a.dataset.link，
      * 所以它拿到的 iframe src 已经是修复后的 URL，
      * FDM 下载出来的文件名就不会再带 +。 */
      if (fixed !== original) {
        try { a.dataset.link = fixed; } catch {}
        try { a.setAttribute('data-link', fixed); } catch {}
        if (a.getAttribute('href') === original) {
          try { a.setAttribute('href', fixed); } catch {}
        }
      }
      return {
        el: a,
        fid: a.dataset.fid || '',
        filename: a.dataset.filename || '',   // 这个本来就是正确的（原始 file_name）
        link: fixed,                          // 记录里也存修复后的 URL
      };
    });
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

 /* ===== 批量下载流程（返回详细结果，供桥接侧校验） ===== */
  async function autoDownloadWorkflow(opts = {}) {
    const { throttle = THROTTLE, waitForBusy = false, targetFids = null } = opts;
    const result = {
      ok: false,
      reason: 'unknown',
      downloadedFids: [],
      skippedFids: [],
      totalLinks: 0,
      pendingAtStart: 0,
      pendingAfter: 0,
    };

    if (downloadRunning) {
      if (!waitForBusy) {
        warn('★ 自动下载：已有任务在跑（downloadRunning=true），跳过');
        result.reason = 'busy';
        return result;
      }
      warn('★ 自动下载：已有任务在跑，等待其完成（最多 3 分钟）…');
      await until(() => !downloadRunning, 500, 180000);
      if (downloadRunning) {
        warn('★ 自动下载：等待超时，仍被占用');
        result.reason = 'busy-timeout';
        return result;
      }
    }

    if (!isListPage()) {
      warn('★ 自动下载：当前不是列表页');
      result.reason = 'not-list-page';
      return result;
    }
    if (isPaused()) {
      log('★ 自动下载：夸克助手暂停中，跳过');
      setStatus('已暂停', 'running');
      result.reason = 'paused';
      return result;
    }
    if (isBridgeBusy()) {
      warn('★ 自动下载：桥接忙碌（转存/刷新/改名中），跳过');
      setStatus('桥接处理中，暂不下载', 'running');
      result.reason = 'bridge-busy';
      return result;
    }

    downloadRunning = true;
    log('===== 开始批量自动下载 =====');

    try {
      setStatus('等待下载助手...', 'running');
      const ready = await waitForApiReady();
      if (!ready) {
        warn('下载助手未就绪');
        setStatus('未就绪', 'error');
        result.reason = 'api-not-ready';
        return result;
      }

      await until(() => scanFileRows().length > 0, 200, 5000);

      const files = scanFileRows();
      const fileByFid = new Map(files.filter(f => f.fid).map(f => [f.fid, f]));
      const targetFidsSet = Array.isArray(targetFids) && targetFids.length ? new Set(targetFids) : null;

      const pending = files.filter(f => {
        if (!f.fid) return false;
        if (targetFidsSet) return targetFidsSet.has(f.fid) && !isFidDownloaded(f.fid);
        return !isFidDownloaded(f.fid);
      });

      result.pendingAtStart = pending.length;
      log(`批量下载：共 ${files.length} 个文件，待下载 ${pending.length} 个${targetFidsSet ? `（targetFids=${targetFidsSet.size}，其中可见 ${pending.length}）` : ''}`);

      if (!pending.length) {
        log('  无待下载文件');
        setStatus('无待下载', 'done');
        setProgress('-');
        result.ok = true;
        result.reason = 'no-pending';
        if (targetFidsSet) {
          result.pendingAfter = targetFids.filter(fid => !isFidDownloaded(fid)).length;
        }
        return result;
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
        result.reason = 'select-failed';
        return result;
      }

      await waitWhilePaused();
      setStatus('获取链接中...', 'running');
      await triggerApiDownload();

      const links = await collectApiLinks(15000);
      result.totalLinks = links ? links.length : 0;
      if (!links || !links.length) {
        const err = document.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning');
        if (err) {
          const cb = document.querySelector('.swal2-close');
          if (cb && isVisible(cb)) realClick(cb);
          result.reason = 'api-dialog-error';
          return result;
        }
        result.reason = 'no-links';
        return result;
      }
      log(`★ 获取到 ${links.length} 个下载链接`);

      let done = 0;
      for (let i = 0; i < links.length; i++) {
        await waitWhilePaused();
        const l = links[i];

        if (l.fid && isFidDownloaded(l.fid)) {
          log(`  [${i + 1}/${links.length}] 跳过（已下载）: ${l.filename}`);
          result.skippedFids.push(l.fid);
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
            const src = fileByFid.get(l.fid);
            markFidDownloaded(l.fid, {
              name: l.filename,
              link: l.link,
              sizeStr: src ? src.sizeStr : '',
              iconSig: src ? src.iconSig : '',
              mtime: src ? src.mtime : '',
            });
            result.downloadedFids.push(l.fid);
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

      if (targetFidsSet) {
        result.pendingAfter = targetFids.filter(fid => !isFidDownloaded(fid)).length;
      }

      log(`===== 批量下载完成（${done}/${links.length}）=====`);
      setStatus('下载完成', 'done');
      setProgress('-');
      result.ok = true;
      result.reason = 'success';
      return result;
    } catch (e) {
      warn('批量下载出错:', e.message);
      setStatus('出错: ' + e.message, 'error');
      result.reason = 'error: ' + (e && e.message || e);
      const cb = document.querySelector('.swal2-close');
      if (cb && isVisible(cb)) realClick(cb);
      return result;
    } finally {
      downloadRunning = false;
    }
  }

 /* ===== 列表加载状态 ===== */
  function isLoadingAnimPresent() {
    return !!(
      document.querySelector('.table-loading-wrap') ||
      document.querySelector('.ant-table-spin-holder.ant-spin-spinning') ||
      document.querySelector('.ant-spin-nested-loading .ant-spin-spinning') ||
      document.querySelector('.ant-spin-container.ant-spin-blur')
    );
  }

  function isEmptyUiVisible() {
    if (isLoadingAnimPresent()) return false;
    const wrap = document.querySelector('.ant-table-placeholder .table-empty-wrap')
    || document.querySelector('.table-empty-wrap');
    if (!wrap) return false;
    let op = '';
    try { op = getComputedStyle(wrap).opacity; } catch {}
    if (op === '' || op == null) op = (wrap.style && wrap.style.opacity) || '';
    if (op === '') return false;
    const n = Number(op);
    if (!Number.isFinite(n)) return false;
    return n > 0.01;
  }

  function isListLoaded() { return !isLoadingAnimPresent(); }

  function isTableVirtual() {
    const body = document.querySelector('.ant-table-wrapper .ant-table-body');
    if (!body) return false;
    const inner = body.firstElementChild;
    if (!inner) return false;
    const innerH = inner.getBoundingClientRect().height
    || parseFloat(getComputedStyle(inner).height) || 0;
    if (!innerH) return true;
    return innerH > body.clientHeight + 50;
  }

  /* 是否"完全渲染"。为保守起见，没有 .ant-table-body 时不再假定为 true，
   * 因为夸克列表页在初始渲染阶段可能暂时不生成 .ant-table-body。
   * 上层建议优先使用 getListFileCountHint() + waitListStableEx() 做判据。 */
  function isWholeListRendered() {
    const body = document.querySelector('.ant-table-wrapper .ant-table-body');
    if (!body) {
      /* 无 body 时依赖"是否有共 N 个提示且行数已达到"来判定；否则保守 false */
      const hint = getListFileCountHint();
      if (!hint) return false;
      const cnt = scanFileRows().length;
      return cnt >= hint;
    }
    if (body.scrollHeight > body.clientHeight + 50) return false;
    return !isTableVirtual();
  }

  /* 等待列表稳定：行数连续 minWaitMs 不变，且（有 expected 时）行数 >= expected。
   * 返回 { stable, count, emptyUi }。 */
  async function waitListStableEx(doc = document, opts = {}) {
    const minWaitMs = Number(opts.minWaitMs) >= 0 ? Number(opts.minWaitMs) : 2000;
    const maxWaitMs = Number(opts.maxWaitMs) > 0 ? Number(opts.maxWaitMs) : 10000;
    const expected = opts.expected !== undefined ? opts.expected : getListFileCountHint();
    const t0 = Date.now();
    let lastCount = -1;
    let stableStart = 0;
    let lastWarn = 0;

    while (Date.now() - t0 < maxWaitMs) {
      const loading = isLoadingAnimPresent();
      const rows = loading ? [] : scanFileRows(doc);
      const cnt = rows.length;
      const emptyUi = loading ? false : isEmptyUiVisible();

      if (!loading && (cnt > 0 || emptyUi) && cnt === lastCount) {
        if (!stableStart) stableStart = Date.now();
        const waited = Date.now() - stableStart;
        if (waited >= minWaitMs) {
          if (!expected || cnt >= expected) {
            return { stable: true, count: cnt, emptyUi };
          }
          if (Date.now() - lastWarn > 2000) {
            lastWarn = Date.now();
            log(`  列表稳定但行数 ${cnt} < 期望 ${expected}，继续等…`);
          }
        }
      } else {
        stableStart = 0;
      }
      lastCount = cnt;
      await sleep(300);
    }
    return { stable: false, count: lastCount };
  }

  async function purgeMissingRecords(opts = {}) {
    const manual = opts.manual === true;
    if (!isListPage()) return 0;

    if (!isListLoaded()) { log('对比清理：列表尚未加载完，跳过（避免误删）'); return 0; }

    /* 稳定性校验：连续 minWaitMs 行数不变 */
    const stab = await waitListStableEx(document, {
      minWaitMs: manual ? 800 : 2000,
      maxWaitMs: 8000,
    });
    if (!stab.stable) {
      log('对比清理：列表未稳定，跳过本次（避免误删记录）');
      return 0;
    }

    const files = scanFileRows();
    const pageFids = new Set(files.map(f => f.fid).filter(Boolean));
    const emptyUi = !pageFids.size && isEmptyUiVisible();
    const hint = getListFileCountHint();
    const incompleteRender = !!(hint && files.length < hint);

    if (!pageFids.size && !emptyUi) {
      log('对比清理：本页无可用 fid，且不是"没有文件"空态，跳过');
      return 0;
    }

    const scope = currentListScope();
    if (!scope) { log('对比清理：无法识别当前目录，跳过'); return 0; }

    const recs = loadDlRecords();
    const stale = [];
    for (const fid of Object.keys(recs)) {
      const r = recs[fid];
      const s = (r && typeof r === 'object') ? String(r.scope || '') : '';
      if (!s) continue;
      if (s !== scope) continue;
      if (!pageFids.has(fid)) stale.push(fid);
    }
    if (!stale.length) { log('对比清理：无失效记录'); return 0; }

    if (manual) {
      const notWhole = !emptyUi && !isWholeListRendered();
      const ok = confirm(
        `将清理目录「${scope}」中 ${stale.length} 条“文件已不存在”的下载记录` +
        (emptyUi ? '（当前目录为空）' : '') + `。\n` +
        (notWhole || incompleteRender
         ? '⚠️ 当前列表可能未完全渲染；未被渲染的行也会被算作“不存在”。\n'
         : '') +
        `（其它目录的记录不受影响）\n\n继续？`
      );
      if (!ok) return 0;
    } else if (!emptyUi) {
      /* 自动模式：多重保护 */
      if (incompleteRender) {
        log(`对比清理：本页 ${files.length} 行 < 提示总数 ${hint}，跳过（列表未渲染完）`);
        return 0;
      }
      if (!isWholeListRendered()) {
        log(`对比清理：列表仍可滚动或为虚拟滚动（DOM 仅 ${files.length} 行），跳过`);
        return 0;
      }
      if (stale.length > Math.max(20, files.length)) {
        log(`对比清理：自动清理疑似误删（待删 ${stale.length} > 本页 ${files.length}），跳过`);
        return 0;
      }
    }

    const n = clearDlRecordsFids(stale);
    log(`★ 对比清理：移除 ${n} 条失效记录（目录 ${scope}，` +
        (emptyUi ? '空目录' : `本页 ${pageFids.size} 个文件`) + '）');
    return n;
  }

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

 /* 删除指定 fid 的行。失败时重试（默认最多 3 次，间隔 2s），
   * 每次只处理当前 DOM 里能匹配的行；成功的 fid 从剩余集合中移除。
   * 返回值：{ count, fids } — count 为成功删除的数量，fids 为成功删除的 fid 列表。 */
  async function deleteRowsByFids(fids, opts = {}) {
    if (!fids || !fids.length) return { count: 0, fids: [] };
    const maxAttempts = Number(opts.maxAttempts) > 0 ? Number(opts.maxAttempts) : 3;
    const retryDelay = Number(opts.retryDelay) >= 0 ? Number(opts.retryDelay) : 2000;

    const remaining = new Set(fids);
    const deletedFidsOut = [];
    let totalPicked = 0;
    let lastResult = '';

    for (let attempt = 1; attempt <= maxAttempts && remaining.size > 0; attempt++) {
      if (attempt > 1) {
        log(`  删除重试 ${attempt}/${maxAttempts}：剩余 ${remaining.size} 个，等 ${retryDelay}ms…`);
        await sleep(retryDelay);
        await until(() => !isLoadingAnimPresent(), 200, 5000);
      }

      await clearAllSelection();
      await sleep(150);

      const rows = document.querySelectorAll('tr.ant-table-row[data-row-key]');
      const pickedFids = new Set();
      for (const row of rows) {
        const fid = row.getAttribute('data-row-key');
        if (!fid || !remaining.has(fid)) continue;
        const lbl = row.querySelector('label.ant-checkbox-wrapper');
        if (!lbl) continue;
        const input = row.querySelector('input.ant-checkbox-input');
        if (!input || !input.checked) {
          realClick(lbl);
          const ok = await until(() => {
            const i = row.querySelector('input.ant-checkbox-input');
            return i && i.checked;
          }, 80, 1200);
          if (!ok) { try { realClick(lbl); await sleep(200); } catch {} }
        }
        const recheck = row.querySelector('input.ant-checkbox-input');
        if (recheck && recheck.checked) pickedFids.add(fid);
      }

      if (!pickedFids.size) {
        log(`  第 ${attempt} 次：目标 fid 在当前页未匹配到可勾选行（剩余 ${remaining.size}，可能是虚拟滚动/页面未加载完）`);
        lastResult = 'no-match';
        continue;
      }

      if (!await clickDeleteButton(8000)) {
        warn(`  第 ${attempt} 次：未找到顶栏删除按钮`);
        lastResult = 'no-delete-btn';
        continue;
      }
      if (!await confirmDeleteDialog(8000)) {
        warn(`  第 ${attempt} 次：未找到删除确认按钮`);
        lastResult = 'no-confirm-btn';
        await until(() => !document.querySelector('.base-confirm-modal'), 100, 800);
        continue;
      }

      const r = await waitDeleteResult(10000);
      log(`  第 ${attempt} 次删除结果：${r}（勾选 ${pickedFids.size} 个）`);
      lastResult = r;

      await until(() => !document.querySelector('.base-confirm-modal'), 100, 800);

      if (r === 'success') {
        for (const fid of pickedFids) {
          remaining.delete(fid);
          deletedFidsOut.push(fid);
        }
        totalPicked += pickedFids.size;
        await sleep(500);
      }
    }

    if (remaining.size > 0) {
      warn(`  删除未完成：${remaining.size}/${fids.length} 个文件未删除（最后结果：${lastResult}）`);
    }
    return { count: totalPicked, fids: deletedFidsOut };
  }

 /* 过期清理：只有"确实删除了文件"或"列表完全渲染时确认文件已不存在"才清除记录。
   * 文件在当前页但删除失败、文件不在当前页且列表非完全渲染（虚拟滚动/别的目录）→ 保留记录，等下次处理。
   * 避免"记录删了、文件还在"导致下次看起来像全部未转存。
   *
   * 稳定性校验：先 waitListStableEx 等列表稳定（连续 minWaitMs 行数不变，且满足 expected）；
   * 删除后再重扫一次，用最新 DOM 判断剩余行，避免快照误判。 */
  async function purgeExpiredRecordsWithFiles() {
    if (!isListPage()) return { records: 0, files: 0 };
    if (!isListLoaded()) {
      log('过期清理：列表尚未加载完，跳过');
      return { records: 0, files: 0 };
    }

    /* 稳定性校验 */
    const stab = await waitListStableEx(document, { minWaitMs: 2000, maxWaitMs: 8000 });
    if (!stab.stable) {
      log('过期清理：列表未稳定，跳过本次清理（避免误删）');
      return { records: 0, files: 0 };
    }

    const expiredFids = pickExpiredFids();
    if (!expiredFids.length) return { records: 0, files: 0 };

    const files = scanFileRows();
    const fidSet = new Set(expiredFids);
    const toDelete = files.filter(f => f.fid && fidSet.has(f.fid));

    let deletedFiles = 0;
    const deletedFids = [];
    if (toDelete.length) {
      log(`★ 过期清理：当前目录命中 ${toDelete.length} 个过期文件，开始删除…`);
      try {
        const pickedFids = toDelete.map(f => f.fid);
        const delRes = await deleteRowsByFids(pickedFids, { maxAttempts: 3, retryDelay: 2000 });
        deletedFiles = delRes.count || 0;
        deletedFids.push(...(delRes.fids || []));
        await sleep(500);
      } catch (e) {
        warn('过期清理：删除文件失败', e);
      }
    } else {
      log('过期清理：当前目录未命中过期文件，检查是否有文件已不存在');
    }

    /* 删除后重扫，用最新 DOM 判断剩余 */
    await until(() => !isLoadingAnimPresent(), 200, 5000);
    const filesAfterDelete = scanFileRows();
    const pageFids = new Set(filesAfterDelete.map(f => f.fid).filter(Boolean));
    const wholeRendered = isWholeListRendered();
    const emptyUi = isEmptyUiVisible();
    const hint = getListFileCountHint();
    const incompleteRender = !!(hint && filesAfterDelete.length < hint);
    const curScope = currentListScope();
    const recs = loadDlRecords();

    const missingFids = []; // 文件已不存在，记录可删
    const keptFids = []; // 保留记录（虚拟滚动/别的目录/删除失败/渲染不完整）

    for (const fid of expiredFids) {
      if (deletedFids.includes(fid)) continue;

      const rec = recs[fid];
      if (!rec) continue;

      const recScope = String(rec.scope || '');
      if (recScope && recScope !== curScope) {
        /* 别的目录，当前页无法判断文件是否存在 */
        keptFids.push(fid);
        continue;
      }

      if (pageFids.has(fid)) {
        /* 当前页可见但删除失败 → 保留 */
        keptFids.push(fid);
        continue;
      }

      /* 当前页不可见 */
      if (incompleteRender) {
        /* 页面提示总数比 DOM 多 → 有行还没渲染，不能判定"不存在" */
        keptFids.push(fid);
        continue;
      }

      if (wholeRendered || emptyUi) {
        /* 列表完全渲染或空态 → 文件确实不存在 */
        missingFids.push(fid);
      } else {
        /* 虚拟滚动/部分渲染 → 不确定，保留 */
        keptFids.push(fid);
      }
    }

    const allToClear = [...deletedFids, ...missingFids];
    const deletedRecords = clearDlRecordsFids(allToClear);
    log(`★ 过期清理完成：删除文件 ${deletedFiles} 个，移除记录 ${deletedRecords} 条`
        + `（其中文件已不存在 ${missingFids.length} 条，保留 ${keptFids.length} 条待下次处理${keptFids.length ? '：' + keptFids.join(', ') : ''}）`);
    refreshGray();
    return { records: deletedRecords, files: deletedFiles };
  }

  async function waitListReadyForCleanup(timeout, tag, minWaitMs = 3000) {
    const t0 = Date.now();
    let lastLog = 0;
    let firstReadyTs = 0;

    while (Date.now() - t0 < timeout) {
      const wrapper = document.querySelector('.ant-table-wrapper');
      const loading = isLoadingAnimPresent();
      let rows = [];
      try { rows = scanFileRows(); } catch {}
      const emptyUi = isEmptyUiVisible();
      const ready = !!wrapper && !loading && (rows.length > 0 || emptyUi);

      if (ready) {
        if (firstReadyTs === 0) firstReadyTs = Date.now();
        const waited = Date.now() - firstReadyTs;
        if (waited >= minWaitMs) {
          warn(`★ ${tag}：列表就绪（wrapper=有, loading=否, rows=${rows.length}, emptyUi=${emptyUi}，就绪后再等 ${waited}ms）`);
          return { ready: true, rows: rows.length, emptyUi, ms: Date.now() - t0 };
        }
      } else {
        firstReadyTs = 0;
      }

      if (Date.now() - lastLog > 3000) {
        lastLog = Date.now();
        log(`… ${tag} 等待列表就绪（wrapper=${wrapper ? '有' : '无'}, loading=${loading}, rows=${rows.length}, emptyUi=${emptyUi}，已等 ${Math.round((Date.now() - t0) / 1000)}s）`);
      }
      await sleep(300);
    }
    warn(`★ ${tag}：等待列表就绪超时（${timeout}ms）`);
    return { ready: false, ms: Date.now() - t0 };
  }

  let _preflightPromise = null;
  let _preflightLastDoneTs = 0;

  async function runPreflightCleanup(opts = {}) {
    const tag = opts.tag || 'preflight';
    const listWaitMs = Number(opts.listWaitMs) > 0 ? Number(opts.listWaitMs) : 30000;
    const minWaitMs = Number(opts.minWaitMs) > 0 ? Number(opts.minWaitMs) : 3000;
    const minInterval = Number(opts.minInterval) >= 0 ? Number(opts.minInterval) : 0;
    const force = opts.force === true;

    if (!force && minInterval > 0 && _preflightLastDoneTs > 0 &&
        Date.now() - _preflightLastDoneTs < minInterval) {
      warn(`★ ${tag}：${Math.round((Date.now() - _preflightLastDoneTs) / 1000)}s 前刚清理过，跳过`);
      return { ok: true, skipped: true, reason: 'recently-done', didRun: false, sinceMs: Date.now() - _preflightLastDoneTs, tag };
    }

    if (_preflightPromise) {
      warn(`★ ${tag}：已有清理在执行，等待其完成`);
      return _preflightPromise;
    }

    const t0 = Date.now();
    _preflightPromise = (async () => {
      if (!isListPage()) {
        warn(`★ ${tag}：非个人页，跳过清理`);
        return { ok: false, skipped: true, reason: 'not-list-page', didRun: false, tag };
      }
      if (isPaused()) {
        warn(`★ ${tag}：夸克助手暂停中，跳过清理`);
        return { ok: false, skipped: true, reason: 'paused', didRun: false, tag };
      }

      warn(`★ ${tag}：开始（force=${force}, listWaitMs=${listWaitMs}, minWaitMs=${minWaitMs}）`);
      const lr = await waitListReadyForCleanup(listWaitMs, tag, minWaitMs);
      if (!lr.ready) {
        warn(`★ ${tag}：列表未就绪，跳过清理（避免空跑）`);
        return { ok: false, skipped: true, reason: 'list-not-ready', didRun: false, tag };
      }

      let missing = 0;
      let expired = { records: 0, files: 0 };
      let hadError = false;

      try { missing = await purgeMissingRecords({ manual: false }); }
      catch (e) { hadError = true; warn(`★ ${tag}：purgeMissingRecords 失败`, e); }

      try { expired = await purgeExpiredRecordsWithFiles(); }
      catch (e) { hadError = true; warn(`★ ${tag}：purgeExpiredRecordsWithFiles 失败`, e); }

      if (!hadError) _preflightLastDoneTs = Date.now();
      const ms = Date.now() - t0;
      warn(`★ ${tag}：清理${hadError ? '结束（有异常）' : '完成'}（失效记录=${missing}, 过期文件=${expired.files}, 过期记录=${expired.records}, 耗时=${ms}ms）`);
      return { ok: true, skipped: false, didRun: true, missing, expired, ms, ts: _preflightLastDoneTs, tag };
    })().finally(() => { _preflightPromise = null; });

    return _preflightPromise;
  }

  async function tryAutoDownloadOnBoot() {
    if (downloadRunning) { log('★ 自动流程：已有任务，跳过'); return; }
    if (isPaused()) { log('★ 自动流程：当前处于暂停状态，跳过'); return; }
    if (isBridgeBusy()) { log('★ 自动流程：桥接脚本转存中，跳过'); return; }

    try {
      const pr = await runPreflightCleanup({ tag: 'boot', minInterval: 30000 });
      warn(`★ boot 预清理返回：${JSON.stringify(pr)}`);
    } catch (e) {
      warn('★ boot 预清理异常（不影响下载）', e);
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

  function markSelectedAsDownloaded() {
    if (!isListPage()) { alert('当前不是列表页'); return 0; }

    const files = scanFileRows();
    const picked = files.filter(f => f.checked && f.fid);

    if (!picked.length) {
      alert('未勾选任何文件（或勾选的文件无有效 fid）');
      return 0;
    }

    for (const f of picked) {
      markFidDownloaded(
        f.fid,
        { name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig, mtime: f.mtime },
        { keepTs: true } /* 手动标记：保留已有 ts */
      );
    }

    log(`★ 标记选中为已下载：${picked.length} 个（keepTs=true）`);
    refreshGray();
    alert(`已标记 ${picked.length} 个文件为已下载`);
    return picked.length;
  }

  function clearDlRecordsFlow() {
    if (!isListPage()) { alert('当前不是列表页'); return; }
    const files = scanFileRows();
    const dl = loadDlRecords();

    const checked = files.filter(f => f.checked && f.fid);
    if (checked.length) {
      const hitIds = checked.filter(f => dl[f.fid]).map(f => f.fid);
      if (!hitIds.length) { alert(`勾选 ${checked.length} 个文件，但均无下载记录`); return; }
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
      title: '把当前勾选的文件标记为已下载（不覆盖已有时间戳，仅补全缺失字段）',
      onclick: () => markSelectedAsDownloaded(),
    });
    addBuiltinAction({
      label: '🔍 清理失效记录',
      color: '#d46b08',
      title: '只清理「当前目录」中"记录存在但文件已不存在"的记录（需列表加载完；其它目录不受影响）',
      onclick: async () => {
        const n = await purgeMissingRecords({ manual: true });
        refreshGray();
        alert(n > 0
              ? `已清理 ${n} 条失效记录`
              : '没有可清理的记录（若列表仍在加载或未渲染完，本次已跳过以避免误删）');
      },
    });
    addBuiltinAction({
      label: '🗑️ 清除下载记录',
      color: '#8c2f1f',
      title: '清除本页/全部下载记录（只删记录，不删文件）',
      onclick: () => clearDlRecordsFlow(),
    });
  }

  unsafeWindow.quarkAssistant = {
    version: '5.7.7',
    isReady: () => true,
    isListPage, isSharePage,

    mountPanel, setStatus, setProgress, setActions,
    addBuiltinAction, clearBuiltinActions,
    refreshGray, setProgressLabel, showProgress, hideProgress,

    isVisible, realClick, sleep, until,
    scanFileRows, getFileIconSig,
    isFidDownloaded, isDownloading: () => downloadRunning,

    isPaused, setPaused, waitWhilePaused, isBridgeBusy,
    isListLoaded,

    autoDownloadWorkflow,
    clearAllSelection,

    runPreflightCleanup,
    purgeMissingRecords,
    purgeExpiredRecordsWithFiles,
  };

  (async function boot() {
    if (!document.body) await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));

    if (isListPage()) {
      document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest && e.target.closest('.listener-link-api');
        if (!a) return;
        const original = a.dataset.link || '';
        const fixed = fixFilenamePlusInUrl(original);
        if (fixed !== original) {
          try { a.dataset.link = fixed; } catch {}
          try { a.setAttribute('data-link', fixed); } catch {}
          if (a.getAttribute('href') === original) {
            try { a.setAttribute('href', fixed); } catch {}
          }
        }
      }, true);
      mountPanel();
      setProgressLabel('已下载');
      installListPageActions();
      setStatus(isPaused() ? '已暂停' : '待机（个人页）', isPaused() ? 'running' : '');
      log(`平台层就绪（个人页${isPaused() ? '，暂停中' : ''}）v5.7.7`);
      setTimeout(() => { tryAutoDownloadOnBoot(); }, 3000);
    } else if (isSharePage()) {
      log('平台层就绪（分享页，等待桥接 mountPanel）v5.7.7');
    } else {
      log('平台层就绪（其他页）v5.7.7');
    }

    startGrayPolling();
  })();
})();