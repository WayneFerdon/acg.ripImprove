// ==UserScript==
// @name acg.ripImprove.Bridge2QuarkPan
// @namespace http://tampermonkey.net/
// @version 3.0.7
// @description acg.rip 桥接：夸克转存业务编排（全表一次滚动 + 内存缓存；单行定位优先可见区 + 估计位置；表头状态快速返回）
// @match *://acg.rip/*
// @match https://pan.quark.cn/*
// @grant GM_setValue
// @grant GM_getValue
// @grant GM_openInTab
// @grant GM_registerMenuCommand
// @grant GM_addValueChangeListener
// @grant unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const HOST = location.hostname;
  const IS_QUARK = /^pan\.quark\.cn$/i.test(HOST);
  const IS_ACGRIP = /^acg\.rip$/i.test(HOST);
  if (!IS_QUARK && !IS_ACGRIP) return;

  const GM_BANGUMI = 'bangumiData';
  const GM_FOLDER = 'setting_quark_folder_id';
  const GM_CD = 'acgrip_quark_check_state';
  const GM_RECORDS = 'acgrip_quark_records';
  const GM_PENDING_URLS = 'acgrip_bridge_pending_urls';
  const GM_AUTO_TRIGGER = 'acgrip_bridge_auto_trigger';
  const GM_CLEAR_FLAG = 'acgrip_quark_clear_records_flag';
  const GM_TASKS = 'acgrip_bridge_tasks';
  const GM_RESULTS = 'acgrip_bridge_results';
  const BUSY_KEY = 'acgrip_bridge_busy';

  const TASK_TTL = 3 * 60 * 1000;
  const TAB_RESULT_TIMEOUT = 90 * 1000;

  const SAVE_TTL = 24 * 60 * 60 * 1000;
  const BASE_CD = 30 * 60 * 1000;
  const MAX_CD = 7 * 24 * 60 * 60 * 1000;
  const AUTO_TTL = 5 * 60 * 1000;

  const log = (...a) => console.log('[桥接]', ...a);
  const warn = (...a) => console.warn('[桥接]', ...a);

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

  /* ★ 直接存原生类型；读时兼容旧的 JSON 字符串 */
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

  /* ============================================================
 * 跨标签页通信
 * ============================================================ */
  function _pruneByTTL(m, ttl) {
    const now = Date.now();
    let dirty = false;
    for (const k of Object.keys(m)) {
      if (now - (m[k].ts || 0) > ttl) { delete m[k]; dirty = true; }
    }
    return dirty;
  }

  function setTask(shareId, url) {
    const m = gmGet(GM_TASKS, {}) || {};
    _pruneByTTL(m, TASK_TTL);
    m[shareId] = { url, ts: Date.now() };
    gmSet(GM_TASKS, m);
  }
  function consumeTask(shareId) {
    const m = gmGet(GM_TASKS, {}) || {};
    _pruneByTTL(m, TASK_TTL);
    const t = m[shareId] || null;
    if (t) delete m[shareId];
    gmSet(GM_TASKS, m);
    return t;
  }
  function clearTask(shareId) {
    const m = gmGet(GM_TASKS, {}) || {};
    if (m[shareId]) { delete m[shareId]; gmSet(GM_TASKS, m); }
  }

  function setResult(shareId, obj) {
    const m = gmGet(GM_RESULTS, {}) || {};
    _pruneByTTL(m, TAB_RESULT_TIMEOUT);
    m[shareId] = { ...obj, ts: Date.now() };
    gmSet(GM_RESULTS, m);
  }
  function consumeResult(shareId) {
    const m = gmGet(GM_RESULTS, {}) || {};
    _pruneByTTL(m, TAB_RESULT_TIMEOUT);
    const r = m[shareId] || null;
    if (r) delete m[shareId];
    gmSet(GM_RESULTS, m);
    return r;
  }
  function clearResult(shareId) {
    const m = gmGet(GM_RESULTS, {}) || {};
    if (m[shareId]) { delete m[shareId]; gmSet(GM_RESULTS, m); }
  }

  function cleanupBridgeComm() {
    const tasks = gmGet(GM_TASKS, {}) || {};
    if (_pruneByTTL(tasks, TASK_TTL)) gmSet(GM_TASKS, tasks);
    const results = gmGet(GM_RESULTS, {}) || {};
    if (_pruneByTTL(results, TAB_RESULT_TIMEOUT)) gmSet(GM_RESULTS, results);
  }

  function getFolderId() {
    const v = GM_getValue(GM_FOLDER, '');
    if (v == null) return '';
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.startsWith('"') && s.endsWith('"')) {
        try { return String(JSON.parse(s)); } catch {}
      }
      return v;
    }
    return String(v);
  }
  function isSameFile(a, b) {
    if (!a || !b) return false;
    if (a.name !== b.name) return false;
    const sa = String(a.sizeStr ?? '').trim();
    const sb = String(b.sizeStr ?? '').trim();
    if (!sa || !sb) return true;
    return sa === sb;
  }

  function normalizeShareKey(url) {
    const m = String(url || '').match(/\/s\/([a-zA-Z0-9]+)/);
    return m ? `https://pan.quark.cn/s/${m[1]}` : String(url).split('?')[0].replace(/\/$/, '');
  }
  function extractShareId(url) {
    const m = String(url || '').match(/\/s\/([a-zA-Z0-9]+)/);
    return m ? m[1] : '';
  }
  function currentCacheKey() {
    return extractShareId(location.href) || 'default';
  }

  /* ============================================================
 * bangumiData
 * ============================================================ */
  function loadBangumiData() {
    if (IS_ACGRIP) {
      try {
        const lsRaw = localStorage.getItem(GM_BANGUMI);
        if (lsRaw) {
          const d = JSON.parse(lsRaw);
          if (d && Array.isArray(d.rows)) {
            try { GM_setValue(GM_BANGUMI, lsRaw); } catch {}
            return d;
          }
        }
      } catch {}
    }
    return gmGet(GM_BANGUMI, null);
  }

  function expandUrl(url, row) {
    if (!url) return url;
    const ep = String(Number(row && row.下集) || 1);
    const pad2 = s => String(s).length >= 2 ? s : String(s).padStart(2, '0');
    return String(url).replace(/@@|@/g, m => m === '@@' ? pad2(ep) : ep);
  }

  function shouldIncludeRow(row) {
    if (typeof row._airDate === 'number' && row._airDate > 0) return row._airDate <= Date.now();
    return true;
  }

  function collectShareUrls(bd) {
    if (!bd || !Array.isArray(bd.rows)) return [];
    const urls = new Set();
    for (const row of bd.rows) {
      if (!shouldIncludeRow(row)) continue;
      for (const f of ['资源', '规则']) {
        const raw = expandUrl(String(row[f] || '').trim(), row);
        const m = raw.match(/https?:\/\/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)([^\s]*)/);
        if (!m) continue;
        const shareId = m[1], suffix = m[2] || '';
        const hashIdx = suffix.indexOf('#');
        const hash = hashIdx >= 0 ? suffix.substring(hashIdx) : '';
        urls.add(`https://pan.quark.cn/s/${shareId}${hash}`.replace(/\/$/, ''));
      }
    }
    return [...urls];
  }

  /* ============================================================
 * 转存记录
 * ============================================================ */
  function loadRecords() {
    const clearTs = Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
    if (clearTs > 0) {
      gmSet(GM_RECORDS, {});
      GM_setValue(GM_CLEAR_FLAG, 0);
      log(`★ 响应清空请求，转存记录已清空（ts=${clearTs}）`);
      return {};
    }
    const recs = gmGet(GM_RECORDS, {});
    const now = Date.now();
    for (const k of Object.keys(recs)) {
      if (now - (recs[k].ts || 0) > SAVE_TTL) delete recs[k];
    }
    return recs;
  }
  function saveRecords(recs) { gmSet(GM_RECORDS, recs); }

  function collectSavedInfos(records) {
    return Object.values(records).flatMap(r => Array.isArray(r.fileInfos) ? r.fileInfos : []);
  }
  function isFileSaved(file, savedInfos) {
    if (!Array.isArray(savedInfos)) return false;
    return savedInfos.some(si => isSameFile(si, file));
  }

  function isFolderFile(f) {
    if (!f) return false;
    if (f.isFolder === true || f.isDir === true || f.type === 'folder' || f.kind === 'folder') return true;
    const row = f.row;
    if (!row || typeof row.querySelector !== 'function') return false;
    return !!(
      row.querySelector('.anticon-folder') ||
      row.querySelector('.anticon-folder-open') ||
      row.querySelector('[class*="icon-folder"]') ||
      row.querySelector('[class*="folder-icon"]') ||
      row.querySelector('svg[data-icon="folder"]')
    );
  }

  /* ============================================================
 * ★ 全表缓存（避免反复滚动）
 * ============================================================ */
  let _allFilesCache = null;
  const ALL_FILES_CACHE_TTL = 60 * 1000;

  function setAllFilesCache(key, files) {
    _allFilesCache = { key, files, ts: Date.now() };
  }
  function getAllFilesCache(key) {
    if (!_allFilesCache) return null;
    if (key && _allFilesCache.key !== key) return null;
    if (Date.now() - _allFilesCache.ts > ALL_FILES_CACHE_TTL) return null;
    return _allFilesCache.files;
  }
  function clearAllFilesCache() { _allFilesCache = null; }

  /* ============================================================
 * 虚拟滚动支持
 * ============================================================ */
  function getTableBody(doc = document) {
    return doc.querySelector('.ant-table-body');
  }

  function isVirtualScrolling(body) {
    if (!body) return false;
    const inner = body.firstElementChild;
    if (!inner) return false;
    const innerH = inner.getBoundingClientRect().height
    || parseFloat(getComputedStyle(inner).height) || 0;
    return innerH > body.clientHeight + 50;
  }

  function getShareFileCount(doc = document) {
    try {
      const sels = ['.info-stat span', '.share-info .info-stat span'];
      for (const sel of sels) {
        for (const el of doc.querySelectorAll(sel)) {
          const t = (el.textContent || '').trim();
          const m = t.match(/共\s*(\d+)\s*个/);
          if (m) return Number(m[1]);
        }
      }
    } catch {}
    return null;
  }

  /* ★ 滚动遍历：检测 loading tr，不做无谓等待；harvest 总是覆盖最新状态 */
  async function scanAllRowsByScroll(qa, doc = document, opts = {}) {
    const useCache = opts.useCache === true;
    const key = opts.key || null;

    if (useCache && key) {
      const cached = getAllFilesCache(key);
      if (cached) {
        log(` ★ 复用缓存：${cached.length} 行`);
        return cached;
      }
    }

    const maxMs = opts.maxMs || 40000;
    const expected = getShareFileCount(doc);

    const body = getTableBody(doc);
    if (!body || !isVirtualScrolling(body)) {
      const rows = qa.scanFileRows(doc);
      if (useCache && key) setAllFilesCache(key, rows);
      return rows;
    }

    /* ★ 检测"加载更多"指示器 */
    const hasLoadingMore = () => !!doc.querySelector(
      '.recent-loading-tr .ant-spin-spinning, ' +
      'tr[data-row-config-type="more"] .ant-spin-spinning'
    );

    const startTop = body.scrollTop;
    const t0 = Date.now();
    const visited = new Map();
    const seenNames = new Set();

    const harvest = () => {
      const rows = qa.scanFileRows(doc);
      let added = 0;
      for (const r of rows) {
        if (!seenNames.has(r.name)) { added++; seenNames.add(r.name); }
        visited.set(r.name, r); // 总是覆盖最新状态（含 checked）
      }
      return added;
    };

    /* ① 滚到顶部 */
    body.scrollTop = 0;
    await qa.sleep(150);
    harvest();

    let lastScrollH = body.scrollHeight;
    let lastSize = visited.size;
    let stallCount = 0;
    const MAX_STALL_BOTTOM = 3; // 到底：连续 3 次"无 loading + 无新增 + 高度不变"
    const MAX_STALL_MID = 4; // 中途：连续 4 次"无新增"

    while (Date.now() - t0 < maxMs) {
      if (expected && visited.size >= expected) break;

      const bodyH = body.clientHeight;
      const scrollH = body.scrollHeight;
      const curTop = body.scrollTop;
      const atBottom = curTop + bodyH >= scrollH - 8;

      if (atBottom) {
        /* ★ 到底：根据 loading 状态决定等待时长 */
        if (hasLoadingMore()) {
          // 有加载中 → 等它消失（最多 1500ms）
          await qa.until(() => !hasLoadingMore(), 60, 1500);
        } else {
          // 无加载中 → 只等 100ms，没有新内容就认到底
          await qa.sleep(100);
        }

        const added = harvest();
        const newH = body.scrollHeight;

        if (newH > lastScrollH + 4) {
          lastScrollH = newH;
          lastSize = visited.size;
          stallCount = 0;
          continue;
        }

        if (added === 0 && visited.size === lastSize && !hasLoadingMore()) {
          stallCount++;
          if (stallCount >= MAX_STALL_BOTTOM) break;
        } else {
          stallCount = 0;
        }
        lastSize = visited.size;
        continue;
      }

      /* ③ 未到底：向下滚一屏（0.8 倍视口，保证 ~20% 重叠） */
      const step = Math.max(200, Math.floor(bodyH * 0.8));
      body.scrollTop = Math.min(curTop + step, scrollH);
      await qa.sleep(100);

      const added = harvest();
      if (added === 0) {
        stallCount++;
        if (stallCount >= MAX_STALL_MID) break;
      } else {
        stallCount = 0;
      }
      lastSize = visited.size;
      lastScrollH = body.scrollHeight;
    }

    await qa.sleep(200);
    harvest();

    body.scrollTop = startTop;
    await qa.sleep(120);

    log(` ★ 滚动扫描：收集 ${visited.size} 行（期望 ${expected || '?'} / 视口 ${body.clientHeight}px / 总高 ${body.scrollHeight}px）`);

    const result = [...visited.values()];
    if (useCache && key) setAllFilesCache(key, result);
    return result;
  }

  /* ★ 滚动收集"所有被勾选的行"（partial 场景用） */
  async function scanCheckedRowsByScroll(qa, doc = document, opts = {}) {
    const cacheKey = opts.cacheKey || null;
    const body = getTableBody(doc);
    if (!body || !isVirtualScrolling(body)) {
      return qa.scanFileRows(doc).filter(f => f.checked);
    }
    const all = await scanAllRowsByScroll(qa, doc, { key: cacheKey, useCache: false });
    return all.filter(f => f.checked);
  }

  /* ★ 滚动定位单行
 * ① 可见区优先
 * ② 用缓存 index 估计滚动位置
 * ③ 附近小范围扫
 * ④ 回退：从当前分别向上/向下顺序扫
 */
  async function scrollToRowByName(qa, doc, name, opts = {}) {
    const body = getTableBody(doc);
    if (!body) return null;

    /* ① 可见区优先 */
    let hit = qa.scanFileRows(doc).find(f => f.name === name);
    if (hit) return hit;

    if (!isVirtualScrolling(body)) return null;

    const startTop = body.scrollTop;
    const bodyH = body.clientHeight;
    const totalH = body.scrollHeight;
    const step = Math.max(150, bodyH - 80);
    const maxMs = opts.maxMs || 6000;
    const t0 = Date.now();

    /* ② 估计位置 */
    const key = opts.cacheKey || null;
    let estTop = null;
    if (key) {
      const cached = getAllFilesCache(key);
      if (cached && cached.length > 0) {
        const idx = cached.findIndex(f => f.name === name);
        if (idx >= 0) {
          const maxTop = Math.max(0, totalH - bodyH);
          const rowH = totalH / cached.length;
          estTop = Math.max(0, Math.min(maxTop, idx * rowH - bodyH / 2 + rowH / 2));
        }
      }
    }

    if (estTop != null) {
      body.scrollTop = estTop;
      await qa.sleep(120);
      hit = qa.scanFileRows(doc).find(f => f.name === name);
      if (hit) return hit;

      const lo = Math.max(0, estTop - bodyH * 2);
      const hi = Math.min(totalH - bodyH, estTop + bodyH * 2);
      for (let pos = lo; pos <= hi && Date.now() - t0 < maxMs; pos += step) {
        body.scrollTop = pos;
        await qa.sleep(80);
        hit = qa.scanFileRows(doc).find(f => f.name === name);
        if (hit) return hit;
      }
    }

    /* ③ 回退 */
    for (const dir of [-1, +1]) {
      let pos = startTop;
      while (Date.now() - t0 < maxMs) {
        pos += dir * step;
        if (pos < 0 || pos > totalH - bodyH) break;
        body.scrollTop = pos;
        await qa.sleep(80);
        hit = qa.scanFileRows(doc).find(f => f.name === name);
        if (hit) return hit;
      }
    }

    body.scrollTop = startTop;
    await qa.sleep(60);
    return null;
  }

  /* ============================================================
 * 全量进度刷新
 * ============================================================ */
  /* ============================================================
 * ★ 分享页置灰 + 进度（由桥接自主维护）
 * ============================================================ */
  const SHARE_GRAY_CLASS = 'qap-grayed';
  let _shareFullCounts = null; // { num, total } | null

  /* 对当前可见区行应用"已转存"灰置 */
  function applyShareGray(qa, doc = document) {
    const files = qa.scanFileRows(doc);
    const recs = loadRecords();
    const savedInfos = collectSavedInfos(recs);
    let grayed = 0;
    for (const f of files) {
      if (isFileSaved(f, savedInfos)) { f.row.classList.add(SHARE_GRAY_CLASS); grayed++; }
      else f.row.classList.remove(SHARE_GRAY_CLASS);
    }
    return { grayed, total: files.length };
  }

  /* 设置 / 清除分享页进度数字 */
  function setShareFullCounts(qa, num, total) {
    if (typeof num === 'number' && typeof total === 'number' && total > 0) {
      _shareFullCounts = { num, total };
      qa.showProgress(num, total, '已转存');
      qa.setProgress(`${num} / ${total}`);
    } else {
      _shareFullCounts = null;
      qa.hideProgress();
      qa.setProgress('-');
    }
  }

  /* 一次 UI 刷新：置灰 + 进度（进度未设置时保持 '-'） */
  function refreshShareUI(qa, doc = document) {
    applyShareGray(qa, doc);
    if (_shareFullCounts) {
      qa.showProgress(_shareFullCounts.num, _shareFullCounts.total, '已转存');
      qa.setProgress(`${_shareFullCounts.num} / ${_shareFullCounts.total}`);
    }
  }

  /* 分享页轮询：可见区置灰 + 进度（不滚动、不全表扫描） */
  function startSharePolling(qa) {
    const tick = () => { try { refreshShareUI(qa); } catch {} };
    setInterval(tick, 800);
    let moTimer = null;
    const mo = new MutationObserver(() => {
      if (moTimer) return;
      moTimer = setTimeout(() => { moTimer = null; tick(); }, 200);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    tick();
  }

  /* 全量进度：仅在用户点击按钮后或子任务中主动调用 */
  async function refreshShareFullCounts(qa, doc = document) {
    try {
      const key = currentCacheKey();
      const allFiles = (await scanAllRowsByScroll(qa, doc, { key, useCache: true }) || [])
      .filter(f => !isFolderFile(f));
      if (!allFiles.length) return;
      const recs = loadRecords();
      const savedInfos = collectSavedInfos(recs);
      const savedCount = allFiles.filter(f => isFileSaved(f, savedInfos)).length;
      setShareFullCounts(qa, savedCount, allFiles.length);
      log(`★ 全量进度：${savedCount} / ${allFiles.length}`);
    } catch (e) { warn('全量进度统计失败', e); }
  }
  async function refreshFullCounts(qa, doc = document) {
    try {
      const key = currentCacheKey();
      const allFiles = (await scanAllRowsByScroll(qa, doc, { key, useCache: true }) || [])
      .filter(f => !isFolderFile(f));
      if (!allFiles.length) return;
      const recs = loadRecords();
      const savedInfos = collectSavedInfos(recs);
      const savedCount = allFiles.filter(f => isFileSaved(f, savedInfos)).length;
      if (qa.setFullCounts) qa.setFullCounts(savedCount, allFiles.length);
      log(`★ 全量进度：${savedCount} / ${allFiles.length}`);
    } catch (e) { warn('全量进度统计失败', e); }
  }

  /* ============================================================
 * 排序
 * ============================================================ */
  function findTimeSortHeader(doc = document) {
    const ths = doc.querySelectorAll('th.td-file-sort');
    for (const th of ths) {
      const title = (th.querySelector('.ant-table-column-title')?.textContent || '').trim();
      if (/修改日期|修改时间/.test(title)) return th;
    }
    return null;
  }

  function getThSortState(th) {
    const el = th && th.querySelector('.table-order');
    if (!el) return 'none';
    if (el.classList.contains('order-desc')) return 'desc';
    if (el.classList.contains('order-asc')) return 'asc';
    return 'none';
  }

  async function ensureTimeDescSort(qa, doc = document, opts = {}) {
    const interval = opts.interval ?? 200;
    const headerTimeout = opts.headerTimeout ?? 15000;
    const settleTimeout = opts.settleTimeout ?? 6000;
    const maxTries = opts.maxTries ?? 4;

    const th0 = await until(() => findTimeSortHeader(doc), interval, headerTimeout);
    if (!th0) {
      warn(` 排序：${headerTimeout}ms 内未找到"修改日期"表头，按无目标处理，跳过`);
      return { ok: false, reason: 'no-th' };
    }
    if (getThSortState(th0) === 'desc') {
      log(' 排序：已是"修改日期"降序');
      return { ok: true, method: 'already' };
    }

    for (let i = 0; i < maxTries; i++) {
      const th = findTimeSortHeader(doc);
      if (!th) {
        warn(' 排序：点击过程中表头消失，按无目标处理');
        return { ok: false, reason: 'no-th-midway' };
      }
      if (getThSortState(th) === 'desc') {
        log(` 排序：已切到降序（第 ${i} 次点击后）`);
        return { ok: true, method: i === 0 ? 'already' : 'clicked', tries: i };
      }

      const before = getThSortState(th);
      const target = th.querySelector('.table-order') || th;
      log(` 排序：第 ${i + 1} 次点击（当前状态=${before}）`);
      try {
        if (qa && typeof qa.realClick === 'function') qa.realClick(target);
        else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch {
        try { target.click(); } catch {}
      }

      const got = await until(() => {
        const cur = findTimeSortHeader(doc);
        if (!cur) return null;
        const st = getThSortState(cur);
        if (st === 'desc') return { done: true, st };
        if (st !== before) return { done: false, st };
        return null;
      }, interval, settleTimeout);

      if (got && got.done) {
        log(` 排序：第 ${i + 1} 次点击后 → 降序 ✔`);
        return { ok: true, method: 'clicked', tries: i + 1 };
      }
    }

    warn(` 排序：${maxTries} 次点击后仍未切到降序，放弃（继续原流程）`);
    return { ok: false, reason: 'cannot-desc' };
  }

  /* ============================================================
 * 转存原语
 * ============================================================ */
  function _isVisible(el) {
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

  function isSuccessModalPresent(doc = document) {
    const m = doc.querySelector('.save-share-file-success-modal');
    if (!m) return false;
    try {
      const wrap = m.closest('.ant-modal-wrap') || m.closest('.ant-modal-root') || m;
      const cs = (wrap.ownerDocument.defaultView || window).getComputedStyle(wrap);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      const r = m.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
    } catch { return false; }
    return true;
  }

  function scanIframeErrors(doc = document) {
    let text = '';
    const winW = doc.documentElement.clientWidth;
    const winH = doc.documentElement.clientHeight;

    for (const f of doc.querySelectorAll('iframe')) {
      let idoc = null;
      try { idoc = f.contentDocument; } catch {}

      if (idoc && idoc.body) {
        try {
          let hit = false;
          for (const sel of [
            '.ant-message-notice', '.ant-notification-notice', '.swal2-popup',
            '[role="alert"]', '[role="dialog"]',
            '[class*="toast"]', '[class*="error"]', '[class*="message"]',
          ]) {
            for (const el of idoc.querySelectorAll(sel)) {
              const t = (el.textContent || '').trim();
              if (t) { text += ' ' + t; hit = true; }
            }
          }
          if (!hit) {
            const bodyText = (idoc.body.innerText || '').trim();
            if (bodyText) text += ' ' + bodyText.slice(0, 800);
          }
        } catch {}
        continue;
      }

      try {
        const cs = (f.ownerDocument.defaultView || window).getComputedStyle(f);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = f.getBoundingClientRect();
        const w = r.width || parseFloat(cs.width) || 0;
        const h = r.height || parseFloat(cs.height) || 0;
        const z = parseInt(cs.zIndex, 10);
        const isFullScreen = w >= winW * 0.9 && h >= winH * 0.9;
        const isOnTop = !isNaN(z) && z >= 0;
        if (isFullScreen && isOnTop) {
          text += ' 空间不足 扩容';
          log(`[桥接] 跨域 iframe #${f.id || ''} 全屏展示（w=${Math.round(w)} h=${Math.round(h)} z=${z}）→ 视为空间不足`);
        }
      } catch {}
    }
    return text;
  }

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

  async function waitSaveButtonReady(qa, doc = document, timeout = 8000) {
    const btn = await qa.until(() => {
      const b = findSaveButton(doc);
      if (!b) return null;
      if (b.disabled) return null;
      if (b.classList.contains('ant-btn-loading')) return null;
      if (b.querySelector('.anticon-loading')) return null;
      return b;
    }, 100, timeout);
    return !!btn;
  }

  function clickSaveButton(qa, doc = document) {
    const btn = findSaveButton(doc);
    if (!btn) throw new Error('未找到"保存到网盘"按钮');
    qa.realClick(btn);
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
          if (_isVisible(el)) return el;
        }
      } catch {}
    }
    return null;
  }

  function findSaveDialog(doc = document) {
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
          if (!_isVisible(el)) continue;
          const cbs = el.querySelectorAll('input[type="checkbox"], input.ant-checkbox-input');
          if (cbs.length) return el;
        }
      } catch {}
    }
    return null;
  }

  async function clickConfirmInDialog(qa, doc = document, timeout = 6000) {
    const scope = findSaveDialog(doc) || findVisibleModal(doc) || doc;
    const texts = ['保存到此处', '确定保存', '确认保存', '确定', '确认'];
    const ok = await qa.until(() => {
      for (const t of texts) {
        for (const el of scope.querySelectorAll('button')) {
          const txt = (el.textContent || '').trim();
          if (txt === t && _isVisible(el)) { qa.realClick(el); return true; }
        }
      }
      return false;
    }, 100, timeout);
    if (!ok) {
      const btns = [...scope.querySelectorAll('button')]
      .map(b => (b.textContent || '').trim()).filter(Boolean);
      warn('clickConfirmInDialog 未找到确认按钮，scope 内按钮：', btns);
    }
    return !!ok;
  }

  function closeDialog(qa, doc = document) {
    const sels = [
      '.save-share-file-success-modal .ant-modal-close',
      '.ant-modal-close', '.swal2-close', '[class*="modal-close"]',
    ];
    for (const sel of sels) {
      try {
        for (const el of doc.querySelectorAll(sel)) {
          if (el.isConnected) { qa.realClick(el); return true; }
        }
      } catch {}
    }
    return false;
  }

  const P = {
    space: [
      /空间不足/, /容量不足/, /存储空间.*不足/, /剩余空间.*不足/,
      /空间.*已满/, /请先扩容/, /配额.*不足/, /空间.*不够/,
      /无法保存.*空间/, /保存.*空间不足/,
    ],
    over: [/已超过.*(每日|当天|今日).*(转存|保存)/, /(每日|当天|今日).*(转存|保存).*(次数|上限|限额)/, /转存次数.*已达/],
    fail: [/保存失败/, /转存失败/, /分享链接.*失效/, /链接已失效/, /分享已失效/, /文件.*不存在/],
    ok: [/保存成功/, /已保存/, /转存成功/, /已添加.*网盘/, /已存入/],
  };
  function classify(text) {
    if (!text) return 'unknown';
    for (const p of P.space) if (p.test(text)) return 'space';
    for (const p of P.over) if (p.test(text)) return 'over_limit';
    for (const p of P.fail) if (p.test(text)) return 'fail';
    for (const p of P.ok) if (p.test(text)) return 'success';
    return 'unknown';
  }

  function detectResultQuick(doc = document) {
    let text = '';
    try {
      for (const sel of ['.swal2-popup', '.ant-message-notice', '.ant-notification-notice']) {
        for (const el of doc.querySelectorAll(sel)) {
          if (_isVisible(el)) text += ' ' + (el.textContent || '');
        }
      }
    } catch {}
    text += ' ' + scanIframeErrors(doc);
    const k = classify(text);
    if (k === 'space' || k === 'over_limit' || k === 'fail') return k;
    return null;
  }

  async function waitResult(qa, doc = document, timeout = 8000) {
    const check = () => {
      let text = '';
      try {
        for (const sel of ['.swal2-popup', '.ant-message-notice', '.ant-notification-notice']) {
          for (const el of doc.querySelectorAll(sel)) {
            if (_isVisible(el)) text += ' ' + (el.textContent || '');
          }
        }
      } catch {}
      text += ' ' + scanIframeErrors(doc);

      const k = classify(text);
      if (k === 'space' || k === 'over_limit' || k === 'fail') return k;

      if (isSuccessModalPresent(doc)) return 'success';
      return null;
    };

    const r = await qa.until(check, 50, timeout);
    log('[桥接] waitResult 判定:', r || 'unknown');
    return r || 'unknown';
  }

  async function waitAllModalsGone(qa, doc, timeout = 2000) {
    const anyVisible = () => {
      const sel = '.ant-modal-wrap, .ant-modal-mask, .swal2-container, .save-share-file-success-modal';
      for (const el of doc.querySelectorAll(sel)) {
        if (!el.isConnected) continue;
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    };
    await qa.until(() => !anyVisible(), 50, timeout);
  }

  async function clickSaveOnce(qa, doc = document) {
    for (let i = 0; i < 4; i++) {
      if (!isSuccessModalPresent(doc)) break;
      try { closeDialog(qa, doc); } catch {}
      const gone = await qa.until(() => !isSuccessModalPresent(doc), 100, 1200);
      if (gone) break;
      const m = doc.querySelector('.save-share-file-success-modal');
      try { m && m.parentNode && m.parentNode.removeChild(m); } catch {}
      await sleep(150);
    }

    await waitAllModalsGone(qa, doc, 3000);
    await sleep(150);

    log(' → 等保存按钮就绪');
    const ready = await waitSaveButtonReady(qa, doc, 8000);
    if (!ready) {
      warn(' ⚠️ 保存按钮未就绪（loading/disabled）');
      return 'fail';
    }

    log(' → 点击保存按钮');
    try { clickSaveButton(qa, doc); } catch (e) {
      warn(' ⚠️ clickSaveButton 失败：', e);
      return 'fail';
    }

    const outcome = await qa.until(() => {
      const err = detectResultQuick(doc);
      if (err) return { type: 'error', kind: err };
      if (isSuccessModalPresent(doc)) return { type: 'success' };
      const dlg = findSaveDialog(doc);
      if (dlg) return { type: 'dialog' };
      return null;
    }, 100, 12000);

    if (!outcome) {
      warn(' ⚠️ 12s 内无任何结果信号');
      return 'unknown';
    }

    if (outcome.type === 'success') {
      log(' → 保存成功（成功模态框已出现）');
      try { closeDialog(qa, doc); } catch {}
      return 'success';
    }

    if (outcome.type === 'error') {
      log(` → 直接收到错误：${outcome.kind}`);
      try { closeDialog(qa, doc); } catch {}
      return outcome.kind;
    }

    log(' → 保存对话框已出现');
    const clicked = await clickConfirmInDialog(qa, doc, 6000);
    if (!clicked) warn(' ⚠️ 未点到确认按钮');

    const result = await waitResult(qa, doc, 8000);
    try { closeDialog(qa, doc); } catch {}
    return result;
  }

  /* ============================================================
 * 行 checkbox
 * ============================================================ */
  function getRowCheckbox(row) {
    return row.querySelector('input.ant-checkbox-input, input[type="checkbox"]');
  }

  async function setRowCheckbox(qa, row, desired) {
    const isDesired = () => {
      const c = getRowCheckbox(row);
      return c && !!c.checked === !!desired ? c : null;
    };

    let cb = getRowCheckbox(row);
    if (!cb) return { ok: false, method: 'no-checkbox' };
    if (!!cb.checked === !!desired) return { ok: true, method: 'already' };

    try { cb.click(); } catch {}
    if (await until(isDesired, 80, 500)) return { ok: true, method: 'native-click' };

    cb = getRowCheckbox(row);
    if (cb) {
      try {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
        setter.call(cb, desired);
        cb.dispatchEvent(new Event('input', { bubbles: true }));
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {}
      if (await until(isDesired, 80, 500)) return { ok: true, method: 'react-setter' };
    }

    cb = getRowCheckbox(row);
    if (cb) {
      const label = cb.closest('label') || row.querySelector('label.ant-checkbox-wrapper');
      if (label) qa.realClick(label);
      if (await until(isDesired, 80, 500)) return { ok: true, method: 'label-click' };
    }
    return { ok: false, method: 'all-failed' };
  }

  /* ============================================================
 * 表头全选
 * ============================================================ */
  function getHeaderCheckbox(doc = document) {
    return doc.querySelector('th.ant-table-selection-column input.ant-checkbox-input')
    || doc.querySelector('.ant-table-selection-column input.ant-checkbox-input');
  }

  function isCheckboxIndeterminate(cb) {
    if (!cb) return false;
    const wrap = cb.closest('.ant-checkbox')
    || (cb.closest('label') && cb.closest('label').querySelector('.ant-checkbox'));
    if (wrap && wrap.classList.contains('ant-checkbox-indeterminate')) return true;
    if (cb.indeterminate === true) return true;
    return false;
  }

  function getHeaderCheckState(doc = document) {
    const cb = getHeaderCheckbox(doc);
    if (!cb) return 'none-cb';
    if (isCheckboxIndeterminate(cb)) return 'partial';
    return cb.checked ? 'all' : 'none';
  }

  async function setHeaderCheckbox(qa, doc, desired, perTry = 400) {
    const isDesired = () => {
      const i = getHeaderCheckbox(doc);
      if (!i) return false;
      if (isCheckboxIndeterminate(i)) return false;
      return !!i.checked === !!desired;
    };

    if (!getHeaderCheckbox(doc)) return { ok: false, reason: 'no-header-cb' };
    if (isDesired()) return { ok: true, method: 'already' };

    for (let attempt = 0; attempt < 4; attempt++) {
      const cb = getHeaderCheckbox(doc);
      if (!cb) return { ok: false, reason: 'header-cb-gone' };
      const label = cb.closest('label') || cb;
      try {
        if (qa && typeof qa.realClick === 'function') qa.realClick(label);
        else label.click();
      } catch { try { cb.click(); } catch {} }
      if (await until(isDesired, 60, perTry)) {
        return { ok: true, method: 'header-click', tries: attempt + 1 };
      }
    }
    return { ok: false, reason: 'header-click-failed' };
  }

  async function clearAllViaHeader(qa, doc = document) {
    if (getHeaderCheckState(doc) === 'none') return { ok: true, tries: 0 };

    for (let i = 0; i < 3; i++) {
      const st = getHeaderCheckState(doc);
      if (st === 'none-cb') return { ok: false, reason: 'no-header-cb' };

      const r = await setHeaderCheckbox(qa, doc, false);
      if (!r.ok) return { ok: false, reason: r.reason || 'header-click-failed' };

      await sleep(80);
      if (getHeaderCheckState(doc) === 'none') return { ok: true, tries: i + 1 };
    }
    return { ok: getHeaderCheckState(doc) === 'none', reason: 'not-cleared' };
  }

  /* ============================================================
 * 逐行勾选（虚拟滚动兼容）
 * ============================================================ */
  async function applyTargetChecks(qa, doc, targets, opts = {}) {
    if (!targets || !targets.size) return { ok: true, applied: 0, failed: 0 };

    const cacheKey = opts.cacheKey || null;

    const body = getTableBody(doc);
    const needScroll = body && isVirtualScrolling(body);

    const entries = [...targets.entries()];
    let applied = 0, failed = 0;
    const failedNames = [];

    for (const [name, desired] of entries) {
      let f;
      if (needScroll) {
        f = await scrollToRowByName(qa, doc, name, { cacheKey });
      } else {
        f = qa.scanFileRows(doc).find(x => x.name === name);
      }
      if (!f) {
        warn(` ⚠️ 找不到行：${name}`);
        failed++; failedNames.push(name);
        continue;
      }
      if (!!f.checked === desired) { applied++; continue; }
      const r = await setRowCheckbox(qa, f.row, desired);
      if (r.ok) applied++;
      else { failed++; failedNames.push(name); }
      await sleep(80);
    }

    return {
      ok: failed === 0,
      applied, failed,
      details: failedNames.map(n => ({ name: n })),
    };
  }

  /* ============================================================
 * 表头全选方案
 * - 少量勾选：表头清空 → 单独滚到目标勾选
 * - 大量勾选：表头全选 → 逐个滚到排除项取消
 * - 快速返回：目标全 true 且表头已 all / 目标全 false 且表头已 none
 * ============================================================ */
  async function applyTargetChecksViaSelectAll(qa, doc, targets, opts = {}) {
    if (!targets || !targets.size) return { ok: true, applied: 0, failed: 0 };

    const cacheKey = opts.cacheKey || null;

    const entries = [...targets.entries()];
    const trueEntries = entries.filter(([, v]) => v === true);
    const falseEntries = entries.filter(([, v]) => v === false);
    const trueCount = trueEntries.length;
    const falseCount = falseEntries.length;
    const totalCount = entries.length;

    const headerState = getHeaderCheckState(doc);
    log(` 表头状态：${headerState}；目标：${trueCount} 勾选 / ${falseCount} 取消`);

    /* ★ 快速返回 1：目标全 true 且表头已 all */
    if (trueCount === totalCount && headerState === 'all') {
      log(` ✓ 表头已全选，无需操作`);
      return { ok: true, applied: 0, failed: 0, method: 'header-all-satisfied' };
    }

    /* ★ 快速返回 2：目标全 false 且表头已 none */
    if (falseCount === totalCount && headerState === 'none') {
      log(` ✓ 表头已全不选，无需操作`);
      return { ok: true, applied: 0, failed: 0, method: 'header-none-satisfied' };
    }

    /* 少量勾选：表头清空 → 逐个滚动勾选目标 */
    if (trueCount > 0 && trueCount < totalCount / 2) {
      log(` ★ 少量勾选（${trueCount}/${totalCount}），走「表头全不选 → 单独勾」快速路径`);

      if (headerState !== 'none') {
        const cls = await clearAllViaHeader(qa, doc);
        if (!cls.ok) {
          warn(` ⚠️ 表头清空失败（${cls.reason}），回退逐行模式`);
          return await applyTargetChecks(qa, doc, targets, { cacheKey });
        }
        log(` 已通过表头全部取消（点击 ${cls.tries} 次）`);
        await sleep(120);
      } else {
        log(` 表头已全不选，跳过清空`);
      }

      let ok = 0;
      const failed = [];
      for (const [name] of trueEntries) {
        const f = await scrollToRowByName(qa, doc, name, { cacheKey });
        if (!f) { failed.push(name); continue; }
        if (f.checked) { ok++; continue; }
        const r = await setRowCheckbox(qa, f.row, true);
        if (r.ok) ok++;
        else failed.push(name);
        await sleep(80);
      }
      return {
        ok: failed.length === 0,
        applied: ok, failed: failed.length,
        details: failed.map(n => ({ name: n })),
        method: 'header-clear+scroll-select',
      };
    }

    /* 大量勾选：表头全选 → 逐个滚动取消排除项 */
    const anyTrue = trueCount > 0;
    const targetHeaderState = anyTrue ? 'all' : 'none';

    if (headerState !== targetHeaderState) {
      const hdr = await setHeaderCheckbox(qa, doc, anyTrue);
      if (!hdr.ok) {
        warn(` ⚠️ 表头复选框操作失败（${hdr.reason}），回退逐行模式`);
        return await applyTargetChecks(qa, doc, targets, { cacheKey });
      }
      log(` 表头已${anyTrue ? '全选' : '全不选'}（${hdr.method}${hdr.tries ? ', 点击 ' + hdr.tries + ' 次' : ''}）`);
      await sleep(120);
    } else {
      log(` 表头已${anyTrue ? '全选' : '全不选'}，跳过点击`);
    }

    if (!falseEntries.length) {
      return { ok: true, applied: 0, failed: 0, method: 'header-only' };
    }

    let ok = 0;
    const failed = [];
    for (const [name] of falseEntries) {
      const f = await scrollToRowByName(qa, doc, name, { cacheKey });
      if (!f) { failed.push(name); continue; }
      if (!f.checked) { ok++; continue; }
      const r = await setRowCheckbox(qa, f.row, false);
      if (r.ok) ok++;
      else failed.push(name);
      await sleep(80);
    }
    return {
      ok: failed.length === 0,
      applied: ok, failed: failed.length,
      details: failed.map(n => ({ name: n })),
      method: 'header+scroll-exclude',
    };
  }

  /* ============================================================
 * 表格稳定等待
 * ============================================================ */
  async function waitTableStable(qa, doc = document, maxMs = 20000) {
    const t0 = Date.now();
    const expected = getShareFileCount(doc);
    log(` 头部显示共 ${expected == null ? '?' : expected} 个；等待表格稳定...`);

    await until(() => !doc.querySelector('.ant-spin-spinning'), 200, maxMs);
    log(` spin 已消失，等待行数稳定...`);

    let lastCount = -1;
    let stableHits = 0;
    const remain = () => Math.max(0, maxMs - (Date.now() - t0));

    const files = await until(() => {
      const rows = qa.scanFileRows(doc);
      const cnt = rows.length;
      if (expected && cnt >= expected && cnt === lastCount) {
        if (++stableHits >= 2) return rows;
      } else if (cnt > 0 && cnt === lastCount) {
        if (++stableHits >= 4) return rows;
      } else {
        stableHits = 0;
      }
      lastCount = cnt;
      return null;
    }, 400, remain());

    if (files) return files;
    const cur = qa.scanFileRows(doc);
    log(` 等待超时，当前扫描到 ${cur.length} 行`);
    return cur;
  }

  /* ============================================================
 * 批次执行器
 * ============================================================ */
  async function executeBatches(qa, doc, prep, opts = {}) {
    const useSelectAll = opts.useSelectAll === true;
    const batches = (Array.isArray(prep.batches) && prep.batches.length) ? prep.batches : [prep.needSave || []];
    const skipped = prep.skipped || [];
    const needSave = prep.needSave || [];
    const cacheKey = currentCacheKey();

    const savedFiles = [];
    const batchResults = [];
    let overall = null;

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = (batches[bi] || []).filter(Boolean);
      if (!batch.length) continue;

      const batchNames = new Set(batch.map(f => f.name));
      const targets = new Map();
      for (const f of skipped) targets.set(f.name, false);
      for (const f of needSave) targets.set(f.name, batchNames.has(f.name));

      log(` [批 ${bi + 1}/${batches.length}] 设置勾选：勾选 ${batch.length}，取消 ${Math.max(0, targets.size - batch.length)}（方式=${useSelectAll ? '全选+排除' : '逐行'}）`);
      const r = useSelectAll
        ? await applyTargetChecksViaSelectAll(qa, doc, targets, { cacheKey })
        : await applyTargetChecks(qa, doc, targets, { cacheKey });

      if (!r.ok) {
        warn(` ⚠️ 批 ${bi + 1} 勾选失败：${r.failed} 个不匹配`);
        batchResults.push({
          index: bi, count: batch.length, result: 'check-failed',
          recorded: false, names: batch.map(f => f.name),
        });
        return { ok: false, kind: 'check-failed', savedFiles, batchResults,
                details: r.details || [], result: overall };
      }

      const result = await clickSaveOnce(qa, doc);
      log(` [批 ${bi + 1}/${batches.length}] 转存结果：${result}`);
      overall = result;

      let recorded = false;
      if (result === 'success') {
        savedFiles.push(...batch);
        recorded = true;
      } else if (result === 'unknown') {
        if (isSuccessModalPresent(doc)) {
          savedFiles.push(...batch);
          recorded = true;
        } else {
          warn(` ⚠️ 批 ${bi + 1} 结果 unknown 且未见成功模态框，视为未成功，不记录`);
        }
      }

      batchResults.push({
        index: bi, count: batch.length, result, recorded,
        names: batch.map(f => f.name),
      });

      if (bi < batches.length - 1) {
        await waitAllModalsGone(qa, doc, 2000);
      }
    }

    return { ok: true, kind: 'done', savedFiles, batchResults, result: overall, details: [] };
  }

  function describeExec(exec) {
    const saved = (exec.savedFiles || []).length;
    const batches = exec.batchResults || [];
    const total = batches.reduce((s, b) => s + (b.count || 0), 0);

    const failed = batches.filter(b => !b.recorded);
    const failedNames = failed.flatMap(b => b.names || []);
    const failedReasons = [...new Set(failed.map(b => b.result).filter(Boolean))];

    if (!total) return { kind: 'empty', saved: 0, total: 0, failed: 0, failedReasons: [] };
    if (!failed.length) return { kind: 'success', saved, total, failed: 0, failedReasons: [] };
    if (saved > 0) return { kind: 'partial', saved, total, failed: failedNames.length, failedReasons };
    return { kind: 'fail', saved: 0, total, failed: failedNames.length, failedReasons };
  }
  /* ★ 格式化文件名列表，超长截断 */
  function fmtNames(arr, maxShow = 20) {
    const names = (arr || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean);
    if (!names.length) return '（无）';
    if (names.length <= maxShow) return names.join('、');
    return names.slice(0, maxShow).join('、') + ` 等 ${names.length} 个`;
  }
  /* ============================================================
 * 分享页准备
 * ============================================================ */
  async function prepareShareSave(qa, doc = document, opts = {}) {
    const splitOldest = opts.splitOldest !== false;
    const cacheKey = currentCacheKey();

    await ensureTimeDescSort(qa, doc);

    /* 等表格稳定（可见区） */
    let files = await waitTableStable(qa, doc, 20000);
    files = (files || []).filter(f => !isFolderFile(f));
    if (!files.length) return { ok: false, kind: 'no-files', files: [] };

    await sleep(300);

    /* ★ 一次滚动收集全表；后续命中缓存不再滚动 */
    files = await scanAllRowsByScroll(qa, doc, { key: cacheKey, useCache: true });
    files = (files || []).filter(f => !isFolderFile(f));
    if (!files.length) return { ok: false, kind: 'no-files', files: [] };

    const records = loadRecords();
    const savedInfos = collectSavedInfos(records);

    const saved = files.filter(f => isFileSaved(f, savedInfos));
    const pending = files.filter(f => !isFileSaved(f, savedInfos));
    const excludeNames = new Set(saved.map(f => f.name));

    log(` 共 ${files.length} 个（已排除文件夹）：已转存 ${saved.length}，待转存 ${pending.length}`);
    log(` 逐行判定：`);
    for (const f of files) {
      log(` - ${f.name} sizeStr="${f.sizeStr}" → ${isFileSaved(f, savedInfos) ? 'SAVED' : 'PENDING'}`);
    }

    setShareFullCounts(qa, saved.length, files.length);

    if (!pending.length) {
      return { ok: false, kind: 'all-saved', needSave: [], skipped: saved, excludeNames, files };
    }

    let batches;
    if (splitOldest && pending.length > 1) {
      const rest = pending.slice(0, -1);
      const oldest = pending[pending.length - 1];
      batches = [rest, [oldest]];
      log(` ★ 全量转存：拆两批 — 第1批 ${rest.length} 个（除最旧），第2批 1 个（最旧：${oldest.name}）`);
    } else {
      batches = [pending];
    }

    return {
      ok: true, kind: 'ready',
      needSave: pending, skipped: saved, excludeNames, files,
      batches,
    };
  }

  /* ============================================================
 * 子任务
 * ============================================================ */
  async function tryHandleChildTask(qa) {
    const shareId = extractShareId(location.href);
    if (!shareId) return false;

    const task = consumeTask(shareId);
    if (!task) return false;

    if (qa.isPaused && qa.isPaused()) {
      log(`⏸ [子任务] ${shareId} 检测到夸克助手已暂停，直接关闭页面`);
      setResult(shareId, { kind: 'paused' });
      setTimeout(() => { try { window.close(); } catch {} }, 300);
      return true;
    }

    log(`★ [子任务] ${shareId} 开始处理`);

    qa.mountPanel();
    qa.setStatus('子任务处理中...', 'running');
    qa.setProgress('-');
    startSharePolling(qa); // ★ 让子任务页可见区也置灰

    const finish = (kind, extra = {}) => {
      setResult(shareId, { kind, ...extra });
      log(`★ [子任务] 结果已写入：${kind}`);
      setTimeout(() => { try { window.close(); } catch {} }, 800);
    };

    let prep;
    try {
      prep = await prepareShareSave(qa, document);
    } catch (e) {
      warn(' 准备失败', e);
      finish('fail', { message: 'prepare-error:' + String(e && e.message || e) });
      return true;
    }

    if (prep.kind === 'no-files') { finish('skip', { message: 'no-files' }); return true; }
    if (prep.kind === 'all-saved') {
      finish('all-saved', { fileCount: prep.files.length, files: prep.files.map(f => f.name) });
      return true;
    }
    if (!prep.ok) {
      finish('fail', {
        message: 'prep-failed:' + prep.kind,
        details: prep.details ? prep.details.map(f => f.name) : [],
      });
      return true;
    }

    try {
      const exec = await executeBatches(qa, document, prep, { useSelectAll: true });
      const savedFiles = exec.savedFiles || [];

      if (savedFiles.length) {
        const key = normalizeShareKey(location.href);
        const recs = loadRecords();
        const prev = recs[key] || {};
        const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
        for (const f of savedFiles) {
          const item = { name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig };
          if (!merged.some(mi => isSameFile(mi, item))) merged.push(item);
        }
        recs[key] = {
          ...prev,
          ts: Date.now(),
          shareId,
          fileInfos: merged,
          names: merged.map(x => x.name),
        };
        saveRecords(recs);
        log(` 记录已更新：${key} → ${merged.length} 条`);
      }

      const summary = describeExec(exec);
      const savedBrief = savedFiles.map(f => ({ name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig }));

      let kind = 'fail';
      if (summary.kind === 'success') kind = 'success';
      else if (summary.kind === 'partial') kind = 'partial';
      else if (summary.kind === 'empty') kind = 'skip';

      finish(kind, {
        savedFiles: savedBrief,
        fileCount: prep.files.length,
        totalPlanned: summary.total,
        failedCount: summary.failed || 0,
        failedReasons: summary.failedReasons || [],
      });
    } catch (e) {
      warn(' 子任务异常', e);
      finish('fail', { message: String(e && e.message || e) });
    }
    return true;
  }

  async function saveShareUrlViaTab(qa, url) {
    const shareId = extractShareId(url);
    if (!shareId) return { kind: 'fail', message: 'bad-url' };

    clearResult(shareId);
    setTask(shareId, url);

    log(` → 打开标签页：${url}`);
    try {
      GM_openInTab(url, { active: false, insert: true, setParent: true });
    } catch (e) {
      clearTask(shareId);
      return { kind: 'fail', message: 'open-tab-failed' };
    }

    const r = await until(() => consumeResult(shareId), 1000, TAB_RESULT_TIMEOUT);
    if (r) return r;
    clearTask(shareId);
    return { kind: 'timeout', message: 'tab-timeout' };
  }

  /* ============================================================
 * 批量转存
 * ============================================================ */
  async function runSaveAllFlow(qa, pendingUrlsOverride) {
    let pending;

    if (Array.isArray(pendingUrlsOverride)) {
      pending = pendingUrlsOverride.slice();
      log(`★ [acg 清单模式] 待处理 ${pending.length} 个 URL`);
      for (const u of pending) log(` → ${u}`);
    } else {
      const bd = loadBangumiData();
      if (!bd) { alert('无 bangumiData'); return; }
      const urls = collectShareUrls(bd);
      const records = loadRecords();
      log('=== 手动触发：队列分析 ===');
      pending = [];
      for (const u of urls) {
        const key = normalizeShareKey(u);
        if (records[key]) log(` [已存在] ${u}`);
        else { log(` [待转存] ${u}`); pending.push(u); }
      }
      if (!pending.length) {
        alert(`所有 URL 均已处理完毕（共 ${urls.length} 个）`);
        return;
      }
    }

    if (!pending.length) return;

    try { sessionStorage.setItem(BUSY_KEY, '1'); } catch {}
    log('★ 已标记桥接忙碌，QuarkAutoAssistant 暂停自动下载');

    try {
      qa.setStatus('转存中...', 'running');
      let successCount = 0;
      let partialCount = 0;

      for (let i = 0; i < pending.length; i++) {
        if (qa.isPaused && qa.isPaused()) {
          warn(`⏸ 夸克助手已暂停，停止后续 ${pending.length - i} 个子任务`);
          qa.setStatus('已暂停', 'running');
          break;
        }

        const url = pending[i];
        qa.setProgress(`${i + 1} / ${pending.length}`);
        log(`--- [${i + 1}/${pending.length}] ${url}`);

        let r;
        try {
          r = await saveShareUrlViaTab(qa, url);
        } catch (e) {
          warn(`处理失败：${url}`, e);
          continue;
        }

        const key = normalizeShareKey(url);
        if (r.kind === 'success' || r.kind === 'partial') {
          if (r.kind === 'success') successCount++;
          else partialCount++;

          const recs = loadRecords();
          const prev = recs[key] || {};
          const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
          for (const f of (r.savedFiles || [])) {
            const item = { name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig };
            if (!merged.some(mi => isSameFile(mi, item))) merged.push(item);
          }
          recs[key] = {
            ...prev,
            ts: Date.now(),
            shareId: extractShareId(key),
            fileInfos: merged,
            names: merged.map(x => x.name),
          };
          saveRecords(recs);

          if (r.kind === 'partial') {
            warn(`⚠️ 部分成功（${(r.savedFiles || []).length}/${r.totalPlanned}）：${url}，失败原因 ${(r.failedReasons || []).join(', ') || '未知'}`);
          } else {
            log(`✅ 已记录 ${merged.length} 条到 ${key}`);
          }
        } else if (r.kind === 'all-saved') {
          const files = Array.isArray(r.files) ? r.files.join(', ') : '?';
          log(`⏭️ 该 URL 所有文件都已转存（fileCount=${r.fileCount}, files=${files}）: ${url}`);
        } else if (r.kind === 'paused') {
          log(`⏸ 子任务因暂停直接关闭：${url}`);
          qa.setStatus('已暂停', 'running');
          break;
        } else {
          warn(`⚠️ 结果 ${r.kind}: ${url}`);
        }

        if (i < pending.length - 1) await sleep(1000);
      }

      qa.setStatus('转存完成', 'done');
      qa.setProgress('-');

      if (successCount + partialCount > 0) {
        log('★ 有新转存，重载页面触发 QuarkAutoAssistant 自动下载...');
        try { sessionStorage.removeItem(BUSY_KEY); } catch {}
        await sleep(1500);
        location.reload();
      } else {
        log('无新转存文件，跳过刷新');
      }
    } finally {
      try { sessionStorage.removeItem(BUSY_KEY); } catch {}
    }
  }

  /* ============================================================
 * 分享页：手动转存当前页
 * ============================================================ */
  async function runSaveCurrentPage(qa) {
    await ensureTimeDescSort(qa, document);

    const url = normalizeShareKey(location.href);
    const cacheKey = currentCacheKey();

    const allFiles = (await scanAllRowsByScroll(qa, document, { key: cacheKey, useCache: true }) || [])
    .filter(f => !isFolderFile(f));
    if (!allFiles.length) { alert('当前页无文件（或仅含文件夹）'); return; }

    const headerState = getHeaderCheckState(document);
    let usingAll, scope;
    if (headerState === 'all' || headerState === 'none' || headerState === 'none-cb') {
      usingAll = true;
      scope = allFiles;
    } else {
      /* partial：滚动收集所有被勾选的行（而非只看可见区） */
      log(` 表头 partial，滚动收集所有勾选行...`);
      const checkedAll = await scanCheckedRowsByScroll(qa, document, { cacheKey });
      if (!checkedAll.length) { usingAll = true; scope = allFiles; }
      else { usingAll = false; scope = checkedAll; }
    }

    log(`=== 转存当前页 ===`);
    log(` URL: ${url}`);
    log(` 表头状态：${headerState}`);
    log(` 范围: ${usingAll ? `全部 ${allFiles.length} 个` : `勾选 ${scope.length} 个`}`);

    const records = loadRecords();
    const savedInfos = collectSavedInfos(records);
    const scopeSaved = scope.filter(f => isFileSaved(f, savedInfos));
    const scopePending = scope.filter(f => !isFileSaved(f, savedInfos));

    log(` 已转存跳过 ${scopeSaved.length}：${scopeSaved.map(f => f.name).join(', ') || '无'}`);
    log(` 待转存 ${scopePending.length}：${scopePending.map(f => f.name).join(', ') || '无'}`);

    if (!scopePending.length) {
      alert(
        `范围内所有文件都已转存（范围 ${scope.length} 个）\n\n` +
        `跳过（${scope.length}）：${fmtNames(scope.map(f => f.name))}`
      );
      refreshShareUI(qa);
      await refreshShareFullCounts(qa);
      return;
    }

    let batches;
    if (usingAll && scopePending.length > 1) {
      batches = [
        scopePending.slice(0, -1),
        [scopePending[scopePending.length - 1]],
      ];
      log(` ★ 全量转存：拆两批 — 第1批 ${batches[0].length} 个（除最旧），第2批 1 个（最旧：${batches[1][0].name}）`);
    } else {
      batches = [scopePending];
    }

    const msg =
          `范围：${usingAll ? `全部 ${allFiles.length} 个` : `勾选 ${scope.length} 个`}\n` +
          `转存：${scopePending.length} 个` +
          (usingAll && scopePending.length > 1 ? `（分 2 批：先 ${batches[0].length} 个，再最旧 1 个）` : '') + `\n` +
          (scopeSaved.length ? `跳过已转存：${scopeSaved.map(f => f.name).join(', ')}\n` : '') +
          `\n继续？`;
    if (!confirm(msg)) return;

    try {
      const prep = {
        batches,
        skipped: scopeSaved,
        needSave: scopePending,
        files: allFiles,
      };

      const exec = await executeBatches(qa, document, prep, { useSelectAll: usingAll });
      const savedFiles = exec.savedFiles || [];

      if (savedFiles.length) {
        const recs = loadRecords();
        const prev = recs[url] || {};
        const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
        for (const f of savedFiles) {
          const item = { name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig };
          if (!merged.some(mi => isSameFile(mi, item))) merged.push(item);
        }
        recs[url] = {
          ...prev,
          ts: Date.now(),
          shareId: extractShareId(url),
          fileInfos: merged,
          names: merged.map(x => x.name),
        };
        saveRecords(recs);
        log(`✅ 已记录 ${merged.length} 条到 ${url}`);
      }

      const summary = describeExec(exec);
      const total = summary.total || scopePending.length;

      const skippedNames = scopeSaved.map(f => f.name);
      const savedNames = savedFiles.map(f => f.name);
      const failedNames = (exec.batchResults || [])
      .filter(b => !b.recorded)
      .flatMap(b => b.names || []);

      let title;
      if (summary.kind === 'success') {
        title = summary.saved < total
          ? `⚠️ 全部成功（${summary.saved} / ${total}）`
          : `✅ 全部成功（${summary.saved} / ${total}）`;
      } else if (summary.kind === 'partial') {
        title = `⚠️ 部分成功：${summary.saved} / ${total}`;
      } else if (summary.kind === 'fail') {
        if (summary.failedReasons.includes('space')) title = '❌ 空间不足，全部未转存';
        else if (summary.failedReasons.includes('over_limit')) title = '❌ 超过转存限额，全部未转存';
        else if (summary.failedReasons.includes('check-failed') || summary.failedReasons.includes('still-unchecked')) title = '❌ 勾选状态设置失败，全部未转存';
        else title = `❌ 转存失败：${summary.failedReasons.join(', ') || '未知原因'}`;
      } else {
        title = '⚠️ 未执行任何转存';
      }

      const lines = [title];
      if (skippedNames.length) lines.push('', `跳过已转存（${skippedNames.length}）：${fmtNames(skippedNames)}`);
      if (savedNames.length) lines.push('', `本次转存（${savedNames.length}）：${fmtNames(savedNames)}`);
      if (failedNames.length) lines.push('', `转存失败（${failedNames.length}）：${fmtNames(failedNames)}`);

      alert(lines.join('\n'));
    } catch (e) {
      warn('转存异常：', e);
      alert('❌ 出错：' + (e && e.message || e));
    }
    qa.refreshGray();
    refreshFullCounts(qa);
  }

  /* ============================================================
 * 分享页：标记 / 清除
 * ============================================================ */
  async function runMarkFlow(qa) {
    await ensureTimeDescSort(qa, document);

    const url = normalizeShareKey(location.href);
    const cacheKey = currentCacheKey();

    const allFiles = (await scanAllRowsByScroll(qa, document, { key: cacheKey, useCache: true }) || [])
    .filter(f => !isFolderFile(f));
    if (!allFiles.length) { alert('无文件'); return; }

    const headerState = getHeaderCheckState(document);
    let usingAll, scope;
    if (headerState === 'all' || headerState === 'none' || headerState === 'none-cb') {
      usingAll = true;
      scope = allFiles;
    } else {
      /* partial：滚动收集所有被勾选的行（而非只看可见区） */
      log(` 表头 partial，滚动收集所有勾选行...`);
      const checkedAll = await scanCheckedRowsByScroll(qa, document, { cacheKey });
      if (!checkedAll.length) { usingAll = true; scope = allFiles; }
      else { usingAll = false; scope = checkedAll; }
    }

    const msg = usingAll
      ? `无勾选，标记全部 ${allFiles.length} 个文件为已转存？\n${scope.map(f => f.name).join(', ')}`
      : `标记勾选的 ${scope.length} 个文件为已转存？\n${scope.map(f => f.name).join(', ')}`;
    if (!confirm(msg)) return;

    const recs = loadRecords();
    const prev = recs[url] || {};
    const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
    let added = 0;
    for (const f of scope) {
      const item = { name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig };
      if (!merged.some(mi => isSameFile(mi, item))) { merged.push(item); added++; }
    }
    recs[url] = {
      ...prev,
      ts: Date.now(),
      shareId: extractShareId(url),
      fileInfos: merged,
      names: merged.map(x => x.name),
      manual: true,
    };
    saveRecords(recs);
    refreshShareUI(qa);
    await refreshShareFullCounts(qa);

    const markedNames = scope.map(f => f.name);
    alert(
      `✅ 已标记 ${scope.length} 个（新增 ${added}，累计 ${merged.length}）\n\n` +
      `本次标记（${markedNames.length}）：${fmtNames(markedNames)}`
    );
  }

  async function runClearShareFlow(qa) {
    await ensureTimeDescSort(qa, document);

    const url = normalizeShareKey(location.href);
    const cacheKey = currentCacheKey();

    const allFiles = (await scanAllRowsByScroll(qa, document, { key: cacheKey, useCache: true }) || [])
    .filter(f => !isFolderFile(f));

    const headerState = getHeaderCheckState(document);
    let usingAll, scope;
    if (headerState === 'all' || headerState === 'none' || headerState === 'none-cb') {
      usingAll = true;
      scope = allFiles;
    } else {
      /* partial：滚动收集所有被勾选的行（而非只看可见区） */
      log(` 表头 partial，滚动收集所有勾选行...`);
      const checkedAll = await scanCheckedRowsByScroll(qa, document, { cacheKey });
      if (!checkedAll.length) { usingAll = true; scope = allFiles; }
      else { usingAll = false; scope = checkedAll; }
    }

    const recs = loadRecords();
    const rec = recs[url];
    if (!rec) { qa.refreshGray(); refreshFullCounts(qa); alert('当前分享无记录'); return; }

    if (usingAll) {
      if (!confirm(`当前分享无勾选，将删除全部记录（共 ${(rec.fileInfos || []).length} 条）？`)) return;
      delete recs[url];
      saveRecords(recs);
      refreshShareUI(qa);
      await refreshShareFullCounts(qa);
      alert('已删除全部记录');
      return;
    }

    const existing = Array.isArray(rec.fileInfos) ? rec.fileInfos : [];
    const toRemove = scope.map(f => ({ name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig }));
    const hitCount = existing.filter(fi => toRemove.some(tr => isSameFile(tr, fi))).length;
    if (!hitCount) { alert(`勾选的 ${scope.length} 个文件无转存记录`); return; }
    if (!confirm(`从记录中移除 ${hitCount} 个勾选文件？（当前记录共 ${existing.length} 条）`)) return;

    const removedInfos = existing.filter(fi => toRemove.some(tr => isSameFile(tr, fi)));
    const removedNames = removedInfos.map(fi => fi.name);

    const keep = existing.filter(fi => !toRemove.some(tr => isSameFile(tr, fi)));
    if (!keep.length) {
      delete recs[url];
      alert(
        `🗑️ 已移除 ${hitCount} 个，记录已清空\n\n` +
        `本次移除（${removedNames.length}）：${fmtNames(removedNames)}`
      );
    } else {
      recs[url] = { ...rec, ts: Date.now(), fileInfos: keep, names: keep.map(x => x.name) };
      alert(
        `🗑️ 已移除 ${hitCount} 个（剩余 ${keep.length} 条）\n\n` +
        `本次移除（${removedNames.length}）：${fmtNames(removedNames)}`
      );
    }
    saveRecords(recs);
    refreshShareUI(qa);
    await refreshShareFullCounts(qa);
  }

  /* ============================================================
 * acg.rip 端
 * ============================================================ */
  function runQuarkAutoTrigger(opts = {}) {
    const { force = false } = opts;
    const folderId = getFolderId().trim();
    if (!folderId) return { triggered: false, reason: 'no-folder' };

    const bd = loadBangumiData();
    if (!bd || !Array.isArray(bd.rows)) return { triggered: false, reason: 'no-data' };

    const urls = collectShareUrls(bd);
    if (!urls.length) return { triggered: false, reason: 'no-urls' };

    const state = gmGet(GM_CD, {}) || {};
    const now = Date.now();
    const need = [];
    let skippedByCD = 0;
    for (const u of urls) {
      const s = state[u] || { ts: 0, attempts: 0 };
      const cd = Math.min(BASE_CD * Math.pow(2, s.attempts), MAX_CD);
      if (!force && now - s.ts < cd) { skippedByCD++; continue; }
      need.push(u);
    }

    log(`触发：CD 内跳过 ${skippedByCD}，待检查 ${need.length}（共 ${urls.length} 个 URL）`);
    if (!need.length) return { triggered: false, reason: 'all-cd', total: urls.length };

    for (const u of need) {
      const s = state[u] || { ts: 0, attempts: 0 };
      s.ts = now; s.attempts += 1; state[u] = s;
    }
    gmSet(GM_CD, state);

    gmSet(GM_PENDING_URLS, { ts: now, urls: need });
    GM_setValue(GM_AUTO_TRIGGER, now);

    const url = `https://pan.quark.cn/list#/list/all/${folderId}/`;
    GM_openInTab(url, { active: false, insert: true, setParent: true });

    return { triggered: true, count: need.length, total: urls.length };
  }

  function watchEditPanel() {
    const tryInject = () => {
      const overlay = document.getElementById('gmEditOverlay');
      if (!overlay) return;
      if (overlay.querySelector('#acgrip-quark-section')) return;
      const host = overlay.querySelector('#lastTableHost');
      if (!host) return;
      injectQuarkSection(host);
    };
    new MutationObserver(tryInject).observe(document.body, { childList: true, subtree: true });
    tryInject();
  }

  function injectQuarkSection(host) {
    const sec = document.createElement('div');
    sec.id = 'acgrip-quark-section';
    sec.style.cssText = 'margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed #3a3a3a;';
    const folder = getFolderId().trim();

    sec.innerHTML = `
 <label><strong>夸克网盘</strong></label>：
 <button type="button" id="resetQuarkCdBtn">重置夸克检查 CD</button>
 <button type="button" id="triggerQuarkBtn">立即触发转存</button>
 <span class="hint" id="quarkCdInfo"></span>
 <span class="hint" style="margin:2px 0 4px 0;display:block;">
 打开夸克个人页时使用的文件夹路径（留空则不自动触发）。
 </span>
 <input id="inpQuarkFolder" type="text"
 placeholder="81c6136399d64c1b8a7cbb794a238860-来自：分享"
 value="${folder.replace(/"/g, '&quot;')}"
 style="width:100%;box-sizing:border-box;font-family:monospace;">
 `;
    host.parentNode.insertBefore(sec, host);

    const inp = sec.querySelector('#inpQuarkFolder');
    const info = sec.querySelector('#quarkCdInfo');
    function refreshInfo() {
      const state = gmGet(GM_CD, {}) || {};
      const recs = loadRecords();
      const pend = gmGet(GM_PENDING_URLS, {}) || {};
      const pendCount = Array.isArray(pend.urls) ? pend.urls.length : 0;
      info.textContent = `CD ${Object.keys(state).length} | 已转存 ${Object.keys(recs).length} | 待处理 ${pendCount}`;
    }
    inp.addEventListener('input', () => { GM_setValue(GM_FOLDER, inp.value.trim()); refreshInfo(); });
    inp.addEventListener('blur', () => { inp.value = getFolderId().trim(); refreshInfo(); });
    sec.querySelector('#resetQuarkCdBtn').onclick = () => {
      if (!confirm('重置所有 URL 的检查 CD？')) return;
      gmSet(GM_CD, {}); refreshInfo();
    };
    sec.querySelector('#triggerQuarkBtn').onclick = () => {
      const r = runQuarkAutoTrigger({ force: true });
      alert(r.triggered ? `已打开夸克处理 ${r.count} 个链接` : `未触发：${r.reason}`);
      refreshInfo();
    };
    refreshInfo();
  }

  async function initAcgRipSide() {
    if (location.href.replace('page/1', '').endsWith('.rip/')) {
      setTimeout(() => { try { runQuarkAutoTrigger(); } catch (e) { warn(e); } }, 5000);
    }
    window.addEventListener('acgrip-bangumi-saved', () => {
      try {
        unsafeWindow.acgripApi?.refreshAirDates?.();
        runQuarkAutoTrigger();
      } catch (e) { warn(e); }
    });
    watchEditPanel();

    try {
      GM_registerMenuCommand('🔄 重置夸克检查 CD', () => {
        gmSet(GM_CD, {}); alert('已重置。');
      });
      GM_registerMenuCommand('🗑️ 清空转存记录', () => {
        if (!confirm('清空所有转存记录？')) return;
        GM_setValue(GM_CLEAR_FLAG, Date.now());
        alert('已发送清空请求。');
      });
      GM_registerMenuCommand('📊 查看状态', () => {
        const state = gmGet(GM_CD, {}) || {};
        const recs = loadRecords();
        const pend = gmGet(GM_PENDING_URLS, {}) || {};
        const auto = Number(GM_getValue(GM_AUTO_TRIGGER, 0) || 0);
        alert(
          `转存记录：${Object.keys(recs).length} 条\n` +
          `CD：${Object.keys(state).length} 个 URL\n` +
          `待处理清单：${Array.isArray(pend.urls) ? pend.urls.length : 0} 项\n` +
          `自动触发标记：${auto ? new Date(auto).toLocaleTimeString() : '无'}`
        );
      });
    } catch {}

    log('已启动（acg.rip 端）');
  }

  /* ============================================================
 * 夸克端入口
 * ============================================================ */
  async function waitForQA(timeout = 10000) {
    return await until(() => {
      const qa = unsafeWindow.quarkAssistant;
      return qa && qa.isReady && qa.isReady() ? qa : null;
    }, 150, timeout);
  }

  async function initQuarkSide() {
    cleanupBridgeComm();
    const qa = await waitForQA();
    if (!qa) { warn('quarkAssistant 未就绪'); return; }
    log('quarkAssistant 就绪 v' + qa.version);

    const isChild = await tryHandleChildTask(qa);
    if (isChild) {
      log('★ 子任务已处理，本标签页即将关闭');
      return;
    }

    const isShare = qa.isSharePage();
    const isList = qa.isListPage();

    if (isShare) {
      qa.mountPanel();
      qa.setActions([
        { label: '📥 转存当前页', color: '#13c2c2', onclick: () => runSaveCurrentPage(qa) },
        { label: '🏷️ 标记', color: '#da9328', onclick: () => runMarkFlow(qa) },
        { label: '🗑️ 清除当前记录', color: '#cc3235', onclick: () => runClearShareFlow(qa) },
      ]);
      qa.setProgressLabel('已转存');
      qa.setStatus('待机（分享页）');
      qa.setProgress('-');

      /* 桥接自主的分享页轮询：只刷可见区置灰 + 进度 */
      startSharePolling(qa);

      ensureTimeDescSort(qa, document).then(r => {
        log(`★ 分享页初始化排序结果：${JSON.stringify(r)}`);
      });

      log(`★ 分享页初始化（等待用户操作 / 子任务触发）`);
      /* ★ 不再主动 refreshShareFullCounts —— 未点击按钮前显示 '-'，不触发全表滚动 */
    } else if (isList) {
      qa.setActions([
        {
          label: '▶️ 转存', color: '#09AAFF',
          title: '处理 pending_urls 或 bangumiData 里的分享，逐条转存',
          onclick: () => runSaveAllFlow(qa, null),
        },
      ]);
      qa.setStatus('待机（个人页）');

      const autoTs = Number(GM_getValue(GM_AUTO_TRIGGER, 0) || 0);
      const fresh = autoTs > 0 && (Date.now() - autoTs) < AUTO_TTL;
      if (fresh) {
        GM_setValue(GM_AUTO_TRIGGER, 0);

        if (qa.isPaused && qa.isPaused()) {
          log('⏸ 自动任务：夸克助手已暂停，直接关闭页面');
          setTimeout(() => { try { window.close(); } catch {} }, 300);
          return;
        }

        const pack = gmGet(GM_PENDING_URLS, null);
        const urls = (pack && Array.isArray(pack.urls)) ? pack.urls : null;
        if (urls && urls.length) {
          log(`★ 自动触发：从 pending_urls 读取 ${urls.length} 个 URL`);
          await runSaveAllFlow(qa, urls);
        } else {
          warn('自动触发但 pending_urls 为空');
        }
        setTimeout(() => { try { window.close(); } catch {} }, 300);
      }
    } else {
      // 其他页
    }

    log('已启动（夸克端）');
  }

  if (IS_QUARK) initQuarkSide();
  else if (IS_ACGRIP) initAcgRipSide();
})();