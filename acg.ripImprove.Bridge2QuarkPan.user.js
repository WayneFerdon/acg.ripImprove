// ==UserScript==
// @name acg.ripImprove.Bridge2QuarkPan
// @namespace http://tampermonkey.net/
// @version 3.10.5
// @description acg.rip 桥接：夸克转存业务编排（全表一次滚动 + 内存缓存；单行定位优先可见区 + 估计位置；表头状态快速返回；记录不按时间过期，过期只依据 acg.rip 清单；转存刷新后按 acg 最终名称改名 acg名称+原始文件名；跨标签页即时触发；自动子任务前强制等待夸克侧预清理完成；改名时记录曾用名；匹配按最新名→曾用名→[bgm]兜底；全量重转时写入诊断 Debug；扫描时自愈旧记录空字段）
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
  const GM_DL_RECORDS = 'quark_auto_dl_records';
  const GM_QRECORDS = 'quark_download_records';
  const GM_FULL_RESAVE_DEBUG = 'acgrip_quark_full_resave_debug';

  const TASK_TTL = 3 * 60 * 1000;
  const TAB_RESULT_TIMEOUT = 90 * 1000;

  const BASE_CD = 30 * 60 * 1000;
  const MAX_CD = 7 * 24 * 60 * 60 * 1000;
  const AUTO_TTL = 5 * 60 * 1000;

  const FULL_RESAVE_DEBUG_MAX = 10;
  const AUTO_CLOSE_DELAY_MS = 5000; // 自动任务下载完成后，延迟关页，避免下载未唤起
  const OBSOLETE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 孤立记录宽限期 7 天
  const MIN_QA_VERSION = [5, 7, 6];

  const log = (...a) => console.log('[桥接]', ...a);
  const warn = (...a) => console.warn('[桥接]', ...a);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  function normalizeSizeStr(s) {
    const t = String(s ?? '').trim();
    if (!t) return '';
    if (t === '--' || t === '-' || t === '—' || /^未知|loading/i.test(t)) return '';
    return t.replace(/\s+/g, '').toUpperCase();
  }

  /* ===== 文件名标识符 [bgm]…[bgm] ===== */
  const FILE_NAME_MARKER = '[bgm]';

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getFileNameMarkerRe() {
    return new RegExp(`${escapeRegExp(FILE_NAME_MARKER)}[\\s\\S]*?${escapeRegExp(FILE_NAME_MARKER)}`, 'gi');
  }

  function sanitizeFileName(s) {
    return String(s ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(getFileNameMarkerRe(), '')
    .trim();
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

  /* 新目标格式：acg名称 + 原始文件名，直接拼接（不再用 [bgm] 包裹） */
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

  /* 判断是否需要改名：
   * 1) [bgm] 格式（历史遗留）  → 需要改
   * 2) 已经是 acg名称+ +文件名 格式（以 acg 名开头且有后续）→ 不需要改
   * 3) 原始文件名 → 需要改 */
  function needRename(currentName, acgName) {
    const raw = String(currentName || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!raw) return false;
    const acg = String(acgName || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!acg) return false;

    /* [bgm] 历史格式 → 需改 */
    if (stripMarkerBlock(raw) !== raw) return true;

    /* 新格式：`${acg} ${base}`（带空格） */
    if (raw.startsWith(acg + ' ')) {
      const suffix = raw.slice(acg.length + 1);
      if (suffix && suffix.trim()) return false;
    }

    /* 兼容旧格式：`${acg}${base}`（无空格直接拼） */
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

  /* DHHMM 编码校验：10000 ~ 79959（周一 0 点 ~ 周日 27:59） */
  function isDHHMMValue(v) {
    const n = Number(v);
    return Number.isInteger(n) && n >= 10000 && n <= 79959;
  }

  /* 把 DHHMM（周几+时分）折算为"本周期内最近一次该时间点"并与当前比较。
 * 返回 true=已过 / false=未到 / null=无法判断。
 * 4 点对齐：0:00~3:59 视为前一日 24:00~27:59。 */
  function dhhmmIsPassed(v, nowMs) {
    const n = Number(v);
    if (!isDHHMMValue(n)) return null;
    const now = nowMs != null ? new Date(nowMs) : new Date();
    let day = Math.floor(n / 10000);
    let hh = Math.floor(n / 100) % 100;
    const mm = n % 100;
    if (hh >= 24) {
      hh -= 24;
      day = day === 7 ? 1 : day + 1;
    }
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

  /* 是否应处理该行（用于 CD 判断、待转存队列）：
 * 1) row.资源 是 DHHMM 时间 → 按该时间是否已到判断
 * 2) row.资源 是链接型（URL）/空 / 其它 → 跳过"资源时间"判断，回退到 _airDate */
  function shouldIncludeRow(row) {
    if (!row) return true;
    const resVal = String(row.资源 ?? '').trim();
    if (resVal && isDHHMMValue(resVal)) {
      const passed = dhhmmIsPassed(resVal);
      if (passed != null) return passed;
    }
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

  function collectSavedInfos(records) {
    return Object.values(records || {})
    .flatMap(r => Array.isArray(r.fileInfos) ? r.fileInfos : []);
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

  /* 曾用名写入：把 oldName 追加到对应 fid 的记录 formerNames（去重）。
   * 遍历所有分享，找到第一个匹配 fid 的记录条目即写入。 */
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

  /* 过期清理（acg 清单已不含该分享的记录）：
   * 1) 清单不可用 / 无任何夸克链接 / 检测到清空请求 → 跳过，不动记录
   * 2) 记录数远多于清单数（> live + max(5, live*0.5)）→ 疑似清单严重不完整，跳过
   * 3) 在清单中 → 清除 obsoleteAt（曾标记过但清单又加回来了）
   * 4) 不在清单中：
   *    - 无 obsoleteAt → 打标记，等 7 天
   *    - 有 obsoleteAt 且已满 7 天 → 删除记录
   *    - 有 obsoleteAt 未满 7 天 → 保留 */
  function sweepObsoleteRecords() {
    const clearTs = Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
    if (clearTs > 0) {
      log('★ 过期清理：检测到清空请求（clearFlag > 0），跳过本次（等夸克端处理）');
      return { removed: 0, marked: 0, unmarked: 0 };
    }

    const bd = loadBangumiData();
    if (!bd || !Array.isArray(bd.rows) || !bd.rows.length) {
      log('★ 过期清理：acg.ripImprove 数据不可用，跳过（不删除任何记录）');
      return { removed: 0, marked: 0, unmarked: 0 };
    }
    const live = collectAllShareKeys(bd);
    if (!live.size) {
      log('★ 过期清理：清单中未解析到任何夸克链接，跳过（不删除任何记录）');
      return { removed: 0, marked: 0, unmarked: 0 };
    }

    const recs = gmGet(GM_RECORDS, {}) || {};
    const now = Date.now();
    const allKeys = Object.keys(recs);
    const recCount = allKeys.length;

    const tooMany = recCount > live.size + Math.max(5, Math.floor(live.size * 0.5));
    if (tooMany) {
      log(`★ 过期清理：记录 ${recCount} 远多于清单 ${live.size}，疑似清单严重不完整，本次跳过（不删除、不标记）`);
      return { removed: 0, marked: 0, unmarked: 0 };
    }

    let removed = 0, marked = 0, unmarked = 0;
    const removedKeys = [];
    const markedKeys = [];
    const unmarkedKeys = [];
    const ttlDays = Math.round(OBSOLETE_TTL_MS / 86400000);

    for (const key of allKeys) {
      const rec = recs[key];
      if (!rec || typeof rec !== 'object') continue;
      const norm = normalizeShareKey(key);
      const inLive = live.has(norm);

      if (inLive) {
        if (rec.obsoleteAt) {
          delete rec.obsoleteAt;
          unmarked++;
          unmarkedKeys.push(key);
        }
      } else {
        if (!rec.obsoleteAt || typeof rec.obsoleteAt !== 'number') {
          rec.obsoleteAt = now;
          marked++;
          markedKeys.push(key);
        } else if (now - rec.obsoleteAt >= OBSOLETE_TTL_MS) {
          delete recs[key];
          removed++;
          removedKeys.push(key);
        }
      }
    }

    if (marked || unmarked || removed) {
      gmSet(GM_RECORDS, recs);
    }

    if (markedKeys.length) {
      log(`★ 过期清理：${markedKeys.length} 条记录已不在清单中，开始 ${ttlDays} 天宽限期（到期后自动删除）：${markedKeys.join(', ')}`);
    }
    if (unmarkedKeys.length) {
      log(`★ 过期清理：${unmarkedKeys.length} 条记录重新出现在清单中，已清除过期标记：${unmarkedKeys.join(', ')}`);
    }
    if (removedKeys.length) {
      log(`★ 过期清理：${removedKeys.length} 条记录宽限期已过，已删除：${removedKeys.join(', ')}`);
    }
    if (!marked && !unmarked && !removed) {
      log(`★ 过期清理：${recCount} 条记录均在清单中，无需处理`);
    }

    return { removed, marked, unmarked };
  }

  /* ===== 分享页「是否已转存」判定 =====
   * 优先级：
   *   L1: fid（完全一致）
   *   L2: icon（同 fid 或同名+同 icon）
   *   L3: 当前最新名（页面 normalize 名 == 记录 name normalize 名）
   *   L4: 曾用名（页面 normalize 名 ∈ 记录 formerNames 的 normalize 名）
   *   L5: [bgm] 兜底：
   *       5a) 页面是 [bgm] 格式 → strip 后与记录 name/formerNames 的 strip 结果比较
   *       5b) 记录是 [bgm] 格式、页面是新格式 → 页面名以"记录 strip 后的原名"结尾
   *   L5 严格 sizeStr 双方都非空且相等，避免 endsWith 误判。 */
  function normalizeMtimeStr(s) {
    return String(s ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }

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

    /* L1：fid */
    if (fid) {
      const hit = savedInfos.find(si => si && si.fid && String(si.fid) === fid);
      if (hit) {
        out.saved = true; out.level = 1;
        if (wantReason) out.reason = `L1 fid=${fid} 命中「${hit.name}」`;
        return out;
      }
    }

    /* L2：icon */
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

    /* L3：当前最新名匹配（页面 normalize 名 == 记录 name normalize 名） */
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

    /* L4：曾用名匹配 */
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

    /* 5a：页面是 [bgm] 格式，剥离后与记录 name/formerNames 剥离后比较
     * 新增：记录是新格式 `${acg} ${base}` 时，通过 `endsWith(' ' + pageStripped)` 兜底匹配
     *       （覆盖"页面旧格式 [bgm]、记录新格式"的方向） */
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
    /* 5b：页面是新格式 `${acg} ${base}`（或原始名），记录是原始名 / [bgm] 历史格式 / 新格式
     * 命中条件（依次）：
     *   1. pageName === 记录剥离（base 完全相同）
     *   2. pageName 以 ' ' + 记录剥离 结尾（新格式 `acg base`）
     *   3. 记录有 [bgm]，pageName 以记录剥离结尾（旧格式无空格兼容，仅当 cStripped !== cRaw）
     * sizeStrict 保证 sizeStr 双方非空且相等，避免 endsWith 误判。 */
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
      const parts = [];
      parts.push(fid ? `L1 无同 fid` : `L1 无 fid`);
      parts.push(`L3 最新名未匹配`);
      parts.push(`L4 曾用名未匹配`);
      parts.push(`L5 [bgm]兜底未匹配`);
      out.reason = parts.join('；');
    }
    return out;
  }

  function isFileSaved(file, savedInfos) {
    return explainIsFileSaved(file, savedInfos, false).saved;
  }

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
      if (incomplete) {
        note = `扫描不完整（${files.length}/${expected || '?'}），本轮告警可能是扫描问题，而非记录失效`;
      } else if (savedInfosCount === 0) {
        note = clearFlag > 0
          ? `该分享无任何转存记录，且检测到清空请求（clearFlag=${clearFlag}）`
          : '该分享无任何转存记录（首次转存或记录被清空）';
      } else if (noRecordEntry.length === files.length) {
        note = `页面 ${files.length} 个文件在记录中均无同名条目（可能是新文件，不是记录失效）`;
      } else if (matchedButFailed.length === files.length) {
        note = `页面 ${files.length} 个文件在记录里有同名条目但匹配失败（请查看每条失败原因）`;
      } else {
        note = `页面 ${files.length} 个文件：${matchedButFailed.length} 个有同名但匹配失败，${noRecordEntry.length} 个在记录中不存在`;
      }

      const entry = {
        ts: Date.now(),
        time: new Date().toLocaleString(),
        source: opts.source || 'unknown',
        href: location.href,
        shareKey,
        shareId: extractShareId(location.href),
        totalFiles: files.length,
        expectedFiles: expected,
        incomplete,
        savedCount,
        savedInfosCount,
        recordKeys,
        recordKeysCount: recordKeys.length,
        clearFlag,
        note,
        files: results.map(r => ({
          name: r.file.name,
          sizeStr: r.file.sizeStr,
          mtime: r.file.mtime || '',
          fid: r.file.fid || '',
          iconSig: truncateStr(r.file.iconSig, 300),
          iconSigLen: String(r.file.iconSig || '').length,
          hasSameName: r.hasSameName,
          level: r.ex.level,
          result: r.ex.reason,
        })),
        savedInfos: (Array.isArray(savedInfos) ? savedInfos : []).map(si => ({
          name: si && si.name,
          sizeStr: si && si.sizeStr,
          mtime: (si && si.mtime) || '',
          fid: (si && si.fid) || '',
          formerNames: Array.isArray(si && si.formerNames) ? si.formerNames : [],
          iconSig: truncateStr(si && si.iconSig, 300),
          iconSigLen: String((si && si.iconSig) || '').length,
        })),
      };
      appendFullResaveDebug(entry);
      warn(`★ 全量重转 Debug 已记录：${note}`);
      return entry;
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

  /* ===== 虚拟滚动支持 ===== */
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

  async function scanAllRowsByScroll(qa, doc = document, opts = {}) {
    const useCache = opts.useCache === true;
    const key = opts.key || null;

    if (useCache && key) {
      const cached = getAllFilesCache(key);
      if (cached) {
        const expected0 = getShareFileCount(doc);
        if (expected0 && cached.length < expected0) {
          warn(` ⚠️ 缓存不完整（${cached.length}/${expected0}），忽略缓存并强制重扫`);
        } else {
          log(` ★ 复用缓存：${cached.length} 行`);
          return cached;
        }
      }
    }

    const maxMs = opts.maxMs || 40000;
    const expected = getShareFileCount(doc);

    if (isShareTableLoading(doc)) {
      log(` ⏳ 检测到表格仍在初始化加载，等待...`);
      await until(() => !isShareTableLoading(doc), 150, 15000);
    }

    const body = getTableBody(doc);
    const visibleRows = qa.scanFileRows(doc);
    const needFullScan = !!(expected && visibleRows.length < expected);

    /* 非虚拟滚动 且 不需要全表扫描 → 只扫可见区 */
    if (!body || (!isVirtualScrolling(body) && !needFullScan)) {
      if (useCache && key) setAllFilesCache(key, visibleRows);
      return visibleRows;
    }

    if (!body) {
      warn(` ⚠️ 无 .ant-table-body 但需要全扫（可见 ${visibleRows.length}/${expected}），只能返回可见区`);
      if (useCache && key) setAllFilesCache(key, visibleRows);
      return visibleRows;
    }

    log(` ★ 全表扫描（可见 ${visibleRows.length} / 期望 ${expected || '?'}${isVirtualScrolling(body) ? ' / 虚拟滚动' : ''}）`);

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
        visited.set(r.name, r);
      }
      return added;
    };

    body.scrollTop = 0;
    await qa.sleep(150);
    harvest();

    let lastScrollH = body.scrollHeight;
    let lastSize = visited.size;
    let stallCount = 0;
    const MAX_STALL_BOTTOM = 5;
    const MAX_STALL_MID = 5;

    while (Date.now() - t0 < maxMs) {
      if (expected && visited.size >= expected) break;

      const bodyH = body.clientHeight;
      const scrollH = body.scrollHeight;
      const curTop = body.scrollTop;
      const atBottom = curTop + bodyH >= scrollH - 8;

      if (atBottom) {
        if (hasLoadingMore()) {
          await qa.until(() => !hasLoadingMore(), 60, 1500);
        } else {
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

    const result = [...visited.values()];
    log(` ★ 滚动扫描：收集 ${result.length} 行（期望 ${expected || '?'}）`);

    /* 只在扫到行数 >= expected 或 expected 未知时才写缓存，避免缓存不完整数据 */
    if (useCache && key) {
      if (!expected || result.length >= expected) {
        setAllFilesCache(key, result);
      } else {
        warn(` ⚠️ 扫描不完整（${result.length}/${expected}），不写缓存`);
      }
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

  async function refreshShareFullCounts(qa, doc = document) {
    try {
      const key = currentCacheKey();
      const allFiles = (await scanAllRowsByScroll(qa, doc, { key, useCache: true }) || [])
      .filter(f => !isFolderFile(f));
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
      } catch { try { target.click(); } catch {} }

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
          log(`[桥接] 跨域 iframe 全屏展示 → 视为空间不足`);
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
    if (!ready) { warn(' ⚠️ 保存按钮未就绪'); return 'fail'; }

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

    if (!outcome) { warn(' ⚠️ 12s 内无任何结果信号'); return 'unknown'; }

    if (outcome.type === 'success') {
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
      await sleep(80);
      if (getHeaderCheckState(doc) === 'none') return { ok: true, tries: i + 1 };
    }
    return { ok: getHeaderCheckState(doc) === 'none', reason: 'not-cleared' };
  }

  /* ===== 列表页改名 ===== */
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
    .map(r => r.getAttribute('data-row-key') || '')
    .filter(Boolean);
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
          if (attempt < 2) { await sleep(500); continue; }
          return { ok: false, reason: `clear-incomplete(${getHeaderCheckState(doc)})` };
        }
      }

      await until(() => getSelectedFids(doc).length === 0, 100, 1500);

      let row = (file.row && file.row.isConnected) ? file.row : findRowByFid(file.fid, doc);
      if (!row) {
        try {
          const found = await scrollToRowByName(qa, doc, file.name, { cacheKey: currentCacheKey(), maxMs: 3000 });
          if (found) { row = found.row; file.row = found.row; }
        } catch {}
      }
      if (!row) {
        if (attempt < 2) { await sleep(500); continue; }
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
        if (attempt < 2) { await sleep(500); continue; }
        return { ok: false, reason: `${state}/${fids.length}` };
      }

      if (state === 'all') {
        const rows = qa.scanFileRows(doc) || [];
        const body = getTableBody(doc);
        const virtual = body && isVirtualScrolling(body);
        if (virtual || rows.length !== 1) {
          if (attempt < 2) { await sleep(500); continue; }
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
      const inputs = [...m.querySelectorAll('input')]
      .filter(i => i.isConnected && _isVisible(i) && !isRenamePanel(i));
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
        await sleep(150);
      }
    } catch {}
  }

  async function openRenameViaToolbar(qa, file, originalName, doc = document) {
    if (!file || !file.fid) return null;

    const sel = await resetSelectionToRow(qa, file, doc);
    if (!sel.ok) {
      warn(` ⚠️ 改名：单选复核未通过（${sel.reason}）→ 不点顶栏「重命名」`);
      return null;
    }

    const btn = findToolbarRenameButton(doc);
    if (!btn) { log('   ↳ 顶栏没有「重命名」按钮，放弃本行改名'); return null; }
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('ant-btn-disabled')) {
      warn(' ⚠️ 改名：顶栏「重命名」按钮处于禁用态，跳过');
      return null;
    }

    const STRAY_SEL = '.ant-modal, [role="dialog"], .ant-drawer-content, .ant-dropdown';
    const before = new Set([...doc.querySelectorAll(STRAY_SEL)]);
    log(` → 改名：点击顶栏「重命名」（已确认仅勾选 1 行）`);
    try { qa.realClick(btn); } catch (e) { warn(' ⚠️ 改名：点击顶栏「重命名」异常', e); return null; }

    const t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      const inline = findInlineRenameInput(originalName, doc);
      if (inline) { log(' ✓ 顶栏「重命名」进入行内编辑'); return inline; }
      const dlg = findNewRenameModal(before, originalName, doc);
      if (dlg) {
        log(` ✓ 顶栏「重命名」打开弹窗：${(dlg.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)}`);
        return dlg;
      }
      await sleep(150);
    }
    warn(' ⚠️ 改名：点了顶栏「重命名」但没等到弹窗/编辑框');
    await dismissStrayModals(qa, before, doc);
    return null;
  }

  async function openRenameDialog(qa, row, nameCell, originalName, doc = document) {
    if (!row || !row.isConnected) {
      const fresh = findListRowByName(qa, originalName, doc);
      row = fresh && fresh.row;
      if (!nameCell || !nameCell.isConnected) nameCell = getNameElInRow(row);
    }
    if (!row || !row.isConnected) { warn(` ⚠️ 改名：列表里找不到该行 —— ${originalName}`); return null; }

    const file = findListRowByName(qa, originalName, doc);
    if (!file || !file.fid) {
      warn(` ⚠️ 改名：找不到带 fid 的行 —— ${originalName}`);
      return null;
    }

    return await openRenameViaToolbar(qa, file, originalName, doc);
  }

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

  async function findExactNameAnywhere(qa, name, doc = document, maxMs = 4000) {
    const want = normExactName(name);
    if (!want) return null;
    const visible = (qa.scanFileRows(doc) || []).find(f => normExactName(f.name) === want);
    if (visible) return visible;
    try {
      const all = await scanAllRowsByScroll(qa, doc, { key: currentCacheKey(), useCache: false, maxMs }) || [];
      return all.find(f => normExactName(f.name) === want) || null;
    } catch { return null; }
  }

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
    let lastFullHit = false;
    let lastLog = 0;
    let scrolled = false;

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
        const hit = await findExactNameAnywhere(qa, newName, doc, 4000);
        lastFullHit = !!(hit && (!fid || !hit.fid || hit.fid === fid));
      }
      if (!seen) seen = lastFullHit;

      if (seen) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) {
          log(` ✓ 改名：按完整名确认到「${newName}」`);
          return true;
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
      await sleep(300);
    }

    const finalHit = await findExactNameAnywhere(qa, newName, doc);
    if (finalHit && (!fid || !finalHit.fid || finalHit.fid === fid)) {
      log(` ✓ 改名：超时前一刻按完整名确认到「${newName}」`);
      return true;
    }
    if (oldName) {
      const oldHit = await findExactNameAnywhere(qa, oldName, doc);
      if (oldHit) return false;
    }
    return null;
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
      pressKeyOn(input, 'Escape');
      await until(() => editorClosed(), 120, 1500);
      warn(' ⚠️ 改名：行内编辑未提交，已按 Esc 放弃');
      return 'fail';
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
    const modalEl = (scope && scope.tagName !== 'INPUT' && scope.isConnected) ? scope : null;
    const closed = await qa.until(
      () => (modalEl ? (!modalEl.isConnected || !_isVisible(modalEl)) : !findRenameModal(originalName, doc)),
      150, 6000
    );
    if (!closed) {
      warn(' ⚠️ 改名：确认后弹窗未关闭，已按 Esc 收尾');
      try { pressKeyOn(doc.body, 'Escape'); } catch {}
      await sleep(200);
      return 'fail';
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

  async function renameOneRow(qa, m, doc = document) {
    const row = (m.row && m.row.isConnected) ? m.row : ((findListRowByName(qa, m.old, doc) || {}).row || null);
    const editor = await openRenameDialog(qa, row, m.nameEl || getNameElInRow(row), m.old, doc);
    if (!editor) { warn(` ⚠️ 改名：打不开改名编辑器 —— ${m.old}`); return false; }

    const r = await applyRenameInDialog(qa, editor, m.old, m.next, doc, m.fid || '');
    if (r === 'fail' || r === false) {
      try {
        const close = editor.querySelector && editor.querySelector('.ant-modal-close, .ant-drawer-close');
        if (close) qa.realClick(close);
        else if (editor.blur) editor.blur();
      } catch {}
      return false;
    }

    const verdict = await confirmRenamedInList(qa, {
      fid: m.fid || '', oldName: m.old, newName: m.next, doc, budgetMs: 45000,
    });

    if (verdict === true) {
      log(' ✓ 改名：列表已确认新名');
      await until(() => !isShareTableLoading(doc), 150, 5000);
      await sleep(300);
      return true;
    }
    if (verdict === false) { warn(` ⚠️ 改名：确认没改成 —— ${m.old}`); return false; }

    const oldStill = await findExactNameAnywhere(qa, m.old, doc, 3000);
    if (!oldStill) {
      log(` ✓ 改名：旧名已不在列表，视为改名成功 —— ${m.old} → ${m.next}`);
      await until(() => !isShareTableLoading(doc), 150, 5000);
      await sleep(300);
      return true;
    }
    warn(` ⚠️ 改名：45s 内无法确认是否改成 —— ${m.old} → ${m.next}`);
    return false;
  }

  async function applyListRenames(qa, plan, opts = {}) {
    const doc = opts.doc || document;
    const waitMs = Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 8000;
    const entries = Array.isArray(plan) ? plan.filter(x => x && x.old && x.next) : [];
    if (!entries.length) { log('★ 改名：无需要改名的文件'); return { renamed: 0, failed: 0, skipped: 0, confirmed: [], failedEntries: [], pairs: [] }; }

    log(`★ 改名：待改名 ${entries.length} 个`);
    for (const e of entries) log(` - ${e.old}  →  ${e.next}`);

    let renamed = 0, failed = 0, skipped = 0;
    const confirmed = [];
    const failedEntries = [];

    const doOne = async (e, label) => {
      await until(() => !isShareTableLoading(doc), 150, 10000);
      await sleep(300);

      try {
        await clearAllViaHeader(qa, doc);
        await until(() => getHeaderCheckState(doc) === 'none', 100, 2000);
      } catch {}

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
      if (!loaded) {
        const alreadyNew = findListRowByName(qa, e.next, doc);
        if (alreadyNew) {
          log(` ↺ 改名：${label} 已是目标名，跳过`);
          return { ok: true, missing: false, alreadyDone: true };
        }
        warn(` ⚠️ 改名：${label} 列表里找不到该文件 —— ${e.old}`);
        return { ok: false, missing: true };
      }
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
      const r = await renameOneRow(qa, { row: loaded.row, nameEl: getNameElInRow(loaded.row), old: oldName, next: e.next, fid }, doc);
      if (r) {
        const row = findRowByExactName(qa, e.next, doc);
        confirmed.push({ old: oldName, next: e.next, fid: row ? row.fid : fid });
        log(` ✓ 改名 ${label} ${oldName} → ${e.next}`);
      } else {
        warn(` ✗ 改名失败 ${label} ${oldName}`);
      }

      try {
        await clearAllViaHeader(qa, doc);
        await until(() => getHeaderCheckState(doc) === 'none', 100, 2000);
      } catch {}
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

    if (failedEntries.length) {
      log(`★ 改名：第一趟后仍有 ${failedEntries.length} 个没成功，等待列表稳定后重试…`);
      await sleep(2500);
      await until(() => !isShareTableLoading(doc), 150, 10000);
      await sleep(500);
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
      warn(` ⚠️ 改名：${failedEntries.length} 个文件最终未确认改名成功：`
           + failedEntries.map(e => e.old).join('、'));
    }

    try { qa.refreshGray(); } catch {}
    log(`★ 改名完成：成功 ${renamed}，失败 ${failed}，跳过 ${skipped}`);
    return { renamed, failed, skipped, confirmed, failedEntries, pairs: [] };
  }

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

    const rep = await applyListRenames(qa, [{ old: f.name, next, fid: f.fid }]);
    if (rep.renamed) {
      alert(`✅ 改名成功\n\n${f.name}\n→ ${next}`);
    } else {
      alert(`❌ 改名未确认成功（成功 ${rep.renamed} / 失败 ${rep.failed} / 跳过 ${rep.skipped}）`);
    }
  }

  function runRenameDiagnose(qa, doc = document) {
    const lines = [];
    const files = (qa.scanFileRows(doc) || []).filter(f => f.fid && f.row && !isFolderFile(f));
    lines.push(`可见文件行：${files.length}`);

    const f = files[0];
    if (!f) {
      const msg = lines.join('\n') + '\n\n当前可见区没有文件行';
      log('=== 改名诊断 ===\n' + msg);
      alert(msg);
      return;
    }

    const cell = getNameCellOnly(f.row);
    lines.push(`首个文件：${f.name}`);
    lines.push(`fid：${f.fid}`);
    lines.push(`mtime：${f.mtime || '（无）'}`);
    lines.push(`行 class：${f.row.className}`);
    lines.push(`名字单元格：${cell ? `<${cell.tagName.toLowerCase()} class="${cell.className}">` : '未找到 .filename-text'}`);
    if (cell) {
      lines.push(`title：${cell.getAttribute('title')}`);
      const style = (cell.ownerDocument.defaultView || window).getComputedStyle(cell);
      lines.push(`样式：pointer-events=${style.pointerEvents}`);
    }
    const fit = fitAcgName('测试改名', f.name);
    lines.push(`改名目标名示例：${fit.name || '（构不出）'}${fit.truncated ? '（会被截短）' : ''}`);
    lines.push(`needRename(当前名, '测试改名') = ${needRename(f.name, '测试改名')}`);

    const tbRename = findToolbarRenameButton(doc);
    lines.push(`顶栏「重命名」按钮：${tbRename ? '已找到' : '未找到'}`);
    lines.push(`表头全选状态：${getHeaderCheckState(doc)}`);
    lines.push(`可见选中行：${getSelectedFids(doc).length}`);

    const msg = lines.join('\n');
    log('=== 改名诊断 ===\n' + msg);
    alert(msg);
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
      await sleep(80);
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

    const headerState = getHeaderCheckState(doc);
    log(` 表头状态：${headerState}；目标：${trueCount} 勾选 / ${falseCount} 取消`);

    if (trueCount === totalCount && headerState === 'all') {
      return { ok: true, applied: 0, failed: 0, method: 'header-all-satisfied' };
    }
    if (falseCount === totalCount && headerState === 'none') {
      return { ok: true, applied: 0, failed: 0, method: 'header-none-satisfied' };
    }

    if (trueCount > 0 && trueCount < totalCount / 2) {
      log(` ★ 少量勾选（${trueCount}/${totalCount}），走「表头全不选 → 单独勾」`);
      if (headerState !== 'none') {
        const cls = await clearAllViaHeader(qa, doc);
        if (!cls.ok) {
          warn(` ⚠️ 表头清空失败（${cls.reason}），回退逐行模式`);
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
        await sleep(80);
      }
      return {
        ok: failed.length === 0,
        applied: ok, failed: failed.length,
        details: failed.map(n => ({ name: n })),
        method: 'header-clear+scroll-select',
      };
    }

    const anyTrue = trueCount > 0;
    const targetHeaderState = anyTrue ? 'all' : 'none';

    if (headerState !== targetHeaderState) {
      const hdr = await setHeaderCheckbox(qa, doc, anyTrue);
      if (!hdr.ok) {
        warn(` ⚠️ 表头复选框操作失败（${hdr.reason}），回退逐行模式`);
        return await applyTargetChecks(qa, doc, targets, { cacheKey });
      }
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
  /* 等表格稳定：有 expected 时必须 cnt >= expected 才算稳定；
   * cnt 稳定但 < expected 时继续等（不提前返回），等超时再返回实际行数，
   * 避免 ant-table 分批渲染时只拿到 1 行就返回。 */
  async function waitTableStable(qa, doc = document, maxMs = 20000) {
    const t0 = Date.now();
    const expected = getShareFileCount(doc);
    log(` 头部显示共 ${expected == null ? '?' : expected} 个；等待表格稳定...`);

    await until(() => !isShareTableLoading(doc), 150, maxMs);
    log(` 表格加载层已消失，等待行数稳定...`);

    let lastCount = -1;
    let stableHits = 0;
    let lastWarn = 0;
    const remain = () => Math.max(0, maxMs - (Date.now() - t0));

    const files = await until(() => {
      if (isShareTableLoading(doc)) { lastCount = -1; stableHits = 0; return null; }

      const rows = qa.scanFileRows(doc);
      const cnt = rows.length;

      if (expected && cnt >= expected && cnt === lastCount) {
        if (++stableHits >= 2) return rows;
      } else if (!expected && cnt > 0 && cnt === lastCount) {
        if (++stableHits >= 4) return rows;
      } else {
        if (expected && cnt > 0 && cnt < expected && Date.now() - lastWarn > 3000) {
          lastWarn = Date.now();
          log(`  ⏳ 扫描到 ${cnt} 行 < 头部 ${expected}，继续等待...`);
        }
        stableHits = 0;
      }
      lastCount = cnt;
      return null;
    }, 300, remain());

    if (files) return files;
    const cur = qa.scanFileRows(doc);
    log(` 等待超时，当前扫描到 ${cur.length} 行（头部 ${expected == null ? '?' : expected}）`);
    return cur;
  }

  async function waitForListRowsStable(qa, doc, expectedMin, timeout = 10000) {
    const t0 = Date.now();
    const expMin = Math.max(1, Number(expectedMin) || 1);
    let last = -1, stable = 0;

    while (Date.now() - t0 < timeout) {
      if (isShareTableLoading(doc)) { last = -1; stable = 0; await sleep(200); continue; }
      const cnt = (qa.scanFileRows(doc) || []).length;
      if (cnt === last && cnt > 0) {
        stable++;
        if (cnt >= expMin && stable >= 2) {
          log(` ★ 刷新后列表稳定：${cnt} 行（期望 ≥${expMin}）`);
          return cnt;
        }
        if (cnt < expMin && stable >= 6) {
          log(` ⏱ 刷新后行数稳定但少于预期：${cnt} < ${expMin}，继续`);
          return cnt;
        }
      } else {
        stable = 0;
      }
      last = cnt;
      await sleep(200);
    }
    const finalCnt = (qa.scanFileRows(doc) || []).length;
    log(` ⏱ 刷新后等待超时：当前 ${finalCnt} 行（期望 ≥${expMin}）`);
    return finalCnt;
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
      if (result === 'success') {
        savedFiles.push(...batch);
        recorded = true;
      } else if (result === 'unknown') {
        if (isSuccessModalPresent(doc)) {
          savedFiles.push(...batch);
          recorded = true;
        } else {
          warn(` ⚠️ 批 ${bi + 1} 结果 unknown 且未见成功模态框`);
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

    let files = await waitTableStable(qa, doc, 20000);
    files = (files || []).filter(f => !isFolderFile(f));
    if (!files.length) return { ok: false, kind: 'no-files', files: [] };

    await sleep(300);

    files = await scanAllRowsByScroll(qa, doc, { key: cacheKey, useCache: true });
    files = (files || []).filter(f => !isFolderFile(f));
    if (!files.length) return { ok: false, kind: 'no-files', files: [] };

    /* 扫描完整性校验：扫到的行数必须 >= 头部显示的总数。
     * 如果不足，强制二次全表扫描（不用缓存），避免因 ant-table 分批渲染
     * 导致只扫到部分文件，进而把"已转存"误判为"未转存"引发重转。 */
    const expected = getShareFileCount(doc);
    if (expected && files.length < expected) {
      warn(` ⚠️ 首次扫描不完整（${files.length}/${expected}），强制全表扫描一次...`);
      await sleep(500);
      files = await scanAllRowsByScroll(qa, doc, { key: cacheKey, useCache: false, maxMs: 40000 });
      files = (files || []).filter(f => !isFolderFile(f));
      if (files.length < expected) {
        warn(` ⚠️ 二次扫描仍不完整（${files.length}/${expected}），本轮按已扫到的 ${files.length} 个处理；未扫到的文件可能被重复转存`);
      } else {
        log(` ✓ 二次扫描完整：${files.length} 个`);
      }
    }

    const shareKey = normalizeShareKey(location.href);
    const clearFlagAtStart = Number(GM_getValue(GM_CLEAR_FLAG, 0) || 0);
    const savedInfos = healShareRecords(shareKey, files);

    try {
      const recsAll = loadRecords({ consumeClear: false });
      const allKeys = Object.keys(recsAll);
      log(` 分享 key：${shareKey}`);
      log(` 记录 keys（${allKeys.length}）：${allKeys.join(', ') || '（空）'}`);
    } catch {}

    const saved = files.filter(f => isFileSaved(f, savedInfos));
    const pending = files.filter(f => !isFileSaved(f, savedInfos));
    const excludeNames = new Set(saved.map(f => f.name));

    log(` 共 ${files.length} 个（已排除文件夹）：已转存 ${saved.length}，待转存 ${pending.length}`);
    for (const f of files) {
      log(` - ${f.name} sizeStr="${f.sizeStr}" mtime="${f.mtime || '-'}" fid="${f.fid || '-'}" → ${isFileSaved(f, savedInfos) ? 'SAVED' : 'PENDING'}`);
    }

    /* 全量重转 Debug：只在"扫描完整 + 全部未命中"时记录。
     * 扫描不完整时跳过 debug，避免假报警。 */
    if (files.length > 0 && saved.length === 0) {
      const incomplete = !!expected && files.length < expected;
      maybeSaveFullResaveDebug(qa, files, savedInfos, {
        source: opts.source || 'child-task',
        clearFlagAtStart,
        incomplete,
        expected,
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
    startSharePolling(qa);

    const finish = (kind, extra = {}) => {
      setResult(shareId, { kind, ...extra });
      log(`★ [子任务] 结果已写入：${kind}`);
      setTimeout(() => { try { window.close(); } catch {} }, 800);
    };

    let prep;
    try {
      prep = await prepareShareSave(qa, document, { source: 'child-task' });
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
          const item = {
            name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
            fid: f.fid || '', mtime: f.mtime || '',
          };
          upsertFileInfo(merged, item);
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

  /* ===== 个人页：点击页面内刷新 ===== */
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
      warn('点击刷新按钮失败：', e);
      try { target.click(); return true; } catch { return false; }
    }
  }

  async function clickListRefreshAndWait(qa, doc = document, opts = {}) {
    const appearedTimeout = opts.appearedTimeout ?? 3000;
    const settleTimeout = opts.settleTimeout ?? 12000;

    const ok = await clickListRefresh(qa, doc);
    if (!ok) return false;

    const tableWrap = doc.querySelector('.ant-table-wrapper');
    if (!tableWrap) { await sleep(800); return true; }

    const appeared = await until(
      () => !!tableWrap.querySelector('.ant-spin-spinning'),
      100, appearedTimeout
    );

    if (appeared) {
      await until(() => !tableWrap.querySelector('.ant-spin-spinning'), 150, settleTimeout);
    } else {
      await sleep(800);
    }
    return true;
  }

  /* ===== 图标签名 ===== */
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

  /* 转存记录与列表行的匹配（用于"转存后定位行去改名"）。
   * 只处理本轮新转存记录，saved.name 即当时记录的名字（原始文件名）。
   * 优先 icon / 快照 / 名字；名字部分同时考虑 [bgm] 新旧格式（通过 normalizeFileName 剥离） */
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
      if (rs.suffix > 0 && getComparableFileName(rs.base) === wantName) {
        baseCand.push({ r, cur, suffix: rs.suffix });
      }
    }
    const exactAlreadySaved = Array.isArray(savedBefore)
    && savedBefore.some(si => isSameFile(si, { name: savedName, sizeStr: (saved && saved.sizeStr) || '', iconSig: (saved && saved.iconSig) || '' }));

    if (isIdentifiableIconSig(savedIcon)) {
      const sameIcon = rows.filter(r => sameIconSig(r.iconSig, savedIcon));
      if (sameIcon.length) {
        if (iconFid(savedIcon)) {
          if (sameIcon.length === 1) {
            log(` ★ 改名：${savedName} 按 icon（fid=${iconFid(savedIcon)}）唯一命中`);
            return mk(sameIcon[0], 'icon-fid');
          }
          log(` ★ 改名：${savedName} 的 icon 命中 ${sameIcon.length} 行`);
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
      } else {
        log(` ★ 改名：${savedName} 的 icon 在列表里没有匹配行`);
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
        log(` ★ 改名：${savedName} 按"转存前快照"定位到新行 ${pick.cur}（fid=${pick.r.fid}）`);
        return mk(pick.r, 'new-fid');
      }
      if (allCand.every(c => c.r && c.r.fid && beforeFids.has(c.r.fid))) {
        log(` ★ 改名：${savedName} 的候选行在转存前就都存在`);
      }
    }

    if (allCand.length === 1) return mk(allCand[0].r, 'name-only');
    if (exactAlreadySaved && suffixed.length) return mk(pickMaxSuffix(suffixed).r, 'name');

    if (exactCand.length && baseCand.length) {
      warn(` ⚠️ 改名：${savedName} 同时存在 ${exactCand.length} 个同名行与 ${baseCand.length} 个带后缀行 → 跳过`);
      lastMatchReason = 'ambiguous';
      return null;
    }

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
        const why = conflict.has(entry.url) ? `名称冲突（${conflict.get(entry.url)}）` : '清单里没有该分享的最终名称';
        log(` ★ 改名：跳过 ${entry.url} —— ${why}`);
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
          if (lastMatchReason === 'ambiguous') {
            ambiguous.push(savedName);
            log(` ★ 改名：${savedName} 有多行同名/带后缀 → 跳过`);
          } else {
            const exists = !!matchSavedToListRow(f, listRows, alreadySaved, { beforeFids });
            unmatched.push(savedName);
            log(exists
                ? ` ★ 改名：${savedName} 对应的行已被另一个同批文件占用，跳过`
                : ` ★ 改名：列表里找不到 ${savedName} 对应的行`);
          }
          continue;
        }
        if (m.row) { usedRows.add(m.row); if (m.row.fid) usedFids.add(m.row.fid); }
        items.push({ savedName, acgName, currentName: m.currentName, base: m.base, row: m.row, how: m.how });
      }
    }
    if (!items.length) {
      const empty = [];
      empty.unmatched = unmatched;
      empty.ambiguous = ambiguous;
      empty.noName = noName;
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

      if (conflictNames.has(it.base)) {
        log(` ★ 改名：跳过 ${oldName} —— 同名文件对应了不同的 acg 名称`);
        ambiguous.push(oldName);
        continue;
      }
      const name = targetByBase.get(it.base);
      if (!name) { notRenamed.push(oldName); continue; }

      /* 目标格式：acg 名称 + 原始文件名（剥离 [bgm] 后的）
       * it.base 已是 stripMarkerBlock 后的原始文件名，可以直接作为 base。 */
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
      if (it.how !== 'icon') log(`   ↳ ${oldName} 非 icon 命中（matchedBy=${it.how}），目标名 ${next}`);
    }
    out.unmatched = notRenamed;
    out.ambiguous = ambiguous;
    out.noName = noName;
    return out;
  }

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
        try { r = await saveShareUrlViaTab(qa, url); }
        catch (e) { warn(`处理失败：${url}`, e); continue; }

        const key = normalizeShareKey(url);
        if (r.kind === 'success' || r.kind === 'partial') {
          if (r.kind === 'success') successCount++;
          else partialCount++;

          const recs = loadRecords();
          const prev = recs[key] || {};
          const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
          for (const f of (r.savedFiles || [])) {
            const item = {
              name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
              fid: f.fid || '', mtime: f.mtime || '',
            };
            upsertFileInfo(merged, item);
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
            warn(`⚠️ 部分成功（${(r.savedFiles || []).length}/${r.totalPlanned}）：${url}`);
          } else {
            log(`✅ 已记录 ${merged.length} 条到 ${key}`);
          }

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
        log('★ 有新转存，点击页面内刷新按钮触发列表更新...');
        await sleep(500);

        const ok = await clickListRefreshAndWait(qa, document, {
          appearedTimeout: 3000,
          settleTimeout: 12000,
        });
        if (ok) log('✓ 已点击页面内刷新按钮');
        else warn('⚠️ 未找到页面内刷新按钮');
        if (ok) {
          const savedTotalForSnap0 = savedByUrl.reduce((n, en) => n + ((en && en.files) || []).length, 0);
          const expectedMin = preRows.length + savedTotalForSnap0;
          await waitForListRowsStable(qa, document, expectedMin, 10000);
        }
        let plan = [];
        let planBuildOk = true;
        let planUnmatched = [];
        let planAmbiguous = [];
        let planNoName = [];
        try {
          let listRows = [];
          try {
            listRows = await scanAllRowsByScroll(qa, document, { key: currentCacheKey(), useCache: false }) || [];
          } catch (e) { warn('⚠️ 改名：全表扫描失败', e); listRows = qa.scanFileRows(document) || []; }
          log(` ★ 改名：列表共扫到 ${listRows.length} 行用于匹配`);
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
        } catch (e) { warn('⚠️ 改名计划构建失败', e); planBuildOk = false; }
        if (!planBuildOk) {
          qa.setStatus('改名计划构建失败，已暂停下载', 'error');
          warn('⛔ 改名计划构建失败：本轮不下载');
        }

        const savedTotal = savedByUrl.reduce((n, en) => n + ((en && en.files) || []).length, 0);
        if (savedTotal && planUnmatched.length) {
          warn(` ⛔ 改名：${planUnmatched.length} 个已转存文件在列表里没找到对应行：${planUnmatched.join('、')}`);
        }
        if (planAmbiguous.length) {
          warn(` ⚠️ 改名：${planAmbiguous.length} 个文件无法唯一判定：${planAmbiguous.join('、')}`);
        }
        if (planNoName.length) {
          warn(` ⚠️ 改名：${planNoName.length} 个文件清单里没有最终名称：${planNoName.join('、')}`);
        }

        if (plan.length && ok) {
          await waitRowsForRename(qa, plan);
        } else if (plan.length) {
          warn(` ★ 改名：未成功刷新，直接在当前列表上尝试改名`);
        }

        let renameReport = { renamed: 0, failed: 0, skipped: 0, pairs: [], confirmed: [], failedEntries: [] };
        let renameStepOk = true;
        if (plan.length) {
          try {
            renameReport = await applyListRenames(qa, plan, { waitMs: ok ? 8000 : 1500 });
          } catch (e) { warn('⚠️ 改名过程异常', e); renameStepOk = false; }

          /* 改名成功（含曾用名）后：
           * 1) 更新下载记录的 name
           * 2) 把 old 名写入分享记录的 formerNames */
          if (renameReport.renamed > 0) {
            const confirmedWithFid = (renameReport.confirmed || []).filter(c => c && c.fid);
            renameReport.pairs = confirmedWithFid.map(c => ({ fid: c.fid, old: c.old, next: c.next }));

            /* 写曾用名 */
            let wroteCount = 0;
            for (const c of confirmedWithFid) {
              try {
                if (recordFormerNameByFid(c.fid, c.old)) wroteCount++;
              } catch (e) { warn('⚠️ 写曾用名异常', e); }
            }
            if (wroteCount) log(` ★ 改名：写入曾用名 ${wroteCount} 条`);

            try {
              const n = refreshDlRecordsAfterRename(renameReport.pairs);
              if (n) log(` ★ 改名：同步 ${n} 条下载记录到新名`);
            } catch (e) { warn('⚠️ 同步下载记录失败', e); }
          }
        } else if (!planUnmatched.length && !planAmbiguous.length) {
          log('★ 改名：本次无需改名');
        } else {
          log('★ 改名：没有可执行的改名计划');
        }

        const confirmedCount = (renameReport.confirmed || []).length;
        const notConfirmed = (renameReport.failed || 0) + (renameReport.skipped || 0);
        if (plan.length || planUnmatched.length || planAmbiguous.length || planNoName.length) {
          log(`★ 改名结果：按完整名确认 ${confirmedCount} / 应改名 ${plan.length + planUnmatched.length + planAmbiguous.length}`
              + (planNoName.length ? `，清单无名称 ${planNoName.length}` : '')
              + (notConfirmed ? `，本次未确认 ${notConfirmed}` : ''));
        }
        if (planNoName.length) {
          qa.setStatus('注意：有文件清单里没有名称，按原名下载', 'running');
        }

        const renameAllConfirmed = planBuildOk && renameStepOk
        && planUnmatched.length === 0
        && planAmbiguous.length === 0
        && (renameReport.failedEntries || []).length === 0
        && confirmedCount >= plan.length;
        renameAllConfirmedOut = renameAllConfirmed;
        hadRenamePlan = plan.length > 0 || planUnmatched.length > 0 || planAmbiguous.length > 0;

        await sleep(600);

        if (renameAllConfirmed) {
          releaseBusy();
          if (qa.isPaused && qa.isPaused()) {
            log('⏸ 夸克助手已暂停，跳过自动下载触发');
          } else if (typeof qa.autoDownloadWorkflow === 'function') {
            log('★ 触发下载（改名已确认）...');
            await qa.autoDownloadWorkflow();
            log('★ 下载流程已结束');
          } else {
            warn('⚠️ quarkAssistant.autoDownloadWorkflow 不可用');
          }
        } else {
          const failedNames = (renameReport.failedEntries || []).map(e => e.old);
          const allBad = [...new Set([...failedNames, ...planUnmatched, ...planAmbiguous])];
          warn(`⛔ 改名未全部确认（已确认 ${confirmedCount} / 计划 ${plan.length}，未匹配 ${planUnmatched.length}`
               + `${planBuildOk ? '' : '，改名计划构建失败'}），已跳过下载：${allBad.join('、') || '（见上方日志）'}`);
          qa.setStatus('改名未确认，已暂停下载', 'error');
          alert(`⚠️ 改名未全部确认，已跳过下载并保持本页。\n\n`
                + `已按完整名（含曾用名）确认：${confirmedCount} / 计划 ${plan.length}\n`
                + (planUnmatched.length ? `列表里没找到对应行（未改名）：${planUnmatched.join('、')}\n` : '')
                + (planAmbiguous.length ? `无法唯一判定是哪一行：${planAmbiguous.join('、')}\n` : '')
                + (planNoName.length ? `清单里没有最终名称（将按原名下载）：${planNoName.join('、')}\n` : '')
                + (allBad.length ? '\n' : '')
                + `可在文件名上手动改名后，重新点「▶️ 转存」。`);
        }

        if (renameAllConfirmed) {
          if (!ok) {
            warn('⚠️ 未找到页面内刷新按钮，回退整页重载');
            await sleep(1000);
            location.reload();
          }
        } else if (!ok) {
          warn('⚠️ 未找到页面内刷新按钮且改名未确认：不重载页面');
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
      if (renameAllConfirmedOut || !hadRenamePlan) {
        releaseBusy();
      } else {
        warn('⛔ 改名未全部确认：保持忙碌标志');
      }
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
        source: 'save-current-page',
        clearFlagAtStart,
      });
    }

    if (!scopePending.length) {
      alert(
        `范围内所有文件都已转存（范围 ${scope.length} 个）\n\n` +
        `跳过（${scope.length}）：${fmtNames(scope.map(f => f.name))}`
      );
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
          const item = {
            name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
            fid: f.fid || '', mtime: f.mtime || '',
          };
          upsertFileInfo(merged, item);
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
        if (summary.failedReasons.includes('space')) title = '❌ 空间不足';
        else if (summary.failedReasons.includes('over_limit')) title = '❌ 超过转存限额';
        else if (summary.failedReasons.includes('check-failed') || summary.failedReasons.includes('still-unchecked')) title = '❌ 勾选状态设置失败';
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
    await refreshShareFullCounts(qa);
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
      log(` 表头 partial，滚动收集所有勾选行...`);
      const checkedAll = await scanCheckedRowsByScroll(qa, document, { cacheKey });
      if (!checkedAll.length) { usingAll = true; scope = allFiles; }
      else { usingAll = false; scope = checkedAll; }
    }

    const msg = usingAll
      ? `无勾选，标记全部 ${allFiles.length} 个文件为已转存？`
      : `标记勾选的 ${scope.length} 个文件为已转存？`;
    if (!confirm(msg)) return;

    const recs = loadRecords();
    const prev = recs[url] || {};
    const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
    let added = 0;
    for (const f of scope) {
      const item = {
        name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig,
        fid: f.fid || '', mtime: f.mtime || '',
      };
      if (upsertFileInfo(merged, item)) added++;
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
      if (!overlay.querySelector('#acgrip-quark-section')) {
        const host = overlay.querySelector('#lastTableHost');
        if (host) injectQuarkSection(host);
      }
      injectTriggerQuarkButton();
    };
    new MutationObserver(tryInject).observe(document.body, { childList: true, subtree: true });
    tryInject();
  }

  function injectTriggerQuarkButton() {
    const airedBtn = document.getElementById('openAiredResourceBtn');
    if (!airedBtn) return;
    const bar = airedBtn.parentElement;
    if (!bar) return;
    if (bar.querySelector('#acgrip-trigger-quark-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'acgrip-trigger-quark-btn';
    btn.textContent = '立即转存';
    btn.title = '立即触发夸克转存（忽略 CD）';
    btn.addEventListener('click', () => {
      try {
        const r = runQuarkAutoTrigger({ force: true });
        if (r && r.triggered) {
          alert(`已打开夸克处理 ${r.count} 个链接`);
        } else {
          const reasonMap = {
            'no-folder': '未设置夸克文件夹路径',
            'no-data': '无 bangumiData',
            'no-urls': '清单中没有夸克链接',
            'all-cd': '所有链接仍在 CD 内',
          };
          alert('未触发：' + (reasonMap[r && r.reason] || (r && r.reason) || '未知原因'));
        }
      } catch (e) {
        alert('转存触发失败：' + (e && e.message || e));
      }
    });
    bar.appendChild(btn);
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
    /* 每 6 小时检查一次：处理"宽限期到期"的情况；用户长时间开着 acg 页面也能触发清理 */
    setInterval(() => { try { sweepObsoleteRecords(); } catch (e) { warn('过期清理失败', e); } }, 6 * 60 * 60 * 1000);
    try {
      unsafeWindow.acgripQuarkBridge = {
        version: '1.2.5',
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

  async function ensurePreflightCleanupDone(qa, opts = {}) {
    const tag = opts.tag || 'trigger';

    if (!qa || typeof qa.runPreflightCleanup !== 'function') {
      warn(`⛔ [${tag}] 预清理不可用：quarkAssistant.runPreflightCleanup 不存在。`
           + `请把 QuarkAutoAssistant 更新到 ${MIN_QA_VERSION.join('.')}+ 后再试。`);
      try { qa && qa.setStatus && qa.setStatus(`请更新夸克助手到 ${MIN_QA_VERSION.join('.')}+`, 'error'); } catch {}
      return { ok: false, skipped: true, reason: 'api-missing' };
    }

    const verCheck = isQAVersionOk(qa);
    if (!verCheck.ok) {
      warn(`⛔ [${tag}] QuarkAutoAssistant 版本不满足要求：当前 ${verCheck.ver}（${verCheck.reason}）。`);
      try { qa.setStatus && qa.setStatus(`助手版本过低(${verCheck.ver})`, 'error'); } catch {}
      return { ok: false, skipped: true, reason: 'version-too-old', version: verCheck.ver };
    }

    warn(`★ [${tag}] 预清理：调用 quarkAssistant.runPreflightCleanup（force=true，最多等 30s）...`);
    try { qa.setStatus && qa.setStatus('预清理中...', 'running'); } catch {}
    try { qa.setProgress && qa.setProgress('-'); } catch {}

    const t0 = Date.now();
    let pr;
    try {
      pr = await qa.runPreflightCleanup({ tag, listWaitMs: 30000, force: true });
    } catch (e) {
      warn(`⚠️ [${tag}] 预清理异常`, e);
      pr = { ok: false, skipped: true, reason: 'exception:' + String(e && e.message || e) };
    }
    warn(`★ [${tag}] 预清理返回（耗时 ${Date.now() - t0}ms）：${JSON.stringify(pr)}`);

    if (!pr) {
      warn(`⛔ [${tag}] 预清理未返回结果，本轮不打开子任务`);
      return { ok: false, skipped: true, reason: 'no-result' };
    }
    if (pr.skipped) {
      if (pr.reason === 'recently-done') {
        warn(`★ [${tag}] 预清理：近期已清理，视为完成，继续`);
        return pr;
      }
      if (pr.reason === 'paused') {
        warn(`⏸ [${tag}] 预清理：暂停中`);
        return pr;
      }
      warn(`⛔ [${tag}] 预清理未完成（reason=${pr.reason || 'unknown'}），本轮不打开子任务`);
      try { qa.setStatus && qa.setStatus(`预清理未完成(${pr.reason || 'unknown'})`, 'error'); } catch {}
      return pr;
    }
    if (pr.ok !== true || pr.didRun !== true) {
      warn(`⛔ [${tag}] 预清理返回异常（ok=${pr.ok}, didRun=${pr.didRun}），本轮不打开子任务`);
      return { ok: false, skipped: true, reason: 'didrun-false' };
    }
    warn(`★ [${tag}] 预清理：完成，继续`);
    return pr;
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
      GM_setValue(GM_AUTO_TRIGGER, 0);
      warn('★ 自动触发：开始处理（已消费标记）');

      if (qa.isPaused && qa.isPaused()) {
        warn('⏸ 自动任务：夸克助手已暂停，直接关闭页面');
        setTimeout(() => { try { window.close(); } catch {} }, 300);
        return true;
      }

      const pack = gmGet(GM_PENDING_URLS, null);
      const urls = (pack && Array.isArray(pack.urls)) ? pack.urls : null;
      if (!urls || !urls.length) {
        warn('自动触发但 pending_urls 为空，跳过');
        return true;
      }
      warn(`★ 自动触发：从 pending_urls 读取 ${urls.length} 个 URL，先执行预清理`);

      const pr = await ensurePreflightCleanupDone(qa, { tag: 'auto-trigger' });
      if (pr && pr.skipped) {
        if (pr.reason === 'paused') {
          setTimeout(() => { try { window.close(); } catch {} }, 300);
        }
        warn(`⛔ 预清理未通过（reason=${pr.reason || 'skipped'}），本轮不打开子任务`);
        return true;
      }

      warn('★ 预清理已通过，开始子任务');
      let autoResult = null;
      try { autoResult = await runSaveAllFlow(qa, urls); }
      catch (e) { warn('自动转存流程异常', e); }

      if (!autoResult || autoResult.allConfirmed !== true) {
        warn('⛔ 自动任务：未确认改名全部完成，保持本页');
        return true;
      }

      /* 下载已触发：延迟 AUTO_CLOSE_DELAY_MS 再关页，
       * 避免浏览器/夸克客户端还在处理下载请求、页面就被关掉导致下载丢失。
       * 期间页面保持开启，面板显示倒计时状态。 */
      warn(`★ 自动任务完成：下载已触发，${AUTO_CLOSE_DELAY_MS / 1000}s 后关闭本页（避免下载未唤起就关页）`);
      try { qa.setStatus && qa.setStatus(`下载已触发，${AUTO_CLOSE_DELAY_MS / 1000}s 后关闭`, 'done'); } catch {}
      try { qa.setProgress && qa.setProgress('-'); } catch {}
      setTimeout(() => {
        warn('★ 自动任务：延时结束，关闭本页');
        try { window.close(); } catch {}
      }, AUTO_CLOSE_DELAY_MS);
      return true;
    } finally {
      _autoRunning = false;
    }
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
        const r0 = { total: qa.scanFileRows(document).length };
        log(`★ 分享页初始化（可见区）：扫描 ${r0.total}`);
      })();

      log(`★ 分享页初始化（等待用户操作 / 子任务触发）`);
    } else if (isList) {
      qa.setActions([
        {
          label: '▶️ 转存', color: '#09AAFF',
          title: '先执行夸克侧预清理（失效记录+过期文件），再处理 pending_urls 或 bangumiData 里的分享，逐条转存；刷新后按 acg 名称+原始文件名改名',
          onclick: async () => {
            warn('★ [manual-trigger] 用户点击「▶️ 转存」，先执行预清理');
            try {
              const pr = await ensurePreflightCleanupDone(qa, { tag: 'manual-trigger' });
              if (pr && pr.skipped) {
                const reason = pr.reason || '';
                if (reason !== 'recently-done' && reason !== 'paused') {
                  alert(`预清理未通过：${reason}\n请检查控制台 [桥接]/[夸克助手] 日志。`);
                  return;
                }
              }
            } catch (e) {
              warn('⚠️ [manual-trigger] 预清理异常', e);
            }
            return runSaveAllFlow(qa, null);
          },
        },
        {
          label: '🏷️ 测试改名', color: '#da9328',
          title: '对当前可见的第一个文件试改名（用 acg名称+原始文件名 的新格式）',
          onclick: () => runRenameSmokeTest(qa),
        },
        {
          label: '🔍 改名诊断', color: '#8c8c8c',
          title: '只报告改名入口的 DOM/按钮/勾选状态，不改动任何文件',
          onclick: () => runRenameDiagnose(qa),
        },
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