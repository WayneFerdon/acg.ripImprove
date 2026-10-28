// ==UserScript==
// @name acg.ripImprove.Bridge2QuarkPan
// @namespace http://tampermonkey.net/
// @version 3.14.6
// @description acg.rip 桥接：夸克转存业务编排（全表一次滚动 + 内存缓存；单行定位优先可见区 + 估计位置；表头状态快速返回；记录不按时间过期，过期只依据 acg.rip 清单；转存刷新后按 acg 最终名称改名 acg名称+原始文件名；跨标签页即时触发；多个子任务并行转存（同时打开全部分享页；任务/结果按 shareId 独立存键避免并发覆盖）；子任务前等待夸克助手 unsafeWindow 挂起门（清理完成才动子任务）；子任务/刷新/改名确认后放行挂起门，自动下载与关页交给夸克助手；改名时记录曾用名；匹配按最新名→曾用名→[bgm]兜底；全量重转时写入诊断 Debug；扫描不完整时中止转存；后台标签页加大步进与超时；关键等待严格化：超时≠成功）
// @match *://acg.rip/*
// @match https://pan.quark.cn/*
// @downloadURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/acg.ripImprove.Bridge2QuarkPan.user.js
// @updateURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/acg.ripImprove.Bridge2QuarkPan.user.js
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
  /* 并行转存时多个子标签页会同时读-改-写上面的共享 map（后写的会覆盖先写的，结果会丢）。
   * 因此任务/结果改为按 shareId 单独存键；GM_COMM_INDEX 仅用于回收旧键，写丢了也不影响正确性。 */
  const GM_TASK_PREFIX = 'acgrip_bridge_task_';
  const GM_RESULT_PREFIX = 'acgrip_bridge_result_';
  const GM_COMM_INDEX = 'acgrip_bridge_comm_index';
  const BUSY_KEY = 'acgrip_bridge_busy';
  const GM_FULL_RESAVE_DEBUG = 'acgrip_quark_full_resave_debug';

  const TASK_TTL = 3 * 60 * 1000;
  const TAB_RESULT_TIMEOUT = 90 * 1000;
  /* 并行转存：0 = 同时打开全部（默认）；改成 2/3/4 可限制同时打开的分享页数量 */
  const PARALLEL_SAVE_LIMIT = 0;
  const PARALLEL_GRACE_MS = 60 * 1000;      /* 并行总超时 = 单页超时 + 宽限 */
  const RESULT_STALE_MS = TAB_RESULT_TIMEOUT + PARALLEL_GRACE_MS;

  const BASE_CD = 30 * 60 * 1000;
  const MAX_CD = 7 * 24 * 60 * 60 * 1000;
  const AUTO_TTL = 5 * 60 * 1000;

  const FULL_RESAVE_DEBUG_MAX = 10;
  /* 关页延时已移交 QuarkAutoAssistant（CLOSE_DELAY_MS），桥接不再关页 */
  const OBSOLETE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MIN_QA_VERSION = [6, 0, 0];
  const GATE_KEY = '__acgripQuarkGate';
  const ACG_FLAG_KEY = 'acgrip_acg_invoked';
  const GATE_WAIT_MS = 4 * 60 * 1000;

  const _1s = 1000;
  const log = (...a) => console.log('[桥接]', ...a);
  const warn = (...a) => console.warn('[桥接]', ...a);

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

  /* 兼容旧签名 until(fn, delay, timeout)：超时返回 null（大量旧调用点依赖此语义） */
  async function until(fn, delay = 200, timeout = 10000) {
    const pollMs = delay === 0 ? 0 : Math.max(50, delay ?? 50);
    const waitMs = Number(timeout) > 0 ? Number(timeout) : 0;
    const t0 = Date.now();
    for (;;) {
      const result = await fn();
      if (result) return result;
      if (waitMs > 0 && Date.now() - t0 >= waitMs) return null;
      await sleep(pollMs, true);
    }
  }

  /* 严格版本：超时抛异常 */
  async function untilStrict(fn, delay, maxWaitMs) {
    const pollMs = delay === 0 ? 0 : Math.max(50, delay ?? 50);
    const waitMs = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 0;
    const t0 = Date.now();
    for (;;) {
      const result = await fn();
      if (result) return result;
      if (waitMs > 0 && Date.now() - t0 >= waitMs) throw new Error(`untilStrict 超时：${waitMs}ms`);
      await sleep(pollMs, true);
    }
  }

  async function untilOrGiveUp(fn, delay, maxWaitMs) {
    try {
      return { ok: true, result: await untilStrict(fn, delay, maxWaitMs) };
    } catch {
      return { ok: false, result: null };
    }
  }

  function acquireBusy() { try { sessionStorage.setItem(BUSY_KEY, '1'); } catch {} }
  function releaseBusy() { try { sessionStorage.removeItem(BUSY_KEY); } catch {} }

  /* 失败收尾时保留的忙碌标志只在"本页生命周期"内有效。
   * 用户刷新/跳转后不该继续被当成"失败中的 acg 自动任务"（否则要关掉页面重开才能恢复）。 */
  let _busyKeptForFailure = false;
  function markBusyKeptForFailure() { _busyKeptForFailure = true; }
  function installUnloadStateCleanup() {
    const clear = () => {
      if (!_busyKeptForFailure) return;
      _busyKeptForFailure = false;
      try { sessionStorage.removeItem(BUSY_KEY); } catch {}
      try { sessionStorage.removeItem(ACG_FLAG_KEY); } catch {}
    };
    try { window.addEventListener('pagehide', clear, true); } catch {}
    try { window.addEventListener('beforeunload', clear, true); } catch {}
    /* Turbolinks 页内跳转不触发 unload，兜一层 */
    try { document.addEventListener('turbolinks:before-visit', clear, true); } catch {}
  }
  installUnloadStateCleanup();

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

  /* ===== 跨标签页通信 ===== */
  function _pruneByTTL(m, ttl) {
    const now = Date.now();
    let dirty = false;
    for (const k of Object.keys(m)) {
      if (now - (m[k].ts || 0) > ttl) { delete m[k]; dirty = true; }
    }
    return dirty;
  }

  function _commIndexAdd(shareId) {
    if (!shareId) return;
    try {
      const idx = gmGet(GM_COMM_INDEX, {}) || {};
      idx[shareId] = Date.now();
      gmSet(GM_COMM_INDEX, idx);
    } catch {}
  }
  function setTask(shareId, url) {
    if (!shareId) return;
    try { GM_setValue(GM_TASK_PREFIX + shareId, { url, ts: Date.now() }); } catch {}
    _commIndexAdd(shareId);
  }
  function consumeTask(shareId) {
    if (!shareId) return null;
    let t = null;
    try { t = GM_getValue(GM_TASK_PREFIX + shareId, null); } catch {}
    if (!t) {
      /* 兼容旧版共享 map（升级时可能有残留） */
      const m = gmGet(GM_TASKS, {}) || {};
      if (m[shareId]) { t = m[shareId]; delete m[shareId]; gmSet(GM_TASKS, m); }
    }
    try { GM_setValue(GM_TASK_PREFIX + shareId, null); } catch {}
    if (!t || !(t.ts > 0)) return null;
    if (Date.now() - t.ts > TASK_TTL) return null;
    return t;
  }
  function clearTask(shareId) {
    if (!shareId) return;
    try { GM_setValue(GM_TASK_PREFIX + shareId, null); } catch {}
    const m = gmGet(GM_TASKS, {}) || {};
    if (m[shareId]) { delete m[shareId]; gmSet(GM_TASKS, m); }
  }
  function setResult(shareId, obj) {
    if (!shareId) return;
    try { GM_setValue(GM_RESULT_PREFIX + shareId, { ...(obj || {}), ts: Date.now() }); } catch {}
    _commIndexAdd(shareId);
  }
  function consumeResult(shareId) {
    if (!shareId) return null;
    let r = null;
    try { r = GM_getValue(GM_RESULT_PREFIX + shareId, null); } catch {}
    if (!r) {
      const m = gmGet(GM_RESULTS, {}) || {};
      _pruneByTTL(m, TAB_RESULT_TIMEOUT);
      if (m[shareId]) { r = m[shareId]; delete m[shareId]; gmSet(GM_RESULTS, m); }
    }
    try { GM_setValue(GM_RESULT_PREFIX + shareId, null); } catch {}
    if (!r) return null;
    /* 上一轮遗留的陈旧结果不能当作本轮结果 */
    if (!(r.ts > 0) || Date.now() - r.ts > RESULT_STALE_MS) return null;
    return r;
  }
  function clearResult(shareId) {
    if (!shareId) return;
    try { GM_setValue(GM_RESULT_PREFIX + shareId, null); } catch {}
    const m = gmGet(GM_RESULTS, {}) || {};
    if (m[shareId]) { delete m[shareId]; gmSet(GM_RESULTS, m); }
  }
  function cleanupBridgeComm() {
    const now = Date.now();
    const tasks = gmGet(GM_TASKS, {}) || {};
    if (_pruneByTTL(tasks, TASK_TTL)) gmSet(GM_TASKS, tasks);
    const results = gmGet(GM_RESULTS, {}) || {};
    if (_pruneByTTL(results, TAB_RESULT_TIMEOUT)) gmSet(GM_RESULTS, results);
    /* 独立键的旧数据：按索引回收（索引是尽力而为，写丢了最多残留一个小键） */
    const idx = gmGet(GM_COMM_INDEX, {}) || {};
    const keep = Math.max(TASK_TTL, RESULT_STALE_MS) + 3600000;
    let changed = false;
    for (const sid of Object.keys(idx)) {
      if (now - (idx[sid] || 0) <= keep) continue;
      delete idx[sid];
      changed = true;
      try {
        GM_setValue(GM_TASK_PREFIX + sid, null);
        GM_setValue(GM_RESULT_PREFIX + sid, null);
      } catch {}
    }
    if (changed) gmSet(GM_COMM_INDEX, idx);
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

  function normalizeSizeStr(s) {
    const t = String(s ?? '').trim();
    if (!t) return '';
    if (t === '--' || t === '-' || t === '—' || /^未知|loading/i.test(t)) return '';
    return t.replace(/\s+/g, '').toUpperCase();
  }

  /* ===== 文件名标识符 ===== */
  const FILE_NAME_MARKER = '[bgm]';
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function getFileNameMarkerRe() {
    return new RegExp(`${escapeRegExp(FILE_NAME_MARKER)}[\\s\\S]*?${escapeRegExp(FILE_NAME_MARKER)}`, 'gi');
  }
  function sanitizeFileName(s) {
    return String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(getFileNameMarkerRe(), '').trim();
  }
  function normalizeFileName(s) { return sanitizeFileName(s); }
  function getComparableFileName(s) { return normalizeFileName(s); }
  function stripMarkerBlock(s) {
    let cur = String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '');
    const re = new RegExp(`^(?:${escapeRegExp(FILE_NAME_MARKER)}[\\s\\S]*?${escapeRegExp(FILE_NAME_MARKER)})+`, 'i');
    for (let i = 0; i < 20; i++) {
      const next = cur.replace(re, '');
      if (next === cur) break;
      cur = next;
    }
    return cur;
  }

  function fitAcgName(acgName, originalName, maxBytes = 250) {
    const base = String(originalName ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(new RegExp(escapeRegExp(FILE_NAME_MARKER), 'g'), '')
    .trim();
    const nm = String(acgName ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(new RegExp(escapeRegExp(FILE_NAME_MARKER), 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
    if (!base || !nm) return { name: '', truncated: false };
    const build = s => `${s} ${base}`;
    const bytes = s => { try { return new TextEncoder().encode(s).length; } catch { return s.length * 3; } };
    const full = build(nm);
    if (bytes(full) <= maxBytes) return { name: full, truncated: false };
    const cps = Array.from(nm);
    const take = n => cps.slice(0, n).join('');
    let lo = 1, hi = cps.length, best = '';
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bytes(build(take(mid))) <= maxBytes) { best = take(mid); lo = mid + 1; }
      else hi = mid - 1;
    }
    if (!best) return { name: '', truncated: false };
    return { name: build(best), truncated: true };
  }
  function buildRenamedFileName(acgName, originalName) {
    return fitAcgName(acgName, originalName).name;
  }
  function needRename(currentName, acgName) {
    const raw = String(currentName || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!raw) return false;
    const acg = String(acgName || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!acg) return false;
    if (stripMarkerBlock(raw) !== raw) return true;
    if (raw.startsWith(acg + ' ')) {
      const suffix = raw.slice(acg.length + 1);
      if (suffix && suffix.trim()) return false;
    }
    if (raw.startsWith(acg)) {
      const suffix = raw.slice(acg.length);
      if (suffix && suffix.trim() && !suffix.startsWith(' ')) return false;
    }
    return true;
  }
  function isSameFile(a, b) {
    if (!a || !b) return false;
    if (normalizeFileName(a.name) !== normalizeFileName(b.name)) return false;
    const sa = normalizeSizeStr(a.sizeStr);
    const sb = normalizeSizeStr(b.sizeStr);
    if (!sa || !sb) return true;
    if (sa === sb) return true;
    if (sameIconSig(a.iconSig, b.iconSig)) return true;
    return false;
  }
  function normalizeShareKey(url) {
    const m = String(url || '').match(/\/s\/([a-zA-Z0-9]+)/);
    return m ? `https://pan.quark.cn/s/${m[1]}` : String(url).split('?')[0].replace(/\/$/, '');
  }
  function extractShareId(url) {
    const m = String(url || '').match(/\/s\/([a-zA-Z0-9]+)/);
    return m ? m[1] : '';
  }
  function currentCacheKey() { return extractShareId(location.href) || 'default'; }

  /* ===== bangumiData ===== */
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

  function isDHHMMValue(v) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 10000 && n <= 79959;
  }
  function dhhmmIsPassed(v, nowMs) {
    const n = Number(v);
    if (!isDHHMMValue(n)) return null;
    const now = nowMs != null ? new Date(nowMs) : new Date();
    let day = Math.floor(n / 10000);
    let hh = Math.floor(n / 100) % 100;
    const mm = n % 100;
    if (hh >= 24) { hh -= 24; day = day === 7 ? 1 : day + 1; }
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    if (now.getHours() < 4) today.setDate(today.getDate() - 1);
    const dow = today.getDay() || 7;
    const monday = new Date(today);
    monday.setDate(monday.getDate() - (dow - 1));
    const target = new Date(monday);
    target.setDate(target.getDate() + (day - 1));
    target.setHours(hh, mm, 0, 0);
    return target.getTime() <= now.getTime();
  }

  /* 是否应处理该行（关键修复：优先看 _airDate）
   * _airDate 是"下集"的放送时间；如果下集还没放送，即使每周轮询时间已到也不该处理。 */
  function shouldIncludeRow(row) {
    if (!row) return true;
    const airTs = row._airDate;
    if (typeof airTs === 'number' && Number.isFinite(airTs) && airTs > 0 && airTs > Date.now()) {
      return false;
    }
    const resVal = String(row.资源 ?? '').trim();
    if (resVal && isDHHMMValue(resVal)) {
      const passed = dhhmmIsPassed(resVal);
      if (passed != null) return passed;
    }
    if (typeof airTs === 'number' && airTs > 0) return airTs <= Date.now();
    return true;
  }

  /* “已播出”模式：只看播出时间（_airDate = 下集实际放送时刻），
   * 不看资源时间（资源列写成 DHHMM 周更时段时，shouldIncludeRow 会优先用那个时段）。
   * 没有 _airDate 的行退回老规则，避免整行被漏掉。 */
  function shouldIncludeRowAired(row) {
    if (!row) return true;
    const airTs = row._airDate;
    if (typeof airTs === 'number' && Number.isFinite(airTs) && airTs > 0) return airTs <= Date.now();
    return shouldIncludeRow(row);
  }

  function collectShareUrls(bd, opts = {}) {
    if (!bd || !Array.isArray(bd.rows)) return [];
    const include = opts.onlyAired ? shouldIncludeRowAired : shouldIncludeRow;
    const urls = new Set();
    for (const row of bd.rows) {
      if (!include(row)) continue;
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

  /* ===== 转存记录 ===== */
  function loadRecords(opts = {}) {
    const consumeClear = opts.consumeClear !== false;
    const clearTs = Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
    if (consumeClear && clearTs > 0) {
      gmSet(GM_RECORDS, {});
      GM_setValue(GM_CLEAR_FLAG, 0);
      log(`★ 响应清空请求，转存记录已清空（ts=${clearTs}）`);
      return {};
    }
    return gmGet(GM_RECORDS, {}) || {};
  }
  function saveRecords(recs) { gmSet(GM_RECORDS, recs); }

  /* 并行转存时多个子标签页会同时改 GM_RECORDS（共享 map：后写的会覆盖先写的）。
   * 写完回读校验，发现本次写入被覆盖就重试，保证最终生效。 */
  async function mergeShareRecord(key, files, extra = {}) {
    if (!key) return null;
    const wanted = (files || []).map(f => normalizeFileName(f && f.name)).filter(Boolean);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const recs = loadRecords();
      const prev = recs[key] || {};
      const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
      for (const f of (files || [])) {
        upsertFileInfo(merged, {
          name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
          fid: f.fid || '', mtime: f.mtime || '',
        });
      }
      recs[key] = {
        ...prev, ts: Date.now(),
        shareId: extra.shareId || prev.shareId || extractShareId(key),
        fileInfos: merged, names: merged.map(x => x.name),
      };
      saveRecords(recs);
      if (!wanted.length) return recs[key];
      const cur = (loadRecords()[key]) || null;
      const has = new Set(((cur && cur.fileInfos) || []).map(x => normalizeFileName(x && x.name)));
      if (wanted.every(w => has.has(w))) return cur;
      warn(` ⚠️ 记录写入被并发覆盖，重试 ${attempt}/4：${key}`);
      await sleep(120 * attempt, true);
    }
    warn(` ⚠️ 记录写入多次被并发覆盖，放弃重试：${key}`);
    return null;
  }

  function collectSavedInfos(records) {
    return Object.values(records || {}).flatMap(r => Array.isArray(r.fileInfos) ? r.fileInfos : []);
  }
  function getShareFileInfos(shareKey) {
    const recs = loadRecords();
    const r = shareKey ? recs[shareKey] : null;
    return (r && Array.isArray(r.fileInfos)) ? r.fileInfos : [];
  }

  function healShareRecords(shareKey, files) {
    const recs = loadRecords();
    const rec = shareKey ? recs[shareKey] : null;
    if (!rec || !Array.isArray(rec.fileInfos)) return [];
    const list = rec.fileInfos;
    if (!Array.isArray(files) || !files.length) return list;
    const byName = new Map();
    for (const f of files) {
      const nk = normalizeFileName(f.name);
      if (nk && !byName.has(nk)) byName.set(nk, f);
    }
    let healed = 0;
    for (const si of list) {
      const nk = normalizeFileName(si && si.name);
      if (!nk) continue;
      const f = byName.get(nk);
      if (!f) continue;
      if (String(si.sizeStr ?? '').trim() !== String(f.sizeStr ?? '').trim()) continue;
      let dirty = false;
      if (!si.fid && f.fid) { si.fid = f.fid; dirty = true; }
      if (!si.mtime && f.mtime) { si.mtime = f.mtime; dirty = true; }
      if (!isIdentifiableIconSig(si.iconSig) && isIdentifiableIconSig(f.iconSig)) {
        si.iconSig = f.iconSig; dirty = true;
      }
      if (dirty) healed++;
    }
    if (healed) {
      rec.ts = Date.now();
      recs[shareKey] = rec;
      saveRecords(recs);
      log(`★ 记录自愈：${shareKey} 补全 ${healed} 条记录的 fid/mtime/iconSig`);
    }
    return list;
  }

  function recordFormerNameByFid(fid, oldName) {
    if (!fid || !oldName) return false;
    const oldKey = String(oldName).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    if (!oldKey) return false;
    const recs = loadRecords();
    let changed = false;
    let hitShare = '';
    for (const key of Object.keys(recs)) {
      const rec = recs[key];
      if (!rec || !Array.isArray(rec.fileInfos)) continue;
      const item = rec.fileInfos.find(fi => fi && String(fi.fid || '') === String(fid));
      if (!item) continue;
      const arr = Array.isArray(item.formerNames) ? item.formerNames.slice() : [];
      const exists = arr.some(x => {
        const k = String(x || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
        return k === oldKey;
      });
      if (exists) return false;
      arr.push(String(oldName));
      item.formerNames = arr;
      rec.ts = Date.now();
      changed = true;
      hitShare = key;
      break;
    }
    if (changed) {
      saveRecords(recs);
      log(`★ 记录曾用名：${fid} ← ${oldName}（share=${hitShare}）`);
    }
    return changed;
  }

  function collectAllShareKeys(bd) {
    const keys = new Set();
    if (!bd || !Array.isArray(bd.rows)) return keys;
    for (const row of bd.rows) {
      for (const f of ['资源', '规则']) {
        const m = String((row && row[f]) || '').match(/pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/);
        if (m && m[1]) keys.add(`https://pan.quark.cn/s/${m[1]}`);
      }
    }
    return keys;
  }

  function upsertFileInfo(merged, item) {
    if (!item || !item.name) return false;
    const nameKey = normalizeFileName(item.name);
    if (!nameKey) return false;
    const idx = merged.findIndex(mi => normalizeFileName(mi && mi.name) === nameKey);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...item };
      return false;
    }
    merged.push(item);
    return true;
  }

  function getAcgDisplayName(row) {
    if (!row) return '';
    const pick = v => {
      const s = String(v ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      return s === '' ? '' : s;
    };
    const cn = pick(row['中文']);
    const nm = pick(row['名称']);
    if (cn) return cn;
    if (nm) return nm;
    let parsed = {};
    try { parsed = parseBgmIdRef(row.BGMID) || {}; } catch {}
    return pick(parsed['中文']) || pick(parsed['名称']) || '';
  }

  function parseBgmIdRef(text) {
    if (!text) return {};
    const plain = String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
    const parts = plain.split(',');
    return {
      id: (parts[0] || '').trim(),
      名称: (parts[1] || '').trim(),
      中文: (parts[2] || '').trim(),
    };
  }

  function collectShareNamesFromRow(row) {
    if (!row) return [];
    const finalName = getAcgDisplayName(row);
    const out = [];
    for (const f of ['资源', '规则']) {
      const raw = String(row[f] || '').trim();
      if (!raw) continue;
      let expanded = raw;
      try { expanded = expandUrl(raw, row); } catch {}
      const re = /pan\.quark\.cn\/s\/([a-zA-Z0-9]+)/g;
      let m;
      while ((m = re.exec(expanded))) out.push({ key: `https://pan.quark.cn/s/${m[1]}`, finalName });
    }
    return out;
  }

  function collectShareNameMap(bd) {
    const map = new Map();
    const conflict = new Map();
    for (const row of ((bd && Array.isArray(bd.rows)) ? bd.rows : [])) {
      for (const { key, finalName } of collectShareNamesFromRow(row)) {
        if (!finalName) continue;
        if (conflict.has(key)) continue;
        const prev = map.get(key);
        if (prev === undefined) { map.set(key, finalName); continue; }
        if (prev !== finalName) {
          map.delete(key);
          conflict.set(key, `"${prev}" / "${finalName}"`);
        }
      }
    }
    return { map, conflict };
  }

  function sweepObsoleteRecords() {
    const clearTs = Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
    if (clearTs > 0) {
      log('★ 过期清理：检测到清空请求（clearFlag > 0），跳过本次');
      return { removed: 0, marked: 0, unmarked: 0 };
    }
    const bd = loadBangumiData();
    if (!bd || !Array.isArray(bd.rows) || !bd.rows.length) {
      log('★ 过期清理：数据不可用，跳过');
      return { removed: 0, marked: 0, unmarked: 0 };
    }
    const live = collectAllShareKeys(bd);
    if (!live.size) {
      log('★ 过期清理：清单无夸克链接，跳过');
      return { removed: 0, marked: 0, unmarked: 0 };
    }
    const recs = gmGet(GM_RECORDS, {}) || {};
    const now = Date.now();
    const allKeys = Object.keys(recs);
    const recCount = allKeys.length;
    const tooMany = recCount > live.size + Math.max(5, Math.floor(live.size * 0.5));
    if (tooMany) {
      log(`★ 过期清理：记录 ${recCount} 远多于清单 ${live.size}，跳过`);
      return { removed: 0, marked: 0, unmarked: 0 };
    }
    let removed = 0, marked = 0, unmarked = 0;
    for (const key of allKeys) {
      const rec = recs[key];
      if (!rec || typeof rec !== 'object') continue;
      const norm = normalizeShareKey(key);
      if (live.has(norm)) {
        if (rec.obsoleteAt) { delete rec.obsoleteAt; unmarked++; }
      } else {
        if (!rec.obsoleteAt || typeof rec.obsoleteAt !== 'number') {
          rec.obsoleteAt = now; marked++;
        } else if (now - rec.obsoleteAt >= OBSOLETE_TTL_MS) {
          delete recs[key]; removed++;
        }
      }
    }
    if (marked || unmarked || removed) gmSet(GM_RECORDS, recs);
    log(`★ 过期清理：标记 ${marked}，清除标记 ${unmarked}，删除 ${removed}`);
    return { removed, marked, unmarked };
  }

  /* ===== 是否已转存 ===== */
  function explainIsFileSaved(file, savedInfos, wantReason = false) {
    const out = { saved: false, level: 0, reason: '' };
    if (!file) { if (wantReason) out.reason = '无文件对象'; return out; }
    if (!Array.isArray(savedInfos) || !savedInfos.length) {
      if (wantReason) out.reason = '记录为空';
      return out;
    }
    const rawName = String(file.name || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const name = normalizeFileName(file.name);
    const fid = String(file.fid || '');
    const iconSig = file.iconSig || '';
    const sizeStr = String(file.sizeStr ?? '').trim();
    const sizeCompat = (a, b) => {
      const sa = String(a ?? '').trim();
      const sb = String(b ?? '').trim();
      if (!sa || !sb) return true;
      return sa === sb;
    };
    const sizeStrict = (a, b) => {
      const sa = String(a ?? '').trim();
      const sb = String(b ?? '').trim();
      return !!sa && !!sb && sa === sb;
    };
    if (fid) {
      const hit = savedInfos.find(si => si && si.fid && String(si.fid) === fid);
      if (hit) {
        out.saved = true; out.level = 1;
        if (wantReason) out.reason = `L1 fid=${fid} 命中「${hit.name}」`;
        return out;
      }
    }
    if (isIdentifiableIconSig(iconSig)) {
      const curFid = iconFid(iconSig);
      for (const si of savedInfos) {
        if (!si) continue;
        const savedIcon = si.iconSig || '';
        if (!isIdentifiableIconSig(savedIcon)) continue;
        if (curFid) {
          if (iconFid(savedIcon) && iconFid(savedIcon) === curFid) {
            out.saved = true; out.level = 2;
            if (wantReason) out.reason = `L2 icon fid=${curFid} 命中「${si.name}」`;
            return out;
          }
        } else {
          if (!name) continue;
          if (normalizeFileName(si.name) !== name) continue;
          if (sameIconSig(savedIcon, iconSig)) {
            out.saved = true; out.level = 2;
            if (wantReason) out.reason = `L2 同名+同 icon 命中「${si.name}」`;
            return out;
          }
        }
      }
    }
    if (name) {
      for (const si of savedInfos) {
        if (!si) continue;
        const savedName = normalizeFileName(si.name);
        if (!savedName || savedName !== name) continue;
        if (!sizeCompat(sizeStr, si.sizeStr)) continue;
        out.saved = true; out.level = 3;
        if (wantReason) out.reason = `L3 最新名命中「${si.name}」`;
        return out;
      }
    }
    if (name) {
      for (const si of savedInfos) {
        if (!si) continue;
        const arr = Array.isArray(si.formerNames) ? si.formerNames : [];
        for (const fn of arr) {
          const fnNorm = normalizeFileName(fn);
          if (!fnNorm || fnNorm !== name) continue;
          if (!sizeCompat(sizeStr, si.sizeStr)) continue;
          out.saved = true; out.level = 4;
          if (wantReason) out.reason = `L4 曾用名命中「${si.name}」曾用「${fn}」`;
          return out;
        }
      }
    }
    const pageStripped = stripMarkerBlock(rawName);
    if (pageStripped && pageStripped !== rawName) {
      for (const si of savedInfos) {
        if (!si) continue;
        if (!sizeStrict(sizeStr, si.sizeStr)) continue;
        const tryHitA = (rawCandidate) => {
          const cRaw = String(rawCandidate || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          const cStripped = stripMarkerBlock(cRaw);
          if (!cStripped) return '';
          if (cStripped === pageStripped) return cStripped;
          if (cStripped.endsWith(' ' + pageStripped)) return cStripped;
          return '';
        };
        const hitA = tryHitA(si.name);
        if (hitA) {
          out.saved = true; out.level = 5;
          if (wantReason) out.reason = `L5a 页面剥离「${pageStripped}」命中记录「${si.name}」`;
          return out;
        }
        const arr = Array.isArray(si.formerNames) ? si.formerNames : [];
        for (const fn of arr) {
          const hitFnA = tryHitA(fn);
          if (hitFnA) {
            out.saved = true; out.level = 5;
            if (wantReason) out.reason = `L5a 页面剥离「${pageStripped}」命中曾用名「${fn}」`;
            return out;
          }
        }
      }
    }
    if (name) {
      for (const si of savedInfos) {
        if (!si) continue;
        if (!sizeStrict(sizeStr, si.sizeStr)) continue;
        const tryHitB = (rawCandidate) => {
          const cRaw = String(rawCandidate || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          const cStripped = stripMarkerBlock(cRaw);
          if (!cStripped) return '';
          if (name === cStripped) return cStripped;
          if (name.endsWith(' ' + cStripped)) return cStripped;
          if (cStripped !== cRaw && name.endsWith(cStripped)) return cStripped;
          return '';
        };
        const hitB = tryHitB(si.name);
        if (hitB) {
          out.saved = true; out.level = 5;
          if (wantReason) out.reason = `L5b 页面「${name}」匹配记录剥离「${hitB}」`;
          return out;
        }
        const arr = Array.isArray(si.formerNames) ? si.formerNames : [];
        for (const fn of arr) {
          const hitFnB = tryHitB(fn);
          if (hitFnB) {
            out.saved = true; out.level = 5;
            if (wantReason) out.reason = `L5b 页面「${name}」匹配曾用名剥离「${hitFnB}」`;
            return out;
          }
        }
      }
    }
    if (wantReason) {
      out.reason = [
        fid ? `L1 无同 fid` : `L1 无 fid`,
        `L3 最新名未匹配`,
        `L4 曾用名未匹配`,
        `L5 [bgm]兜底未匹配`,
      ].join('；');
    }
    return out;
  }
  function isFileSaved(file, savedInfos) { return explainIsFileSaved(file, savedInfos, false).saved; }

  /* ===== 全量重转 Debug ===== */
  function truncateStr(s, n) {
    const t = String(s ?? '');
    if (t.length <= n) return t;
    return t.slice(0, n) + `…(+${t.length - n})`;
  }
  function loadFullResaveDebug() { return gmGet(GM_FULL_RESAVE_DEBUG, []) || []; }
  function clearFullResaveDebug() { gmSet(GM_FULL_RESAVE_DEBUG, []); }
  function appendFullResaveDebug(entry) {
    const arr = loadFullResaveDebug();
    arr.unshift(entry);
    if (arr.length > FULL_RESAVE_DEBUG_MAX) arr.length = FULL_RESAVE_DEBUG_MAX;
    gmSet(GM_FULL_RESAVE_DEBUG, arr);
  }
  function maybeSaveFullResaveDebug(qa, files, savedInfos, opts = {}) {
    try {
      if (!Array.isArray(files) || !files.length) return null;
      const incomplete = opts.incomplete === true;
      const expected = Number(opts.expected) > 0 ? Number(opts.expected) : null;
      const results = files.map(f => {
        const ex = explainIsFileSaved(f, savedInfos, true);
        const hasSameName = Array.isArray(savedInfos) && savedInfos.some(si =>
          si && normalizeFileName(si.name) === normalizeFileName(f.name)
        );
        return { file: f, ex, hasSameName };
      });
      const savedCount = results.filter(r => r.ex.saved).length;
      if (savedCount !== 0) return null;
      const matchedButFailed = results.filter(r => r.hasSameName);
      const noRecordEntry = results.filter(r => !r.hasSameName);
      const shareKey = normalizeShareKey(location.href);
      const recsAll = loadRecords({ consumeClear: false });
      const recordKeys = Object.keys(recsAll);
      const clearFlag = (opts.clearFlagAtStart != null)
        ? Number(opts.clearFlagAtStart) || 0
        : Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
      const savedInfosCount = Array.isArray(savedInfos) ? savedInfos.length : 0;
      let note;
      if (incomplete) note = `扫描不完整（${files.length}/${expected || '?'}）`;
      else if (savedInfosCount === 0) note = clearFlag > 0 ? `无记录+清空请求` : '无记录';
      else if (noRecordEntry.length === files.length) note = `无同名记录`;
      else if (matchedButFailed.length === files.length) note = `有同名但匹配失败`;
      else note = `${matchedButFailed.length} 匹配失败 / ${noRecordEntry.length} 无记录`;
      appendFullResaveDebug({
        ts: Date.now(), time: new Date().toLocaleString(),
        source: opts.source || 'unknown', href: location.href, shareKey,
        shareId: extractShareId(location.href),
        totalFiles: files.length, expectedFiles: expected, incomplete,
        savedCount, savedInfosCount, recordKeys, recordKeysCount: recordKeys.length,
        clearFlag, note,
        files: results.map(r => ({
          name: r.file.name, sizeStr: r.file.sizeStr, mtime: r.file.mtime || '',
          fid: r.file.fid || '', iconSig: truncateStr(r.file.iconSig, 300),
          iconSigLen: String(r.file.iconSig || '').length,
          hasSameName: r.hasSameName, level: r.ex.level, result: r.ex.reason,
        })),
        savedInfos: (Array.isArray(savedInfos) ? savedInfos : []).map(si => ({
          name: si && si.name, sizeStr: si && si.sizeStr, mtime: (si && si.mtime) || '',
          fid: (si && si.fid) || '',
          formerNames: Array.isArray(si && si.formerNames) ? si.formerNames : [],
          iconSig: truncateStr(si && si.iconSig, 300),
          iconSigLen: String((si && si.iconSig) || '').length,
        })),
      });
      warn(`★ 全量重转 Debug 已记录：${note}`);
      return note;
    } catch (e) {
      warn('写入全量重转 Debug 失败', e);
      return null;
    }
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

  /* ===== 全表缓存 ===== */
  let _allFilesCache = null;
  const ALL_FILES_CACHE_TTL = 60 * 1000;
  function setAllFilesCache(key, files) { _allFilesCache = { key, files, ts: Date.now() }; }
  function getAllFilesCache(key) {
    if (!_allFilesCache) return null;
    if (key && _allFilesCache.key !== key) return null;
    if (Date.now() - _allFilesCache.ts > ALL_FILES_CACHE_TTL) return null;
    return _allFilesCache.files;
  }

  /* ===== 虚拟滚动 ===== */
  function getTableBody(doc = document) { return doc.querySelector('.ant-table-body'); }
  function isShareTableLoading(doc = document) {
    if (doc.querySelector('.ant-table-wrapper .ant-table-spin-holder.ant-spin-spinning')) return true;
    if (doc.querySelector('.ant-table-wrapper .table-loading-wrap')) return true;
    if (doc.querySelector('.ant-table-wrapper .ant-spin-container.ant-spin-blur')) return true;
    return false;
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

  /* ===== 扫描完整性状态 =====
   * 头部"共 N 个文件"是**整个分享**的口径（含文件夹本身、含各子目录里的文件），
   * 进子文件夹后数字不变，因此它只能当"上界"，不能用来判当前目录是否扫全。
   * 真正的判据是：滚动扫描是否走到了底、且没有超时（见 scanAllRowsByScroll 记录）。 */
  let _lastScan = null;
  function isLastScanComplete(maxAgeMs = 180000) {
    if (!_lastScan) return false;
    if (Date.now() - _lastScan.at > maxAgeMs) return false;
    return _lastScan.reachedBottom === true && _lastScan.timedOut !== true;
  }

  /* 扫描所有行。返回数组，调用方用 length vs expected 判断完整性。 */
  async function scanAllRowsByScroll(qa, doc = document, opts = {}) {
    const useCache = opts.useCache === true;
    const key = opts.key || null;

    const isHidden = !!doc.hidden;
    const maxMsBase = opts.maxMs || 40000;
    const maxMs = isHidden ? maxMsBase * 3 : maxMsBase;
    const sleepStep = isHidden ? 300 : 100;
    const sleepSmall = isHidden ? 250 : 150;
    const sleepFinal = isHidden ? 400 : 200;
    const sleepRestore = isHidden ? 250 : 120;
    const loadingMoreWait = isHidden ? 4500 : 1500;
    const loadingMoreCheck = isHidden ? 150 : 60;

    if (isHidden) warn(` ⚠️ 检测到后台标签页，扫描步进加大（sleep=${sleepStep}ms, maxMs=${maxMs}ms）`);

    if (useCache && key) {
      const cached = getAllFilesCache(key);
      if (cached) {
        /* 缓存只在"扫到底且未超时"时写入，可直接复用；
         * 不能用头部总数比（它是整个分享口径，进子文件夹后恒大于当前目录行数） */
        const expected0 = getShareFileCount(doc);
        if (expected0 && cached.length < expected0) {
          log(` ★ 复用缓存：${cached.length} 行（头部 ${expected0}，含文件夹本身/其它目录，属正常差额）`);
        } else {
          log(` ★ 复用缓存：${cached.length} 行`);
        }
        return cached;
      }
    }

    /* 这里刻意用"分享总数"（.info-stat）作为上界：它 ≥ 当前目录条数，
     * 不会因为低估而在 visited.size >= expected 时提前 break 掉真行 */
    const expected = getShareFileCount(doc);

    if (isShareTableLoading(doc)) {
      log(` ⏳ 检测到表格仍在初始化加载，等待...`);
      await until(() => !isShareTableLoading(doc), 150, 15000);
    }

    const body = getTableBody(doc);
    const visibleRows = qa.scanFileRows(doc);
    const needFullScan = !!(expected && visibleRows.length < expected);

    if (!body || (!isVirtualScrolling(body) && !needFullScan)) {
      /* 非虚拟滚动/无表体：可视区就是全部 */
      _lastScan = { count: visibleRows.length, expected, reachedBottom: true, timedOut: false, at: Date.now() };
      if (useCache && key) setAllFilesCache(key, visibleRows);
      return visibleRows;
    }

    if (!body) {
      warn(` ⚠️ 无 .ant-table-body 但需要全扫（可见 ${visibleRows.length}/${expected}），只能返回可见区`);
      _lastScan = { count: visibleRows.length, expected, reachedBottom: false, timedOut: false, at: Date.now() };
      if (useCache && key) setAllFilesCache(key, visibleRows);
      return visibleRows;
    }

    log(` ★ 全表扫描（可见 ${visibleRows.length} / 期望 ${expected || '?'}${isVirtualScrolling(body) ? ' / 虚拟滚动' : ''}）`);

    const hasLoadingMore = () => !!doc.querySelector(
      '.recent-loading-tr .ant-spin-spinning, tr[data-row-config-type="more"] .ant-spin-spinning'
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
        visited.set(r.name, r);
      }
      return added;
    };

    body.scrollTop = 0;
    await qa.sleep(sleepSmall);
    harvest();

    let lastScrollH = body.scrollHeight;
    let lastSize = visited.size;
    let stallCount = 0;
    let reachedBottom = false;
    let timedOut = false;
    const MAX_STALL_BOTTOM = 5;
    const MAX_STALL_MID = 5;

    while (Date.now() - t0 < maxMs) {
      if (expected && visited.size >= expected) break;
      const bodyH = body.clientHeight;
      const scrollH = body.scrollHeight;
      const curTop = body.scrollTop;
      const atBottom = curTop + bodyH >= scrollH - 8;
      reachedBottom = atBottom;   /* 取最后一次观测值：中途停顿 break 时不能算"到底" */
      if (atBottom) {
        if (hasLoadingMore()) {
          await qa.until(() => !hasLoadingMore(), loadingMoreCheck, loadingMoreWait);
        } else {
          await qa.sleep(sleepStep);
        }
        const added = harvest();
        const newH = body.scrollHeight;
        if (newH > lastScrollH + 4) {
          lastScrollH = newH; lastSize = visited.size; stallCount = 0; continue;
        }
        if (added === 0 && visited.size === lastSize && !hasLoadingMore()) {
          stallCount++;
          if (stallCount >= MAX_STALL_BOTTOM) break;
        } else stallCount = 0;
        lastSize = visited.size;
        continue;
      }
      const step = Math.max(200, Math.floor(bodyH * 0.8));
      body.scrollTop = Math.min(curTop + step, scrollH);
      await qa.sleep(sleepStep);
      const added = harvest();
      if (added === 0) { stallCount++; if (stallCount >= MAX_STALL_MID) break; }
      else stallCount = 0;
      lastSize = visited.size;
      lastScrollH = body.scrollHeight;
    }

    timedOut = (Date.now() - t0) >= maxMs;

    await qa.sleep(sleepFinal);
    harvest();
    body.scrollTop = startTop;
    await qa.sleep(sleepRestore);

    const result = [...visited.values()];
    _lastScan = { count: result.length, expected, reachedBottom, timedOut, at: Date.now() };
    log(` ★ 滚动扫描：收集 ${result.length} 行（头部 ${expected || '?'}，到底=${reachedBottom}，超时=${timedOut}）`);

    if (useCache && key) {
      if (reachedBottom && !timedOut) setAllFilesCache(key, result);
      else warn(` ⚠️ 扫描未确认完整（${result.length} 行，到底=${reachedBottom}），不写缓存`);
    }
    return result;
  }

  async function scanCheckedRowsByScroll(qa, doc = document, opts = {}) {
    const cacheKey = opts.cacheKey || null;
    const body = getTableBody(doc);
    if (!body || !isVirtualScrolling(body)) {
      return qa.scanFileRows(doc).filter(f => f.checked);
    }
    const all = await scanAllRowsByScroll(qa, doc, { key: cacheKey, useCache: false });
    return all.filter(f => f.checked);
  }

  async function scrollToRowByName(qa, doc, name, opts = {}) {
    const body = getTableBody(doc);
    if (!body) return null;
    let hit = qa.scanFileRows(doc).find(f => f.name === name);
    if (hit) return hit;
    if (!isVirtualScrolling(body)) return null;
    const startTop = body.scrollTop;
    const bodyH = body.clientHeight;
    const totalH = body.scrollHeight;
    const step = Math.max(150, bodyH - 80);
    const maxMs = opts.maxMs || 6000;
    const t0 = Date.now();
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

  /* ===== 分享页置灰 + 进度 ===== */
  const SHARE_GRAY_CLASS = 'qap-grayed';
  let _shareFullCounts = null;
  function applyShareGray(qa, doc = document) {
    const files = qa.scanFileRows(doc);
    const savedInfos = getShareFileInfos(normalizeShareKey(location.href));
    let grayed = 0;
    for (const f of files) {
      if (isFileSaved(f, savedInfos)) { f.row.classList.add(SHARE_GRAY_CLASS); grayed++; }
      else f.row.classList.remove(SHARE_GRAY_CLASS);
    }
    return { grayed, total: files.length };
  }
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
  function refreshShareUI(qa, doc = document) {
    if (isShareTableLoading(doc)) return;
    applyShareGray(qa, doc);
    if (_shareFullCounts) {
      qa.showProgress(_shareFullCounts.num, _shareFullCounts.total, '已转存');
      qa.setProgress(`${_shareFullCounts.num} / ${_shareFullCounts.total}`);
    }
  }
  let _sharePollingStarted = false;
  function startSharePolling(qa) {
    if (_sharePollingStarted) return;      /* 待机期间补做子任务时会二次进入，避免重复轮询 */
    _sharePollingStarted = true;
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
  async function refreshShareFullCounts(qa, doc = document) {
    try {
      const key = currentCacheKey();
      const allFiles = (await scanAllRowsByScroll(qa, doc, { key, useCache: true }) || []).filter(f => !isFolderFile(f));
      if (!allFiles.length) return;
      const savedInfos = healShareRecords(normalizeShareKey(location.href), allFiles);
      const savedCount = allFiles.filter(f => isFileSaved(f, savedInfos)).length;
      setShareFullCounts(qa, savedCount, allFiles.length);
      log(`★ 全量进度：${savedCount} / ${allFiles.length}`);
    } catch (e) { warn('全量进度统计失败', e); }
  }

  /* ===== 排序 ===== */
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
      warn(` 排序：${headerTimeout}ms 内未找到"修改日期"表头，跳过`);
      return { ok: false, reason: 'no-th' };
    }
    if (getThSortState(th0) === 'desc') {
      log(' 排序：已是"修改日期"降序');
      return { ok: true, method: 'already' };
    }
    for (let i = 0; i < maxTries; i++) {
      const th = findTimeSortHeader(doc);
      if (!th) { warn(' 排序：点击过程中表头消失，跳过'); return { ok: false, reason: 'no-th-midway' }; }
      if (getThSortState(th) === 'desc') return { ok: true, method: i === 0 ? 'already' : 'clicked', tries: i };
      const before = getThSortState(th);
      const target = th.querySelector('.table-order') || th;
      try {
        if (qa && typeof qa.realClick === 'function') qa.realClick(target);
        else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } catch { try { target.click(); } catch {} }
      const got = await until(() => {
        const cur = findTimeSortHeader(doc);
        if (!cur) return null;
        const st = getThSortState(cur);
        if (st === 'desc') return { done: true, st };
        if (st !== before) return { done: false, st };
        return null;
      }, interval, settleTimeout);
      if (got && got.done) return { ok: true, method: 'clicked', tries: i + 1 };
    }
    warn(` 排序：${maxTries} 次点击后仍未切到降序，放弃`);
    return { ok: false, reason: 'cannot-desc' };
  }

  /* ===== 转存原语 ===== */
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
    } catch { return false; }
    return true;
  }
  /* 视口中心最上层的元素是不是 iframe（= 有全屏/居中 iframe 真的盖在页面上） */
  function isIframeCovering(doc = document) {
    try {
      const w = doc.documentElement.clientWidth;
      const h = doc.documentElement.clientHeight;
      const top = doc.elementFromPoint(Math.floor(w / 2), Math.floor(h / 2));
      if (!top) return false;
      return top.tagName === 'IFRAME' || !!(top.closest && top.closest('iframe'));
    } catch { return false; }
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
          for (const sel of ['.ant-message-notice', '.ant-notification-notice', '.swal2-popup',
            '[role="alert"]', '[role="dialog"]', '[class*="toast"]', '[class*="error"]', '[class*="message"]']) {
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
      /* 跨域 iframe（收银台）：只能靠"是否真的盖住页面"判断。
       * 注意 QKVIP_* 收银台 iframe 常驻 DOM（100%×100%、z-index:999），关闭后依然存在，
       * 只按尺寸判断会把它当成"空间不足"，从而让之后每次保存都误判失败 */
      try {
        const cs = (f.ownerDocument.defaultView || window).getComputedStyle(f);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        if (cs.pointerEvents === 'none') continue;
        const r = f.getBoundingClientRect();
        const w = r.width || parseFloat(cs.width) || 0;
        const h = r.height || parseFloat(cs.height) || 0;
        if (!(w >= winW * 0.9 && h >= winH * 0.9)) continue;
        const z = parseInt(cs.zIndex, 10);
        if (isNaN(z) || z < 0) continue;
        /* 决定性判据：视口中心命中的就是它（说明它在最上层），否则只是留在 DOM 里的残留 */
        let top = null;
        try { top = doc.elementFromPoint(Math.floor(winW / 2), Math.floor(winH / 2)); } catch {}
        const covered = !!top && (top === f || (f.contains && f.contains(top)));
        if (!covered) continue;
        text += ' 空间不足 扩容';
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
    const btn = await until(() => {
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
  function ensurePackDirUnchecked(qa, doc = document) {
    const cb = doc.querySelector('.pack-check input.ant-checkbox-input')
    || doc.querySelector('.share-pack-dir-tips input.ant-checkbox-input');
    if (!cb) return true;
    if (!cb.checked) return true;
    const label = cb.closest('label') || cb;
    try {
      if (qa && typeof qa.realClick === 'function') qa.realClick(label);
      else label.click();
    } catch { try { cb.click(); } catch {} }
    return !cb.checked;
  }
  function findVisibleModal(doc = document) {
    const sels = ['.ant-modal:not(.ant-modal-hidden)', '.save-share-file-modal',
      '[class*="save-share"][class*="modal"]', '[class*="saveShare"][class*="modal"]', '[role="dialog"]'];
    for (const sel of sels) {
      try { for (const el of doc.querySelectorAll(sel)) if (_isVisible(el)) return el; } catch {}
    }
    return null;
  }
  function findSaveDialog(doc = document) {
    const sels = ['.ant-modal:not(.ant-modal-hidden)', '.save-share-file-modal',
      '[class*="save-share"][class*="modal"]', '[class*="saveShare"][class*="modal"]', '[role="dialog"]'];
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
    const ok = await until(() => {
      for (const t of texts) {
        for (const el of scope.querySelectorAll('button')) {
          const txt = (el.textContent || '').trim();
          if (txt === t && _isVisible(el)) { qa.realClick(el); return true; }
        }
      }
      return false;
    }, 100, timeout);
    if (!ok) {
      const btns = [...scope.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean);
      warn('clickConfirmInDialog 未找到确认按钮，scope 内按钮：', btns);
    }
    return !!ok;
  }
  function closeDialog(qa, doc = document) {
    const sels = ['.save-share-file-success-modal .ant-modal-close', '.ant-modal-close',
      '.swal2-close', '[class*="modal-close"]'];
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
    space: [/空间不足/, /容量不足/, /存储空间.*不足/, /剩余空间.*不足/, /空间.*已满/,
      /请先扩容/, /配额.*不足/, /空间.*不够/, /无法保存.*空间/, /保存.*空间不足/],
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
        for (const el of doc.querySelectorAll(sel)) if (_isVisible(el)) text += ' ' + (el.textContent || '');
      }
    } catch {}
    text += ' ' + scanIframeErrors(doc);
    const k = classify(text);
    if (k === 'space' || k === 'over_limit' || k === 'fail') return k;
    return null;
  }
  async function waitResult(qa, doc = document, timeout = 8000) {
    const r = await until(() => {
      let text = '';
      try {
        for (const sel of ['.swal2-popup', '.ant-message-notice', '.ant-notification-notice']) {
          for (const el of doc.querySelectorAll(sel)) if (_isVisible(el)) text += ' ' + (el.textContent || '');
        }
      } catch {}
      text += ' ' + scanIframeErrors(doc);
      const k = classify(text);
      if (k === 'space' || k === 'over_limit' || k === 'fail') return k;
      if (isSuccessModalPresent(doc)) return 'success';
      return null;
    }, 50, timeout);
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
    await until(() => !anyVisible(), 50, timeout);
  }
  async function clickSaveOnce(qa, doc = document) {
    for (let i = 0; i < 4; i++) {
      if (!isSuccessModalPresent(doc)) break;
      try { closeDialog(qa, doc); } catch {}
      const gone = await until(() => !isSuccessModalPresent(doc), 100, 1200);
      if (gone) break;
      const m = doc.querySelector('.save-share-file-success-modal');
      try { m && m.parentNode && m.parentNode.removeChild(m); } catch {}
      await sleep(150, true);
    }
    await waitAllModalsGone(qa, doc, 3000);
    await sleep(150, true);
    log(' → 等保存按钮就绪');
    const ready = await waitSaveButtonReady(qa, doc, 8000);
    if (!ready) { warn(' ⚠️ 保存按钮未就绪'); return 'fail'; }
    log(' → 点击保存按钮');
    try { clickSaveButton(qa, doc); } catch (e) {
      warn(' ⚠️ clickSaveButton 失败：', e);
      return 'fail';
    }
    const outcome = await until(() => {
      const err = detectResultQuick(doc);
      if (err) return { type: 'error', kind: err };
      if (isSuccessModalPresent(doc)) return { type: 'success' };
      const dlg = findSaveDialog(doc);
      if (dlg) return { type: 'dialog' };
      return null;
    }, 100, 12000);
    if (!outcome) { warn(' ⚠️ 12s 内无任何结果信号'); return 'unknown'; }
    if (outcome.type === 'success') {
      /* "保存成功"弹窗可能先于真实结果出现（实测存在"保存成功弹窗 + 容量不足收银台"并存的状态），
       * 所以再观察一小段：若收银台真的盖到页面上，就把这次判定为失败 */
      const late = await until(() => {
        const k = detectResultQuick(doc);
        return k ? k : null;
      }, 150, 1200);
      if (late) {
        warn(` ⚠️ 成功弹窗后又出现失败信号：${late}，按失败处理`);
        try { closeDialog(qa, doc); } catch {}
        return late;
      }
      log(' → 保存成功');
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

  /* ===== 行 checkbox ===== */
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

  /* ===== 表头全选 ===== */
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
      await sleep(80, true);
      if (getHeaderCheckState(doc) === 'none') return { ok: true, tries: i + 1 };
    }
    return { ok: getHeaderCheckState(doc) === 'none', reason: 'not-cleared' };
  }

  /* ===== 改名 ===== */
  const RENAME_CONFIRM_TEXTS = ['确定', '确认', '保存', '完成', '确 定'];
  function isRenamePanel(el) {
    try {
      return !!(el && el.closest && (el.closest('#quark-auto-panel') || el.closest('#quark-share-progress')));
    } catch { return false; }
  }
  function findListRowByName(qa, name, doc = document) {
    const want = getComparableFileName(name);
    if (!want) return null;
    const files = qa.scanFileRows(doc) || [];
    return files.find(f => getComparableFileName(f.name) === want) || null;
  }
  function findRowByExactName(qa, name, doc = document) {
    const want = String(name ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!want) return null;
    const files = qa.scanFileRows(doc) || [];
    return files.find(f => String(f.name ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() === want) || null;
  }
  function getNameElInRow(row) {
    if (!row || typeof row.querySelector !== 'function') return null;
    return row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]') || row;
  }
  function getNameCellOnly(row) {
    if (!row || typeof row.querySelector !== 'function') return null;
    return row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
  }
  function getSelectedFids(doc = document) {
    return [...doc.querySelectorAll('tr.ant-table-row-selected')]
    .map(r => r.getAttribute('data-row-key') || '').filter(Boolean);
  }
  function findRowByFid(fid, doc = document) {
    if (!fid) return null;
    return doc.querySelector(`tr.ant-table-row[data-row-key="${fid}"]`);
  }
  async function resetSelectionToRow(qa, file, doc = document) {
    if (!file || !file.fid) return { ok: false, reason: 'no-fid' };
    for (let attempt = 0; attempt < 3; attempt++) {
      await until(() => !isShareTableLoading(doc), 150, 5000);
      const cleared = await clearAllViaHeader(qa, doc);
      if (!cleared.ok || getHeaderCheckState(doc) !== 'none') {
        try { await qa.clearAllSelection(); } catch {}
        await until(() => getHeaderCheckState(doc) === 'none', 100, 2000);
        if (getHeaderCheckState(doc) !== 'none') {
          if (attempt < 2) { await sleep(500, true); continue; }
          return { ok: false, reason: `clear-incomplete(${getHeaderCheckState(doc)})` };
        }
      }
      let noSel = await until(() => getSelectedFids(doc).length === 0, 100, 1500);
      if (!noSel) {
        /* 表头清不掉时逐行取消残留勾选。残留的上一行就是"改错文件"的另一大来源 */
        for (const r of [...doc.querySelectorAll('tr.ant-table-row-selected')]) {
          try {
            const lbl = r.querySelector('label.ant-checkbox-wrapper');
            if (lbl) qa.realClick(lbl);
            else { const cb = r.querySelector('input.ant-checkbox-input'); if (cb) cb.click(); }
          } catch {}
        }
        noSel = await until(() => getSelectedFids(doc).length === 0, 100, 1500);
      }
      if (!noSel) {
        const n = getSelectedFids(doc).length;
        if (attempt < 2) { await sleep(500, true); continue; }
        return { ok: false, reason: `residual-selection(${n})` };
      }
      let row = (file.row && file.row.isConnected) ? file.row : findRowByFid(file.fid, doc);
      if (!row) {
        try {
          const found = await scrollToRowByName(qa, doc, file.name, { cacheKey: currentCacheKey(), maxMs: 3000 });
          if (found) { row = found.row; file.row = found.row; }
        } catch {}
      }
      if (!row) {
        if (attempt < 2) { await sleep(500, true); continue; }
        return { ok: false, reason: 'row-gone' };
      }
      const isSel = () => {
        const cur = findRowByFid(file.fid, doc) || row;
        const input = cur && cur.querySelector('input.ant-checkbox-input');
        return !!(cur && (cur.classList.contains('ant-table-row-selected') || (input && input.checked)));
      };
      if (!isSel()) {
        const lbl = row.querySelector('label.ant-checkbox-wrapper');
        if (lbl) { try { qa.realClick(lbl); } catch {} }
        else { try { const cb = row.querySelector('input.ant-checkbox-input'); if (cb) cb.click(); } catch {} }
        await until(isSel, 100, 2000);
      }
      await until(() => getSelectedFids(doc).length > 0, 100, 1000);
      const state = getHeaderCheckState(doc);
      const fids = getSelectedFids(doc);
      if (fids.length !== 1 || fids[0] !== file.fid) {
        if (attempt < 2) { await sleep(500, true); continue; }
        return { ok: false, reason: `${state}/${fids.length}` };
      }
      if (state === 'all') {
        const rows = qa.scanFileRows(doc) || [];
        const body = getTableBody(doc);
        const virtual = body && isVirtualScrolling(body);
        if (virtual || rows.length !== 1) {
          if (attempt < 2) { await sleep(500, true); continue; }
          return { ok: false, reason: `head-all-not-single(${rows.length}${virtual ? ',virtual' : ''})` };
        }
      }
      return { ok: true };
    }
    return { ok: false, reason: 'max-attempts' };
  }
  function findToolbarRenameButton(doc = document) {
    const els = [...doc.querySelectorAll(
      '.btn-group button, .btn-group [role="button"], .btn-group span, .btn-group a, .section-header button.btn-file'
    )];
    for (const el of els) {
      if (el.closest && el.closest('.btn-main')) continue;
      if (isRenamePanel(el)) continue;
      const txt = (el.textContent || '').replace(/\s+/g, '').trim();
      if (!/^(重命名|重新命名|改名)$/.test(txt)) continue;
      const clickable = (el.closest && el.closest('button, [role="button"], a')) || el;
      if (clickable.closest && clickable.closest('.btn-main')) continue;
      return clickable;
    }
    return null;
  }
  function findNewRenameModal(beforeSet, originalName, doc = document) {
    const want = getComparableFileName(originalName);
    const modals = [...doc.querySelectorAll('.ant-modal, [role="dialog"], .ant-drawer-content')];
    for (const m of modals) {
      if (beforeSet.has(m) || !_isVisible(m)) continue;
      const inputs = [...m.querySelectorAll('input')].filter(i => i.isConnected && _isVisible(i) && !isRenamePanel(i));
      if (!inputs.length) continue;
      const valMatch = inputs.some(i => {
        const v = String(i.value ?? '');
        return !!v && (v === originalName || getComparableFileName(v) === want);
      });
      if (valMatch) return m;
      const txt = (m.textContent || '').replace(/\s+/g, '');
      if (/重命名|重新命名|修改名称/.test(txt)) return m;
    }
    return null;
  }
  async function dismissStrayModals(qa, beforeSet, doc = document) {
    try {
      const stray = [...doc.querySelectorAll('.ant-modal, [role="dialog"], .ant-drawer-content, .ant-dropdown')]
      .filter(el => !beforeSet.has(el) && _isVisible(el));
      for (const el of stray) {
        const close = el.querySelector('.ant-modal-close, .ant-drawer-close');
        if (close) { try { qa.realClick(close); } catch {} }
      }
      if (stray.length) {
        await until(() => !stray.some(el => _isVisible(el)), 150, 2000);
        if (stray.some(el => _isVisible(el))) { try { pressKeyOn(doc.body, 'Escape'); } catch {} }
        await sleep(150, true);
      }
    } catch {}
  }
  /* 关闭残留的行内改名框 / 弹窗。
   * 上一轮改名若没提交干净，残留的编辑框会让本轮打开的是"上一个文件"的编辑器
   * —— 这正是"把上一个改名条目当成这一个"的根因之一。 */
  async function closeStrayRenameEditors(qa, doc = document) {
    let closedAny = false;
    try {
      const inline = [...doc.querySelectorAll('input.input-edit, input.ant-input.input-edit, .filename input.ant-input')]
      .filter(i => !isRenamePanel(i) && i.isConnected && _isVisible(i));
      for (const i of inline) {
        try { pressKeyOn(i, 'Escape'); } catch {}
        try { i.blur(); } catch {}
      }
      if (inline.length) {
        closedAny = true;
        await until(() => !inline.some(i => i.isConnected && _isVisible(i)), 120, 1500);
        log(` 🧹 清理了 ${inline.length} 个残留的行内改名框`);
      }
    } catch {}
    try {
      const stray = [...doc.querySelectorAll('.ant-modal, [role="dialog"], .ant-drawer-content')]
      .filter(el => !isRenamePanel(el) && el.isConnected && _isVisible(el));
      for (const el of stray) {
        const close = el.querySelector('.ant-modal-close, .ant-drawer-close');
        if (close) { try { qa.realClick(close); } catch {} }
      }
      if (stray.length) {
        closedAny = true;
        await until(() => !stray.some(el => el.isConnected && _isVisible(el)), 150, 2000);
        if (stray.some(el => el.isConnected && _isVisible(el))) { try { pressKeyOn(doc.body, 'Escape'); } catch {} }
        await sleep(150, true);
        log(` 🧹 清理了 ${stray.length} 个残留弹窗`);
      }
    } catch {}
    return closedAny;
  }

  /* 改名弹窗里的值可能不带扩展名（或空格/大小写有差异），这里做宽松比对。
   * 只剥离"已知扩展名"，避免把 "Show.S02E05" 这类带点的名字误砍掉一段 */
  const KNOWN_EXT_RE = /\.(mp4|mkv|avi|mov|flv|wmv|webm|m4v|m2ts|ts|rmvb|rm|mpg|mpeg|ogm|strm|iso|ass|ssa|srt|sub|idx|zip|rar|7z|tar|gz|pdf|txt)$/i;
  function stripKnownExt(s) {
    let v = String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    const m = v.match(KNOWN_EXT_RE);
    if (m) v = v.slice(0, v.length - m[0].length);
    return getComparableFileName(v.trim());
  }
  function sameNameIgnoreExt(a, b) {
    const x = stripKnownExt(a), y = stripKnownExt(b);
    return !!x && x === y;
  }

  /* 改名提交失败时，把弹窗里的报错文字抓出来（重名 / 非法字符 / 超长…） */
  function readRenameErrorText(scope, doc = document) {
    const seen = [];
    const push = t => {
      const s = String(t ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
      if (s && s.length <= 60 && !seen.includes(s)) seen.push(s);
    };
    const roots = [];
    try { if (scope && scope.isConnected) roots.push(scope); } catch {}
    try { if (doc && doc.body) roots.push(doc.body); } catch {}
    const sels = [
      '.ant-form-item-explain-error', '.ant-message-error', '.ant-message-notice-content',
      '.ant-alert-error', '.ant-typography-danger', '.error-msg', '.ant-modal-body',
    ];
    const keys = ['已存在', '重名', '重复', '不能为空', '不能超过', '非法', '不支持', '失败', '错误', '无效'];
    for (const root of roots) {
      for (const sel of sels) {
        let els = [];
        try { els = [...root.querySelectorAll(sel)]; } catch { continue; }
        for (const el of els) {
          try {
            if (!_isVisible(el)) continue;
            if (el.closest && el.closest('#quark-auto-panel, #quark-share-progress')) continue;
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (keys.some(k => t.includes(k))) push(t);
          } catch {}
        }
      }
    }
    return seen.length ? seen[0] : '';
  }

  async function openRenameViaToolbar(qa, file, originalName, doc = document) {
    if (!file || !file.fid) return null;
    const sel = await resetSelectionToRow(qa, file, doc);
    if (!sel.ok) {
      warn(` ⚠️ 改名：单选复核未通过（${sel.reason}）→ 不点顶栏「重命名」`);
      return null;
    }
    const btn = findToolbarRenameButton(doc);
    if (!btn) { log('   ↳ 顶栏没有「重命名」按钮'); return null; }
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('ant-btn-disabled')) {
      warn(' ⚠️ 改名：顶栏「重命名」按钮禁用，跳过');
      return null;
    }
    const STRAY_SEL = '.ant-modal, [role="dialog"], .ant-drawer-content, .ant-dropdown';
    const before = new Set([...doc.querySelectorAll(STRAY_SEL)]);
    log(` → 改名：点击顶栏「重命名」（已确认仅勾选 1 行）`);
    try { qa.realClick(btn); } catch (e) { warn(' ⚠️ 改名：点击异常', e); return null; }
    const t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      const inline = findInlineRenameInput(originalName, doc);
      if (inline) { log(' ✓ 顶栏「重命名」进入行内编辑'); return inline; }
      const dlg = findNewRenameModal(before, originalName, doc);
      if (dlg) return dlg;
      await sleep(150, true);
    }
    warn(' ⚠️ 改名：点了顶栏「重命名」但没等到弹窗/编辑框');
    await dismissStrayModals(qa, before, doc);
    return null;
  }
  /* fid 是唯一权威：按名字重新找行可能命中"上一个改名条目"（同名/排序变化） */
  async function openRenameDialog(qa, row, nameCell, originalName, doc = document, fid = '') {
    let rowFid = String(fid || '').trim();
    if (rowFid) {
      const byFid = findRowByFid(rowFid, doc);
      if (byFid && byFid.isConnected) {
        if (row !== byFid) log(`   ↳ 改名：按 fid 定位行（${rowFid}）`);
        row = byFid;
        nameCell = getNameElInRow(row);
      }
    }
    if (!row || !row.isConnected) {
      const fresh = findListRowByName(qa, originalName, doc);
      row = fresh && fresh.row;
      if (!nameCell || !nameCell.isConnected) nameCell = getNameElInRow(row);
    }
    if (!row || !row.isConnected) { warn(` ⚠️ 改名：找不到该行 —— ${originalName}`); return null; }
    if (!rowFid && row.getAttribute) rowFid = String(row.getAttribute('data-row-key') || '');

    let file = rowFid ? { fid: rowFid, row, name: originalName } : null;
    if (!file || !file.fid) file = findListRowByName(qa, originalName, doc);
    if (!file || !file.fid) {
      warn(` ⚠️ 改名：找不到带 fid 的行 —— ${originalName}`);
      return null;
    }

    /* 防错行：fid 行的真实名与计划名不一致时，以 fid 行的真实名为准并告警
     * （绝不反过来按名字去匹配别的行，那正是"用成上一个条目"的来源） */
    if (rowFid) {
      const rowName = readRowRealName(rowFid, doc);
      if (rowName && getComparableFileName(rowName) !== getComparableFileName(originalName)) {
        warn(` ⚠️ 改名：fid ${rowFid} 的行名是「${rowName}」，与计划名「${originalName}」不一致 —— 以行内真实名为准`);
        file = { fid: rowFid, row, name: rowName };
        originalName = rowName;
      }
    }
    return await openRenameViaToolbar(qa, file, file.name || originalName, doc);
  }
  function findInlineRenameInput(originalName = '', doc = document) {
    const want = getComparableFileName(originalName);
    const inputs = [...doc.querySelectorAll('input.input-edit, input.ant-input.input-edit, .filename input.ant-input')]
    .filter(i => !isRenamePanel(i) && i.isConnected && _isVisible(i));
    if (!inputs.length) return null;
    if (!originalName) return inputs[0];
    const exact = inputs.find(i => String(i.value ?? '') === originalName);
    if (exact) return exact;
    return inputs.find(i => getComparableFileName(i.value) === want)
        || inputs.find(i => sameNameIgnoreExt(i.value, originalName)) || null;
  }
  function isEditorOpen(input) {
    return !!(input && input.isConnected && _isVisible(input));
  }
  function pressKeyOn(el, key) {
    const win = (el && el.ownerDocument ? el.ownerDocument.defaultView : window) || window;
    const code = { Enter: 13, Escape: 27, F2: 113 }[key] || 0;
    const base = { key, code: key, bubbles: true, cancelable: true, view: win };
    const fire = type => {
      let ev = null;
      try { ev = new win.KeyboardEvent(type, base); } catch { return; }
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => code });
        Object.defineProperty(ev, 'which', { get: () => code });
      } catch {}
      try { el.dispatchEvent(ev); } catch {}
    };
    fire('keydown'); fire('keypress'); fire('keyup');
  }
  function readRowRealName(fid, doc = document) {
    if (!fid) return '';
    const row = findRowByFid(fid, doc);
    if (!row) return '';
    const cell = row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]') || row;
    return String((cell.getAttribute && cell.getAttribute('title')) || cell.textContent || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }
  function normExactName(s) {
    return String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }

  /* 查找完整名。返回 {found, hit, timedOut}：
   *   found=true      → 命中
   *   found=false timedOut=false → 完整扫描确认不存在
   *   found=false timedOut=true  → 扫描未完成，不能判定"不存在" */
  async function findExactNameAnywhere(qa, name, doc = document, maxMs = 4000) {
    const want = normExactName(name);
    if (!want) return { found: false, hit: null, timedOut: false };
    const visible = (qa.scanFileRows(doc) || []).find(f => normExactName(f.name) === want);
    if (visible) return { found: true, hit: visible, timedOut: false };

    const expected = getShareFileCount(doc);
    try {
      const all = await scanAllRowsByScroll(qa, doc, { key: currentCacheKey(), useCache: false, maxMs }) || [];
      const hit = all.find(f => normExactName(f.name) === want);
      if (hit) return { found: true, hit, timedOut: false };
      /* 全表扫描结果长度 < expected → 扫描不完整，不能下结论 */
      if (expected && all.length < expected) {
        return { found: false, hit: null, timedOut: true };
      }
      return { found: false, hit: null, timedOut: false };
    } catch {
      return { found: false, hit: null, timedOut: true };
    }
  }

  /* 确认改名生效。返回 {ok, method, reason}：
   *   ok=true   → 可见区稳定或全表确认到新名
   *   ok=false  → 明确失败（旧名仍在 / 超时未能确认）
   *   reason    → 'visible-stable' | 'full-scan-stable' | 'timeout-hit'
   *             | 'old-still-exists' | 'scan-incomplete' | 'not-found' */
  async function confirmRenamedInList(qa, opts = {}) {
    const doc = opts.doc || document;
    const fid = opts.fid || '';
    const oldName = normExactName(opts.oldName);
    const newName = normExactName(opts.newName);
    const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 45000;
    const stableMs = 2000;
    const deadline = Date.now() + budgetMs;
    let stableSince = 0;
    let lastFull = 0;
    let lastFullResult = { found: false, hit: null, timedOut: true };
    let lastLog = 0;
    let scrolled = false;
    let scanIncompleteObserved = false;

    const visibleExact = () => {
      const hit = (qa.scanFileRows(doc) || []).find(f => normExactName(f.name) === newName);
      if (!hit) return false;
      if (fid && hit.fid && hit.fid !== fid) return false;
      return true;
    };

    while (Date.now() < deadline) {
      let seen = visibleExact();
      if (!seen && Date.now() - lastFull > 3000) {
        lastFull = Date.now();
        const r = await findExactNameAnywhere(qa, newName, doc, 4000);
        lastFullResult = r;
        if (r.timedOut) scanIncompleteObserved = true;
        seen = !!(r.found && r.hit && (!fid || !r.hit.fid || r.hit.fid === fid));
      }
      if (seen) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) {
          log(` ✓ 改名：按完整名确认到「${newName}」`);
          return { ok: true, method: lastFullResult.found ? 'full-scan-stable' : 'visible-stable' };
        }
      } else {
        stableSince = 0;
      }
      if (!scrolled && Date.now() > deadline - (budgetMs - 5000)) {
        scrolled = true;
        try { await scrollToRowByName(qa, doc, newName, { cacheKey: currentCacheKey(), maxMs: 4000 }); } catch {}
      }
      if (Date.now() - lastLog > 8000) {
        lastLog = Date.now();
        const live = fid ? readRowRealName(fid, doc) : '';
        log(`   …仍在等待改名生效（该行当前名：${live ? live.slice(0, 60) : '不在可见区'}）`);
      }
      await sleep(300, true);
    }

    /* 超时：最后再做一次完整判断 */
    const finalR = await findExactNameAnywhere(qa, newName, doc, 5000);
    if (finalR.found && (!fid || !finalR.hit.fid || finalR.hit.fid === fid)) {
      log(` ✓ 改名：超时前一刻按完整名确认到「${newName}」`);
      return { ok: true, method: 'timeout-hit' };
    }
    if (finalR.timedOut || scanIncompleteObserved) {
      /* 扫描不完整 → 不能判定失败，但也不能当作成功 */
      warn(` ⚠️ 改名：确认期间扫描不完整，无法判定「${newName}」是否已生效`);
      return { ok: false, reason: 'scan-incomplete' };
    }
    if (oldName) {
      const oldR = await findExactNameAnywhere(qa, oldName, doc, 5000);
      if (oldR.found) return { ok: false, reason: 'old-still-exists' };
      if (oldR.timedOut) return { ok: false, reason: 'scan-incomplete' };
    }
    return { ok: false, reason: 'not-found' };
  }

  async function applyRenameViaInlineEditor(qa, input, oldName, newName, doc = document, fid = '') {
    if (!input || !input.isConnected) return 'fail';
    try { input.focus(); } catch {}
    try { input.select(); } catch {}
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) { try { setter.call(input, newName); } catch {} }
    if (input.value !== newName) input.value = newName;
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    if (input.value !== newName) {
      warn(` ⚠️ 改名：行内输入框未接受新名（当前="${input.value}"）`);
      return 'fail';
    }
    const editorClosed = () => !isEditorOpen(input);
    let closed = false;
    pressKeyOn(input, 'Enter');
    closed = await until(() => editorClosed(), 150, 3000);
    if (!closed) { try { input.blur(); } catch {} closed = await until(() => editorClosed(), 150, 3000); }
    if (!closed) {
      const cell = input.closest('.filename, .file-click-wrap, td') || doc;
      const okBtn = [...cell.querySelectorAll('button, .anticon-check, [class*="confirm"], [class*="sure"], [class*="save"]')]
      .find(b => _isVisible(b) && !isRenamePanel(b));
      if (okBtn) {
        log(' → 改名：点击行内编辑的确认按钮');
        try { qa.realClick(okBtn); } catch {}
        closed = await until(() => editorClosed(), 150, 3000);
      }
    }
    if (!closed) {
      const errText = readRenameErrorText(input.closest('.filename, .file-click-wrap, td') || doc.body, doc);
      pressKeyOn(input, 'Escape');
      await until(() => editorClosed(), 120, 1500);
      warn(` ⚠️ 改名：行内编辑未提交${errText ? `，提示「${errText}」` : ''}，已按 Esc 放弃`);
      return errText ? `submit-failed(${errText})` : 'submit-failed';
    }
    log(' ⏳ 改名：已提交，等待列表确认新名…');
    return 'submitted';
  }

  function findRenameModal(originalName, doc = document) {
    const want = getComparableFileName(originalName);
    const modals = doc.querySelectorAll('.ant-modal, [role="dialog"], .ant-drawer-content, .base-confirm-modal .ant-modal');
    for (const m of modals) {
      if (!_isVisible(m)) continue;
      const inputs = [...m.querySelectorAll('input[type="text"], input:not([type]), input.ant-input')]
      .filter(i => !isRenamePanel(i) && i.isConnected && _isVisible(i));
      if (!inputs.length) continue;
      for (const i of inputs) {
        const v = String(i.value ?? '');
        if (v && (v === originalName || getComparableFileName(v) === want)) return m;
      }
    }
    return null;
  }

  async function applyRenameInDialog(qa, scope, originalName, newName, doc = document, fid = '') {
    if (!scope || !scope.isConnected) { warn(' ⚠️ 改名：改名编辑器已消失'); return false; }
    const inpSel = 'input.input-edit, input[type="text"], input:not([type]), input.ant-input';
    const collect = () => (typeof scope.querySelectorAll === 'function' && !(scope.tagName === 'INPUT'))
      ? [...scope.querySelectorAll(inpSel)].filter(i => !isRenamePanel(i))
      : [scope];
    const want = getComparableFileName(originalName);
    /* 必须找到"值为待改名文件当前名"的输入框才允许提交。
     * 以前兜底用 inputs[0]，一旦弹窗里是上一个文件／预填值不同，就会把别的文件改掉。
     * 弹窗刚打开时值可能还没渲染，所以这里要等一等再判定。 */
    let input = null;
    let matches = [];
    let vals = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      const ins = collect();
      matches = ins.filter(i => {
        const v = String(i.value ?? '');
        return v && (v === originalName || getComparableFileName(v) === want || sameNameIgnoreExt(v, originalName));
      });
      if (matches.length) break;
      vals = ins.map(i => String(i.value ?? ''));
      await sleep(150, true);
    }
    if (!matches.length) {
      warn(` ⚠️ 改名：改名框里的名字不是「${originalName}」—— 拒绝提交，避免改错文件。`
           + (vals.filter(Boolean).length ? `（框内实际为：${vals.filter(Boolean).join(' | ')}）` : '（框内为空）'));
      return 'wrong-row';
    }
    if (matches.length > 1) log(`   ↳ 改名框内有 ${matches.length} 个同名输入框，取第一个`);
    input = matches[0];
    const setInputValue = v => {
      try { input.focus(); } catch {}
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) { try { setter.call(input, v); } catch {} }
      if (input.value !== v) input.value = v;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    };
    if (input.classList.contains('input-edit')) {
      return await applyRenameViaInlineEditor(qa, input, originalName, newName, doc, fid);
    }
    setInputValue(newName);
    if (input.value !== newName) {
      warn(` ⚠️ 改名：输入框未接受新名（当前="${input.value}"）`);
      return false;
    }
    const btn = await until(() => {
      for (const t of RENAME_CONFIRM_TEXTS) {
        for (const el of scope.querySelectorAll('.ant-modal-footer button, .ant-drawer-footer button, button')) {
          if (!_isVisible(el) || isRenamePanel(el)) continue;
          if (el.disabled || el.classList.contains('ant-btn-loading')) continue;
          if ((el.textContent || '').replace(/\s+/g, '') === t) return el;
        }
      }
      return null;
    }, 100, 2500);
    if (!btn) {
      const btns = [...scope.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean);
      warn(' ⚠️ 改名：未找到确认按钮，弹窗内按钮：', btns);
      return false;
    }
    qa.realClick(btn);
    const modalEl = (scope && scope.tagName !== 'INPUT' && scope.isConnected) ? scope : null;
    const closed = await until(
      () => (modalEl ? (!modalEl.isConnected || !_isVisible(modalEl)) : !findRenameModal(originalName, doc)),
      150, 6000
    );
    if (!closed) {
      /* 弹窗不关通常是服务端拒绝：重名 / 非法字符 / 超长。把报错文字带出去 */
      const errText = readRenameErrorText(modalEl || scope, doc);
      const dup = await findExactNameAnywhere(qa, newName, doc, 4000);
      const dupFid = dup.found && dup.hit ? dup.hit.fid : '';
      const looksDup = !!dupFid && (!fid || dupFid !== fid);
      warn(` ⚠️ 改名：确认后弹窗未关闭${errText ? `，提示「${errText}」` : ''}`
           + `${looksDup ? `；目标名已被占用（fid ${dupFid}）` : ''}`);
      try { pressKeyOn(doc.body, 'Escape'); } catch {}
      await sleep(200, true);
      if (looksDup) return `target-name-exists${errText ? `(${errText})` : ''}`;
      return errText ? `submit-failed(${errText})` : 'submit-failed';
    }
    log(' ⏳ 改名：弹窗已提交，等待列表确认新名…');
    return 'submitted';
  }

  async function waitRowsForRename(qa, plan, timeout = 8000, doc = document) {
    const tokens = [];
    for (const e of plan) {
      const base = normalizeFileName(e.old);
      const tail = (base.split(/[\s_]+/).filter(Boolean).pop() || base).slice(0, 24);
      if (tail) tokens.push({ tail, name: base });
    }
    if (!tokens.length) return true;
    const hitAll = () => {
      const rows = qa.scanFileRows(doc) || [];
      const names = rows.map(r => normalizeFileName(r.name));
      return tokens.every(t => names.some(n => n === t.name || n.endsWith(t.tail)));
    };
    const got = await until(hitAll, 200, timeout);
    if (got) { log(' ✓ 刷新后列表已出现本次转存文件，开始改名'); return true; }
    warn(` ⚠️ 改名：${timeout}ms 内列表未出现全部目标文件`);
    return false;
  }

  /* 返回值统一为 {ok, confirmed, method?, reason?}：
   *   ok=true  → 新名确认
   *   ok=false → 明确失败（改名没成功 / 扫描不完整无法确认 / 旧名仍在） */
  async function renameOneRow(qa, m, doc = document) {
    const row = (m.row && m.row.isConnected) ? m.row : ((findListRowByName(qa, m.old, doc) || {}).row || null);
    const editor = await openRenameDialog(qa, row, m.nameEl || getNameElInRow(row), m.old, doc, m.fid || '');
    if (!editor) { warn(` ⚠️ 改名：打不开改名编辑器 —— ${m.old}`); return { ok: false, reason: 'no-editor' }; }
    const r = await applyRenameInDialog(qa, editor, m.old, m.next, doc, m.fid || '');
    if (r !== 'submitted' && r !== true) {
      try {
        const close = editor.querySelector && editor.querySelector('.ant-modal-close, .ant-drawer-close');
        if (close) qa.realClick(close);
        else if (editor.blur) editor.blur();
      } catch {}
      /* 只有 'fail' / false 属于提交类失败；其余是带原因的明确失败 */
      const reason = (typeof r === 'string' && r && r !== 'fail') ? r : 'submit-failed';
      return { ok: false, reason };
    }

    const verdict = await confirmRenamedInList(qa, {
      fid: m.fid || '', oldName: m.old, newName: m.next, doc, budgetMs: 45000,
    });

    if (verdict.ok) {
      log(' ✓ 改名：列表已确认新名');
      await until(() => !isShareTableLoading(doc), 150, 5000);
      await sleep(300, true);
      return { ok: true, confirmed: true, method: verdict.method };
    }

    /* 超时时如果旧名确实不存在（且扫描完整），可以视作成功 */
    if (verdict.reason === 'not-found' || verdict.reason === 'old-still-exists') {
      const oldR = await findExactNameAnywhere(qa, m.old, doc, 3000);
      if (!oldR.found && !oldR.timedOut) {
        log(` ✓ 改名：旧名已不在列表，视为改名成功 —— ${m.old} → ${m.next}`);
        await until(() => !isShareTableLoading(doc), 150, 5000);
        await sleep(300, true);
        return { ok: true, confirmed: true, method: 'old-name-gone' };
      }
      if (oldR.timedOut) {
        warn(` ⚠️ 改名：旧名扫描不完整，无法确认 —— ${m.old}`);
        return { ok: false, reason: 'scan-incomplete' };
      }
      warn(` ⚠️ 改名：失败 —— ${m.old}（${verdict.reason}）`);
      return { ok: false, reason: verdict.reason };
    }

    warn(` ⚠️ 改名：超时且无法确认（${verdict.reason || 'unknown'}）—— ${m.old} → ${m.next}`);
    return { ok: false, reason: verdict.reason || 'unknown' };
  }

  /* 返回 {renamed, failed, skipped, confirmed, failedEntries, pairs}；失败会重试一次 */
  async function applyListRenames(qa, plan, opts = {}) {
    const doc = opts.doc || document;
    const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 8000;
    const entries = Array.isArray(plan) ? plan.filter(x => x && x.old && x.next) : [];
    if (!entries.length) return { renamed: 0, failed: 0, skipped: 0, confirmed: [], failedEntries: [], pairs: [] };

    log(`★ 改名：待改名 ${entries.length} 个`);
    for (const e of entries) log(` - ${e.old}  →  ${e.next}`);

    /* 计划里若有重复目标名，必然只有第一个能成功，剩下的会撞重名 —— 提前点名 */
    const nameCount = new Map();
    for (const e of entries) {
      const k = normExactName(e.next);
      nameCount.set(k, (nameCount.get(k) || 0) + 1);
    }
    const dupPlanned = [...nameCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    if (dupPlanned.length) {
      warn(` ⚠️ 改名：计划里有 ${dupPlanned.length} 个目标名重复（同名的只能成功一个）：${dupPlanned.join('、')}`);
    }

    let renamed = 0, failed = 0, skipped = 0;
    const confirmed = [];
    const takenNames = new Set();   /* 本次已占用的目标名，用于零开销判重 */

    const doOne = async (e, label) => {
      await until(() => !isShareTableLoading(doc), 150, 10000);
      await sleep(300, true);
      try {
        await clearAllViaHeader(qa, doc);
        await until(() => getHeaderCheckState(doc) === 'none', 100, 2000);
      } catch {}
      /* 上一轮若留下没提交干净的改名框／弹窗，本轮会打开"上一个文件"的编辑器 */
      try { await closeStrayRenameEditors(qa, doc); } catch {}

      let loaded = null;
      if (e.fid) {
        const row = findRowByFid(e.fid, doc);
        if (row) {
          const nc = row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
          const curName = nc
            ? String(nc.getAttribute('title') || nc.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
            : '';
          loaded = { row, fid: e.fid, name: curName || e.old };
        }
      }
      if (!loaded) loaded = findListRowByName(qa, e.old, doc);
      if (!loaded) loaded = await until(() => findListRowByName(qa, e.old, doc), 200, waitMs);
      if (!loaded) loaded = await scrollToRowByName(qa, doc, e.old, { cacheKey: currentCacheKey(), maxMs: 6000 });

      /* ① 已经是目标名（可能上一趟改成功了只是没确认到）→ 直接算成功 */
      let curReal = '';
      try {
        const nc = loaded && loaded.row && loaded.row.querySelector
          && loaded.row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
        curReal = nc ? String(nc.getAttribute('title') || nc.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : '';
      } catch {}
      if (curReal && normExactName(curReal) === normExactName(e.next)) {
        log(` ↺ 改名：${label} 已是目标名，跳过`);
        return { ok: true, missing: false, alreadyDone: true, reason: 'already-target',
                 confirmedEntry: { old: e.old, next: e.next, fid: e.fid || (loaded && loaded.fid) || '' } };
      }
      if (!loaded) {
        /* 可见区找不到：全表滚动再找一次目标名，避免"其实改好了但不在可见区"被判失败 */
        let alreadyNew = { found: false, hit: null };
        try { alreadyNew = await findExactNameAnywhere(qa, e.next, doc, 5000); } catch {}
        if (alreadyNew.found && alreadyNew.hit) {
          log(` ↺ 改名：${label} 全表已是目标名，跳过 —— ${e.next}`);
          return { ok: true, missing: false, alreadyDone: true, reason: 'already-target-scan',
                   confirmedEntry: { old: e.old, next: e.next, fid: alreadyNew.hit.fid || e.fid || '' } };
        }
        warn(` ⚠️ 改名：${label} 列表里找不到该文件 —— ${e.old}`);
        return { ok: false, missing: true, reason: 'missing' };
      }

      /* ② 该行仍在转存/处理中时改名不会生效，先等它结束 */
      try {
        if (rowLooksBusy(loaded.row)) {
          log(` ⏳ 改名：${label} 该行仍在转存/处理中，等待结束…`);
          await until(() => !rowLooksBusy(loaded.row), 400, 20000);
          await sleep(300, true);
        }
      } catch {}

      const fid = e.fid || loaded.fid || (loaded.row && loaded.row.getAttribute && loaded.row.getAttribute('data-row-key')) || '';
      let realName = '';
      try {
        if (fid) realName = readRowRealName(fid, doc);
        if (!realName) {
          const nc = loaded.row && loaded.row.querySelector && loaded.row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
          realName = nc ? String(nc.getAttribute('title') || nc.textContent || '').replace(/\s+/g, ' ').trim() : '';
        }
      } catch {}
      const oldName = realName || e.old;
      if (oldName !== e.old) log(`   ↳ 列表真实名：${oldName}（计划名 ${e.old}）`);

      /* 提交前查目标名是否已被占用 —— 重名会让弹窗卡住并报 submit-failed */
      if (takenNames.has(normExactName(e.next))) {
        warn(` ✗ 改名 ${label}：目标名与本次已改好的另一个文件重复 → ${e.next}`);
        return { ok: false, missing: false, reason: 'target-name-exists(与本次另一个条目重名)' };
      }
      try {
        const dup = await findExactNameAnywhere(qa, e.next, doc, 4000);
        if (dup.found && dup.hit && !dup.timedOut) {
          const dupFid = dup.hit.fid || '';
          if (!dupFid || !fid || dupFid !== fid) {
            warn(` ✗ 改名 ${label}：目标名已被列表中另一个文件占用 → ${e.next}`
                 + (dupFid ? `（占用者 fid ${dupFid}）` : ''));
            return { ok: false, missing: false, reason: 'target-name-exists' };
          }
        }
      } catch {}

      const r = await renameOneRow(qa, { row: loaded.row, nameEl: getNameElInRow(loaded.row), old: oldName, next: e.next, fid }, doc);
      if (r.ok) {
        const row = findRowByExactName(qa, e.next, doc);
        confirmed.push({ old: oldName, next: e.next, fid: row ? row.fid : fid });
        log(` ✓ 改名 ${label} ${oldName} → ${e.next}（${r.method}）`);
      } else {
        warn(` ✗ 改名失败 ${label} ${oldName}（${r.reason}）`);
      }

      try {
        await clearAllViaHeader(qa, doc);
        await until(() => getHeaderCheckState(doc) === 'none', 100, 2000);
      } catch {}
      await sleep(250, true);
      return { ok: !!r.ok, missing: false, reason: r.ok ? 'renamed' : (r.reason || 'unknown') };
    };

    /* 第一趟 + 最多 2 趟补做：每趟之前等列表稳定并重建行缓存 */
    let queue = entries.map(e => ({ ...e }));
    for (let round = 0; round < 3 && queue.length; round++) {
      if (round > 0) {
        log(`★ 改名：第 ${round} 趟补做 ${queue.length} 个（等待列表稳定并重建行缓存）`);
        await sleep(round === 1 ? 2500 : 5000, true);
        await until(() => !isShareTableLoading(doc), 150, 10000);
        try { await scanAllRowsByScroll(qa, doc, { key: currentCacheKey(), useCache: false }); } catch {}
        await sleep(500, true);
      }
      const nextQueue = [];
      for (let i = 0; i < queue.length; i++) {
        const e = queue[i];
        const res = await doOne(e, round === 0 ? `[${i + 1}/${queue.length}]` : `[补做${round} ${i + 1}/${queue.length}]`);
        if (res.ok) {
          renamed++;
          takenNames.add(normExactName(e.next));
          if (res.confirmedEntry) confirmed.push(res.confirmedEntry);
        }
        else nextQueue.push({ ...e, reason: res.reason || 'unknown' });
      }
      queue = nextQueue;
    }

    /* 收尾复核：补做仍失败的，再全表确认一次新名是否已经生效
     * （改名常常其实成功了，只是当时列表扫描不完整没能确认） */
    if (queue.length) {
      log(`★ 改名：${queue.length} 个未成功，做最后一次全表复核`);
      await sleep(1500, true);
      await until(() => !isShareTableLoading(doc), 150, 10000);
      const still = [];
      for (const e of queue) {
        let r = { found: false, hit: null, timedOut: true };
        try { r = await findExactNameAnywhere(qa, e.next, doc, 6000); } catch {}
        if (r.found && r.hit) {
          renamed++;
          confirmed.push({ old: e.old, next: e.next, fid: r.hit.fid || e.fid || '' });
          log(` ✓ 改名：复核确认「${e.next}」已生效（此前未确认到）`);
          continue;
        }
        still.push({ ...e, reason: (r.timedOut && e.reason === 'scan-incomplete') ? 'scan-incomplete' : (e.reason || 'not-found') });
      }
      queue = still;
    }

    const failedEntries = queue;
    failed = failedEntries.filter(e => e.reason !== 'missing').length;
    skipped = failedEntries.filter(e => e.reason === 'missing').length;
    if (failedEntries.length) {
      warn(` ⚠️ 改名：${failedEntries.length} 个文件最终未确认改名成功：`
           + failedEntries.map(e => `${e.old}（${renameReasonText(e.reason)}）`).join('、'));
    }
    try { qa.refreshGray(); } catch {}
    log(`★ 改名完成：成功 ${renamed}，失败 ${failed}，跳过 ${skipped}`);
    return { renamed, failed, skipped, confirmed, failedEntries, pairs: [] };
  }

  /* 改名失败原因 → 人话（用于弹窗与日志） */
  function renameReasonText(reason) {
    const r = String(reason || '').trim();
    const i = r.indexOf('(');
    const base = i > 0 ? r.slice(0, i) : r;
    const extra = i > 0 ? r.slice(i).replace(/[()]/g, '') : '';
    const tail = extra ? `：${extra}` : '';
    switch (base) {
      case 'missing': return '列表里找不到该行' + tail;
      case 'no-editor': return '打不开改名编辑器（单选未通过/顶栏按钮不可用）' + tail;
      case 'submit-failed': return '改名提交未成功（服务端拒绝：重名/非法字符/超长）' + tail;
      case 'wrong-row': return '改名框里的名字不是该文件 —— 已拒绝提交，避免改错行';
      case 'target-name-exists': return '目标名已被列表中另一个文件占用（重名）' + tail;
      case 'residual-selection': return '上一次的勾选没清干净，单选复核未通过';
      case 'scan-incomplete': return '扫描不完整，无法确认' + tail;
      case 'old-still-exists': return '旧名仍在，改名未生效' + tail;
      case 'not-found': return '新名始终未出现' + tail;
      case 'row-busy': return '该行仍在转存/处理中';
      default: return r ? `原因：${r}` : '未知原因';
    }
  }
  /* 行是否还在转存/处理中（此时改名不会生效） */
  function rowLooksBusy(row) {
    if (!row || typeof row.textContent !== 'string') return false;
    return /转存中|上传中|保存中|正在转存|处理中|离线下载中|等待中/.test(row.textContent);
  }

  async function runRenameSmokeTest(qa, doc = document) {
    const files = (qa.scanFileRows(doc) || []).filter(f => f.fid && f.row && !isFolderFile(f));
    if (!files.length) { alert('当前可见区没有可改名的文件行'); return; }
    const f = files[0];
    const base = normalizeFileName(f.name);
    const next = buildRenamedFileName('测试改名', base);
    if (!next) { alert('难以构造测试文件名'); return; }
    log('=== 改名自检 ===');
    const rep = await applyListRenames(qa, [{ old: f.name, next, fid: f.fid }]);
    if (rep.renamed) alert(`✅ 改名成功\n\n${f.name}\n→ ${next}`);
    else alert(`❌ 改名未确认成功（成功 ${rep.renamed} / 失败 ${rep.failed} / 跳过 ${rep.skipped}）`);
  }

  function runRenameDiagnose(qa, doc = document) {
    const lines = [];
    const files = (qa.scanFileRows(doc) || []).filter(f => f.fid && f.row && !isFolderFile(f));
    lines.push(`可见文件行：${files.length}`);
    const f = files[0];
    if (!f) { alert(lines.join('\n') + '\n\n当前可见区没有文件行'); return; }
    const cell = getNameCellOnly(f.row);
    lines.push(`首个文件：${f.name}`);
    lines.push(`fid：${f.fid}`);
    lines.push(`mtime：${f.mtime || '（无）'}`);
    lines.push(`行 class：${f.row.className}`);
    lines.push(`名字单元格：${cell ? `<${cell.tagName.toLowerCase()} class="${cell.className}">` : '未找到 .filename-text'}`);
    if (cell) {
      lines.push(`title：${cell.getAttribute('title')}`);
    }
    const fit = fitAcgName('测试改名', f.name);
    lines.push(`改名目标名示例：${fit.name || '（构不出）'}${fit.truncated ? '（会被截短）' : ''}`);
    lines.push(`needRename(当前名, '测试改名') = ${needRename(f.name, '测试改名')}`);
    lines.push(`顶栏「重命名」按钮：${findToolbarRenameButton(doc) ? '已找到' : '未找到'}`);
    lines.push(`表头全选状态：${getHeaderCheckState(doc)}`);
    lines.push(`可见选中行：${getSelectedFids(doc).length}`);
    alert(lines.join('\n'));
  }

  /* ===== 逐行勾选 ===== */
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
      if (needScroll) f = await scrollToRowByName(qa, doc, name, { cacheKey });
      else f = qa.scanFileRows(doc).find(x => x.name === name);
      if (!f) { warn(` ⚠️ 找不到行：${name}`); failed++; failedNames.push(name); continue; }
      if (!!f.checked === desired) { applied++; continue; }
      const r = await setRowCheckbox(qa, f.row, desired);
      if (r.ok) applied++;
      else { failed++; failedNames.push(name); }
      await sleep(80, true);
    }
    return { ok: failed === 0, applied, failed, details: failedNames.map(n => ({ name: n })) };
  }

  async function applyTargetChecksViaSelectAll(qa, doc, targets, opts = {}) {
    if (!targets || !targets.size) return { ok: true, applied: 0, failed: 0 };
    const cacheKey = opts.cacheKey || null;
    const entries = [...targets.entries()];
    const trueEntries = entries.filter(([, v]) => v === true);
    const falseEntries = entries.filter(([, v]) => v === false);
    const trueCount = trueEntries.length;
    const falseCount = falseEntries.length;
    const totalCount = entries.length;

    /* 头部总数含"文件夹本身/其它目录"，不可能与当前目录行数相等；
     * 只有在"没扫到底"且行数明显少于头部时才回退逐行勾选 */
    const expected = getShareFileCount(doc);
    const hidden = !!doc.hidden;
    if (hidden || (expected && totalCount < expected && !isLastScanComplete())) {
      warn(` ⚠️ ${hidden ? '后台标签页' : `扫描未确认完整 ${totalCount}/头部 ${expected}`}，回退逐行勾选`);
      const cls = await clearAllViaHeader(qa, doc);
      if (!cls.ok) {
        return {
          ok: false, applied: 0, failed: totalCount,
          details: entries.map(([name]) => ({ name })),
          method: 'clear-failed-before-rowcheck',
        };
      }
      return await applyTargetChecks(qa, doc, targets, { cacheKey });
    }

    const headerState = getHeaderCheckState(doc);
    log(` 表头状态：${headerState}；目标：${trueCount} 勾选 / ${falseCount} 取消`);

    if (trueCount === totalCount && headerState === 'all') return { ok: true, applied: 0, failed: 0, method: 'header-all-satisfied' };
    if (falseCount === totalCount && headerState === 'none') return { ok: true, applied: 0, failed: 0, method: 'header-none-satisfied' };

    if (trueCount > 0 && trueCount < totalCount / 2) {
      log(` ★ 少量勾选（${trueCount}/${totalCount}），走「表头全不选 → 单独勾」`);
      if (headerState !== 'none') {
        const cls = await clearAllViaHeader(qa, doc);
        if (!cls.ok) {
          warn(` ⚠️ 表头清空失败（${cls.reason}），回退逐行`);
          return await applyTargetChecks(qa, doc, targets, { cacheKey });
        }
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
        await sleep(80, true);
      }
      return {
        ok: failed.length === 0, applied: ok, failed: failed.length,
        details: failed.map(n => ({ name: n })),
        method: 'header-clear+scroll-select',
      };
    }

    const anyTrue = trueCount > 0;
    const targetHeaderState = anyTrue ? 'all' : 'none';
    if (headerState !== targetHeaderState) {
      const hdr = await setHeaderCheckbox(qa, doc, anyTrue);
      if (!hdr.ok) {
        warn(` ⚠️ 表头复选框操作失败（${hdr.reason}），回退逐行`);
        return await applyTargetChecks(qa, doc, targets, { cacheKey });
      }
    }
    if (!falseEntries.length) return { ok: true, applied: 0, failed: 0, method: 'header-only' };
    let ok = 0;
    const failed = [];
    for (const [name] of falseEntries) {
      const f = await scrollToRowByName(qa, doc, name, { cacheKey });
      if (!f) { failed.push(name); continue; }
      if (!f.checked) { ok++; continue; }
      const r = await setRowCheckbox(qa, f.row, false);
      if (r.ok) ok++;
      else failed.push(name);
      await sleep(80, true);
    }
    return {
      ok: failed.length === 0, applied: ok, failed: failed.length,
      details: failed.map(n => ({ name: n })),
      method: 'header+scroll-exclude',
    };
  }

  /* ===== 表格稳定等待 =====
   * 返回 {ok, files, count, expected}：
   *   ok=true   → 行数达到 expected 且稳定（或 expected 未知但行数稳定）
   *   ok=false  → 超时未达 expected；files 是当前可见区
   * 调用方必须检查 .ok，不能直接用 files。 */
  async function waitTableStable(qa, doc = document, maxMs = 20000) {
    const t0 = Date.now();
    /* 头部总数只作参考：它是整个分享的口径（含文件夹本身/其它目录），
     * 永远大于等于当前目录行数；拿它当等式会让每次保存都白等满 maxMs */
    const expected = getShareFileCount(doc);
    log(` 头部共 ${expected == null ? '?' : expected} 个（仅参考）；等待首屏行数稳定...`);

    await until(() => !isShareTableLoading(doc), 150, maxMs);
    log(` 表格加载层已消失，等待行数稳定...`);

    let lastCount = -1;
    let stableHits = 0;
    let lastWarn = 0;
    const remain = () => Math.max(800, maxMs - (Date.now() - t0));

    const got = await until(() => {
      if (isShareTableLoading(doc)) { lastCount = -1; stableHits = 0; return null; }
      const rows = qa.scanFileRows(doc);
      const cnt = rows.length;
      if (cnt > 0 && cnt === lastCount) {
        if (++stableHits >= 2) return { ok: true, files: rows, count: cnt, expected };
      } else {
        if (cnt > 0 && Date.now() - lastWarn > 3000) {
          lastWarn = Date.now();
          log(`  ⏳ 首屏 ${cnt} 行（头部 ${expected == null ? '?' : expected}），继续等稳定...`);
        }
        stableHits = 0;
      }
      lastCount = cnt;
      return null;
    }, 300, remain());

    if (got) return got;

    const cur = qa.scanFileRows(doc);
    log(` 等待超时，当前扫描到 ${cur.length} 行（期望 ${expected == null ? '?' : expected}）`);
    return { ok: false, files: cur, count: cur.length, expected };
  }

  /* 返回 {ok, count, expectedMin}：ok=true 表示行数达到 expectedMin 并稳定 */
  async function waitForListRowsStable(qa, doc, expectedMin, timeout = 10000) {
    const t0 = Date.now();
    const expMin = Math.max(1, Number(expectedMin) || 1);
    let last = -1, stable = 0;
    while (Date.now() - t0 < timeout) {
      if (isShareTableLoading(doc)) { last = -1; stable = 0; await sleep(200, true); continue; }
      const cnt = (qa.scanFileRows(doc) || []).length;
      if (cnt === last && cnt > 0) {
        stable++;
        if (cnt >= expMin && stable >= 2) {
          log(` ★ 刷新后列表稳定：${cnt} 行（期望 ≥${expMin}）`);
          return { ok: true, count: cnt, expectedMin: expMin };
        }
        if (cnt < expMin && stable >= 6) {
          log(` ⏱ 刷新后行数稳定但少于预期：${cnt} < ${expMin}，等待超时视作不完整`);
          return { ok: false, count: cnt, expectedMin: expMin };
        }
      } else {
        stable = 0;
      }
      last = cnt;
      await sleep(200, true);
    }
    const finalCnt = (qa.scanFileRows(doc) || []).length;
    log(` ⏱ 刷新后等待超时：当前 ${finalCnt} 行（期望 ≥${expMin}）`);
    return { ok: finalCnt >= expMin, count: finalCnt, expectedMin: expMin };
  }

  /* ===== 批次执行器 ===== */
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
        return {
          ok: false, kind: 'check-failed', savedFiles, batchResults,
          details: r.details || [], result: overall,
        };
      }

      const result = await clickSaveOnce(qa, doc);
      log(` [批 ${bi + 1}/${batches.length}] 转存结果：${result}`);
      overall = result;

      let recorded = false;
      if (result === 'success'
          || (result === 'unknown' && isSuccessModalPresent(doc) && !isIframeCovering(doc))) {
        const allRows = qa.scanFileRows(doc) || [];
        const actuallySaved = allRows.filter(row => row.checked);
        if (actuallySaved.length) {
          savedFiles.push(...actuallySaved);
          if (actuallySaved.length !== batch.length) {
            warn(` ⚠️ 批 ${bi + 1} 实际勾选 ${actuallySaved.length} 个 ≠ 计划 ${batch.length} 个，按实际记录`);
          }
        } else {
          savedFiles.push(...batch);
        }
        recorded = true;
      } else if (result === 'unknown') {
        warn(` ⚠️ 批 ${bi + 1} 结果 unknown 且未见成功模态框`);
      }

      batchResults.push({
        index: bi, count: batch.length, result, recorded,
        names: batch.map(f => f.name),
      });

      if (bi < batches.length - 1) await waitAllModalsGone(qa, doc, 2000);
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

  function fmtNames(arr, maxShow = 20) {
    const names = (arr || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean);
    if (!names.length) return '（无）';
    if (names.length <= maxShow) return names.join('、');
    return names.slice(0, maxShow).join('、') + ` 等 ${names.length} 个`;
  }

  /* ===== 分享页准备 ===== */
  async function prepareShareSave(qa, doc = document, opts = {}) {
    const cacheKey = currentCacheKey();
    await ensureTimeDescSort(qa, doc);

    const stable = await waitTableStable(qa, doc, 20000);
    let files = (stable.files || []).filter(f => !isFolderFile(f));
    if (!files.length && !stable.ok && stable.expected > 0) {
      warn(` ⚠️ 等待表格稳定超时且无行（期望 ${stable.expected}）`);
      return { ok: false, kind: 'scan-incomplete', files: [], expected: stable.expected };
    }
    if (!files.length) return { ok: false, kind: 'no-files', files: [] };

    await sleep(300, true);
    files = await scanAllRowsByScroll(qa, doc, { key: cacheKey, useCache: true });
    files = (files || []).filter(f => !isFolderFile(f));
    if (!files.length) return { ok: false, kind: 'no-files', files: [] };

    /* 头部总数是整个分享的口径（含文件夹本身、含各子目录的文件），只能当上界；
     * 是否扫全看 scanAllRowsByScroll 有没有"到底 + 未超时" */
    const expected = getShareFileCount(doc);
    if (expected && files.length < expected) {
      if (isLastScanComplete()) {
        warn(` ⚠️ 已扫到底：${files.length} 行 < 头部 ${expected}（头部把文件夹本身/其它目录算进来了），按实际继续`);
      } else {
        warn(` ⚠️ 首次扫描未确认完整（${files.length}/头部 ${expected}），强制全表扫描一次...`);
        await sleep(500, true);
        files = await scanAllRowsByScroll(qa, doc, { key: cacheKey, useCache: false, maxMs: 40000 });
        files = (files || []).filter(f => !isFolderFile(f));
        if (files.length < expected && !isLastScanComplete()) {
          warn(` ⚠️ 二次扫描仍未到底（${files.length}/头部 ${expected}），中止本轮以避免误转存`);
          return { ok: false, kind: 'scan-incomplete', files, expected };
        }
        log(` ✓ 二次扫描：${files.length} 个（到底=${isLastScanComplete()}）`);
      }
    }

    const shareKey = normalizeShareKey(location.href);
    const clearFlagAtStart = Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
    const savedInfos = healShareRecords(shareKey, files);

    try {
      const recsAll = loadRecords({ consumeClear: false });
      log(` 分享 key：${shareKey}`);
      log(` 记录 keys（${Object.keys(recsAll).length}）：${Object.keys(recsAll).join(', ') || '（空）'}`);
    } catch {}

    const saved = files.filter(f => isFileSaved(f, savedInfos));
    const pending = files.filter(f => !isFileSaved(f, savedInfos));
    const excludeNames = new Set(saved.map(f => f.name));

    log(` 共 ${files.length} 个（已排除文件夹）：已转存 ${saved.length}，待转存 ${pending.length}`);
    for (const f of files) {
      log(` - ${f.name} sizeStr="${f.sizeStr}" mtime="${f.mtime || '-'}" fid="${f.fid || '-'}" → ${isFileSaved(f, savedInfos) ? 'SAVED' : 'PENDING'}`);
    }

    if (files.length > 0 && saved.length === 0) {
      maybeSaveFullResaveDebug(qa, files, savedInfos, {
        source: opts.source || 'child-task',
        clearFlagAtStart, incomplete: false, expected,
      });
    }

    setShareFullCounts(qa, saved.length, files.length);

    if (!pending.length) {
      return { ok: false, kind: 'all-saved', needSave: [], skipped: saved, excludeNames, files };
    }

    try {
      const okPack = ensurePackDirUnchecked(qa, doc);
      log(` ★ 转存前"保存为文件夹"：${okPack ? '已取消/无此项' : '取消失败'}`);
    } catch (e) { warn('取消"保存为文件夹"异常', e); }

    const batches = [pending];
    log(` ★ 全量转存：单批 ${pending.length} 个`);

    return {
      ok: true, kind: 'ready',
      needSave: pending, skipped: saved, excludeNames, files, batches,
    };
  }

  /* ===== 子任务 ===== */
  async function tryHandleChildTask(qa) {
    const shareId = extractShareId(location.href);
    if (!shareId) return false;
    const task = consumeTask(shareId);
    if (!task) return false;

    if (qa.isPaused && qa.isPaused()) {
      log(`⏸ [子任务] ${shareId} 检测到暂停，直接关闭页面`);
      setResult(shareId, { kind: 'paused' });
      setTimeout(() => { try { window.close(); } catch {} }, 300);
      return true;
    }

    log(`★ [子任务] ${shareId} 开始处理`);
    qa.mountPanel();
    qa.setStatus('子任务处理中...', 'running');
    qa.setProgress('-');
    startSharePolling(qa);

    const finish = (kind, extra = {}) => {
      setResult(shareId, { kind, ...extra });
      log(`★ [子任务] 结果已写入：${kind}`);
      setTimeout(() => { try { window.close(); } catch {} }, 800);
    };

    let prep;
    try { prep = await prepareShareSave(qa, document, { source: 'child-task' }); }
    catch (e) {
      warn(' 准备失败', e);
      finish('fail', { message: 'prepare-error:' + String(e && e.message || e) });
      return true;
    }

    if (prep.kind === 'no-files') { finish('skip', { message: 'no-files' }); return true; }
    if (prep.kind === 'all-saved') {
      finish('all-saved', { fileCount: prep.files.length, files: prep.files.map(f => f.name) });
      return true;
    }
    if (prep.kind === 'scan-incomplete') {
      warn(` ⛔ [子任务] 扫描不完整（${prep.files.length}/${prep.expected}），中止转存`);
      finish('fail', { message: `scan-incomplete:${prep.files.length}/${prep.expected}` });
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
        const rec = await mergeShareRecord(key, savedFiles, { shareId });
        log(` 记录已更新：${key} → ${((rec && rec.fileInfos) || []).length} 条`);
      }
      const summary = describeExec(exec);
      const savedBrief = savedFiles.map(f => ({
        name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
        fid: f.fid || '', mtime: f.mtime || '',
      }));
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

  /* 只读地看一眼有没有属于自己的任务（不消费，用于待机期间轮询） */
  function peekTask(shareId) {
    if (!shareId) return null;
    let t = null;
    try { t = GM_getValue(GM_TASK_PREFIX + shareId, null); } catch {}
    if (!t) {
      const m = gmGet(GM_TASKS, {}) || {};
      if (m[shareId]) t = m[shareId];
    }
    if (!t || !(t.ts > 0)) return null;
    if (Date.now() - t.ts > TASK_TTL) return null;
    return t;
  }

  /* 分享页进入待机后仍继续等一小段时间的子任务。
   * 场景：后台标签页脚本执行被浏览器推迟 / 父页分批补开，任务可能写得比本页就绪晚。 */
  function watchChildTaskWhileIdle(qa, ms = 60000) {
    const shareId = extractShareId(location.href);
    if (!shareId) return;
    const t0 = Date.now();
    let handled = false;
    const tick = async () => {
      if (handled) return;
      if (Date.now() - t0 > ms) return;
      let task = null;
      try { task = peekTask(shareId); } catch {}
      if (!task) { setTimeout(tick, 1500); return; }
      handled = true;
      log(`★ [子任务] 待机期间检测到任务 ${shareId}，立即接管`);
      try { await tryHandleChildTask(qa); } catch (e) { warn('待机期间子任务处理异常', e); }
    };
    setTimeout(tick, 1500);
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

  /* 并行转存：一次性（或按 maxConcurrent 分批）打开所有需要的分享页，再统一收结果。
   * 返回 [{url, shareId, result}]，顺序与入参一致；任务/结果按 shareId 独立存键，互不覆盖。 */
  async function saveShareUrlsInParallel(qa, urls, opts = {}) {
    const stagger = Number(opts.stagger) > 0 ? Number(opts.stagger) : 250;
    const cap = Number(opts.maxConcurrent) > 0 ? Number(opts.maxConcurrent) : 0;   /* 0 = 不限 */
    const timeout = Number(opts.timeout) > 0
      ? Number(opts.timeout)
      : (TAB_RESULT_TIMEOUT + PARALLEL_GRACE_MS);

    /* 同一 shareId 只开一次：重复链接会争抢同一个任务键，导致第二个页面永远拿不到任务 */
    const seenSid = new Set();
    const jobs = (urls || []).map(url => ({
      url, shareId: extractShareId(url) || '', result: null, done: false, opened: false,
    }));
    for (const j of jobs) {
      if (!j.shareId) { j.result = { kind: 'fail', message: 'bad-url' }; j.done = true; continue; }
      if (seenSid.has(j.shareId)) {
        j.result = { kind: 'fail', message: 'duplicate-url' };
        j.done = true;
        continue;
      }
      seenSid.add(j.shareId);
    }
    const todo = jobs.filter(j => !j.done);
    log(`★ 并行转存：${todo.length} 个链接，${cap ? `并发上限 ${cap}` : '同时打开全部'}，` +
        `开页间隔 ${stagger}ms，总超时 ${Math.round(timeout / 1000)}s`);

    const openOne = async (j) => {
      /* 必须先写任务再开页：子页脚本一就绪就会 consumeTask，晚写会让它直接进"待机" */
      try {
        clearResult(j.shareId);
        setTask(j.shareId, j.url);
      } catch (e) {
        warn(' 写入子任务失败', e);
        j.result = { kind: 'fail', message: 'set-task-failed' };
        j.done = true;
        return false;
      }
      try {
        GM_openInTab(j.url, { active: false, insert: true, setParent: true });
        j.opened = true;
        return true;
      } catch (e) {
        clearTask(j.shareId);
        j.result = { kind: 'fail', message: 'open-tab-failed' };
        j.done = true;
        return false;
      }
    };
    const collect = () => {
      for (const j of jobs) {
        if (j.done || !j.opened || !j.shareId) continue;
        const r = consumeResult(j.shareId);
        if (r) { j.result = r; j.done = true; log(` ← 收到结果 ${j.shareId}：${r.kind}`); }
      }
    };
    const pausedNow = () => !!(qa && qa.isPaused && qa.isPaused());

    const t0 = Date.now();
    let openedCount = 0;
    /* 首批：不限并发时就是全部 */
    for (const j of todo) {
      if (cap && openedCount >= cap) break;
      if (pausedNow()) break;
      if (await openOne(j)) {
        openedCount++;
        log(` → 打开标签页（${openedCount}/${todo.length}）：${j.url}`);
        await sleep(stagger, true);
      }
    }

    for (;;) {
      collect();
      const notOpened = jobs.filter(j => !j.done && !j.opened);
      if (notOpened.length) {
        if (pausedNow()) {
          for (const x of notOpened) { clearTask(x.shareId); x.result = { kind: 'paused' }; x.done = true; }
          log(`⏸ 暂停，剩余 ${notOpened.length} 个不再打开`);
        } else if (!cap || jobs.filter(j => j.opened && !j.done).length < cap) {
          const j = notOpened[0];
          if (await openOne(j)) {
            openedCount++;
            log(` → 补开标签页（${openedCount}/${todo.length}）：${j.url}`);
            await sleep(stagger, true);
            continue;
          }
        }
      }
      if (jobs.every(j => j.done)) break;
      if (Date.now() - t0 > timeout) {
        const lost = jobs.filter(j => !j.done);
        for (const j of lost) {
          clearTask(j.shareId);
          j.result = j.opened ? { kind: 'timeout', message: 'tab-timeout' } : { kind: 'fail', message: 'not-opened' };
          j.done = true;
        }
        warn(` ⚠️ 并行转存超时（${Math.round((Date.now() - t0) / 1000)}s），${lost.length} 个未收到结果`);
        break;
      }
      try {
        const doneN = jobs.filter(j => j.done).length;
        if (qa && qa.setProgress) qa.setProgress(`${doneN} / ${jobs.length}`);
      } catch {}
      await sleep(500, true);
    }

    const kinds = jobs.reduce((m, j) => {
      const k = (j.result && j.result.kind) || 'none';
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {});
    log(`★ 并行转存结束：${Object.entries(kinds).map(([k, n]) => `${k}×${n}`).join('，')}` +
        `（耗时 ${Math.round((Date.now() - t0) / 1000)}s）`);
    return jobs;
  }

  /* ===== 页面内刷新 ===== */
  function findListRefreshButton(doc = document) {
    const el = doc.querySelector('.fl-refresh');
    if (el && _isVisible(el)) return el;
    return null;
  }
  async function clickListRefresh(qa, doc = document) {
    const wrap = findListRefreshButton(doc);
    if (!wrap) return false;
    const target = wrap.querySelector('img') || wrap;
    try {
      if (qa && typeof qa.realClick === 'function') qa.realClick(target);
      else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (e) {
      try { target.click(); return true; } catch { return false; }
    }
  }

  /* 返回 {ok, refreshed}：
   *   ok=true,  refreshed=true  → 点到了刷新按钮，loading 已结束（或本无 loading）
   *   ok=false, refreshed=false → 没找到刷新按钮，或刷新后 loading 一直不消失 */
  async function clickListRefreshAndWait(qa, doc = document, opts = {}) {
    const appearedTimeout = opts.appearedTimeout ?? 3000;
    const settleTimeout = opts.settleTimeout ?? 15000;
    const ok = await clickListRefresh(qa, doc);
    if (!ok) return { ok: false, refreshed: false };
    const tableWrap = doc.querySelector('.ant-table-wrapper');
    if (!tableWrap) { await sleep(800, true); return { ok: true, refreshed: true }; }
    const appeared = await until(() => !!tableWrap.querySelector('.ant-spin-spinning'), 100, appearedTimeout);
    if (appeared) {
      const gone = await until(() => !tableWrap.querySelector('.ant-spin-spinning'), 150, settleTimeout);
      if (!gone) return { ok: false, refreshed: true };
      return { ok: true, refreshed: true };
    }
    await sleep(800, true);
    return { ok: true, refreshed: true };
  }

  /* ===== 图标 ===== */
  function normalizeIconSig(sig) {
    let s = String(sig ?? '').trim();
    if (!s) return '';
    s = s.replace(/&amp;/g, '&').replace(/^([A-Za-z]+):/, (m, p) => p.toLowerCase() + ':');
    s = s.replace(/^([a-z]+:)\s*["']?/, '$1').replace(/["']\s*$/, '').trim();
    if (/^bg:.*thumb-.*drive\.quark\.cn\//i.test(s) || /^bg:.*\/thumbnail_/i.test(s)) {
      const q = s.indexOf('?');
      return (q >= 0 ? s.slice(0, q) : s).replace(/\/+$/, '');
    }
    const q = s.indexOf('?');
    if (q < 0) return s.replace(/\/+$/, '');
    const base = s.slice(0, q).replace(/\/+$/, '');
    const params = s.slice(q + 1).split('&').filter(Boolean);
    const fidKv = params.find(p => /^fid=/i.test(p));
    if (fidKv) return base + '?' + fidKv;
    return base + '?' + params.slice().sort().join('&');
  }
  function iconFid(sig) {
    const m = normalizeIconSig(sig).match(/[?&]fid=([^&]+)/i);
    return m ? m[1] : '';
  }
  function isIdentifiableIconSig(sig) {
    const s = String(sig ?? '').trim();
    if (!s || /^(svg|cls):/i.test(s)) return false;
    if (!/^(img|bg|url):/i.test(s)) return /^https?:\/\//i.test(s);
    return /thumbnail|\.(png|jpe?g|webp|gif|avif)/i.test(s) || /[?&]fid=/i.test(s);
  }
  function sameIconSig(a, b) {
    if (!isIdentifiableIconSig(a) || !isIdentifiableIconSig(b)) return false;
    const fa = iconFid(a), fb = iconFid(b);
    if (fa || fb) return !!fa && !!fb && fa.toLowerCase() === fb.toLowerCase();
    const na = normalizeIconSig(a), nb = normalizeIconSig(b);
    return !!na && na === nb;
  }
  function stripDedupSuffix(name) {
    let t = String(name ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    let suffix = 0;
    for (let i = 0; i < 5; i++) {
      const m = t.match(/^(.*?)\s*\((\d{1,3})\)(\.[^.]*)$/);
      if (!m || !m[1]) break;
      const n = Number(m[2]) || 0;
      if (n > suffix) suffix = n;
      t = (m[1] + m[3]).trim();
    }
    return { base: t, suffix };
  }
  function normSizeKey(s) {
    try { return normalizeSizeStr(s); } catch { return String(s ?? '').trim().toUpperCase(); }
  }

  let lastMatchReason = '';
  function matchSavedToListRow(saved, rows, savedBefore, opts = {}) {
    const beforeFids = (opts && opts.beforeFids) || null;
    lastMatchReason = '';
    if (!Array.isArray(rows) || !rows.length) return null;
    const savedName = String((saved && saved.name) || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!savedName) return null;
    const savedIcon = normalizeIconSig(saved && saved.iconSig);
    const savedSize = normSizeKey(saved && saved.sizeStr);
    const wantName = getComparableFileName(savedName);
    const mk = (r, how) => ({ row: r, currentName: r.name, base: stripMarkerBlock(r.name).trim(), how });
    const exactCand = [];
    const baseCand = [];
    for (const r of rows) {
      const cur = String(r.name || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (!cur) continue;
      if (stripMarkerBlock(cur) !== cur) continue;
      const curKey = getComparableFileName(cur);
      const rs = stripDedupSuffix(cur);
      if (curKey === wantName) { exactCand.push({ r, cur, suffix: rs.suffix }); continue; }
      if (rs.suffix > 0 && getComparableFileName(rs.base) === wantName) baseCand.push({ r, cur, suffix: rs.suffix });
    }
    const exactAlreadySaved = Array.isArray(savedBefore)
    && savedBefore.some(si => isSameFile(si, { name: savedName, sizeStr: (saved && saved.sizeStr) || '', iconSig: (saved && saved.iconSig) || '' }));
    if (isIdentifiableIconSig(savedIcon)) {
      const sameIcon = rows.filter(r => sameIconSig(r.iconSig, savedIcon));
      if (sameIcon.length) {
        if (iconFid(savedIcon)) {
          if (sameIcon.length === 1) return mk(sameIcon[0], 'icon-fid');
        } else {
          const nameOk = r => {
            const cur = String(r.name || '');
            const curKey = getComparableFileName(cur);
            if (curKey === wantName) return true;
            const rs = stripDedupSuffix(cur);
            return rs.suffix > 0 && getComparableFileName(rs.base) === wantName;
          };
          const oldRows = new Set(exactCand.map(c => c.r));
          const byIcon = sameIcon.filter(r => nameOk(r) && !oldRows.has(r));
          if (byIcon.length) {
            const sized = savedSize ? byIcon.filter(r => normSizeKey(r.sizeStr) === savedSize) : [];
            const allSized = byIcon.every(r => !!normSizeKey(r.sizeStr));
            if (savedSize && allSized && sized.length === 1) return mk(sized[0], 'icon');
            if (!savedSize && byIcon.length === 1 && normSizeKey(byIcon[0].sizeStr)) return mk(byIcon[0], 'icon');
          }
        }
      }
    }
    const allCand = exactCand.concat(baseCand);
    const suffixed = exactCand.filter(c => c.suffix > 0).concat(baseCand);
    const pickBySize = list => {
      if (savedSize) {
        const sized = list.filter(c => normSizeKey(c.r.sizeStr) === savedSize);
        if (sized.length) return sized;
      }
      return list;
    };
    const pickMaxSuffix = list => {
      const p = pickBySize(list).slice();
      p.sort((a, b) => b.suffix - a.suffix);
      return p[0];
    };
    if (beforeFids && beforeFids.size && allCand.length) {
      const fresh = allCand.filter(c => c.r && c.r.fid && !beforeFids.has(c.r.fid));
      if (fresh.length) {
        const pick = fresh.length === 1 ? fresh[0] : pickMaxSuffix(fresh);
        return mk(pick.r, 'new-fid');
      }
    }
    if (allCand.length === 1) return mk(allCand[0].r, 'name-only');
    if (exactAlreadySaved && suffixed.length) return mk(pickMaxSuffix(suffixed).r, 'name');
    if (exactCand.length && baseCand.length) { lastMatchReason = 'ambiguous'; return null; }
    const cand = exactCand.length ? exactCand : baseCand;
    if (cand.length) return mk(pickMaxSuffix(cand).r, 'name');
    const hit = rows.find(r => getComparableFileName(r.name) === wantName);
    if (hit) return mk(hit, 'name-only');
    return null;
  }

  function buildRenamePlan(savedByUrl, bd, listRows = [], alreadySaved = [], beforeFids = null) {
    const { map: nameByShare, conflict } = collectShareNameMap(bd);
    const items = [];
    const usedFids = new Set();
    const usedRows = new Set();
    const unmatched = [];
    let ambiguous = [];
    const noName = [];
    for (const entry of (Array.isArray(savedByUrl) ? savedByUrl : [])) {
      if (!entry || !Array.isArray(entry.files) || !entry.files.length) continue;
      const acgName = nameByShare.get(entry.url);
      if (!acgName) {
        for (const f of entry.files) {
          const savedName = String((f && f.name) || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          if (savedName) noName.push(savedName);
        }
        continue;
      }
      for (const f of entry.files) {
        const savedName = String((f && f.name) || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        if (!savedName) continue;
        const freeRows = listRows.filter(r => !usedRows.has(r) && !(r.fid && usedFids.has(r.fid)));
        const m = matchSavedToListRow(f, freeRows, alreadySaved, { beforeFids });
        if (!m) {
          if (lastMatchReason === 'ambiguous') ambiguous.push(savedName);
          else unmatched.push(savedName);
          continue;
        }
        if (m.row) { usedRows.add(m.row); if (m.row.fid) usedFids.add(m.row.fid); }
        items.push({ savedName, acgName, currentName: m.currentName, base: m.base, row: m.row, how: m.how });
      }
    }
    if (!items.length) {
      const empty = [];
      empty.unmatched = unmatched; empty.ambiguous = ambiguous; empty.noName = noName;
      return empty;
    }
    const targetByBase = new Map();
    const conflictNames = new Set();
    let tooLong = 0, truncated = 0;
    for (const it of items) {
      if (!it.base) continue;
      const fit = fitAcgName(it.acgName, it.base);
      if (!fit.name) { tooLong++; continue; }
      if (fit.truncated) truncated++;
      const prev = targetByBase.get(it.base);
      if (prev === undefined) { targetByBase.set(it.base, it.acgName); continue; }
      if (prev !== it.acgName) { targetByBase.delete(it.base); conflictNames.add(it.base); }
    }
    if (tooLong) warn(` ⚠️ 改名：${tooLong} 个文件即使用截短后的 acg 名称也放不下，保留原名不改`);
    if (truncated) log(` ★ 改名：${truncated} 个文件的目标名超过夸克 250 上限，acg 名称已自动截短`);
    const out = [];
    const seenOld = new Set();
    ambiguous = [];
    const notRenamed = unmatched.slice();
    for (const it of items) {
      const oldName = it.currentName;
      if (!oldName || seenOld.has(oldName)) { if (oldName) ambiguous.push(oldName); continue; }
      seenOld.add(oldName);
      if (conflictNames.has(it.base)) { ambiguous.push(oldName); continue; }
      const name = targetByBase.get(it.base);
      if (!name) { notRenamed.push(oldName); continue; }
      const baseForTarget = String(it.base || '').trim();
      if (!baseForTarget) { notRenamed.push(oldName); continue; }
      const next = buildRenamedFileName(name, baseForTarget);
      if (!next) { notRenamed.push(oldName); continue; }
      if (!needRename(it.currentName, name)) continue;
      out.push({
        old: oldName, next, acgName: name,
        truncated: fitAcgName(name, baseForTarget).truncated,
        matchedBy: it.how, fid: (it.row && it.row.fid) || '',
      });
    }
    out.unmatched = notRenamed;
    out.ambiguous = ambiguous;
    out.noName = noName;
    return out;
  }

  /* 改名前的同名旧文件清理
   * 场景：转存前没被清掉的旧文件正好占着本次的目标名 → 改名必然撞重名（以前表现为 submit-failed，
   *      手动改也失败；但删掉旧文件后就能改）。这里在改名之前把这类旧文件删掉。
   * 只删同时满足三个条件的行，宁可不删也不误删：
   *   ① 名字与某个改名目标名完全一致（去零宽字符后逐字相等）
   *   ② 该 fid 出现在"转存前快照"里（即转存前就已经存在）
   *   ③ 该 fid 不是本次转存得到的行（不在 plan[].fid 里）
   * 单次最多 20 个，超过就只提示不执行。 */
  async function purgeConflictingOldRows(qa, plan, preRows, doc = document) {
    const out = { deleted: 0, fids: [], names: [], skipped: 0 };
    if (!Array.isArray(plan) || !plan.length) return out;
    if (!Array.isArray(preRows) || !preRows.length) return out;
    if (!qa || typeof qa.deleteFilesByFids !== 'function') return out;

    const preFidSet = new Set(preRows.map(r => String((r && r.fid) || '')).filter(Boolean));
    const newFidSet = new Set(plan.map(p => String((p && p.fid) || '')).filter(Boolean));
    const targetByKey = new Map();
    for (const p of plan) {
      const k = normExactName(p.next);
      if (k) targetByKey.set(k, p);
    }
    if (!targetByKey.size) return out;

    const victims = [];
    for (const r of preRows) {
      const fid = String((r && r.fid) || '');
      if (!fid || !preFidSet.has(fid) || newFidSet.has(fid)) continue;
      const hit = targetByKey.get(normExactName(r.name));
      if (!hit) continue;
      victims.push({ fid, name: String(r.name || ''), target: hit.next, old: hit.old });
    }
    if (!victims.length) return out;

    if (victims.length > 20) {
      warn(` ⚠️ 改名：检测到 ${victims.length} 个同名旧文件（超过 20 个上限），本轮不自动删除，请人工确认`);
      out.skipped = victims.length;
      return out;
    }

    warn(` 🧹 改名：${victims.length} 个目标名已被转存前的旧文件占用，先删旧文件再改名（否则必然撞重名）`);
    for (const v of victims) log(`    - 旧文件：${v.name}（fid ${v.fid.slice(0, 8)}）占用了目标名「${v.target}」`);

    let del = null;
    try { del = await qa.deleteFilesByFids(victims.map(v => v.fid), { tag: 'rename-dup' }); }
    catch (e) { warn(' ⚠️ 改名：删除同名旧文件异常', e); return out; }

    const gone = new Set(victims.map(v => v.fid));
    const still = new Set((del && del.still) || []);
    const removed = victims.filter(v => gone.has(v.fid) && !still.has(v.fid));
    if (removed.length) {
      out.deleted = removed.length;
      out.fids = removed.map(v => v.fid);
      out.names = removed.map(v => v.name);
      log(` 🧹 改名：已删除 ${removed.length} 个同名旧文件`);
      try { await until(() => !isShareTableLoading(doc), 150, 8000); } catch {}
      await sleep(500, true);
    }
    if (still.size) {
      warn(` ⚠️ 改名：${still.size} 个同名旧文件删除后仍在列表（可能删除被拒），改名可能仍会撞重名`);
    }
    return out;
  }

  function refreshDlRecordsAfterRename(qa, pairs) {
    if (!Array.isArray(pairs) || !pairs.length) return 0;
    /* GM_setValue 是"按脚本"隔离的：桥接直接写 quark_auto_dl_records 对 QuarkAutoAssistant 无效，
     * 必须走它暴露的 API（否则日志说"已同步"，实际记录里的名字还是旧的） */
    if (!qa || typeof qa.renameDlRecordNames !== 'function') {
      warn('⚠️ 夸克助手未提供 renameDlRecordNames，跳过下载记录改名同步');
      return 0;
    }
    try { return qa.renameDlRecordNames(pairs) || 0; }
    catch (e) { warn('⚠️ 同步下载记录失败', e); return 0; }
  }

  /* ===== 全流程 ===== */
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

    acquireBusy();
    log('★ 已标记桥接忙碌，QuarkAutoAssistant 暂停自动下载');

    const savedNamesBefore = collectSavedInfos(loadRecords())
    .map(si => ({
      name: si.name, sizeStr: si.sizeStr, iconSig: si.iconSig,
      fid: si.fid || '', mtime: si.mtime || '',
    }));

    let renameAllConfirmedOut = true;
    let hadRenamePlan = false;

    let preRows = [];
    try {
      preRows = await scanAllRowsByScroll(qa, document, { key: currentCacheKey(), useCache: false, maxMs: 12000 }) || [];
    } catch (e) {
      warn('⚠️ 改名：转存前快照失败', e);
      preRows = qa.scanFileRows(document) || [];
    }
    log(` ★ 改名：转存前列表快照 ${preRows.length} 行`);

    try {
      qa.setStatus('转存中...', 'running');
      let successCount = 0;
      let partialCount = 0;
      let scanIncompleteCount = 0;
      const savedByUrl = [];

      /* 并行：一次性打开全部（或按上限分批）分享页，再统一收结果 */
      let jobs;
      try { jobs = await saveShareUrlsInParallel(qa, pending, { maxConcurrent: PARALLEL_SAVE_LIMIT }); }
      catch (e) { warn('并行转存异常', e); jobs = pending.map(u => ({ url: u, result: { kind: 'fail', message: String(e && e.message || e) } })); }

      for (let i = 0; i < jobs.length; i++) {
        const url = jobs[i].url;
        const r = jobs[i].result || { kind: 'fail', message: 'no-result' };
        log(`--- [${i + 1}/${jobs.length}] ${url} → ${r.kind}`);

        const key = normalizeShareKey(url);
        if (r.kind === 'success' || r.kind === 'partial') {
          if (r.kind === 'success') successCount++;
          else partialCount++;
          const rec = await mergeShareRecord(key, r.savedFiles || [], { shareId: extractShareId(key) });
          const merged = (rec && rec.fileInfos) || [];
          if (r.kind === 'partial') warn(`⚠️ 部分成功（${(r.savedFiles || []).length}/${r.totalPlanned}）：${url}`);
          else log(`✅ 已记录 ${merged.length} 条到 ${key}`);
          if (Array.isArray(r.savedFiles) && r.savedFiles.length) {
            savedByUrl.push({
              url: key,
              files: r.savedFiles.map(f => ({
                name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
                fid: f.fid || '', mtime: f.mtime || '',
              })),
            });
          }
        } else if (r.kind === 'all-saved') {
          log(`⏭️ 该 URL 所有文件都已转存：${url}`);
          /* all-saved：重置 CD 避免下次触发被拖长 */
          try {
            const st = gmGet(GM_CD, {}) || {};
            if (st[key]) { st[key] = { ts: Date.now(), attempts: 0 }; gmSet(GM_CD, st); }
          } catch {}
        } else if (r.kind === 'paused') {
          log(`⏸ 子任务因暂停直接关闭：${url}`);
          qa.setStatus('已暂停', 'running');
          break;
        } else if (r.kind === 'fail' && r.message && String(r.message).startsWith('scan-incomplete:')) {
          warn(`⚠️ 扫描不完整，跳过本轮转存：${url}（${r.message}）`);
          scanIncompleteCount++;
        } else {
          warn(`⚠️ 结果 ${r.kind}: ${url}`);
        }
      }

      qa.setStatus('转存完成', 'done');
      qa.setProgress('-');

      if (scanIncompleteCount > 0) {
        warn(`⚠️ ${scanIncompleteCount} 个 URL 因扫描不完整被跳过（未转存，下次重试）`);
      }

      if (successCount + partialCount > 0) {
        log('★ 有新转存，点击页面内刷新按钮触发列表更新...');
        await sleep(500, true);

        const refreshRes = await clickListRefreshAndWait(qa, document, {
          appearedTimeout: 3000, settleTimeout: 15000,
        });
        if (refreshRes.ok) log('✓ 已点击刷新并等到列表恢复');
        else if (refreshRes.refreshed) warn('⚠️ 已点刷新但 loading 超时未结束');
        else warn('⚠️ 未找到页面内刷新按钮');

        let waitRes = { ok: false, count: preRows.length };
        if (refreshRes.ok) {
          const savedTotalForSnap0 = savedByUrl.reduce((n, en) => n + ((en && en.files) || []).length, 0);
          const expectedMin = preRows.length + savedTotalForSnap0;
          waitRes = await waitForListRowsStable(qa, document, expectedMin, 15000);
        }

        let plan = [];
        let planBuildOk = true;
        let planUnmatched = [];
        let planAmbiguous = [];
        let planNoName = [];
        let listScanComplete = false;
        try {
          let listRows = [];
          try {
            listRows = await scanAllRowsByScroll(qa, document, { key: currentCacheKey(), useCache: false }) || [];
          } catch (e) {
            warn('⚠️ 改名：全表扫描失败', e);
            listRows = qa.scanFileRows(document) || [];
          }
          const listHint = getShareFileCount(document);
          /* 「共 N 个文件」是整个分享的口径（含各子目录），只能当上界；
           * 真正的判据是"滚到底且未超时"（scanAllRowsByScroll 记录的 _lastScan） */
          const scrolledToBottom = isLastScanComplete();
          listScanComplete = scrolledToBottom || !listHint || listRows.length >= listHint;
          if (!listScanComplete) {
            warn(` ⚠️ 改名：列表扫描不完整（${listRows.length}/${listHint}），改名计划可能不可靠`);
          }
          log(` ★ 改名：列表共扫到 ${listRows.length} 行用于匹配${listHint ? `（提示 ${listHint}）` : ''}`);

          const savedTotalForSnap = savedByUrl.reduce((n, en) => n + ((en && en.files) || []).length, 0);
          const addedRows = listRows.length - preRows.length;
          let beforeFids = null;
          if (preRows.length && addedRows >= 0 && addedRows <= savedTotalForSnap) {
            beforeFids = new Map(preRows.map(r => [r.fid, String(r.name || '')]));
            log(` ★ 改名：使用转存前快照判定新行（${beforeFids.size} 个 fid，新增 ${addedRows} 行）`);
          } else if (preRows.length) {
            warn(` ⚠️ 改名：转存前 ${preRows.length} 行 / 转存后 ${listRows.length} 行 → 不按快照判定新行`);
          }

          plan = buildRenamePlan(savedByUrl, loadBangumiData(), listRows, savedNamesBefore, beforeFids);
          planUnmatched = plan.unmatched || [];
          planAmbiguous = plan.ambiguous || [];
          planNoName = plan.noName || [];

          /* 目标名被"转存前就存在的旧文件"占着时，改名一定撞重名 → 先删旧文件 */
          if (plan.length) {
            try {
              const purged = await purgeConflictingOldRows(qa, plan, preRows, document);
              if (purged.deleted) {
                log(` 🧹 改名：删除 ${purged.deleted} 个同名旧文件后重建行缓存`);
                try { await scanAllRowsByScroll(qa, document, { key: currentCacheKey(), useCache: false, maxMs: 12000 }); } catch {}
                await sleep(300, true);
              }
            } catch (e) { warn(' ⚠️ 改名：清理同名旧文件失败（继续改名）', e); }
          }
        } catch (e) {
          warn('⚠️ 改名计划构建失败', e);
          planBuildOk = false;
        }
        if (!planBuildOk) {
          qa.setStatus('改名计划构建失败，已暂停下载', 'error');
          warn('⛔ 改名计划构建失败：本轮不下载');
        }

        const savedTotal = savedByUrl.reduce((n, en) => n + ((en && en.files) || []).length, 0);
        if (savedTotal && planUnmatched.length) {
          warn(` ⛔ 改名：${planUnmatched.length} 个已转存文件在列表里没找到对应行：${planUnmatched.join('、')}`);
        }
        if (planAmbiguous.length) warn(` ⚠️ 改名：${planAmbiguous.length} 个文件无法唯一判定：${planAmbiguous.join('、')}`);
        if (planNoName.length) warn(` ⚠️ 改名：${planNoName.length} 个文件清单里没有最终名称：${planNoName.join('、')}`);

        if (plan.length && refreshRes.ok) await waitRowsForRename(qa, plan);
        else if (plan.length) warn(` ★ 改名：未成功刷新，直接在当前列表上尝试改名`);

        let renameReport = { renamed: 0, failed: 0, skipped: 0, pairs: [], confirmed: [], failedEntries: [] };
        let renameStepOk = true;
        if (plan.length) {
          try {
            renameReport = await applyListRenames(qa, plan, { waitMs: refreshRes.ok ? 8000 : 1500 });
          } catch (e) {
            warn('⚠️ 改名过程异常', e);
            renameStepOk = false;
          }

          if (renameReport.renamed > 0) {
            const confirmedWithFid = (renameReport.confirmed || []).filter(c => c && c.fid);
            renameReport.pairs = confirmedWithFid.map(c => ({ fid: c.fid, old: c.old, next: c.next }));
            let wroteCount = 0;
            for (const c of confirmedWithFid) {
              try { if (recordFormerNameByFid(c.fid, c.old)) wroteCount++; } catch (e) { warn('⚠️ 写曾用名异常', e); }
            }
            if (wroteCount) log(` ★ 改名：写入曾用名 ${wroteCount} 条`);
            try {
              const n = refreshDlRecordsAfterRename(qa, renameReport.pairs);
              if (n) log(` ★ 改名：同步 ${n} 条下载记录到新名`);
            } catch (e) { warn('⚠️ 同步下载记录失败', e); }
          }
        }

        const confirmedCount = (renameReport.confirmed || []).length;
        const notConfirmed = (renameReport.failed || 0) + (renameReport.skipped || 0);
        if (plan.length || planUnmatched.length || planAmbiguous.length || planNoName.length) {
          log(`★ 改名结果：按完整名确认 ${confirmedCount} / 应改名 ${plan.length + planUnmatched.length + planAmbiguous.length}`
              + (planNoName.length ? `，清单无名称 ${planNoName.length}` : '')
              + (notConfirmed ? `，本次未确认 ${notConfirmed}` : ''));
        }
        if (planNoName.length) qa.setStatus('注意：有文件清单里没有名称，按原名下载', 'running');

        /* 全部确认条件只看"改名结果本身"：
         *   刷新成功 + 计划构建成功 + 改名步骤成功 + 无未匹配/歧义 + 计划内全部按完整名确认。
         * 行数（waitRes）与列表扫描完整性不再当硬闸门 —— preRows 基线会被"转存前没清掉的旧文件"
         * 污染，虚拟滚动下 count 也不准，拿它们卡关会频繁误报"改名未全部确认"
         * （典型：已确认 1/计划 1，却因 列表行数未达预期 1/2 而中止）。 */
        const renameAllConfirmed = planBuildOk && renameStepOk
        && refreshRes.ok
        && planUnmatched.length === 0
        && planAmbiguous.length === 0
        && (renameReport.failedEntries || []).length === 0
        && confirmedCount >= plan.length;
        renameAllConfirmedOut = renameAllConfirmed;
        hadRenamePlan = plan.length > 0 || planUnmatched.length > 0 || planAmbiguous.length > 0;

        /* 行数/扫描完整性只作提示：不阻塞，但要让人看见 */
        if (renameAllConfirmed && (!waitRes.ok || !listScanComplete)) {
          warn(` ℹ️ 行数校验未通过（${waitRes.count}/${waitRes.expectedMin}，扫描完整=${listScanComplete}），`
               + `但计划内 ${confirmedCount} 个已全部按完整名确认 → 继续下载`);
        }

        await sleep(600, true);

        if (renameAllConfirmed) {
          /* 下载不在桥接里做：交给夸克助手，在挂起门被放行后自己执行 */
          releaseBusy();
          log('★ 刷新/改名已确认，准备放行挂起门（自动下载由夸克助手执行）');
        } else {
          const failedList = (renameReport.failedEntries || []).map(e => `${e.old}（${renameReasonText(e.reason)}）`);
          const failedNames = (renameReport.failedEntries || []).map(e => e.old);
          const allBad = [...new Set([...failedNames, ...planUnmatched, ...planAmbiguous])];
          const reasonLines = [];
          if (!refreshRes.ok) reasonLines.push(`页面内刷新未完成（refreshed=${refreshRes.refreshed}）`);
          if (!waitRes.ok) reasonLines.push(`列表行数未达预期（${waitRes.count}/${waitRes.expectedMin}）`);
          if (!listScanComplete) reasonLines.push('改名期间列表扫描不完整');
          if (!planBuildOk) reasonLines.push('改名计划构建失败');
          if (renameReport.failed) reasonLines.push(`改名步骤失败 ${renameReport.failed} 个`);
          if (renameReport.skipped) reasonLines.push(`列表里找不到 ${renameReport.skipped} 个`);
          warn(`⛔ 改名未全部确认（已确认 ${confirmedCount} / 计划 ${plan.length}，未匹配 ${planUnmatched.length}）`);
          if (failedList.length) warn(`   未确认明细：${failedList.join('；')}`);
          if (reasonLines.length) warn(`   附加原因：${reasonLines.join('；')}`);
          qa.setStatus('改名未确认，已暂停下载', 'error');
          alert(`⚠️ 改名未全部确认，已跳过下载并保持本页。\n\n`
                + `已按完整名（含曾用名）确认：${confirmedCount} / 计划 ${plan.length}\n`
                + (reasonLines.length ? `附加原因：${reasonLines.join('；')}\n` : '')
                + (failedList.length ? `未确认：\n  ${failedList.join('\n  ')}\n` : '')
                + (planUnmatched.length ? `列表里没找到对应行（未改名）：${planUnmatched.join('、')}\n` : '')
                + (planAmbiguous.length ? `无法唯一判定是哪一行：${planAmbiguous.join('、')}\n` : '')
                + (planNoName.length ? `清单里没有最终名称（将按原名下载）：${planNoName.join('、')}\n` : '')
                + (allBad.length ? '\n' : '')
                + `可在文件名上手动改名后，重新点「▶️ 转存」。`);
        }

      } else {
        log('无新转存文件，跳过刷新');
      }
      return { hadPlan: hadRenamePlan, allConfirmed: renameAllConfirmedOut };
    } catch (e) {
      warn('⛔ 转存流程异常，本轮不下载', e);
      qa.setStatus('流程异常，已暂停下载', 'error');
      hadRenamePlan = true;
      renameAllConfirmedOut = false;
      throw e;
    } finally {
      if (renameAllConfirmedOut || !hadRenamePlan) releaseBusy();
      else {
        warn('⛔ 改名未全部确认：保持忙碌标志（本页刷新/跳转后自动解除）');
        markBusyKeptForFailure();
      }
    }
  }

  /* ===== 分享页：手动转存当前页 ===== */
  async function runSaveCurrentPage(qa) {
    await ensureTimeDescSort(qa, document);
    const url = normalizeShareKey(location.href);
    const cacheKey = currentCacheKey();

    let allFiles = (await scanAllRowsByScroll(qa, document, { key: cacheKey, useCache: true }) || []).filter(f => !isFolderFile(f));
    if (!allFiles.length) { alert('当前页无文件（或仅含文件夹）'); return; }

    const expected = getShareFileCount(document);
    if (expected && allFiles.length < expected && !isLastScanComplete()) {
      warn(` ⚠️ 扫描未确认完整（${allFiles.length}/头部 ${expected}），强制重扫一次`);
      await sleep(500, true);
      const retry = (await scanAllRowsByScroll(qa, document, { key: cacheKey, useCache: false, maxMs: 40000 }) || []).filter(f => !isFolderFile(f));
      if (retry.length > allFiles.length) allFiles = retry;
      if (allFiles.length < expected && !isLastScanComplete()) {
        if (!confirm(`⚠️ 扫描仍不完整（${allFiles.length}/头部 ${expected}，可能还没加载完），可能导致漏转存。\n\n继续？`)) return;
      }
    } else if (expected && allFiles.length < expected) {
      warn(` ⚠️ 已扫到底：${allFiles.length} 行 < 头部 ${expected}（头部含文件夹本身/其它目录），按实际继续`);
    }

    const headerState = getHeaderCheckState(document);
    let usingAll, scope;
    if (headerState === 'all' || headerState === 'none' || headerState === 'none-cb') {
      usingAll = true; scope = allFiles;
    } else {
      log(` 表头 partial，滚动收集所有勾选行...`);
      const checkedAll = await scanCheckedRowsByScroll(qa, document, { cacheKey });
      if (!checkedAll.length) { usingAll = true; scope = allFiles; }
      else { usingAll = false; scope = checkedAll; }
    }

    log(`=== 转存当前页 ===`);
    log(` URL: ${url}`);
    log(` 范围: ${usingAll ? `全部 ${allFiles.length} 个` : `勾选 ${scope.length} 个`}`);

    const clearFlagAtStart = Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
    const savedInfos = healShareRecords(url, allFiles);
    const scopeSaved = scope.filter(f => isFileSaved(f, savedInfos));
    const scopePending = scope.filter(f => !isFileSaved(f, savedInfos));
    log(` 已转存跳过 ${scopeSaved.length}`);
    log(` 待转存 ${scopePending.length}`);

    if (usingAll && scope.length > 0 && scopeSaved.length === 0) {
      maybeSaveFullResaveDebug(qa, scope, savedInfos, {
        source: 'save-current-page', clearFlagAtStart,
      });
    }

    if (!scopePending.length) {
      alert(`范围内所有文件都已转存（范围 ${scope.length} 个）\n\n跳过（${scope.length}）：${fmtNames(scope.map(f => f.name))}`);
      refreshShareUI(qa);
      await refreshShareFullCounts(qa);
      return;
    }

    try {
      const okPack = ensurePackDirUnchecked(qa, document);
      log(` ★ "保存为文件夹"：${okPack ? '已取消/无此项' : '取消失败'}`);
    } catch {}

    const batches = [scopePending];
    log(` ★ 转存：单批 ${scopePending.length} 个`);

    const msg =
          `范围：${usingAll ? `全部 ${allFiles.length} 个` : `勾选 ${scope.length} 个`}\n` +
          `转存：${scopePending.length} 个` +
          (usingAll && scopePending.length > 1 ? `（单批全选转存）` : '') + `\n` +
          (scopeSaved.length ? `跳过已转存：${scopeSaved.map(f => f.name).join(', ')}\n` : '') +
          `\n继续？`;
    if (!confirm(msg)) return;

    try {
      const prep = { batches, skipped: scopeSaved, needSave: scopePending, files: allFiles };
      const exec = await executeBatches(qa, document, prep, { useSelectAll: usingAll });
      const savedFiles = exec.savedFiles || [];
      if (savedFiles.length) {
        const recs = loadRecords();
        const prev = recs[url] || {};
        const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
        for (const f of savedFiles) {
          upsertFileInfo(merged, {
            name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
            fid: f.fid || '', mtime: f.mtime || '',
          });
        }
        recs[url] = {
          ...prev, ts: Date.now(), shareId: extractShareId(url),
          fileInfos: merged, names: merged.map(x => x.name),
        };
        saveRecords(recs);
        log(`✅ 已记录 ${merged.length} 条到 ${url}`);
      }
      const summary = describeExec(exec);
      const total = summary.total || scopePending.length;
      const skippedNames = scopeSaved.map(f => f.name);
      const savedNames = savedFiles.map(f => f.name);
      const failedNames = (exec.batchResults || []).filter(b => !b.recorded).flatMap(b => b.names || []);
      let title;
      if (summary.kind === 'success') {
        title = summary.saved < total ? `⚠️ 全部成功（${summary.saved} / ${total}）` : `✅ 全部成功（${summary.saved} / ${total}）`;
      } else if (summary.kind === 'partial') title = `⚠️ 部分成功：${summary.saved} / ${total}`;
      else if (summary.kind === 'fail') {
        if (summary.failedReasons.includes('space')) title = '❌ 空间不足';
        else if (summary.failedReasons.includes('over_limit')) title = '❌ 超过转存限额';
        else if (summary.failedReasons.includes('check-failed') || summary.failedReasons.includes('still-unchecked')) title = '❌ 勾选状态设置失败';
        else title = `❌ 转存失败：${summary.failedReasons.join(', ') || '未知原因'}`;
      } else title = '⚠️ 未执行任何转存';
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
    await refreshShareFullCounts(qa);
  }

  /* ===== 标记 / 清除 ===== */
  async function runMarkFlow(qa) {
    await ensureTimeDescSort(qa, document);
    const url = normalizeShareKey(location.href);
    const cacheKey = currentCacheKey();
    const allFiles = (await scanAllRowsByScroll(qa, document, { key: cacheKey, useCache: true }) || []).filter(f => !isFolderFile(f));
    if (!allFiles.length) { alert('无文件'); return; }
    const headerState = getHeaderCheckState(document);
    let usingAll, scope;
    if (headerState === 'all' || headerState === 'none' || headerState === 'none-cb') {
      usingAll = true; scope = allFiles;
    } else {
      log(` 表头 partial，滚动收集所有勾选行...`);
      const checkedAll = await scanCheckedRowsByScroll(qa, document, { cacheKey });
      if (!checkedAll.length) { usingAll = true; scope = allFiles; }
      else { usingAll = false; scope = checkedAll; }
    }
    const msg = usingAll ? `无勾选，标记全部 ${allFiles.length} 个文件为已转存？` : `标记勾选的 ${scope.length} 个文件为已转存？`;
    if (!confirm(msg)) return;
    const recs = loadRecords();
    const prev = recs[url] || {};
    const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
    let added = 0;
    for (const f of scope) {
      if (upsertFileInfo(merged, {
        name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
        fid: f.fid || '', mtime: f.mtime || '',
      })) added++;
    }
    recs[url] = {
      ...prev, ts: Date.now(), shareId: extractShareId(url),
      fileInfos: merged, names: merged.map(x => x.name), manual: true,
    };
    saveRecords(recs);
    refreshShareUI(qa);
    await refreshShareFullCounts(qa);
    const markedNames = scope.map(f => f.name);
    alert(`✅ 已标记 ${scope.length} 个（新增 ${added}，累计 ${merged.length}）\n\n本次标记（${markedNames.length}）：${fmtNames(markedNames)}`);
  }

  async function runClearShareFlow(qa) {
    await ensureTimeDescSort(qa, document);
    const url = normalizeShareKey(location.href);
    const cacheKey = currentCacheKey();
    const allFiles = (await scanAllRowsByScroll(qa, document, { key: cacheKey, useCache: true }) || []).filter(f => !isFolderFile(f));
    const headerState = getHeaderCheckState(document);
    let usingAll, scope;
    if (headerState === 'all' || headerState === 'none' || headerState === 'none-cb') {
      usingAll = true; scope = allFiles;
    } else {
      log(` 表头 partial，滚动收集所有勾选行...`);
      const checkedAll = await scanCheckedRowsByScroll(qa, document, { cacheKey });
      if (!checkedAll.length) { usingAll = true; scope = allFiles; }
      else { usingAll = false; scope = checkedAll; }
    }
    const recs = loadRecords();
    const rec = recs[url];
    if (!rec) { qa.refreshGray(); await refreshShareFullCounts(qa); alert('当前分享无记录'); return; }
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
    const toRemove = scope.map(f => ({
      name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
      fid: f.fid || '', mtime: f.mtime || '',
    }));
    const hitCount = existing.filter(fi => toRemove.some(tr => isSameFile(tr, fi))).length;
    if (!hitCount) { alert(`勾选的 ${scope.length} 个文件无转存记录`); return; }
    if (!confirm(`从记录中移除 ${hitCount} 个勾选文件？（当前记录共 ${existing.length} 条）`)) return;
    const removedInfos = existing.filter(fi => toRemove.some(tr => isSameFile(tr, fi)));
    const removedNames = removedInfos.map(fi => fi.name);
    const keep = existing.filter(fi => !toRemove.some(tr => isSameFile(tr, fi)));
    if (!keep.length) {
      delete recs[url];
      alert(`🗑️ 已移除 ${hitCount} 个，记录已清空\n\n本次移除（${removedNames.length}）：${fmtNames(removedNames)}`);
    } else {
      recs[url] = { ...rec, ts: Date.now(), fileInfos: keep, names: keep.map(x => x.name) };
      alert(`🗑️ 已移除 ${hitCount} 个（剩余 ${keep.length} 条）\n\n本次移除（${removedNames.length}）：${fmtNames(removedNames)}`);
    }
    saveRecords(recs);
    refreshShareUI(qa);
    await refreshShareFullCounts(qa);
  }

  /* ===== acg.rip 端 ===== */
  function runQuarkAutoTrigger(opts = {}) {
    const { force = false, onlyAired = false } = opts;
    const folderId = getFolderId().trim();
    if (!folderId) return { triggered: false, reason: 'no-folder' };
    const bd = loadBangumiData();
    if (!bd || !Array.isArray(bd.rows)) return { triggered: false, reason: 'no-data' };
    const urls = collectShareUrls(bd, { onlyAired });
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
    log(`触发${onlyAired ? '(已播出)' : ''}：CD 内跳过 ${skippedByCD}，待检查 ${need.length}（共 ${urls.length} 个 URL）`);
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
      if (!overlay.querySelector('#acgrip-quark-section')) {
        const host = overlay.querySelector('#lastTableHost');
        if (host) injectQuarkSection(host);
      }
      injectTriggerQuarkButton();
    };
    /* acg.rip 用 Turbolinks 做页内跳转：document.body 会被整体替换，
     * 挂在 body 上的观察器会随旧 body 一起失效，导致重建后的面板里没有夸克区/转存按钮。
     * 改挂 documentElement（跨跳转稳定）即可跟上主脚本恢复出来的面板。 */
    new MutationObserver(tryInject).observe(document.documentElement || document.body, { childList: true, subtree: true });
    for (const ev of ['turbolinks:load', 'turbolinks:render', 'popstate', 'pageshow']) {
      document.addEventListener(ev, () => { try { tryInject(); } catch (e) { console.error('[Bridge] tryInject', e); } }, true);
    }
    tryInject();
  }

  /* “已播出”按钮可能有多个（不同工具条/不同版本），文本恰为“已播出”的都算锚点 */
  function findAiredButtonAnchors() {
    const anchors = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || !el.isConnected) return;
      if (el.id && el.id.indexOf('acgrip-') === 0) return;
      if (seen.has(el)) return;
      seen.add(el);
      anchors.push(el);
    };
    push(document.getElementById('openAiredResourceBtn'));
    for (const el of document.querySelectorAll('button, a')) {
      const t = (el.textContent || '').replace(/\s+/g, '');
      if (t === '已播出') push(el);
    }
    return anchors;
  }

  function makeQuarkTriggerHandler(onlyAired) {
    return () => {
      try {
        const r = runQuarkAutoTrigger({ force: true, onlyAired });
        if (r && r.triggered) {
          alert(`已打开夸克处理 ${r.count} 个链接${onlyAired ? '（已播出）' : ''}`);
        } else {
          const reasonMap = {
            'no-folder': '未设置夸克文件夹路径', 'no-data': '无 bangumiData',
            'no-urls': onlyAired ? '清单中没有“已播出”且含夸克链接的条目' : '清单中没有夸克链接',
            'all-cd': '所有链接仍在 CD 内',
          };
          alert('未触发：' + (reasonMap[r && r.reason] || (r && r.reason) || '未知原因'));
        }
      } catch (e) { alert('转存触发失败：' + (e && e.message || e)); }
    };
  }

  function injectTriggerQuarkButton() {
    const primary = document.getElementById('openAiredResourceBtn');
    if (!primary) return;
    /* 已注入且锚点未被重建 → 直接返回。
     * 这个方法挂在 MutationObserver 上，编辑表格时 DOM 会高频变动，
     * 不能每次都对整页 button/a 做 querySelectorAll。 */
    const mainExists = document.getElementById('acgrip-trigger-quark-btn');
    const airedExists = document.getElementById('acgrip-trigger-quark-aired-btn');
    if (mainExists && airedExists && airedExists.previousElementSibling === primary) return;

    const anchors = findAiredButtonAnchors();
    if (!anchors.length) return;

    /* ① 原有“立即转存”：仍挂在工具条末尾 */
    const bar = anchors[0].parentElement;
    if (bar && !bar.querySelector('#acgrip-trigger-quark-btn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'acgrip-trigger-quark-btn';
      btn.textContent = '立即转存';
      btn.title = '立即触发夸克转存（忽略 CD）';
      btn.addEventListener('click', makeQuarkTriggerHandler(false));
      bar.appendChild(btn);
    }

    /* ② 每个“已播出”后面各挂一个“立即转存（已播出）” */
    anchors.forEach((anchor, i) => {
      const id = i === 0 ? 'acgrip-trigger-quark-aired-btn' : `acgrip-trigger-quark-aired-btn-${i + 1}`;
      if (document.getElementById(id)) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = id;
      btn.dataset.acgripAired = '1';
      btn.textContent = '立即转存（已播出）';
      btn.title = '立即触发夸克转存：只挑“播出时间已过”的条目（忽略 CD）';
      btn.addEventListener('click', makeQuarkTriggerHandler(true));
      anchor.insertAdjacentElement('afterend', btn);
    });
  }

  function injectQuarkSection(host) {
    const sec = document.createElement('div');
    sec.id = 'acgrip-quark-section';
    sec.style.cssText = 'margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed #3a3a3a;';
    const folder = getFolderId().trim();
    sec.innerHTML = `
 <label><strong>夸克网盘</strong></label>：
 <button type="button" id="resetQuarkCdBtn">重置 CD</button>
 <button type="button" id="triggerQuarkBtn">立即转存</button>
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
      const recs = loadRecords({ consumeClear: false });
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
    try { injectTriggerQuarkButton(); } catch {}
  }

  function registerFullResaveDebugMenu() {
    try {
      GM_registerMenuCommand('🐞 查看全量重转 Debug', () => {
        const arr = loadFullResaveDebug();
        if (!arr.length) { alert('暂无全量重转 Debug'); return; }
        const lines = arr.map((e, i) => {
          const head = `#${i + 1} ${e.time} [${e.source}]`;
          const sum = `文件 ${e.totalFiles}，记录 ${e.savedInfosCount}，记录keys ${e.recordKeysCount}，clearFlag=${e.clearFlag}`;
          const note = e.note || '';
          const first = (e.files || []).slice(0, 3).map(f =>
            `  - ${f.name} (${f.sizeStr || '-'}/${f.mtime || '-'}/${f.fid || '-'}) → ${f.result || ''}`
          ).join('\n');
          return `${head}\n${sum}\n${note}\n${first}`;
        }).join('\n\n');
        alert(lines + '\n\n完整 JSON 见控制台：acgripQuarkBridge.fullResaveDebug()');
      });
      GM_registerMenuCommand('🗑️ 清空全量重转 Debug', () => {
        if (!confirm('清空全量重转 Debug？')) return;
        clearFullResaveDebug();
        alert('已清空');
      });
    } catch {}
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
      GM_registerMenuCommand('🔄 重置夸克检查 CD', () => { gmSet(GM_CD, {}); alert('已重置。'); });
      GM_registerMenuCommand('🗑️ 清空转存记录', () => {
        if (!confirm('清空所有转存记录？')) return;
        GM_setValue(GM_CLEAR_FLAG, Date.now());
        alert('已发送清空请求。');
      });
      GM_registerMenuCommand('📊 查看状态', () => {
        const state = gmGet(GM_CD, {}) || {};
        const recs = loadRecords({ consumeClear: false });
        const pend = gmGet(GM_PENDING_URLS, {}) || {};
        const auto = Number(GM_getValue(GM_AUTO_TRIGGER, 0) || 0);
        alert(
          `转存记录：${Object.keys(recs).length} 条\n` +
          `CD：${Object.keys(state).length} 个 URL\n` +
          `待处理清单：${Array.isArray(pend.urls) ? pend.urls.length : 0} 项\n` +
          `自动触发标记：${auto ? new Date(auto).toLocaleTimeString() : '无'}\n` +
          `全量重转 Debug：${loadFullResaveDebug().length} 条`
        );
      });
    } catch {}
    registerFullResaveDebugMenu();
    setTimeout(() => { try { sweepObsoleteRecords(); } catch (e) { warn('过期清理失败', e); } }, 2000);
    setInterval(() => { try { sweepObsoleteRecords(); } catch (e) { warn('过期清理失败', e); } }, 6 * 60 * 60 * 1000);
    try {
      unsafeWindow.acgripQuarkBridge = {
        version: '1.4.0',
        trigger: (opts = {}) => runQuarkAutoTrigger({ force: opts.force !== false }),
        status: () => {
          const state = gmGet(GM_CD, {}) || {};
          const recs = loadRecords({ consumeClear: false });
          const pend = gmGet(GM_PENDING_URLS, {}) || {};
          return {
            cd: Object.keys(state).length,
            saved: Object.keys(recs).length,
            pending: Array.isArray(pend.urls) ? pend.urls.length : 0,
            fullResaveDebug: loadFullResaveDebug().length,
          };
        },
        fullResaveDebug: () => loadFullResaveDebug(),
        clearFullResaveDebug: () => clearFullResaveDebug(),
      };
    } catch (e) { warn('暴露 acgripQuarkBridge 失败', e); }
    log('已启动（acg.rip 端）');
  }

  /* ===== 夸克端入口 ===== */
  async function waitForQA(timeout = 10000) {
    return await until(() => {
      const qa = unsafeWindow.quarkAssistant;
      return qa && qa.isReady && qa.isReady() ? qa : null;
    }, 150, timeout);
  }

  function isQAVersionOk(qa) {
    const ver = String((qa && qa.version) || '');
    const m = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return { ok: false, ver, reason: 'cannot-parse' };
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const [ra, rb, rc] = MIN_QA_VERSION;
    if (a > ra) return { ok: true, ver };
    if (a < ra) return { ok: false, ver, reason: `需要 ≥${ra}.${rb}.${rc}` };
    if (b > rb) return { ok: true, ver };
    if (b < rb) return { ok: false, ver, reason: `需要 ≥${ra}.${rb}.${rc}` };
    if (c >= rc) return { ok: true, ver };
    return { ok: false, ver, reason: `需要 ≥${ra}.${rb}.${rc}` };
  }

  /* ===== 挂起门（夸克助手 unsafeWindow 上的内存标记，不落盘） ===== */
  function getGate() {
    try {
      const qa = unsafeWindow.quarkAssistant;
      const g = (qa && qa.gate) || unsafeWindow[GATE_KEY];
      if (g && typeof g.waitReady === 'function' && typeof g.release === 'function') return g;
    } catch {}
    return null;
  }

  /* 声明"本次是 acg 唤起"：写 sessionStorage（同标签页共享） + 通知门 */
  function markAcgInvoked(tag) {
    try { sessionStorage.setItem(ACG_FLAG_KEY, '1'); } catch {}
    const g = getGate();
    if (g) { try { g.attach(tag); } catch (e) { warn('门 attach 失败', e); } }
    return g;
  }

  /* 步骤 3：等夸克助手挂起（清理完成）标记 */
  async function waitGateReady(tag) {
    const g = getGate();
    if (!g) {
      warn(`⛔ [${tag}] 夸克助手未提供挂起门（需要 QuarkAutoAssistant ≥${MIN_QA_VERSION.join('.')}）`);
      return { ok: false, reason: 'gate-missing', gate: null };
    }
    const verCheck = isQAVersionOk(unsafeWindow.quarkAssistant);
    if (!verCheck.ok) {
      warn(`⛔ [${tag}] 夸克助手版本过低：${verCheck.ver}（${verCheck.reason}）`);
      return { ok: false, reason: 'version-too-old', gate: g };
    }
    try { g.attach(tag); } catch {}
    warn(`★ [${tag}] 等待挂起标记（清理完成）...`);
    const t0 = Date.now();
    const st = await g.waitReady(GATE_WAIT_MS);
    if (!st) {
      warn(`⛔ [${tag}] 等待挂起标记超时（${Math.round((Date.now() - t0) / 1000)}s）`);
      return { ok: false, reason: 'gate-timeout', gate: g };
    }
    warn(`★ [${tag}] 挂起门：state=${st.state}，round=${st.round}，note=${st.note || '-'}` +
         `（等待 ${Math.round((Date.now() - t0) / 1000)}s）`);
    if (st.state !== 'ready') return { ok: false, reason: 'gate-' + st.state, gate: g, snap: st };
    if (st.cleanup && st.cleanup.ok !== true) {
      warn(`⛔ [${tag}] 挂起门是"降级放行"（清理未完成：${st.cleanup.reason || '?'}），不打开子任务`);
      return { ok: false, reason: 'gate-degraded', gate: g, snap: st };
    }
    return { ok: true, gate: g, snap: st };
  }

  let _autoRunning = false;
  async function handleAutoTriggerIfAny(qa) {
    if (_autoRunning) { log('自动触发：已有任务在跑，跳过'); return false; }
    const autoTs = Number(GM_getValue(GM_AUTO_TRIGGER, 0) || 0);
    if (!(autoTs > 0)) return false;
    if ((Date.now() - autoTs) >= AUTO_TTL) { log('自动触发：标记已过期，跳过'); return false; }
    _autoRunning = true;
    try {
      const ts2 = Number(GM_getValue(GM_AUTO_TRIGGER, 0) || 0);
      if (ts2 !== autoTs) { log('自动触发：已被其他标签页消费，跳过'); return false; }
      /* 步骤 2：夸克端开始，清理标识 */
      GM_setValue(GM_AUTO_TRIGGER, 0);
      markAcgInvoked('auto-trigger');
      warn('★ 自动触发：开始处理（已消费标记）');

      if (qa.isPaused && qa.isPaused()) {
        warn('⏸ 自动任务：暂停中，关闭页面');
        try { const g = getGate(); g && g.abort('paused'); } catch {}
        setTimeout(() => { try { window.close(); } catch {} }, 300);
        return true;
      }

      const pack = gmGet(GM_PENDING_URLS, null);
      const urls = (pack && Array.isArray(pack.urls)) ? pack.urls : null;
      if (!urls || !urls.length) {
        warn('自动触发但 pending_urls 为空，跳过');
        try { const g = getGate(); g && g.abort('no-urls'); } catch {}
        return true;
      }

      /* 步骤 3：等 QA 挂起标记 */
      const wg = await waitGateReady('auto-trigger');
      if (!wg.ok) {
        warn(`⛔ 挂起门未就绪（${wg.reason}），本轮不打开子任务`);
        try { qa.setStatus && qa.setStatus(`清理未就绪(${wg.reason})`, 'error'); } catch {}
        if (wg.gate) { try { wg.gate.abort(wg.reason); } catch {} }
        return true;
      }

      /* 步骤 4：依次执行子任务（个人页在此等待） */
      warn(`★ 开始 ${urls.length} 个链接的子任务`);
      let flow = null;
      try { flow = await runSaveAllFlow(qa, urls); }
      catch (e) { warn('自动转存流程异常', e); }

      /* 步骤 6：移除 QA 挂起标志 */
      const g = wg.gate;
      if (flow && flow.allConfirmed === true) {
        warn('★ 子任务完成（含刷新/改名确认），放行挂起门 → 夸克助手执行自动下载');
        releaseBusy();
        try { g.release({ source: 'acg-trigger', urls: urls.length }); } catch (e) { warn('release 失败', e); }
        return true;
      }
      warn('⛔ 未确认子任务完成，保持本页（不放行挂起门）');
      releaseBusy();
      try { g.abort((flow && flow.reason) || 'flow-unconfirmed'); } catch {}
      return true;
    } finally {
      _autoRunning = false;
    }
  }

  /* 桥接端 collectApiLinks：修复 filename=+（复用 QA 的修复函数） */
  async function collectApiLinksBridge(qa, timeout = 15000) {
    const fix = (qa && typeof qa.fixFilenamePlusInUrl === 'function')
      ? qa.fixFilenamePlusInUrl
      : (u => u);
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
    return [...popup.querySelectorAll('.listener-link-api')].map(a => {
      const original = a.dataset.link || '';
      const fixed = fix(original);
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

  async function initQuarkSide() {
    cleanupBridgeComm();
    const qa = await waitForQA();
    if (!qa) { warn('quarkAssistant 未就绪'); return; }
    log('quarkAssistant 就绪 v' + qa.version);

    registerFullResaveDebugMenu();

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
      startSharePolling(qa);
      ensureTimeDescSort(qa, document).then(async (r) => {
        log(`★ 分享页初始化排序结果：${JSON.stringify(r)}`);
        if (r && r.ok && r.method !== 'already') {
          await until(() => !isShareTableLoading(document), 150, 15000);
          refreshShareUI(qa);
        }
      });
      (async () => {
        await until(() => !isShareTableLoading(document), 150, 20000);
        refreshShareUI(qa);
        log(`★ 分享页初始化（可见区）：扫描 ${qa.scanFileRows(document).length}`);
      })();
      log(`★ 分享页初始化（等待用户操作 / 子任务触发）`);
      watchChildTaskWhileIdle(qa);
    } else if (isList) {
      qa.setActions([
        {
          label: '▶️ 转存', color: '#09AAFF',
          title: '等夸克助手清理完成（挂起门就绪）后，逐条转存；刷新后按 acg 名称+原始文件名改名；确认后放行挂起门',
          onclick: async () => {
            warn('★ [manual-trigger] 用户点击「▶️ 转存」，先等挂起门就绪');
            markAcgInvoked('manual-trigger');
            const wg = await waitGateReady('manual-trigger');
            if (!wg.ok) {
              alert(`清理未就绪：${wg.reason}\n请检查控制台 [桥接]/[夸克助手] 日志。`);
              return;
            }
            let flow = null;
            try { flow = await runSaveAllFlow(qa, null); }
            catch (e) { warn('⚠️ [manual-trigger] 转存异常', e); }
            const g = wg.gate;
            if (flow && flow.allConfirmed === true) {
              releaseBusy();
              try { g.release({ source: 'manual-trigger' }); } catch {}
            } else {
              releaseBusy();
              try { g.abort((flow && flow.reason) || 'manual-unconfirmed'); } catch {}
            }
          },
        },
        // {
        //   label: '🏷️ 测试改名', color: '#da9328',
        //   title: '对当前可见的第一个文件试改名（用 acg名称+原始文件名 的新格式）',
        //   onclick: () => runRenameSmokeTest(qa),
        // },
        // {
        //   label: '🔍 改名诊断', color: '#8c8c8c',
        //   title: '只报告改名入口的 DOM/按钮/勾选状态，不改动任何文件',
        //   onclick: () => runRenameDiagnose(qa),
        // },
      ]);
      qa.setStatus('待机（个人页）');
      try {
        GM_addValueChangeListener(GM_AUTO_TRIGGER, (name, oldVal, newVal, remote) => {
          if (!remote) return;
          const ts = Number(newVal) || 0;
          if (ts <= 0) return;
          if (Date.now() - ts > AUTO_TTL) return;
          setTimeout(() => {
            handleAutoTriggerIfAny(qa).catch(e => warn('自动触发处理异常', e));
          }, 500);
        });
        log('已注册 GM_AUTO_TRIGGER 监听（跨标签页即时触发）');
      } catch (e) { warn('注册 GM_AUTO_TRIGGER 监听失败', e); }
      await handleAutoTriggerIfAny(qa);
    }
    log('已启动（夸克端）');
  }

  if (IS_QUARK) initQuarkSide();
  else if (IS_ACGRIP) initAcgRipSide();
})();