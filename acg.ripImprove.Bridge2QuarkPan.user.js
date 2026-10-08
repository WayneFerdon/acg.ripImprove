// ==UserScript==
// @name         acg.ripImprove.Bridge2QuarkPan
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  acg.rip 桥接：夸克业务编排 + 数据同步 + UI 注入
// @author       WayneFerdon
// @match        *://acg.rip/*
// @downloadURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/acg.ripImprove.Bridge2QuarkPan.user.js
// @updateURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/acg.ripImprove.Bridge2QuarkPan.user.js
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

  /* ============================================================
   *  常量
   * ============================================================ */
  const GM_KEY_BANGUMI = 'bangumiData';
  const GM_KEY_FOLDER  = 'setting_quark_folder_id';
  const GM_KEY_CD      = 'acgrip_quark_check_state';
  const GM_KEY_MIRROR  = 'acgrip_quark_records_mirror';
  const LS_SAVE_RECORDS = 'quark_save_records_v2';
  const LS_TRIGGER_TS   = 'acgrip_bridge_trigger_ts';
  const LS_STAMP        = 'acgrip_bridge_ts';
  const SAVE_TTL = 24 * 60 * 60 * 1000;
  const BASE_CD  = 30 * 60 * 1000;
  const MAX_CD   = 7 * 24 * 60 * 60 * 1000;
  const TRIGGER_TTL = 5 * 60 * 1000;

  const log  = (...a) => console.log('[桥接]', ...a);
  const warn = (...a) => console.warn('[桥接]', ...a);

  /* ============================================================
   *  bangumiData 解析
   * ============================================================ */
  function loadBangumiData() {
    try {
      // 1. 优先读 localStorage（与原脚本共享，同源）
      const lsRaw = localStorage.getItem(GM_KEY_BANGUMI);
      if (lsRaw) {
        const d = JSON.parse(lsRaw);
        if (d && typeof d === 'object' && Array.isArray(d.rows)) {
          // 同步到桥接自己的 GM 空间，供夸克端读取
          try { GM_setValue(GM_KEY_BANGUMI, lsRaw); } catch {}
          return d;
        }
      }
      // 2. 兜底：读桥接自己的 GM 存储（夸克端场景）
      const raw = GM_getValue(GM_KEY_BANGUMI);
      if (!raw) return null;
      const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return (d && typeof d === 'object') ? d : null;
    } catch { return null; }
  }

  function expandUrl(url, row) {
    if (!url) return url;
    const ep = String(Number(row && row.下集) || 1);
    const pad2 = s => String(s).length >= 2 ? s : String(s).padStart(2, '0');
    return String(url).replace(/@@|@/g, m => m === '@@' ? pad2(ep) : ep);
  }

  function shouldIncludeRow(row) {
    if (typeof row._airDate === 'number' && row._airDate > 0) {
      return row._airDate <= Date.now();
    }
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
   *  记录管理
   * ============================================================ */
  function loadSaveRecords() {
    try {
      const raw = localStorage.getItem(LS_SAVE_RECORDS);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch { return {}; }
  }
  function saveSaveRecords(records) {
    const now = Date.now();
    for (const k of Object.keys(records)) {
      if (now - (records[k].ts || 0) > SAVE_TTL) delete records[k];
    }
    try { localStorage.setItem(LS_SAVE_RECORDS, JSON.stringify(records)); } catch {}
    try { GM_setValue(GM_KEY_MIRROR, JSON.stringify(records)); } catch {}
  }

  /* ============================================================
   *  acg.rip 端
   * ============================================================ */
  function runQuarkAutoTrigger(opts = {}) {
    const { force = false } = opts;
    const folderId = (GM_getValue(GM_KEY_FOLDER) || '').trim();
    if (!folderId) return { triggered: false, reason: 'no-folder' };

    const bd = loadBangumiData();
    if (!bd || !Array.isArray(bd.rows)) return { triggered: false, reason: 'no-data' };

    const urls = collectShareUrls(bd);
    if (!urls.length) return { triggered: false, reason: 'no-urls' };

    let mirror = {};
    try { mirror = JSON.parse(GM_getValue(GM_KEY_MIRROR, '{}') || '{}'); } catch {}

    const state = GM_getValue(GM_KEY_CD, {}) || {};
    const now = Date.now();
    const need = [];
    let skippedBySaved = 0, skippedByCD = 0;

    for (const u of urls) {
      if (mirror[u]) { skippedBySaved++; continue; }
      const s = state[u] || { ts: 0, attempts: 0 };
      const cd = Math.min(BASE_CD * Math.pow(2, s.attempts), MAX_CD);
      if (!force && now - s.ts < cd) { skippedByCD++; continue; }
      need.push(u);
    }

    log(`触发：已转存 ${skippedBySaved}，CD 内跳过 ${skippedByCD}，待检查 ${need.length}`);
    if (!need.length) return { triggered: false, reason: 'all-cached', total: urls.length };

    for (const u of need) {
      const s = state[u] || { ts: 0, attempts: 0 };
      s.ts = now; s.attempts += 1; state[u] = s;
    }
    GM_setValue(GM_KEY_CD, state);

    const ts = Date.now();
    GM_setValue('acgrip_bridge_trigger_ts', ts);   // ★ 跨域传信号
    const url = `https://pan.quark.cn/list#/list/all/${folderId}/`;
    GM_openInTab(url, { active: false, insert: true, setParent: true });

    return { triggered: true, count: need.length, total: urls.length };
  }

  function watchEditPanel() {
    const tryInject = () => {
      const overlay = document.getElementById('gmEditOverlay');
      if (!overlay) return;
      if (overlay.querySelector('#acgrip-quark-section')) return;
      const lastTableHost = overlay.querySelector('#lastTableHost');
      if (!lastTableHost) return;
      injectQuarkSection(lastTableHost);
    };
    new MutationObserver(tryInject).observe(document.body, { childList: true, subtree: true });
    tryInject();
  }

  function injectQuarkSection(lastTableHost) {
    const section = document.createElement('div');
    section.id = 'acgrip-quark-section';
    section.style.cssText = 'margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed #3a3a3a;';

    const folderId = (GM_getValue(GM_KEY_FOLDER) || '').trim();

    section.innerHTML = `
      <label><strong>夸克网盘</strong></label>：
        <button type="button" id="resetQuarkCdBtn">重置夸克检查 CD</button>
        <button type="button" id="triggerQuarkBtn">立即触发转存</button>
        <span class="hint" id="quarkCdInfo"></span>
      <span class="hint" style="margin:2px 0 4px 0;display:block;">
        打开夸克个人页时使用的文件夹路径，例如：81c6136399d64c1b8a7cbb794a238860-来自：分享。留空则不自动打开夸克处理流程。
      </span>
      <input id="inpQuarkFolder" type="text"
        placeholder="81c6136399d64c1b8a7cbb794a238860-来自：分享"
        value="${folderId.replace(/"/g, '&quot;')}"
        style="width:100%;box-sizing:border-box;font-family:monospace;">
      
    `;
    lastTableHost.parentNode.insertBefore(section, lastTableHost);

    const inp  = section.querySelector('#inpQuarkFolder');
    const info = section.querySelector('#quarkCdInfo');

    function refreshInfo() {
      try {
        const state = GM_getValue(GM_KEY_CD, {}) || {};
        let mirror = {};
        try { mirror = JSON.parse(GM_getValue(GM_KEY_MIRROR, '{}') || '{}'); } catch {}
        info.textContent = `CD ${Object.keys(state).length} | 已转存 ${Object.keys(mirror).length}`;
      } catch { info.textContent = ''; }
    }

    inp.addEventListener('input', () => {
      GM_setValue(GM_KEY_FOLDER, inp.value.trim());
      refreshInfo();
    });
    inp.addEventListener('blur', () => {
      inp.value = (GM_getValue(GM_KEY_FOLDER) || '').trim();
      refreshInfo();
    });

    section.querySelector('#resetQuarkCdBtn').addEventListener('click', () => {
      if (!confirm('重置所有 URL 的检查 CD？')) return;
      GM_setValue(GM_KEY_CD, {});
      refreshInfo();
    });

    section.querySelector('#triggerQuarkBtn').addEventListener('click', () => {
      const r = runQuarkAutoTrigger({ force: true });
      alert(r.triggered ? `已打开夸克处理 ${r.count} 个链接` : `未触发：${r.reason}`);
      refreshInfo();
    });

    refreshInfo();
  }

  async function initAcgRipSide() {
    if (location.href.replace('page/1', '').endsWith('.rip/')) {
      setTimeout(() => {
        try {
          const r = runQuarkAutoTrigger();
          log('自动触发结果：', r);
        } catch (e) { warn('自动触发失败', e); }
      }, 5000);
    }

    // ★ 新增：监听原脚本保存事件，刷新数据并重新触发夸克流程
    window.addEventListener('acgrip-bangumi-saved', () => {
      try {
        log('检测到 bangumiData 保存');
        // 1. 让原脚本刷新 _airDate 并写回 localStorage
        try { unsafeWindow.acgripApi?.refreshAirDates?.(); } catch (e) { warn('refreshAirDates 失败', e); }
        // 2. 重新触发夸克流程（内部会 loadBangumiData + CD 判定 + 打开夸克页）
        const r = runQuarkAutoTrigger();
        log('保存后自动触发结果：', r);
      } catch (e) {
        warn('保存后触发失败', e);
      }
    });

    watchEditPanel();

    try {
      GM_registerMenuCommand('🔄 重置夸克检查 CD', () => {
        GM_setValue(GM_KEY_CD, {});
        alert('已重置。');
      });
      GM_registerMenuCommand('📊 查看桥接状态', () => {
        const state = GM_getValue(GM_KEY_CD, {}) || {};
        let mirror = {};
        try { mirror = JSON.parse(GM_getValue(GM_KEY_MIRROR, '{}') || '{}'); } catch {}
        alert(
          `已转存记录：${Object.keys(mirror).length} 条\n` +
          `CD 状态：${Object.keys(state).length} 个 URL\n` +
          `bangumiData：${GM_getValue(GM_KEY_BANGUMI) ? '已同步' : '未同步'}`
        );
      });
    } catch {}

    log('已启动（acg.rip 端）');
  }

  /* ============================================================
   *  夸克端
   * ============================================================ */
  function syncBangumiDataToLS() {
    try {
      const v = GM_getValue(GM_KEY_BANGUMI);
      if (v == null) return;
      const obj = typeof v === 'string' ? JSON.parse(v) : v;
      if (!obj || !Array.isArray(obj.rows)) return;
      const json = JSON.stringify(obj);
      if (localStorage.getItem(GM_KEY_BANGUMI) !== json) {
        localStorage.setItem(GM_KEY_BANGUMI, json);
        localStorage.setItem(LS_STAMP, String(Date.now()));
        log('bangumiData → quark localStorage (' + json.length + ' 字节)');
      }
    } catch (e) { warn('bangumiData 同步失败', e); }
  }

  function detectAutoTrigger() {
    const now = Date.now();
    const ts = Number(GM_getValue('acgrip_bridge_trigger_ts', 0) || 0);
    if (ts && now - ts < TRIGGER_TTL) {
      GM_setValue('acgrip_bridge_trigger_ts', 0);   // 用后即焚
      return true;
    }
    return false;
  }

  function waitForQA(timeoutMs = 10000) {
    return new Promise(resolve => {
      const start = Date.now();
      (function check() {
        const qa = unsafeWindow.quarkAssistant;
        if (qa && qa.isReady && qa.isReady()) return resolve(qa);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(check, 150);
      })();
    });
  }

  async function runSaveAllFlow(qa) {
    const bd = loadBangumiData();
    if (!bd) { warn('无 bangumiData'); return; }
    const urls = collectShareUrls(bd);
    const records = loadSaveRecords();
    const pending = urls.filter(u => !records[u]);

    log(`转存：共 ${urls.length} 个 URL，待转存 ${pending.length}`);
    if (!pending.length) return;

    for (let i = 0; i < pending.length; i++) {
      const url = pending[i];
      qa.setPanel({ status: '转存中...', cls: 'running', progress: `${i + 1}/${pending.length}` });

      const check = await qa.checkShareHasFiles(url);
      if (!check.ok) {
        log(`跳过（${check.reason}）: ${url}`);
        if (i < pending.length - 1) await qa.sleep(5000);
        continue;
      }

      const beforeSet = await qa.getRootFileKeys();
      let result;
      try {
        result = await qa.saveViaIframe(url);
        if (result.kind === 'iframe_failed') result = await qa.saveViaNewTab(url);
      } catch (e) {
        result = (e instanceof qa.SaveResult) ? e : new qa.SaveResult('fail', String(e));
      }

      if (result.kind === 'success' || result.kind === 'unknown') {
        let newFiles = result.newFiles;
        if (!newFiles) newFiles = await qa.diffRootNewFiles(beforeSet, 3000);
        const recs = loadSaveRecords();
        recs[url] = {
          ts: Date.now(),
          shareId: qa.extractShareId(url),
          fids: newFiles.map(f => f.fid),
          names: newFiles.map(f => f.file_name || f.name),
          fileInfos: newFiles.map(f => ({ name: f.file_name || f.name, sizeStr: '', iconSig: '' })),
          uncertain: result.kind === 'unknown',
          totalNeeded: check.fileCount,
        };
        saveSaveRecords(recs);
        log(`转存成功，新增 ${newFiles.length} 个: ${url}`);
      } else {
        warn(`转存失败(${result.kind}): ${result.message} - ${url}`);
      }
      if (i < pending.length - 1) await qa.sleep(5000);
    }
  }

  async function runSaveCurrentPage(qa) {
    const url = qa.normalizeUrl(location.href);
    const files = qa.scanDomFileRows();
    if (!files.length) { alert('当前页无文件'); return; }

    const selected = files.filter(f => {
      const cb = f.row.querySelector('input.ant-checkbox-input');
      return cb && cb.checked;
    });
    const scope = selected.length ? selected : files;

    const savedInfos = Object.values(loadSaveRecords()).flatMap(r => r.fileInfos || []);
    const needSave = scope.filter(f =>
                                  !savedInfos.some(si => si.name === f.name && String(si.sizeStr ?? '') === String(f.sizeStr ?? ''))
                                 );
    if (!needSave.length) { alert('选中/全部文件都已转存'); qa.refreshGray(); return; }

    if (!confirm(`转存 ${needSave.length} 个文件？（共选 ${scope.length} 个）`)) return;

    const result = await qa.performSaveOnDoc(document);
    if (result.kind === 'success' || result.kind === 'unknown') {
      const recs = loadSaveRecords();
      const existing = recs[url]?.fileInfos || [];
      const merged = [...existing];
      for (const f of scope) {
        if (!merged.some(mi => mi.name === f.name)) {
          merged.push({ name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig });
        }
      }
      recs[url] = {
        ...(recs[url] || {}),
        ts: Date.now(),
        shareId: qa.extractShareId(url),
        names: merged.map(x => x.name),
        fileInfos: merged,
      };
      saveSaveRecords(recs);
      alert(`✅ 已转存（记录 ${merged.length} 条）`);
    } else if (result.kind === 'space') alert('❌ 空间不足');
    else if (result.kind === 'over_limit') alert('❌ 超限');
    else alert('❌ 失败：' + result.message);

    qa.refreshGray();
  }

  async function runMarkFlow(qa) {
    const url = qa.normalizeUrl(location.href);
    const files = qa.getSelectedOrAllFiles();
    if (!files.length) { alert('无文件'); return; }
    if (!confirm(`标记 ${files.length} 个文件为已转存？`)) return;

    const recs = loadSaveRecords();
    const existing = recs[url]?.fileInfos || [];
    const merged = [...existing];
    for (const f of files) {
      if (!merged.some(mi => mi.name === f.name)) {
        merged.push({ name: f.name, sizeStr: f.sizeStr, iconSig: f.iconSig });
      }
    }
    recs[url] = {
      ...(recs[url] || {}),
      ts: Date.now(),
      shareId: qa.extractShareId(url),
      names: merged.map(x => x.name),
      fileInfos: merged,
      manual: true,
    };
    saveSaveRecords(recs);
    qa.refreshGray();
    alert(`已标记 ${files.length} 个`);
  }

  async function runClearShareFlow(qa) {
    const url = qa.normalizeUrl(location.href);
    const recs = loadSaveRecords();
    if (!recs[url]) { alert('当前分享无转存记录'); return; }

    const files = qa.getSelectedOrAllFiles();
    const all = qa.scanDomFileRows();
    const isPartial = files.length < all.length;

    if (isPartial) {
      if (!confirm(`从记录中移除 ${files.length} 个选中文件？`)) return;
      const toRemove = new Set(files.map(f => f.name));
      const newInfos = (recs[url].fileInfos || []).filter(fi => !toRemove.has(fi.name));
      if (!newInfos.length) delete recs[url];
      else recs[url] = { ...recs[url], fileInfos: newInfos, names: newInfos.map(x => x.name) };
      saveSaveRecords(recs);
      alert(`已移除 ${files.length} 个`);
    } else {
      if (!confirm('删除当前分享的全部转存记录？')) return;
      delete recs[url];
      saveSaveRecords(recs);
      alert('已删除全部记录');
    }
    qa.refreshGray();
  }

  async function runAutoWorkflow(qa) {
    log('★ 自动流程开始');
    await runSaveAllFlow(qa);
    await qa.autoDownloadWorkflow({
      maxRounds: 3,
      onProgress: (state) => qa.setPanel(state),
    });
    await qa.sleep(3000);
    try { window.close(); } catch {}
  }

  async function initQuarkSide() {
    // 子标签页交给夸克脚本处理
    const pendingKey = localStorage.getItem('quark_auto_save_pending');
    const shareIdMatch = location.pathname.match(/^\/s\/([a-zA-Z0-9]+)/);
    if (pendingKey && shareIdMatch && pendingKey === shareIdMatch[1]) {
      log('子标签页模式，跳过初始化');
      return;
    }

    syncBangumiDataToLS();
    try {
      GM_addValueChangeListener(GM_KEY_BANGUMI, (n, o, v, remote) => {
        if (remote) syncBangumiDataToLS();
      });
    } catch {}
    setInterval(syncBangumiDataToLS, 30000);

    const qa = await waitForQA();
    if (!qa) { warn('quarkAssistant 未就绪，退出'); return; }
    log('quarkAssistant 就绪 v' + qa.version);

    const pageType = qa.getPageType();

    // 分享页：激活 UI + 置灰判定
    if (pageType === 'share') {
      qa.setShareGrayPredicate(file => {
        const recs = loadSaveRecords();
        for (const rec of Object.values(recs)) {
          if (!Array.isArray(rec.fileInfos)) continue;
          for (const fi of rec.fileInfos) {
            if (fi.name === file.name &&
                String(fi.sizeStr ?? '') === String(file.sizeStr ?? '')) return true;
          }
        }
        return false;
      });
    }

    // 面板按钮
    qa.registerActions({
      share: {
        1: [
          { label: '📥 转存当前页', color: '#13c2c2', onclick: () => runSaveCurrentPage(qa) },
          { label: '🏷️ 标记', color: '#da9328', onclick: () => runMarkFlow(qa) },
        ],
        2: [
          { label: '🗑️ 清除当前记录', color: '#cc3235', onclick: () => runClearShareFlow(qa) },
        ],
      },
      list: {
        1: [
          { label: '▶️ 转存', color: '#09AAFF', onclick: () => runSaveAllFlow(qa) },
        ],
      },
    });

    // 自动触发
    if (detectAutoTrigger()) {
      log('检测到 auto_check');
      await runAutoWorkflow(qa);
    } else {
      qa.setPanel({ status: '待机', cls: '', progress: '-' });
    }

    setInterval(() => saveSaveRecords(loadSaveRecords()), 60 * 1000);

    log('已启动（夸克端）');
  }

  if (IS_QUARK) initQuarkSide();
  else if (IS_ACGRIP) initAcgRipSide();
})();