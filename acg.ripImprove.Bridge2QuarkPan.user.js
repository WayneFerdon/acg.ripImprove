// ==UserScript==
// @name acg.ripImprove.Bridge2QuarkPan
// @namespace http://tampermonkey.net/
// @version 3.3.0
// @description acg.rip 桥接：夸克转存业务编排（全表一次滚动 + 内存缓存；单行定位优先可见区 + 估计位置；表头状态快速返回；记录不按时间过期，过期只依据 acg.rip 清单；转存刷新后按 acg 最终名称改名 [bgm]名称[bgm]原始文件名）
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
  const BUSY_KEY = 'acgrip_bridge_busy';
  /* 夸克助手的历史键：改名后同步记录用（失败不影响主流程） */
  const GM_DL_RECORDS = 'quark_auto_dl_records';
  const GM_QRECORDS = 'quark_download_records';

  const TASK_TTL = 3 * 60 * 1000;
  const TAB_RESULT_TIMEOUT = 90 * 1000;

  /* 转存记录不按时间过期，是否过期只依据 acg.ripImprove 清单（sweepObsoleteRecords）。 */
  const BASE_CD = 30 * 60 * 1000;
  const MAX_CD = 7 * 24 * 60 * 60 * 1000;
  const AUTO_TTL = 5 * 60 * 1000;

  const log = (...a) => console.log('[桥接]', ...a);
  const warn = (...a) => console.warn('[桥接]', ...a);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* 桥接忙碌标志：夸克助手的 boot 自动下载据此跳过。
   * 必须一直持有到"转存 → 刷新 → 改名"全部结束（改名完成前放开会让下载抢跑，
   * 落盘文件名就还是原始名），所以只在流程 finally 里释放。*/
  function acquireBusy() { try { sessionStorage.setItem(BUSY_KEY, '1'); } catch {} }
  function releaseBusy() { try { sessionStorage.removeItem(BUSY_KEY); } catch {} }

  async function until(fn, delay = 200, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = await fn();
      if (r) return r;
      await sleep(delay);
    }
    return null;
  }

  /* 直接存原生类型；读取时兼容旧的 JSON 字符串 */
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

  /* 规范化文件大小：去空白、统一单位大小写，占位符视为未知 */
  function normalizeSizeStr(s) {
    const t = String(s ?? '').trim();
    if (!t) return '';
    // 表格未加载完的占位符
    if (t === '--' || t === '-' || t === '—' || /^未知|loading/i.test(t)) return '';
    // 去掉内部空白："1.5 GB" 变 "1.5GB"
    return t.replace(/\s+/g, '').toUpperCase();
  }

  /* ===== 文件名标识符（改名标记）=====
   * 改名后的文件名形如：[bgm]acg最终名称[bgm]原始文件名
   * 桥接脚本与夸克脚本比对文件名时，一律排除两个标识符及其之间的文本
   * （即只拿"原始文件名"部分比对）。*/
  const FILE_NAME_MARKER = '[bgm]';

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* 标识符块（非贪婪、忽略大小写；不配对则不动）。
   * 大小写不敏感：文件系统本身不区分，`[BGM]` 视为同一标识符。*/
  function getFileNameMarkerRe() {
    return new RegExp(`${escapeRegExp(FILE_NAME_MARKER)}[\\s\\S]*?${escapeRegExp(FILE_NAME_MARKER)}`, 'gi');
  }

  /* 去掉零宽字符 + 排除所有标识符块 */
  function sanitizeFileName(s) {
    return String(s ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(getFileNameMarkerRe(), '')
    .trim();
  }

  /* 规范化文件名：去零宽字符 + 排除两个标识符及其之间的文本 + trim */
  function normalizeFileName(s) {
    return sanitizeFileName(s);
  }

  /* 去掉标识符块后是否已为空（仅剩标识符时视为空名） */
  function isBlankFileName(s) {
    return !sanitizeFileName(s);
  }

  /* 比对用文件名（唯一入口）：排除两个标识符及其之间的文本 */
  function getComparableFileName(s) {
    return normalizeFileName(s);
  }

  /* 只剥"开头连续出现的标识符块"，保留其余空白与字符（零宽字符顺带清掉）。
   * 循环剥离：`[bgm]a[bgm][bgm]b[bgm]01.mp4` 这类叠加残留能一次还原成 `01.mp4`，
   * 否则每次运行都会再判"需要改名"，把标识符越叠越多。*/
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

  /* 目标改名后应有的完整文件名。
   * 夸克行内输入框 maxlength=250，超长会**静默不改**，所以这里主动把 acg 名称截短到能放下
   * （原始文件名一字不动），并在截短时返回 truncated 让调用方告警。*/
  function fitAcgName(acgName, originalName, maxBytes = 250) {
    const base = String(originalName ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
    const nm = String(acgName ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(new RegExp(escapeRegExp(FILE_NAME_MARKER), 'g'), '')
    .replace(/\s+/g, ' ')
    .trim();
    if (!base || !nm) return { name: '', truncated: false };

    const build = s => `${FILE_NAME_MARKER}${s}${FILE_NAME_MARKER}${base}`;
    const bytes = s => { try { return new TextEncoder().encode(s).length; } catch { return s.length * 3; } };

    const full = build(nm);
    if (bytes(full) <= maxBytes) return { name: full, truncated: false };

    /* 二分找最长的可放前缀（按码点推进，避免切坏代理对） */
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

  /* 是否需要改名。
   * 入参约定：currentName = 列表页当前名（可能已带标识符块）；acgName = 纯 acg 名称（不含标识符块）。
   * 不能拿"当前名"与"acg 名称"各自归一化后比较 —— 当前名带块时的归一化结果与裸 acg 名称无关；
   * 正确做法：把当前名开头已有的标识符块剥掉还原出原始文件名，按目标格式重建后再与原样当前名比较。
   * 返回 true 表示"当前名（原样）与目标名不同"，调用方应把 currentName 原样作为 old 传给列表页定位。*/
  function needRename(currentName, acgName) {
    const raw = String(currentName ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const target = buildRenamedFileName(acgName, stripMarkerBlock(raw).trim());
    if (!raw || !target) return false;
    return raw !== target;
  }

  function isSameFile(a, b) {
    if (!a || !b) return false;
    if (normalizeFileName(a.name) !== normalizeFileName(b.name)) return false;

    const sa = normalizeSizeStr(a.sizeStr);
    const sb = normalizeSizeStr(b.sizeStr);

    // 任一方大小未知（未加载 / 占位符）：仅凭文件名视为相同
    if (!sa || !sb) return true;

    if (sa === sb) return true;

    // 兜底：iconSig 一致且都存在时也算相同（个别大小格式可能不同）
    const ia = String(a.iconSig ?? '').trim();
    const ib = String(b.iconSig ?? '').trim();
    if (ia && ib && ia === ib) return true;

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
  function currentCacheKey() {
    return extractShareId(location.href) || 'default';
  }

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

  /* ===== 转存记录：读取路径永不删数据，删除只发生在显式 sweep / 用户清空 ===== */
  function loadRecords() {
    /* 用户显式清空请求（acg.rip 菜单命令） */
    const clearTs = Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
    if (clearTs > 0) {
      gmSet(GM_RECORDS, {});
      GM_setValue(GM_CLEAR_FLAG, 0);
      log(`★ 响应清空请求，转存记录已清空（ts=${clearTs}）`);
      return {};
    }
    return gmGet(GM_RECORDS, {}) || {};
  }
  function saveRecords(recs) { gmSet(GM_RECORDS, recs); }

  /* 未被显式清空的记录一律算"已转存"；是否过期只依据 acg.ripImprove 清单。 */
  function collectSavedInfos(records) {
    return Object.values(records || {})
    .flatMap(r => Array.isArray(r.fileInfos) ? r.fileInfos : []);
  }

  /* 从 bangumiData 收集"清单里仍存在"的分享 key。
   * 故意不做播出日期过滤，否则未播出条目的记录会被误判为已从清单移除。 */
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

  /* ===== acg 名称数据（最终名称：中文 > 原始名称）=====
   * 桥接不读 acg.ripImprove 的内部函数，只按同一优先级自行解析：
   * 「中文」列非空取中文，否则取「名称」列（两列为空时回退 BGMID 内嵌的 名称,中文）。*/
  function getAcgDisplayName(row) {
    if (!row) return '';
    const pick = v => {
      const s = String(v ?? '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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

  /* 从 BGMID 文本里取兜底名称（id,名称,中文,…） */
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

  /* 每行可能带多个夸克链接（资源 + 规则，且 @ / @@ 会展开成集数）。
   * 一行内所有展开结果都指向同一个作品 → 一律取该行的最终名称。*/
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

  /* shareKey → acg 最终名称。
   * 同一 key 出现多个不同名称（同名作品 / 复用链接，无法判定）→ 该 key 不改名。*/
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

  /* 从当前页地址推 key（与记录 key 同源：https://pan.quark.cn/s/<shareId>） */
  function shareKeyFromUrl(url) {
    const m = String(url || '').match(/\/s\/([a-zA-Z0-9]+)/);
    return m ? `https://pan.quark.cn/s/${m[1]}` : '';
  }

  /* 清理过期记录：只依据 acg.ripImprove 清单，清单里已不存在的分享即过期。
   * 清单不可用或解析不到链接时一律不动（宁可不清，也不误删）。 */
  function sweepObsoleteRecords() {
    const bd = loadBangumiData();
    if (!bd || !Array.isArray(bd.rows) || !bd.rows.length) {
      log('★ 过期清理：acg.ripImprove 数据不可用，跳过（不删除任何记录）');
      return 0;
    }
    const live = collectAllShareKeys(bd);
    if (!live.size) {
      log('★ 过期清理：清单中未解析到任何夸克链接，跳过（不删除任何记录）');
      return 0;
    }
    const recs = gmGet(GM_RECORDS, {}) || {};
    const dead = Object.keys(recs).filter(k => !live.has(normalizeShareKey(k)));
    if (!dead.length) {
      log(`★ 过期清理：${Object.keys(recs).length} 条记录均在清单中，无需清理`);
      return 0;
    }
    for (const k of dead) delete recs[k];
    gmSet(GM_RECORDS, recs);
    log(`★ 过期清理：移除 ${dead.length} 条已不在 acg.ripImprove 清单中的转存记录`
      + `（保留 ${Object.keys(recs).length} 条）`);
    return dead.length;
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

  /* ===== 全表缓存（避免反复滚动） ===== */
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

  /* ===== 虚拟滚动支持 ===== */
  function getTableBody(doc = document) {
    return doc.querySelector('.ant-table-body');
  }
  /* 分享页表格是否仍在初始化加载（首屏 spin / 内容模糊） */
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

  /* 滚动遍历：有 loading tr 才多等，否则不空耗；harvest 总是覆盖最新状态 */
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

    if (isShareTableLoading(doc)) {
      log(` ⏳ 检测到表格仍在初始化加载，等待...`);
      await until(() => !isShareTableLoading(doc), 150, 15000);
    }

    const body = getTableBody(doc);
    if (!body || !isVirtualScrolling(body)) {
      const rows = qa.scanFileRows(doc);
      if (useCache && key) setAllFilesCache(key, rows);
      return rows;
    }

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

    /* 滚到顶部 */
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
        /* 到底：按 loading 状态决定等待时长 */
        if (hasLoadingMore()) {
          // 有加载中：等它消失（最多 1500ms）
          await qa.until(() => !hasLoadingMore(), 60, 1500);
        } else {
          // 无加载中：只等 100ms，没有新内容就认到底
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

      /* 未到底：向下滚一屏（0.8 倍视口，保证约 20% 重叠） */
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

  /* 滚动收集所有被勾选的行（partial 场景用） */
  async function scanCheckedRowsByScroll(qa, doc = document, opts = {}) {
    const cacheKey = opts.cacheKey || null;
    const body = getTableBody(doc);
    if (!body || !isVirtualScrolling(body)) {
      return qa.scanFileRows(doc).filter(f => f.checked);
    }
    const all = await scanAllRowsByScroll(qa, doc, { key: cacheKey, useCache: false });
    return all.filter(f => f.checked);
  }

  /* 滚动定位单行：可见区优先，其次按缓存 index 估计位置就近扫，最后上下顺序扫 */
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

  /* ===== 分享页置灰 + 进度（由桥接自主维护） ===== */
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
    /* 加载中不刷：避免虚表空行被误判未转存 */
    if (isShareTableLoading(doc)) return;

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

      await sleep(80);
      if (getHeaderCheckState(doc) === 'none') return { ok: true, tries: i + 1 };
    }
    return { ok: getHeaderCheckState(doc) === 'none', reason: 'not-cleared' };
  }

  /* ===== 列表页改名（按 acg 最终名称）=====
   * 时序：转存完成 → 页面内刷新 → ★ 改名 → 触发下载。
   * 已下载记录按 fid 记录，改名不换 fid，因此改名后仍不会重复下载。*/

  const RENAME_CONFIRM_TEXTS = ['确定', '确认', '保存', '完成', '确 定'];

  function isRenamePanel(el) {
    try {
      return !!(el && el.closest && (el.closest('#quark-auto-panel') || el.closest('#quark-share-progress')));
    } catch { return false; }
  }

  /* 行名按"排除标识符后"比对：既能找到 [bgm]名[bgm]原始名，也能找到原始名 */
  function findListRowByName(qa, name, doc = document) {
    const want = getComparableFileName(name);
    if (!want) return null;
    const files = qa.scanFileRows(doc) || [];
    return files.find(f => getComparableFileName(f.name) === want) || null;
  }

  /* 原样名精确比对（**不能**用 findListRowByName 做改名确认）：
   * 它的比较键会把 [bgm]…[bgm] 剥掉，导致"改名后的新名"与"改名前的旧名"键相等，
   * 于是"看见新名"永远为真 —— 那是同义反复，会把没改成的也判成功。*/
  function findRowByExactName(qa, name, doc = document) {
    const want = String(name ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!want) return null;
    const files = qa.scanFileRows(doc) || [];
    return files.find(f => String(f.name ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() === want) || null;
  }

  /* 行内用来触发重命名/右键的元素（scanFileRows 只给 row，没有 nameEl） */
  function getNameElInRow(row) {
    if (!row || typeof row.querySelector !== 'function') return null;
    return row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]') || row;
  }

  /* 只点真正的文件名单元格（返回 null 表示拿不到，调用方不要退回整行） */
  function getNameCellOnly(row) {
    if (!row || typeof row.querySelector !== 'function') return null;
    return row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
  }

  /* 当前渲染出来的选中行 fid */
  function getSelectedFids(doc = document) {
    return [...doc.querySelectorAll('tr.ant-table-row-selected')]
    .map(r => r.getAttribute('data-row-key') || '')
    .filter(Boolean);
  }

  function findRowByFid(fid, doc = document) {
    if (!fid) return null;
    return doc.querySelector(`tr.ant-table-row[data-row-key="${fid}"]`);
  }

  /* 把勾选收敛到目标一行。
   * 夸克助手没有导出 selectRow，这里直接点该行的 checkbox label；
   * 最后用表头三态复核：只有确定"当前只剩这一行被勾选"时才允许走顶栏按钮路径
   * （虚拟滚动下看不到的行也可能被勾选，看不见就一律不点按钮，避免批量重命名）。*/
  async function resetSelectionToRow(qa, file, doc = document) {
    if (!file || !file.fid) return { ok: false, reason: 'no-fid' };
    try { await qa.clearAllSelection(); } catch {}

    let row = (file.row && file.row.isConnected) ? file.row : findRowByFid(file.fid, doc);
    if (!row) return { ok: false, reason: 'row-gone' };

    const isSel = () => {
      const cur = findRowByFid(file.fid, doc) || row;
      const input = cur && cur.querySelector('input.ant-checkbox-input');
      return !!(cur && (cur.classList.contains('ant-table-row-selected') || (input && input.checked)));
    };
    if (!isSel()) {
      const lbl = row.querySelector('label.ant-checkbox-wrapper');
      if (lbl) { try { qa.realClick(lbl); } catch {} }
      else { try { const cb = row.querySelector('input.ant-checkbox-input'); if (cb) cb.click(); } catch {} }
      await until(isSel, 100, 1500);
    }

    const state = getHeaderCheckState(doc);
    const fids = getSelectedFids(doc);
    if (state !== 'partial' || fids.length !== 1 || fids[0] !== file.fid) {
      return { ok: false, reason: `${state}/${fids.length}` };
    }
    return { ok: true };
  }

  /* 打开改名入口：优先行内编辑（夸克真实实现），其次"重命名"按钮弹窗。
   * 返回 input 元素（行内编辑）或弹窗元素（modal），两者都用 querySelector 取输入框。*/
  async function openRenameDialog(qa, row, nameCell, originalName, doc = document) {
    if (!row || !row.isConnected) {
      const fresh = findListRowByName(qa, originalName, doc);
      row = fresh && fresh.row;
      if (!nameCell || !nameCell.isConnected) nameCell = getNameElInRow(row);
    }
    if (!row || !row.isConnected) { warn(` ⚠️ 改名：列表里找不到该行 —— ${originalName}`); return null; }

    /* ① 行内编辑：点文件名单元格原地改（DOM 实测路径）。
     * 先把勾选收敛到这一行：用户实测里"正在被编辑的那行"同时带 ant-table-row-selected，
     * 所以不要清空勾选就点名字。*/
    const file = findListRowByName(qa, originalName, doc);
    if (file && file.fid) {
      const sel = await resetSelectionToRow(qa, file, doc);
      if (!sel.ok) warn(` ⚠️ 改名：勾选收敛未达预期（${sel.reason}），行内编辑可能不生效`);
      row = file.row;
      nameCell = getNameCellOnly(file.row) || nameCell;
    }

    const inline = await openInlineRename(qa, nameCell, originalName, doc);
    if (inline) return inline;

    /* ② 顶栏「重命名」按钮：**故意不自动点**。
     * 夸克该按钮作用于"所有被勾选的行"，而列表是虚拟滚动：看不见的行也可能处于勾选状态，
     * clearAllSelection 只能清掉渲染出来的行 → 无法证明"当前只勾选了目标行"，
     * 一旦点下去就是跨屏批量重命名（不可逆）。用户实测的可用路径是行内编辑（①），
     * 所以这里只记日志提示，绝不代点。*/
    log(`   ↳ 行内编辑没打开；顶栏「重命名」按钮需要手动单选后再点（自动点有批量改名风险，已跳过）`);

    /* ③ 悬停操作条的"更多"菜单里可能藏着重命名。
     * 只在目标行**确实有** .hoitem-more 时才走这条路，且菜单项只认"点击后新出现的下拉"，
     * 避免命中页面上其它残留的菜单把新名写到别的文件上。*/
    try {
      if (row && row.isConnected) {
        const closer = row.closest('.filename') || row;
        dispatchHover(qa, getNameElInRow(row));
        const more = await untilVisibleMatch(1200, /.*/, '.hoitem-more, .hover-oper-item.ant-dropdown-trigger', closer);
        if (!more) {
          log('   ↳ 悬停条里没有「更多」入口，跳过菜单路径');
        } else {
          const before = new Set([...doc.querySelectorAll('.ant-dropdown, .ant-dropdown-menu, .ant-menu')]);
          try { qa.realClick(more); } catch {}
          const fresh = [...doc.querySelectorAll('.ant-dropdown, .ant-dropdown-menu, .ant-menu')]
          .filter(el => !before.has(el) && _isVisible(el));
          let item = null;
          const t0 = Date.now();
          while (!item && Date.now() - t0 < 1500) {
            for (const menu of fresh) {
              for (const el of menu.querySelectorAll('li, .ant-dropdown-menu-item, [role="menuitem"]')) {
                const txt = (el.textContent || '').replace(/\s+/g, '').trim();
                if (/^重命名$|^重新命名$|^改名$/.test(txt)) { item = el; break; }
              }
              if (item) break;
            }
            if (!item) await sleep(120);
          }
          if (item) {
            log(' → 改名：点击菜单里的「重命名」');
            qa.realClick(item.closest('li') || item);
            const dlg = await waitRenameDialog(originalName, doc, 2000);
            if (dlg) return dlg;
          } else {
            log('   ↳ 新出现的菜单里没有「重命名」，关闭菜单');
            try { pressKeyOn(more, 'Escape'); } catch {}
          }
        }
      }
    } catch (e) { warn(' ⚠️ 改名：菜单路径异常', e); }

    return null;
  }

  /* 在 [0, timeout] 内轮询匹配可见元素（默认只扫菜单项类元素，避免误点页面导航里的 li） */
  async function untilVisibleMatch(timeout, re, selector = 'li, .ant-dropdown-menu-item, [role="menuitem"], .ant-menu-item, .ant-modal-footer button, .ant-drawer button', scope = document) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      for (const el of scope.querySelectorAll(selector)) {
        if (isRenamePanel(el) || !_isVisible(el)) continue;
        const txt = (el.textContent || '').replace(/\s+/g, '').trim();
        if (re.test(txt)) return el;
      }
      await sleep(120);
    }
    return null;
  }

  /* ===== 行内改名（夸克真实实现）=====
   * 文件名单元格：`<div class="filename-text editable-cell editable-cell-allow" title="原名">原名</div>`
   * 点它 → 原地变成 `<input class="ant-input input-edit" maxlength="250" value="原名">`（无弹窗）。
   * 输入新名后按 Enter 或失焦提交。*/

  function findInlineRenameInput(originalName = '', doc = document) {
    const want = getComparableFileName(originalName);
    const inputs = [...doc.querySelectorAll('input.input-edit, input.ant-input.input-edit, .filename input.ant-input')]
    .filter(i => !isRenamePanel(i) && i.isConnected && _isVisible(i));
    if (!inputs.length) return null;
    if (!originalName) return inputs[0];
    const exact = inputs.find(i => String(i.value ?? '') === originalName);
    if (exact) return exact;
    return inputs.find(i => getComparableFileName(i.value) === want) || null;
  }

  /* 行内编辑是否还开着：绑定到具体元素 + 可见性判断（不要用"全文还有没有 input-edit"） */
  function isEditorOpen(input) {
    return !!(input && input.isConnected && _isVisible(input));
  }

  /* 点开行内编辑：单击 → 两次点击 → F2，每一步都记日志，便于真机定位。
   * 不用 dblclick：夸克列表页双击文件名会打开/预览文件（mp4 会拉播放器）。*/
  async function openInlineRename(qa, nameCell, originalName, doc = document) {
    if (!nameCell || !nameCell.isConnected) {
      const row = (findListRowByName(qa, originalName, doc) || {}).row;
      /* 只取真正的文件名单元格：getNameElInRow 会兜底返回整行，点整行会打开/选中文件 */
      nameCell = getNameCellOnly(row);
    }
    if (!nameCell || !nameCell.isConnected) {
      warn(` ⚠️ 改名：拿不到文件名单元格 —— ${originalName}`);
      return null;
    }

    const row = nameCell.closest('tr');
    log(` 改名·目标单元格：<${nameCell.tagName.toLowerCase()} class="${nameCell.className}"> text="${(nameCell.textContent || '').trim().slice(0, 40)}"`
      + ` | 行选中=${!!(row && row.classList.contains('ant-table-row-selected'))}`
      + ` 可编辑=${nameCell.classList.contains('editable-cell-allow') || nameCell.classList.contains('editable-cell')}`);

    /* 鼠标先移到该行，让 hover-oper 就位（不改变勾选） */
    try { dispatchHover(qa, nameCell); } catch {}

    /* 手势顺序：单击 → 两次点击（选中后进入编辑）→ F2 → Enter（Enter 放最后，副作用最大）。
     * 不用 dblclick：夸克列表页双击文件名会打开/预览文件（mp4 会拉播放器）。*/
    for (const how of ['click', 'slowclick', 'f2', 'enterkey']) {
      try {
        if (how === 'click') qa.realClick(nameCell);
        else if (how === 'slowclick') {
          qa.realClick(nameCell);
          await sleep(600);
          if (!isEditorOpen(findInlineRenameInput(originalName, doc))) {
            if (!nameCell.isConnected) {
              const fresh = findListRowByName(qa, originalName, doc);
              const el = fresh ? getNameCellOnly(fresh.row) : null;
              /* 只点真正的文件名单元格；坚决不退回整行（点行会打开/选中文件） */
              nameCell = el;
            }
            if (nameCell && nameCell.isConnected) qa.realClick(nameCell);
          }
        } else if (how === 'enterkey') {
          /* 有些可编辑单元格要先聚焦，再按 Enter 才进编辑态 */
          try { if (!nameCell.hasAttribute('tabindex')) nameCell.setAttribute('tabindex', '-1'); } catch {}
          try { nameCell.focus(); } catch {}
          pressKeyOn(nameCell, 'Enter');
        } else pressKeyOn(nameCell, 'F2');
      } catch (e) { warn(` ⚠️ 改名：${how} 手势异常`, e); }
      const input = await waitInlineRenameInput(originalName, doc, how === 'click' ? 1500 : 1200);
      if (input) {
        log(` → 改名：进入行内编辑（${how}）`);
        return input;
      }
    }
    return null;
  }

  async function waitInlineRenameInput(originalName, doc = document, timeout = 1500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const input = findInlineRenameInput(originalName, doc);
      if (input) return input;
      await sleep(100);
    }
    return null;
  }

  /* 发键盘事件。
   * 注意：KeyboardEventInit **不接收** keyCode/which，必须用 defineProperty 补，
   * 否则 e.keyCode 恒为 0 —— 有些组件只认 keyCode 判 Enter/Esc/F2。*/
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
    fire('keydown');
    fire('keypress');
    fire('keyup');
  }

  function dispatchHover(qa, el) {
    const win = el.ownerDocument.defaultView || window;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    for (const [type, ctor] of [['pointerover', win.PointerEvent], ['pointerenter', win.PointerEvent], ['pointermove', win.PointerEvent], ['mouseover', win.MouseEvent], ['mouseenter', win.MouseEvent], ['mousemove', win.MouseEvent]]) {
      try { el.dispatchEvent(new ctor(type, base)); } catch {}
    }
  }

  /* ===== 行内改名（夸克真实实现）=====
   * 文件名单元格：`<div class="filename-text editable-cell editable-cell-allow" title="原名">原名</div>`
   * 点它 → 原地变成 `<input class="ant-input input-edit" maxlength="250" value="原名">`（无弹窗）。
   * 写入新名 → Enter（不行再失焦 / 点确认 / Ctrl+Enter）提交 → **等列表确认新名落地** 才算成功。
   * fid：目标行的 data-row-key（改名不换 fid，用它绑定复核，比按名比对可靠）。
   * 返回 'ok' | 'fail' | 'unverified'。*/

  /* 提交后绑定复核：同一 fid 行现在叫什么？
   * 不能用 findListRowByName 做判据 —— 它的比较键会把 [bgm]…[bgm] 剥掉，
   * "新名"与"旧名"键相同 → 恒真，会把没改成的判成功。*/
  function readRowLiveName(fid, doc = document) {
    if (!fid) return null;
    const row = findRowByFid(fid, doc);
    if (!row) return null;
    const cell = row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
    const el = cell || row;
    const t = (el.getAttribute && el.getAttribute('title')) || '';
    return `${t} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim();
  }

  /* 读取某一行"当前显示的单个文件名"（title 优先，退回 textContent）。
   * 注意：readRowLiveName 返回的是 "title 空格 textContent" 的拼接串，**不能**当文件名用。*/
  function readRowRealName(fid, doc = document) {
    if (!fid) return '';
    const row = findRowByFid(fid, doc);
    if (!row) return '';
    const cell = row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]') || row;
    return String((cell.getAttribute && cell.getAttribute('title')) || cell.textContent || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }

  function rowNameMatches(live, raw, mode) {
    if (!live || !raw) return false;
    if (mode === 'new') return live.includes(raw) || live.replace(/\s+/g, '') === raw.replace(/\s+/g, '');
    return live.includes(raw);
  }

  /* ===== 改名落地确认（唯一判据，行内与弹窗两条路径共用）=====
   * 必须确认"这一行（fid 绑定）的原样名确实变成了新名"，或者"旧名精确消失 + 新名出现"。
   * 绝不用 getComparableFileName / findListRowByName 做成功判据：它会剥掉 [bgm]…[bgm]，
   * 新旧名比较键相同 → 恒真，会把没改成的判成功。
   * 返回 true(已确认) / false(确认没有改) / null(确认不了)。*/
  async function confirmRenamedInList(qa, opts = {}) {
    const doc = opts.doc || document;
    const fid = opts.fid || '';
    const oldName = String(opts.oldName ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const newName = String(opts.newName ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 45000;
    const stableMs = 2000;
    const preRaw = fid ? readRowLiveName(fid, doc) : null;

    const deadline = Date.now() + budgetMs;
    let scrolled = false;
    let lastLog = 0;
    let lastFallback = 0;
    let lastFallbackHit = false;
    let stableSince = 0;

    while (Date.now() < deadline) {
      /* 确认"新名已落地"：连续 stableMs 都成立才算，避免乐观更新/瞬时值假成功。
       * 兜底查询被节流时沿用上次结果（否则每 300ms 一次的循环会把连续计时清零，
       * 兜底永远攒不满 stableMs）。*/
      let fallbackHit = false;
      if (Date.now() - lastFallback > 1000) {
        lastFallback = Date.now();
        const hit = findRowByExactName(qa, newName, doc);
        fallbackHit = !!(hit && (!fid || hit.fid === fid));
        lastFallbackHit = fallbackHit;
      } else {
        fallbackHit = lastFallbackHit;
      }
      const seenNow = () => {
        if (fid) {
          const live = readRowLiveName(fid, doc);
          if (live != null && rowNameMatches(live, newName, 'new')) return true;
        }
        return fallbackHit;
      };

      if (seenNow()) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) return true;
      } else {
        stableSince = 0;
      }

      if (!scrolled && Date.now() > deadline - (budgetMs - 5000)) {
        scrolled = true;
        if (fid) { try { await scrollToRowByName(qa, doc, newName, { cacheKey: currentCacheKey(), maxMs: 4000 }); } catch {} }
      }
      if (Date.now() - lastLog > 8000) {
        lastLog = Date.now();
        const live = fid ? readRowLiveName(fid, doc) : null;
        log(`   …仍在等待改名生效（当前行名：${live ? live.slice(0, 60) : '不在可见区'}）`);
      }
      await sleep(300);
    }

    /* 超时：原样名精确判定 */
    if (fid && preRaw) {
      const live = readRowLiveName(fid, doc);
      if (live != null) {
        if (live === preRaw) {
          /* 同一 fid 行原样名一个字都没变 → 确实没改成 */
          return false;
        }
        /* 名字变了：按"排除标识符后同名"确认，或精确等于新名 */
        if (live === newName) return true;
        if (findRowByExactName(qa, newName, doc)) return true;
        if (findListRowByName(qa, newName, doc)) return true;
        return null;
      }
    }
    if (oldName && findRowByExactName(qa, oldName, doc)) return false;
    if (findRowByExactName(qa, newName, doc)) return true;
    return null;
  }

  /* 行内改名：写入新名并提交（提交动作本身）。
   * fid 只用于日志；"是否真的改成"统一由 renameOneRow 调 confirmRenamedInList 判定。
   * 返回 'submitted' | 'fail'。*/
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

    /* ① Enter（带 keyCode） */
    pressKeyOn(input, 'Enter');
    closed = await until(() => editorClosed(), 150, 3000);

    /* ② 失焦 */
    if (!closed) {
      try { input.blur(); } catch {}
      closed = await until(() => editorClosed(), 150, 3000);
    }

    /* ③ 单元格里的确认按钮 */
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

    /* ④ Ctrl+Enter 兜底 */
    if (!closed) {
      try {
        const win = input.ownerDocument.defaultView || window;
        const base = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ctrlKey: true, bubbles: true, cancelable: true, view: win };
        let ev = null;
        try { ev = new win.KeyboardEvent('keydown', base); } catch {}
        if (ev) {
          try {
            Object.defineProperty(ev, 'keyCode', { get: () => 13 });
            Object.defineProperty(ev, 'which', { get: () => 13 });
            Object.defineProperty(ev, 'ctrlKey', { get: () => true });
          } catch {}
          input.dispatchEvent(ev);
        }
      } catch {}
      closed = await until(() => editorClosed(), 150, 2000);
    }

    if (!closed) {
      /* 还没关：按 Esc 收尾，避免残留编辑器污染后面的行 */
      pressKeyOn(input, 'Escape');
      await until(() => editorClosed(), 120, 1500);
      warn(' ⚠️ 改名：行内编辑未提交（Enter/失焦/确认按钮都无效），已按 Esc 放弃');
      return 'fail';
    }

    log(' ⏳ 改名：已提交，等待列表确认新名…');
    return 'submitted';
  }

  /* 找改名的 ant-modal：输入框的值必须就是原文件名（或去标识符后同名）。
   * 不做"弹窗文本含重命名"的兜底 —— 那会把别的行的改名弹窗也认下来，改错文件。*/
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

  async function waitRenameDialog(originalName, doc = document, timeout = 2500) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const m = findRenameModal(originalName, doc);
      if (m) return m;
      await sleep(120);
    }
    return null;
  }

  /* 输入新名 → 确认 → 等关闭。
   * scope 可能是行内编辑的 <input>（夸克真实路径）或改名弹窗（改动后的 Quark 版本）。*/
  async function applyRenameInDialog(qa, scope, originalName, newName, doc = document, fid = '') {
    if (!scope || !scope.isConnected) { warn(' ⚠️ 改名：改名编辑器已消失'); return false; }

    const inpSel = 'input.input-edit, input[type="text"], input:not([type]), input.ant-input';
    const collect = () => (typeof scope.querySelectorAll === 'function' && !(scope.tagName === 'INPUT'))
    ? [...scope.querySelectorAll(inpSel)].filter(i => !isRenamePanel(i))
    : [scope];
    const inputs = collect();
    const want = getComparableFileName(originalName);
    const input = inputs.find(i => {
      const v = String(i.value ?? '');
      return v && (v === originalName || getComparableFileName(v) === want);
    }) || inputs[0];
    if (!input) { warn(' ⚠️ 改名：找不到改名输入框'); return false; }

    const setInputValue = v => {
      try { input.focus(); } catch {}
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) { try { setter.call(input, v); } catch {} }
      if (input.value !== v) input.value = v;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
      try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
    };

    /* 行内编辑：Enter 或失焦提交；弹窗：点确认按钮 */
    if (input.classList.contains('input-edit')) {
      return await applyRenameViaInlineEditor(qa, input, originalName, newName, doc, fid);
    }

    setInputValue(newName);
    if (input.value !== newName) {
      warn(` ⚠️ 改名：输入框未接受新名（当前="${input.value}"）`);
      return false;
    }

    const btn = await qa.until(() => {
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
    const gone = await qa.until(() => !findRenameModal(originalName, doc), 150, 6000);
    if (!gone) { warn(' ⚠️ 改名：确认后弹窗未关闭'); return 'fail'; }
    log(' ⏳ 改名：弹窗已提交，等待列表确认新名…');
    return 'submitted';
  }

  /* 刷新后等列表出现本次转存的文件名（用尾巴 token 匹配，避免被标识符影响）。
   * 超时不算失败：后续 applyListRenames 会自己再等一次并逐个跳过找不到的行。*/
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
    warn(` ⚠️ 改名：${timeout}ms 内列表未出现全部目标文件（可能仍在加载），继续尝试改名`);
    return false;
  }

  /* 单行改名：返回 true 表示"已确认改名落地"。
   * 提交动作由行内编辑/弹窗完成；**是否真的改成**统一在这里用 confirmRenamedInList 判定，
   * 两条路径共用同一判据（绝不"提交了就当你成功"）。*/
  async function renameOneRow(qa, m, doc = document) {
    const row = (m.row && m.row.isConnected) ? m.row : ((findListRowByName(qa, m.old, doc) || {}).row || null);
    const editor = await openRenameDialog(qa, row, m.nameEl || getNameElInRow(row), m.old, doc);
    if (!editor) { warn(` ⚠️ 改名：打不开改名编辑器（行内编辑与按钮都没成功） —— ${m.old}`); return false; }

    const r = await applyRenameInDialog(qa, editor, m.old, m.next, doc, m.fid || '');
    if (r === 'fail' || r === false) {
      try {
        const close = editor.querySelector && editor.querySelector('.ant-modal-close, .ant-drawer-close');
        if (close) qa.realClick(close);
        else if (editor.blur) editor.blur();
      } catch {}
      return false;
    }

    /* ===== 落地确认（唯一判据）===== */
    const verdict = await confirmRenamedInList(qa, {
      fid: m.fid || '', oldName: m.old, newName: m.next, doc, budgetMs: 45000,
    });
    if (verdict === true) { log(' ✓ 改名：列表已确认新名'); return true; }
    if (verdict === false) { warn(` ⚠️ 改名：确认没改成（列表仍是旧名）—— ${m.old}`); return false; }
    warn(` ⚠️ 改名：45s 内无法确认是否改成 —— ${m.old} → ${m.next}`);
    return false;
  }

  /* 批量改名：把已转存文件改成 [bgm]acg最终名称[bgm]原始文件名
   * opts.waitMs：单个文件在列表里等待出现的上限（未成功刷新时可缩短，避免白等） */
  async function applyListRenames(qa, plan, opts = {}) {
    const doc = opts.doc || document;
    const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 8000;
    const entries = Array.isArray(plan) ? plan.filter(x => x && x.old && x.next) : [];
    if (!entries.length) { log('★ 改名：无需要改名的文件'); return { renamed: 0, failed: 0, skipped: 0, confirmed: [], failedEntries: [], pairs: [] }; }

    log(`★ 改名：待改名 ${entries.length} 个 → ${FILE_NAME_MARKER}acg名称${FILE_NAME_MARKER}原始文件名`);
    for (const e of entries) log(` - ${e.old}  →  ${e.next}`);

    let renamed = 0, failed = 0, skipped = 0;
    const confirmed = [];
    const failedEntries = [];

    /* 单趟改名；确认成功才计入 confirmed */
    const doOne = async (e, label) => {
      /* 优先按 fid 定位（名字可能带 (2) 后缀或已被改过）；行可能在可见区外 → 先滚动 */
      let loaded = null;
      if (e.fid) {
        const row = findRowByFid(e.fid, doc);
        if (row) {
          const nc = row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
          /* 当前名优先用 title（scanFileRows 同口径）；退回 textContent；再退回计划里的老名字 */
          const curName = nc
            ? String(nc.getAttribute('title') || nc.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
            : '';
          loaded = { row, fid: e.fid, name: curName || e.old };
        }
      }
      if (!loaded) loaded = findListRowByName(qa, e.old, doc);
      if (!loaded) loaded = await until(() => findListRowByName(qa, e.old, doc), 200, waitMs);
      if (!loaded) loaded = await scrollToRowByName(qa, doc, e.old, { cacheKey: currentCacheKey(), maxMs: 6000 });
      if (!loaded) {
        warn(` ⚠️ 改名：${label} 列表里找不到该文件 —— ${e.old}`);
        return { ok: false, missing: true };
      }
      const fid = e.fid || loaded.fid || (loaded.row && loaded.row.getAttribute && loaded.row.getAttribute('data-row-key')) || '';
      /* 关键：old 必须换成**该行的真实当前名**（可能是 02(2).mp4），
       * 否则行内编辑的输入框（值=真实当前名）匹配不上、弹窗也会认错行。*/
      let realName = '';
      try {
        if (fid) realName = readRowRealName(fid, doc);
        if (!realName) {
          const nc = loaded.row && loaded.row.querySelector && loaded.row.querySelector('.filename-text, [class*="filename-text"], .file-name, [class*="file-name"]');
          realName = nc ? String(nc.getAttribute('title') || nc.textContent || '').replace(/\s+/g, ' ').trim() : '';
        }
      } catch {}
      const oldName = realName || e.old;
      if (oldName !== e.old) log(`   ↳ 列表真实名：${oldName}（计划名 ${e.old}，夸克重名加了后缀）`);
      const r = await renameOneRow(qa, { row: loaded.row, nameEl: getNameElInRow(loaded.row), old: oldName, next: e.next, fid }, doc);
      if (r) {
        const row = findRowByExactName(qa, e.next, doc);
        confirmed.push({ old: oldName, next: e.next, fid: row ? row.fid : fid });
        log(` ✓ 改名 ${label} ${oldName} → ${e.next}`);
      } else {
        warn(` ✗ 改名失败 ${label} ${oldName}`);
      }
      try { await qa.clearAllSelection(); } catch {}
      await sleep(250);
      return { ok: !!r, missing: false };
    };

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const res = await doOne(e, `[${i + 1}/${entries.length}]`);
      if (res.ok) renamed++;
      else if (res.missing) { skipped++; failedEntries.push(e); }
      else { failed++; failedEntries.push(e); }
    }

    /* 没成功的再来一趟：列表可能刚好还在刷、行还没渲染出来 */
    if (failedEntries.length) {
      log(`★ 改名：第一趟后仍有 ${failedEntries.length} 个没成功，重试一趟…`);
      await sleep(1500);
      const retry = failedEntries.slice();
      failedEntries.length = 0;
      failed = 0; skipped = 0;
      for (let i = 0; i < retry.length; i++) {
        const e = retry[i];
        const res = await doOne(e, `[重试 ${i + 1}/${retry.length}]`);
        if (res.ok) renamed++;
        else if (res.missing) { skipped++; failedEntries.push(e); }
        else { failed++; failedEntries.push(e); }
      }
    }

    if (failedEntries.length) {
      warn(` ⚠️ 改名：${failedEntries.length} 个文件最终未确认改名成功（不会自动补做）：`
        + failedEntries.map(e => e.old).join('、'));
    }

    try { qa.refreshGray(); } catch {}
    log(`★ 改名完成：成功 ${renamed}，失败 ${failed}，跳过 ${skipped}`);
    return { renamed, failed, skipped, confirmed, failedEntries, pairs: [] };
  }

  /* 改名自检：对当前可见的第一个文件加/改标识符前缀，用于验证改名路径是否可用 */
  async function runRenameSmokeTest(qa, doc = document) {
    const files = (qa.scanFileRows(doc) || []).filter(f => f.fid && f.row && !isFolderFile(f));
    if (!files.length) { alert('当前可见区没有可改名的文件行'); return; }

    const f = files[0];
    const base = normalizeFileName(f.name);
    const next = buildRenamedFileName('测试改名', base);
    if (!next) { alert('难以构造测试文件名'); return; }

    log('=== 改名自检 ===');
    log(` 当前名：${f.name}`);
    log(` 目标名：${next}`);
    const btns = [...doc.querySelectorAll('.btn-group button, button')]
    .map(b => (b.textContent || '').replace(/\s+/g, '')).filter(Boolean);
    log(' 页面按钮文本：', btns.join(' | '));

    const rep = await applyListRenames(qa, [{ old: f.name, next, fid: f.fid }]);
    if (rep.renamed) {
      alert(`✅ 改名成功（已确认列表中新名生效）\n\n${f.name}\n→ ${next}\n\n（自检用，验证完可手动改回）`);
    } else {
      alert(`❌ 改名未确认成功（成功 ${rep.renamed} / 失败 ${rep.failed} / 跳过 ${rep.skipped}）\n\n`
        + `若文件其实已经改名：说明列表刷新慢于 45s，请把控制台 [桥接] 日志发我。\n`
        + `若完全没改名：请看日志里"打不开改名编辑器/行内编辑未提交"的具体原因。`);
    }
  }

  /* 改名诊断（只读）：不改动任何文件，只报告入口元素/按钮/勾选状态，便于真机排查 */
  function runRenameDiagnose(qa, doc = document) {
    const lines = [];
    const files = (qa.scanFileRows(doc) || []).filter(f => f.fid && f.row && !isFolderFile(f));
    lines.push(`可见文件行：${files.length}`);

    const f = files[0];
    if (!f) {
      const msg = lines.join('\n') + '\n\n当前可见区没有文件行（列表可能还在加载）';
      log('=== 改名诊断 ===\n' + msg);
      alert(msg);
      return;
    }

    const cell = getNameCellOnly(f.row);
    lines.push(`首个文件：${f.name}`);
    lines.push(`fid：${f.fid}`);
    lines.push(`行 class：${f.row.className}`);
    lines.push(`行选中：${f.row.classList.contains('ant-table-row-selected')}`);
    lines.push(`名字单元格：${cell ? `<${cell.tagName.toLowerCase()} class="${cell.className}">` : '未找到 .filename-text'}`);
    if (cell) {
      lines.push(`title：${cell.getAttribute('title')}`);
      lines.push(`可编辑标记：editable-cell-allow=${cell.classList.contains('editable-cell-allow')} editable-cell=${cell.classList.contains('editable-cell')}`);
      const style = (cell.ownerDocument.defaultView || window).getComputedStyle(cell);
      lines.push(`样式：pointer-events=${style.pointerEvents} user-select=${style.userSelect} cursor=${style.cursor}`);
    }
    /* 行内改名会写入的名字长度检查：超长会被夸克 maxlength=250 砍掉/拒绝 */
    const fit = fitAcgName('测试改名', f.name);
    lines.push(`改名目标名示例：${fit.name || '（构不出）'}${fit.truncated ? '（acg 名称会被截短以适配 250）' : ''}`);

    const btns = [...doc.querySelectorAll('.btn-group button.btn-file')]
    .map(b => (b.textContent || '').replace(/\s+/g, '') || b.className).filter(Boolean);
    lines.push(`顶栏按钮：${btns.join(' | ') || '（无）'}`);
    lines.push(`表头全选状态：${getHeaderCheckState(doc)}`);
    lines.push(`可见选中行：${getSelectedFids(doc).length}`);
    lines.push(`当前行内编辑 input：${findInlineRenameInput('', doc) ? '有' : '无'}`);
    const closer = f.row.closest('.filename') || f.row;
    lines.push(`目标行内 .hoitem-more：${closer.querySelectorAll('.hoitem-more, .hover-oper-item.ant-dropdown-trigger').length} 个`);

    const msg = lines.join('\n');
    log('=== 改名诊断 ===\n' + msg);
    alert(msg + '\n\n（本诊断不改动任何文件；详细内容见控制台 [桥接] 日志）');
  }

  /* ===== 逐行勾选（虚拟滚动兼容） ===== */
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

  /* ===== 表头全选方案 =====
   * 少量勾选：表头清空后逐个滚动勾选；大量勾选：表头全选后逐个滚动取消。
   * 目标全 true 且表头已 all / 全 false 且表头已 none 时直接快速返回。 */
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

    if (trueCount === totalCount && headerState === 'all') {
      log(` ✓ 表头已全选，无需操作`);
      return { ok: true, applied: 0, failed: 0, method: 'header-all-satisfied' };
    }

    if (falseCount === totalCount && headerState === 'none') {
      log(` ✓ 表头已全不选，无需操作`);
      return { ok: true, applied: 0, failed: 0, method: 'header-none-satisfied' };
    }

    /* 少量勾选：表头清空后逐个滚动勾选目标 */
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

    /* 大量勾选：表头全选后逐个滚动取消排除项 */
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

  /* ===== 表格稳定等待 ===== */
  async function waitTableStable(qa, doc = document, maxMs = 20000) {
    const t0 = Date.now();
    const expected = getShareFileCount(doc);
    log(` 头部显示共 ${expected == null ? '?' : expected} 个；等待表格稳定...`);

    /* 等"表格专用加载层"消失（不误判分页器/按钮的 spin） */
    await until(() => !isShareTableLoading(doc), 150, maxMs);
    log(` 表格加载层已消失，等待行数稳定...`);

    let lastCount = -1;
    let stableHits = 0;
    const remain = () => Math.max(0, maxMs - (Date.now() - t0));

    const files = await until(() => {
      /* 中途又出现加载层：重置稳定计数 */
      if (isShareTableLoading(doc)) { lastCount = -1; stableHits = 0; return null; }

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
    }, 300, remain());

    if (files) return files;
    const cur = qa.scanFileRows(doc);
    log(` 等待超时，当前扫描到 ${cur.length} 行`);
    return cur;
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
  /* 文件名列表拼接，超过 maxShow 个则截断 */
  function fmtNames(arr, maxShow = 20) {
    const names = (arr || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean);
    if (!names.length) return '（无）';
    if (names.length <= maxShow) return names.join('、');
    return names.slice(0, maxShow).join('、') + ` 等 ${names.length} 个`;
  }
  /* ===== 分享页准备 ===== */
  async function prepareShareSave(qa, doc = document, opts = {}) {
    const splitOldest = opts.splitOldest !== false;
    const cacheKey = currentCacheKey();

    await ensureTimeDescSort(qa, doc);

    /* 先等可见区表格稳定 */
    let files = await waitTableStable(qa, doc, 20000);
    files = (files || []).filter(f => !isFolderFile(f));
    if (!files.length) return { ok: false, kind: 'no-files', files: [] };

    await sleep(300);

    /* 一次滚动收集全表；后续命中缓存不再滚动 */
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

  /* ===== 子任务 ===== */
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
    startSharePolling(qa); // 让子任务页可见区也置灰

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
  /* ===== 个人页：点击页面内"刷新"按钮（替代整页 reload） ===== */
  function findListRefreshButton(doc = document) {
    const el = doc.querySelector('.fl-refresh');
    if (el && _isVisible(el)) return el;
    return null;
  }

  async function clickListRefresh(qa, doc = document) {
    const wrap = findListRefreshButton(doc);
    if (!wrap) return false;

    // 优先点内部 img（避免 hover 层拦截），退化为点容器
    const target = wrap.querySelector('img') || wrap;
    try {
      if (qa && typeof qa.realClick === 'function') qa.realClick(target);
      else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch (e) {
      warn('点击刷新按钮失败：', e);
      try { target.click(); return true; } catch { return false; }
    }
  }

  /* 点击刷新后，等表格 loading 出现再消失（列表重拉一次） */
  async function clickListRefreshAndWait(qa, doc = document, opts = {}) {
    const appearedTimeout = opts.appearedTimeout ?? 3000;
    const settleTimeout  = opts.settleTimeout  ?? 12000;

    const ok = await clickListRefresh(qa, doc);
    if (!ok) return false;

    const tableWrap = doc.querySelector('.ant-table-wrapper');
    if (!tableWrap) { await sleep(800); return true; }

    // 等 spin 出现（有 loading 才算真的触发了重拉）
    const appeared = await until(
      () => !!tableWrap.querySelector('.ant-spin-spinning'),
      100, appearedTimeout
    );

    if (appeared) {
      await until(() => !tableWrap.querySelector('.ant-spin-spinning'), 150, settleTimeout);
    } else {
      // 有的情况下刷新很快 / 没有明显 spin，给个短稳定期
      await sleep(800);
    }
    return true;
  }
  /* ===== 把"刚转存的文件"对上列表里的真实行 =====
   * 关键：夸克转存到已有同名文件时会自动加 (2) 后缀（02.mp4 → 02(2).mp4），
   * 所以**不能按名字找行**。优先用图标签名（thumbnail URL 去掉 fid 查询参数后是文件自身的标识）。
   * 退路：名字去 (n) 后缀相等（按后缀号最大者优先 = 夸克给新文件分配的号最大）。*/

  /* 图标签名归一化：去掉 ?query（fid 不同页不同），只留资源路径 */
  function normalizeIconSig(sig) {
    const s = String(sig ?? '').trim();
    if (!s) return '';
    const cut = s.split('?')[0];
    return cut.replace(/\/+$/, '');
  }

  /* 判定"目录里已存在的文件" vs "刚转存进来的新文件" */
  function stripDedupSuffix(name) {
    let t = String(name ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    let suffix = 0;
    /* 夸克可能叠后缀（01(1) (1).mkv），循环剥掉 */
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

  /* 图标签名是否"可以按文件区分"：只有真实缩略图/图片 URL 才当身份用。
   * `svg:`/`cls:`/`url:` 这类是**按文件类型**生成的（同类型文件签名相同），不能用来认文件。*/
  function isIdentifiableIconSig(sig) {
    const s = normalizeIconSig(sig);
    return /^img:https?:\/\//i.test(s) && /thumbnail|\.(png|jpe?g|webp|gif|avif)/i.test(s);
  }

  /* 图标签名是否同一份文件（去掉 ?query 后全等）。匹配不上就走名字后缀那条路。*/
  function sameIconSig(a, b) {
    if (!isIdentifiableIconSig(a) || !isIdentifiableIconSig(b)) return false;
    const na = normalizeIconSig(a), nb = normalizeIconSig(b);
    return !!na && na === nb;
  }

  /* saved：转存结果记录（share 页拿到的原始文件名，可能没有大小）
   * rows：个人页当前列表行（qa.scanFileRows）
   * savedBefore：本次转存前的已转存名单（用于区分"已存在的旧同名文件"与"刚转存进来的新文件"）
   * 返回 { row, currentName, base, how }；base 一律取**列表真实当前名**（不剥 (n)），
   * 避免目标名与目录里已存在的文件撞名。*/
  function matchSavedToListRow(saved, rows, savedBefore) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const savedName = String((saved && saved.name) || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!savedName) return null;
    const savedIcon = normalizeIconSig(saved && saved.iconSig);
    const savedSize = normSizeKey(saved && saved.sizeStr);
    const wantName = getComparableFileName(savedName);

    const mk = (r, how) => ({ row: r, currentName: r.name, base: stripMarkerBlock(r.name).trim(), how });

    /* ① 图标签名一致（首选）。
     * 但必须唯一：命中多个且大小无法唯一确定时，不能猜（猜错就是改错文件）。*/
    if (isIdentifiableIconSig(savedIcon)) {
      const byIcon = rows.filter(r => sameIconSig(r.iconSig, savedIcon));
      if (byIcon.length) {
        const sized = savedSize ? byIcon.filter(r => normSizeKey(r.sizeStr) === savedSize) : [];
        if (sized.length) return mk(sized[0], 'icon');
        if (byIcon.length === 1) return mk(byIcon[0], 'icon');
        log(` ★ 改名：${savedName} 的缩略图匹配到 ${byIcon.length} 行且大小无法区分，改走名字匹配`);
      }
    }

    /* ② 名字一致或只差 (n) 后缀。
     * 关键判定：如果"与转存名完全相同"的那一行**本来就在转存记录里**（=旧文件），
     * 那这次新转存进来的是带后缀的那个 → 取后缀号最大的候选。
     * （"最大后缀号 = 新文件"依赖夸克的分配规则，日志会打出来，真机可核对。）*/
    const exactCand = [];
    const baseCand = [];
    for (const r of rows) {
      const cur = String(r.name || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
      if (!cur) continue;
      const curKey = getComparableFileName(cur);
      const rs = stripDedupSuffix(cur);
      if (curKey === wantName) { exactCand.push({ r, cur, suffix: rs.suffix }); continue; }
      /* 去后缀后与转存名同名，且自身确实带后缀 */
      if (rs.suffix > 0 && getComparableFileName(rs.base) === wantName) {
        baseCand.push({ r, cur, suffix: rs.suffix });
      }
    }
    const exactAlreadySaved = Array.isArray(savedBefore) && savedBefore.some(si => isSameFile(si, { name: savedName }));
    const suffixed = exactCand.filter(c => c.suffix > 0).concat(baseCand);
    const cand = (exactAlreadySaved && suffixed.length) ? suffixed : (exactCand.length ? exactCand : baseCand);
    if (cand.length) {
      let pool = cand;
      if (savedSize) {
        const sized = cand.filter(c => normSizeKey(c.r.sizeStr) === savedSize);
        if (sized.length) pool = sized;
      }
      pool.sort((a, b) => b.suffix - a.suffix);
      return mk(pool[0].r, 'name');
    }

    /* ③ 兜底：仅按可比较名匹配 */
    const hit = rows.find(r => getComparableFileName(r.name) === wantName);
    if (hit) return mk(hit, 'name-only');
    return null;
  }

  /* 本次转存结果 → 改名计划（[bgm]acg最终名称[bgm]原始文件名）。
   * listRows：个人页当前列表行（用于把"刚转存的文件"对上真实行，含 (n) 后缀场景）。
   * old 一律保留"列表页当前名"原样（applyListRenames 靠它定位行）。
   * 同一个原始文件名出现在多个分享、但 acg 最终名称不一致 → 无法判定，跳过不改名。*/
  function buildRenamePlan(savedByUrl, bd, listRows = [], alreadySaved = []) {
    const { map: nameByShare, conflict } = collectShareNameMap(bd);
    /* 先给每个"转存结果"配上列表里真实的行与未被转存前就存在的同名文件 */
    const items = [];
    for (const entry of (Array.isArray(savedByUrl) ? savedByUrl : [])) {
      if (!entry || !Array.isArray(entry.files) || !entry.files.length) continue;
      const acgName = nameByShare.get(entry.url);
      if (!acgName) {
        const why = conflict.has(entry.url) ? `名称冲突（${conflict.get(entry.url)}）` : '清单里没有该分享的最终名称';
        log(` ★ 改名：跳过 ${entry.url} —— ${why}`);
        continue;
      }
      for (const f of entry.files) {
        const savedName = String((f && f.name) || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
        if (!savedName) continue;
        const m = matchSavedToListRow(f, listRows, alreadySaved);
        if (!m) { log(` ★ 改名：列表里找不到 ${savedName}（转存后可能尚未显示），跳过`); continue; }
        items.push({ savedName, acgName, currentName: m.currentName, base: m.base, row: m.row, how: m.how });
      }
    }
    if (!items.length) return [];

    /* 原始文件名（去标识符后）→ acg 名称；同一原始名对应不同 acg 名 → 冲突跳过 */
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
    if (tooLong) warn(` ⚠️ 改名：${tooLong} 个文件即使用截短后的 acg 名称也放不下（原始文件名太长），保留原名不改`);
    if (truncated) log(` ★ 改名：${truncated} 个文件的目标名超过夸克 250 上限，acg 名称已自动截短（原始文件名保持不变）`);

    const out = [];
    const seenOld = new Set();
    for (const it of items) {
      const oldName = it.currentName;                /* 列表里的真实当前名（可能带 (2)） */
      if (!oldName || seenOld.has(oldName)) continue;
      seenOld.add(oldName);

      if (conflictNames.has(it.base)) {
        log(` ★ 改名：跳过 ${oldName} —— 同名文件对应了不同的 acg 名称`);
        continue;
      }
      const name = targetByBase.get(it.base);
      if (!name) continue;
      /* 目标名用"列表真实当前名的原始名部分"重建（保留 (2) 后缀，已有 [bgm] 前缀则替换为新 acg 名）。
       * acg 名称超长时 buildRenamedFileName 会自动截短 acg 名称部分，原始文件名一字不动。*/
      const baseForTarget = stripMarkerBlock(String(it.currentName ?? '')).trim();
      if (!baseForTarget) continue;
      const next = buildRenamedFileName(name, baseForTarget);
      if (!next) continue;                             /* 即使截短也放不下 → 不改 */
      if (!needRename(it.currentName, name)) continue; /* 已经是目标名 → 不改 */
      out.push({ old: oldName, next, acgName: name, truncated: fitAcgName(name, baseForTarget).truncated, matchedBy: it.how, fid: (it.row && it.row.fid) || '' });
      if (it.how !== 'icon') log(`   ↳ ${oldName} 非 icon 命中（matchedBy=${it.how}），目标名 ${next}`);
    }
    return out;
  }

  /* 改名成功 → 下载记录里那一行也换成新名（fid 不变，不会重复下载）。
     记录键可能是 fid（夸克助手）或名字（历史遗留键），两种都覆盖；只改命中的那条。
     整表只读写一次，避免与夸克助手并发整表覆盖；ts 保留原值（不因改名延长 TTL）。*/
  function refreshDlRecordsAfterRename(pairs) {
    if (!Array.isArray(pairs) || !pairs.length) return 0;
    let n = 0;

    const byFid = gmGet(GM_DL_RECORDS, {}) || {};
    let fidDirty = false;
    for (const p of pairs) {
      if (!p || !p.fid) continue;
      const rec = byFid[p.fid];
      if (!rec || typeof rec !== 'object') continue;
      byFid[p.fid] = { ...rec, name: p.next };
      fidDirty = true;
      n++;
    }
    if (fidDirty) gmSet(GM_DL_RECORDS, byFid);

    const byName = gmGet(GM_QRECORDS, {}) || {};
    let nameDirty = false;
    for (const p of pairs) {
      if (!p || !p.old || !byName[p.old]) continue;
      byName[p.next] = { ...byName[p.old], name: p.next };
      delete byName[p.old];
      nameDirty = true;
      n++;
    }
    if (nameDirty) gmSet(GM_QRECORDS, byName);

    return n;
  }

  /* 批量转存 */
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
    log('★ 已标记桥接忙碌，QuarkAutoAssistant 暂停自动下载（下载由本脚本在改名确认后触发）');
    /* 本轮转存**之前**的已转存名单：用来区分"目录里早就存在的旧同名文件"与"刚转存进来的新文件"
     * （夸克重名转存会给新文件加 (2)，不能靠名字判断哪个是新的）。*/
    const savedNamesBefore = collectSavedInfos(loadRecords())
    .map(si => ({ name: si.name, sizeStr: si.sizeStr, iconSig: si.iconSig }));

    try {
      qa.setStatus('转存中...', 'running');
      let successCount = 0;
      let partialCount = 0;
      /* 本次真正转存成功的文件：按来源分享收集，供改名使用 */
      const savedByUrl = [];

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

          if (Array.isArray(r.savedFiles) && r.savedFiles.length) {
            savedByUrl.push({
              url: key,
              files: r.savedFiles.map(f => ({ name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig })),
            });
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

      /* 本次改名是否全部确认成功（false 时不允许下载、也不允许关页） */
      let renameAllConfirmedOut = true;
      let hadRenamePlan = false;
      if (successCount + partialCount > 0) {
        log('★ 有新转存，点击页面内刷新按钮触发列表更新...');
        /* 注意：此处不放开 BUSY_KEY —— 刷新和改名期间放开会让夸克助手的 boot 自动下载抢跑 */
        await sleep(500);

        const ok = await clickListRefreshAndWait(qa, document, {
          appearedTimeout: 3000,
          settleTimeout: 12000,
        });
        if (ok) log('✓ 已点击页面内刷新按钮，等待列表更新完成');
        else warn('⚠️ 未找到页面内刷新按钮：列表可能还是旧行，改名多半会失败（会逐个跳过），最后回退整页重载');

        /* ===== 刷新完成 → ★ 按 acg 最终名称改名 → 触发下载 ===== */
        let plan = [];
        let planBuildOk = true;
        try {
          /* 把"转存结果"对上列表真实行：夸克重名会加 (2) 后缀，所以要拿当前列表行来比对。
           * savedNamesBefore：本轮转存前的已转存名单（区分旧同名文件与刚转存的新文件）。*/
          const listRows = qa.scanFileRows(document) || [];
          plan = buildRenamePlan(savedByUrl, loadBangumiData(), listRows, savedNamesBefore);
        } catch (e) { warn('⚠️ 改名计划构建失败', e); planBuildOk = false; }
        if (!planBuildOk) {
          qa.setStatus('改名计划构建失败，已暂停下载', 'error');
          warn('⛔ 改名计划构建失败：本轮不下载（避免按旧名落盘）');
        }

        if (plan.length && ok) {
          await waitRowsForRename(qa, plan);
        } else if (plan.length) {
          warn(` ★ 改名：未成功刷新，直接在当前列表上尝试改名（找不到的行会跳过）；本次未改名成功的文件不会自动补做`);
        }

        let renameReport = { renamed: 0, failed: 0, skipped: 0, pairs: [] };
        let renameStepOk = true;
        if (plan.length) {
          try {
            renameReport = await applyListRenames(qa, plan, { waitMs: ok ? 8000 : 1500 });
          } catch (e) { warn('⚠️ 改名过程异常', e); renameStepOk = false; }

          /* pairs 只取"本次确认为改成功"的行（不要用比较键反推：它会剥掉标识符，新旧名键相同） */
          if (renameReport.renamed > 0) {
            renameReport.pairs = (renameReport.confirmed || [])
            .filter(c => c && c.fid)
            .map(c => ({ fid: c.fid, old: c.old, next: c.next }));
            const missingFid = (renameReport.confirmed || []).filter(c => !c.fid).length;
            if (missingFid) warn(` ⚠️ 改名：${missingFid} 个已改名文件拿不到 fid，未同步下载记录名（不影响下载判定）`);
            try {
              const n = refreshDlRecordsAfterRename(renameReport.pairs);
              if (n) log(` ★ 改名：同步 ${n} 条下载记录到新名`);
            } catch (e) { warn('⚠️ 同步下载记录失败（不影响下载）', e); }
          }
        } else {
          log('★ 改名：本次无需改名（无计划或清单里没有对应最终名称）');
        }

        /* 下载前先把"改名结果"讲清楚，并决定这一轮还能不能下载 */
        const confirmedCount = (renameReport.confirmed || []).length;
        const notConfirmed = (renameReport.failed || 0) + (renameReport.skipped || 0);
        if (plan.length) {
          log(`★ 改名结果：确认成功 ${confirmedCount} / 计划 ${plan.length}`
            + (notConfirmed ? `，未确认 ${notConfirmed}` : ''));
        }
        /* 用户要求：必须等名称确认改完，才允许下载 / 关页。
         * 计划构建失败 / 改名步骤异常 / 有文件没确认 → 一律视为"未全确认"：
         * 不下载、不重载、不关页（改名确认通过后才由本脚本触发夸克下载）。*/
        const renameAllConfirmed = planBuildOk && renameStepOk
          && (renameReport.failedEntries || []).length === 0
          && (!plan.length || confirmedCount >= plan.length);
        renameAllConfirmedOut = renameAllConfirmed;
        hadRenamePlan = plan.length > 0;

        await sleep(600);

        if (renameAllConfirmed) {
          /* 改名已全部确认，放开忙碌标志后再触发下载 */
          releaseBusy();
          if (qa.isPaused && qa.isPaused()) {
            log('⏸ 夸克助手已暂停，跳过自动下载触发');
          } else if (typeof qa.autoDownloadWorkflow === 'function') {
            log('★ 触发下载（改名已确认）...');
            await qa.autoDownloadWorkflow();
            log('★ 下载流程已结束');
          } else {
            warn('⚠️ quarkAssistant.autoDownloadWorkflow 不可用，无法触发下载');
          }
        } else {
          const names = (renameReport.failedEntries || []).map(e => e.old).join('、');
          warn(`⛔ 改名未全部确认（${confirmedCount}/${plan.length}${planBuildOk ? '' : '，改名计划构建失败'}），`
            + `已跳过下载、保持本页：${names || '（见上方日志）'}`);
          qa.setStatus('改名未确认，已暂停下载', 'error');
          alert(`⚠️ 改名未全部确认（${confirmedCount}/${plan.length}），已跳过下载并保持本页。\n\n`
            + `${names ? '未确认：' + names + '\n\n' : ''}`
            + `处理建议：\n`
            + `1) 先点「🔍 改名诊断」看入口，再点「🏷️ 测试改名」验证该文件能否改成功；\n`
            + `2) 想手动改：直接在文件名上点一下，改完按 Enter；\n`
            + `3) 改好后重新点「▶️ 转存」再跑一轮。`);
        }

        if (renameAllConfirmed) {
          if (!ok) {
            warn('⚠️ 未找到页面内刷新按钮，回退整页重载（改名已在上方就地完成）');
            await sleep(1000);
            location.reload();
          }
        } else if (!ok) {
          warn('⚠️ 未找到页面内刷新按钮且改名未确认：不重载页面，避免把未确认状态掩盖掉');
        }
      } else {
        log('无新转存文件，跳过刷新');
      }
      return { hadPlan: hadRenamePlan, allConfirmed: renameAllConfirmedOut };
    } catch (e) {
      /* 流程异常：绝不"出错后还按旧名下载" */
      warn('⛔ 转存流程异常，本轮不下载', e);
      qa.setStatus('流程异常，已暂停下载', 'error');
      throw e;
    } finally {
      releaseBusy();
    }
  }

  /* ===== 分享页：手动转存当前页 ===== */
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

  /* ===== 分享页：标记 / 清除 ===== */
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

  /* ===== acg.rip 端 ===== */
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
          `转存记录：${Object.keys(recs).length} 条（不按时间过期；过期只依据 acg.rip 清单）\n` +
          `CD：${Object.keys(state).length} 个 URL\n` +
          `待处理清单：${Array.isArray(pend.urls) ? pend.urls.length : 0} 项\n` +
          `自动触发标记：${auto ? new Date(auto).toLocaleTimeString() : '无'}`
        );
      });
    } catch {}

    /* 过期只依据 acg.ripImprove 清单；清单不可用时 sweepObsoleteRecords 会自行跳过，绝不误删。 */
    setTimeout(() => { try { sweepObsoleteRecords(); } catch (e) { warn('过期清理失败', e); } }, 2000);

    log('已启动（acg.rip 端）');
  }

  /* ===== 夸克端入口 ===== */
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

      /* 排序会触发新的加载，完成后需再刷一次灰置 */
      ensureTimeDescSort(qa, document).then(async (r) => {
        log(`★ 分享页初始化排序结果：${JSON.stringify(r)}`);
        if (r && r.ok && r.method !== 'already') {
          await until(() => !isShareTableLoading(document), 150, 15000);
          refreshShareUI(qa);
          log(`★ 排序后刷新灰置：可见区已刷新`);
        }
      });

      /* 等首屏加载完再刷灰色，避免加载中查到空表格 */
      (async () => {
        await until(() => !isShareTableLoading(document), 150, 20000);
        refreshShareUI(qa);
        const r0 = { total: qa.scanFileRows(document).length };
        log(`★ 分享页初始化（可见区）：扫描 ${r0.total}`);
      })();

      log(`★ 分享页初始化（等待用户操作 / 子任务触发）`);
      /* 不主动 refreshShareFullCounts：未点击按钮前显示 '-'，不触发全表滚动 */
    } else if (isList) {
      qa.setActions([
        {
          label: '▶️ 转存', color: '#09AAFF',
          title: '处理 pending_urls 或 bangumiData 里的分享，逐条转存；刷新后按 acg 最终名称改名再触发下载',
          onclick: () => runSaveAllFlow(qa, null),
        },
        {
          label: '🏷️ 测试改名', color: '#da9328',
          title: '对当前可见的第一个文件试改名（只加标识符前缀，用于验证改名路径）',
          onclick: () => runRenameSmokeTest(qa),
        },
        {
          label: '🔍 改名诊断', color: '#8c8c8c',
          title: '只报告改名入口的 DOM/按钮/勾选状态，不改动任何文件',
          onclick: () => runRenameDiagnose(qa),
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
        let autoResult = null;
        if (urls && urls.length) {
          log(`★ 自动触发：从 pending_urls 读取 ${urls.length} 个 URL`);
          try { autoResult = await runSaveAllFlow(qa, urls); } catch (e) { warn('自动转存流程异常', e); }
        } else {
          warn('自动触发但 pending_urls 为空');
        }
        /* 关页白名单：只有"明确全部确认"才自动关闭。
         * 结果为空（异常）、或 allConfirmed !== true，一律保持页面，避免把未确认状态掩盖掉。*/
        if (!autoResult || autoResult.allConfirmed !== true) {
          warn('⛔ 自动任务：未确认改名全部完成，保持本页（不自动关闭）');
          return;
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