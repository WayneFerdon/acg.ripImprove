// ==UserScript==
// @name         QuarkAutoAssistant
// @namespace    quark-auto-save
// @version      6.2.1
// @description  夸克网盘平台层：个人页清理（等列表就绪 → 删过期文件 → 逐条复核后清记录）→ unsafeWindow 挂起门 → 恢复后自动下载 → acg 唤起时走完下载即关页（不等 FDM）；FDM 完成后的云端删除走后台异步轮询。含 FDM 本地桥（127.0.0.1:8732）、UI、DOM 工具、暂停控制（转存逻辑交给桥接脚本）
// @match        https://pan.quark.cn/*
// @downloadURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/quarkAutoAssistant.user.js
// @updateURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/quarkAutoAssistant.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const PREFIX = '[夸克助手]';
  const GM_DL_RECORDS = 'quark_auto_dl_records';
  const DL_TTL = 24 * 60 * 60 * 1000;   /* 只用于保留期（删过期文件+清记录），不参与"是否已下载"判断 */
  const THROTTLE = 5000;
  const BUSY_KEY = 'acgrip_bridge_busy';
  const PAUSE_KEY = 'quark_auto_pause_state';
  /* 跨脚本（同标签页）通信：只放 sessionStorage，不落盘 */
  const ACG_FLAG_KEY = 'acgrip_acg_invoked';
  const GATE_KEY = '__acgripQuarkGate';
  const _1s = 1000;

  /* 流程参数 */
  const LIST_WAIT_MS = 45000;      // 等列表就绪
  const SCAN_MS = 25000;           // 全量滚动扫描
  const NOT_ACG_GRACE_MS = 5000;   // 非 acg 唤起时，留给桥接自报身份的时间
  const CLOSE_DELAY_MS = 5000;     // 下载触发后关页延时

  /* FDM（AutoCleanOrMoveFDMCache.pyw）本地桥：拿到"下载已完成"的信号后删云端文件 */
  const FDM_BRIDGE = 'http://127.0.0.1:8732';
  const FDM_POLL_MS = 60000;        // 后台轮询间隔（FDM 完成 → 删云端，异步）
  /* FDM 已完成、但本地没有对应下载记录、列表里也确实没有的项：
   * 不立刻 ack（怕误删），先记账，满 7 天且列表确认干净后才 ack 掉，避免永远挂着。 */
  const GM_FDM_UNMATCHED = 'quark_fdm_unmatched';
  const FDM_UNMATCHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  const log = (...a) => console.log(PREFIX, ...a);
  const warn = (...a) => console.warn(PREFIX, ...a);

  /* ================= Blob Worker 定时器（后台标签页安全） ================= */
  let _timerWorkerFn = null;
  function _getTimerWorker() {
    if (_timerWorkerFn) return _timerWorkerFn;
    try {
      const code = `
        let timerMap = {};
        self.onmessage = (e) => {
          const { id, ms } = e.data;
          timerMap[id] = setTimeout(() => {
            self.postMessage({ id });
            delete timerMap[id];
          }, ms);
        };
      `;
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);
      const callbacks = new Map();
      let idCounter = 0;
      worker.onmessage = (e) => {
        const { id } = e.data;
        const resolve = callbacks.get(id);
        if (!resolve) return;
        resolve();
        callbacks.delete(id);
      };
      _timerWorkerFn = (ms) => new Promise((resolve) => {
        const id = idCounter++;
        callbacks.set(id, resolve);
        worker.postMessage({ id, ms });
      });
      return _timerWorkerFn;
    } catch {
      _timerWorkerFn = (ms) => new Promise((r) => setTimeout(r, ms));
      return _timerWorkerFn;
    }
  }

  async function sleep(ms, isForBattle) {
    if (!ms || ms <= 0) return;
    if (!isForBattle || ms >= _1s) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    ms = Math.max(ms, 50);
    return _getTimerWorker()(ms);
  }

  async function until(condition, delay, maxWaitMs, opts = {}) {
    const pollMs = delay === 0 ? 0 : Math.max(50, delay ?? 50);
    const waitMs = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 0;
    const throwOnTimeout = opts.throwOnTimeout === true;
    const t0 = Date.now();
    for (;;) {
      const result = await condition();
      if (result) return result;
      if (waitMs > 0 && Date.now() - t0 >= waitMs) {
        if (throwOnTimeout) throw new Error(`until 超时：${waitMs}ms`);
        return null;
      }
      await sleep(pollMs, true);
    }
  }

  async function untilStrict(condition, delay, maxWaitMs) {
    return await until(condition, delay, maxWaitMs, { throwOnTimeout: true });
  }

  async function untilOrGiveUp(condition, delay, maxWaitMs) {
    try {
      return { ok: true, result: await until(condition, delay, maxWaitMs, { throwOnTimeout: true }) };
    } catch {
      return { ok: false, result: null };
    }
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
    while (isPaused()) await sleep(400, true);
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

  /* 文件夹行：class 含 folder，或图标 use 指向 #qkdrive-folder */
  function isFolderRow(row) {
    try {
      if (row.querySelector('[class*="folder" i],[class*="Folder"]')) return true;
      for (const u of row.querySelectorAll('use')) {
        const href = u.getAttribute('xlink:href') || u.getAttribute('href') || '';
        if (/folder/i.test(href)) return true;
      }
    } catch {}
    return false;
  }

  function scanFileRows(doc = document) {
    const out = [];
    const seen = new Set();
    const rows = doc.querySelectorAll('tr.ant-table-row[data-row-key], tr.ant-table-row');
    for (const row of rows) {
      if (isFolderRow(row)) continue;
      const nameEl = row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
      /* 行内重命名时 .filename-text 会被替换成 <input class="ant-input input-edit">，
       * 此时用 input 的值当名字，保证这一行不会从列表里"消失"（否则它的记录会被误清） */
      const inputEl = row.querySelector('input.input-edit, .filename input.ant-input');
      const name = String(
        (nameEl && (nameEl.getAttribute('title') || nameEl.textContent)) ||
        (inputEl && inputEl.value) || ''
      ).trim();
      const fid = row.getAttribute('data-row-key') || '';
      const key = fid || name;
      if (!name || seen.has(key)) continue;
      let sizeStr = '';
      const tds = row.querySelectorAll('td');
      if (tds.length >= 3) sizeStr = (tds[2].textContent || '').trim();
      const cb = row.querySelector('input.ant-checkbox-input, input[type="checkbox"]');
      const checked = !!(cb && cb.checked) || row.classList.contains('ant-table-row-selected');
      out.push({
        name, sizeStr, fid,
        mtime: getRowMtimeStr(row),
        iconSig: getFileIconSig(row),
        row, checked,
      });
      seen.add(key);
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

  /* 读取页面"共 N 个/条/项"提示。已补充分页总数等常见选择器。 */
  function getListFileCountHint() {
    try {
      const sels = [
        '.info-stat span',
        '.list-info-stat span',
        '.share-info .info-stat span',
        '.ant-pagination-total-text',
        '.ant-table-title',
        '.list-header .info span',
        '.file-list .list-header span',
      ];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent || '').trim();
          const m = t.match(/共\s*(\d+)\s*[个条项]/) || t.match(/^(\d+)\s*[个条项]/);
          if (m) return Number(m[1]);
        }
      }
    } catch {}
    return null;
  }

  function loadDlRecords() { return gmGet(GM_DL_RECORDS, {}) || {}; }
  function saveDlRecords(recs) { gmSet(GM_DL_RECORDS, recs); }

  function recordTs(r) { return typeof r === 'number' ? r : (r && r.ts || 0); }

  /* 下载记录 = "已下载"，与时间无关：
   * 记录超过 24h 时文件其实还在（随后由 runCleanupRound 删掉），
   * 如果这里按 TTL 判成"未下载"，就会出现"不置灰 + 重新下载一个马上要被删的文件"。 */
  function isFidDownloaded(fid, recs) {
    if (!fid) return false;
    const m = recs || loadDlRecords();
    return !!m[fid];
  }

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
    log(`★ 标记已下载 fid=${String(fid).slice(0, 8)} "${next.name || ''}" sizeStr="${next.sizeStr || '-'}" keepTs=${keepTs}`);
  }

  /* 改名后同步记录里的显示名（按 fid）；桥接脚本跨脚本写 GM 无效，必须走这里 */
  function renameDlRecordNames(pairs) {
    if (!Array.isArray(pairs) || !pairs.length) return 0;
    const recs = loadDlRecords();
    let n = 0;
    for (const p of pairs) {
      if (!p || !p.fid || !p.next) continue;
      const rec = recs[p.fid];
      if (!rec || typeof rec !== 'object') continue;
      recs[p.fid] = { ...rec, name: p.next };
      n++;
    }
    if (n) saveDlRecords(recs);
    return n;
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


 /* ===== 个人页置灰 + 进度 ===== */
  let _progressLabel = '已处理';
  function setProgressLabel(label) { _progressLabel = label || '已处理'; }

  function refreshGray(doc = document) {
    if (!isListPage()) return { grayed: 0, total: 0 };
    const files = scanFileRows(doc);
    const recs = loadDlRecords();   /* 一次读取，避免每行一次 GM 调用（长列表会很卡） */
    let grayed = 0;
    for (const f of files) {
      if (isFidDownloaded(f.fid, recs)) { f.row.classList.add('qap-grayed'); grayed++; }
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

  function fixFilenamePlusInUrl(url) {
    if (!url) return url;
    try {
      return String(url).replace(/([?&]filename=)([^&#]*)/gi, (m, prefix, value) => {
        return prefix + value.replace(/\+/g, '%20');
      });
    } catch { return url; }
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
    const g = await untilOrGiveUp(
      () => document.querySelector('.pl-button-mode[data-mode="api"]'),
      100, 3000
    );
    if (!g.ok) throw new Error('找不到 API 下载菜单项');
    const itemEl = g.result;
    const $ = win.jQuery || win.$;
    const popupShown = () => !!document.querySelector('.swal2-popup');
    if ($) {
      try { $(itemEl).trigger('click'); } catch {}
      const p = await untilOrGiveUp(popupShown, 100, 800);
      if (p.ok) return;
    }
    if (popupShown()) return;
    if (itemEl.isConnected) {
      realClick(itemEl);
      const p = await untilOrGiveUp(popupShown, 100, 800);
      if (p.ok) return;
    }
    if (popupShown()) return;
    if (itemEl.isConnected) {
      try { itemEl.click(); } catch {}
    }
  }

  async function handleApiDialog() {
    const g = await untilOrGiveUp(() => document.querySelector('.swal2-popup'), 250, 5000);
    if (!g.ok) throw new Error('未弹出 API 下载对话框');
    const popup = g.result;
    const link = await until(() => {
      const el = document.querySelector('.listener-link-api');
      if (el) return el;
      const err = document.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning');
      if (err) throw new Error('弹窗返回错误');
      return null;
    }, 250, 8000, { throwOnTimeout: true });
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
    const g = await untilOrGiveUp(() => {
      const p = document.querySelector('.swal2-popup');
      if (!p) return null;
      if (p.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning')) return p;
      if (p.querySelector('.listener-link-api')) return p;
      return null;
    }, 200, timeout);
    if (!g.ok) return null;
    const popup = g.result;
    if (popup.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning')) return null;
    const links = [...popup.querySelectorAll('.listener-link-api')];
    return links.map(a => {
      const original = a.dataset.link || '';
      const fixed = fixFilenamePlusInUrl(original);
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
        filename: a.dataset.filename || '',
        link: fixed,
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

  async function autoDownloadWorkflow(opts = {}) {
    const { throttle = THROTTLE, waitForBusy = false, targetFids = null, ignoreBusy = false } = opts;
    const result = {
      ok: false, reason: 'unknown',
      downloadedFids: [], skippedFids: [],
      totalLinks: 0, pendingAtStart: 0, pendingAfter: 0,
    };
    if (downloadRunning) {
      if (!waitForBusy) {
        warn('★ 自动下载：已有任务在跑，跳过');
        result.reason = 'busy';
        return result;
      }
      const g = await untilOrGiveUp(() => !downloadRunning, 500, 180000);
      if (!g.ok) {
        warn('★ 自动下载：等待超时，仍被占用');
        result.reason = 'busy-timeout';
        return result;
      }
    }
    if (!isListPage()) { result.reason = 'not-list-page'; return result; }
    if (isPaused()) {
      log('★ 自动下载：暂停中，跳过');
      setStatus('已暂停', 'running');
      result.reason = 'paused';
      return result;
    }
    if (!ignoreBusy && isBridgeBusy()) {
      warn('★ 自动下载：桥接忙碌，跳过');
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
      const dlRecs = loadDlRecords();
      const pending = files.filter(f => {
        if (!f.fid) return false;
        if (targetFidsSet) return targetFidsSet.has(f.fid) && !isFidDownloaded(f.fid, dlRecs);
        return !isFidDownloaded(f.fid, dlRecs);
      });
      result.pendingAtStart = pending.length;
      log(`批量下载：共 ${files.length} 个文件，待下载 ${pending.length} 个`);
      if (!pending.length) {
        log('  无待下载文件');
        setStatus('无待下载', 'done');
        setProgress('-');
        result.ok = true;
        result.reason = 'no-pending';
        if (targetFidsSet) result.pendingAfter = targetFids.filter(fid => !isFidDownloaded(fid)).length;
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
              name: l.filename, link: l.link,
              sizeStr: src ? src.sizeStr : '',
              iconSig: src ? src.iconSig : '',
              mtime: src ? src.mtime : '',
            });
            result.downloadedFids.push(l.fid);
          }
          done++;
          refreshGray();
        } catch (e) { warn(`  下载失败 ${l.filename}: ${e.message}`); }
        if (i < links.length - 1) await sleep(throttle, true);
      }
      const cb = document.querySelector('.swal2-close');
      if (cb && isVisible(cb)) realClick(cb);
      await until(() => !document.querySelector('.swal2-popup'), 100, 3000);
      if (targetFidsSet) result.pendingAfter = targetFids.filter(fid => !isFidDownloaded(fid)).length;
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

 /* ===== 列表状态 / 全量扫描 / 行定位 ===== */
  function tableWrap() { return document.querySelector('.ant-table-wrapper'); }
  function tableBody() {
    const w = tableWrap();
    return w ? w.querySelector('.ant-table-body') : null;
  }

  function isLoadingAnimPresent() {
    const w = tableWrap();
    if (!w) return false;
    return !!(
      w.querySelector('.table-loading-wrap') ||
      w.querySelector('.ant-spin-spinning') ||
      w.querySelector('.ant-spin-container.ant-spin-blur')
    );
  }

  function isEmptyUiVisible() {
    if (isLoadingAnimPresent()) return false;
    const w = tableWrap() || document;
    const wrap = w.querySelector('.table-empty-wrap') || document.querySelector('.table-empty-wrap');
    if (!wrap) return false;
    let op = '';
    try { op = getComputedStyle(wrap).opacity; } catch {}
    if (op === '' || op == null) op = (wrap.style && wrap.style.opacity) || '';
    if (op === '') return false;
    const n = Number(op);
    if (!Number.isFinite(n)) return false;
    return n > 0.01;
  }

  function getVirtualScrollInfo(body = null) {
    if (!body) body = tableBody();
    if (!body) return null;
    const vt = body.querySelector('[vt]');
    if (!vt) return null;
    const vtHeight = parseFloat(vt.style.height) || parseFloat(vt.style.maxHeight) || 0;
    const renderedRows = body.querySelectorAll('tr.ant-table-row');
    if (!renderedRows.length) return { vtHeight, renderedCount: 0, rowHeight: 0, dataCount: null, isVirtual: true };
    /* 行高并不均匀（文件夹行矮、上传中/两行文件名更高），用可视行平均高度更稳；
     * 且向下取整：宁可低估总量，也不要因高估而误判"扫描不完整" */
    let sum = 0, n = 0;
    for (const row of renderedRows) {
      let h = row.offsetHeight || 0;
      if (!h) { try { h = row.getBoundingClientRect().height || 0; } catch {} }
      if (h > 0) { sum += h; n++; }
    }
    const rowHeight = n ? sum / n : 0;
    /* vt 高度里还含"非数据行"：底部 拖拽/粘贴 灰框（tr.drag-bottom）、分批加载行等。
     * 不扣掉会把总数抬高（典型：2 个文件 + 1 个灰框 → 推断 3，误报"列表没加载完"） */
    let extraH = 0, extraN = 0;
    try {
      for (const tr of body.querySelectorAll('tr:not(.ant-table-row)')) {
        if (tr.closest && tr.closest('.ant-table-measure-row')) continue;
        const stl = tr.style || {};
        if (stl.display === 'none' || stl.visibility === 'hidden') continue;
        const h = tr.offsetHeight || (tr.getBoundingClientRect ? tr.getBoundingClientRect().height : 0) || 0;
        if (h > 0) { extraH += h; extraN++; }
      }
    } catch {}
    const dataH = Math.max(0, vtHeight - extraH);
    const dataCount = rowHeight > 0 && dataH > 0 ? Math.floor(dataH / rowHeight) : null;
    return {
      vtHeight, extraHeight: extraH, extraRows: extraN,
      renderedCount: renderedRows.length, rowHeight, dataCount, isVirtual: true,
    };
  }

  /* 当前目录列表总条数：优先用虚拟滚动容器高度/行高推断
   * （"共 N 个文件"是整个分享的总数，进子文件夹后不会变，不能用来判断当前目录完整性） */
  function getExpectedRowTotal() {
    const info = getVirtualScrollInfo(tableBody());
    if (info && info.dataCount > 0) return info.dataCount;
    const hint = getListFileCountHint();
    if (typeof hint === 'number' && hint > 0) return hint;
    return null;
  }

  /* 步骤 1：等列表就绪
   * 判据：loading 动画消失 + （有行 或 确认空目录）+ 行数/容器高度连续 2 次不变 */
  async function waitListSettled(opts = {}) {
    const tag = opts.tag || 'list';
    const maxWaitMs = Number(opts.maxWaitMs) > 0 ? Number(opts.maxWaitMs) : LIST_WAIT_MS;

    const hasWrap = await until(() => tableWrap(), 200, 15000);
    if (!hasWrap) return { ok: false, reason: 'no-table' };

    let lastSig = '';
    let stable = 0;
    let last = null;

    const g = await until(() => {
      if (isLoadingAnimPresent()) { lastSig = ''; stable = 0; return null; }
      const empty = isEmptyUiVisible();
      const rows = document.querySelectorAll('tr.ant-table-row[data-row-key]').length;
      const info = getVirtualScrollInfo(tableBody());
      if (!empty && rows === 0) { lastSig = ''; stable = 0; return null; }
      if (!empty && info && !(info.vtHeight > 0)) { lastSig = ''; stable = 0; return null; }
      const sig = `${empty ? 'E' : 'R'}|${rows}|${info ? Math.round(info.vtHeight) : '-'}`;
      if (sig === lastSig) stable++;
      else { lastSig = sig; stable = 1; }
      last = { empty, rows, info };
      return stable >= 2 ? last : null;
    }, 250, maxWaitMs);

    if (!g) {
      warn(`★ [${tag}] 等列表就绪超时（${maxWaitMs}ms）`);
      return { ok: false, reason: 'timeout' };
    }
    log(`★ [${tag}] 列表就绪：${g.empty ? '空目录' : `${g.rows} 行渲染`}` +
        `（vt=${g.info ? g.info.vtHeight : '-'}，尾行 ${g.info ? (g.info.extraRows || 0) : 0} 行/${g.info ? Math.round(g.info.extraHeight || 0) : 0}px，` +
        `推断数据行=${g.info ? g.info.dataCount : '-'}）`);
    return { ok: true, empty: g.empty, rows: g.rows, info: g.info, total: getExpectedRowTotal() };
  }

  /* 表格底部"加载更多"行（Quark 列表是分批加载的：tr.recent-loading-tr[data-row-config-type=more]） */
  function hasLoadingMore() {
    try {
      return !!document.querySelector(
        '.recent-loading-tr .ant-spin-spinning, tr[data-row-config-type="more"] .ant-spin-spinning'
      );
    } catch { return false; }
  }

  /* 步骤 1.5：滚动全量收集（列表分批加载 + 虚拟滚动，必须滚到底并等每一批加载完）
   * 返回 { byFid(文件) / allKeys(所有数据行，含文件夹) / reachedBottom / timedOut }
   * 注意：**不拿条数当完整性判据**——vt 高度推算会因行高不一/文件夹行/分批加载而失真，
   * 记录清理改为"逐条滚动复核"（见 clearRecordsMissingFromList） */
  async function scanAllRowsWithScroll(opts = {}) {
    const tag = opts.tag || 'scan';
    /* acg 唤起时个人页是后台标签页，setTimeout 被节流到 ~1s，超时与步进都要放大 */
    const isHidden = !!document.hidden;
    const maxMsBase = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : SCAN_MS;
    const maxMs = isHidden ? Math.round(maxMsBase * 2.5) : maxMsBase;
    const sleepStep = isHidden ? 300 : 150;
    if (isHidden) log(`★ [${tag}] 后台标签页：扫描步进放大（maxMs=${maxMs}，sleep=${sleepStep}）`);

    const byFid = new Map();
    const allKeys = new Set();          /* 所有已见数据行的 key（含文件夹/无名字行） */
    const addAll = () => {
      for (const f of scanFileRows()) {
        const k = f.fid || f.name;
        if (k && !byFid.has(k)) byFid.set(k, f);
      }
      try {
        for (const tr of document.querySelectorAll('tr.ant-table-row[data-row-key]')) {
          const k = tr.getAttribute('data-row-key');
          if (k) allKeys.add(k);
        }
      } catch {}
    };
    const total = getExpectedRowTotal();
    const body = tableBody();

    if (!body) {
      addAll();
      const empty = isEmptyUiVisible();
      const complete = byFid.size > 0 || empty;
      return { ok: true, byFid, allKeys, count: byFid.size, allCount: allKeys.size, total, empty, complete, reachedBottom: complete, timedOut: false };
    }

    try { body.scrollTop = 0; } catch {}
    await sleep(120, true);

    const step = Math.max(120, Math.floor((body.clientHeight || 400) * 0.75));
    let last = -1;
    let lastScrollH = body.scrollHeight;
    let stable = 0;
    let reachedBottom = false;
    let timedOut = false;
    const t0 = Date.now();

    while (Date.now() - t0 < maxMs) {
      if (isLoadingAnimPresent()) { await sleep(200, true); continue; }
      addAll();
      const scrollH = body.scrollHeight;
      const atBottom = body.scrollTop + body.clientHeight >= scrollH - 2;
      if (atBottom) {
        reachedBottom = true;
        if (hasLoadingMore()) {
          /* 到底了但还有下一批在加载：等它加载完，再重新计稳定 */
          await until(() => !hasLoadingMore(), 150, 4000);
          stable = 0;
          await sleep(120, true);
          continue;
        }
        if (allKeys.size === last && scrollH === lastScrollH) {
          if (++stable >= 3) break;
        } else stable = 0;
      } else stable = 0;
      last = allKeys.size;
      lastScrollH = scrollH;
      if (!atBottom) {
        try { body.scrollTop = Math.min(scrollH, body.scrollTop + step); } catch {}
      }
      await sleep(sleepStep, true);
    }
    timedOut = (Date.now() - t0) >= maxMs;

    addAll();
    try { body.scrollTop = 0; } catch {}
    await sleep(120, true);

    const empty = isEmptyUiVisible();
    const complete = reachedBottom && !timedOut;
    log(`★ [${tag}] 全量扫描：文件 ${byFid.size} / 数据行 ${allKeys.size} / 推断 ${total == null ? '?' : total}` +
        `${empty ? '（空目录）' : ''} → 到底=${reachedBottom} 超时=${timedOut} → ${complete ? '可用' : '未确认'}`);
    if (total != null && allKeys.size < total) {
      warn(`  ⚠️ 数据行 ${allKeys.size} < 推断 ${total}：列表可能仍有未渲染的行（清理会逐条复核，不会误清）`);
    }
    return { ok: true, byFid, allKeys, count: byFid.size, allCount: allKeys.size, total, empty, complete, reachedBottom, timedOut };
  }

  function findRowByFid(fid) {
    if (!fid) return null;
    const rows = document.querySelectorAll('tr.ant-table-row[data-row-key]');
    for (const row of rows) {
      if (row.getAttribute('data-row-key') === fid) return row;
    }
    return null;
  }

  /* 滚动直到目标行进入 DOM（虚拟滚动下必须） */
  async function scrollRowIntoView(fid, opts = {}) {
    const isHidden = !!document.hidden;
    /* 后台标签页里每步 ~1s（定时器节流），必须放大超时，否则长列表找不到目标行 */
    const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : (isHidden ? 20000 : 8000);
    const stepSleep = isHidden ? 260 : 110;
    let row = findRowByFid(fid);
    if (row) return row;
    const body = tableBody();
    if (!body) return null;

    try { body.scrollTop = 0; } catch {}
    await sleep(100, true);

    const step = Math.max(120, Math.floor((body.clientHeight || 400) * 0.7));
    const t0 = Date.now();
    for (;;) {
      row = findRowByFid(fid);
      if (row) return row;
      if (Date.now() - t0 > maxMs) return null;
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 2;
      if (atBottom) {
        if (hasLoadingMore()) { await until(() => !hasLoadingMore(), 150, 4000); continue; }
        await sleep(200, true);
        return findRowByFid(fid);
      }
      try { body.scrollTop = Math.min(body.scrollHeight, body.scrollTop + step); } catch {}
      await sleep(stepSleep, true);
    }
  }

  async function setRowChecked(row, desired) {
    if (!row || !row.isConnected) return false;
    const isOn = () => {
      const i = row.querySelector('input.ant-checkbox-input');
      return !!(i && i.checked) || row.classList.contains('ant-table-row-selected');
    };
    if (isOn() === desired) return true;
    const lbl = row.querySelector('label.ant-checkbox-wrapper');
    if (!lbl) return false;
    realClick(lbl);
    const ok = await until(() => (isOn() === desired ? true : null), 80, 2000);
    return !!ok;
  }

  function collectToastText() {
    let t = '';
    try {
      for (const sel of ['.ant-message-notice', '.ant-notification-notice', '.swal2-popup']) {
        for (const el of document.querySelectorAll(sel)) {
          if (isVisible(el)) t += ' ' + (el.textContent || '');
        }
      }
    } catch {}
    return t;
  }

  /* 账号被限制时删除/转存都会"假成功"，必须先识别出来
   * 注意：#portal-message 里的提示条常驻 DOM，隐藏态带 out-screen 类，不能只看尺寸 */
  function isAccountLimited() {
    try {
      const box = document.querySelector('#portal-message');
      if (!box) return false;
      const text = box.textContent || '';
      if (!/涉嫌违规|被封禁|禁止使用|限制使用/.test(text)) return false;
      const inner = box.firstElementChild || box;
      const cls = `${box.className || ''} ${inner.className || ''}`;
      if (/out-screen/.test(cls)) return false;
      return isVisible(inner);
    } catch { return false; }
  }

  /* 步骤 2 的"await until 文件已删除"：以行消失 + toast 为准（真伪由刷新后重扫复核） */
  async function awaitRowsGone(fids, timeout = 25000) {
    const alive = () => fids.filter(fid => !!findRowByFid(fid)).length;
    const t0 = Date.now();
    const r = await until(() => {
      const toast = collectToastText();
      if (/删除失败|无法删除|操作失败|不支持/.test(toast)) return 'fail';
      if (alive() === 0) {
        if (/删除成功|已删除|删除完成/.test(toast)) return 'success';
        if (Date.now() - t0 > 1200) return 'gone';
      }
      return null;
    }, 250, timeout);
    return r || 'timeout';
  }

  /* 点页面内刷新并等 loading 走完（删除后的唯一可信来源） */
  /* 点页面内刷新并等 loading 走完。
   * 返回值区分两类失败：
   *   settle-timeout → list 还在 loading，DOM 不可信，调用方必须放弃
   *   no-refresh-btn / no-loading-signal → 没点到或没看到动画，但 DOM 仍是"服务端已确认"的状态，可继续 */
  async function refreshListAndWait(opts = {}) {
    const tag = opts.tag || 'refresh';
    const settleMs = Number(opts.settleMs) > 0 ? Number(opts.settleMs) : 20000;
    let w = tableWrap();
    if (!w) return { ok: false, reason: 'no-table' };
    const btn = document.querySelector('.fl-refresh') ||
      (w.closest('.file-list') && w.closest('.file-list').querySelector('.fl-refresh'));
    if (!btn) return { ok: false, reason: 'no-refresh-btn' };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const target = btn.querySelector('img') || btn;
      realClick(target);
      const appeared = await until(() => isLoadingAnimPresent(), 80, 3500);
      if (appeared) {
        const gone = await until(() => !isLoadingAnimPresent(), 150, settleMs);
        if (!gone) return { ok: false, reason: 'settle-timeout' };
        const settled = await waitListSettled({ tag, maxWaitMs: 20000 });
        return settled.ok ? { ok: true } : { ok: false, reason: settled.reason };
      }
      warn(`  [${tag}] 第 ${attempt} 次点刷新未见 loading 动画`);
      await sleep(600, true);
    }
    return { ok: false, reason: 'no-loading-signal' };
  }

  /* 刷新失败分两类：卡在 loading/拿不到表格 → 致命；没点到/没动画 → 只是没刷新，DOM 仍可信 */
  function isRefreshFatal(reason) {
    return ['settle-timeout', 'timeout', 'no-table'].includes(String(reason || ''));
  }

  /* 步骤 2：勾选 → 删除 → 确认 → await until 消失 → 刷新复核 */
  async function deleteFilesByFids(fids, opts = {}) {
    const tag = opts.tag || 'delete';
    const out = { requested: fids.length, picked: 0, pickedFids: [], result: 'none', failed: [], still: [] };
    if (!fids || !fids.length) return out;
    if (isAccountLimited()) {
      warn('⛔ 账号受限提示可见，跳过删除');
      out.result = 'account-limited';
      out.failed = fids.slice();
      return out;
    }

    const targets = [...new Set(fids)];
    let remaining = targets.slice();

    for (let attempt = 1; attempt <= 2 && remaining.length; attempt++) {
      if (attempt > 1) {
        log(`  删除重试 ${attempt}/2：剩余 ${remaining.length}，等 2000ms`);
        await sleep(2000, true);
        const settled = await waitListSettled({ tag: tag + '-retry', maxWaitMs: 20000 });
        if (!settled.ok) break;
      }
      await clearAllSelection();
      await sleep(150, true);

      const picked = [];
      let paused = false;
      for (const fid of remaining) {
        if (isPaused()) { paused = true; break; }
        const row = await scrollRowIntoView(fid);
        if (!row) { log(`  目标 ${fid.slice(0, 8)} 不在列表中，跳过`); continue; }
        if (await setRowChecked(row, true)) picked.push(fid);
      }
      if (paused) {
        warn('  ⏸ 暂停：放弃本次删除（不点了，避免只删一半）');
        out.result = 'paused';
        out.failed = remaining.slice();
        await clearAllSelection();
        break;
      }
      out.picked = picked.length;
      out.pickedFids = picked.slice();
      if (!picked.length) {
        warn(`  没有勾选到任何目标文件（${remaining.length} 个都不在列表内）`);
        break;
      }

      if (!await clickDeleteButton(8000)) { warn('  未找到顶栏删除按钮'); break; }
      if (!await confirmDeleteDialog(8000)) {
        warn('  未找到删除确认按钮');
        await until(() => !document.querySelector('.base-confirm-modal'), 100, 1200);
        break;
      }

      const st = await awaitRowsGone(picked, 25000);
      out.result = st;
      log(`  删除结果：${st}（勾选 ${picked.length}）`);
      await until(() => !document.querySelector('.base-confirm-modal'), 100, 1500);

      const rf = await refreshListAndWait({ tag: tag + '-refresh' });
      if (!rf.ok && isRefreshFatal(rf.reason)) {
        warn(`  删除后刷新未完成（${rf.reason}），无法复核`);
        out.still = picked.slice();
        out.result = 'unverified';
        return out;
      }
      if (!rf.ok) warn(`  刷新未确认（${rf.reason}），按当前（服务端已确认的）列表复核`);

      const left = [];
      for (const fid of picked) {
        if (await scrollRowIntoView(fid, { maxMs: 5000 })) left.push(fid);
      }
      out.still = left;
      out.failed = targets.filter(f => !picked.includes(f)).concat(left);
      remaining = left.slice();
      if (!left.length) { out.result = 'deleted'; break; }
      warn(`  ${left.length} 个文件刷新后仍在列表中，判定未删除`);
    }

    log(`★ [${tag}] 删除汇总：请求 ${out.requested}，勾选 ${out.picked}，剩余 ${out.still.length}（${out.result}）`);
    return out;
  }

  /* ===== FDM 下载完成 → 删云端文件 =====
   * 页面看不到本地下载进度，真正的"完成"信号由本机 Python 工具
   * （AutoCleanOrMoveFDMCache.pyw）提供：它监听 FDM 的 db.sqlite，搬运成功（已校验大小）
   * 后登记到 quark_pending_delete.json，并通过 http://127.0.0.1:8732 暴露给这里。 */
  function fdmAvailable() {
    try { return typeof GM_xmlhttpRequest === 'function'; } catch { return false; }
  }

  function fdmRequest(path, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!fdmAvailable()) { reject(new Error('GM_xmlhttpRequest 不可用')); return; }
      const data = opts.data ? JSON.stringify(opts.data) : undefined;
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: FDM_BRIDGE + path,
        headers: data ? { 'Content-Type': 'application/json' } : {},
        data,
        timeout: opts.timeout || 4000,
        onload: (r) => {
          try { resolve(JSON.parse((r && r.responseText) || '{}')); }
          catch { resolve(null); }
        },
        onerror: () => reject(new Error('bridge-unreachable')),
        ontimeout: () => reject(new Error('bridge-timeout')),
        onabort: () => reject(new Error('bridge-abort')),
      });
    });
  }

  function fdmStripDupSuffix(name) {
    return String(name || '').replace(/\s*\(\d+\)(?=\.[^.]+$)/, '').trim();
  }

  /* 待删条目 → 下载记录里的 fid：先按签名链接精确比，再按 filename=/文件名 兜底 */
  function fdmMatchRecord(recs, item) {
    const url = String(item.url || '').trim();
    if (url) {
      for (const fid of Object.keys(recs)) {
        const r = recs[fid];
        if (r && r.link && String(r.link).trim() === url) return { fid, how: 'url' };
      }
    }
    const names = new Set();
    try {
      const f = new URL(url).searchParams.get('filename');
      if (f) names.add(f.trim());
    } catch {}
    if (item.name) names.add(String(item.name).trim());
    const keys = new Set([...names].map(fdmStripDupSuffix).filter(Boolean));
    if (!keys.size) return null;
    for (const fid of Object.keys(recs)) {
      const r = recs[fid];
      if (!r || !r.name) continue;
      if (keys.has(String(r.name).trim()) || keys.has(fdmStripDupSuffix(r.name))) {
        return { fid, how: 'name' };
      }
    }
    return null;
  }

  let _fdmBusy = false;
  let _fdmFail = 0;
  let _fdmNextAt = 0;
  let _fdmStaleScanAt = 0;

  function fdmUnmatchedKey(it) {
    const url = String((it && it.url) || '').trim();
    if (url) return url;
    return 'name:' + String((it && it.name) || '').trim();
  }

  /* FDM 已完成但没有下载记录的项：先记账（首次见到的时间），
   * 满 7 天 + 列表已加载完 + 列表里确实找不到同名文件 → ack 掉，别让它永远挂在 /pending。 */
  async function reclaimStaleFdmItems(unmatched) {
    const out = { tracked: 0, acked: 0, expired: 0, skipped: 0 };
    if (!unmatched || !unmatched.length) return out;
    const store = gmGet(GM_FDM_UNMATCHED, {}) || {};
    const now = Date.now();
    for (const it of unmatched) {
      const k = fdmUnmatchedKey(it);
      if (!k) continue;
      if (!store[k]) { store[k] = now; out.tracked++; }
    }
    /* 清掉已经不在 /pending 里的跟踪项 */
    const liveKeys = new Set(unmatched.map(fdmUnmatchedKey));
    for (const k of Object.keys(store)) if (!liveKeys.has(k)) delete store[k];

    const aged = unmatched.filter(it => {
      const ts = store[fdmUnmatchedKey(it)] || now;
      return now - ts >= FDM_UNMATCHED_TTL_MS;
    });
    if (out.tracked) {
      const names = unmatched.slice(0, 5).map(it => it.name || it.url).join('、');
      log(`☁️ FDM 残留项：新增跟踪 ${out.tracked} 个（无下载记录，${Math.round(FDM_UNMATCHED_TTL_MS / 86400000)} 天后若列表仍无此文件才清理）：`
          + names + (unmatched.length > 5 ? '…' : ''));
    }
    if (!aged.length) { gmSet(GM_FDM_UNMATCHED, store); return out; }

    out.expired = aged.length;
    if (!isListLoaded()) { out.skipped = aged.length; gmSet(GM_FDM_UNMATCHED, store); return out; }
    /* 全表扫描比较重，限制频率 */
    if (now - _fdmStaleScanAt < 10 * 60 * 1000) { out.skipped = aged.length; gmSet(GM_FDM_UNMATCHED, store); return out; }
    _fdmStaleScanAt = now;

    let scan = null;
    try { scan = await scanAllRowsWithScroll({ tag: 'fdm-stale', maxMs: 20000 }); } catch (e) { warn('☁️ 残留项扫描异常', e); }
    if (!scan || scan.complete !== true) {
      log('☁️ FDM 残留项：列表未确认完整，本轮不清理');
      out.skipped = aged.length;
      gmSet(GM_FDM_UNMATCHED, store);
      return out;
    }
    const present = new Set();
    try {
      for (const f of scan.byFid.values()) {
        const n = String((f && f.name) || '').trim();
        if (!n) continue;
        present.add(n);
        present.add(fdmStripDupSuffix(n));
      }
    } catch {}

    const gone = aged.filter(it => {
      const n = String(it.name || '').trim();
      if (!n) return false;
      return !present.has(n) && !present.has(fdmStripDupSuffix(n));
    });
    if (!gone.length) {
      log(`☁️ FDM 残留项：${aged.length} 个已超期，但文件仍在列表中 → 保留跟踪`);
      gmSet(GM_FDM_UNMATCHED, store);
      return out;
    }
    log(`☁️ FDM 残留项：${gone.length} 个超过 7 天且列表中已不存在 → ack 清理（不删任何文件）`);
    try {
      const a = await fdmRequest('/ack', { method: 'POST', data: { urls: gone.map(it => it.url) } });
      out.acked = (a && a.acked) || 0;
    } catch (e) { warn('☁️ 残留项 ack 失败（下轮重试）', e); }
    if (out.acked > 0) {
      for (const it of gone) delete store[fdmUnmatchedKey(it)];
    }
    gmSet(GM_FDM_UNMATCHED, store);
    return out;
  }

  /* 纯执行：拉 /pending → 匹配 fid → 删云端 → 复核 → 清记录 + ack。
   * 不做状态守卫/退避，供清理流程（流程开始）和定时同步共用 */
  async function purgeFdmConfirmed(opts = {}) {
    if (_fdmBusy) return { ok: false, reason: 'busy' };
    if (!isListPage()) return { ok: false, reason: 'not-list-page' };
    if (!fdmAvailable()) return { ok: false, reason: 'no-api' };
    const tag = opts.tag || 'fdm';
    _fdmBusy = true;
    try {
      let res;
      try { res = await fdmRequest('/pending', { timeout: opts.timeout || 4000 }); }
      catch (e) { return { ok: false, reason: 'bridge-unreachable', message: e.message }; }

      if (!res || res.ok !== true) return { ok: false, reason: 'bad-response' };

      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) return { ok: true, pending: 0, deleted: 0, acked: 0 };

      const recs = loadDlRecords();
      const plan = [];
      const unmatched = [];
      for (const it of items) {
        const m = fdmMatchRecord(recs, it);
        if (m) plan.push({ fid: m.fid, how: m.how, item: it });
        else unmatched.push(it);
      }
      /* 没有下载记录的：不删任何文件，只按"超期 + 列表里确实没有"去做 ack 清理 */
      let stale = null;
      if (unmatched.length) {
        try { stale = await reclaimStaleFdmItems(unmatched); }
        catch (e) { warn('☁️ 处理 FDM 残留项异常', e); }
      }
      if (!plan.length) {
        return { ok: true, pending: items.length, deleted: 0, acked: (stale && stale.acked) || 0, unmatched: unmatched.length };
      }

      log(`☁️ [${tag}] 云端待删 ${plan.length} 个：${plan.map(p => p.item.name || p.fid.slice(0, 8)).join('、')}`);
      const del = await deleteFilesByFids(plan.map(p => p.fid), { tag });
      const picked = new Set(del.pickedFids || []);
      const still = new Set(del.still || []);
      const gone = plan.filter(p => picked.has(p.fid) && !still.has(p.fid));

      let acked = 0;
      if (gone.length) {
        clearDlRecordsFids(gone.map(p => p.fid));
        refreshGray();
        try {
          const a = await fdmRequest('/ack', { method: 'POST', data: { urls: gone.map(p => p.item.url) } });
          acked = (a && a.acked) || 0;
        } catch (e) { warn('☁️ ack 失败（下轮会重试）', e); }
      }
      log(`☁️ [${tag}] 云端删除：确认 ${gone.length} / 计划 ${plan.length}（ack ${acked}）`);
      return { ok: true, pending: items.length, deleted: gone.length, acked };
    } catch (e) {
      warn('☁️ 同步 FDM 完成状态异常', e);
      return { ok: false, reason: String((e && e.message) || e) };
    } finally {
      _fdmBusy = false;
    }
  }

  /* 定时/等待用：加状态守卫与失败退避（清理流程内部直接调 purgeFdmConfirmed） */
  async function syncFdmFinishedDeletes(opts = {}) {
    if (!isListPage()) return { ok: false, reason: 'not-list-page' };
    if (isPaused()) return { ok: false, reason: 'paused' };
    if (!fdmAvailable()) return { ok: false, reason: 'no-api' };
    if (_fdmBusy) return { ok: false, reason: 'busy' };
    if (!opts.force && Date.now() < _fdmNextAt) return { ok: false, reason: 'backoff' };
    if (GATE.state === 'cleanup' || GATE.state === 'downloading' || downloadRunning) {
      return { ok: false, reason: 'busy-local' };
    }
    const r = await purgeFdmConfirmed(opts);
    if (r.ok) { _fdmFail = 0; _fdmNextAt = 0; return r; }
    if (r.reason === 'bridge-unreachable') {
      _fdmFail++;
      const wait = Math.min(10 * 60 * 1000, 60 * 1000 * _fdmFail);
      _fdmNextAt = Date.now() + wait;
      if (_fdmFail === 1) log(`☁️ 本地桥不可用（${r.message || 'unreachable'}），${Math.round(wait / 1000)}s 后再试`);
    }
    return r;
  }

  function isListLoaded() { return !isLoadingAnimPresent(); }

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
    const match = (el) => {
      if (!isVisible(el)) return false;
      const txt = (el.textContent || '').replace(/\s+/g, '');
      const title = el.getAttribute('title') || el.getAttribute('aria-label') || '';
      return txt === '删除' || title === '删除';
    };
    const btn = await until(() => {
      for (const el of document.querySelectorAll('.btn-group button.btn-file, .btn-group button.ant-btn')) {
        if (match(el)) return el;
      }
      for (const el of document.querySelectorAll('.btn-operate button, .list-header button, .btn-group button')) {
        if (match(el)) return el;
      }
      for (const el of document.querySelectorAll('button.btn-file, button.ant-btn, button[class*="btn"]')) {
        if (match(el)) return el;
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

 /* ================= 清理（步骤 1-3） ================= */

  /* 步骤 3：只按"删除后的列表"清记录 —— 不看时间，只看文件是否还在列表里 */
  /* 扫描结果是否可用来清记录：
   *   1) 必须滚到底且没超时；
   *   2) 见过的数据行数不能明显少于 vt 高度推算的条数（差 1 容忍，行高不一时会有偏差）。
   * 注：第 2 条只是"安全护栏"，不满足时**不清记录**，但不会拦截整轮流程。 */
  function scanTrust(s) {
    if (!s || s.complete !== true) return false;
    if (s.total == null) return true;
    return s.allCount >= s.total - 1;
  }

  /* 步骤 3：只清"文件确实不在列表里"的记录。
   * 判据不依赖条数：对每个候选 fid **滚动定位复核**一次，找不到才清
   * （虚拟滚动/分批加载下，"这次没扫到"不等于"不存在"） */
  async function clearRecordsMissingFromList(byFid, scope, opts = {}) {
    const out = { removed: [], kept: 0, noScope: 0, unverified: 0, names: [] };
    if (!scope) return out;
    const recs = loadDlRecords();
    const candidates = [];
    for (const fid of Object.keys(recs)) {
      const r = recs[fid];
      if (!r) { candidates.push(fid); continue; }   /* 脏数据：没有对象，直接清 */
      const s = String(r.scope || '');
      if (!s) { out.noScope++; continue; }          /* 无归属目录：不猜，保留 */
      if (s !== scope) continue;                    /* 其它目录：不动 */
      if (byFid.has(fid)) { out.kept++; continue; } /* 文件还在：不动 */
      candidates.push(fid);
    }
    if (!candidates.length) return out;
    if (isPaused()) { out.unverified = candidates.length; return out; }

    const verifyMs = Number(opts.verifyMs) > 0 ? Number(opts.verifyMs) : 8000;
    const dead = [];
    for (const fid of candidates) {
      const row = await scrollRowIntoView(fid, { maxMs: verifyMs });
      /* 复核期间列表若在刷新，结论不可信 → 本轮不动记录 */
      if (!row && isLoadingAnimPresent()) { out.unverified++; continue; }
      if (row) {
        out.kept++;
        log(`  记录 ${String(fid).slice(0, 8)}「${(recs[fid] && recs[fid].name) || ''}」复核时找到了，保留`);
      } else {
        dead.push(fid);
        out.names.push((recs[fid] && recs[fid].name) || fid);
      }
    }
    if (dead.length) { clearDlRecordsFids(dead); out.removed = dead; }
    return out;
  }

  let _cleanupRunning = false;
  async function runCleanupRound(opts = {}) {
    if (_cleanupRunning) {
      warn('清理：已有清理在执行，跳过本次');
      return { ok: false, reason: 'busy' };
    }
    _cleanupRunning = true;
    try { return await cleanupRoundCore(opts); }
    finally { _cleanupRunning = false; }
  }

  async function cleanupRoundCore(opts = {}) {
    const tag = opts.tag || 'cleanup';
    const t0 = Date.now();
    if (!isListPage()) return { ok: false, reason: 'not-list-page' };
    if (isPaused() && !opts.manual) return { ok: false, reason: 'paused' };
    if (isAccountLimited()) return { ok: false, reason: 'account-limited' };

    /* ---- 1. 等文件列表加载完 ---- */
    const settled = await waitListSettled({ tag, maxWaitMs: opts.listWaitMs });
    if (!settled.ok) return { ok: false, reason: 'list-' + settled.reason };

    const scope = currentListScope();
    if (!scope) return { ok: false, reason: 'no-scope' };

    let scan = await scanAllRowsWithScroll({ tag: tag + '-before', maxMs: opts.scanMs });
    if (!scanTrust(scan)) {
      /* 首屏可能还没把行挂上（list 就绪 ≠ 行已渲染），重试一次再判断 */
      warn(`⚠️ [${tag}] 扫描结果可疑（文件 ${scan.count} / 数据行 ${scan.allCount} / 推断 ${scan.total}），等列表稳定后重试一次`);
      await waitListSettled({ tag: tag + '-retry', maxWaitMs: 15000 }).catch(() => null);
      await sleep(800, true);
      const again = await scanAllRowsWithScroll({ tag: tag + '-retry', maxMs: opts.scanMs });
      if (!again || again.allCount >= scan.allCount) scan = again || scan;
      log(`★ [${tag}] 重试后：文件 ${scan.count} / 数据行 ${scan.allCount} / 推断 ${scan.total}，可信=${scanTrust(scan)}`);
    }

    /* ---- 1.5 先走 FDM 桥：本地已确认下载完成的，立刻删云端 ----
     * 顺序很重要：先删"确证本地有完整副本"的，再按 24h TTL 兜底删剩下的，
     * 避免 TTL 先动手把还没下到本地的文件删掉。 */
    let fdmDeleted = 0;
    let fdmState = 'skipped';
    if (fdmAvailable()) {
      const pg = await purgeFdmConfirmed({ tag: tag + '-fdm' });
      if (pg.ok) {
        fdmState = pg.pending ? `确认删除 ${pg.deleted}/${pg.pending}` : '无待删';
        if (pg.deleted > 0) {
          fdmDeleted = pg.deleted;
          log(`★ [${tag}] FDM 已完成并删除云端 ${pg.deleted} 个，重新扫描列表后继续`);
          const rescan = await scanAllRowsWithScroll({ tag: tag + '-fdm-after', maxMs: opts.scanMs });
          if (rescan && scanTrust(rescan)) scan = rescan;
          else warn(`⚠️ [${tag}] FDM 删除后重扫不可信，沿用删除前的扫描结果`);
        }
      } else if (pg.reason === 'bridge-unreachable') {
        fdmState = '桥不可达';
        log(`★ [${tag}] 本地桥不可达，跳过 FDM 确认（按 24h TTL 兜底）`);
      } else {
        fdmState = pg.reason || 'unknown';
        warn(`⚠️ [${tag}] FDM 确认跳过（${fdmState}）`);
      }
    }

    /* ---- 2. 删除过期文件（TTL 兜底） ---- */
    const recs = loadDlRecords();
    const expired = [];
    for (const fid of Object.keys(recs)) {
      const r = recs[fid];
      if (!r) continue;
      if (String(r.scope || '') !== scope) continue;
      const ts = recordTs(r);
      if (!(ts > 0) || Date.now() - ts <= DL_TTL) continue;
      if (!scan.byFid.has(fid)) continue;   /* 文件已不在列表：交给第 3 步清记录 */
      expired.push({ fid, name: String((scan.byFid.get(fid) || {}).name || '') });
    }

    let del = { requested: 0, picked: 0, result: 'none', failed: [], still: [], deleted: 0 };
    if (expired.length) {
      log(`★ [${tag}] 过期文件 ${expired.length} 个：${expired.map(e => e.name).join('、')}`);
      del = await deleteFilesByFids(expired.map(e => e.fid), { tag });
      if (del.result === 'account-limited') return { ok: false, reason: 'account-limited', files: del };
      if (del.result === 'paused') return { ok: false, reason: 'paused', files: del };
      if (del.result === 'unverified') return { ok: false, reason: 'delete-unverified', files: del };

      /* 删除后尽量重新拉一次列表：Quark 的删除不是乐观更新（行在服务端确认后才消失），
       * 所以刷新失败不等于数据不可信；只有"卡在 loading"才必须放弃 */
      const rf = await refreshListAndWait({ tag: tag + '-refresh' });
      if (!rf.ok && isRefreshFatal(rf.reason)) {
        return { ok: false, reason: 'refresh-' + rf.reason, files: del };
      }
      if (!rf.ok) warn(`⚠️ [${tag}] 刷新未确认（${rf.reason}），按当前列表继续`);
      else await waitListSettled({ tag: tag + '-after-refresh', maxWaitMs: 20000 });

      scan = await scanAllRowsWithScroll({ tag: tag + '-after', maxMs: opts.scanMs });
      if (!scanTrust(scan)) warn(`⚠️ [${tag}] 删除后扫描不可信，本轮不清记录`);

      del.still = expired.filter(e => scan.byFid.has(e.fid)).map(e => e.name);
      del.deleted = expired.length - del.still.length;
      if (del.still.length) warn(`⚠️ [${tag}] 删除后仍在列表：${del.still.join('、')}（其记录保留）`);
    }

    /* ---- 3. 根据删除后的列表清理记录 ---- */
    /* 兜底：一条文件都没扫到却没能确认"真空目录"时，绝不清记录（但也不中止整轮） */
    let cleared = { removed: [], kept: 0, noScope: 0, unverified: 0, names: [] };
    if (!scanTrust(scan)) {
      warn(`⚠️ [${tag}] 列表扫描不可信（文件 ${scan.count} / 数据行 ${scan.allCount} / 推断 ${scan.total}），本轮保留全部记录`);
    } else if (scan.byFid.size === 0 && !scan.empty) {
      warn(`⚠️ [${tag}] 列表扫到 0 个文件且未确认空目录，跳过记录清理`);
    } else {
      cleared = await clearRecordsMissingFromList(scan.byFid, scope);
    }
    const ms = Date.now() - t0;
    log(`★ [${tag}] 清理完成：FDM 确认 ${fdmDeleted}（${fdmState}），过期文件 ${expired.length}（删掉 ${del.deleted}）` +
        `，清记录 ${cleared.removed.length}（保留 ${cleared.kept}，待复核 ${cleared.unverified}）` +
        `，文件 ${scan.count} / 数据行 ${scan.allCount}，耗时 ${ms}ms`);
    refreshGray();
    return {
      ok: true, scope, rows: scan.count, allRows: scan.allCount, empty: scan.empty,
      expired: expired.length, deleted: del.deleted, still: del.still,
      fdmDeleted, fdmState,
      records: cleared.removed.length, recordNames: cleared.names,
      kept: cleared.kept, unverified: cleared.unverified,
      noScope: cleared.noScope, ms,
    };
  }

 /* ================= 挂起门（unsafeWindow，不落盘） ================= */
  function isAcgInvokedFlag() {
    try { return sessionStorage.getItem(ACG_FLAG_KEY) === '1'; } catch { return false; }
  }
  function clearBridgeBusy() {
    try { sessionStorage.removeItem(BUSY_KEY); } catch {}
  }

  const GATE = {
    key: GATE_KEY,
    id: Date.now().toString(36),
    round: 0,
    state: 'init',        /* init | cleanup | ready | blocked | released | aborted | downloading | closing | idle */
    stateAt: Date.now(),
    acg: false,
    acgTag: '',
    readyAt: 0,
    releasedAt: 0,
    abortReason: '',
    cleanup: null,
    result: null,
    note: '',
    _pendingRearm: false,
  };

  function gateSnapshot() {
    return {
      key: GATE.key, id: GATE.id, round: GATE.round, state: GATE.state,
      acg: GATE.acg, acgTag: GATE.acgTag, readyAt: GATE.readyAt,
      releasedAt: GATE.releasedAt, abortReason: GATE.abortReason,
      cleanup: GATE.cleanup, result: GATE.result, note: GATE.note,
    };
  }
  function gateSet(state, note) {
    if (GATE.state !== state) GATE.stateAt = Date.now();
    GATE.state = state;
    if (note !== undefined) GATE.note = String(note || '');
    log(`⛩ 门 → ${state}${GATE.note ? `（${GATE.note}）` : ''}${GATE.acg ? ' [acg]' : ''}`);
  }

  GATE.snapshot = gateSnapshot;
  GATE.isReady = () => GATE.state === 'ready';

  /* 桥接脚本调用：声明"这是 acg 唤起"，若已过门则请求重开一轮 */
  GATE.attach = (tag) => {
    if (!GATE.acg) {
      GATE.acg = true;
      GATE.acgTag = tag || 'bridge';
      log('⛩ 桥接接入（acg 唤起）');
    }
    if (!['init', 'cleanup', 'ready'].includes(GATE.state)) {
      GATE._pendingRearm = true;
      log(`⛩ 门已在 ${GATE.state}，请求重开一轮`);
    }
    return gateSnapshot();
  };

  /* 桥接脚本调用：等挂起标记（timeoutMs=0 表示一直等） */
  GATE.waitReady = async (timeoutMs) => {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    return await until(
      () => (GATE.state === 'ready' || GATE.state === 'blocked') ? gateSnapshot() : null,
      150, ms
    );
  };

  /* 桥接脚本调用：放行 */
  GATE.release = (info) => {
    if (!['ready', 'cleanup'].includes(GATE.state)) {
      warn(`⛩ release 被忽略（state=${GATE.state}）`);
      return false;
    }
    GATE.releasedAt = Date.now();
    GATE.result = info || null;
    gateSet('released', (info && info.reason) || 'bridge-release');
    return true;
  };

  /* 桥接脚本调用：中止本轮（保持页面，不下载） */
  GATE.abort = (reason) => {
    GATE.abortReason = String(reason || 'aborted');
    gateSet('aborted', GATE.abortReason);
    return true;
  };

  /* 桥接脚本调用：请求重开一轮（重新清理 → 再次挂起） */
  GATE.rearm = () => {
    GATE._pendingRearm = true;
    return gateSnapshot();
  };

 /* ================= 个人页控制器 ================= */
  let _controllerRunning = false;
  async function runPersonalController() {
    if (_controllerRunning) return;
    if (!isListPage()) return;
    _controllerRunning = true;
    try {
      GATE.acg = isAcgInvokedFlag();
      if (GATE.acg) log('⛩ 检测到 acg 唤起标记（sessionStorage，不落盘）');

      for (;;) {
        GATE._pendingRearm = false;
        GATE.round++;
        gateSet('cleanup', `第 ${GATE.round} 轮`);
        if (GATE.acg) setStatus('清理中...', 'running');
        setProgress('-');

        let cleanup;
        try { cleanup = await runCleanupRound({ tag: `round${GATE.round}` }); }
        catch (e) { cleanup = { ok: false, reason: 'exception:' + String(e && e.message || e) }; }
        GATE.cleanup = cleanup;

        if (!cleanup || cleanup.ok !== true) {
          const reason = (cleanup && cleanup.reason) || 'unknown';
          if (GATE.acg) {
            /* acg 唤起：清不干净就不动子任务、不下载，挂起等人工/下次重开 */
            gateSet('blocked', reason);
            setStatus(`清理未完成(${reason})`, 'error');
            warn('⛩ 清理未完成：本轮不开子任务、不下载');
            await until(() => GATE._pendingRearm, 300);
            continue;
          }
          /* 非 acg：清理失败只是放弃清理（没有清记录就没有风险），照常下载 */
          gateSet('ready', `降级：清理失败(${reason})`);
          setStatus(`清理失败(${reason})，仅下载`, 'running');
        } else {
          GATE.readyAt = Date.now();
          gateSet('ready', `删文件 ${cleanup.deleted} / 清记录 ${cleanup.records}`);
          setStatus('清理完成，等待下一步', 'running');
          setProgress(`列表 ${cleanup.rows} 行`);
        }

        /* ---- 5. 一直 await until：不是 acg 唤起的 / 挂起结束 ---- */
        if (!GATE.acg) await sleep(NOT_ACG_GRACE_MS, true);

        const decision = await until(() => {
          if (GATE._pendingRearm) return { kind: 'rearm' };
          if (GATE.state === 'released') return { kind: 'released' };
          if (GATE.state === 'aborted') return { kind: 'aborted' };
          if (!GATE.acg) {
            if (isAcgInvokedFlag()) { GATE.acg = true; GATE.acgTag = 'late-flag'; return null; }
            return { kind: 'self' };
          }
          return null;
        }, 200);

        if (decision.kind === 'rearm') { log('⛩ 收到重开请求'); continue; }
        if (decision.kind === 'aborted') {
          warn(`⛩ 桥接中止：${GATE.abortReason}，保持本页`);
          setStatus('子任务中止，保持本页', 'error');
          await until(() => GATE._pendingRearm, 500);
          continue;
        }

        /* ---- 6. 执行自动下载 ---- */
        gateSet('downloading', decision.kind === 'self' ? '非 acg 唤起' : '桥接已放行');
        clearBridgeBusy();
        setStatus('自动下载中...', 'running');
        let dlResult = null;
        try { dlResult = await autoDownloadWorkflow({ ignoreBusy: true }); }
        catch (e) { warn('自动下载异常', e); }

        /* ---- 6.5 FDM 完成后的云端删除：异步，绝不阻塞本页 ----
         * 大文件可能十几分钟，页面不能等：
         *  · acg 唤起：走完下载直接进入关页流程；遗留的待删项等下次手动打开个人页时补删；
         *  · 手动打开：本页常驻，后台轮询（FDM_POLL_MS）发现完成即删，只刷置灰、不打断界面。 */
        const dlFids = (dlResult && Array.isArray(dlResult.downloadedFids)) ? dlResult.downloadedFids : [];
        if (dlFids.length) {
          log(`☁️ 下载已触发 ${dlFids.length} 个；FDM 完成后的云端删除交给后台轮询（不阻塞）`);
          if (!GATE.acg) {
            setTimeout(() => { syncFdmFinishedDeletes({ force: true }).catch(() => {}); }, 5000);
          }
        }

        /* ---- 7. acg 唤起：执行关闭页面流程 ---- */
        if (GATE.acg) {
          gateSet('closing', `下载已触发，${Math.round(CLOSE_DELAY_MS / 1000)}s 后关闭`);
          setStatus(`下载已触发，${Math.round(CLOSE_DELAY_MS / 1000)}s 后关闭`, 'done');
          setProgress('-');
          await sleep(CLOSE_DELAY_MS, true);
          warn('⛩ acg 唤起：关闭本页');
          try { window.close(); } catch {}
          await sleep(1500, true);
          gateSet('idle', 'close-blocked');
        } else {
          gateSet('idle', '下载完成');
          setStatus('待机（个人页）');
          setProgress('-');
        }
        await until(() => GATE._pendingRearm, 500);
      }
    } catch (e) {
      warn('⛩ 控制器异常', e);
      gateSet('blocked', 'controller:' + String(e && e.message || e));
    } finally {
      _controllerRunning = false;
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
        { keepTs: true }
      );
    }
    log(`★ 标记选中为已下载：${picked.length} 个`);
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
      title: '批量下载本页未下载过的文件',
      onclick: () => autoDownloadWorkflow(),
    });
    addBuiltinAction({
      get label() { return isPaused() ? '▶️ 继续下载' : '⏸️ 暂停下载'; },
      get color() { return isPaused() ? '#52c41a' : '#faad14'; },
      title: '暂停/继续自动下载（状态持久化）',
      onclick: () => {
        const next = !isPaused();
        setPaused(next);
        setStatus(next ? '已暂停' : '待机（个人页）', next ? 'running' : '');
        renderActions();
      },
    });
    addBuiltinAction({
      label: '✅ 标记已下载',
      color: '#1677ff',
      title: '把当前勾选的文件标记为已下载',
      onclick: () => markSelectedAsDownloaded(),
    });
    addBuiltinAction({
      label: '🧹 立即清理',
      color: '#d46b08',
      title: '等列表就绪 → 删除过期文件 → 按删除后的列表清理「文件已不存在」的记录',
      onclick: async () => {
        const r = await runCleanupRound({ tag: 'manual', manual: true });
        refreshGray();
        if (r.ok) {
          alert(`清理完成\n\nFDM 已确认完成：${r.fdmDeleted || 0}（${r.fdmState || '-'}）`
                + `\n过期文件：${r.expired}（删掉 ${r.deleted}）`
                + (r.still && r.still.length ? `\n删除后仍在：${r.still.join('、')}` : '')
                + `\n清理记录：${r.records}`
                + (r.recordNames && r.recordNames.length ? `\n${r.recordNames.slice(0, 10).join('、')}` : '')
                + `\n列表：${r.rows} 行`);
        } else {
          const reasonMap = {
            'busy': '已有清理在执行',
            'not-list-page': '不在个人页',
            'paused': '暂停中',
            'account-limited': '账号被限制（删除/转存都会失败）',
            'no-scope': '无法识别当前目录',
            'list-timeout': '等列表就绪超时',
            'list-no-table': '未找到文件表格',
            'scan-incomplete': '全量扫描不完整',
            'rescan-incomplete': '删除后重扫不完整',
            'delete-unverified': '删除后卡在加载，无法复核',
            'refresh-settle-timeout': '删除后刷新卡在加载',
            'refresh-timeout': '删除后列表未就绪',
            'refresh-no-table': '找不到文件表格',
            'empty-unconfirmed': '扫到 0 行但未确认空目录',
          };
          const key = r.reason || '';
          alert(`未清理（${reasonMap[key] || key || '未知原因'}）\n\n本次未改动任何记录。`);
        }
      },
    });
    addBuiltinAction({
      label: '🗑️ 清除下载记录',
      color: '#8c2f1f',
      title: '清除本页/全部下载记录（只删记录，不删文件）',
      onclick: () => clearDlRecordsFlow(),
    });
  }

  /* 捕获阶段：修复 .listener-link-api 的 filename=+ */
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

  unsafeWindow[GATE_KEY] = GATE;

  unsafeWindow.quarkAssistant = {
    version: '6.2.0',
    isReady: () => true,
    isListPage, isSharePage,
    mountPanel, setStatus, setProgress, setActions,
    addBuiltinAction, clearBuiltinActions,
    refreshGray, setProgressLabel, showProgress, hideProgress,
    isVisible, realClick,
    sleep: (ms) => sleep(ms, true),
    until: (condition, delay, timeout) => until(condition, delay, timeout > 0 ? timeout : 0),
    untilStrict, untilOrGiveUp,
    scanFileRows, getFileIconSig,
    isFidDownloaded, isDownloading: () => downloadRunning,
    renameDlRecordNames,
    isPaused, setPaused, waitWhilePaused, isBridgeBusy,
    isListLoaded, isAccountLimited,
    autoDownloadWorkflow, clearAllSelection,
    /* 新流程 */
    gate: GATE,
    runCleanupRound,
    syncFdmFinishedDeletes,
    waitListSettled,
    scanAllRowsWithScroll,
    deleteFilesByFids,
    clearRecordsMissingFromList,
    fixFilenamePlusInUrl,
  };

  (async function boot() {
    if (!document.body) await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
    if (isListPage()) {
      mountPanel();
      setProgressLabel('已下载');
      installListPageActions();
      setStatus(isPaused() ? '已暂停' : '待机（个人页）', isPaused() ? 'running' : '');
      log(`平台层就绪（个人页${isPaused() ? '，暂停中' : ''}）v6.2.1`);
      runPersonalController();
      /* 后台补删：FDM 完成时机不受页面控制（可能在关页后、或下次打开时才完成），
       * 所以靠定时轮询把已完成的云端副本删掉，全程不阻塞界面 */
      setTimeout(() => { syncFdmFinishedDeletes().catch(() => {}); }, 5000);
      setInterval(() => { syncFdmFinishedDeletes().catch(() => {}); }, FDM_POLL_MS);
    } else if (isSharePage()) {
      log('平台层就绪（分享页，等待桥接 mountPanel）v6.2.1');
    } else {
      log('平台层就绪（其他页）v6.2.1');
    }
    startGrayPolling();
  })();
})();