// ==UserScript==
// @name         acg.ripImprove.Bridge2QuarkPan
// @namespace    http://tampermonkey.net/
// @version      3.0.0
// @description  acg.rip 桥接：夸克转存业务编排（下载完全交给 QuarkAutoAssistant）
// @match        *://acg.rip/*
// @match        https://pan.quark.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const HOST = location.hostname;
  const IS_QUARK  = /^pan\.quark\.cn$/i.test(HOST);
  const IS_ACGRIP = /^acg\.rip$/i.test(HOST);
  if (!IS_QUARK && !IS_ACGRIP) return;

  const GM_BANGUMI       = 'bangumiData';
  const GM_FOLDER        = 'setting_quark_folder_id';
  const GM_CD            = 'acgrip_quark_check_state';
  const GM_RECORDS       = 'acgrip_quark_records';
  const GM_PENDING_URLS  = 'acgrip_bridge_pending_urls';
  const GM_AUTO_TRIGGER  = 'acgrip_bridge_auto_trigger';
  const GM_CLEAR_FLAG    = 'acgrip_quark_clear_records_flag';
  const GM_TASKS   = 'acgrip_bridge_tasks';     // 单个 key 存 Map: { [shareId]: { url, ts } }
  const GM_RESULTS = 'acgrip_bridge_results';   // 单个 key 存 Map: { [shareId]: { kind, ts, ... } }
  const BUSY_KEY         = 'acgrip_bridge_busy';   // ★ 通知 QuarkAutoAssistant 转存中

  const TASK_TTL         = 3 * 60 * 1000;
  const TAB_RESULT_TIMEOUT = 90 * 1000;

  const SAVE_TTL = 24 * 60 * 60 * 1000;
  const BASE_CD  = 30 * 60 * 1000;
  const MAX_CD   = 7 * 24 * 60 * 60 * 1000;
  const AUTO_TTL = 5 * 60 * 1000;

  const log  = (...a) => console.log('[桥接]', ...a);
  const warn = (...a) => console.warn('[桥接]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function gmGet(key, def) {
    try {
      const v = GM_getValue(key);
      if (v == null || v === '') return def;
      return typeof v === 'string' ? JSON.parse(v) : v;
    } catch { return def; }
  }
  function gmSet(key, val) { try { GM_setValue(key, JSON.stringify(val)); } catch {} }
  function gmRaw(key, def) {
    try { const v = GM_getValue(key); return v == null ? def : v; } catch { return def; }
  }
  /* ============================================================
 *  跨标签页通信：单 key Map，消费即删，读时清过期
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

  // 启动时清一次残留
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

  /* ============================================================
   *  bangumiData
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
   *  转存记录
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

  /* ============================================================
   *  checkbox 控制
   * ============================================================ */
  function getRowCheckbox(row) {
    return row.querySelector('input.ant-checkbox-input, input[type="checkbox"]');
  }

  async function setRowCheckbox(qa, row, desired) {
    let cb = getRowCheckbox(row);
    if (!cb) return { ok: false, method: 'no-checkbox' };
    if (!!cb.checked === !!desired) return { ok: true, method: 'already' };

    try { cb.click(); } catch {}
    await sleep(200);
    cb = getRowCheckbox(row);
    if (cb && !!cb.checked === !!desired) return { ok: true, method: 'native-click' };

    cb = getRowCheckbox(row);
    if (cb) {
      try {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
        setter.call(cb, desired);
        cb.dispatchEvent(new Event('input', { bubbles: true }));
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {}
      await sleep(200);
      cb = getRowCheckbox(row);
      if (cb && !!cb.checked === !!desired) return { ok: true, method: 'react-setter' };
    }

    cb = getRowCheckbox(row);
    if (cb) {
      const label = cb.closest('label') || row.querySelector('label.ant-checkbox-wrapper');
      if (label) qa.realClick(label);
      await sleep(200);
      cb = getRowCheckbox(row);
      if (cb && !!cb.checked === !!desired) return { ok: true, method: 'label-click' };
    }
    return { ok: false, method: 'all-failed' };
  }

  function getShareFileCount(doc = document) {
    try {
      const sels = [
        '.info-stat span',
        '.share-info .info-stat span',
      ];
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

  async function waitTableStable(qa, doc = document, maxMs = 20000) {
    const t0 = Date.now();
    const expected = getShareFileCount(doc);
    log(`  头部显示共 ${expected == null ? '?' : expected} 个；等待表格稳定...`);

    while (Date.now() - t0 < maxMs) {
      if (!doc.querySelector('.ant-spin-spinning')) break;
      await sleep(200);
    }
    log(`  spin 已消失，等待行数稳定...`);

    let lastCount = -1;
    let stableHits = 0;
    let files = [];
    while (Date.now() - t0 < maxMs) {
      files = qa.scanFileRows(doc);
      const cnt = files.length;
      if (expected && cnt >= expected && cnt === lastCount) {
        stableHits++;
        if (stableHits >= 2) { log(`  行数稳定：${cnt} 行（预期 ${expected}）`); return files; }
      } else if (cnt > 0 && cnt === lastCount) {
        stableHits++;
        if (stableHits >= 4) { log(`  行数稳定：${cnt} 行`); return files; }
      } else {
        stableHits = 0;
      }
      lastCount = cnt;
      await sleep(400);
    }
    log(`  等待超时，当前扫描到 ${files.length} 行`);
    return files;
  }

  async function applyTargetChecks(qa, doc, targets) {
    if (!targets || !targets.size) return { ok: true, applied: 0, failed: 0 };
    for (let attempt = 1; attempt <= 3; attempt++) {
      let applied = 0, failed = 0;
      const rows = qa.scanFileRows(doc);
      for (const f of rows) {
        if (!targets.has(f.name)) continue;
        const desired = targets.get(f.name);
        if (!!f.checked === desired) continue;
        const r = await setRowCheckbox(qa, f.row, desired);
        if (r.ok) applied++; else failed++;
        await sleep(150);
      }
      const finalRows = qa.scanFileRows(doc);
      const stillWrong = finalRows.filter(f => targets.has(f.name) && !!f.checked !== targets.get(f.name));
      if (!stillWrong.length) return { ok: true, applied, failed };
      warn(`  第 ${attempt} 次尝试后仍有 ${stillWrong.length} 个不匹配：` +
           stillWrong.map(f => `${f.name}(want=${targets.get(f.name)}, got=${f.checked})`).join(', '));
    }
    const finalRows = qa.scanFileRows(doc);
    const stillWrong = finalRows.filter(f => targets.has(f.name) && !!f.checked !== targets.get(f.name));
    return { ok: false, applied: 0, failed: stillWrong.length, details: stillWrong };
  }

  /* ============================================================
   *  acg.rip 端
   * ============================================================ */
  function runQuarkAutoTrigger(opts = {}) {
    const { force = false } = opts;
    const folderId = getFolderId().trim();     // ★
    if (!folderId) return { triggered: false, reason: 'no-folder' };

    const bd = loadBangumiData();
    if (!bd || !Array.isArray(bd.rows)) return { triggered: false, reason: 'no-data' };

    const urls = collectShareUrls(bd);
    if (!urls.length) return { triggered: false, reason: 'no-urls' };

    const state = gmGet(GM_CD, {}) || {};      // ★ 用 gmGet
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
   *  夸克端
   * ============================================================ */
  async function waitForQA(timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const qa = unsafeWindow.quarkAssistant;
      if (qa && qa.isReady && qa.isReady()) return qa;
      await sleep(150);
    }
    return null;
  }

  async function prepareShareSave(qa, doc = document) {
    let files = await waitTableStable(qa, doc, 20000);
    if (!files.length) return { ok: false, kind: 'no-files', files: [] };

    await sleep(1000);
    files = qa.scanFileRows(doc);

    const records = loadRecords();
    const savedInfos = collectSavedInfos(records);

    const saved   = files.filter(f => isFileSaved(f, savedInfos));
    const pending = files.filter(f => !isFileSaved(f, savedInfos));
    const excludeNames = new Set(saved.map(f => f.name));

    log(`  共 ${files.length} 个：已转存 ${saved.length}，待转存 ${pending.length}`);
    log(`  逐行判定：`);
    for (const f of files) {
      log(`    - ${f.name}  sizeStr="${f.sizeStr}"  →  ${isFileSaved(f, savedInfos) ? 'SAVED' : 'PENDING'}`);
    }

    if (!pending.length) {
      return { ok: false, kind: 'all-saved', needSave: [], skipped: saved, excludeNames, files };
    }

    const targets = new Map();
    for (const f of saved)   targets.set(f.name, false);
    for (const f of pending) targets.set(f.name, true);

    log(`  设置勾选状态（${saved.length} 个取消，${pending.length} 个勾选）...`);
    const r = await applyTargetChecks(qa, doc, targets);
    if (!r.ok) {
      warn(`  ⚠️ 勾选状态设置失败：${r.failed} 个仍不匹配`);
      return { ok: false, kind: 'check-failed', needSave: pending, skipped: saved, excludeNames, files, details: r.details };
    }

    const finalRows = qa.scanFileRows(doc);
    const stillChecked = finalRows.filter(f => targets.has(f.name) && targets.get(f.name) === false && f.checked);
    if (stillChecked.length) {
      warn(`  ⚠️ 最终验证：仍有 ${stillChecked.length} 个已转存行被勾选：${stillChecked.map(f => f.name).join(', ')}`);
      return { ok: false, kind: 'still-checked', needSave: pending, skipped: saved, excludeNames, files, details: stillChecked };
    }

    log(`  ✔ 勾选状态已就绪（已转存 ${saved.length} 个取消，待转存 ${pending.length} 个勾选）`);
    return { ok: true, kind: 'ready', needSave: pending, skipped: saved, excludeNames, files };
  }

  async function tryHandleChildTask(qa) {
    const shareId = extractShareId(location.href);
    if (!shareId) return false;

    const task = consumeTask(shareId);   // 消费即删，内部自动清过期
    if (!task) return false;
    log(`★ [子任务] ${shareId} 开始处理`);

    qa.mountPanel();
    qa.setStatus('子任务处理中...', 'running');
    qa.setProgress('-');

    const finish = (kind, extra = {}) => {
      setResult(shareId, { kind, ...extra });
      log(`★ [子任务] 结果已写入：${kind}`);
      setTimeout(() => { try { window.close(); } catch {} }, 800);
    };

    let prep;
    try {
      prep = await prepareShareSave(qa, document);
    } catch (e) {
      warn('  准备失败', e);
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
      await qa.clickSaveButton(document);
      await sleep(1500);
      await qa.clickConfirmInDialog(document);
      const result = await qa.waitResult(document, 8000);
      log(`  子任务结果：${result}`);
      qa.closeDialog(document);

      if (result === 'success' || result === 'unknown') {
        const key = normalizeShareKey(location.href);
        const recs = loadRecords();
        const prev = recs[key] || {};
        const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
        for (const f of prep.needSave) {
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
        log(`  记录已更新：${key} → ${merged.length} 条`);
      }

      finish(result, {
        savedFiles: prep.needSave.map(f => ({ name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig })),
        fileCount: prep.files.length,
      });
    } catch (e) {
      warn('  子任务异常', e);
      finish('fail', { message: String(e && e.message || e) });
    }
    return true;
  }

  async function saveShareUrlViaTab(qa, url) {
    const shareId = extractShareId(url);
    if (!shareId) return { kind: 'fail', message: 'bad-url' };

    clearResult(shareId);           // 清残留
    setTask(shareId, url);          // 写任务

    log(`  → 打开标签页：${url}`);
    try {
      GM_openInTab(url, { active: false, insert: true, setParent: true });
    } catch (e) {
      clearTask(shareId);
      return { kind: 'fail', message: 'open-tab-failed' };
    }

    const t0 = Date.now();
    while (Date.now() - t0 < TAB_RESULT_TIMEOUT) {
      const r = consumeResult(shareId);
      if (r) return r;
      await sleep(1000);
    }
    clearTask(shareId);
    return { kind: 'timeout', message: 'tab-timeout' };
  }

  /* ============================================================
   *  批量转存
   *  ★ 只负责转存 + 记录 + reload；下载完全不碰
   * ============================================================ */
  async function runSaveAllFlow(qa, pendingUrlsOverride) {
    let pending;

    if (Array.isArray(pendingUrlsOverride)) {
      pending = pendingUrlsOverride.slice();
      log(`★ [acg 清单模式] 待处理 ${pending.length} 个 URL`);
      for (const u of pending) log(`   → ${u}`);
    } else {
      const bd = loadBangumiData();
      if (!bd) { alert('无 bangumiData'); return; }
      const urls = collectShareUrls(bd);
      const records = loadRecords();
      log('=== 手动触发：队列分析 ===');
      pending = [];
      for (const u of urls) {
        const key = normalizeShareKey(u);
        if (records[key]) log(`  [已存在] ${u}`);
        else { log(`  [待转存] ${u}`); pending.push(u); }
      }
      if (!pending.length) {
        alert(`所有 URL 均已处理完毕（共 ${urls.length} 个）`);
        return;
      }
    }

    if (!pending.length) return;

    // ★ 标记桥接忙碌，让 QuarkAutoAssistant 的自动下载暂停
    try { sessionStorage.setItem(BUSY_KEY, '1'); } catch {}
    log('★ 已标记桥接忙碌，QuarkAutoAssistant 暂停自动下载');

    try {
      qa.setStatus('转存中...', 'running');
      let successCount = 0;
      for (let i = 0; i < pending.length; i++) {
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
        if (r.kind === 'success' || r.kind === 'unknown') {
          successCount++;
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
          log(`✅ 已记录 ${merged.length} 条到 ${key}`);
        } else if (r.kind === 'all-saved') {
          const files = Array.isArray(r.files) ? r.files.join(', ') : '?';
          log(`⏭️ 该 URL 所有文件都已转存（fileCount=${r.fileCount}, files=${files}）: ${url}`);
        } else {
          warn(`⚠️ 结果 ${r.kind}: ${url}`);
        }

        if (i < pending.length - 1) await sleep(1200);
      }

      qa.setStatus('转存完成', 'done');
      qa.setProgress('-');

      if (successCount > 0) {
        log('★ 有新转存，重载页面触发 QuarkAutoAssistant 自动下载...');
        try { sessionStorage.removeItem(BUSY_KEY); } catch {}
        await sleep(1500);
        location.reload();
      } else {
        log('无新转存文件，跳过刷新');
      }
    } finally {
      // 兜底清除
      try { sessionStorage.removeItem(BUSY_KEY); } catch {}
    }
  }

  /* ============================================================
   *  分享页：手动转存当前页
   * ============================================================ */
  async function runSaveCurrentPage(qa) {
    const url = normalizeShareKey(location.href);
    const allFiles = qa.scanFileRows(document);
    if (!allFiles.length) { alert('当前页无文件'); return; }

    const checked = allFiles.filter(f => f.checked);
    const scope = checked.length ? checked : allFiles;
    const usingAll = checked.length === 0;

    log(`=== 转存当前页 ===`);
    log(`  URL: ${url}`);
    log(`  范围: ${usingAll ? `全部 ${allFiles.length} 个` : `勾选 ${checked.length} 个`}`);

    const records = loadRecords();
    const savedInfos = collectSavedInfos(records);
    const scopeSaved   = scope.filter(f => isFileSaved(f, savedInfos));
    const scopePending = scope.filter(f => !isFileSaved(f, savedInfos));

    log(`  已转存跳过 ${scopeSaved.length}：${scopeSaved.map(f => f.name).join(', ') || '无'}`);
    log(`  待转存 ${scopePending.length}：${scopePending.map(f => f.name).join(', ') || '无'}`);

    if (!scopePending.length) {
      alert(`范围内所有文件都已转存（范围 ${scope.length} 个）`);
      qa.refreshGray();
      return;
    }

    const msg =
          `范围：${usingAll ? `全部 ${allFiles.length} 个` : `勾选 ${checked.length} 个`}\n` +
          `转存：${scopePending.length} 个\n` +
          (scopeSaved.length ? `跳过已转存：${scopeSaved.map(f => f.name).join(', ')}\n` : '') +
          `\n继续？`;
    if (!confirm(msg)) return;

    try {
      const targets = new Map();
      for (const f of scopeSaved)   targets.set(f.name, false);
      for (const f of scopePending) targets.set(f.name, true);

      log(`  设置勾选状态...`);
      const r = await applyTargetChecks(qa, document, targets);
      log(`  应用结果：ok=${r.ok}, applied=${r.applied}, failed=${r.failed}`);
      if (!r.ok) {
        const names = (r.details || []).map(f => f.name).join(', ');
        if (!confirm(`⚠️ 有 ${r.failed} 个勾选状态未设置成功：\n${names}\n\n继续保存？（可能包含已转存的文件）`)) return;
      }

      await qa.clickSaveButton(document);
      await sleep(1500);
      await qa.clickConfirmInDialog(document);
      const result = await qa.waitResult(document, 8000);
      log(`  waitResult → ${result}`);
      qa.closeDialog(document);

      if (result === 'success' || result === 'unknown') {
        const recs = loadRecords();
        const prev = recs[url] || {};
        const merged = Array.isArray(prev.fileInfos) ? prev.fileInfos.slice() : [];
        for (const f of scopePending) {
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
        alert(`✅ 已转存（记录 ${merged.length} 条）`);
      } else if (result === 'space') alert('❌ 空间不足');
      else if (result === 'over_limit') alert('❌ 超限');
      else alert('❌ 失败或未知：' + result);
    } catch (e) {
      warn('转存异常：', e);
      alert('❌ 出错：' + (e && e.message || e));
    }
    qa.refreshGray();
  }

  /* ============================================================
   *  分享页：标记 / 清除
   * ============================================================ */
  async function runMarkFlow(qa) {
    const url = normalizeShareKey(location.href);
    const allFiles = qa.scanFileRows(document);
    if (!allFiles.length) { alert('无文件'); return; }

    const checked = allFiles.filter(f => f.checked);
    const scope = checked.length ? checked : allFiles;
    const usingAll = checked.length === 0;

    const msg = usingAll
      ? `无勾选，标记全部 ${allFiles.length} 个文件为已转存？\n${scope.map(f => f.name).join(', ')}`
      : `标记勾选的 ${checked.length} 个文件为已转存？\n${scope.map(f => f.name).join(', ')}`;
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
    qa.refreshGray();
    alert(`已标记 ${scope.length} 个（新增 ${added}，累计 ${merged.length}）`);
  }

  async function runClearShareFlow(qa) {
    const url = normalizeShareKey(location.href);
    const allFiles = qa.scanFileRows(document);
    const checked = allFiles.filter(f => f.checked);
    const scope = checked.length ? checked : allFiles;
    const usingAll = checked.length === 0;

    const recs = loadRecords();
    const rec = recs[url];
    if (!rec) { qa.refreshGray(); alert('当前分享无记录'); return; }

    if (usingAll) {
      if (!confirm(`当前分享无勾选，将删除全部记录（共 ${(rec.fileInfos || []).length} 条）？`)) return;
      delete recs[url];
      saveRecords(recs);
      qa.refreshGray();
      alert('已删除全部记录');
      return;
    }

    const existing = Array.isArray(rec.fileInfos) ? rec.fileInfos : [];
    const toRemove = scope.map(f => ({ name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig }));
    const hitCount = existing.filter(fi => toRemove.some(tr => isSameFile(tr, fi))).length;
    if (!hitCount) { alert(`勾选的 ${checked.length} 个文件无转存记录`); return; }
    if (!confirm(`从记录中移除 ${hitCount} 个勾选文件？（当前记录共 ${existing.length} 条）`)) return;

    const keep = existing.filter(fi => !toRemove.some(tr => isSameFile(tr, fi)));
    if (!keep.length) {
      delete recs[url];
      alert(`已移除 ${hitCount} 个，记录已清空`);
    } else {
      recs[url] = { ...rec, ts: Date.now(), fileInfos: keep, names: keep.map(x => x.name) };
      alert(`已移除 ${hitCount} 个（剩余 ${keep.length} 条）`);
    }
    saveRecords(recs);
    qa.refreshGray();
  }

  /* ============================================================
   *  夸克端入口
   * ============================================================ */
  async function initQuarkSide() {
    cleanupBridgeComm();   // ★ 清残留
    const qa = await waitForQA();
    if (!qa) { warn('quarkAssistant 未就绪'); return; }
    log('quarkAssistant 就绪 v' + qa.version);

    const isChild = await tryHandleChildTask(qa);
    if (isChild) {
      log('★ 子任务已处理，本标签页即将关闭');
      return;
    }

    const isShare = qa.isSharePage();
    const isList  = qa.isListPage();

    if (isShare) {
      qa.mountPanel();
      qa.setActions([
        { label: '📥 转存当前页', color: '#13c2c2', onclick: () => runSaveCurrentPage(qa) },
        { label: '🏷️ 标记',       color: '#da9328', onclick: () => runMarkFlow(qa) },
        { label: '🗑️ 清除当前记录', color: '#cc3235', onclick: () => runClearShareFlow(qa) },
      ]);
      qa.setProgressLabel('已转存');
      qa.setGrayPredicate(file => isFileSaved(file, collectSavedInfos(loadRecords())));
      const r0 = qa.refreshGray(document);
      log(`★ 分享页初始化：扫描 ${r0.total}，已转存 ${r0.grayed}`);
      qa.setStatus('待机（分享页）');

      if (r0.grayed > 0) {
        setTimeout(async () => {
          const files = await waitTableStable(qa, document, 10000);
          if (!files.length) return;
          const recs = loadRecords();
          const savedInfos = collectSavedInfos(recs);
          const targets = new Map();
          for (const f of files) {
            if (isFileSaved(f, savedInfos)) targets.set(f.name, false);
          }
          if (!targets.size) return;
          const r = await applyTargetChecks(qa, document, targets);
          log(`★ 分享页初始化：自动取消 ${targets.size} 个已转存行（成功 ${r.ok ? targets.size - r.failed : '?'}）`);
        }, 900);
      }
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
        const pack = gmGet(GM_PENDING_URLS, null);
        const urls = (pack && Array.isArray(pack.urls)) ? pack.urls : null;
        if (urls && urls.length) {
          log(`★ 自动触发：从 pending_urls 读取 ${urls.length} 个 URL`);
          runSaveAllFlow(qa, urls);
        } else {
          warn('自动触发但 pending_urls 为空');
        }
      }
    } else {
      // 其他页
    }

    log('已启动（夸克端）');
  }

  if (IS_QUARK) initQuarkSide();
  else if (IS_ACGRIP) initAcgRipSide();
})();