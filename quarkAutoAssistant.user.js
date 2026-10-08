// ==UserScript==
// @name         QuarkAutoAssistant
// @namespace    quark-auto-save
// @version      1.0
// @description  夸克网盘平台层：UI 面板 + 原子操作 + unsafeWindow API
// @author       -
// @downloadURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/QuarkAutoAssistant.user.js
// @updateURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/QuarkAutoAssistant.user.js
// @match        https://pan.quark.cn/*
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   *  0. 常量
   * ============================================================ */
  const _1s = 1000, _1m = 60 * _1s;
  const DL_RECORD_KEY   = 'quark_auto_dl_records_v2';
  const PENDING_KEY     = 'quark_auto_save_pending';
  const PENDING_RESULT  = 'quark_auto_save_pending_result_';
  const DL_TTL          = 24 * 60 * 60 * 1000;
  const THROTTLE        = 5000;
  const IF_WAIT         = 30000;
  const IF_BODY_WAIT    = 3000;
  const BTN_WAIT        = 20000;
  const CLICK_WAIT      = 1200;
  const RESULT_WAIT     = 8000;
  const TAB_RESULT_WAIT = 45000;
  const PREFIX          = '[夸克助手]';
  const DEBUG           = true;

  const log  = (...a) => console.log(PREFIX, ...a);
  const warn = (...a) => console.warn(PREFIX, ...a);
  const dbg  = (...a) => DEBUG && console.log(PREFIX, '🔍', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(cond, delay = 50) {
    try {
      let r; delay = Math.max(50, delay);
      while (!(r = await cond())) await sleep(delay);
      return r;
    } catch (e) { console.error(e); }
  }

  /* ============================================================
   *  1. 全局样式
   * ============================================================ */
  function ensureGlobalStyle() {
    if (document.getElementById('quark-auto-style')) return;
    const style = document.createElement('style');
    style.id = 'quark-auto-style';
    style.textContent = `
    [data-quark-grayed="1"] .filename-text,
    [data-quark-grayed="1"] .filename-text *,
    [data-quark-grayed="1"] [class*="filename-text"],
    [data-quark-grayed="1"] [class*="filename-text"] *,
    [data-quark-grayed="1"] [class*="file-name"],
    [data-quark-grayed="1"] [class*="file-name"] * {
      color: #999 !important; opacity: 0.65 !important;
    }
    [data-quark-grayed="1"] [class*="file-icon"],
    [data-quark-grayed="1"] [class*="file-icon"] *,
    [data-quark-grayed="1"] img {
      filter: grayscale(1) !important; opacity: 0.5 !important;
    }
    #quark-share-progress {
      position: fixed; right: 24px; top: 100px;
      z-index: 2147483645; padding: 8px 14px;
      background: rgba(0,0,0,0.75); color: #fff;
      border-radius: 6px; font-size: 13px;
      font-family: "PingFang SC","Microsoft YaHei",sans-serif;
      pointer-events: none; user-select: none;
    }
    #quark-share-progress .num { color: #52c41a; font-weight: 700; font-size: 15px; margin: 0 3px; }
    #quark-share-progress.all-done .num { color: #faad14; }
  `;
    document.head.appendChild(style);
  }

  /* ============================================================
   *  2. 页面类型
   * ============================================================ */
  function getPageType() {
    if (/^\/s\/[a-zA-Z0-9]+/.test(location.pathname)) return 'share';
    if (location.pathname.startsWith('/list')) return 'list';
    return 'other';
  }

  /* ============================================================
   *  3. 面板
   * ============================================================ */
  let uiRefs = null;
  let _shareUIActive = false;   // 分享页 UI 是否被桥接激活
  const _builtinActions = { share: { 1: [], 2: [] }, list: { 1: [], 2: [] } };
  let _registeredActions = { share: { 1: [], 2: [] }, list: { 1: [], 2: [] } };

  function buildPanel() {
    if (uiRefs || document.getElementById('quark-auto-panel')) return;
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = 'quark-auto-panel';
    panel.innerHTML = `
    <div class="qap-header">
      <span class="qap-title">夸克助手</span>
      <span class="qap-toggle" title="折叠/展开">−</span>
    </div>
    <div class="qap-body">
      <div class="qap-row"><span class="qap-label">状态</span><span class="qap-status">待机</span></div>
      <div class="qap-row"><span class="qap-label">页面</span><span class="qap-page">-</span></div>
      <div class="qap-row qap-records-row" style="display:none;"><span class="qap-label">转存记录</span><span class="qap-records">0</span></div>
      <div class="qap-row qap-dl-records-row" style="display:none;"><span class="qap-label">下载记录</span><span class="qap-dl-records">0</span></div>
      <div class="qap-row"><span class="qap-label">进度</span><span class="qap-progress">-</span></div>

      <div class="qap-actions qap-share-only" data-page="share" data-row="1"></div>
      <div class="qap-actions qap-share-only" data-page="share" data-row="2"></div>
      <div class="qap-actions qap-personal-only" data-page="list" data-row="1"></div>
      <div class="qap-actions qap-personal-only" data-page="list" data-row="2"></div>
    </div>
  `;
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
    #quark-auto-panel .qap-actions{display:flex;gap:8px;margin-top:8px}
    #quark-auto-panel .qap-btn{flex:1;padding:6px 0;border:none;border-radius:5px;cursor:pointer;font-size:12px;color:#fff;background:#09AAFF;transition:opacity .2s}
    #quark-auto-panel .qap-btn:hover{opacity:.85}
    #quark-auto-panel .qap-btn:disabled{background:#ccc;cursor:not-allowed}
  `;
    document.head.appendChild(style);
    document.body.appendChild(panel);

    uiRefs = {
      panel,
      status:      panel.querySelector('.qap-status'),
      page:        panel.querySelector('.qap-page'),
      records:     panel.querySelector('.qap-records'),
      dlRecords:   panel.querySelector('.qap-dl-records'),
      progress:    panel.querySelector('.qap-progress'),
      toggle:      panel.querySelector('.qap-toggle'),
      recordsRow:  panel.querySelector('.qap-records-row'),
      dlRecordsRow:panel.querySelector('.qap-dl-records-row'),
      shareOnly:   panel.querySelectorAll('.qap-share-only'),
      personalOnly:panel.querySelectorAll('.qap-personal-only'),
      actionSlots: {
        share: {
          1: panel.querySelector('.qap-share-only[data-row="1"]'),
          2: panel.querySelector('.qap-share-only[data-row="2"]'),
        },
        list: {
          1: panel.querySelector('.qap-personal-only[data-row="1"]'),
          2: panel.querySelector('.qap-personal-only[data-row="2"]'),
        },
      },
    };

    uiRefs.toggle.onclick = () => {
      panel.classList.toggle('collapsed');
      uiRefs.toggle.textContent = panel.classList.contains('collapsed') ? '+' : '−';
    };

    updatePanel();
    rebuildActionsUI();
    log('UI 面板已挂载');
  }

  function updatePanel(state) {
    if (!uiRefs) return;
    const pageType = getPageType();
    uiRefs.page.textContent = pageType === 'share' ? '分享页'
      : pageType === 'list'  ? '列表页' : '其他';

    uiRefs.shareOnly.forEach(el => el.style.display = pageType === 'share' ? 'flex' : 'none');
    uiRefs.personalOnly.forEach(el => el.style.display = pageType === 'list' ? 'flex' : 'none');

    // 行显隐：
    //   转存记录行 → 分享页 + 桥接激活
    //   下载记录行 → 列表页
    if (uiRefs.recordsRow) {
      uiRefs.recordsRow.style.display = (pageType === 'share' && _shareUIActive) ? 'flex' : 'none';
    }
    if (uiRefs.dlRecordsRow) {
      uiRefs.dlRecordsRow.style.display = (pageType === 'list') ? 'flex' : 'none';
    }

    // 转存记录
    if (pageType === 'share' && _shareUIActive) {
      try {
        const recs = JSON.parse(localStorage.getItem('quark_save_records_v2') || '{}') || {};
        const now = Date.now();
        const entries = Object.values(recs);
        const valid   = entries.filter(r => now - (r.ts || 0) < DL_TTL).length;
        const expired = entries.length - valid;
        uiRefs.records.textContent = `${entries.length} (有效${valid}/过期${expired})`;
      } catch { uiRefs.records.textContent = '0'; }
    }

    // 下载记录
    if (pageType === 'list') {
      const dlRecs = loadDlRecords();
      const now2 = Date.now();
      const dlValid = Object.values(dlRecs).filter(r => {
        const ts = getDlRecTs(r);
        return ts && now2 - ts < DL_TTL;
      }).length;
      uiRefs.dlRecords.textContent = `${dlValid} 条`;
    }

    if (state) {
      if (state.status) { uiRefs.status.textContent = state.status; uiRefs.status.className = 'qap-status ' + (state.cls || ''); }
      if (state.progress != null) uiRefs.progress.textContent = state.progress;
    }
  }
  function setPanel(state) { updatePanel(state); }

  /* ============================================================
   *  4. 动态按钮
   * ============================================================ */
  function registerActions(groups) {
    if (!groups || typeof groups !== 'object') return;
    const next = { share: { 1: [], 2: [] }, list: { 1: [], 2: [] } };
    for (const page of ['share', 'list']) {
      const src = groups[page] || {};
      for (const row of [1, 2]) {
        const list = src[row] || src['row' + row] || [];
        next[page][row] = Array.isArray(list) ? list : [];
      }
    }
    _registeredActions = next;
    buildPanel();       // 幂等：桥接注册时保证面板存在
    updatePanel();
    rebuildActionsUI();
  }

  function rebuildActionsUI() {
    if (!uiRefs) return;
    for (const page of ['share', 'list']) {
      for (const row of [1, 2]) {
        const slot = uiRefs.actionSlots[page][row];
        if (!slot) continue;
        slot.innerHTML = '';
        const actions = [
          ...(_builtinActions[page]?.[row] || []),
          ...(_registeredActions[page]?.[row] || []),
        ];
        for (const a of actions) {
          const btn = document.createElement('button');
          btn.className = 'qap-btn';
          btn.textContent = a.label || '动作';
          if (a.color) btn.style.background = a.color;
          if (a.title) btn.title = a.title;
          btn.addEventListener('click', () => {
            try { a.onclick && a.onclick(); } catch (e) { warn('按钮出错', e); }
          });
          slot.appendChild(btn);
        }
      }
    }
  }

  /* ============================================================
   *  5. 文件匹配
   * ============================================================ */
  function stripCopySuffix(name) {
    if (!name) return '';
    return String(name).replace(/\s*\(\d+\)(?=\.[^.]+$)/, '');
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
    if (m) {
      const base = m[1].split('?')[0];
      const tMatch = base.match(/\/file\/([^/]+)\//);
      if (tMatch) return 'type:' + tMatch[1];
      try { return 'host:' + new URL(base).hostname; } catch { return 'url:' + base.slice(0, 80); }
    }
    const cls = (iconEl.className || '').trim();
    if (cls) return 'cls:' + cls;
    return '';
  }
  function isSameFile(a, b) {
    if (!a || !b) return false;
    if (stripCopySuffix(a.name) !== stripCopySuffix(b.name)) return false;
    const sa = String(a.sizeStr ?? '').trim();
    const sb = String(b.sizeStr ?? '').trim();
    if (sa !== sb) return false;
    const ia = String(a.iconSig ?? '').trim();
    const ib = String(b.iconSig ?? '').trim();
    if (ia && ib && ia !== ib) return false;
    return true;
  }

  /* ============================================================
   *  6. 下载记录
   * ============================================================ */
  function loadDlRecords() {
    try {
      const raw = localStorage.getItem(DL_RECORD_KEY);
      if (!raw) return {};
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
      return p;
    } catch { return {}; }
  }
  function saveDlRecords(r) {
    try {
      localStorage.setItem(DL_RECORD_KEY, JSON.stringify(r));
      window.dispatchEvent(new CustomEvent('quark-dl-records-updated'));
    } catch {}
  }
  function getDlRecTs(rec) {
    if (rec == null) return 0;
    return typeof rec === 'number' ? rec : (rec.ts || 0);
  }
  function isFidDownloaded(fid) {
    if (!fid) return false;
    const recs = loadDlRecords();
    const ts = getDlRecTs(recs[fid]);
    return typeof ts === 'number' && ts > 0 && (Date.now() - ts) <= DL_TTL;
  }
  function markFidDownloaded(fid, info) {
    if (!fid) return;
    const recs = loadDlRecords();
    recs[fid] = {
      ts: Date.now(),
      name: info?.name || '',
      sizeStr: info?.sizeStr || '',
      iconSig: info?.iconSig || '',
    };
    const now = Date.now();
    for (const k of Object.keys(recs)) {
      if (now - getDlRecTs(recs[k]) > DL_TTL) delete recs[k];
    }
    saveDlRecords(recs);
  }
  function clearDlRecordsFids(fids) {
    const recs = loadDlRecords();
    for (const fid of fids) delete recs[fid];
    saveDlRecords(recs);
  }

  /* ============================================================
   *  7. 网盘 API
   * ============================================================ */
  async function getRootFiles(pdirFid = '0', size = 200) {
    const qs = new URLSearchParams({
      pr: 'ucpro', fr: 'pc', pdir_fid: pdirFid, force: '0',
      _page: '1', _size: String(size), _sort: 'file_type:asc,updated_at:desc',
    });
    try {
      const r = await fetch(`https://drive-pc.quark.cn/1/clouddrive/file/sort?${qs}`, {
        credentials: 'include', headers: { 'Referer': 'https://pan.quark.cn/' },
      });
      const j = await r.json();
      return (j && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
    } catch (e) { warn('获取根目录失败', e); return []; }
  }
  async function getRootFileKeys() {
    const list = await getRootFiles();
    return new Set(list.map(f => `${f.file_name}|${f.fid}`));
  }
  async function diffRootNewFiles(beforeSet, waitMs = 3000) {
    await sleep(waitMs);
    const after = await getRootFiles();
    return after.filter(f => !beforeSet.has(`${f.file_name}|${f.fid}`));
  }
  async function deleteFiles(fids) {
    if (!fids || !fids.length) return null;
    const qs = new URLSearchParams({ pr: 'ucpro', fr: 'pc' });
    try {
      const r = await fetch(`https://drive-pc.quark.cn/1/clouddrive/file/delete?${qs}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Referer': 'https://pan.quark.cn/' },
        body: JSON.stringify({ filelist: fids, action_type: 2, exclude_fids: [] }),
      });
      return await r.json();
    } catch (e) { warn('删除失败', e); return null; }
  }
  function extractShareId(u) {
    const m = String(u || '').match(/\/s\/([a-zA-Z0-9]+)/);
    return m ? m[1] : '';
  }
  function normalizeUrl(u) { return String(u).split('?')[0].replace(/\/$/, ''); }

  async function fetchShareFileList(url) {
    const shareId = extractShareId(url || location.href);
    if (!shareId) return [];
    try {
      const tokenResp = await fetch(
        `https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc`,
        {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Referer': 'https://pan.quark.cn/' },
          body: JSON.stringify({ pwd_id: shareId, passcode: '' }),
        });
      const tokenData = await tokenResp.json();
      const stoken = tokenData && tokenData.data && tokenData.data.stoken;
      if (!stoken) return [];
      let pdirFid = '0';
      const m = (url || location.href).match(/\/list\/share\/([a-zA-Z0-9]+)/);
      if (m) pdirFid = m[1];
      const qs = new URLSearchParams({
        pr: 'ucpro', fr: 'pc', pwd_id: shareId, stoken,
        pdir_fid: pdirFid, force: '0', _page: '1', _size: '200',
      });
      const detailResp = await fetch(
        `https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?${qs}`,
        { credentials: 'include', headers: { 'Referer': 'https://pan.quark.cn/' } });
      const detail = await detailResp.json();
      return (detail && detail.data && Array.isArray(detail.data.list)) ? detail.data.list : [];
    } catch (e) { warn('获取分享文件列表失败', e); return []; }
  }
  async function checkShareHasFiles(url) {
    const list = await fetchShareFileList(url);
    if (!list.length) return { ok: true, fileCount: -1, folderCount: -1 };
    const fileCount   = list.filter(f => f.dir === false || f.dir === 0).length;
    const folderCount = list.filter(f => f.dir === true  || f.dir === 1).length;
    if (fileCount === 0) return { ok: false, reason: folderCount > 0 ? 'only_folders' : 'empty', fileCount, folderCount };
    return { ok: true, fileCount, folderCount };
  }

  /* ============================================================
   *  8. DOM 工具
   * ============================================================ */
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
    } catch (e) { try { el.click?.(); } catch (_) { return false; } }
    return true;
  }
  function getVisibleText(doc) {
    try { return (doc && doc.body) ? (doc.body.textContent || '') : ''; } catch { return ''; }
  }
  function findClickable(doc, patterns, excludes = [], preferSelectors = []) {
    const win = doc.defaultView || window;
    for (const sel of preferSelectors) {
      let list = [];
      try { list = [...doc.querySelectorAll(sel)]; } catch {}
      for (const el of list) {
        const text = (el.textContent || '').trim();
        if (excludes.some(p => text.includes(p))) continue;
        try {
          const cs = win.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        } catch {}
        return el;
      }
    }
    const seen = new Set();
    const candidates = [];
    const push = el => { if (el && !seen.has(el)) { seen.add(el); candidates.push(el); } };
    for (const sel of ['button', 'a', '[role="button"]', '[class*="btn"]', '[class*="Btn"]']) {
      try { doc.querySelectorAll(sel).forEach(push); } catch {}
    }
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 32) continue;
      if (excludes.some(p => text.includes(p))) continue;
      if (!patterns.some(p => text.includes(p))) continue;
      try {
        const cs = win.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        return el;
      } catch { return el; }
    }
    return null;
  }
  function scanDomFileRows() {
    const result = [];
    const seen = new Set();
    const rows = document.querySelectorAll(
      '[data-row-key], tr.ant-table-row, tr[class*="ant-table-row"]'
    );
    for (const row of rows) {
      if (row.querySelector('[class*="folder"], [class*="Folder"]')) continue;
      const nameEl = row.querySelector(
        '.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]'
      );
      if (!nameEl) continue;
      const name = (nameEl.getAttribute('title') || nameEl.textContent || '').trim();
      if (!name || seen.has(name)) continue;
      let sizeStr = '';
      const tds = row.querySelectorAll('td');
      if (tds.length >= 3) sizeStr = (tds[2].textContent || '').trim();
      const fid = row.getAttribute('data-row-key') || '';
      const iconSig = getFileIconSig(row);
      seen.add(name);
      result.push({ name, sizeStr, iconSig, fid, row });
    }
    return result;
  }
  function getSelectedOrAllFiles() {
    const all = scanDomFileRows();
    const selected = [];
    for (const f of all) {
      const cb = f.row.querySelector('input.ant-checkbox-input');
      if (cb && cb.checked) selected.push(f);
    }
    return selected.length ? selected : all;
  }

  /* ============================================================
   *  9. 文案判定
   * ============================================================ */
  const SPACE_PATTERNS = [/空间不足/, /容量不足/, /存储空间.*不足/, /剩余空间.*不足/,
                          /空间.*已满/, /容量.*已满/, /已超额/, /超出.*容量/, /请先扩容/, /开通SVIP.*空间/];
  const OVER_LIMIT_PATTERNS = [/已超过.*(每日|当天|今日).*(转存|保存)/,
                               /(每日|当天|今日).*(转存|保存).*(次数|上限|限额)/, /超过.*(每日|当天|今日).*上限/, /转存次数.*已达/];
  const FAIL_PATTERNS = [/保存失败/, /转存失败/, /分享链接.*失效/, /链接已失效/, /分享已失效/, /文件.*不存在/];
  const SUCCESS_PATTERNS = [/保存成功/, /已保存/, /转存成功/, /已添加.*网盘/, /已存入/];
  function classify(text) {
    if (!text) return 'unknown';
    for (const p of SPACE_PATTERNS)      if (p.test(text)) return 'space';
    for (const p of OVER_LIMIT_PATTERNS) if (p.test(text)) return 'over_limit';
    for (const p of FAIL_PATTERNS)       if (p.test(text)) return 'fail';
    for (const p of SUCCESS_PATTERNS)    if (p.test(text)) return 'success';
    return 'unknown';
  }

  /* ============================================================
   *  10. iframe / 保存
   * ============================================================ */
  function createHiddenIframe(url) {
    const iframe = document.createElement('iframe');
    iframe.style.cssText =
      'position:fixed;left:0;top:0;width:1200px;height:900px;opacity:0.001;pointer-events:none;border:0;z-index:-1;';
    iframe.src = url;
    document.body.appendChild(iframe);
    return iframe;
  }
  async function waitIframeReady(iframe, timeout = IF_WAIT) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const doc = iframe.contentDocument;
        if (doc && doc.readyState !== 'loading' && doc.body) {
          const bodyStart = Date.now();
          while (Date.now() - bodyStart < IF_BODY_WAIT) {
            const htmlLen = (doc.body.innerHTML || '').length;
            const textLen = (doc.body.textContent || '').trim().length;
            if (htmlLen > 500 || textLen > 50) return doc;
            await sleep(200);
          }
          return doc;
        }
      } catch (e) { throw new Error('无法访问 iframe: ' + e.message); }
      await sleep(250);
    }
    throw new Error('iframe 加载超时');
  }
  async function waitButton(doc, patterns, timeout, excludes = [], preferSelectors = []) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const btn = findClickable(doc, patterns, excludes, preferSelectors);
      if (btn) return btn;
      await sleep(300);
    }
    return null;
  }
  async function watchTextUntilResult(doc, timeout = RESULT_WAIT) {
    return new Promise(resolve => {
      const collected = [];
      const win = doc.defaultView || window;
      let finished = false;
      let timerPoll = null;
      function finish(kind) {
        if (finished) return;
        finished = true;
        try { mo.disconnect(); } catch {}
        if (timerPoll) clearInterval(timerPoll);
        resolve({ kind, text: collected.join('\n') });
      }
      const check = () => {
        const kind = classify(collected.join('\n') + '\n' + getVisibleText(doc));
        if (kind === 'success' || kind === 'space' || kind === 'over_limit' || kind === 'fail') {
          finish(kind);
          return true;
        }
        return false;
      };
      const mo = new win.MutationObserver(muts => {
        for (const m of muts) {
          if (m.type === 'childList') {
            m.addedNodes.forEach(n => {
              if (n.nodeType === 1) {
                const t = (n.textContent || '').trim();
                if (t && t.length < 500) collected.push(t);
              } else if (n.nodeType === 3) {
                const t = (n.nodeValue || '').trim();
                if (t) collected.push(t);
              }
            });
          } else if (m.type === 'characterData') {
            const t = (m.target.nodeValue || '').trim();
            if (t) collected.push(t);
          }
        }
        check();
      });
      mo.observe(doc.body, { childList: true, subtree: true, characterData: true });
      timerPoll = setInterval(check, 300);
      check();
      setTimeout(() => finish('unknown'), timeout);
    });
  }
  class SaveResult {
    constructor(kind, message, extra) {
      this.kind = kind;
      this.message = message || '';
      if (extra) Object.assign(this, extra);
    }
  }
  function closeQuarkModal(doc) {
    const selectors = [
      '.save-share-file-success-modal .ant-modal-close',
      '.ant-modal.save-share-file-success-modal .ant-modal-close',
      '.save-share-file-success-modal button.ant-modal-close',
      '.ant-modal-close',
    ];
    for (const sel of selectors) {
      const btn = doc.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        realClick(btn);
        dbg(`  关闭夸克模态框：${sel}`);
        return true;
      }
    }
    return false;
  }
  async function performSaveOnDoc(doc) {
    const href = (doc.location && doc.location.href) || '';
    if (/\/login|passport/i.test(href)) throw new SaveResult('fail', '未登录');
    const initialText = getVisibleText(doc);
    if (classify(initialText) === 'fail') throw new SaveResult('fail', '分享无效');

    log('  寻找"保存到网盘"按钮...');
    const mainBtn = await waitButton(doc,
                                     ['保存到我的网盘', '保存到网盘', '保存到夸克网盘'],
                                     BTN_WAIT, ['已保存', '取消', '关闭'],
                                     ['.share-save', 'button[class*="share-save"]', '.save-btn', 'button[class*="save"]']);
    if (!mainBtn) {
      const btnCount = doc.querySelectorAll('button').length;
      throw new SaveResult('fail', `未找到保存按钮（button 总数=${btnCount}）`);
    }
    realClick(mainBtn);
    await sleep(CLICK_WAIT);

    let kind = classify(getVisibleText(doc));
    if (kind === 'space')      throw new SaveResult('space', '空间不足（阶段1）');
    if (kind === 'over_limit') throw new SaveResult('over_limit', '超限已用尽（阶段1）');

    log('  寻找二次确认按钮...');
    const confirmBtn = await waitButton(doc,
                                        ['保存到此处', '确定保存', '确认保存', '确定', '确认'],
                                        3000, ['取消', '关闭', '保存到我的网盘', '保存到网盘'],
                                        ['.save-confirm', 'button[class*="confirm"]']);
    if (confirmBtn) { realClick(confirmBtn); await sleep(CLICK_WAIT); }

    log('  监听保存结果...');
    const { kind: finalKind, text: finalText } = await watchTextUntilResult(doc, RESULT_WAIT);
    log('  结果判定:', finalKind);

    closeQuarkModal(doc);

    if (finalKind === 'space')      throw new SaveResult('space', '空间不足');
    if (finalKind === 'over_limit') throw new SaveResult('over_limit', '超限已用尽');
    if (finalKind === 'fail')       throw new SaveResult('fail', '保存失败: ' + finalText.substring(0, 150));
    if (finalKind === 'success')    return new SaveResult('success', '');
    return new SaveResult('unknown', finalText.substring(0, 200));
  }
  async function saveViaIframe(url) {
    const iframe = createHiddenIframe(url);
    try {
      const doc = await waitIframeReady(iframe, IF_WAIT);
      const docHref = (doc.location && doc.location.href) || '';
      const bodyLen = (doc.body && doc.body.innerHTML || '').length;
      if (!docHref || /^about:blank/i.test(docHref) || bodyLen < 500) {
        return new SaveResult('iframe_failed', 'iframe 未加载');
      }
      return await performSaveOnDoc(doc);
    } finally { try { iframe.remove(); } catch {} }
  }
  async function saveViaNewTab(url) {
    const shareId = extractShareId(url);
    if (!shareId) return new SaveResult('fail', '无法解析 shareId');
    localStorage.setItem(PENDING_KEY, shareId);
    try { localStorage.removeItem(PENDING_RESULT + shareId); } catch {}
    try { GM_openInTab(url, { active: false, insert: true, setParent: true }); }
    catch (e) { localStorage.removeItem(PENDING_KEY); return new SaveResult('fail', 'GM_openInTab 失败'); }

    const start = Date.now();
    while (Date.now() - start < TAB_RESULT_WAIT) {
      try {
        const raw = localStorage.getItem(PENDING_RESULT + shareId);
        if (raw) {
          localStorage.removeItem(PENDING_RESULT + shareId);
          const parsed = JSON.parse(raw);
          return new SaveResult(parsed.kind, parsed.message || '', {
            newFiles: parsed.newFiles || [],
          });
        }
      } catch {}
      await sleep(800);
    }
    try { localStorage.removeItem(PENDING_KEY); } catch {}
    return new SaveResult('fail', '子标签页超时');
  }
  async function tryAutoSaveAsChild() {
    const m = location.pathname.match(/^\/s\/([a-zA-Z0-9]+)/);
    if (!m) return false;
    const shareId = m[1];
    const pending = localStorage.getItem(PENDING_KEY);
    if (pending !== shareId) return false;

    log('检测到子标签页任务:', shareId);
    _shareUIActive = true;
    buildPanel();
    updatePanel({ status: '子任务处理中...', cls: 'running', progress: '-' });

    const check = await checkShareHasFiles(location.href);
    if (!check.ok) {
      localStorage.setItem(PENDING_RESULT + shareId, JSON.stringify({ kind: 'skip', message: check.reason }));
      try { localStorage.removeItem(PENDING_KEY); } catch {}
      await sleep(500);
      try { window.close(); } catch {}
      return true;
    }

    const beforeSet = await getRootFileKeys();
    let result;
    try {
      await sleep(1500);
      result = await performSaveOnDoc(document);
    } catch (e) {
      result = (e instanceof SaveResult) ? e : new SaveResult('fail', String(e.message || e));
    }

    let newFiles = [];
    if (result.kind === 'success' || result.kind === 'unknown') {
      newFiles = await diffRootNewFiles(beforeSet, 3000);
    }
    localStorage.setItem(PENDING_RESULT + shareId, JSON.stringify({
      kind: result.kind,
      message: result.message || '',
      newFiles: newFiles.map(f => ({ fid: f.fid, file_name: f.file_name })),
    }));
    try { localStorage.removeItem(PENDING_KEY); } catch {}
    await sleep(800);
    try { window.close(); } catch {}
    return true;
  }

  /* ============================================================
   *  11. 置灰 + 进度条
   * ============================================================ */
  let progressEl = null;
  let _shareGrayPredicate = () => false;

  function setShareGrayPredicate(fn) {
    _shareGrayPredicate = (typeof fn === 'function') ? fn : () => false;
    _shareUIActive = true;
    buildPanel();
    updatePanel();
    refreshGray();
  }

  function updateShareProgress(existing, total) {
    ensureGlobalStyle();
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.id = 'quark-share-progress';
      document.body.appendChild(progressEl);
    }
    if (total > 0 && existing >= total) progressEl.classList.add('all-done');
    else progressEl.classList.remove('all-done');
    progressEl.innerHTML = `已下载 <span class="num">${existing}</span> / <span class="num">${total}</span>`;
    if (uiRefs && uiRefs.progress) uiRefs.progress.textContent = `${existing} / ${total}`;
  }

  function refreshGray() {
    const pageType = getPageType();

    // 分享页无桥接 → 不置灰、不显示进度条
    if (pageType === 'share' && !_shareUIActive) return { grayed: 0, total: 0 };

    ensureGlobalStyle();
    const files = scanDomFileRows();
    let grayed = 0;

    for (const f of files) {
      let hit = false;
      if (pageType === 'share') {
        try { hit = !!_shareGrayPredicate(f); } catch (e) { hit = false; }
      } else if (pageType === 'list') {
        hit = isFidDownloaded(f.fid);
      }
      if (hit) { f.row.setAttribute('data-quark-grayed', '1'); grayed++; }
      else f.row.removeAttribute('data-quark-grayed');
    }
    if (files.length > 0) updateShareProgress(grayed, files.length);
    return { grayed, total: files.length };
  }

  function startGrayPolling() {
    const tick = () => { try { refreshGray(); } catch (e) {} };
    setInterval(tick, 1000);
    let moTimer = null;
    const mo = new MutationObserver(() => {
      if (moTimer) return;
      moTimer = setTimeout(() => { moTimer = null; tick(); }, 300);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    tick();
  }

  /* ============================================================
   *  12. 排序
   * ============================================================ */
  async function waitTableLoaded(getBody, snapshot, timeout = 30 * _1s) {
    const deadline = Date.now() + timeout;
    const ready = () => {
      const now = getBody();
      if (!now) return false;
      if (now.innerHTML !== snapshot) return true;
      return !!now.querySelector('.ant-table-row');
    };
    while (!ready()) { if (Date.now() > deadline) return false; await sleep(200); }
    return true;
  }
  async function autoClickSort() {
    const getBody = () => document.querySelector('.ant-table-tbody');
    const body = await until(getBody, 250);
    if (!body) { warn('排序：未等到 .ant-table-tbody'); return; }
    const loading = body.innerHTML;
    const loaded = await waitTableLoaded(getBody, loading);
    if (!loaded) { warn('排序：表格加载超时'); return; }
    const selectors = [
      '.order-asc', '.order-desc', '[class*="order-asc"]', '[class*="order-desc"]',
      '.ant-table-column-sorter-up', '.ant-table-column-sorter-down',
      '.ant-table-column-sorter',
    ];
    let asc = null;
    const deadline = Date.now() + 15 * _1s;
    while (Date.now() < deadline) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { asc = el; break; }
      }
      if (asc) break;
      await sleep(300);
    }
    if (!asc) { warn('排序：未找到排序图标'); return; }
    const candidates = [
      asc, asc.parentElement, asc.closest('.td-file-sort'),
      asc.closest('th'), asc.closest('[role="columnheader"]'), asc.closest('[class*="sorter"]'),
    ].filter(Boolean);
    const seen = new Set();
    for (const el of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      realClick(el);
      await sleep(600);
    }
    log('排序：完成');
  }

  /* ============================================================
   *  13. 下载流程
   * ============================================================ */
  let downloadRunning = false;

  async function triggerApiDownload() {
    const btnEl = document.querySelector('.quark-button.pl-button');
    if (!btnEl) throw new Error('找不到"下载助手"按钮');
    const win = btnEl.ownerDocument.defaultView || window;
    for (const t of ['mouseenter', 'mouseover']) {
      try { btnEl.dispatchEvent(new win.MouseEvent(t, { bubbles: true, view: win })); } catch {}
    }
    const itemEl = document.querySelector('.pl-button-mode[data-mode="api"]');
    if (!itemEl) throw new Error('找不到 API 下载菜单项');
    const $ = win.jQuery || win.$;
    if ($) { try { $(itemEl).trigger('click'); } catch {} }
    await sleep(200);
    if (document.querySelector('.swal2-popup')) return;
    realClick(itemEl);
    await sleep(200);
    if (document.querySelector('.swal2-popup')) return;
    try { itemEl.click(); } catch {}
  }

  async function handleApiDialog() {
    const popup = await until(() => document.querySelector('.swal2-popup'), 250);
    if (!popup) throw new Error('未弹出 API 下载对话框');
    const link = await until(() => {
      const el = document.querySelector('.listener-link-api');
      if (el) return el;
      const err = document.querySelector('.swal2-icon.swal2-error, .swal2-icon.swal2-warning');
      if (err) throw new Error('弹窗返回错误');
      return null;
    }, 250);
    const dlink = link.dataset.link || '';
    const fname = link.dataset.filename || '';
    if (!dlink || /失败|提示|请先|异常/.test(dlink)) {
      document.querySelector('.swal2-close')?.click();
      await sleep(400);
      throw new Error('链接无效: ' + dlink.slice(0, 80));
    }
    log(`  触发下载: ${fname}`);
    realClick(link);
    await sleep(2000);
    document.querySelector('.swal2-close')?.click();
    await until(() => !document.querySelector('.swal2-popup'), 250).catch(() => {});
    await sleep(300);
  }

  async function downloadOneRow(row, fid, name) {
    const allRows = document.querySelectorAll('tr.ant-table-row, [data-row-key]');
    for (const r of allRows) {
      if (r === row) continue;
      if (r.classList.contains('ant-table-row-selected')) {
        const cb = r.querySelector('label.ant-checkbox-wrapper');
        if (cb) realClick(cb);
      }
    }
    await sleep(300);
    const label = row.querySelector('label.ant-checkbox-wrapper');
    if (!label) throw new Error('找不到 checkbox');
    const input = label.querySelector('input.ant-checkbox-input');
    if (!input || !input.checked) { realClick(label); await sleep(500); }
    const newInput = row.querySelector('input.ant-checkbox-input');
    if (!newInput || !newInput.checked) { realClick(label); await sleep(500); }
    await triggerApiDownload();
    await handleApiDialog();
  }

  function waitForApiReady() {
    return until(() => document.querySelector('.quark-button.pl-button'), 500);
  }

  function clickRefresh() {
    const selectors = ['.fl-refresh', '.fl-refresh img', '[class*="fl-refresh"]', '[class*="refresh"]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) { realClick(el); dbg(`  点击刷新：${sel}`); return true; }
    }
    warn('  找不到刷新按钮');
    return false;
  }

  async function autoDownloadWorkflow(opts = {}) {
    const { maxRounds = 3, throttle = THROTTLE, onProgress } = opts;
    if (downloadRunning) { dbg('下载任务已在运行'); return; }
    if (!location.pathname.startsWith('/list')) { warn('当前不是列表页'); return; }
    downloadRunning = true;
    log('===== 开始下载流程 =====');
    try {
      setPanel({ status: '等待下载助手...', cls: 'running', progress: '-' });
      await waitForApiReady();
      log('  下载助手已就绪');
      await sleep(800);

      for (let round = 1; round <= maxRounds; round++) {
        const files = scanDomFileRows();
        const pending = files.filter(f => f.fid && !isFidDownloaded(f.fid));
        log(`第 ${round} 轮：待下载 ${pending.length} / 共 ${files.length}`);
        if (!pending.length) { log('  无待下载文件'); break; }

        for (let i = 0; i < pending.length; i++) {
          const f = pending[i];
          const st = { status: '下载中...', cls: 'running', progress: `第${round}轮 ${i+1}/${pending.length}` };
          onProgress?.(st);
          setPanel(st);
          try {
            await downloadOneRow(f.row, f.fid, f.name);
            markFidDownloaded(f.fid, { name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig });
            refreshGray();
          } catch (e) {
            warn(`  下载失败: ${e.message}`);
            document.querySelector('.swal2-close')?.click();
            await sleep(400);
          }
          if (i < pending.length - 1) await sleep(throttle);
        }
        clickRefresh();
        await sleep(5000);
      }
      log('===== 下载完成 =====');
      setPanel({ status: '下载完成', cls: 'done', progress: '-' });
    } finally {
      downloadRunning = false;
    }
  }

  function clearDownloadRecordsFlow() {
    if (!location.pathname.startsWith('/list')) { alert('当前不是列表页'); return; }
    const files = getSelectedOrAllFiles();
    const all = scanDomFileRows();
    if (!all.length) { alert('当前页面无文件'); return; }

    const isPartial = files.length < all.length;
    if (isPartial) {
      if (!confirm(`清除 ${files.length} 个选中文件的下载记录？`)) return;
      const fids = files.map(f => f.fid).filter(Boolean);
      clearDlRecordsFids(fids);
      alert(`已清除 ${fids.length} 条`);
    } else {
      if (!confirm(`清除当前页面所有文件的下载记录？`)) return;
      const fids = all.map(f => f.fid).filter(Boolean);
      clearDlRecordsFids(fids);
      alert(`已清除 ${fids.length} 条`);
    }
    refreshGray();
    updatePanel();
  }

  /* ============================================================
   *  14. 对外接口
   * ============================================================ */
  unsafeWindow.quarkAssistant = {
    version: '2.0',

    /* 状态 */
    isReady: () => true,               // 脚本已加载，API 已暴露
    isUIBuilt: () => !!uiRefs,         // 面板是否已构建（保留原语义）
    getPageType,
    isShareUIActive: () => _shareUIActive,

    /* UI */
    buildPanel,
    setPanel,
    registerActions,
    refreshGray,
    setShareGrayPredicate,

    /* DOM */
    scanDomFileRows,
    getSelectedOrAllFiles,
    getFileIconSig,
    stripCopySuffix,
    isSameFile,

    /* 网盘 API */
    getRootFiles,
    getRootFileKeys,
    diffRootNewFiles,
    deleteFiles,
    fetchShareFileList,
    checkShareHasFiles,

    /* 转存原语 */
    performSaveOnDoc,
    saveViaIframe,
    saveViaNewTab,
    closeQuarkModal,
    normalizeUrl,
    extractShareId,

    /* 下载 */
    autoDownloadWorkflow,
    waitForApiReady,
    clickRefresh,
    isFidDownloaded,
    markFidDownloaded,
    loadDlRecords,
    saveDlRecords,
    clearDlRecordsFids,

    /* 工具 */
    realClick, sleep, until, classify, SaveResult,
    log, warn, dbg,
  };

  /* ============================================================
   *  15. 启动
   * ============================================================ */
  (async function boot() {
    if (!document.body) await new Promise(r => window.addEventListener('DOMContentLoaded', r, { once: true }));
    ensureGlobalStyle();

    const isChild = await tryAutoSaveAsChild();
    if (isChild) return;

    const pageType = getPageType();

    if (pageType === 'list') {
      _builtinActions.list[1] = [{
        label: '⬇️ 下载', color: '#52c41a',
        title: '下载未下载过的文件（网盘助手）',
        onclick: () => autoDownloadWorkflow(),
      }];
      _builtinActions.list[2] = [{
        label: '🗑️ 清除下载记录', color: '#8c2f1f',
        title: '清除选中/全部文件的下载记录',
        onclick: () => clearDownloadRecordsFlow(),
      }];
      buildPanel();
      setPanel({ status: '待机（列表页）', cls: '', progress: '-' });
      log('夸克助手就绪（列表页）');
    } else if (pageType === 'share') {
      // 分享页：不构建面板，等桥接激活
      setTimeout(() => autoClickSort().catch(() => {}), 2000);
      log('夸克助手就绪（分享页，等待桥接）');
    } else {
      log('夸克助手就绪（其他页面）');
    }

    startGrayPolling();
  })();

  /* ============================================================
   *  16. 菜单
   * ============================================================ */
  GM_registerMenuCommand('⬇️ 立即执行下载', () => {
    if (downloadRunning) { alert('进行中'); return; }
    autoDownloadWorkflow();
  });

})();