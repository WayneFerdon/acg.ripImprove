// ==UserScript==
// @name         acg.ripImprove
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  acg.rip torrent auto download
// @author       WayneFerdon
// @include      *acg.rip*
// @match        https://bangumi.tv/subject/*
// @match        https://bgm.tv/subject/*
// @downloadURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/acg.ripImprove.user.js
// @updateURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/acg.ripImprove.user.js
// @connect      bangumi.tv
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// ==/UserScript==

const _1s = 1000, _1m = 60 * _1s, _1h = 60 * _1m, _1d = 24 * _1h;
const colors = { last: 'palegreen', tracking: 'crimson', downloaded: 'rebeccapurple', unviewed: 'cyan' };
const timeOpt = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
const url2num = url => 1 * `${url ?? ''}`.replace('/t/', '');
const WEEKDAY_LABEL = ['日七', '月一', '火二', '水三', '木四', '金五', '土六'];
const KANJI_MONTH = { 1: '一', 4: '四', 7: '七', 10: '十' };
const UPDATED_KEY = 'updated', LAST_KEY = 'last', BANGUMI_INTERVAL = 24 * 3600 * 1000;
const DRAFT_KEY = 'acgrip_draft_edit';

let trackingItems = {}, tracking = [], downloaded = {};
let last, lastDownload, lastViewed;
let inferredTimes = {}, display, downloadInProgress = false;
let _gmEditOverlay = null, _gmEditShow = null, _gmEditHide = null;
let inferredTimesCache = {}, _inferredCacheLoaded = false, _inferScannedThisSession = false;
let inferenceStatus = { phase: 'idle', pending: 0, found: 0, page: 0, message: '', scanning: false };
const IMPORT_HEADER_ALIASES = {
  '下集':'下集','中文':'中文','名称':'名称','年':'年','开播':'开播','放送':'放送','最大':'最大',
  '初始':'初始','前季':'前季','更新':'更新','BGMID':'BGMID','资源':'资源','规则':'规则',
  '延周':'延周','延日':'延日','已下载':'已下载','记录':'已下载',
};
let _gmEditRelayout = null;
const PANEL_OPEN_KEY = 'acgrip_panel_open';

const $ajax = initAjax();
onHandle();
new MutationObserver(muts => muts.forEach(onHandle)).observe(document.documentElement, { childList: true });
/* 页面加载后恢复上次的面板打开状态 */
(function restorePanelOpenState() {
  const tryRestore = () => {
    try {
      if (localStorage.getItem(PANEL_OPEN_KEY) === '1') {
        showEditDialog();
      }
    } catch (e) {
      console.error('[restorePanelOpenState]', e);
    }
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(tryRestore, 400);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(tryRestore, 400), { once: true });
  }
})();
/* 并排判定 + 浮标位置刷新（窗口变化时统一处理） */
let _globalResizeTimer = null;
function handleGlobalResize() {
  if (_globalResizeTimer) clearTimeout(_globalResizeTimer);
  _globalResizeTimer = setTimeout(() => {
    _globalResizeTimer = null;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const uiVisible = _gmEditOverlay && _gmEditOverlay.isConnected && _gmEditOverlay.style.display !== 'none';
    const shouldSplit = vw >= 1400;

    if (uiVisible) {
      // UI 打开：交给内部完整重新布局（含 split class 设置 + 浮标位置）
      if (_gmEditRelayout) _gmEditRelayout();
    } else {
      // UI 未打开：只调整 split class + 刷新浮标
      if (document.body.classList.contains('acgrip-split') !== shouldSplit) {
        if (shouldSplit) document.body.classList.add('acgrip-split');
        else document.body.classList.remove('acgrip-split');
      }
      void document.body.offsetWidth;
      requestAnimationFrame(() => positionDisplay());
    }
  }, 150);
}
window.addEventListener('resize', handleGlobalResize);

/* 界面关闭时按 Esc：打开编辑界面 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 界面已打开 → 由内部 handler 处理
  if (_gmEditOverlay && _gmEditOverlay.style.display !== 'none') return;
  // 导入子窗口已打开 → 由内部处理
  if (document.getElementById('importOverlay')) return;
  // 页面上其它输入框正在编辑 → 不干扰
  const ae = document.activeElement;
  if (ae && ae !== document.body && ae !== document.documentElement) {
    const tag = ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae.isContentEditable) return;
  }
  e.preventDefault();
  showEditDialog();
}, true);

/* ---- updated / last 存储 ---- */
function getUpdated() {
  const u = getValue(UPDATED_KEY);
  if (!u || typeof u !== 'object' || Array.isArray(u)) return { bangumi: 0, quarter: '', schedule: {} };
  return {
    bangumi: Number(u.bangumi) || 0,
    quarter: typeof u.quarter === 'string' ? u.quarter : '',
    schedule: (u.schedule && typeof u.schedule === 'object' && !Array.isArray(u.schedule)) ? { ...u.schedule } : {},
  };
}
function setUpdated(partial) { const u = getUpdated(); Object.assign(u, partial); setValue(UPDATED_KEY, u); return u; }
function saveLastData() {
  const idVal = (last != null && !Number.isNaN(url2num(last))) ? url2num(last) : '';
  const viewedVal = (lastViewed != null && !Number.isNaN(url2num(lastViewed))) ? url2num(lastViewed) : '';
  setValue(LAST_KEY, { id: idVal, match: lastDownload ?? '', viewed: viewedVal });

  // 面板打开时同步 last 三个输入框（未手动修改的字段）
  if (_gmEditOverlay && _gmEditOverlay.isConnected && _gmEditOverlay.style.display !== 'none'
      && typeof _gmEditOverlay._refreshLastInputs === 'function') {
    _gmEditOverlay._refreshLastInputs();
  }
}
function idToHref(v) {
  if (v == null || v === '') return undefined;
  const s = String(v).replace(/^\/t\//, '').trim();
  return /^\d+$/.test(s) ? '/t/' + s : undefined;
}

/* ---- 已下载转换 ---- */
function parseDownloadedToList(v) {
  const norm = s => { const n = String(s).replace(/^\/t\//, '').trim(); return /^\d+$/.test(n) ? Number(n) : null; };
  const items = Array.isArray(v) ? v.flatMap(x => String(x ?? '').split(/[;\n,]+/)) : String(v ?? '').split(/[;\n,]+/);
  return Array.from(new Set(items.map(norm).filter(n => n !== null)));
}
function parseDownloadedToText(v) { return parseDownloadedToList(v).join('\n'); }
function parseTextToDownloaded(text) {
  const norm = s => { const n = String(s).replace(/^\/t\//, '').trim(); return /^\d+$/.test(n) ? Number(n) : null; };
  const parts = String(text ?? '').split(/[\s,;]+/).map(norm).filter(n => n !== null);
  return Array.from(new Set(parts));
}
function toDownloadedIndex(arr) { return parseDownloadedToList(arr).map(n => '/t/' + n); }
function normRuleKey(s) { return String(s ?? '').replace(/^\/|\/$/g, ''); }
function getDownloadedList(found) {
  if (!found) return null;
  if (Object.prototype.hasOwnProperty.call(downloaded, found)) return downloaded[found];
  const target = normRuleKey(found);
  for (const k of Object.keys(downloaded)) if (normRuleKey(k) === target) return downloaded[k];
  return null;
}
function isDownloaded(found, href) {
  if (!href) return false;
  if (found && Array.isArray(downloaded[found]) && downloaded[found].includes(href)) return true;
  if (found) {
    const target = normRuleKey(found);
    for (const k of Object.keys(downloaded)) {
      if (normRuleKey(k) === target) {
        const list = downloaded[k];
        if (Array.isArray(list) && list.includes(href)) return true;
      }
    }
  }
  for (const k of Object.keys(downloaded)) {
    const list = downloaded[k];
    if (Array.isArray(list) && list.includes(href)) return true;
  }
  return false;
}
function cleanRowObject(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) if (row[k] === '') delete row[k];
  return row;
}
function isRuleInferable(key) {
  if (!key) return false;
  let k = String(key).trim();
  if (!k) return false;
  if (k.startsWith('/') && k.endsWith('/') && k.length >= 2) k = k.slice(1, -1);
  if (!k) return false;
  if (/^https?:\/\//i.test(k)) return false;
  return true;
}

/* ---- 修复历史污染 & 数据加载 ---- */
function repairBangumiRows(bd) {
  if (!Array.isArray(bd.rows)) return false;
  const slashRows = new Map();
  for (const r of bd.rows) {
    const rule = String(r.规则 || '').trim();
    if (rule.startsWith('/') && rule.endsWith('/') && rule.length >= 2) slashRows.set(rule.slice(1, -1), r);
  }
  const toRemove = new Set();
  let changed = false;
  for (const r of bd.rows) {
    const rule = String(r.规则 || '').trim();
    if (!rule || (rule.startsWith('/') && rule.endsWith('/'))) continue;
    const target = slashRows.get(rule);
    if (!target || target === r) continue;
    const existing = Array.isArray(target.已下载) ? target.已下载.slice() : [];
    const incoming = Array.isArray(r.已下载) ? r.已下载.slice() : [];
    target.已下载 = Array.from(new Set([...existing, ...incoming]));
    for (const f of ['资源','下集','中文','名称','年','开播','放送','最大','初始','前季','更新','BGMID','延周','延日']) {
      const tv = String(target[f] ?? '').trim(), rv = String(r[f] ?? '').trim();
      if (!tv && rv) target[f] = r[f];
    }
    toRemove.add(r); changed = true;
  }
  if (toRemove.size) bd.rows = bd.rows.filter(r => !toRemove.has(r));
  return changed;
}
function findRowByRule(bd, rule) {
  const r = String(rule).trim();
  if (!r) return null;
  let row = bd.rows.find(x => (x.规则 || '').trim() === r);
  if (row) return row;
  if (!(r.startsWith('/') && r.endsWith('/'))) {
    row = bd.rows.find(x => (x.规则 || '').trim() === `/${r}/`);
    if (row) return row;
  }
  if (r.startsWith('/') && r.endsWith('/') && r.length >= 2) {
    const src = r.slice(1, -1);
    row = bd.rows.find(x => (x.规则 || '').trim() === src);
    if (row) return row;
    row = bd.rows.find(x => {
      const rr = (x.规则 || '').trim();
      if (!(rr.startsWith('/') && rr.endsWith('/') && rr.length >= 2)) return false;
      return rr.slice(1, -1) === src;
    });
    if (row) return row;
  }
  return null;
}
function loadDatas() {
  loadInferredCache();
  let bd = getValue('bangumiData');
  if (!bd || typeof bd !== 'object' || Array.isArray(bd)) bd = { rows: [], delay: { rows: [] } };
  if (!Array.isArray(bd.rows)) bd.rows = [];
  if (!bd.delay || !Array.isArray(bd.delay.rows)) bd.delay = { rows: [] };
  let migrated = false;
  if (repairBangumiRows(bd)) { migrated = true; setUpdated({ bangumi: 0 }); }
  if (bd.tracking) { delete bd.tracking; migrated = true; }
  if (bd.trackingDownloaded) { delete bd.trackingDownloaded; migrated = true; }
  if (migrated) setValue('bangumiData', bd);
  trackingItems = {}; downloaded = {};
  for (const r of bd.rows) {
    const rule = String(r.规则 || '').trim();
    if (!rule) continue;
    trackingItems[rule] = r.资源 || '';
    const m = rule.match(/^\/([\s\S]*)\/$/);
    const keyNoSlash = m ? m[1] : rule, keyWithSlash = m ? rule : '/' + rule + '/';
    const idx = toDownloadedIndex(r.已下载);
    downloaded[keyNoSlash] = idx; downloaded[keyWithSlash] = idx;
    r.已下载 = parseDownloadedToList(r.已下载);
  }
  tracking = Object.keys(trackingItems).map(k => k.match(/^\/.*\/$/) ? new RegExp(k.replace(/^\/|\/$/g, '')) : k);
  const lastData = getValue(LAST_KEY);
  if (lastData && typeof lastData === 'object' && !Array.isArray(lastData)) {
    last = idToHref(lastData.id);
    lastDownload = lastData.match || undefined;
    lastViewed = idToHref(lastData.viewed);
  } else { last = lastDownload = lastViewed = undefined; }
}
/** 从 bangumiData.delay 里查延周（不依赖面板 DOM，可在无 UI 环境调用） */
function lookupDelayFromData(row, parsed, delayData) {
  const keys = [
    String(effective(row, '中文', parsed) || '').trim(),
    String(effective(row, '名称', parsed) || '').trim(),
  ].filter(Boolean);
  if (!keys.length || !delayData || !Array.isArray(delayData.rows)) {
    return { total: 0, matched: false };
  }
  const currentEP = Number(row.下集) || 0;
  let total = 0, matched = false;
  for (const dr of delayData.rows) {
    const name = String(dr.名称 || '').trim();
    const exclude = String(dr.排除 || '').trim();
    if (!name || !keys.includes(name) || exclude) continue;
    matched = true;
    const episodes = Array.isArray(dr.episodes) ? dr.episodes : [];
    const weeks = Array.isArray(dr.weeks) ? dr.weeks : [];
    for (let i = 0; i < episodes.length; i++) {
      const ep = Number(episodes[i]);
      if (!Number.isFinite(ep) || ep <= 0) continue;
      if (currentEP >= ep) {
        const wkRaw = weeks[i];
        const wk = (wkRaw === '' || wkRaw == null) ? 1 : Number(wkRaw);
        if (Number.isFinite(wk)) total += wk;
      }
    }
  }
  return { total, matched };
}
function saveBangumiData() {
  const bd = getValue('bangumiData') ?? { rows: [], delay: { rows: [] } };
  if (!Array.isArray(bd.rows)) bd.rows = [];
  for (const row of bd.rows) {
    const rule = String(row.规则 || '').trim();
    if (!rule) continue;
    if (Object.prototype.hasOwnProperty.call(trackingItems, rule)) row.资源 = trackingItems[rule];
    const m = rule.match(/^\/([\s\S]*)\/$/);
    const keyNoSlash = m ? m[1] : rule, keyWithSlash = m ? rule : '/' + rule + '/';
    const list = downloaded[keyNoSlash] ?? downloaded[keyWithSlash];
    if (list) row.已下载 = parseDownloadedToList(list);
  }
  for (const row of bd.rows) cleanRowObject(row);
  // ★ 新增：为每行预计算播出时间戳，供外部脚本复用
  const delayData = (bd.delay && Array.isArray(bd.delay.rows)) ? bd.delay : { rows: [] };
  for (const row of bd.rows) {
    try {
      const parsed = parseBGMID(row.BGMID);
      const delayGetter = (r, p) => lookupDelayFromData(r, p, delayData);
      const air = getAirDate(row, parsed, delayGetter);
      row._airDate = air ? air.getTime() : 0;
    } catch (e) {
      row._airDate = 0;
    }
  }
  setValue('bangumiData', bd);
}

/* ---- onHandle ---- */
function onHandle() {
  loadInferredCache();
  try { autoReload().catch(e => console.error('autoReload error:', e)); } catch (e) { console.error(e); }
  onHandleItems(setDisplayHighlight);
  setTimeHover();
  // Bangumi 条目详情页：更新对应行
  if (/^https?:\/\/(bangumi\.tv|bgm\.tv)\/subject\/\d+/.test(window.location.href)) {
    updateFromBangumiSubjectPage().catch(e => console.error('[SubjectPage] error:', e));
    return;
  }
  if (window.location.href.replace('page/1', '').endsWith('.rip/')) {
    autoUpdateFromBangumi().catch(e => console.error(e));
    autoUpdateQuarter().catch(e => console.error(e));
    asyncDownloadTorrents();
    precomputeAirDatesGlobal();
  }
}

function precomputeAirDatesGlobal() {
  try {
    const bd = getValue('bangumiData');
    if (!bd || !Array.isArray(bd.rows)) return;
    const delayData = (bd.delay && Array.isArray(bd.delay.rows)) ? bd.delay : { rows: [] };
    let changed = false;
    for (const row of bd.rows) {
      const parsed = parseBGMID(row.BGMID);
      const delayGetter = (r, p) => lookupDelayFromData(r, p, delayData);
      const air = getAirDate(row, parsed, delayGetter);
      const newTs = air ? air.getTime() : 0;
      if (row._airDate !== newTs) { row._airDate = newTs; changed = true; }
    }
    if (changed) setValue('bangumiData', bd);
  } catch (e) { /* ignore */ }
}

/* ---- 悬浮显示 ---- */
function getDisplayHost() { return document.querySelector('header > .container') ?? document.body; }
function getDisplay() {
  if (display?.isConnected) { positionDisplay(display); return display; }
  display = cE('span');
  display.id = 'acgrip-display';
  display.style.cssText = 'position:fixed;z-index:9998;display:inline-flex;flex-direction:row;align-items:center;gap:6px;background:rgba(0,0,0,0.6);color:#fff;padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace;line-height:1.4;cursor:pointer;white-space:pre';
  display.title = '点击编辑GM存储数据（Ctrl+点击清空推断缓存）';
  display.addEventListener('click', showEditDialog);
  display.addEventListener('click', (e) => {
    if (e.ctrlKey) {
      e.preventDefault(); e.stopPropagation();
      inferredTimesCache = {};
      _inferredCacheLoaded = true; _inferScannedThisSession = false;
      saveInferredCache();
      inferenceStatus = { phase: 'idle', pending: 0, found: 0, page: 0, message: '已清空推断缓存', scanning: false };
      showToast('已清空推断缓存，刷新页面后重新扫描');
    }
  }, true);
  const btn = createViewedButton();
  display.appendChild(btn);
  const timeText = cE('span');
  timeText.id = 'acgrip-time-text';
  timeText.style.cssText = 'white-space:pre; text-align:right;';
  display.appendChild(timeText);
  display.timeText = timeText;
  getDisplayHost().appendChild(display);
  bindDisplayPositioning(display);
  positionDisplay(display);
  updateViewedButton(btn);
  return display;
}
function positionDisplay(disp = display) {
  if (!disp?.isConnected) return;
  const bar = document.getElementById('session-bar');
  if (!bar) { disp.style.top = '8px'; disp.style.right = '8px'; disp.style.left = 'auto'; return; }
  const rect = bar.getBoundingClientRect();
  disp.style.top = `${Math.max(0, rect.top)}px`;
  disp.style.right = `${Math.max(0, window.innerWidth - rect.left - 8)}px`;
  disp.style.left = 'auto';
}
function bindDisplayPositioning(disp) {
  let scheduled = false;
  const schedule = () => { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; positionDisplay(disp); }); };
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
  setInterval(schedule, 1000);
}

/* ---- 未查看标记 ---- */
function isViewed(href) {
  if (lastViewed == null) return true;
  const t = url2num(href), v = url2num(lastViewed);
  if (Number.isNaN(t) || Number.isNaN(v)) return true;
  return t <= v;
}
function markLatestViewed() {
  let newest;
  for (const item of gE('tr', 'all')) {
    const a = gE('.title .title a', item);
    if (!a) continue;
    const href = a.getAttribute('href');
    if (!href || Number.isNaN(url2num(href))) continue;
    if (newest === undefined || url2num(href) > url2num(newest)) newest = href;
  }
  if (newest === undefined) return;
  if (lastViewed != null && url2num(newest) <= url2num(lastViewed)) return;
  lastViewed = newest; saveLastData(); updateViewedButton(); onHandleItems(setDisplayHighlight);
}
function createViewedButton() {
  const btn = cE('button');
  btn.id = 'acgrip-view-button';
  btn.style.cssText = 'cursor:pointer;';
  btn.title = '将当前最新的链接及其之前的链接标记为已查看';
  btn.addEventListener('click', (e) => { e.stopPropagation(); markLatestViewed(); });
  return btn;
}
function updateViewedButton(btn) {
  btn = btn ?? document.getElementById('acgrip-view-button');
  if (!btn) return;
  btn.textContent = '标记已查看';
}

/* ---- 时间悬浮 ---- */
function setTimeHover() {
  for (const timeObj of gE('time', 'all')) {
    if (gE('.local', timeObj)) continue;
    const gap = timeObj.innerHTML.match(`(分)|(时)|(天)|(月)|(年)`)?.reverse().findIndex(x => x);
    let opt = JSON.parse(JSON.stringify(timeOpt));
    if (gap >= 3) opt.day = undefined;
    if (gap >= 2) opt.month = undefined;
    if (gap >= 1) opt.year = undefined;
    if (gap === 0) { [opt.hour, opt.minute, opt.second] = [undefined, undefined, undefined]; opt.year = '2-digit'; }
    timeObj.defaultHTML = timeObj.innerHTML;
    timeObj.hoverHTML = `<span class="local" style="color:cyan">${new Date(timeObj.getAttribute('datetime') * 1000).toLocaleString('zh-CN', opt).replaceAll('/', '-')}</span>`;
    timeObj.addEventListener('mouseenter', () => { timeObj.innerHTML = timeObj.hoverHTML; });
    timeObj.addEventListener('mouseleave', () => { timeObj.innerHTML = timeObj.defaultHTML; });
  }
}

/* ---- 页面高亮 ---- */
function setDisplayHighlight({ item, found, href }) {
  const color = getColor();
  for (const el of [item, ...gE('a', 'all', item)]) {
    if (color) el.style.color = color;
    else el.style.removeProperty('color');
  }
  function getColor() {
    switch (true) {
      case !!found: return isDownloaded(found, href) ? colors.downloaded : colors.tracking;
      case href === last: return colors.last;
      case !isViewed(href): return colors.unviewed;
    }
  }
}

/* ---- 手动点击下载 ---- */
document.addEventListener('click', function (e) {
  const a = e.target.closest('a');
  if (e.altKey && a) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    return;
  }
  const target = e.target.closest('a[href*=".torrent"]');
  if (!target || target._acgripHandled) return;
  target._acgripHandled = true;
  e.preventDefault();
  window.open(target.href, '_blank', 'noopener');
  const item = target.closest('tr');
  if (!item) return;
  const titleLink = item.querySelector('.title .title a');
  if (!titleLink) return;
  const href = titleLink.getAttribute('href');
  const title = titleLink.innerHTML.replace(/\s+/g, ' ');
  const { found, key } = matchTitle(title);
  if (found && !isDownloaded(found, href)) {
    let list = getDownloadedList(found);
    if (!list) { list = []; downloaded[found] = list; }
    list.push(href);
    saveBangumiData();
    lastDownload = found;
    saveLastData();
  }
  if (found) {
    console.log('[手动下载] 尝试同步下集', { key, title });
    syncNextEpisode(key, title);
  }
  if (key && !trackingItems[key]) {
    const timeEl = item.querySelector('time');
    if (timeEl) {
      const dt = Number(timeEl.getAttribute('datetime')) * 1000;
      if (dt && !isNaN(dt)) {
        const dhhmm = timeToDHHMM(dt);
        if (dhhmm) { trackingItems[key] = dhhmm; saveBangumiData(); loadDatas(); }
      }
    }
  }
  onHandleItems(setDisplayHighlight);
});

/* ---- 自动下载 ---- */
async function asyncDownloadTorrents() {
  downloadInProgress = true;
  try {
    let page = 0, html, done;
    let latest = last;
    while (!done && !html?.includes(last) && ++page <= 10) {
      html = page === 1 ? document.documentElement.outerHTML : await $ajax.fetch(`/page/${page}`);
      onHandleItems(({ item, found, key, title, href }) => {
        if (done = (url2num(href) <= url2num(last))) return;
        if (!found || isDownloaded(found, href)) return;
        const bd = getValue('bangumiData') ?? { rows: [] };
        const row = (bd.rows || []).find(r => String(r.规则 || '').trim() === key);
        if (row) {
          const parsed = parseBGMID(row.BGMID);
          const max = Number(parsed.最大) || 0, next = Number(row.下集) || 0;
          if (max > 0 && next > max) return;
          const epMatch = extractEpisodeFromRule(key, title);
          if (epMatch != null) {
            const total = getTotalEpisodes(row);
            if (epMatch !== next && epMatch !== total) return;
          }
        }
        const torrentLink = item.querySelector('a[href*=".torrent"]');
        if (torrentLink) torrentLink._acgripHandled = true;
        window.open(href + '.torrent', '_blank', 'noopener');
        let list = getDownloadedList(found);
        if (!list) { list = []; downloaded[found] = list; }
        list.push(href); saveBangumiData();
        if (url2num(href) <= url2num(latest)) return;
        latest = href; lastDownload = found; saveLastData();
        if (found) {
          console.log('[自动下载] 尝试同步下集', { key, title });
          syncNextEpisode(key, title);
        }
        if (key && !trackingItems[key]) {
          const timeEl = item.querySelector('time');
          if (timeEl) {
            const dt = Number(timeEl.getAttribute('datetime')) * 1000;
            if (dt && !isNaN(dt)) {
              const dhhmm = timeToDHHMM(dt);
              if (dhhmm) { trackingItems[key] = dhhmm; saveBangumiData(); }
            }
          }
        }
      }, $doc(html));
      onHandleItems(setDisplayHighlight);
      await sleep(_1s);
    }
    const trs = gE('tr', 'all');
    if (trs && trs.length >= 2) {
      const newLast = gE('.title .title a', trs[1])?.getAttribute('href');
      if (newLast && url2num(newLast) > url2num(last)) { last = newLast; saveLastData(); }
    }
  } finally { downloadInProgress = false; }
}
function extractEpisodeFromRule(key, title) {
  if (!key || !key.startsWith('/') || !key.endsWith('/') || key.length < 3) return null;
  try {
    const m = title.match(new RegExp(key.slice(1, -1)));
    if (!m || m[1] == null) return null;
    const ep = parseInt(m[1], 10);
    return Number.isFinite(ep) ? ep : null;
  } catch { return null; }
}
async function downloadSince(sinceUrl, onlyRules = null) {
  const since = url2num(sinceUrl);
  if (!since) return;
  let page = 0, html, done = false;
  while (!done && ++page <= 10) {
    html = page === 1 ? document.documentElement.outerHTML : await $ajax.fetch(`/page/${page}`);
    const doc = page === 1 ? document : $doc(html);
    let pageMin = Infinity;
    onHandleItems(({ item, found, key, title, href }) => {
      const n = url2num(href);
      if (!Number.isNaN(n) && n < pageMin) pageMin = n;
      if (Number.isNaN(n) || n <= since) return;
      if (onlyRules && !onlyRules.has(key)) return;
      if (!found || isDownloaded(found, href)) return;
      const torrentLink = item.querySelector('a[href*=".torrent"]');
      if (torrentLink) torrentLink._acgripHandled = true;
      window.open(href + '.torrent', '_blank', 'noopener');
      let list = getDownloadedList(found);
      if (!list) { list = []; downloaded[found] = list; }
      list.push(href); saveBangumiData();
      lastDownload = found; saveLastData();
      if (found) {
        console.log('[downloadSince] 尝试同步下集', { key, title });
        syncNextEpisode(key, title);
      }
      if (key && !trackingItems[key]) {
        const timeEl = item.querySelector('time');
        if (timeEl) {
          const dt = Number(timeEl.getAttribute('datetime')) * 1000;
          if (dt && !isNaN(dt)) {
            const dhhmm = timeToDHHMM(dt);
            if (dhhmm) { trackingItems[key] = dhhmm; saveBangumiData(); }
          }
        }
      }
    }, doc);
    if (pageMin === Infinity || pageMin <= since) done = true;
    if (!done) await sleep(_1s);
  }
  onHandleItems(setDisplayHighlight);
}

/* ---- 倒计时 ---- */
async function autoReload() {
  const index = gE('.post-index');
  if (!index) return;
  if (display) {
    if (!display.isConnected) getDisplayHost().appendChild(display);
    positionDisplay(display);
    return;
  }
  const disp = getDisplay();
  const now0 = new Date();
  const last = `${pad(now0.getMonth() + 1)}/${pad(now0.getDate())} 周${WEEKDAY_LABEL[now0.getDay()]} ${pad(now0.getHours())}:${pad(now0.getMinutes())}:${pad(now0.getSeconds())}`;
  let total = Infinity, next, nextTimeRaw = 0, done = false;
  const waitDuration = 2 * _1h, digits = 100;
  function computeCurrent() {
    const d = new Date();
    const [dd, h, m, s] = [(d.getDay() || 7) - 1, d.getHours(), d.getMinutes(), d.getSeconds()];
    return (((dd * _1d / _1h + h) * _1h / _1m + m) * _1m / _1s + s) * _1s;
  }
  function getRemain([i, t], current) {
    const time = (Math.floor(t / digits / digits) - 1) * _1d + Math.floor((t / digits) % digits) * _1h + t % digits * _1m;
    const delta = time + waitDuration - current;
    return [i, t, delta <= 0 ? time + 7 * _1d + waitDuration - current : delta];
  }
  function findNext(current) {
    let items = Object.entries(trackingItems)
    .map(([k, t]) => [k, isDHHMM(t) ? t : (inferredTimes[k] || 0)])
    .filter(([, t]) => t);
    if (!items.length) return null;
    items.sort((x, y) => getRemain(x, current)[2] - getRemain(y, current)[2]);
    items = items.filter(it => getRemain(it, current)[2] !== Infinity);
    if (!items.length) return null;
    const idx = items.findIndex(([it]) => [lastDownload, `/${lastDownload}/`].includes(it));
    return items[(idx + 1) % items.length];
  }
  loadDatas();
  inferredTimes = { ...inferredTimesCache, ...buildInferredTimesFromCurrentPage() };
  {
    const current = computeCurrent();
    const item = findNext(current);
    if (item) { [next, nextTimeRaw, total] = getRemain(item, current); total = Math.abs(total - waitDuration); }
    else { next = undefined; nextTimeRaw = 0; total = Infinity; }
  }
  (async () => {
    while (!done) {
      loadDatas();
      while (downloadInProgress) await sleep(_1s);
      const more = await buildInferredTimes();
      for (const k in more) inferredTimes[k] = more[k];
      const current = computeCurrent();
      const item = findNext(current);
      if (item) { [next, nextTimeRaw, total] = getRemain(item, current); total = Math.abs(total - waitDuration); }
      else { next = undefined; nextTimeRaw = 0; total = Infinity; }
      await sleep(_1s);
    }
  })();
  let remain, previous, waiting, start;
  while (!done) {
    if (next === undefined) {
      inferredTimes = { ...inferredTimesCache, ...buildInferredTimesFromCurrentPage() };
      const current = computeCurrent();
      const item = findNext(current);
      if (item) { [next, nextTime, total] = getRemain(item, current); total = Math.abs(total - waitDuration); continue; }
      const pendingKeys = Object.keys(trackingItems).filter(k => !isDHHMM(trackingItems[k]) && isRuleInferable(k));
      const lines = ['@' + last, '（等待调度信息…）'];
      lines.push(`待推断: ${pendingKeys.length} 条 | 已推断: ${Object.keys(inferredTimesCache).length} 条`);
      lines.push(inferenceStatus.message || inferenceStatus.phase);
      if (inferenceStatus.page) lines.push(`已扫描页: ${inferenceStatus.page}`);
      if (pendingKeys.length && pendingKeys.length <= 5) lines.push('待推断键:\n' + pendingKeys.map(k => '  ' + k).join('\n'));
      disp.timeText.innerText = lines.join('\n');
      await sleep(_1s);
      continue;
    }
    const now = new Date() * 1;
    if (next !== waiting) [previous, waiting, start] = [total, next, now];
    remain = previous - now + start;
    if (remain <= 0) { done = true; break; }
    const time = `${pad(Math.floor(remain / _1h / 24), ' ')}+${pad(Math.floor(remain % (24 * _1h) / _1h), ' ')}:${pad(Math.floor(remain % _1h / _1m))}:${pad(Math.floor(remain % _1m / _1s))}`;
    const nextTimeDisplay = `${pad(Math.floor(nextTimeRaw / digits / digits), ' ')}-${pad(Math.floor(nextTimeRaw / digits) % digits)}:${pad(Math.floor(nextTimeRaw % digits))}`;
    document.title = time;
    disp.timeText.innerText = `@${last}\n${time} ${next} @ ${nextTimeDisplay}`;
    await sleep(_1s);
  }
  if (!done) return;
  await sleep(_1s);
  window.location = window.location.href;
}

/* ---- 存储读写 ---- */
function coerceObject(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return undefined; } }
  if (typeof v === 'object') return v;
  return undefined;
}
function getValue(key) {
  try {
    const gm = GM_getValue(key);
    const gmObj = coerceObject(gm);
    if (gmObj !== undefined) { try { localStorage[key] = JSON.stringify(gmObj); } catch {} return gmObj; }
  } catch {}
  const localObj = coerceObject(localStorage[key]);
  if (localObj !== undefined) return localObj;
  return undefined;
}
function setValue(key, value) {
  try { localStorage[key] = JSON.stringify(value); } catch {}
  GM_setValue(key, value);
}
function showToast(msg) {
  const t = cE('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:10001;background:rgba(0,0,0,0.85);color:#eee;padding:6px 14px;border-radius:4px;font-size:12pt;pointer-events:none;opacity:1;transition:opacity .3s';
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; }, 1200);
  setTimeout(() => { t.remove(); }, 1600);
}

/* ---- 辅助函数 ---- */
function decodeHtmlEntities(s) {
  if (s == null) return s;
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
function matchTitle(title) {
  const m = tracking.find(t => t instanceof RegExp ? title.match(t) : title.includes(t));
  if (!m) return { found: '', key: '' };
  if (m instanceof RegExp) return { found: m.source, key: `/${m.source}/` };
  return { found: m, key: m };
}
function matchTitleWithKey(title, key) {
  if (key.startsWith('/') && key.endsWith('/') && key.length >= 2) {
    try { return new RegExp(key.slice(1, -1)).test(title); } catch { return false; }
  }
  return title.includes(key);
}
function effective(row, key, parsed) {
  const v = row[key];
  if (v !== '' && v != null) return v;
  return parsed?.[key] ?? '';
}
function parseBGMID(text) {
  if (!text) return {};
  const plain = decodeHtmlEntities(String(text).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim());
  const parts = plain.split(',');
  return { id: (parts[0] || '').trim(), 名称: (parts[1] || '').trim(), 中文: (parts[2] || '').trim(), 年: (parts[3] || '').trim(), 开播: (parts[4] || '').trim(), 最大: (parts[5] || '').trim() };
}
function getBgmIdFromBGMID(text) {
  const plain = decodeHtmlEntities(String(text || '').replace(/<[^>]+>/g, '')).trim();
  const m = plain.match(/^(\d+)(?:,|$)/);
  return m ? m[1] : '';
}
function isDHHMM(v) { const n = Number(v); return Number.isInteger(n) && n >= 10000 && n <= 79959; }
function isHttpUrl(v) { return /^https?:\/\//i.test(decodeHtmlEntities(String(v ?? '').trim())); }
function extractDomainLastTwo(url) {
  try {
    const host = new URL(decodeHtmlEntities(String(url))).hostname;
    const parts = host.split('.');
    return parts.length < 2 ? host : parts[parts.length - 2];
  } catch { return String(url).slice(0, 40); }
}
function extractFirstUrl(text) {
  if (!text) return '';
  const s = String(text);
  let m = s.match(/href\s*=\s*["']([^"']+)["']/i);
  if (m) return decodeHtmlEntities(m[1]);
  m = s.match(/https?:\/\/[^\s<>"']+/);
  return m ? decodeHtmlEntities(m[0]) : '';
}
function pad2Episode(ep) { const s = String(ep ?? ''); return s.length >= 2 ? s : s.padStart(2, '0'); }
function expandResourceUrl(url, row) {
  if (!url) return url;
  const decoded = decodeHtmlEntities(url);
  const ep = String(Number(row?.下集) || 1);
  return decoded.replace(/@@|@/g, (m) => m === '@@' ? pad2Episode(ep) : ep);
}
function getResourceDisplayInfo(row) {
  const rawRule = String(row.规则 ?? '').trim();
  const rawRes = String(row.资源 ?? '').trim();
  const ruleStr = expandResourceUrl(rawRule, row);
  const resStr = expandResourceUrl(rawRes, row);
  if (isDHHMM(row.资源)) return { text: String(row.资源), href: '' };
  if (isHttpUrl(ruleStr)) return { text: extractDomainLastTwo(ruleStr), href: ruleStr };
  if (isHttpUrl(resStr)) return { text: extractDomainLastTwo(resStr), href: resStr };
  if (ruleStr) return { text: '-', href: '' };
  return { text: resStr, href: '' };
}
function normalizeKai(kai) {
  const n = Number(kai) || 0;
  if (n <= 0) return 0;
  if (n < 100) return n * 100 + 1;
  return n;
}
function pad2Display(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!/^\d+$/.test(s)) return s;
  return s.padStart(2, '0');
}
function getTotalEpisodes(row) {
  const next = Number(row.下集) || 0, prev = Number(row.前季) || 0;
  return (next * prev) ? next + prev : 0;
}

/* ---- 延日公式求值器 ---- */
function tokenizeDelay(s) {
  const tokens = []; let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(s[i + 1] || ''))) {
      let j = i; while (j < s.length && /[\d.]/.test(s[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(s.slice(i, j)) }); i = j; continue;
    }
    if (ch === '@') { tokens.push({ t: 'at' }); i++; continue; }
    if (ch === '{') {
      let j = i + 1, depth = 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      const arr = s.slice(i + 1, j).split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));
      tokens.push({ t: 'arr', v: arr }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      tokens.push({ t: 'ident', v: s.slice(i, j).toUpperCase() }); i = j; continue;
    }
    const two = s.substr(i, 2);
    if (['>=', '<=', '==', '!='].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/()<>^,'.includes(ch)) { tokens.push({ t: 'op', v: ch }); i++; continue; }
    i++;
  }
  return tokens;
}
function toRPN(tokens) {
  const out = [], stack = [];
  const prec = { '==': 1, '!=': 1, '>': 2, '<': 2, '>=': 2, '<=': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  const rightAssoc = new Set(['^']);
  const funcs = new Set(['SUM', 'MIN', 'MAX', 'ABS', 'AVG']);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'num' || t.t === 'at' || t.t === 'arr') { out.push(t); continue; }
    if (t.t === 'ident') { if (funcs.has(t.v)) stack.push({ t: 'func', v: t.v }); continue; }
    if (t.v === '(') { stack.push(t); continue; }
    if (t.v === ')') {
      while (stack.length && stack[stack.length - 1].v !== '(') out.push(stack.pop());
      if (stack.length && stack[stack.length - 1].v === '(') stack.pop();
      if (stack.length && stack[stack.length - 1].t === 'func') out.push(stack.pop());
      continue;
    }
    if (t.v === ',') { while (stack.length && stack[stack.length - 1].v !== '(') out.push(stack.pop()); continue; }
    if (t.v === '-' || t.v === '+') {
      const p = tokens[i - 1];
      const unary = !p || (p.t === 'op' && (p.v === '(' || p.v === ',' || ['+','-','*','/','^','<','>','<=','>=','==','!='].includes(p.v)));
      if (unary) { if (t.v === '-') stack.push({ t: 'op', v: 'u-' }); continue; }
    }
    while (stack.length && stack[stack.length - 1].t === 'op' && stack[stack.length - 1].v !== '(') {
      const top = stack[stack.length - 1];
      const p1 = prec[t.v] ?? 0, p2 = prec[top.v === 'u-' ? '-' : top.v] ?? 0;
      if (p2 > p1 || (p2 === p1 && !rightAssoc.has(t.v))) out.push(stack.pop());
      else break;
    }
    stack.push(t);
  }
  while (stack.length) {
    const top = stack.pop();
    if (top.t === 'op' && top.v === '(') continue;
    out.push(top);
  }
  return out;
}
function evalRPN(rpn, ep) {
  const stack = [];
  const isArr = a => Array.isArray(a);
  const mapBinOp = (a, b, fn) => {
    if (isArr(a) && isArr(b)) return a.map((x, i) => fn(x, b[i]));
    if (isArr(a)) return a.map(x => fn(x, b));
    if (isArr(b)) return b.map(x => fn(a, x));
    return fn(a, b);
  };
  for (const t of rpn) {
    if (t.t === 'num') { stack.push(t.v); continue; }
    if (t.t === 'at') { stack.push(ep); continue; }
    if (t.t === 'arr') { stack.push(t.v); continue; }
    if (t.t === 'func') {
      const arg = stack.pop();
      const flat = isArr(arg) ? arg : [arg];
      let v = 0;
      switch (t.v) {
        case 'SUM': v = flat.reduce((a, b) => a + Number(b || 0), 0); break;
        case 'MIN': v = Math.min(...flat.map(Number)); break;
        case 'MAX': v = Math.max(...flat.map(Number)); break;
        case 'ABS': v = Math.abs(Number(flat[0] || 0)); break;
        case 'AVG': v = flat.reduce((a, b) => a + Number(b || 0), 0) / flat.length; break;
      }
      stack.push(v); continue;
    }
    if (t.t === 'op') {
      if (t.v === 'u-') { const a = stack.pop(); stack.push(isArr(a) ? a.map(x => -Number(x)) : -Number(a)); continue; }
      const b = stack.pop(), a = stack.pop();
      let v;
      switch (t.v) {
        case '+': v = mapBinOp(a, b, (x, y) => Number(x) + Number(y)); break;
        case '-': v = mapBinOp(a, b, (x, y) => Number(x) - Number(y)); break;
        case '*': v = mapBinOp(a, b, (x, y) => Number(x) * Number(y)); break;
        case '/': v = mapBinOp(a, b, (x, y) => Number(x) / Number(y)); break;
        case '^': v = mapBinOp(a, b, (x, y) => Math.pow(Number(x), Number(y))); break;
        case '>':  v = mapBinOp(a, b, (x, y) => Number(x) > Number(y)  ? 1 : 0); break;
        case '<':  v = mapBinOp(a, b, (x, y) => Number(x) < Number(y)  ? 1 : 0); break;
        case '>=': v = mapBinOp(a, b, (x, y) => Number(x) >= Number(y) ? 1 : 0); break;
        case '<=': v = mapBinOp(a, b, (x, y) => Number(x) <= Number(y) ? 1 : 0); break;
        case '==': v = mapBinOp(a, b, (x, y) => Number(x) === Number(y) ? 1 : 0); break;
        case '!=': v = mapBinOp(a, b, (x, y) => Number(x) !== Number(y) ? 1 : 0); break;
      }
      stack.push(v); continue;
    }
  }
  const result = stack[0];
  if (Array.isArray(result)) return result.reduce((a, b) => a + Number(b || 0), 0);
  return result;
}
function evalDelayFormula(expr, row) {
  if (expr == null || expr === '') return NaN;
  const s = String(expr).trim();
  if (!s) return NaN;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const ep = Number(row && row['下集']) || 0;
  try { return evalRPN(toRPN(tokenizeDelay(s)), ep); }
  catch (e) { console.error('evalDelayFormula error:', e); return NaN; }
}

/* ---- 时间推断 ---- */
function timeToDHHMM(ms) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return 0;
  return (d.getDay() || 7) * 10000 + d.getHours() * 100 + d.getMinutes();
}
function loadInferredCache() {
  if (_inferredCacheLoaded) return;
  _inferredCacheLoaded = true;
  inferredTimesCache = getUpdated().schedule;
}
function saveInferredCache() { setUpdated({ schedule: { ...inferredTimesCache } }); }
function writeInferredTime(key, val) {
  if (isDHHMM(trackingItems[key])) return false;
  trackingItems[key] = val;
  const bd = getValue('bangumiData');
  if (!bd || !Array.isArray(bd.rows)) return false;
  let changed = false;
  for (const r of bd.rows) if (String(r.规则 || '').trim() === key) { r.资源 = val; changed = true; break; }
  if (changed) setValue('bangumiData', bd);
  return changed;
}
function buildInferredTimesFromCurrentPage() {
  const map = {};
  const pending = Object.keys(trackingItems).filter(k => !isDHHMM(trackingItems[k]) && !inferredTimesCache[k] && isRuleInferable(k));
  if (!pending.length) return map;
  for (const item of [...gE('tr', 'all')].reverse()) {
    const a = gE('.title .title a', item); if (!a) continue;
    const title = a.innerHTML.replace(/\s+/g, ' ');
    const timeEl = gE('time', item); if (!timeEl) continue;
    const dt = Number(timeEl.getAttribute('datetime')) * 1000;
    if (!dt || isNaN(dt)) continue;
    for (const key of pending) {
      if (matchTitleWithKey(title, key)) {
        const val = timeToDHHMM(dt);
        map[key] = val; inferredTimesCache[key] = val; writeInferredTime(key, val);
      }
    }
  }
  if (Object.keys(map).length) saveInferredCache();
  return map;
}
async function buildInferredTimes() {
  let waitCount = 0;
  while (downloadInProgress && waitCount < 60) await sleep(_1s), waitCount++;
  const allPending = Object.keys(trackingItems).filter(k => !isDHHMM(trackingItems[k]) && isRuleInferable(k));
  if (!allPending.length) return { ...inferredTimesCache };
  if (inferenceStatus.scanning || _inferScannedThisSession) {
    const cur = {};
    for (const k of allPending) if (inferredTimesCache[k]) cur[k] = inferredTimesCache[k];
    return cur;
  }
  inferenceStatus = { ...inferenceStatus, scanning: true };
  const stillPending = allPending.filter(k => !isDHHMM(trackingItems[k]) && !inferredTimesCache[k] && isRuleInferable(k));
  if (!stillPending.length) {
    _inferScannedThisSession = true;
    inferenceStatus = { ...inferenceStatus, phase: 'done', pending: 0, found: 0, page: 0, message: '全部命中缓存', scanning: false };
    return { ...inferredTimesCache };
  }
  const oneWeekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const remaining = new Set(stillPending);
  let page = 0, roundHits = 0;
  while (remaining.size && page < 50) {
    page++;
    inferenceStatus = { ...inferenceStatus, phase: 'fetching', page, pending: remaining.size, found: roundHits, message: `扫描第 ${page} 页…` };
    let html, doc;
    if (page === 1) { html = document.documentElement.outerHTML; doc = document; }
    else {
      try { html = await $ajax.fetch(`/page/${page}`); }
      catch { inferenceStatus = { ...inferenceStatus, phase: 'failed', message: `第 ${page} 页抓取失败` }; break; }
      if (!html) break;
      doc = $doc(html);
    }
    let pageOldest = Infinity;
    for (const item of [...gE('tr', 'all', doc)].reverse()) {
      const a = gE('.title .title a', item); if (!a) continue;
      const title = a.innerHTML.replace(/\s+/g, ' ');
      const timeEl = gE('time', item);
      let dt = 0;
      if (timeEl) {
        const t = Number(timeEl.getAttribute('datetime')) * 1000;
        if (t && !isNaN(t)) { dt = t; if (t < pageOldest) pageOldest = t; }
      }
      for (const key of [...remaining]) {
        if (!matchTitleWithKey(title, key) || !dt) continue;
        const val = timeToDHHMM(dt);
        inferredTimesCache[key] = val; writeInferredTime(key, val);
        remaining.delete(key); roundHits++;
        saveInferredCache();
      }
      if (!remaining.size) break;
    }
    if (pageOldest === Infinity || pageOldest < oneWeekAgo) break;
    if (remaining.size && page < 50) await sleep(_1s);
  }
  saveInferredCache();
  _inferScannedThisSession = true;
  inferenceStatus = { phase: 'done', pending: remaining.size, found: roundHits, page, message: `扫描 ${page} 页：命中 ${roundHits} 条，仍未命中 ${remaining.size} 条`, scanning: false };
  return { ...inferredTimesCache };
}
function syncNextEpisode(key, title) {
  if (!key) { console.log('[syncNextEpisode] 空 key'); return false; }
  try {
    if (!(key.startsWith('/') && key.endsWith('/') && key.length >= 3)) {
      console.log('[syncNextEpisode] 非正则规则，跳过', { key });
      return false;
    }
    const ep = extractEpisodeFromRule(key, title);
    if (ep == null) {
      console.log('[syncNextEpisode] 未能从标题提取集数', { key, title });
      return false;
    }

    let newNextValue = null;
    let hitInfo = null;

    const bd = getValue('bangumiData');
    if (bd && Array.isArray(bd.rows)) {
      for (const r of bd.rows) {
        if ((r.规则 || '').trim() !== key) continue;

        const curNext = Number(r.下集) || 0;
        const total = getTotalEpisodes(r);
        const hitNext = (ep === curNext);
        const hitTotal = (total > 0 && ep === total);

        hitInfo = { key, ep, curNext, total, hitNext, hitTotal };
        console.log('[syncNextEpisode] 检查', hitInfo);

        if (hitNext || hitTotal) {
          newNextValue = curNext + 1;
          r.下集 = String(newNextValue);
          setValue('bangumiData', bd);
          console.log('[syncNextEpisode] 存储已更新', { key, old: curNext, new: newNextValue });
        } else {
          console.log('[syncNextEpisode] 未命中（ep≠下集 且 ep≠总集），不改', hitInfo);
        }
        break;
      }
    }

    if (newNextValue == null) return false;

    // 同步面板（如果打开）
    if (_gmEditOverlay && _gmEditOverlay.isConnected && _gmEditOverlay.style.display !== 'none'
        && typeof _gmEditOverlay._syncRowUpdate === 'function') {
      _gmEditOverlay._syncRowUpdate(key, newNextValue);
    }

    // 同步草稿（如果存在），避免下次打开面板读到旧值
    try {
      const draftRaw = localStorage.getItem(DRAFT_KEY);
      if (draftRaw) {
        const draft = JSON.parse(draftRaw);
        if (draft && Array.isArray(draft.rows)) {
          let draftChanged = false;
          for (const r of draft.rows) {
            if ((r.规则 || '').trim() === key && String(r.下集 || '') !== String(newNextValue)) {
              r.下集 = String(newNextValue);
              draftChanged = true;
              break;
            }
          }
          if (draftChanged) {
            draft.ts = Date.now();
            localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
            console.log('[syncNextEpisode] 草稿已同步', { key, new: newNextValue });
          }
        }
      }
    } catch {}

    return true;
  } catch (e) {
    console.error('[syncNextEpisode] 出错', e, { key, title });
    return false;
  }
}

/* ---- 更新节奏 / 播出时间 ---- */
function parseUpdateColumn(text) {
  const episodes = Array(7).fill(0);
  if (!text) return { episodes };
  const s = String(text), tokens = [], seps = [];
  let cur = '';
  for (const ch of s) {
    if (ch === '|' || ch === ',') { tokens.push(cur); seps.push(ch); cur = ''; }
    else cur += ch;
  }
  tokens.push(cur);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i].trim();
    if (tok === '') { i++; continue; }
    const num = parseInt(tok, 10);
    if (!Number.isFinite(num) || num < 1 || num > 7) { i++; continue; }
    if (seps[i] === ',') {
      const nextTok = (tokens[i + 1] ?? '').trim();
      if (nextTok !== '') {
        const ep = Number(nextTok);
        episodes[num - 1] = (Number.isFinite(ep) && ep > 0) ? ep : 1;
        i += 2; continue;
      }
    }
    episodes[num - 1] = 1; i++;
  }
  return { episodes };
}
function getMultiUpdateDuration(startDay, startEP, currentEP, episodes) {
  if (currentEP <= startEP) return 0;
  const allZero = episodes.every(e => !e);
  const epArr = allZero ? Array(7).fill(1) : episodes;
  let duration = 0, day = startDay, ep = startEP, safety = 0;
  while (ep < currentEP) {
    duration++;
    day = day === 7 ? 1 : day + 1;
    ep += epArr[day - 1] || 0;
    if (++safety > 5000) break;
  }
  return duration;
}
function getAirDate(row, parsed, delayGetter) {
  parsed = parsed ?? parseBGMID(row.BGMID);
  const year = Number(effective(row, '年', parsed));
  const kai = normalizeKai(Number(effective(row, '开播', parsed)));
  if (!year || !kai) return null;
  const mm = Math.floor(kai / 100), dd = kai % 100;
  const houRaw = String(effective(row, '放送', parsed) ?? '').trim();
  let hh = 0, mi = 0;
  if (houRaw && !isNaN(Number(houRaw))) { const hou = Number(houRaw); hh = Math.floor(hou / 100); mi = hou % 100; }
  const startDate = new Date(2000 + year, mm - 1, dd, hh, mi, 0);
  if (isNaN(startDate.getTime())) return null;
  const startEP = Number(effective(row, '初始', parsed)) || 1;
  const currentEP = Number(row.下集) || startEP;
  const updateText = String(row.更新 ?? '').trim();
  let duration;
  if (updateText) {
    const { episodes } = parseUpdateColumn(updateText);
    duration = getMultiUpdateDuration(startDate.getDay() || 7, startEP, currentEP, episodes);
  } else duration = (currentEP - startEP) * 7;
  let delayWeeks = 0;
  const manualW = String(row.延周 ?? '').trim();
  if (manualW) { const n = Number(manualW); if (Number.isFinite(n)) delayWeeks = n; }
  else if (typeof delayGetter === 'function') { const r = delayGetter(row, parsed); if (r && Number.isFinite(r.total)) delayWeeks = r.total; }
  let delayDays = 0;
  const manualD = String(row.延日 ?? '').trim();
  if (manualD) {
    if (/^-?\d+(\.\d+)?$/.test(manualD)) delayDays = Number(manualD);
    else { const v = evalDelayFormula(manualD, row); if (Number.isFinite(v)) delayDays = v; }
  }
  return new Date(startDate.getTime() + (duration + delayWeeks * 7 + delayDays) * 86400000);
}
function getAirDateAdjusted(row, delayGetter) {
  const airDate = getAirDate(row, null, delayGetter);
  if (!airDate) return null;
  return new Date(airDate.getTime() - 4 * 3600 * 1000);
}
function computeAirTimeText(row, parsed, delayGetter) {
  parsed = parsed ?? parseBGMID(row.BGMID);
  const airDate = getAirDate(row, parsed, delayGetter);
  if (!airDate) return '';
  const houRaw = String(effective(row, '放送', parsed) ?? '').trim();
  const hasTime = houRaw !== '' && !isNaN(Number(houRaw)) && Number(houRaw) > 0;
  const adjusted = hasTime ? new Date(airDate.getTime() - 4 * 3600 * 1000) : airDate;
  const base = `${pad(adjusted.getMonth() + 1)}/${pad(adjusted.getDate())} ${WEEKDAY_LABEL[adjusted.getDay()]}`;
  if (!hasTime) return base;
  const hh = airDate.getHours(), mm = airDate.getMinutes();
  const displayH = hh < 4 ? hh + 24 : hh;
  return `${base} ${pad(displayH)}:${pad(mm)}`;
}
const BG_LEVELS = [
  '#000000', // -1: 空值专用（= 标题栏纯黑），仅由 getBgByLevel(-1) 触发
  '#121212', // 0: 今天 4:00 之前
  '#1e1e1e', // 1: 今日已播出
  '#2a2a2a', // 2: 今日稍后
  '#363636', // 3: 明天
  '#424242', // 4: 后天
  '#4e4e4e', // 5: +3
  '#5a5a5a', // 6: +4
  '#666666', // 7: +5
  '#727272', // 8: +6
  '#7e7e7e', // 9: 7 天以后 / 未定
];

// 空值格的"上一时间段"下限允许到 -1（纯黑）
const BG_EMPTY_MIN_LEVEL = -1;

function getBgLevel(airDate) {
  if (!airDate) return 9;
  const now = new Date();
  const today4 = new Date(now); today4.setHours(4, 0, 0, 0);
  if (now < today4) today4.setDate(today4.getDate() - 1);
  const nowMs = now.getTime();
  const today4Ms = today4.getTime();
  const tomorrow4Ms = today4Ms + 86400000;
  const t = airDate.getTime();
  if (t < today4Ms) return 0;
  if (t < nowMs) return 1;
  if (t < tomorrow4Ms) return 2;
  if (t < tomorrow4Ms + 1 * 86400000) return 3;
  if (t < tomorrow4Ms + 2 * 86400000) return 4;
  if (t < tomorrow4Ms + 3 * 86400000) return 5;
  if (t < tomorrow4Ms + 4 * 86400000) return 6;
  if (t < tomorrow4Ms + 5 * 86400000) return 7;
  if (t < tomorrow4Ms + 6 * 86400000) return 8;
  return 9;
}

function getBgByLevel(level, allowNegative) {
  const minLevel = allowNegative ? -1 : 0;
  if (level < minLevel) level = minLevel;
  if (level > 9) level = 9;
  // BG_LEVELS 索引 = level + 1（因为多了 -1 项）
  return BG_LEVELS[level + 1];
}

function getBgByDate(airDate) {
  return getBgByLevel(getBgLevel(airDate), false);
}
function darkerColor(hex) {
  if (!hex) return hex;
  let r, g, b;
  if (hex.startsWith('#')) {
    const h = hex.slice(1);
    if (h.length === 3) { r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16); }
    else { r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); }
  } else if (hex.startsWith('rgb')) { const m = hex.match(/\d+/g); [r, g, b] = m.map(Number); }
  else return hex;
  const f = 0.55;
  return `rgb(${Math.max(0, Math.round(r * f))},${Math.max(0, Math.round(g * f))},${Math.max(0, Math.round(b * f))})`;
}
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDateKey(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function collectTrackingFromRows(rows) {
  const t = {};
  for (const r of rows) { if (!r.规则) continue; t[r.规则] = isDHHMM(r.资源) ? r.资源 : ''; }
  return t;
}

/* ---- 导入 / 富文本 ---- */
function importTableHtml(html) {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;
  const table = doc.querySelector('table');
  if (!table) return [];
  const rows = [...table.querySelectorAll('tr')];
  if (rows.length < 2) return [];
  const headers = [...rows[0].querySelectorAll('td,th')].map(c => c.textContent.trim());
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = [...rows[i].querySelectorAll('td,th')];
    if (!cells.length) continue;
    const obj = {}; let resourceCell = null;
    for (let j = 0; j < Math.min(headers.length, cells.length); j++) {
      const mapped = IMPORT_HEADER_ALIASES[headers[j]];
      if (!mapped) continue;
      const cell = cells[j];
      if (mapped === 'BGMID') obj[mapped] = cell.innerHTML;
      else if (mapped === '资源') resourceCell = cell;
      else obj[mapped] = cell.textContent.trim();
    }
    if (resourceCell) {
      const cellHtml = resourceCell.innerHTML;
      const linkMatch = cellHtml.match(/<a[^>]+href\s*=\s*["']([^"']+)["']/i);
      if (linkMatch) { if (!obj['规则']) obj['规则'] = decodeHtmlEntities(linkMatch[1]); }
      else { if (!obj['资源']) obj['资源'] = decodeHtmlEntities(resourceCell.textContent.trim()); }
    }
    if (Object.values(obj).some(v => v)) result.push(obj);
  }
  return result;
}
function cleanPastedHtml(html) {
  const tmp = document.createElement('div'); tmp.innerHTML = html;
  const result = [];
  function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) result.push(escapeHtml(child.textContent));
      else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'A' && child.getAttribute('href')) {
          result.push(`<a href="${escapeAttr(decodeHtmlEntities(child.getAttribute('href')))}">${escapeHtml(child.textContent || '')}</a>`);
        } else if (child.tagName === 'BR') result.push('\n');
        else walk(child);
      }
    }
  }
  walk(tmp);
  return result.join('');
}
function cleanBGMID(html) {
  if (!html) return '';
  const cleaned = cleanPastedHtml(html);
  if (!cleaned.replace(/\n/g, '').replace(/&nbsp;/g, '').replace(/<[^>]+>/g, '').trim()) return '';
  return cleaned.trim();
}

/* ---- Bangumi 定时更新 ---- */
function pad2(n) { return String(n).padStart(2, '0'); }
function parseBangumiSubject(html, subjectId) {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = html;
  let officialUrl = '';
  const infoItems = doc.querySelectorAll('#infobox li');
  for (const li of infoItems) {
    const span = li.querySelector('span');
    if (span && /官方网站/.test(span.textContent)) {
      const a = li.querySelector('a');
      if (a && a.href) { officialUrl = a.href; break; }
    }
  }
  if (!officialUrl) {
    const nameSingleA = doc.querySelector('.nameSingle a');
    if (nameSingleA && /^https?:\/\//i.test(nameSingleA.href)) officialUrl = nameSingleA.href;
  }
  let bgmName = '', bgmTrans = '';
  const nameA = doc.querySelector('h1.nameSingle a') || doc.querySelector('.nameSingle a[href^="/subject/"]');
  if (nameA) {
    const textContent = (nameA.textContent || '').trim();
    const titleAttr = (nameA.getAttribute('title') || '').trim();
    const cjkText = (textContent.match(/[\u4e00-\u9fff]/g) || []).length;
    const cjkTitle = (titleAttr.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjkText > cjkTitle) { bgmTrans = textContent; bgmName = titleAttr || textContent; }
    else if (cjkTitle > cjkText) { bgmName = textContent; bgmTrans = titleAttr; }
    else { bgmName = textContent || titleAttr; bgmTrans = titleAttr && titleAttr !== bgmName ? titleAttr : ''; }
  }
  let y = '0', md = '0000', eps = 0;
  for (const li of infoItems) {
    const text = (li.textContent || '').trim();
    if (!/开始/.test(text) && !/放送/.test(text)) continue;
    let m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (!m) m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) m = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (m) { y = String(Number(m[1]) % 100).padStart(2, '0'); md = pad2(Number(m[2])) + pad2(Number(m[3])); break; }
  }
  const prg = doc.querySelectorAll('.prg_list li');
  for (const ep of prg) { if (ep.classList.contains('subtitle')) break; eps++; }
  const bgmId = officialUrl
    ? `<a href="${officialUrl}"><span style="color:#8F8F8F">${subjectId},${bgmName},${bgmTrans},${y},${md},${eps}</span></a>`
    : `<span style="color:#8F8F8F">${subjectId},${bgmName},${bgmTrans},${y},${md},${eps}</span>`;
  return { bgmId, bgmName, bgmTrans, y, md, eps, officialUrl };
}
function rowIsEmpty(r) {
  if (!r) return true;
  const keys = ['下集','中文','名称','年','开播','放送','最大','初始','前季','更新','BGMID','资源','规则','延周','延日','已下载'];
  return keys.every(k => {
    const v = r[k];
    if (Array.isArray(v)) return v.length === 0;
    return String(v ?? '').trim() === '';
  });
}
async function fetchBangumiHomeIds() {
  const html = await $ajax.fetch('https://bangumi.tv/', null, 'GET');
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = html;
  let containers = doc.querySelectorAll('[class*="infoWrapperContainer"]');
  if (!containers.length) containers = doc.querySelectorAll('[class*="infoWrapper"]');
  if (!containers.length) containers = doc.querySelectorAll('.browserFull, .browserCoverList, #browserItemList');
  let ids = new Set();
  if (containers.length) {
    for (const c of containers) for (const a of c.querySelectorAll('a[href^="/subject/"]')) {
      const m = a.getAttribute('href').match(/\/subject\/(\d+)/);
      if (m) ids.add(m[1]);
    }
  }
  if (!ids.size) {
    for (const a of doc.querySelectorAll('a[href^="/subject/"]')) {
      if (a.closest('#headerNeue2, .mainNav, nav, footer, #footer')) continue;
      const m = a.getAttribute('href').match(/\/subject\/(\d+)/);
      if (m) ids.add(m[1]);
    }
  }
  return ids.size ? { ids: [...ids], ok: true } : { ids: [], ok: false };
}
async function fetchBangumiSubject(id) {
  const html = await $ajax.fetch(`https://bangumi.tv/subject/${id}`, null, 'GET');
  return parseBangumiSubject(html, id);
}
async function autoUpdateFromBangumi() {
  const u = getUpdated();
  if (Date.now() - u.bangumi < BANGUMI_INTERVAL) return;
  setUpdated({ bangumi: Date.now() });
  let homeResult;
  try { homeResult = await fetchBangumiHomeIds(); }
  catch (e) { console.error('fetchBangumiHomeIds failed:', e); return; }
  if (!homeResult.ids.length) return;
  const bd = getValue('bangumiData') ?? { rows: [], delay: { rows: [] } };
  if (!Array.isArray(bd.rows)) bd.rows = [];
  const existingIds = new Set();
  for (const r of bd.rows) { const bid = getBgmIdFromBGMID(r.BGMID); if (bid) existingIds.add(bid); }
  let added = 0;
  for (const id of homeResult.ids) {
    if (existingIds.has(id)) continue;
    try {
      const info = await fetchBangumiSubject(id);
      let target = null;
      if (bd.rows.length && rowIsEmpty(bd.rows[bd.rows.length - 1])) target = bd.rows[bd.rows.length - 1];
      if (!target) { target = {}; bd.rows.push(target); }
      Object.assign(target, { 下集: '01', 中文: '', 名称: '', 年: '', 开播: '', 放送: '', 最大: '', 初始: '', 前季: '', 更新: '', BGMID: info.bgmId, 资源: '', 规则: '', 延周: '', 延日: '', 已下载: [] });
      existingIds.add(id); added++;
    } catch (e) { console.error('fetchBangumiSubject failed:', id, e); }
    await sleep(_1s);
  }
  setValue('bangumiData', bd);
}
async function autoUpdateQuarter() {
  const now = new Date();
  const month = now.getMonth() + 1;
  if (![1, 4, 7, 10].includes(month)) return;
  const qKey = `${now.getFullYear()}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (getUpdated().quarter === qKey) return;
  setUpdated({ quarter: qKey });
  const bd = getValue('bangumiData') ?? { rows: [], delay: { rows: [] } };
  if (!Array.isArray(bd.rows)) bd.rows = [];
  let changed = false;
  for (const r of bd.rows) {
    const bgmId = getBgmIdFromBGMID(r.BGMID);
    if (!bgmId) continue;
    const parsed = parseBGMID(r.BGMID);
    const missCN = !String(parsed.中文 ?? '').trim();
    const missYear = !String(parsed.年 ?? '').trim();
    const missKai = !String(parsed.开播 ?? '').trim();
    const missMax = !String(parsed.最大 ?? '').trim();
    const missUrl = !extractFirstUrl(r.BGMID);
    if (!(missCN || missYear || missKai || missMax || missUrl)) continue;
    try { const info = await fetchBangumiSubject(bgmId); r.BGMID = info.bgmId; changed = true; }
    catch (e) { console.error('quarter update failed:', bgmId, e); }
    await sleep(_1s);
  }
  if (changed) setValue('bangumiData', bd);
}
async function updateFromBangumiSubjectPage() {
  const m = window.location.href.match(/\/subject\/(\d+)/);
  if (!m) return;
  const subjectId = m[1];

  // 复用已有的解析器：从当前页面 HTML 提取最新信息
  const info = parseBangumiSubject(document.documentElement.innerHTML, subjectId);

  const bd = getValue('bangumiData');
  if (!bd || !Array.isArray(bd.rows)) return;

  let changed = false;
  let rowCount = 0;
  for (const row of bd.rows) {
    const id = getBgmIdFromBGMID(row.BGMID);
    if (id !== subjectId) continue;
    rowCount++;
    if (row.BGMID !== info.bgmId) {
      row.BGMID = info.bgmId;
      changed = true;
    }
  }

  if (changed) {
    setValue('bangumiData', bd);
    console.log('[SubjectPage] 已更新 BGMID', subjectId, `(影响 ${rowCount} 行)`);
    showToast(`已更新条目信息（${rowCount} 行）`);
    // 若同浏览器其他标签打开了编辑面板，需手动关闭再打开以看到更新
  } else {
    console.log('[SubjectPage] 无需更新', subjectId);
  }
}
/* ============ 编辑对话框 ============ */
function showEditDialog() {
  if (_gmEditShow) { _gmEditShow(); return; }
  if (document.getElementById('gmEditOverlay')) return;

  let bd = getValue('bangumiData') ?? { rows: [], delay: { rows: [] } };
  let draftLast = null;
  try {
    const draftRaw = localStorage.getItem('acgrip_draft_edit');
    if (draftRaw) {
      const draft = JSON.parse(draftRaw);
      if (draft && Array.isArray(draft.rows) && draft.rows.length) {
        bd = { rows: draft.rows, delay: draft.delay || { rows: [] } };
        draftLast = draft.last || null;
      }
    }
  } catch {}

  const storedRows = Array.isArray(bd.rows) ? bd.rows.map(r => ({ ...r })) : [];
  const storedLastData = getValue(LAST_KEY);
  const storedLast = draftLast?.id ?? ((storedLastData && typeof storedLastData === 'object') ? (storedLastData.id ?? '') : '');
  const storedLastDownload = draftLast?.match ?? ((storedLastData && typeof storedLastData === 'object') ? (storedLastData.match ?? '') : '');
  const storedLastViewed = draftLast?.viewed ?? ((storedLastData && typeof storedLastData === 'object') ? (storedLastData.viewed ?? '') : '');
  const oldTrackingKeys = new Set(Object.keys(collectTrackingFromRows(storedRows)));
  let delayData = { rows: [] };
  if (bd.delay && Array.isArray(bd.delay.rows)) delayData = { rows: bd.delay.rows };

  const overlay = cE('div');
  overlay.id = 'gmEditOverlay';
  overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;justify-content:center;align-items:center;color-scheme:dark;box-sizing:border-box;`;
  let hideDialog = () => {};   // 末尾赋值
  const dialog = cE('div');
  dialog.style.cssText = `background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:8px;width:max-content;max-width:calc(100vw - 40px);max-height:calc(100vh - 20px);overflow:auto;box-shadow:0 4px 12px rgba(0,0,0,0.6);border:1px solid #333;box-sizing:border-box;`;
  const styleTag = cE('style');
  styleTag.textContent = `
    /* ---------- 普通列文字颜色 ---------- */
    #gmEditOverlay .u-main-table td:nth-child(6) input,
    #gmEditOverlay .u-main-table td:nth-child(7) input,
    #gmEditOverlay .u-main-table td:nth-child(8) .u-bgmid,
    #gmEditOverlay .u-main-table td:nth-child(9) input,
    #gmEditOverlay .u-main-table td:nth-child(10) input,
    #gmEditOverlay .u-main-table td:nth-child(11) input,
    #gmEditOverlay .u-main-table td:nth-child(12) input,
    #gmEditOverlay .u-main-table td:nth-child(13) input,
    #gmEditOverlay .u-main-table td:nth-child(14) input,
    #gmEditOverlay .u-main-table td:nth-child(15) input,
    #gmEditOverlay .u-main-table td:nth-child(16) input,
    #gmEditOverlay .u-main-table td:nth-child(17) input,
    #gmEditOverlay .u-main-table td:nth-child(18) textarea.u-downloaded { color: #8F8F8F; }

    /* ---------- placeholder ---------- */
    #gmEditOverlay .u-main-table td:nth-child(9) input::placeholder,
    #gmEditOverlay .u-main-table td:nth-child(10) input::placeholder,
    #gmEditOverlay .u-main-table td:nth-child(11) input::placeholder,
    #gmEditOverlay .u-main-table td:nth-child(12) input::placeholder,
    #gmEditOverlay .u-main-table td:nth-child(14) input::placeholder { color: #5a5a5a; }

    /* ---------- 基础主题 ---------- */
    #gmEditOverlay, #gmEditOverlay * { color-scheme: dark; font-size: 12pt; }
    #gmEditOverlay { color:#d4d4d4; }
    #gmEditOverlay h2 { font-size: 15pt; margin: 0 0 6px 0; display:flex; align-items:center; }
    #gmEditOverlay .info-icon { display:inline-block; margin-left:8px; cursor:help; color:#66c6ff; font-size:13pt; user-select:none; }

    /* ---------- 按钮 ---------- */
    #gmEditOverlay button { background:#2d2d2d; color:#d4d4d4; border:1px solid #444; border-radius:4px; cursor:pointer; padding:2px 10px; font-size: 12pt; line-height: 1.3; }
    #gmEditOverlay button:hover { background:#3a3a3a; }

    /* ---------- 输入框 / 下拉框 ---------- */
    #gmEditOverlay input,
    #gmEditOverlay select { background:#252525; color:#d4d4d4; border:1px solid #444; font-size: 12pt; }
    #gmEditOverlay textarea { color:#d4d4d4; border:1px solid #444; font-size: 12pt; }
    #gmEditOverlay input:focus, #gmEditOverlay textarea:focus { outline:1px solid #555; }
    #gmEditOverlay .hint { color:#909090; font-size: 11pt; line-height: 1.5; }

    /* ---------- 主表 ---------- */
    #gmEditOverlay table.u-main-table { border-collapse: collapse; table-layout: fixed; width: max-content; }
    #gmEditOverlay table.u-main-table th {
      padding:0 2px; border:1px solid #444; background:#000000; color:#cfcfcf;
      height:22px; white-space:nowrap; position:sticky; top:0; z-index:10;
      overflow:hidden; text-overflow:ellipsis; font-size: 12pt; line-height: 22px;
    }
        #gmEditOverlay .divider-row td { border-left: 1px solid #444; }

        #gmEditOverlay table.u-main-table thead th:first-child {
      left: 0;
      z-index: 15;
      will-change: transform;
      transform: translateZ(0);
    }
       #gmEditOverlay table.u-main-table tbody td.u-cell:first-child {
      position: sticky;
      left: 0;
      z-index: 2;
      will-change: transform;
      transform: translateZ(0);
    }
        #gmEditOverlay .divider-row td { padding: 0; }
    #gmEditOverlay .divider-row .divider-inner {
      position: sticky;
      left: 0;
      z-index: 6;
      display: block;
      width: max-content;
      padding: 2px 8px;
      font-weight: bold;
      font-size: 12pt;
      line-height: 22px;
      white-space: nowrap;
      will-change: transform;
      transform: translateZ(0);
    }

    /* ---------- 单元格基础 ---------- */
    #gmEditOverlay .u-cell {
      padding:0 1px; border:1px solid #333; height:22px; max-height:22px;
      overflow:hidden; white-space:nowrap; vertical-align:middle; text-overflow:ellipsis;
      color:#d4d4d4; font-size: 12pt; line-height: 22px; position: relative;
    }
    #gmEditOverlay .u-cell input {
      width:100%; height:20px; line-height:20px; padding:0 1px; box-sizing:border-box;
      border:none; outline:none; background:transparent; color:#d4d4d4;
      text-overflow:ellipsis; font-size: 12pt; font-family: inherit;
    }
    #gmEditOverlay .u-cell input:focus { background:#2f2f2f; }
    #gmEditOverlay .u-cell.c-total, #gmEditOverlay .u-cell.c-air { text-align:center; font-weight:bold; }
    #gmEditOverlay .u-cell.c-downloaded { color: #9ac; }
    #gmEditOverlay .u-cell input.u-extd.extd-formula {
      font-weight: bold;
    }
    /* ---------- 名称 / 中文 / 更新列：强制左对齐 ---------- */
    #gmEditOverlay .u-cell input.u-name,
    #gmEditOverlay .u-cell input.u-cn,
    #gmEditOverlay .u-cell input.u-update {
      text-align: left !important;
      direction: ltr !important;
      unicode-bidi: plaintext !important;
      text-overflow: ellipsis;
      overflow: hidden;
      white-space: nowrap;
      padding-left: 2px;
      padding-right: 2px;
    }
    #gmEditOverlay .u-cell.editing-expand input.u-name,
    #gmEditOverlay .u-cell.editing-expand input.u-cn,
    #gmEditOverlay .u-cell.editing-expand input.u-update {
      text-align: left !important;
      direction: ltr !important;
      unicode-bidi: plaintext !important;
    }

    /* ---------- 高亮：结尾 / 警告 ---------- */
    /* 结尾（END）：紫色，对应 VBA highLightFontColor(1) = -104775 = #B966FE */
    #gmEditOverlay .hl-end { color: #B966FE !important; font-weight:bold; }

    /* 警告（放送≥24:00、无效开播、EP01）：琥珀色，对应 VBA highLightFontColor(0) = -16727809 = #FFC000 */
    #gmEditOverlay .hl-warn { color: #FFC000 !important; font-weight:bold; }

    /* 输入框 / td 上的 hl-warn（覆盖 CSS 里的 #8F8F8F 默认色） */
    #gmEditOverlay input.hl-warn,
    #gmEditOverlay td.hl-warn input {
      color: #FFC000 !important;
      font-weight: bold !important;
    }

    /* ---------- 链接 / 默认值 ---------- */
    #gmEditOverlay a { color: inherit !important; text-decoration: underline; }
    #gmEditOverlay .from-default { font-weight: bold; }

    /* ---------- 资源列（复合：显示层 + 编辑层） ---------- */
    #gmEditOverlay .u-res-display { cursor:default; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
    #gmEditOverlay .u-res-edit-btn { cursor:pointer; background:none; border:none; padding:0 2px; flex-shrink:0; color:#ccc; font-size: 12pt; line-height: 20px; }
    #gmEditOverlay .u-res-display-layer,
    #gmEditOverlay .u-res-edit-layer { display:flex; gap:2px; align-items:center; height:100%; width:100%; }
    #gmEditOverlay .u-cell.u-combined { position: relative; }
    #gmEditOverlay .u-cell.u-combined:focus { outline: 1px solid #4a9eff; outline-offset: -2px; }
    #gmEditOverlay .u-cell.u-combined.editing { overflow: visible; z-index: 20; }
    #gmEditOverlay .u-cell.u-combined.editing .u-res-edit-layer {
      position: absolute; left: 0; top: 0; min-width: 100%; z-index: 30;
      background: #1e1e1e; border: 1px solid #4a9eff; padding: 0 2px;
      border-radius: 3px; box-shadow: 0 2px 10px rgba(0,0,0,0.8);
      box-sizing: border-box; height: 22px;
      /* max-width 由 JS autoResizeEditLayer 动态设置 */
    }
    #gmEditOverlay .u-res-edit-layer input {
      height:20px; line-height:20px; padding:0 2px; box-sizing:border-box;
      border:1px solid #444; background:#252525; color:#d4d4d4; outline:none;
      font-size: 12pt; font-family: inherit;
    }
    #gmEditOverlay .u-res-edit-layer input.u-res { width:60px; flex-shrink:0; }
    #gmEditOverlay .u-res-edit-layer input.u-rule { flex:1; min-width:0; }

    /* ---------- 编辑态展开：input / textarea / contenteditable ---------- */
    #gmEditOverlay .u-cell.editing-expand {
      overflow: visible;
      z-index: 20;
    }
    #gmEditOverlay .u-cell.editing-expand input,
    #gmEditOverlay .u-cell.editing-expand select,
    #gmEditOverlay .u-cell.editing-expand .u-bgmid,
    #gmEditOverlay .u-cell.u-focus-expand .u-bgmid {
      position: absolute;
      right: 0;
      left: auto;
      top: 0;
      height: auto;
      min-height: 22px;
      max-height: 40vh;
      background: #1e1e1e;
      border: 1px solid #4a9eff;
      border-radius: 3px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.8);
      box-sizing: border-box;
      padding: 2px 4px;
      z-index: 30;
      color: #d4d4d4;
      font-size: 12pt;
      font-family: inherit;
      outline: none;
      overflow: auto;
      text-overflow: clip;
      white-space: pre-wrap;
      word-break: break-all;
    }
    #gmEditOverlay .u-cell.c-bgmid { overflow: visible; }
    #gmEditOverlay .u-cell.editing-expand textarea {
      position: absolute;
      left: 0;
      top: 0;
      width: auto;
      min-width: 80px;
      height: auto;
      min-height: 22px;
      line-height: 1.4;
      padding: 2px 4px;
      background: #1e1e1e;
      border: 1px solid #4a9eff;
      border-radius: 3px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.8);
      box-sizing: border-box;
      resize: none;
      overflow: hidden;
      white-space: pre;
      z-index: 30;
      color: #d4d4d4;
      font-size: 12pt;
      font-family: inherit;
      outline: none;
      /* 宽度/最大宽度由 JS autoResizeTextarea 动态设置 */
    }
    #gmEditOverlay .u-cell.editing-expand .u-bgmid {
      display: block;
      white-space: pre-wrap;
      word-break: break-all;
      overflow: auto;
      text-overflow: clip;
      height: auto;
      min-height: 22px;
      max-height: 40vh;
      /* 宽度/最大宽度由 JS autoResizeInput 动态设置 */
    }

    /* ---------- BGMID contenteditable ---------- */
    #gmEditOverlay .u-bgmid {
      min-height:20px; max-height:20px; overflow:hidden;
      padding:0 1px; line-height:20px; white-space:nowrap; outline:none;
      box-sizing:border-box; text-overflow:ellipsis; color:#d4d4d4; font-size: 12pt;
    }
    #gmEditOverlay .u-bgmid:focus { background:#2f2f2f; }

    /* ---------- 分隔行 ---------- */
    #gmEditOverlay .divider-row td { user-select:none; color:#cfcfcf; font-weight:bold; font-size: 12pt; }

    /* ---------- 行选中轮廓 ---------- */
    #gmEditOverlay tr.row-selected .u-cell:first-child { box-shadow: inset 2px 0 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-top .u-cell:first-child { box-shadow: inset 2px 0 0 0 #4a9eff, inset 0 2px 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-bottom .u-cell:first-child { box-shadow: inset 2px 0 0 0 #4a9eff, inset 0 -2px 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-top.sel-bottom .u-cell:first-child { box-shadow: inset 2px 0 0 0 #4a9eff, inset 0 2px 0 0 #4a9eff, inset 0 -2px 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected .u-cell:last-child { box-shadow: inset -2px 0 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-top .u-cell:last-child { box-shadow: inset -2px 0 0 0 #4a9eff, inset 0 2px 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-bottom .u-cell:last-child { box-shadow: inset -2px 0 0 0 #4a9eff, inset 0 -2px 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-top.sel-bottom .u-cell:last-child { box-shadow: inset -2px 0 0 0 #4a9eff, inset 0 2px 0 0 #4a9eff, inset 0 -2px 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-top .u-cell:not(:first-child):not(:last-child) { box-shadow: inset 0 2px 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-bottom .u-cell:not(:first-child):not(:last-child) { box-shadow: inset 0 -2px 0 0 #4a9eff; }
    #gmEditOverlay tr.row-selected.sel-top.sel-bottom .u-cell:not(:first-child):not(:last-child) { box-shadow: inset 0 2px 0 0 #4a9eff, inset 0 -2px 0 0 #4a9eff; }
    /* ---------- 展示列聚焦样式 ---------- */
    #gmEditOverlay .u-cell.c-disp:focus,
    #gmEditOverlay .u-cell.c-total:focus,
    #gmEditOverlay .u-cell.c-air:focus {
      outline: 1px solid #4a9eff;
      outline-offset: -2px;
    }

    /* ---------- 列宽 ---------- */
    #gmEditOverlay .u-main-table th:nth-child(1), #gmEditOverlay .u-main-table td:nth-child(1) { width: 230px !important; min-width: 230px !important; max-width: 230px !important; }
    #gmEditOverlay .u-main-table th:nth-child(2), #gmEditOverlay .u-main-table td:nth-child(2) { width: 73px !important; max-width: 73px !important; }
    #gmEditOverlay .u-main-table th:nth-child(5), #gmEditOverlay .u-main-table td:nth-child(5) { width: 135px !important; max-width: 135px !important; }
    #gmEditOverlay .u-main-table th:nth-child(8), #gmEditOverlay .u-main-table td:nth-child(8) { width: 90px !important; max-width: 90px !important; }
    #gmEditOverlay .u-main-table th:nth-child(9), #gmEditOverlay .u-main-table td:nth-child(9) { width: 64px !important; max-width: 64px !important; }
    #gmEditOverlay .u-main-table th:nth-child(12), #gmEditOverlay .u-main-table td:nth-child(12),
    #gmEditOverlay .u-main-table th:nth-child(13), #gmEditOverlay .u-main-table td:nth-child(13) { min-width: 46px !important; }

    /* ---------- 记录列 textarea ---------- */
    #gmEditOverlay .u-cell textarea.u-downloaded {
      width: 100%;
      height: 20px;
      line-height: 20px;
      padding: 0 1px;
      box-sizing: border-box;
      border: none;
      outline: none;
      background: transparent !important;
      color: #8F8F8F;
      font-size: 12pt;
      font-family: inherit;
      text-align: left;
      resize: none;
      overflow: hidden;
      white-space: pre;
      display: block;
    }
    #gmEditOverlay .u-cell textarea.u-downloaded:focus {
      background: #2f2f2f !important;
      text-align: left;
    }
    #gmEditOverlay .u-cell.c-downloaded { overflow: visible; }
    #gmEditOverlay .u-cell.c-downloaded.editing-expand textarea.u-downloaded,
    #gmEditOverlay .u-cell.c-downloaded.u-focus-expand textarea.u-downloaded {
      position: absolute;
      left: 0;
      top: 0;
      width: auto;
      min-width: 80px;
      height: auto;
      min-height: 22px;
      line-height: 1.4;
      padding: 2px 4px;
      background: #1e1e1e !important;
      border: 1px solid #4a9eff;
      border-radius: 3px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.8);
      resize: none;
      overflow: hidden;
      white-space: pre;
      z-index: 30;
      text-align: left;
      /* 宽度/最大宽度由 JS autoResizeTextarea 动态设置 */
    }
    /* ---------- 临时编辑过的格子：深蓝背景 ---------- */
    #gmEditOverlay .u-cell.cell-temp-edited { background: #1a2f5a !important; }
    #gmEditOverlay .u-cell.cell-temp-edited textarea.u-downloaded { background: transparent !important; }

    /* ---------- last 表 ---------- */
    #gmEditOverlay #lastTableHost { background:#242424; border:1px solid #3a3a3a; border-radius:4px; padding:6px 8px; }
    #gmEditOverlay #lastTableHost table { border-collapse:collapse; width:100%; }
    #gmEditOverlay #lastTableHost th { background:#2a2a2a; color:#cfcfcf; border:1px solid #444; padding:2px 6px; font-size:12pt; text-align:left; }
    #gmEditOverlay #lastTableHost td { border:1px solid #333; padding:2px; }
    #gmEditOverlay #lastTableHost input.last-temp-edited {
      background: #1a2f5a !important;
    }
    /* ---------- 延周表 ---------- */
    #gmEditOverlay #delayTableHost { background:#1a1a1a; border:1px solid #3a3a3a; }
    #gmEditOverlay #delayTableHost th { background:#2a2a2a !important; color:#cfcfcf !important; border:1px solid #444 !important; padding: 2px 4px; }
    #gmEditOverlay #delayTableHost td { background:#1f1f1f !important; border:1px solid #333 !important; padding: 2px 4px; }
    #gmEditOverlay #delayTableHost tr.delay-sub td { background:#232323 !important; }
    #gmEditOverlay #delayTableHost input { background:#252525; color:#d4d4d4; border:1px solid #444; }
    #gmEditOverlay #delayTableHost input.delay-name.no-match {
      color: #FFC000 !important;
      font-weight: bold !important;
      background: #2a2418 !important;
    }
    /* ---------- 滚动条 ---------- */
    #gmEditOverlay ::-webkit-scrollbar { width:12px; height:12px; }
    #gmEditOverlay ::-webkit-scrollbar-track { background:#1a1a1a; }
    #gmEditOverlay ::-webkit-scrollbar-thumb { background:#3a3a3a; border-radius:6px; }
    /* ---------- 并排模式：原页面收缩到左半，UI 占右半 ---------- */
    body.acgrip-split { overflow-x: hidden !important; }
    body.acgrip-split > header.navbar,
    body.acgrip-split > header.navbar > .container,
    body.acgrip-split > .container,
    body.acgrip-split > .footer {
      width: 50vw !important;
      max-width: 50vw !important;
      box-sizing: border-box;
    }
    body.acgrip-split > header.navbar > .container,
    body.acgrip-split > .container {
      margin-left: 0 !important;
      margin-right: auto !important;
      padding-left: 12px !important;
      padding-right: 12px !important;
    }
  `;
  dialog.appendChild(styleTag);

  const form = cE('form');
  form.id = 'gmEditForm';
  form.innerHTML = `
        <h2>编辑数据<span class="info-icon" title="资源/规则列：@ 表示当前下集（1、2、10、101），@@ 表示补零两位（01、02、10、101）。
延日列：支持算式与函数，@ 表示当前下集数字。如 @*2、@+7、@-5；
或 =SUM((@&gt;={8,10,12,14,16})*-1) 表示下集达到 8,10,12,14,16 时各提前 1 天，并累计。
开播列：输入 &lt;100 的数字视为月份，自动转换为该月 1 号（如 10 → 1001）。

快捷键：
  Esc：退出编辑（编辑中则取消编辑，多行选中则恢复单选，未打开时打开面板）
  Ctrl+S：保存
  F2：切换编辑/非编辑
  Ctrl+方向键：按内容跳格（跳过空格，连续非空格落到末尾）
  Alt+点击链接：选中该行而非打开链接
  Backspace / Delete（非编辑态）：清空该格
  Shift+方向键（非编辑态）：扩展行选择
">ⓘ</span>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      <button type="submit">保存</button>
      <button type="button" id="gmEditCancel">关闭</button>
      <button type="button" id="discardChangesBtn" style="color:#e88;">放弃更改</button>
      <button type="button" id="addUnifiedRow">+ 添加</button>
      <button type="button" id="importTableBtn">导入</button>
      <button type="button" id="openResourceBtn">资源</button>
      <button type="button" id="openBgmBtn">BGM</button>
      <button type="button" id="openBgmIdLinkBtn">链接</button>
      <button type="button" id="deleteSelectedBtn" style="color:#e88;">删除</button>
      <button type="button" id="resetBangumiUpdate" title="重置从Bangumi更新的计时">重置更新</button>
      <button type="button" id="resetInferredTimes" title="重置调度匹配计时">重置匹配</button>
      <button type="button" id="openAiredResourceBtn" title="打开所有播出时间已过、且有资源链接的条目">已播出</button>
    </div></h2>
    <div id="unifiedTableHost" style="margin-top:6px;max-height:calc(100vh - 160px);overflow:auto;border:1px solid #333;background:#1a1a1a;padding-right:4px;"></div>
    <div style="margin-top:10px;border:1px solid #3a3a3a;border-radius:4px;padding:6px 8px;background:#242424;">
      <div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed #3a3a3a;">
        <label><strong>延周计算</strong>：</label>
        <span class="hint" style="margin:2px 0 4px 0;">奇数行为需要延时的集数，偶数行为对应的周数（默认 1）。名称匹配表格"名称"列。</span>
        <div id="delayTableHost" style="overflow:auto;border:1px solid #3a3a3a;background:#1a1a1a;"></div>
        <button type="button" id="addDelayRow" style="margin-top:4px;">+ 添加延周行</button>
      </div>

      <div id="lastTableHost">
        <table>
          <thead><tr>
            <th style="width:33.33%;">last.viewed</th>
            <th style="width:33.33%;">last.id</th>
            <th style="width:33.34%;">last.match</th>
          </tr></thead>
          <tbody><tr>
            <td><input id="inpLastViewed" value="${storedLastViewed}" style="width:100%;box-sizing:border-box;"></td>
            <td><input id="inpLast" value="${storedLast}" style="width:100%;box-sizing:border-box;"></td>
            <td><input id="inpLastDownload" value="${storedLastDownload}" style="width:100%;box-sizing:border-box;"></td>
          </tr></tbody>
        </table>
      </div>
    </div>
  `;
  dialog.appendChild(form);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  // ---- last 三个输入框的临时修改跟踪 ----
  const inpLastViewed = dialog.querySelector('#inpLastViewed');
  const inpLast = dialog.querySelector('#inpLast');
  const inpLastDownload = dialog.querySelector('#inpLastDownload');
  const lastModified = { viewed: false, id: false, match: false };

  function refreshLastEditedMark() {
    if (inpLastViewed) inpLastViewed.classList.toggle('last-temp-edited', lastModified.viewed);
    if (inpLast) inpLast.classList.toggle('last-temp-edited', lastModified.id);
    if (inpLastDownload) inpLastDownload.classList.toggle('last-temp-edited', lastModified.match);
  }

  inpLastViewed.addEventListener('input', () => {
    const expected = lastViewed != null && !Number.isNaN(url2num(lastViewed)) ? String(url2num(lastViewed)) : '';
    lastModified.viewed = inpLastViewed.value !== expected;
    refreshLastEditedMark();
  });
  inpLast.addEventListener('input', () => {
    const expected = last != null && !Number.isNaN(url2num(last)) ? String(url2num(last)) : '';
    lastModified.id = inpLast.value !== expected;
    refreshLastEditedMark();
  });
  inpLastDownload.addEventListener('input', () => {
    const expected = lastDownload ?? '';
    lastModified.match = inpLastDownload.value !== expected;
    refreshLastEditedMark();
  });

  overlay._refreshLastInputs = () => {
    if (!lastModified.viewed) {
      inpLastViewed.value = (lastViewed != null && !Number.isNaN(url2num(lastViewed))) ? String(url2num(lastViewed)) : '';
    }
    if (!lastModified.id) {
      inpLast.value = (last != null && !Number.isNaN(url2num(last))) ? String(url2num(last)) : '';
    }
    if (!lastModified.match) {
      inpLastDownload.value = lastDownload ?? '';
    }
  };
  const host = dialog.querySelector('#unifiedTableHost');
  const tbody = cE('tbody');
  const delayHost = dialog.querySelector('#delayTableHost');
  const delayTbody = cE('tbody');
  // ---- 快照基准：以存储中的行为准，草稿里的行与之对比 ----
  const storedRowsForBaseline = (() => {
    const bd = getValue('bangumiData');
    return (bd && Array.isArray(bd.rows)) ? bd.rows : [];
  })();

  const storedIndex = (() => {
    const map = new Map();
    for (const r of storedRowsForBaseline) {
      const id = getBgmIdFromBGMID(String(r.BGMID ?? ''));
      if (id) map.set('id:' + id, r);
      const rule = String(r.规则 ?? '').trim();
      if (rule) map.set('rule:' + rule, r);
      const cn = String(r.中文 ?? '').trim();
      if (cn) map.set('cn:' + cn, r);
      const nm = String(r.名称 ?? '').trim();
      if (nm) map.set('nm:' + nm, r);
    }
    return map;
  })();

  const EMPTY_SNAPSHOT = {
    资源: '', 规则: '', 下集: '', 延周: '', 延日: '', BGMID: '',
    名称: '', 中文: '', 年: '', 开播: '', 放送: '', 最大: '',
    更新: '', 初始: '', 前季: '', 已下载: '[]',
  };

  /** 存储基准快照：按 BGMID → 规则 → 中文 → 名称 匹配；找不到返回空快照 */
  function storedRowSnapshot(row) {
    // 1) BGMID 的 id 最稳定，优先
    const id = getBgmIdFromBGMID(String(row.BGMID ?? ''));
    if (id && storedIndex.has('id:' + id)) return snapshotRowValues(storedIndex.get('id:' + id));
    // 2) 规则
    const rule = String(row.规则 ?? '').trim();
    if (rule && storedIndex.has('rule:' + rule)) return snapshotRowValues(storedIndex.get('rule:' + rule));
    // 3) 中文
    const cn = String(row.中文 ?? '').trim();
    if (cn && storedIndex.has('cn:' + cn)) return snapshotRowValues(storedIndex.get('cn:' + cn));
    // 4) 名称
    const nm = String(row.名称 ?? '').trim();
    if (nm && storedIndex.has('nm:' + nm)) return snapshotRowValues(storedIndex.get('nm:' + nm));
    return { ...EMPTY_SNAPSHOT };
  }
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  function measureTextWidth(text, font = '16px sans-serif') {
    measureCtx.font = font;
    return measureCtx.measureText(text || '').width;
  }
  function setBgmidMultiline(div, expand) {
    if (!div) return;
    if (expand) {
      if (div.dataset.multilineExpanded === '1') return;
      const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        node.nodeValue = node.nodeValue.replace(/,/g, ',\n');
      }
      div.dataset.multilineExpanded = '1';
    } else {
      if (div.dataset.multilineExpanded !== '1') return;
      const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        node.nodeValue = node.nodeValue.replace(/,?\n/g, ',');
      }
      delete div.dataset.multilineExpanded;
    }
  }
  let selAnchorTr = null;    // 唯一的锚点：Shift 系列的固定端
  let selDragging = false;
  let refreshTimer = null;
  let pendingEditMode = false;
  let _restoringSelection = false;
  let draftSaveTimer = null;
  let _suppressDraft = false;

  function scheduleDraftSave() {
    if (_suppressDraft) return;

    // 同步判断状态，立即刷新按钮（不先亮后灰）
    try {
      const rows = collectUnifiedRows();
      const delay = collectDelayData();
      const last = {
        id: dialog.querySelector('#inpLast').value,
        match: dialog.querySelector('#inpLastDownload').value,
        viewed: dialog.querySelector('#inpLastViewed').value,
      };
      setDiscardBtnEnabled(hasAnyChange(rows, delay, last));
    } catch (e) {
      console.error('scheduleDraftSave check error', e);
    }

    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null;
      flushDraftSave();
    }, 300);
  }
  function setDiscardBtnEnabled(enabled) {
    const btn = dialog.querySelector('#discardChangesBtn');
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '' : '0.5';
    btn.style.cursor = enabled ? '' : 'not-allowed';
  }

  function normalizeRow(r) {
    const out = {};
    for (const k of Object.keys(r).sort()) {
      if (k === '已下载') {
        out[k] = parseDownloadedToList(r[k]);
      } else {
        const v = String(r[k] ?? '').trim();
        if (v !== '') out[k] = v;
      }
    }
    return out;
  }

  /** 与"格子/ last 输入框标记 + delay 与存储比对"一致的变化判定 */
  function hasAnyChange(panelRows, panelDelay, panelLast) {
    try {
      // 1. 任何格子有 cell-temp-edited → 有变化
      for (const tr of tbody.children) {
        if (!tr._row) continue;
        for (const td of tr.children) {
          if (td.classList && td.classList.contains('cell-temp-edited')) return true;
        }
      }
      // 2. last 三个输入框有 last-temp-edited → 有变化
      for (const sel of ['#inpLast', '#inpLastDownload', '#inpLastViewed']) {
        const inp = dialog.querySelector(sel);
        if (inp && inp.classList && inp.classList.contains('last-temp-edited')) return true;
      }
      // 3. delay 与存储比对
      const bd = getValue('bangumiData') ?? {};
      const storedDelay = bd.delay || { rows: [] };
      const delayNorm = (d) => JSON.stringify({
        rows: (d.rows || []).map(r => ({
          名称: String(r.名称 || '').trim(),
          排除: String(r.排除 || '').trim(),
          episodes: (r.episodes || []).map(String),
          weeks: (r.weeks || []).map(String),
        })),
      });
      if (delayNorm(panelDelay) !== delayNorm(storedDelay)) return true;
      return false;
    } catch (e) {
      console.error('hasAnyChange error', e);
      return true;
    }
  }
  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
  }
  function flushDraftSave() {
    if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }
    try {
      // 先刷新格子标记（保证与 row 状态同步）
      for (const tr of tbody.children) {
        if (tr._row) refreshTempEditedMark(tr);
      }

      const rows = collectUnifiedRows();
      const delay = collectDelayData();
      const last = {
        id: dialog.querySelector('#inpLast').value,
        match: dialog.querySelector('#inpLastDownload').value,
        viewed: dialog.querySelector('#inpLastViewed').value,
      };

      // 与存储对比：无变化 → 清草稿 + 灰按钮
      if (!hasAnyChange(rows, delay, last)) {
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        setDiscardBtnEnabled(false);
        return;
      }

      localStorage.setItem(DRAFT_KEY, JSON.stringify({ rows, delay, last, ts: Date.now() }));
      setDiscardBtnEnabled(true);
    } catch (e) {
      console.error('draft save error', e);
    }
  }

  /* ---- 延周表 ---- */
  function computeDelayCols() {
    let n = 6;
    for (const dr of delayData.rows) n = Math.max(n, (dr.episodes || []).length + 1, (dr.weeks || []).length + 1);
    return n;
  }
  function onDelayInput() {
    updateDelayNameHighlight();
    scheduleRefresh();
    ensureDelayExtraColumn();
  }
  function ensureDelayExtraColumn() {
    const mainTrs = delayTbody.querySelectorAll('.delay-main');
    if (!mainTrs.length) return;
    let need = false;
    for (const mt of mainTrs) {
      const eps = mt.querySelectorAll('.delay-episode');
      const lastEp = eps[eps.length - 1];
      if (lastEp && lastEp.value.trim() !== '') { need = true; break; }
      const st = mt.nextElementSibling;
      const wks = st ? st.querySelectorAll('.delay-week') : [];
      const lastWk = wks[wks.length - 1];
      if (lastWk && lastWk.value.trim() !== '') { need = true; break; }
    }
    if (need) appendDelayColumn();
  }
  function makeDelayEpisodeInput(v) {
    const i = cE('input'); i.type = 'text'; i.inputMode = 'decimal'; i.autocomplete = 'off';
    i.className = 'delay-episode'; i.value = v ?? '';
    i.style.cssText = 'width:50px;box-sizing:border-box;text-align:center;font-size:12pt;';
    i.addEventListener('input', onDelayInput); return i;
  }
  function makeDelayWeekInput(v) {
    const i = cE('input'); i.type = 'text'; i.inputMode = 'decimal'; i.autocomplete = 'off';
    i.className = 'delay-week'; i.placeholder = '1';
    i.value = (v === '' || v == null) ? '' : v;
    i.style.cssText = 'width:50px;box-sizing:border-box;text-align:center;font-size:12pt;';
    i.addEventListener('input', onDelayInput); return i;
  }
  function appendDelayColumn() {
    for (const mt of delayTbody.querySelectorAll('.delay-main')) {
      const st = mt.nextElementSibling, tdDel = mt.lastElementChild;
      const tdEp = cE('td'); tdEp.style.cssText = 'padding:2px;border:1px solid #333;';
      tdEp.appendChild(makeDelayEpisodeInput('')); mt.insertBefore(tdEp, tdDel);
      if (st) {
        const tdWk = cE('td'); tdWk.style.cssText = 'padding:2px;border:1px solid #333;background:#232323;';
        tdWk.appendChild(makeDelayWeekInput('')); st.appendChild(tdWk);
      }
    }
    const thead = delayHost.querySelector('thead tr');
    if (thead) {
      const thDel = thead.lastElementChild;
      const idx = thead.querySelectorAll('th').length - 1;
      const thNew = cE('th'); thNew.textContent = '集数' + idx;
      thNew.style.cssText = 'padding:2px 4px;border:1px solid #444;background:#2a2a2a;color:#cfcfcf;min-width:56px;font-size:12pt;';
      thead.insertBefore(thNew, thDel);
    }
  }
  function addDelayPair(data = {}) {
    const cols = computeDelayCols();
    const mainTr = cE('tr'); mainTr.className = 'delay-main';
    const tdName = cE('td'); tdName.rowSpan = 2;
    tdName.style.cssText = 'padding:2px;border:1px solid #333;vertical-align:top;min-width:130px;';
    const nameInput = cE('input'); nameInput.type = 'text'; nameInput.autocomplete = 'off'; nameInput.className = 'delay-name';
    nameInput.value = data.名称 || ''; nameInput.style.cssText = 'width:100%;box-sizing:border-box;font-size:12pt;';
    nameInput.addEventListener('input', onDelayInput); tdName.appendChild(nameInput);
    const tdExc = cE('td'); tdExc.rowSpan = 2;
    tdExc.style.cssText = 'padding:2px;border:1px solid #333;vertical-align:top;min-width:60px;';
    const excInput = cE('input'); excInput.type = 'text'; excInput.autocomplete = 'off'; excInput.className = 'delay-exclude';
    excInput.value = data.排除 || ''; excInput.style.cssText = 'width:100%;box-sizing:border-box;font-size:12pt;';
    excInput.addEventListener('input', onDelayInput); tdExc.appendChild(excInput);
    const tdDel = cE('td'); tdDel.rowSpan = 2;
    tdDel.style.cssText = 'padding:2px;border:1px solid #333;text-align:center;vertical-align:middle;';
    const delBtn = cE('button'); delBtn.type = 'button'; delBtn.textContent = '✕';
    delBtn.style.cssText = 'cursor:pointer;color:#e55;background:none;border:none;font-size:12pt;';
    delBtn.addEventListener('click', () => { mainTr.remove(); if (subTr) subTr.remove(); scheduleRefresh(); });
    tdDel.appendChild(delBtn);
    mainTr.append(tdName, tdExc);
    const episodes = data.episodes || [], weeks = data.weeks || [];
    for (let i = 0; i < cols; i++) {
      const td = cE('td'); td.style.cssText = 'padding:2px;border:1px solid #333;';
      td.appendChild(makeDelayEpisodeInput(episodes[i])); mainTr.appendChild(td);
    }
    mainTr.appendChild(tdDel);
    const subTr = cE('tr'); subTr.className = 'delay-sub';
    for (let i = 0; i < cols; i++) {
      const td = cE('td'); td.style.cssText = 'padding:2px;border:1px solid #333;background:#232323;';
      td.appendChild(makeDelayWeekInput(weeks[i])); subTr.appendChild(td);
    }
    delayTbody.append(mainTr, subTr);
  }
  function renderDelayTable() {
    delayTbody.innerHTML = '';
    if (!delayData.rows.length) addDelayPair({});
    else for (const dr of delayData.rows) addDelayPair(dr);
  }
  function buildDelayTable() {
    delayHost.innerHTML = '';
    const table = cE('table'); table.style.cssText = 'border-collapse:collapse;font-size:12pt;';
    const thead = cE('thead'), trh = cE('tr');
    const thName = cE('th'); thName.textContent = '名称';
    thName.style.cssText = 'padding:2px 4px;border:1px solid #444;background:#2a2a2a;color:#cfcfcf;font-size:12pt;';
    trh.appendChild(thName);
    const thExc = cE('th'); thExc.textContent = '排除';
    thExc.style.cssText = 'padding:2px 4px;border:1px solid #444;background:#2a2a2a;color:#cfcfcf;font-size:12pt;';
    trh.appendChild(thExc);
    const cols = computeDelayCols();
    for (let i = 1; i <= cols; i++) {
      const th = cE('th'); th.textContent = '集数' + i;
      th.style.cssText = 'padding:2px 4px;border:1px solid #444;background:#2a2a2a;color:#cfcfcf;min-width:56px;font-size:12pt;';
      trh.appendChild(th);
    }
    const thDel = cE('th'); thDel.textContent = '×';
    thDel.style.cssText = 'padding:2px 4px;border:1px solid #444;background:#2a2a2a;color:#cfcfcf;width:36px;font-size:12pt;';
    trh.appendChild(thDel);
    thead.appendChild(trh); table.appendChild(thead); table.appendChild(delayTbody);
    delayHost.appendChild(table);
  }
  buildDelayTable(); renderDelayTable();
  dialog.querySelector('#addDelayRow').addEventListener('click', () => {
    delayData = collectDelayData();
    delayData.rows.push({ 名称: '', 排除: '', episodes: [], weeks: [] });
    buildDelayTable(); renderDelayTable(); scheduleRefresh();
  });
  dialog.querySelector('#resetBangumiUpdate').addEventListener('click', () => {
    setUpdated({ bangumi: 0 });
    showToast('已重置 Bangumi 抓取计时');
  });
  dialog.querySelector('#resetInferredTimes').addEventListener('click', () => {
    inferredTimesCache = {}; _inferredCacheLoaded = true; _inferScannedThisSession = false;
    saveInferredCache();
    inferenceStatus = { phase: 'idle', pending: 0, found: 0, page: 0, message: '已清空调度时间匹配', scanning: false };
    showToast('已清空调度时间匹配');
  });
  function collectDelayData() {
    const rows = [];
    for (const mainTr of delayTbody.querySelectorAll('.delay-main')) {
      const name = mainTr.querySelector('.delay-name').value.trim();
      if (!name) continue;
      const exclude = mainTr.querySelector('.delay-exclude').value.trim();
      const epInputs = mainTr.querySelectorAll('.delay-episode');
      const subTr = mainTr.nextElementSibling;
      const wkInputs = subTr ? subTr.querySelectorAll('.delay-week') : [];
      const episodes = [...epInputs].map(i => i.value.trim());
      const weeks = [...wkInputs].map(i => i.value.trim());
      while (episodes.length && episodes[episodes.length - 1] === '') episodes.pop();
      while (weeks.length && weeks[weeks.length - 1] === '') weeks.pop();
      rows.push({ 名称: name, 排除: exclude, episodes, weeks });
    }
    return { rows };
  }
  /** 高亮延周表中名称在主表格里找不到对应「最终显示名」的条目 */
  function updateDelayNameHighlight() {
    const validNames = new Set();
    for (const tr of tbody.children) {
      if (!tr._row) continue;
      const parsed = parseBGMID(tr._row.BGMID);
      const cn = String(effective(tr._row, '中文', parsed) || '').trim();
      const nm = String(effective(tr._row, '名称', parsed) || '').trim();
      if (cn) validNames.add(cn);
      if (nm) validNames.add(nm);
    }
    for (const mainTr of delayTbody.querySelectorAll('.delay-main')) {
      const nameInput = mainTr.querySelector('.delay-name');
      if (!nameInput) continue;
      const name = nameInput.value.trim();
      if (!name) { nameInput.classList.remove('no-match'); continue; }
      if (validNames.has(name)) nameInput.classList.remove('no-match');
      else nameInput.classList.add('no-match');
    }
  }

  function getDisplayName(row, parsed) {
    return String(effective(row, '中文', parsed) || effective(row, '名称', parsed) || '').trim();
  }
  function lookupDelay(row, parsed) {
    const keys = [String(effective(row, '中文', parsed) || '').trim(), String(effective(row, '名称', parsed) || '').trim()].filter(Boolean);
    if (!keys.length) return { total: 0, matched: false };
    const currentEP = Number(row.下集) || 0;
    let total = 0, matched = false;
    for (const mainTr of delayTbody.querySelectorAll('.delay-main')) {
      const name = mainTr.querySelector('.delay-name')?.value.trim();
      const exclude = mainTr.querySelector('.delay-exclude')?.value.trim() || '';
      if (!name || !keys.includes(name) || exclude) continue;
      matched = true;
      const epInputs = mainTr.querySelectorAll('.delay-episode');
      const subTr = mainTr.nextElementSibling;
      const wkInputs = subTr ? subTr.querySelectorAll('.delay-week') : [];
      for (let i = 0; i < epInputs.length; i++) {
        const ep = Number(epInputs[i].value);
        if (!Number.isFinite(ep) || ep <= 0) continue;
        if (currentEP >= ep) {
          const wkRaw = wkInputs[i] ? wkInputs[i].value.trim() : '';
          const wk = wkRaw === '' ? 1 : Number(wkRaw);
          if (Number.isFinite(wk)) total += wk;
        }
      }
    }
    return { total, matched };
  }
  function isEmptyRow(tr) {
    const row = tr._row;
    if (!row) return true;
    return rowIsEmpty(row);
  }
  function ensureTrailingEmpty() {
    const last = tbody.lastElementChild;
    if (!last || !last._row || !isEmptyRow(last)) buildRow({});
  }

  /* ---- 选中与轮廓 ---- */
  function clearRowSelection() {
    for (const tr of tbody.children) if (tr._row) tr.classList.remove('row-selected');
    updateSelectionBorders();
  }
  function getSelectedRows() { return [...tbody.children].filter(tr => tr._row && tr.classList.contains('row-selected')); }
  function updateSelectionBorders() {
    const mainRows = getMainTrs();
    for (let i = 0; i < mainRows.length; i++) {
      const tr = mainRows[i];
      if (!tr.classList.contains('row-selected')) { tr.classList.remove('sel-top', 'sel-bottom'); continue; }
      const prevSel = i > 0 && mainRows[i - 1].classList.contains('row-selected');
      const nextSel = i < mainRows.length - 1 && mainRows[i + 1].classList.contains('row-selected');
      tr.classList.toggle('sel-top', !prevSel);
      tr.classList.toggle('sel-bottom', !nextSel);
    }
    for (const tr of mainRows) {
      const isSel = tr.classList.contains('row-selected');
      if (tr._lastSelectedState !== isSel) {
        tr._lastSelectedState = isSel;
        try { applyRowBackground(tr); } catch {}
      }
    }
    if (!_restoringSelection) {
      try { saveLastCellState(); } catch {}
    }
  }
  /* ===== 选择逻辑统一抽象 ===== */

  function getMainTrs() {
    return [...tbody.children].filter(tr => tr._row);
  }

  function indexOfTr(tr) {
    return getMainTrs().indexOf(tr);
  }

  /** 当前焦点行（无则回退到 anchor） */
  function getFocusTr() {
    const ae = document.activeElement;
    const tr = ae?.closest?.('tr');
    if (tr && tr._row) return tr;
    if (selAnchorTr && selAnchorTr.isConnected) return selAnchorTr;
    return null;
  }

  /** 单行选中（无修饰键点击） */
  function selectSingle(tr) {
    for (const t of tbody.children) if (t._row) t.classList.remove('row-selected');
    tr.classList.add('row-selected');
    updateSelectionBorders();
  }

  /** 切换单行（Ctrl+点击） */
  function toggleSelect(tr) {
    tr.classList.toggle('row-selected');
    updateSelectionBorders();
  }

  /** 区间选中：把 [baseTr, curTr] 区间内所有主行选中，其余取消 */
  function setRangeSelection(baseTr, curTr) {
    const trs = getMainTrs();
    const a = trs.indexOf(baseTr);
    const b = trs.indexOf(curTr);
    if (a < 0 || b < 0) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = 0; i < trs.length; i++) {
      trs[i].classList.toggle('row-selected', i >= lo && i <= hi);
    }
    updateSelectionBorders();
  }
  function toggleRowSelect(tr, add) {
    if (add) tr.classList.toggle('row-selected'); else tr.classList.add('row-selected');
    updateSelectionBorders();
  }
  function selectRange(from, to) {
    clearRowSelection();
    const list = [...tbody.children].filter(tr => tr._row);
    const i1 = list.indexOf(from), i2 = list.indexOf(to);
    if (i1 < 0 || i2 < 0) return;
    const [a, b] = i1 <= i2 ? [i1, i2] : [i2, i1];
    for (let i = a; i <= b; i++) list[i].classList.add('row-selected');
    updateSelectionBorders();
  }

  /* ---- 单元格模块 ---- */
  function setReadOnly(el, ro) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.readOnly = ro;
    else el.contentEditable = ro ? 'false' : 'true';
  }
  function getRowCells(tr) {
    const out = [];
    for (const td of tr.children) {
      if (td.colSpan > 1) continue;
      const c = td._acgripCell;
      if (!c) continue;
      const list = c._list ?? [c];
      for (const item of list) out.push(item);
    }
    return out;
  }
  function getCellList(trs) {
    const out = [];
    for (const tr of trs) for (const c of getRowCells(tr)) out.push(c);
    return out;
  }
  /** 保存当前选中的单元格 / 多行状态 */
  function saveLastCellState() {
    const rows = getSelectedRows();
    if (!rows.length) return;

    const rowNames = [];
    for (const tr of rows) {
      const row = tr._row;
      if (!row) continue;
      const parsed = parseBGMID(row.BGMID);
      const name = getDisplayName(row, parsed) || '';
      if (name) rowNames.push(name);
    }
    if (!rowNames.length) return;

    // 焦点所在单元格的列索引（按 td 在 tr 中的位置）
    const ae = document.activeElement;
    const cell = ae?._acgripCell ?? ae?.closest('td')?._acgripCell;
    let colIndex = 0;
    if (cell && cell.tr) {
      const idx = [...cell.tr.children].indexOf(cell.td);
      if (idx >= 0) colIndex = idx;
    }

    try {
      localStorage.setItem('acgrip_last_cell', JSON.stringify({ rowNames, colIndex }));
    } catch {}
  }
  /** 恢复上次选中的单元格 / 多行；兼容旧格式 {rowName,colIndex} */
  function restoreLastCellState() {
    let saved = null;
    try {
      const s = localStorage.getItem('acgrip_last_cell');
      if (s) saved = JSON.parse(s);
    } catch {}

    // 兼容旧格式
    if (saved && !Array.isArray(saved.rowNames)) {
      saved.rowNames = saved.rowName ? [saved.rowName] : [];
    }
    const wantedNames = (saved && Array.isArray(saved.rowNames)) ? saved.rowNames : [];
    const colIndex = (saved && typeof saved.colIndex === 'number') ? saved.colIndex : 0;

    // 显示名 → tr
    const nameToTr = new Map();
    for (const tr of tbody.children) {
      if (!tr._row) continue;
      const parsed = parseBGMID(tr._row.BGMID);
      const name = getDisplayName(tr._row, parsed) || '';
      if (name && !nameToTr.has(name)) nameToTr.set(name, tr);
    }

    const selectedTrs = [];
    for (const name of wantedNames) {
      const tr = nameToTr.get(name);
      if (tr && !selectedTrs.includes(tr)) selectedTrs.push(tr);
    }

    if (!selectedTrs.length) {
      const first = [...tbody.children].find(tr => tr._row);
      if (!first) return;
      selectedTrs.push(first);
    }

    // 按 DOM 顺序排列
    const allTrs = [...tbody.children].filter(tr => tr._row);
    selectedTrs.sort((a, b) => allTrs.indexOf(a) - allTrs.indexOf(b));

    _restoringSelection = true;
    clearRowSelection();
    for (const tr of selectedTrs) tr.classList.add('row-selected');
    selAnchorTr = selectedTrs[0];
    updateSelectionBorders();
    _restoringSelection = false;

    // 聚焦第一行的对应列
    const focusTr = selectedTrs[0];
    let td = null;
    if (colIndex >= 0 && colIndex < focusTr.children.length) td = focusTr.children[colIndex];
    if (!td) td = focusTr.children[0];
    const cell = td?._acgripCell;
    if (!cell) return;

    setTimeout(() => {
      try { cell.host.focus({ preventScroll: true }); } catch {}
      try { td.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
    }, 0);
  }
  function isCellEmpty(cell) {
    if (!cell) return true;
    if (cell.isCombined) {
      const resVal = String(cell.editor?.value ?? '').trim();
      const ruleVal = String(cell._ruleCell?.editor?.value ?? '').trim();
      return !resVal && !ruleVal;
    }
    const editor = cell.editor;
    if (!editor) return true;
    if (editor.tagName === 'INPUT' || editor.tagName === 'TEXTAREA') return !String(editor.value ?? '').trim();
    return !String(editor.textContent ?? '').trim();
  }

  /**
   * Ctrl+方向键跳格：
   * - 下一格为空（或当前为空）→ 跳过多空，落到方向第一个非空；找不到则到方向尽头
   * - 当前非空且下一格非空 → 连续非空块末尾
   */
  function ctrlArrowTarget(cell, key) {
    const allTrs = [...tbody.children].filter(t => t._row);
    const rowIdx = allTrs.indexOf(cell.tr);
    const rowCells = getRowCells(cell.tr);
    const colIdx = rowCells.indexOf(cell);
    if (colIdx < 0) return null;

    const currentEmpty = isCellEmpty(cell);

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const dir = key === 'ArrowLeft' ? -1 : 1;
      const nextIdx = colIdx + dir;
      if (nextIdx < 0 || nextIdx >= rowCells.length) return null;
      const nextCell = rowCells[nextIdx];
      const nextEmpty = isCellEmpty(nextCell);

      if (nextEmpty || currentEmpty) {
        let i = nextIdx;
        while (i >= 0 && i < rowCells.length && isCellEmpty(rowCells[i])) i += dir;
        if (i >= 0 && i < rowCells.length) return rowCells[i];
        return rowCells[dir > 0 ? rowCells.length - 1 : 0];
      }
      let last = nextIdx;
      let i = nextIdx + dir;
      while (i >= 0 && i < rowCells.length && !isCellEmpty(rowCells[i])) {
        last = i;
        i += dir;
      }
      return rowCells[last];
    }

    // 垂直
    const dir = key === 'ArrowUp' ? -1 : 1;
    const nextRowIdx = rowIdx + dir;
    if (nextRowIdx < 0 || nextRowIdx >= allTrs.length) return null;

    const getVerticalCell = (tr) => {
      const rc = getRowCells(tr);
      return rc[Math.min(colIdx, rc.length - 1)];
    };

    const nextCell = getVerticalCell(allTrs[nextRowIdx]);
    const nextEmpty = isCellEmpty(nextCell);

    if (nextEmpty || currentEmpty) {
      let i = nextRowIdx;
      while (i >= 0 && i < allTrs.length && isCellEmpty(getVerticalCell(allTrs[i]))) i += dir;
      if (i >= 0 && i < allTrs.length) return getVerticalCell(allTrs[i]);
      const edgeRow = allTrs[dir > 0 ? allTrs.length - 1 : 0];
      return getVerticalCell(edgeRow);
    }
    let last = nextCell;
    let i = nextRowIdx + dir;
    while (i >= 0 && i < allTrs.length) {
      const cc = getVerticalCell(allTrs[i]);
      if (isCellEmpty(cc)) break;
      last = cc;
      i += dir;
    }
    return last;
  }
  function makeDisplayCell(td, tr) {
    if (td.tabIndex < 0) td.tabIndex = 0;
    const cell = {
      td, host: td, editor: td, isCombined: false, isDisplayOnly: true, tr,
      _list: [null], _editing: false, _original: null, _applyStyle: null,
      _enterEdit() {},
      _exitEdit() {},
    };
    cell._list = [cell];
    td._acgripCell = cell;
    return cell;
  }
  function makeCell(td, input, tr) {
    setReadOnly(input, true);
    const cell = {
      td, host: input, editor: input, isCombined: false, tr,
      _list: null, _editing: false, _original: null, _applyStyle: null,
      _enterEdit(clearFirst) {
        if (this._editing) return;
        const isInput = (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA');
        this._original = isInput ? (input.value ?? '') : (input.innerHTML ?? '');
        this._editing = true;
        setReadOnly(input, false);
        // 延日列：进入编辑态显式换为公式原文
        if (input.classList && input.classList.contains('u-extd')) {
          if (input.dataset.exprRaw != null) {
            input.value = input.dataset.exprRaw;
            delete input.dataset.exprRaw;
          } else {
            input.value = String(tr._row?.延日 ?? '');
          }
          // 编辑态保持公式加粗样式（若本身是公式）
          const s = String(input.value || '').trim();
          const isFormula = s !== '' && !/^-?\d+(\.\d+)?$/.test(s);
          input.classList.toggle('extd-formula', isFormula);
        }
        if (input.classList && (input.classList.contains('u-name') || input.classList.contains('u-cn') || input.classList.contains('u-update'))) {
          input.style.setProperty('text-align', 'left', 'important');
          input.style.setProperty('direction', 'ltr', 'important');
        }

        // contenteditable 光标设置工具
        const applyCursor = () => {
          if (!input.isContentEditable) return;
          try {
            const range = document.createRange();
            range.selectNodeContents(input);
            range.collapse(clearFirst ? true : false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          } catch {}
        };

        if (document.activeElement === input) {
          if (this._applyStyle) this._applyStyle();
          if (input.isContentEditable) {
            requestAnimationFrame(() => { if (this._editing) applyCursor(); });
          }
        } else {
          try { input.focus({ preventScroll: true }); } catch {}
          if (input.isContentEditable) {
            // contenteditable 从 false → true 后需要等一次布局再设置光标
            requestAnimationFrame(() => {
              if (!this._editing) return;
              if (document.activeElement !== input) {
                try { input.focus({ preventScroll: true }); } catch {}
              }
              applyCursor();
            });
          }
        }

        if (clearFirst) {
          if (isInput) input.value = '';
          else input.innerHTML = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          if (input.setSelectionRange) { try { input.setSelectionRange(0, 0); } catch {} }
          if (input.isContentEditable) {
            requestAnimationFrame(() => { if (this._editing) applyCursor(); });
          }
        }
      },
      _exitEdit(commit) {
        if (!this._editing) return;
        const orig = this._original;
        this._editing = false;
        this._original = null;
        if (td.tabIndex < 0) td.tabIndex = 0;
        if (!commit && orig != null) {
          if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') input.value = orig;
          else input.innerHTML = orig;
        }
        setReadOnly(input, true);
        td.classList.remove('editing-expand');
        input.style.width = '';
        input.style.maxWidth = '';

        const isBgmid = input.classList && input.classList.contains('u-bgmid');
        const stillFocused = document.activeElement === input || td.contains(document.activeElement);

        if (isBgmid) {
          if (stillFocused) {
            // 退出编辑但仍聚焦：保持多行显示，仅切换 class 与恢复只读
            td.classList.add('u-focus-expand');
            setBgmidMultiline(input, true);
            requestAnimationFrame(() => autoResizeInput(input));
          } else {
            td.classList.remove('u-focus-expand');
            setBgmidMultiline(input, false);
            input.style.width = '';
            input.style.maxWidth = '';
          }
        } else {
          td.classList.remove('u-focus-expand');
        }

        if (commit) {
          updateDerived(tr);
          scheduleDraftSave();
          setTimeout(() => {
            if (document.activeElement !== input) updateDerived(tr);
          }, 0);
        }
      },
    };
    cell._list = [cell];
    td._acgripCell = cell;
    input._acgripCell = cell;
    return cell;
  }
  function initCell(cell) {
    const { host, editor, td } = cell;
    const isDisplayOnly = !!cell.isDisplayOnly;

    const applyStyle = () => {
      if (cell.isCombined || isDisplayOnly) return;
      const isRecord = editor.classList && editor.classList.contains('u-downloaded');
      const isBgmid = editor.classList && editor.classList.contains('u-bgmid');
      if (isRecord) {
        if (cell._editing) td.classList.add('editing-expand');
        else td.classList.add('u-focus-expand');
        requestAnimationFrame(() => autoResizeTextarea(editor));
        return;
      }
      if (isBgmid) {
        td.classList.add('editing-expand');
        setBgmidMultiline(editor, true);
        requestAnimationFrame(() => autoResizeInput(editor));
        return;
      }
      td.classList.add('editing-expand');
      requestAnimationFrame(() => autoResizeInput(editor));
    };
    cell._applyStyle = applyStyle;

    const keydown = (e) => onCellKeydown(e, cell);
    if (!cell.skipHostKeydown) host.addEventListener('keydown', keydown);
    if (editor !== host) editor.addEventListener('keydown', keydown);

    if (!isDisplayOnly) {
      const compositionStart = () => { if (!cell._editing) cell._enterEdit(true); };
      if (!cell.skipHostKeydown) host.addEventListener('compositionstart', compositionStart);
      if (editor !== host) editor.addEventListener('compositionstart', compositionStart);

      const paste = (e) => {
        if (cell._editing) return;
        e.preventDefault();
        if (cell.isCombined) {
          cell._enterEdit(false);
          editor.value = e.clipboardData.getData('text/plain');
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          scheduleDraftSave();
        } else {
          if (editor.tagName === 'INPUT' || editor.tagName === 'TEXTAREA') editor.value = e.clipboardData.getData('text/plain');
          else {
            const html = e.clipboardData.getData('text/html');
            const text = e.clipboardData.getData('text/plain');
            editor.innerHTML = html ? cleanPastedHtml(html) : escapeHtml(text || '');
          }
          cell._editing = true;
          cell._original = '';
          setReadOnly(editor, false);
          td.classList.add('editing-expand');
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          scheduleDraftSave();
        }
      };
      if (!cell.skipHostKeydown) host.addEventListener('paste', paste);
      if (editor !== host) editor.addEventListener('paste', paste);
    }
    // 编辑态下内容变化时自动调整宽度
    const onInputResize = () => {
      if (!cell._editing) return;
      if (cell._applyStyle) cell._applyStyle();
      scheduleDraftSave();
    };
    if (!cell.skipHostKeydown) host.addEventListener('input', onInputResize);
    if (editor !== host) editor.addEventListener('input', onInputResize);
    const onFocus = () => {
      const tr = cell.tr;
      // 选中状态由 mousedown / 键盘导航逻辑管理，onFocus 不再重置
      updateSelectionBorders();

      if (editor.classList && (editor.classList.contains('u-name') || editor.classList.contains('u-cn') || editor.classList.contains('u-update'))) {
        editor.style.setProperty('text-align', 'left', 'important');
        editor.style.setProperty('direction', 'ltr', 'important');
        editor.style.setProperty('unicode-bidi', 'plaintext', 'important');
      }

      if (!cell._editing && (editor.tagName === 'INPUT' || editor.tagName === 'TEXTAREA')) {
        try { editor.setSelectionRange(0, 0); } catch {}
        try { editor.scrollLeft = 0; } catch {}
        requestAnimationFrame(() => {
          if (cell._editing) return;
          if (document.activeElement !== editor) return;
          try { editor.setSelectionRange(0, 0); } catch {}
          try { editor.scrollLeft = 0; } catch {}
          if (editor.classList && (editor.classList.contains('u-name') || editor.classList.contains('u-cn') || editor.classList.contains('u-update'))) {
            editor.style.setProperty('text-align', 'left', 'important');
          }
        });
      }

      const isRecord = editor.classList && editor.classList.contains('u-downloaded');
      const isBgmid = editor.classList && editor.classList.contains('u-bgmid');
      if (cell._editing) {
        applyStyle();
      } else if (isRecord) {
        td.classList.add('u-focus-expand');
        requestAnimationFrame(() => autoResizeTextarea(editor));
      } else if (isBgmid) {
        // 非编辑聚焦态：多行展开
        td.classList.add('u-focus-expand');
        setBgmidMultiline(editor, true);
        requestAnimationFrame(() => autoResizeInput(editor));
      }
    };
    if (!cell.skipHostKeydown) host.addEventListener('focus', onFocus);
    if (editor !== host) editor.addEventListener('focus', onFocus);

    if (!isDisplayOnly) {
      const onBlur = () => {
        setTimeout(() => {
          if (cell._editing) {
            if (cell.td.contains(document.activeElement)) return;
            cell._exitEdit(true);
            return;
          }
          // 非编辑态：处理 BGMID 聚焦态退出
          const isBgmid = editor.classList && editor.classList.contains('u-bgmid');
          if (isBgmid && !cell.td.contains(document.activeElement)) {
            cell.td.classList.remove('u-focus-expand');
            setBgmidMultiline(editor, false);
            editor.style.width = '';
            editor.style.maxWidth = '';
          }
        }, 0);
      };
      if (editor !== host) editor.addEventListener('blur', onBlur);
      else if (!cell.skipHostKeydown) host.addEventListener('blur', onBlur);
    }

    const linkClickCapture = (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      if (e.altKey) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        // 1) 若在编辑态：先退出（提交）
        if (cell._editing) cell._exitEdit(true);
        // 2) 单选当前行
        clearRowSelection();
        cell.tr.classList.add('row-selected');
        selAnchorTr = cell.tr;
        updateSelectionBorders();
        // 3) 聚焦点击的格子自身（非编辑态）
        const target = cell.host;
        if (target && typeof target.focus === 'function') {
          if (target.tabIndex < 0) target.tabIndex = 0;
          try { target.focus({ preventScroll: true }); } catch {}
        }
        updateSelectionBorders();
      }
    };
    host.addEventListener('click', linkClickCapture, true);
    if (editor !== host) editor.addEventListener('click', linkClickCapture, true);

    const ctxCopy = (e) => {
      const el = e.target.closest('input, textarea, .u-bgmid, [contenteditable]');
      if (!el) return;
      let text = '', isDefault = false;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.value !== '') text = el.value;
        else if (el.placeholder) { text = el.placeholder; isDefault = true; }
      } else if (el.isContentEditable || el.classList.contains('u-bgmid')) {
        const content = (el.textContent || '').trim();
        if (content !== '') text = content;
        else if (el.placeholder) { text = el.placeholder; isDefault = true; }
      }
      if (!text) return;
      e.preventDefault();
      navigator.clipboard.writeText(text)
      .then(() => showToast((isDefault ? '已复制默认值: ' : '已复制: ') + text))
      .catch(() => showToast('复制失败'));
    };
    host.addEventListener('contextmenu', ctxCopy);
    if (editor !== host) editor.addEventListener('contextmenu', ctxCopy);
  }
  /** 非编辑态清空单元格内容 */
  function clearCellContent(cell) {
    const tr = cell.tr;
    const row = tr._row;
    if (!row) return;

    // 资源列（复合格）：清空 资源 + 规则
    if (cell.isCombined) {
      row.资源 = '';
      row.规则 = '';
      if (cell.editor) cell.editor.value = '';
      if (cell._ruleCell && cell._ruleCell.editor) cell._ruleCell.editor.value = '';
      // updateDerived 末尾已包含 refreshTempEditedMark + applyRowBackground
      updateDerived(tr);
      scheduleDraftSave();
      return;
    }

    const editor = cell.editor;
    if (!editor) return;

    // 记录列 textarea
    if (editor.classList && editor.classList.contains('u-downloaded')) {
      row.已下载 = [];
      editor.value = '';
      editor.style.height = '20px';
      adjustAdaptiveColumns();
      refreshTempEditedMark(tr);
      applyRowBackground(tr);
      scheduleDraftSave();
      return;
    }

    // BGMID（含非编辑态，contenteditable="false" 也走此分支）
    const isBgmid = editor.classList && editor.classList.contains('u-bgmid');
    if (isBgmid) {
      editor.innerHTML = '';
      row.BGMID = '';
      refreshTempEditedMark(tr);
      applyRowBackground(tr);
      scheduleDraftSave();
      return;
    }

    // 普通 input / textarea
    if (editor.tagName === 'INPUT' || editor.tagName === 'TEXTAREA') {
      editor.value = '';
    } else {
      return;
    }

    // 派发 input 事件，让各列的 handler 更新 row 对应字段
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    refreshTempEditedMark(tr);
    applyRowBackground(tr);
    scheduleDraftSave();
  }

  function onCellKeydown(e, cell) {
    const key = e.key;
    const editing = cell._editing;
    const tr = cell.tr;
    const isDisplayOnly = !!cell.isDisplayOnly;
    // Ctrl+Shift+方向键：按内容跳格到目标行，区间选中（anchor → 目标）
    if (e.ctrlKey && e.shiftKey && !e.altKey && !editing && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key)) {
      e.preventDefault(); e.stopPropagation();
      const target = ctrlArrowTarget(cell, key);
      if (target && target.tr) {
        const base = (selAnchorTr && selAnchorTr.isConnected) ? selAnchorTr : cell.tr;
        if (!selAnchorTr || !selAnchorTr.isConnected) selAnchorTr = base;
        setRangeSelection(base, target.tr);
        pendingEditMode = false;
        setTimeout(() => { try { target.host.focus({ preventScroll: true }); } catch {} }, 0);
      }
      return;
    }
    // Ctrl+方向键：按内容跳格，单选目标行
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !editing && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key)) {
      e.preventDefault(); e.stopPropagation();
      const target = ctrlArrowTarget(cell, key);
      if (target && target.tr) {
        selectSingle(target.tr);
        selAnchorTr = target.tr;
        pendingEditMode = false;
        setTimeout(() => { try { target.host.focus({ preventScroll: true }); } catch {} }, 0);
      }
      return;
    }

    if (isDisplayOnly) {
      if (key === 'Tab' || key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const dir = ((key === 'Tab' && !e.shiftKey) || (key === 'Enter' && !e.shiftKey)) ? 1 : -1;
        navigateInSelection(cell, dir, pendingEditMode, key === 'Tab' ? 'tab' : 'enter');
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
          const trs = getMainTrs();
          const curIdx = trs.indexOf(tr);
          if (curIdx < 0) return;
          const base = (selAnchorTr && selAnchorTr.isConnected) ? selAnchorTr : tr;
          if (!selAnchorTr || !selAnchorTr.isConnected) selAnchorTr = base;
          const newIdx = curIdx + (key === 'ArrowUp' ? -1 : 1);
          if (newIdx < 0 || newIdx >= trs.length) return;
          setRangeSelection(base, trs[newIdx]);
          // 焦点移到目标行的同列
          const rowCells = getRowCells(tr);
          const colIdx = rowCells.indexOf(cell);
          const targetCells = getRowCells(trs[newIdx]);
          const target = targetCells[Math.min(colIdx, targetCells.length - 1)] || targetCells[0];
          if (target) try { target.host.focus({ preventScroll: true }); } catch {}
        } else if (!e.shiftKey) {
          pendingEditMode = false;
          navigateDirection(cell, key);
        }
        return;
      }
      return;
    }

    if (key === 'F2') {
      e.preventDefault(); e.stopPropagation();
      if (editing) {
        const hostEl = cell.host;
        const tdEl = cell.td;
        if (tdEl.tabIndex < 0) tdEl.tabIndex = 0;
        cell._exitEdit(true);
        setTimeout(() => {
          if (tdEl.contains(document.activeElement)) return;
          try { hostEl.focus({ preventScroll: true }); } catch {}
          if (!tdEl.contains(document.activeElement)) {
            try { tdEl.focus({ preventScroll: true }); } catch {}
          }
        }, 0);
      } else {
        cell._enterEdit(false);
      }
      return;
    }
    if (key === 'Escape') {
      if (editing) {
        e.preventDefault(); e.stopPropagation();
        const hostEl = cell.host;
        const tdEl = cell.td;
        if (tdEl.tabIndex < 0) tdEl.tabIndex = 0;
        cell._exitEdit(false);
        const refocus = () => {
          if (tdEl.contains(document.activeElement)) return;
          try { hostEl.focus({ preventScroll: true }); } catch {}
          if (!tdEl.contains(document.activeElement)) {
            try { tdEl.focus({ preventScroll: true }); } catch {}
          }
        };
        refocus();
        setTimeout(refocus, 0);
      }
      return;
    }
    if (key === 'Tab' || key === 'Enter') {
      if (key === 'Enter' && editing && cell.editor.tagName === 'TEXTAREA' && e.altKey) {
        e.preventDefault(); e.stopPropagation();
        const ta = cell.editor;
        const start = ta.selectionStart, end = ta.selectionEnd;
        const val = ta.value;
        ta.value = val.slice(0, start) + '\n' + val.slice(end);
        ta.selectionStart = ta.selectionEnd = start + 1;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        autoResizeTextarea(ta);
        return;
      }

      e.preventDefault(); e.stopPropagation();
      const wasEditing = cell._editing;
      const isForward = ((key === 'Tab' && !e.shiftKey) || (key === 'Enter' && !e.shiftKey));
      const dir = isForward ? 1 : -1;
      const keyType = key === 'Tab' ? 'tab' : 'enter';
      const allTrs = [...tbody.children].filter(t => t._row);

      if (wasEditing && cell.isCombined) {
        if (keyType === 'tab') {
          if (cell._ruleCell && isForward) {
            setTimeout(() => { try { cell._ruleCell.editor.focus(); } catch {} }, 0);
            return;
          }
          if (!cell._ruleCell && !isForward && cell._parent && cell._parent !== cell) {
            setTimeout(() => { try { cell._parent.editor.focus(); } catch {} }, 0);
            return;
          }
        }
        if (keyType === 'enter') {
          const rowIdx = allTrs.indexOf(cell.tr);
          const nRow = ((rowIdx + dir) % allTrs.length + allTrs.length) % allTrs.length;
          const targetTr = allTrs[nRow];
          let targetResCell = null;
          for (const td of targetTr.children) {
            const c = td._acgripCell;
            if (c && c.isCombined && !c._isRuleCell) { targetResCell = c; break; }
          }
          if (targetResCell) {
            if (!targetResCell._editing) targetResCell._enterEdit(false);
            const isRule = !!cell._isRuleCell;
            const focusCell = isRule ? targetResCell._ruleCell : targetResCell;
            cell._exitEdit(true);
            if (!targetTr.classList.contains('row-selected')) {
              clearRowSelection();
              targetTr.classList.add('row-selected');
            }
            selAnchorTr = targetTr;
            updateSelectionBorders();
            pendingEditMode = true;
            setTimeout(() => {
              if (focusCell && focusCell.editor) try { focusCell.editor.focus(); } catch {}
            }, 0);
            return;
          }
        }
      }

      const selTrs = getSelectedRows();
      const singleRow = selTrs.length <= 1;
      let target = null;

      if (singleRow && keyType === 'tab') {
        const allCells = [];
        for (const t of allTrs) for (const c of getRowCells(t)) allCells.push(c);
        const pos = allCells.indexOf(cell);
        if (pos >= 0) target = allCells[(pos + dir + allCells.length) % allCells.length];
      } else if (singleRow && keyType === 'enter') {
        const rowIdx = allTrs.indexOf(cell.tr);
        const rowCells = getRowCells(cell.tr);
        const colIdx = rowCells.indexOf(cell);
        if (colIdx >= 0) {
          const nRow = ((rowIdx + dir) % allTrs.length + allTrs.length) % allTrs.length;
          const targetCells = getRowCells(allTrs[nRow]);
          target = targetCells[Math.min(colIdx, targetCells.length - 1)];
        }
      } else {
        const trs = selTrs;
        if (keyType === 'tab') {
          const allCells = getCellList(trs);
          const pos = allCells.indexOf(cell);
          if (pos >= 0) target = allCells[(pos + dir + allCells.length) % allCells.length];
        } else {
          const colCount = Math.max(...trs.map(t => getRowCells(t).length));
          const allCells = [];
          for (let c = 0; c < colCount; c++) for (const t of trs) {
            const cells = getRowCells(t);
            if (cells[c]) allCells.push(cells[c]);
          }
          const pos = allCells.indexOf(cell);
          if (pos >= 0) target = allCells[(pos + dir + allCells.length) % allCells.length];
        }
      }

      if (wasEditing) cell._exitEdit(true);
      pendingEditMode = wasEditing;

      if (target) {
        const ttr = target.tr;
        if (!ttr.classList.contains('row-selected')) {
          clearRowSelection();
          ttr.classList.add('row-selected');
        }
        updateSelectionBorders();

        const targetCanEdit = !target.isDisplayOnly;
        if (wasEditing && targetCanEdit) {
          if (!target._editing) target._enterEdit(false);
          const focusEl = (() => {
            if (!target.isCombined) return target.editor || target.host;
            if (target.td !== cell.td && dir < 0 && target._ruleCell) return target._ruleCell.editor;
            return target.editor || target.host;
          })();
          setTimeout(() => {
            try { focusEl.focus({ preventScroll: true }); } catch {}
            if (focusEl.isContentEditable) {
              requestAnimationFrame(() => {
                if (document.activeElement !== focusEl) {
                  try { focusEl.focus({ preventScroll: true }); } catch {}
                }
              });
            }
          }, 0);
        } else {
          if (target._editing) target._exitEdit(true);
          setTimeout(() => { try { target.host.focus({ preventScroll: true }); } catch {} }, 0);
        }
      }
      return;
    }

    if (!editing && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
        extendRowSelection(tr, key === 'ArrowUp' ? -1 : 1);
      } else if (!e.shiftKey) {
        pendingEditMode = false;
        navigateDirection(cell, key);
      }
      return;
    }
    if (!editing && (key === 'Backspace' || key === 'Delete')) {
      e.preventDefault(); e.stopPropagation();
      clearCellContent(cell);
      return;
    }
    if (!editing && key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      cell._enterEdit(true);
      if (cell.editor.tagName !== 'INPUT' && cell.editor.tagName !== 'TEXTAREA') {
        e.preventDefault();
        try { document.execCommand('insertText', false, key); } catch {}
      }
      return;
    }
  }
  function navigateInSelection(currentCell, delta, keepEditing, keyType) {
    const allTrs = [...tbody.children].filter(t => t._row);
    const selTrs = getSelectedRows();
    const singleRow = selTrs.length <= 1;
    let target = null;

    if (singleRow && keyType === 'tab') {
      const allCells = [];
      for (const tr of allTrs) for (const c of getRowCells(tr)) allCells.push(c);
      const pos = allCells.indexOf(currentCell);
      if (pos < 0) return;
      target = allCells[((pos + delta) % allCells.length + allCells.length) % allCells.length];
    } else if (singleRow && keyType === 'enter') {
      const rowIdx = allTrs.indexOf(currentCell.tr);
      const rowCells = getRowCells(currentCell.tr);
      const colIdx = rowCells.indexOf(currentCell);
      if (colIdx < 0) return;
      const nRow = ((rowIdx + delta) % allTrs.length + allTrs.length) % allTrs.length;
      const targetCells = getRowCells(allTrs[nRow]);
      target = targetCells[Math.min(colIdx, targetCells.length - 1)];
    } else {
      const trs = selTrs;
      if (keyType === 'tab') {
        const allCells = getCellList(trs);
        const pos = allCells.indexOf(currentCell);
        if (pos < 0) return;
        target = allCells[((pos + delta) % allCells.length + allCells.length) % allCells.length];
      } else {
        const colCount = Math.max(...trs.map(t => getRowCells(t).length));
        const allCells = [];
        for (let c = 0; c < colCount; c++) for (const tr of trs) {
          const cells = getRowCells(tr);
          if (cells[c]) allCells.push(cells[c]);
        }
        const pos = allCells.indexOf(currentCell);
        if (pos < 0) return;
        target = allCells[((pos + delta) % allCells.length + allCells.length) % allCells.length];
      }
    }
    if (!target) return;
    const tr = target.tr;
    if (!tr.classList.contains('row-selected')) {
      selectSingle(tr);
      selAnchorTr = tr;
    }

    const targetCanEdit = !target.isDisplayOnly;
    if (keepEditing && targetCanEdit) {
      if (!target._editing) target._enterEdit(false);
      const focusEl = (() => {
        if (!target.isCombined) return target.editor || target.host;
        if (target.td !== currentCell.td && delta < 0 && target._ruleCell) return target._ruleCell.editor;
        return target.editor || target.host;
      })();
      const doFocus = () => {
        try { focusEl.focus({ preventScroll: true }); } catch {}
        if (focusEl.isContentEditable) {
          requestAnimationFrame(() => {
            if (document.activeElement !== focusEl) {
              try { focusEl.focus({ preventScroll: true }); } catch {}
            }
          });
        }
      };
      setTimeout(doFocus, 0);
    } else {
      if (target._editing) target._exitEdit(true);
      setTimeout(() => { try { target.host.focus({ preventScroll: true }); } catch {} }, 0);
    }
  }
  function navigateDirection(cell, key) {
    const allTrs = [...tbody.children].filter(t => t._row);
    const rowIdx = allTrs.indexOf(cell.tr);
    const rowCells = getRowCells(cell.tr);
    const colIdx = rowCells.indexOf(cell);
    if (colIdx < 0) return;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const nRow = rowIdx + (key === 'ArrowUp' ? -1 : 1);
      if (nRow < 0 || nRow >= allTrs.length) return;
      const targetTr = allTrs[nRow];
      const targetCells = getRowCells(targetTr);
      const target = targetCells[Math.min(colIdx, targetCells.length - 1)];
      if (!target) return;
      selectSingle(targetTr);
      selAnchorTr = targetTr;
      try { target.host.focus({ preventScroll: true }); } catch {}
    } else {
      const nCol = colIdx + (key === 'ArrowLeft' ? -1 : 1);
      if (nCol < 0 || nCol >= rowCells.length) return;
      const target = rowCells[nCol];
      if (target) try { target.host.focus(); } catch {}
    }
  }

  /* ---- updateDerived ---- */
  function updateDerived(tr) {
    const row = tr._row, parsed = parseBGMID(row.BGMID);
    const ph = (cls, v) => { const el = tr.querySelector('.' + cls); if (el) el.placeholder = v || ''; };
    ph('u-name', parsed.名称); ph('u-cn', parsed.中文); ph('u-year', parsed.年);
    ph('u-kai', parsed.开播); ph('u-max', parsed.最大);

    const nextInput = tr.querySelector('.u-next');
    if (nextInput) {
      const isEditing = nextInput._acgripCell && nextInput._acgripCell._editing;
      if (!isEditing) nextInput.value = pad2Display(row.下集);
    }
    const kaiInput = tr.querySelector('.u-kai');
    if (kaiInput) {
      const isEditing = kaiInput._acgripCell && kaiInput._acgripCell._editing;
      if (!isEditing) {
        const raw = String(row.开播 ?? '').trim();
        const num = Number(raw);
        if (raw && Number.isFinite(num) && num > 0 && num < 100) kaiInput.value = String(normalizeKai(num));
        else kaiInput.value = raw;
      }
    }

    const dlInput = tr.querySelector('.u-downloaded');
    if (dlInput) {
      const isFocused = document.activeElement === dlInput;
      const items = parseDownloadedToList(row.已下载);
      dlInput.title = items.join('\n');
      if (!isFocused) {
        dlInput.value = items.length === 0
          ? ''
          : (items.length === 1 ? String(items[0]) : `${items[items.length - 1]}+${items.length - 1}`);
        dlInput.style.height = '20px';
      }
    }

    const resDisplay = tr.querySelector('.u-res-display');
    if (resDisplay) {
      resDisplay.innerHTML = '';
      const info = getResourceDisplayInfo(row);
      if (info.href) {
        const a = cE('a');
        a.href = info.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = info.text;
        a.addEventListener('click', (e) => {
          if (e.altKey) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            clearRowSelection();
            tr.classList.add('row-selected');
            selAnchorTr = tr;
            updateSelectionBorders();
            const firstCell = getRowCells(tr)[0];
            if (firstCell && firstCell.host && firstCell.host.focus) try { firstCell.host.focus(); } catch {}
          } else e.stopPropagation();
        }, true);
        resDisplay.appendChild(a);
      } else resDisplay.textContent = info.text;
      const resVal = String(row.资源 ?? '').trim();
      const ruleVal = String(row.规则 ?? '').trim();
      const tipParts = [];
      if (isDHHMM(resVal)) tipParts.push(resVal);
      if (ruleVal) tipParts.push(ruleVal);
      else if (resVal && !isDHHMM(resVal)) tipParts.push(resVal);
      resDisplay.title = tipParts.join('\n');
    }

    const dispCell = tr.querySelector('.u-display-name');
    if (dispCell) {
      dispCell.innerHTML = '';
      const text = getDisplayName(row, parsed);
      const bgmId = getBgmIdFromBGMID(row.BGMID);
      const link = bgmId ? `https://bangumi.tv/subject/${bgmId}` : '';
      if (link && text) {
        const a = cE('a');
        a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = text;
        a.addEventListener('click', (e) => {
          if (e.altKey) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            clearRowSelection();
            tr.classList.add('row-selected');
            selAnchorTr = tr;
            updateSelectionBorders();
            const firstCell = getRowCells(tr)[0];
            if (firstCell && firstCell.host && firstCell.host.focus) try { firstCell.host.focus(); } catch {}
          }
        }, true);
        dispCell.appendChild(a);
      } else dispCell.textContent = text;
      const userCN = String(row.中文 ?? '').trim();
      const userNAME = String(row.名称 ?? '').trim();
      dispCell.classList.toggle('from-default', !userCN && !userNAME && !!text);
      setupContextCopy(dispCell, () => text);
    }

    const totalCell = tr.querySelector('.u-total');
    if (totalCell) {
      totalCell.textContent = getTotalEpisodes(row) || '';
      setupContextCopy(totalCell, () => totalCell.textContent);
    }
    const airCell = tr.querySelector('.u-air');
    if (airCell) {
      airCell.textContent = computeAirTimeText(row, parsed, lookupDelay);
      setupContextCopy(airCell, () => airCell.textContent);
    }
    const extW = tr.querySelector('.u-extw');
    if (extW) {
      const manualW = String(row.延周 ?? '').trim();
      if (manualW) { extW.placeholder = ''; extW.title = ''; }
      else {
        const { total, matched } = lookupDelay(row, parsed);
        extW.placeholder = matched ? String(total) : '';
        extW.title = matched ? `计算值: ${total}` : '';
      }
    }
    const extD = tr.querySelector('.u-extd');
    const extDCell = extD ? extD._acgripCell : null;
    // 只要不在编辑态就刷新（非编辑选中/未选中都显示计算值）
    if (extD && !(extDCell && extDCell._editing)) {
      const manualD = String(row.延日 ?? '').trim();
      const isFormula = manualD !== '' && !/^-?\d+(\.\d+)?$/.test(manualD);
      extD.classList.toggle('extd-formula', isFormula);
      if (isFormula) {
        const v = evalDelayFormula(manualD, row);
        if (Number.isFinite(v)) {
          extD.value = String(v);
          extD.dataset.exprRaw = manualD;
          extD.title = `公式: ${manualD} = ${v}`;
        }
      } else if (manualD) {
        delete extD.dataset.exprRaw;
        extD.value = manualD;
      } else {
        delete extD.dataset.exprRaw;
        extD.value = '';
      }
    }
    tr.querySelectorAll('input').forEach(input => {
      if (!input.title) input.title = input.value || input.placeholder || '';
    });
    const bgmid = tr.querySelector('.u-bgmid');
    if (bgmid) {
      bgmid.title = bgmid.textContent || '';
      bgmid.querySelectorAll('a').forEach(a => {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      });
    }
    tr.querySelectorAll('.u-cell.c-disp, .u-cell.c-total, .u-cell.c-air').forEach(td => {
      td.title = td.textContent || '';
    });
    applyRowHighlight(tr);
    // name/cn/update 强制左对齐（防任何路径下的对齐漂移）
    ['.u-name', '.u-cn', '.u-update'].forEach(sel => {
      const el = tr.querySelector(sel);
      if (el) {
        el.style.setProperty('text-align', 'left', 'important');
        el.style.setProperty('direction', 'ltr', 'important');
        el.style.setProperty('unicode-bidi', 'plaintext', 'important');
      }
    });
    // 当前聚焦的非编辑 name/cn/update → 光标归零
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      const ae = document.activeElement;
      if (ae.classList.contains('u-name') || ae.classList.contains('u-cn') || ae.classList.contains('u-update')) {
        const ac = ae._acgripCell;
        if (ac && !ac._editing) {
          try { ae.setSelectionRange(0, 0); } catch {}
          try { ae.scrollLeft = 0; } catch {}
        }
      }
    }
    refreshTempEditedMark(tr);
    applyRowBackground(tr);
  }

  function makeNumberInput(className, row, key, onInput) {
    const input = cE('input'); input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off';
    input.className = className; input.value = row[key] ?? ''; input.style.textAlign = 'center';
    input.addEventListener('input', () => { row[key] = input.value; if (onInput) onInput(input, row, key); });
    return input;
  }

  function buildRow(row) {
    const tr = cE('tr'); tr._row = row;

    /* 1. 显示名列 */
    const tdDisp = cE('td'); tdDisp.className = 'u-cell c-disp u-display-name';
    makeDisplayCell(tdDisp, tr);
    initCell(tdDisp._acgripCell);

    /* 2. 资源列（两格：资源、规则） */
    const tdCombined = cE('td'); tdCombined.className = 'u-cell u-combined';
    const displayLayer = cE('div'); displayLayer.className = 'u-res-display-layer';
    const resDisplay = cE('span'); resDisplay.className = 'u-res-display';
    const editBtn = cE('button');
    editBtn.type = 'button'; editBtn.className = 'u-res-edit-btn'; editBtn.textContent = '✎'; editBtn.title = '编辑资源 / 规则';
    displayLayer.append(resDisplay, editBtn);
    const editLayer = cE('div');
    editLayer.className = 'u-res-edit-layer';
    editLayer.style.display = 'none';
    const resInput = cE('input');
    resInput.type = 'text'; resInput.autocomplete = 'off'; resInput.className = 'u-res';
    resInput.value = row.资源 ?? '';
    const ruleInput = cE('input');
    ruleInput.type = 'text'; ruleInput.autocomplete = 'off'; ruleInput.className = 'u-rule';
    ruleInput.value = row.规则 || '';
    const doneBtn = cE('button');
    doneBtn.type = 'button'; doneBtn.className = 'u-res-edit-btn'; doneBtn.textContent = '✓'; doneBtn.style.color = '#8c8';
    editLayer.append(resInput, ruleInput, doneBtn);
    tdCombined.append(displayLayer, editLayer);

    const enterEdit = () => {
      displayLayer.style.display = 'none';
      editLayer.style.display = 'flex';
      tdCombined.classList.add('editing');
      tdCombined.style.outline = 'none';
      requestAnimationFrame(() => {
        if (document.activeElement !== resInput && document.activeElement !== ruleInput) {
          try { resInput.focus(); } catch {}
        }
        autoResizeEditLayer(editLayer, ruleInput);
      });
    };
    const exitEdit = () => {
      editLayer.style.display = 'none';
      displayLayer.style.display = 'flex';
      tdCombined.classList.remove('editing');
      tdCombined.style.outline = '';
      updateDerived(tr);
    };

    resInput.addEventListener('input', () => { row.资源 = resInput.value; updateDerived(tr); scheduleRefresh(); });
    ruleInput.addEventListener('input', () => {
      row.规则 = ruleInput.value.trim();
      requestAnimationFrame(() => autoResizeEditLayer(editLayer, ruleInput));
      scheduleRefresh();
    });

    const combinedEdit = { _editing: false, _original: null };
    const resCell = {
      td: tdCombined, host: tdCombined, editor: resInput, isCombined: true, tr,
      _parent: null, _ruleCell: null, _applyStyle: null, _isRuleCell: false,
      get _editing() { return combinedEdit._editing; },
      set _editing(v) { combinedEdit._editing = v; },
      get _original() { return combinedEdit._original; },
      set _original(v) { combinedEdit._original = v; },
      _enterEdit(clearFirst) {
        if (combinedEdit._editing) return;
        combinedEdit._original = { 资源: String(row.资源 ?? ''), 规则: String(row.规则 ?? '') };
        combinedEdit._editing = true;
        setReadOnly(resInput, false);
        setReadOnly(ruleInput, false);
        enterEdit();
        if (clearFirst) {
          resInput.value = ''; ruleInput.value = '';
          row.资源 = ''; row.规则 = '';
          updateDerived(tr);
        }
      },
      _exitEdit(commit) {
        if (!combinedEdit._editing) return;
        if (!commit) {
          row.资源 = combinedEdit._original.资源;
          row.规则 = combinedEdit._original.规则;
          resInput.value = row.资源;
          ruleInput.value = row.规则;
          updateDerived(tr);
        }
        combinedEdit._editing = false;
        combinedEdit._original = null;
        setReadOnly(resInput, true);
        setReadOnly(ruleInput, true);
        exitEdit();
        scheduleDraftSave();
      },
    };
    const ruleCell = {
      td: tdCombined, host: tdCombined, editor: ruleInput, isCombined: true, tr,
      _parent: null, _applyStyle: null, _isRuleCell: true,
      skipHostKeydown: true,
      get _editing() { return combinedEdit._editing; },
      set _editing(v) { combinedEdit._editing = v; },
      get _original() { return combinedEdit._original; },
      set _original(v) { combinedEdit._original = v; },
      _enterEdit(clearFirst) {
        resCell._enterEdit(clearFirst);
        setTimeout(() => { try { ruleInput.focus(); } catch {} }, 0);
      },
      _exitEdit(commit) { resCell._exitEdit(commit); },
    };
    resCell._parent = resCell;
    resCell._ruleCell = ruleCell;
    ruleCell._parent = resCell;
    Object.defineProperty(resCell, '_list', {
      configurable: true, enumerable: false,
      get() { return combinedEdit._editing ? [resCell, ruleCell] : [resCell]; },
    });
    Object.defineProperty(ruleCell, '_list', {
      configurable: true, enumerable: false,
      get() { return [ruleCell]; },
    });

    tdCombined._acgripCell = resCell;
    resInput._acgripCell = resCell;
    ruleInput._acgripCell = ruleCell;
    tdCombined.tabIndex = 0;

    editBtn.addEventListener('click', (e) => { e.stopPropagation(); resCell._enterEdit(false); });
    doneBtn.addEventListener('click', () => { resCell._exitEdit(true); try { tdCombined.focus(); } catch {} });

    initCell(resCell);
    initCell(ruleCell);

    /* 3. 下集 */
    const tdNext = cE('td'); tdNext.className = 'u-cell';
    const nextInput = makeNumberInput('u-next', row, '下集', () => { updateDerived(tr); scheduleRefresh(); });
    nextInput.addEventListener('blur', () => {
      const v = String(nextInput.value).trim(); const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) { row.下集 = String(n); }
      updateDerived(tr);
    });
    tdNext.appendChild(nextInput);
    makeCell(tdNext, nextInput, tr);
    const nextCell = tdNext._acgripCell;
    const origNextEnter = nextCell._enterEdit.bind(nextCell);
    nextCell._enterEdit = function (clearFirst) {
      if (!this._editing && !clearFirst) {
        nextInput.value = String(tr._row.下集 ?? '');
        if (nextInput.setSelectionRange) {
          try { nextInput.setSelectionRange(nextInput.value.length, nextInput.value.length); } catch {}
        }
      }
      return origNextEnter(clearFirst);
    };
    initCell(nextCell);

    /* 4. 总集 / 5. 播出（展示列） */
    const tdTotal = cE('td'); tdTotal.className = 'u-cell c-total u-total';
    makeDisplayCell(tdTotal, tr);
    initCell(tdTotal._acgripCell);
    const tdAir = cE('td'); tdAir.className = 'u-cell c-air u-air';
    makeDisplayCell(tdAir, tr);
    initCell(tdAir._acgripCell);

    /* 6. 延周 */
    const tdExtW = cE('td'); tdExtW.className = 'u-cell';
    const extWInput = cE('input');
    extWInput.type = 'text'; extWInput.autocomplete = 'off'; extWInput.className = 'u-extw';
    extWInput.value = row.延周 ?? ''; extWInput.style.textAlign = 'center';
    extWInput.addEventListener('input', () => { row.延周 = extWInput.value; updateDerived(tr); scheduleRefresh(); });
    tdExtW.appendChild(extWInput);
    makeCell(tdExtW, extWInput, tr); initCell(tdExtW._acgripCell);

    /* 7. 延日 */
    const tdExtD = cE('td'); tdExtD.className = 'u-cell';
    const extDInput = cE('input');
    extDInput.type = 'text'; extDInput.autocomplete = 'off'; extDInput.className = 'u-extd';
    extDInput.value = row.延日 ?? ''; extDInput.style.textAlign = 'center';
    extDInput.addEventListener('input', () => {
      row.延日 = extDInput.value;
      const s = String(extDInput.value).trim();
      if (s && !/^-?\d+(\.\d+)?$/.test(s)) { const v = evalDelayFormula(s, row); if (Number.isFinite(v)) extDInput.title = `= ${v}`; }
      else extDInput.title = extDInput.value;
      updateDerived(tr); scheduleRefresh();
    });
    tdExtD.appendChild(extDInput);
    makeCell(tdExtD, extDInput, tr); initCell(tdExtD._acgripCell);

    /* 8. BGMID */
    const tdBgmid = cE('td'); tdBgmid.className = 'u-cell c-bgmid';
    row.BGMID = cleanBGMID(row.BGMID);
    const bgmidDiv = cE('div');
    bgmidDiv.contentEditable = 'false'; bgmidDiv.className = 'u-bgmid'; bgmidDiv.innerHTML = row.BGMID || '';
    bgmidDiv.tabIndex = 0;
    bgmidDiv.addEventListener('input', () => {
      if (bgmidDiv.dataset.multilineExpanded === '1') {
        const clone = bgmidDiv.cloneNode(true);
        const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          node.nodeValue = node.nodeValue.replace(/,?\n/g, ',');
        }
        row.BGMID = clone.innerHTML;
      } else {
        row.BGMID = bgmidDiv.innerHTML;
      }
      // 不用 updateDerived / scheduleRefresh —— 它们会触发 rebuild，导致焦点丢失
      bgmidDiv.title = bgmidDiv.textContent || '';
      refreshTempEditedMark(tr);
      applyRowBackground(tr);
      scheduleDraftSave();
    });
    tdBgmid.appendChild(bgmidDiv);
    makeCell(tdBgmid, bgmidDiv, tr); initCell(tdBgmid._acgripCell);

    /* 9. 名称 */
    const tdName = cE('td'); tdName.className = 'u-cell';
    const nameInput = cE('input');
    nameInput.type = 'text'; nameInput.autocomplete = 'off'; nameInput.className = 'u-name';
    nameInput.value = row.名称 ?? '';
    nameInput.style.setProperty('text-align', 'left', 'important');
    nameInput.addEventListener('input', () => { row.名称 = nameInput.value; updateDerived(tr); scheduleRefresh(); });
    tdName.appendChild(nameInput);
    makeCell(tdName, nameInput, tr); initCell(tdName._acgripCell);

    /* 10. 中文 */
    const tdCn = cE('td'); tdCn.className = 'u-cell';
    const cnInput = cE('input');
    cnInput.type = 'text'; cnInput.autocomplete = 'off'; cnInput.className = 'u-cn';
    cnInput.value = row.中文 ?? '';
    cnInput.style.setProperty('text-align', 'left', 'important');
    cnInput.addEventListener('input', () => { row.中文 = cnInput.value; updateDerived(tr); scheduleRefresh(); });
    tdCn.appendChild(cnInput);
    makeCell(tdCn, cnInput, tr); initCell(tdCn._acgripCell);

    /* 11. 年 */
    const tdYear = cE('td'); tdYear.className = 'u-cell';
    const yearInput = makeNumberInput('u-year', row, '年', () => { updateDerived(tr); scheduleRefresh(); });
    tdYear.appendChild(yearInput);
    makeCell(tdYear, yearInput, tr); initCell(tdYear._acgripCell);

    /* 12. 开播 */
    const tdKai = cE('td'); tdKai.className = 'u-cell';
    const kaiInput = makeNumberInput('u-kai', row, '开播', () => { updateDerived(tr); scheduleRefresh(); });
    tdKai.appendChild(kaiInput);
    makeCell(tdKai, kaiInput, tr);
    const kaiCell = tdKai._acgripCell;
    const origKaiEnter = kaiCell._enterEdit.bind(kaiCell);
    kaiCell._enterEdit = function (clearFirst) {
      if (!this._editing && !clearFirst) {
        kaiInput.value = String(tr._row.开播 ?? '');
        if (kaiInput.setSelectionRange) {
          try { kaiInput.setSelectionRange(kaiInput.value.length, kaiInput.value.length); } catch {}
        }
      }
      return origKaiEnter(clearFirst);
    };
    initCell(kaiCell);

    /* 13. 放送 */
    const tdHou = cE('td'); tdHou.className = 'u-cell';
    const houInput = makeNumberInput('u-hou', row, '放送', () => { updateDerived(tr); scheduleRefresh(); });
    tdHou.appendChild(houInput);
    makeCell(tdHou, houInput, tr); initCell(tdHou._acgripCell);

    /* 14. 最大 */
    const tdMax = cE('td'); tdMax.className = 'u-cell';
    const maxInput = makeNumberInput('u-max', row, '最大', () => { updateDerived(tr); scheduleRefresh(); });
    tdMax.appendChild(maxInput);
    makeCell(tdMax, maxInput, tr); initCell(tdMax._acgripCell);

    /* 15. 更新 */
    const tdUpd = cE('td'); tdUpd.className = 'u-cell';
    const updInput = cE('input');
    updInput.type = 'text'; updInput.autocomplete = 'off'; updInput.className = 'u-update';
    updInput.value = row.更新 ?? '';
    updInput.style.setProperty('text-align', 'left', 'important');
    updInput.addEventListener('input', () => { row.更新 = updInput.value; updateDerived(tr); scheduleRefresh(); });
    tdUpd.appendChild(updInput);
    makeCell(tdUpd, updInput, tr); initCell(tdUpd._acgripCell);

    /* 16. 初始 */
    const tdInit = cE('td'); tdInit.className = 'u-cell';
    const initInput = makeNumberInput('u-init', row, '初始', () => { updateDerived(tr); scheduleRefresh(); });
    tdInit.appendChild(initInput);
    makeCell(tdInit, initInput, tr); initCell(tdInit._acgripCell);

    /* 17. 前季 */
    const tdPrev = cE('td'); tdPrev.className = 'u-cell';
    const prevInput = makeNumberInput('u-prev', row, '前季', () => { updateDerived(tr); scheduleRefresh(); });
    tdPrev.appendChild(prevInput);
    makeCell(tdPrev, prevInput, tr); initCell(tdPrev._acgripCell);

    /* 18. 记录 */
    const tdDownloaded = cE('td'); tdDownloaded.className = 'u-cell c-downloaded';
    const dlInput = cE('textarea');
    dlInput.autocomplete = 'off';
    dlInput.className = 'u-downloaded';
    dlInput.value = '';
    dlInput.rows = 1;
    dlInput.cols = 1;
    dlInput.style.cssText = 'width:100%;height:20px;line-height:20px;padding:0 1px;box-sizing:border-box;border:none;outline:none;background:transparent;font-size:12pt;font-family:inherit;text-align:left;resize:none;overflow:hidden;white-space:pre;display:block;';
    dlInput.addEventListener('focus', () => {
      dlInput.value = parseDownloadedToText(row.已下载);
      requestAnimationFrame(() => autoResizeTextarea(dlInput));
    });
    dlInput.addEventListener('input', () => {
      autoResizeTextarea(dlInput);
      adjustAdaptiveColumns();
      scheduleRefresh();
    });
    dlInput.addEventListener('blur', () => {
      setTimeout(() => {
        if (dlInput._acgripCell && dlInput._acgripCell._editing) return;
        if (tdDownloaded.contains(document.activeElement)) return;
        tdDownloaded.classList.remove('u-focus-expand');
        dlInput.style.height = '';
        dlInput.style.width = '';
        dlInput.style.maxWidth = '';
        const items = parseDownloadedToList(row.已下载);
        dlInput.value = items.length === 0
          ? ''
          : (items.length === 1 ? String(items[0]) : `${items[items.length - 1]}+${items.length - 1}`);
        dlInput.style.height = '20px';
        console.log('[记录列] blur 后显示摘要', { value: dlInput.value });
      }, 0);
    });
    tdDownloaded.appendChild(dlInput);
    makeCell(tdDownloaded, dlInput, tr);
    const dlCell = tdDownloaded._acgripCell;

    const originalExit = dlCell._exitEdit.bind(dlCell);
    dlCell._exitEdit = function (commit) {
      const wasEditing = this._editing;
      if (wasEditing && commit) {
        row.已下载 = parseTextToDownloaded(dlInput.value);
      }
      originalExit(commit);

      dlInput.style.height = '';
      dlInput.style.width = '';
      dlInput.style.maxWidth = '';
      dlInput.style.background = '';
      tdDownloaded.classList.remove('editing-expand');
      tdDownloaded.classList.remove('u-focus-expand');

      const stillFocused = document.activeElement === dlInput;
      if (stillFocused) {
        dlInput.value = parseDownloadedToText(row.已下载);
        tdDownloaded.classList.add('u-focus-expand');
        requestAnimationFrame(() => autoResizeTextarea(dlInput));
      } else {
        updateDerived(tr);
        adjustAdaptiveColumns();
      }

      // 兜底：Tab / 点击切换时焦点稍后才移走
      setTimeout(() => {
        const nowFocused = document.activeElement === dlInput;
        const items = parseDownloadedToList(row.已下载);
        if (nowFocused) {
          if (!tdDownloaded.classList.contains('u-focus-expand')) {
            tdDownloaded.classList.add('u-focus-expand');
            dlInput.value = parseDownloadedToText(row.已下载);
            autoResizeTextarea(dlInput);
          }
        } else {
          tdDownloaded.classList.remove('u-focus-expand');
          dlInput.value = items.length === 0
            ? ''
            : (items.length === 1 ? String(items[0]) : `${items[items.length - 1]}+${items.length - 1}`);
          dlInput.style.height = '20px';
        }
      }, 0);

      if (wasEditing && commit) {
        adjustAdaptiveColumns();
        console.log('[记录列] 编辑退出', { wasEditing, commit, value: dlInput.value });
      }
    };
    initCell(dlCell);
    tdCombined._editedKeys = ['资源', '规则'];
    tdNext._editedKeys = ['下集'];
    tdExtW._editedKeys = ['延周'];
    tdExtD._editedKeys = ['延日'];
    tdBgmid._editedKeys = ['BGMID'];
    tdName._editedKeys = ['名称'];
    tdCn._editedKeys = ['中文'];
    tdYear._editedKeys = ['年'];
    tdKai._editedKeys = ['开播'];
    tdHou._editedKeys = ['放送'];
    tdMax._editedKeys = ['最大'];
    tdUpd._editedKeys = ['更新'];
    tdInit._editedKeys = ['初始'];
    tdPrev._editedKeys = ['前季'];
    tdDownloaded._editedKeys = ['已下载'];
    tr.append(tdDisp, tdCombined, tdNext, tdTotal, tdAir, tdExtW, tdExtD,
              tdBgmid, tdName, tdCn, tdYear, tdKai, tdHou, tdMax,
              tdUpd, tdInit, tdPrev, tdDownloaded);

    tr._updateDerived = () => updateDerived(tr);
    tr._originalValues = storedRowSnapshot(row);
    tbody.appendChild(tr);
    updateDerived(tr);
    return tr;
  }

  function snapshotRowValues(row) {
    return {
      资源: String(row.资源 ?? ''),
      规则: String(row.规则 ?? ''),
      下集: String(row.下集 ?? ''),
      延周: String(row.延周 ?? ''),
      延日: String(row.延日 ?? ''),
      // 面板里的 row.BGMID 已由 buildRow 做过 cleanBGMID；快照基准也必须统一清洗，
      // 否则存储里的 <span> 包装会导致 BGMID 列永远被判为"已修改"
      BGMID: cleanBGMID(String(row.BGMID ?? '')),
      名称: String(row.名称 ?? ''),
      中文: String(row.中文 ?? ''),
      年: String(row.年 ?? ''),
      开播: String(row.开播 ?? ''),
      放送: String(row.放送 ?? ''),
      最大: String(row.最大 ?? ''),
      更新: String(row.更新 ?? ''),
      初始: String(row.初始 ?? ''),
      前季: String(row.前季 ?? ''),
      已下载: JSON.stringify(parseDownloadedToList(row.已下载)),
    };
  }

  function computeRowFieldValue(row, key) {
    if (key === '已下载') return JSON.stringify(parseDownloadedToList(row.已下载));
    if (key === 'BGMID') return cleanBGMID(String(row.BGMID ?? ''));
    return String(row[key] ?? '');
  }

  function refreshTempEditedMark(tr) {
    const orig = tr._originalValues;
    const row = tr._row;
    if (!orig || !row) return;
    for (const td of tr.children) {
      const keys = td._editedKeys;
      if (!keys || !keys.length) continue;
      const edited = keys.some(k => computeRowFieldValue(row, k) !== orig[k]);
      td.classList.toggle('cell-temp-edited', edited);
    }
  }

  /* ---- 表格骨架 ---- */
  const header = cE('thead'); const hr = cE('tr');
  const headerCols = [
    ['名称', '230px'], ['资源', '73px'],
    ['下集', '36px'], ['总集', '36px'], ['播出', '135px'],
    ['延周', '36px'], ['延日', '36px'], ['BGMID', '90px'],
    ['名称', '64px'], ['中文', '64px'],
    ['年', '36px'], ['开播', '46px'], ['放送', '46px'], ['最大', '36px'],
    ['更新', '36px'], ['初始', '36px'], ['前季', '36px'], ['记录', '38px'],
  ];
  for (const [label, w] of headerCols) {
    const th = cE('th'); th.textContent = label;
    if (w) { th.style.width = w; th._initialWidth = parseInt(w) || 38; }
    hr.appendChild(th);
  }
  header.appendChild(hr);
  const table = cE('table'); table.className = 'u-main-table';
  table.appendChild(header); table.appendChild(tbody); host.appendChild(table);

  for (const row of storedRows) buildRow(row);
  ensureTrailingEmpty();
  sortMainRows();
  adjustAdaptiveColumns();
  updateDelayNameHighlight();

  /* ---- 排序 / 分隔 / 高亮 ---- */
  function sortMainRows() {
    const mainRows = [...tbody.children].filter(tr => tr._row);
    mainRows.sort((a, b) => {
      const ra = a._row, rb = b._row;
      const pa = parseBGMID(ra.BGMID), pb = parseBGMID(rb.BGMID);
      // 用 effective 取值，与 applyRowHighlight 的高亮判定一致
      const maxA = Number(effective(ra, '最大', pa)) || 0;
      const maxB = Number(effective(rb, '最大', pb)) || 0;
      const nextA = Number(ra.下集) || 0, nextB = Number(rb.下集) || 0;
      // 与 applyRowHighlight 同一条件：下一集已超过最大集 → 视为 END
      // 排序：严格大于最大集才算已完结
      const endA = maxA > 1 && nextA > maxA;
      const endB = maxB > 1 && nextB > maxB;
      if (endA !== endB) return endA ? 1 : -1;    // END 行排末尾
      const da = getAirDate(ra, null, lookupDelay), db = getAirDate(rb, null, lookupDelay);
      const ta = da ? da.getTime() : Infinity, tb = db ? db.getTime() : Infinity;
      if (ta !== tb) return ta - tb;
      return getDisplayName(ra, parseBGMID(ra.BGMID)).localeCompare(getDisplayName(rb, parseBGMID(rb.BGMID)), 'zh-Hans-CN');
    });
    tbody.querySelectorAll('.divider-row').forEach(el => el.remove());
    for (const tr of mainRows) tbody.appendChild(tr);
    rebuildDividerRows();
    adjustAdaptiveColumns();
    scheduleDraftSave();
  }
  function makeDividerRow(label, bgColor) {
    const tr = cE('tr'); tr.className = 'divider-row';
    const td = cE('td'); td.colSpan = 18;
    td.style.cssText = `padding:0;border:1px solid #444;background:${bgColor};color:#cfcfcf;font-weight:bold;font-size:12pt;line-height:22px;`;
    const inner = cE('div');
    inner.className = 'divider-inner';
    // 背景同色覆盖在 td 上，保证 sticky 内容在滚动时不被行底干扰
    inner.style.cssText = `background:${bgColor};color:#cfcfcf;`;
    inner.textContent = label;
    td.appendChild(inner);
    tr.appendChild(td);
    return tr;
  }
  function makeDayDivider(d) {
    // d 是当天 0 点；getBgByDate 的边界是当天 4 点，需要加 4 小时才能命中正确的段
    const d4 = new Date(d.getTime() + 4 * 3600 * 1000);
    return makeDividerRow(
      `[${pad(d4.getMonth() + 1)}${pad(d4.getDate())} ${WEEKDAY_LABEL[d4.getDay()]}]`,
      getBgByDate(d4)
    );
  }
  function makeQuarterDivider(d, year, month) {
    const season = month === 1 ? '冬' : month === 4 ? '春' : month === 7 ? '夏' : '秋';
    return makeDividerRow(`[${String(year).slice(-2)}年${KANJI_MONTH[month]}月${season}]`, getBgByDate(d));
  }
  function rebuildDividerRows() {
    const selectedRows = new Set();
    for (const tr of tbody.children) if (tr._row && tr.classList.contains('row-selected')) selectedRows.add(tr._row);
    tbody.querySelectorAll('.divider-row').forEach(el => el.remove());
    const mainRows = [...tbody.children].filter(tr => tr._row);
    if (!mainRows.length) return;

    const rowsByDate = new Map(), noDateRows = [], endRows = [];
    for (const tr of mainRows) {
      const row = tr._row;

      // END 判定优先使用"原始快照"（保存时的值），避免临时编辑触发重排
      const orig = tr._originalValues;
      const parsed = parseBGMID(row.BGMID);
      const maxRaw = (orig && String(orig.最大 ?? '').trim())
        ? orig.最大
        : effective(row, '最大', parsed);
      const nextRaw = (orig && String(orig.下集 ?? '').trim())
        ? orig.下集
        : row.下集;
      const max = Number(maxRaw) || 0;
      const next = Number(nextRaw) || 0;

      if (max > 1 && next > max) { endRows.push(tr); continue; }

      const adj = getAirDateAdjusted(row, lookupDelay);
      if (!adj) { noDateRows.push(tr); continue; }
      const k = dateKey(adj);
      if (!rowsByDate.has(k)) rowsByDate.set(k, []);
      rowsByDate.get(k).push(tr);
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayKey = dateKey(today);
    const endKey = dateKey(new Date(today.getTime() + 7 * 86400000));
    const curM = today.getMonth() + 1;
    const curQStart = [1, 4, 7, 10][Math.floor((curM - 1) / 3)];
    let qm = curQStart, qy = today.getFullYear();
    const quarters = [];
    for (let i = 0; i < 3; i++) { qm += 3; if (qm > 12) { qm -= 12; qy++; } quarters.push({ date: new Date(qy, qm - 1, 1), year: qy, month: qm }); }
    const frag = document.createDocumentFragment();
    const pastKeys = [...rowsByDate.keys()].filter(k => k < todayKey).sort();
    if (pastKeys.length) {
      for (const k of pastKeys) { for (const tr of rowsByDate.get(k)) frag.appendChild(tr); rowsByDate.delete(k); }
    }
    const points = [];
    for (let i = 0; i <= 7; i++) points.push({ type: 'day', date: new Date(today.getTime() + i * 86400000) });
    for (const q of quarters) {
      const dk = dateKey(q.date);
      if (dk >= todayKey && dk <= endKey) points.push({ type: 'quarter', date: q.date, year: q.year, month: q.month });
    }
    points.sort((a, b) => a.date - b.date);
    for (const pt of points) {
      if (pt.type === 'quarter') frag.appendChild(makeQuarterDivider(pt.date, pt.year, pt.month));
      else {
        frag.appendChild(makeDayDivider(pt.date));
        const k = dateKey(pt.date), arr = rowsByDate.get(k);
        if (arr) { for (const tr of arr) frag.appendChild(tr); rowsByDate.delete(k); }
      }
    }
    const laterKeys = [...rowsByDate.keys()].sort();
    const nowQ = new Date();
    const curQStartNow = Math.floor(nowQ.getMonth() / 3) * 3 + 1;
    let lastQKey = `${nowQ.getFullYear()}-Q${curQStartNow}`;
    for (const k of laterKeys) {
      const d = parseDateKey(k);
      const qStart = Math.floor(d.getMonth() / 3) * 3 + 1;
      const qKeyStr = `${d.getFullYear()}-Q${qStart}`;
      if (qKeyStr !== lastQKey) {
        frag.appendChild(makeQuarterDivider(new Date(d.getFullYear(), qStart - 1, 1), d.getFullYear(), qStart));
        lastQKey = qKeyStr;
      }
      for (const tr of rowsByDate.get(k)) frag.appendChild(tr);
    }
    if (noDateRows.length) {
      frag.appendChild(makeDividerRow('[未定]', '#7e7e7e'));
      for (const tr of noDateRows) frag.appendChild(tr);
    }
    // END 行统一放末尾
    if (endRows.length) {
      frag.appendChild(makeDividerRow('[已完结]', '#7e7e7e'));
      for (const tr of endRows) frag.appendChild(tr);
    }
    tbody.innerHTML = ''; tbody.appendChild(frag); applyRowBackgrounds();
    if (selectedRows.size) for (const tr of tbody.children) if (tr._row && selectedRows.has(tr._row)) tr.classList.add('row-selected');
    updateSelectionBorders();
  }
  function applyRowBackground(tr) {
    if (!tr._row) return;
    const row = tr._row, parsed = parseBGMID(row.BGMID);
    const airDate = getAirDate(row, null, lookupDelay);
    const level = getBgLevel(airDate);
    const bg = getBgByLevel(level, false);
    const bgEmpty = getBgByLevel(level - 1, true);
    const isSelected = tr.classList.contains('row-selected');
    const SELECTED_BG = '#2d3d52';
    const SELECTED_EDIT_BG = '#1a2f5a';
    const TEMP_EDIT_BG = '#1a2f5a';

    const tds = [...tr.children];
    for (const td of tds) {
      if (td.colSpan > 1) continue;
      if (!td.classList.contains('u-cell')) continue;
      const isTempEdit = td.classList.contains('cell-temp-edited');
      let bgToUse;
      if (isTempEdit) bgToUse = isSelected ? SELECTED_EDIT_BG : TEMP_EDIT_BG;
      else if (isSelected) bgToUse = SELECTED_BG;
      else bgToUse = bg;
      td.style.setProperty('background', bgToUse, 'important');
      const ta = td.querySelector('textarea.u-downloaded');
      if (ta && !ta.closest('.editing-expand') && !ta.closest('.u-focus-expand')) {
        ta.style.setProperty('background', 'transparent', 'important');
      }
    }
    // 空值列覆盖：仅在未选中且非临时编辑时套用"上一时段色"
    if (!isSelected) {
      const checkEmpty = [
        [1, () => !String(row.资源 ?? '').trim() && !String(row.规则 ?? '').trim()],
        [9, () => !String(effective(row, '中文', parsed)).trim()],
        [10, () => !String(effective(row, '年', parsed)).trim()],
        [11, () => !String(effective(row, '开播', parsed)).trim()],
        [12, () => !String(row.放送 ?? '').trim()],
        [13, () => !String(effective(row, '最大', parsed)).trim()],
      ];
      for (const [idx, isEmpty] of checkEmpty) {
        if (!isEmpty()) continue;
        const td = tds[idx];
        if (td && !td.classList.contains('cell-temp-edited')) {
          td.style.setProperty('background', bgEmpty, 'important');
        }
      }
    }
  }
  function applyRowBackgrounds() { for (const tr of tbody.children) if (tr._row) applyRowBackground(tr); }
  function applyRowHighlight(tr) {
    const row = tr._row, parsed = parseBGMID(row.BGMID);
    const els = { next: tr.querySelector('.u-next'), kai: tr.querySelector('.u-kai'), hou: tr.querySelector('.u-hou'), air: tr.querySelector('.u-air') };
    for (const k in els) {
      if (!els[k]) continue;
      els[k].classList.remove('hl-end', 'hl-warn');
      const td = els[k].closest('td'); if (td) td.classList.remove('hl-warn');
    }
    const max = Number(effective(row, '最大', parsed)) || 0;
    const next = Number(row.下集) || 0;
    const kai = normalizeKai(Number(effective(row, '开播', parsed))) || 0;
    const hou = Number(effective(row, '放送', parsed)) || 0;
    const init = Number(effective(row, '初始', parsed)) || 0;
    const isEnd = max > 1 && next + 1 > max;
    if (isEnd && els.next) els.next.classList.add('hl-end');
    if (hou > 2359) { if (els.hou) els.hou.classList.add('hl-warn'); if (els.air) els.air.classList.add('hl-warn'); }
    const kaiRaw = String(row.开播 ?? '').trim();
    const kaiRawNum = Number(kaiRaw);
    if (kaiRaw && Number.isFinite(kaiRawNum) && kaiRawNum > 0 && kaiRawNum < 100) {
      if (els.kai) els.kai.classList.add('hl-warn');
      const kaiTd = els.kai ? els.kai.closest('td') : null;
      if (kaiTd) kaiTd.classList.add('hl-warn');
    }
    const initVal = String(row.初始 ?? '').trim() === '' ? 1 : init;
    if (max !== 1 && next === initVal && !isEnd && els.next) els.next.classList.add('hl-warn');
  }

  /* ---- 自适应 / 辅助 ---- */
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      for (const tr of tbody.querySelectorAll('tr')) if (tr._row) updateDerived(tr);
      ensureTrailingEmpty();
      adjustAdaptiveColumns();
      updateDelayNameHighlight();
      const active = document.activeElement;
      const editing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (!editing) rebuildDividerRows();
      scheduleDraftSave();
    }, 150);
  }
  function adjustAdaptiveColumns() {
    const adaptiveCols = [12, 13, 14, 17, 18];
    const thead = tbody.parentElement.querySelector('thead');
    if (!thead) return;
    const headerRow = thead.querySelector('tr');
    if (!headerRow) return;
    for (const colIdx of adaptiveCols) {
      const th = headerRow.children[colIdx - 1];
      if (!th) continue;
      let maxW = 38;
      for (const tr of tbody.children) {
        if (!tr._row) continue;
        const td = tr.children[colIdx - 1];
        if (!td) continue;
        if (colIdx === 18) {
          const dlInput = td.querySelector('.u-downloaded');
          if (!dlInput) continue;
          const isFocused = document.activeElement === dlInput;
          if (isFocused) {
            for (const p of String(dlInput.value || '').split(/\n/)) {
              const w = Math.ceil(measureTextWidth(p, '16px sans-serif')) + 12;
              if (w > maxW) maxW = w;
            }
          } else {
            const label = String(dlInput.value || '');
            if (label) {
              const w = Math.ceil(measureTextWidth(label, '16px sans-serif')) + 12;
              if (w > maxW) maxW = w;
            }
          }
          continue;
        }
        const input = td.querySelector('input, textarea');
        const text = input
          ? String(input.value || '') || String(input.placeholder || '')
          : String(td.textContent || '');
        const w = Math.ceil(measureTextWidth(text, '16px sans-serif')) + 10;
        if (w > maxW) maxW = w;
      }
      th.style.setProperty('width', maxW + 'px', 'important');
      th.style.setProperty('min-width', maxW + 'px', 'important');
      th.style.setProperty('max-width', maxW + 'px', 'important');
    }

    // 列宽变化可能影响 dialog 需要的宽度 → 重新布局
    if (_gmEditOverlay && _gmEditOverlay.isConnected && _gmEditOverlay.style.display !== 'none') {
      // 防止频繁调用
      if (!adjustAdaptiveColumns._layoutTimer) {
        adjustAdaptiveColumns._layoutTimer = setTimeout(() => {
          adjustAdaptiveColumns._layoutTimer = null;
          layoutOverlay();
        }, 200);
      }
    }
  }
  function setupContextCopy(el, getText) {
    el.addEventListener('contextmenu', (e) => {
      const text = getText(); if (!text) return;
      e.preventDefault();
      navigator.clipboard.writeText(text).then(() => showToast('已复制: ' + text)).catch(() => {
        const ta = cE('textarea'); ta.value = text;
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
        showToast('已复制: ' + text);
      });
    });
  }
  function computeAvailableWidth(el, useViewport) {
    const vw = document.documentElement.clientWidth || window.innerWidth || 1200;
    if (useViewport) {
      const rect = el.getBoundingClientRect();
      const left = Math.max(0, Math.min(rect.left, vw - 60));
      return Math.max(60, vw - left - 40);
    }
    const container = el.closest('#unifiedTableHost') || el.closest('#gmEditOverlay') || document.body;
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const rightLimit = cRect.right - 12;
    const left = Math.min(eRect.left, rightLimit - 60);
    return Math.max(60, rightLimit - left);
  }
  function autoResizeInput(input) {
    const cls = input.classList;
    const isWide = cls && (cls.contains('u-name') || cls.contains('u-cn') || cls.contains('u-update'));
    const avail = computeAvailableWidth(input, isWide);

    // BGMID（含非编辑聚焦态 / 编辑态）：右对齐，通过离屏 clone 按 pre-wrap 计算最长行宽度
    if (input.classList && input.classList.contains('u-bgmid')) {
      const container = input.closest('#unifiedTableHost') || input.closest('#gmEditOverlay') || document.body;
      const cRect = container.getBoundingClientRect();
      const td = input.closest('td');
      const tdRect = td ? td.getBoundingClientRect() : input.getBoundingClientRect();
      const availRight = Math.max(60, tdRect.right - cRect.left - 12);

      // 归一文本为"多行"形式（逗号后插入换行）
      const raw = String(input.textContent ?? '');
      let normalized;
      if (raw.includes('\n')) {
        normalized = raw;
      } else {
        const parts = raw.split(',');
        normalized = parts.map((p, i) => i < parts.length - 1 ? p + ',\n' : p).join('');
      }

      // 离屏 clone 测量
      const clone = document.createElement('div');
      clone.textContent = normalized;
      const cs = getComputedStyle(input);
      Object.assign(clone.style, {
        position: 'absolute',
        visibility: 'hidden',
        pointerEvents: 'none',
        top: '-9999px',
        left: '0',
        width: 'max-content',
        minWidth: '0',
        maxWidth: availRight + 'px',
        height: 'auto',
        maxHeight: 'none',
        padding: '2px 4px',
        border: '0',
        boxSizing: 'border-box',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        overflow: 'visible',
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        lineHeight: '1.4',
      });
      document.body.appendChild(clone);
      void clone.offsetWidth;
      const measuredW = clone.getBoundingClientRect().width;
      clone.remove();

      // 冗余：padding 左右 8 + 边框 2 + 亚像素/字距缓冲 12
      const targetW = Math.min(availRight, Math.max(tdRect.width, Math.ceil(measuredW) + 12));
      input.style.setProperty('width', targetW + 'px', 'important');
      input.style.setProperty('max-width', availRight + 'px', 'important');
      input.style.setProperty('box-sizing', 'border-box', 'important');
      return;
    }
    // input / textarea
    const rawValue = (input.value ?? input.textContent ?? '') || '';
    const placeholder = input.placeholder || '';
    const text = rawValue || placeholder;
    const textW = measureTextWidth(text, '16px sans-serif');
    const baseMin = isWide ? 240 : 38;
    const minW = Math.max(baseMin, input.parentElement?.clientWidth || 0);
    const w = Math.max(minW, Math.min(avail, textW + 24));
    input.style.setProperty('width', w + 'px', 'important');
    input.style.setProperty('max-width', avail + 'px', 'important');
    input.style.setProperty('box-sizing', 'border-box', 'important');
  }
  function autoResizeEditLayer(editLayer, ruleInput) {
    const textW = measureTextWidth(ruleInput.value || '', '16px monospace');
    const avail = computeAvailableWidth(editLayer);
    const w = Math.max(240, Math.min(avail, textW + 110));
    editLayer.style.setProperty('width', w + 'px', 'important');
    editLayer.style.setProperty('max-width', avail + 'px', 'important');
  }
  function autoResizeTextarea(ta) {
    const parent = ta.closest('td');
    const inExpand = parent && (parent.classList.contains('editing-expand') || parent.classList.contains('u-focus-expand'));
    if (!inExpand) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    const avail = computeAvailableWidth(ta);
    const maxLineW = String(ta.value || '').split('\n').reduce((m, l) => Math.max(m, measureTextWidth(l, '16px sans-serif')), 0);
    const w = Math.min(avail, Math.max(80, maxLineW + 20));
    ta.style.setProperty('width', w + 'px', 'important');
    ta.style.setProperty('max-width', avail + 'px', 'important');
  }
  /* ---- 行选择事件 ---- */
  tbody.addEventListener('mousedown', (e) => {
    const tr = e.target.closest('tr'); if (!tr || !tr._row) return;
    const isControl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (isShift) {
      e.preventDefault(); e.stopPropagation();
      // Shift+点击：从 anchor（或当前行）扩展到目标行
      const base = (selAnchorTr && selAnchorTr.isConnected) ? selAnchorTr : tr;
      if (!selAnchorTr || !selAnchorTr.isConnected) selAnchorTr = base;
      setRangeSelection(base, tr);
      return;
    }
    if (isControl) {
      e.preventDefault(); e.stopPropagation();
      // Ctrl+点击：独立切换；anchor 更新为当前行
      toggleSelect(tr);
      selAnchorTr = tr;
      return;
    }

    // 无修饰键
    if (e.target.closest('input, textarea, button, a, [contenteditable], .u-combined')) {
      const sel = getSelectedRows();
      if (sel.length > 1 || !tr.classList.contains('row-selected')) {
        selectSingle(tr);
        selAnchorTr = tr;
      }
      return;
    }

    e.preventDefault();
    selectSingle(tr);
    selAnchorTr = tr;
    selDragging = true;

    const td = e.target.closest('td.u-cell');
    if (td && td._acgripCell && !td._acgripCell.isCombined) {
      const hasInput = td.querySelector('input, textarea, [contenteditable]');
      if (!hasInput) {
        if (td.tabIndex < 0) td.tabIndex = 0;
        try { td.focus({ preventScroll: true }); } catch {}
      }
    }
  });
  document.addEventListener('mousemove', (e) => {
    if (!selDragging || !selAnchorTr) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tr = el?.closest('#gmEditOverlay tr');
    if (!tr || !tr._row) return;
    if (tr === selAnchorTr) { clearRowSelection(); tr.classList.add('row-selected'); }
    else selectRange(selAnchorTr, tr);
  });
  document.addEventListener('mouseup', () => { selDragging = false; });
  tbody.addEventListener('focusin', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || !tr._row) return;
    if (!tr.classList.contains('row-selected')) {
      clearRowSelection();
      tr.classList.add('row-selected');
      selAnchorTr = tr;
    }
    updateSelectionBorders();
  });

  /* ---- 按钮 ---- */
  dialog.querySelector('#openResourceBtn').addEventListener('click', () => {
    const rows = getSelectedRows(); if (!rows.length) { showToast('请先选择行'); return; }
    let opened = 0;
    for (const tr of rows) {
      const row = tr._row;
      const res = expandResourceUrl(String(row.资源 ?? '').trim(), row);
      const rule = expandResourceUrl(String(row.规则 ?? '').trim(), row);
      let url = ''; if (isHttpUrl(res)) url = res; else if (isHttpUrl(rule)) url = rule;
      if (url) { window.open(url, '_blank', 'noopener'); opened++; }
    }
    if (!opened) showToast('无资源链接');
  });
  dialog.querySelector('#openAiredResourceBtn').addEventListener('click', () => {
    const now = Date.now();
    let opened = 0, skipped = 0;
    const allRows = [...tbody.children].filter(tr => tr._row);
    for (const tr of allRows) {
      const row = tr._row;
      if (!row) continue;
      const airDate = getAirDate(row, null, lookupDelay);
      if (!airDate) { skipped++; continue; }
      if (airDate.getTime() >= now) { skipped++; continue; }

      const res = expandResourceUrl(String(row.资源 ?? '').trim(), row);
      const rule = expandResourceUrl(String(row.规则 ?? '').trim(), row);
      let url = '';
      if (isHttpUrl(res)) url = res;
      else if (isHttpUrl(rule)) url = rule;
      if (!url) { skipped++; continue; }

      window.open(url, '_blank', 'noopener');
      opened++;
    }
    if (!opened) showToast('无已播出条目含资源链接');
    else showToast(`已打开 ${opened} 条${skipped ? `，跳过 ${skipped} 条` : ''}`);
  });
  dialog.querySelector('#openBgmBtn').addEventListener('click', () => {
    const rows = getSelectedRows(); if (!rows.length) { showToast('请先选择行'); return; }
    let opened = 0, skipped = 0;
    for (const tr of rows) {
      const row = tr._row;
      const bgmId = getBgmIdFromBGMID(row.BGMID);
      if (!bgmId) { skipped++; continue; }
      window.open(`https://bangumi.tv/subject/${bgmId}`, '_blank', 'noopener');
      opened++;
    }
    if (!opened) showToast(skipped ? `无BGM链接（跳过 ${skipped} 行）` : '无BGM链接');
    else if (skipped) showToast(`已打开 ${opened} 条${skipped ? `，跳过 ${skipped} 条` : ''}`);
  });
  dialog.querySelector('#openBgmIdLinkBtn').addEventListener('click', () => {
    const rows = getSelectedRows(); if (!rows.length) { showToast('请先选择行'); return; }
    let opened = 0;
    for (const tr of rows) {
      const url = expandResourceUrl(extractFirstUrl(tr._row.BGMID), tr._row);
      if (url) { window.open(url, '_blank', 'noopener'); opened++; }
    }
    if (!opened) showToast('无BGMID内嵌链接');
  });
  dialog.querySelector('#deleteSelectedBtn').addEventListener('click', () => {
    const rows = getSelectedRows(); if (!rows.length) { showToast('请先选择行'); return; }
    if (!confirm(`确定删除选中的 ${rows.length} 行？`)) return;
    for (const tr of rows) tr.remove();
    ensureTrailingEmpty(); scheduleRefresh();
  });
  dialog.querySelector('#addUnifiedRow').addEventListener('click', () => {
    const last = [...tbody.children].reverse().find(tr => tr._row);
    if (last && isEmptyRow(last)) { const c = getRowCells(last)[0]; if (c) c._enterEdit(false); }
    else { const tr = buildRow({}); const c = getRowCells(tr)[0]; if (c) c._enterEdit(false); }
    ensureTrailingEmpty(); scheduleRefresh();
  });

  /* ---- 导入 ---- */
  dialog.querySelector('#importTableBtn').addEventListener('click', () => {
    const ov = cE('div'); ov.id = 'importOverlay';
    ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:10000;display:flex;justify-content:center;align-items:center;color-scheme:dark;';
    const box = cE('div');
    box.style.cssText = 'background:#1e1e1e;color:#d4d4d4;padding:16px;border-radius:8px;width:80%;max-width:800px;max-height:80vh;display:flex;flex-direction:column;gap:6px;border:1px solid #333;font-size:12pt;';
    const title = cE('h3'); title.textContent = '从表格导入'; title.style.margin = '0';
    const hint = cE('div');
    hint.style.cssText = 'color:#909090;line-height:1.4;font-size:11pt;';
    hint.innerHTML = '在 Excel 中选中数据区域（含表头）复制，粘贴到下方虚线框。<br>支持的列名：下集、中文、名称、年、开播、放送、最大、初始、前季、更新、BGMID、资源、规则、延周、延日、已下载/记录。';
    const area = cE('div'); area.contentEditable = 'true';
    area.style.cssText = 'border:2px dashed #555;border-radius:6px;padding:8px;min-height:130px;max-height:50vh;overflow:auto;background:#252525;color:#d4d4d4;font-size:12pt;';
    const btnRow = cE('div'); btnRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
    const importOnlyNew = cE('button'); importOnlyNew.type = 'button'; importOnlyNew.textContent = '仅新增';
    importOnlyNew.style.cssText = 'background:#2d5d9f;color:#fff;border:none;border-radius:4px;cursor:pointer;padding:4px 14px;font-size:12pt;';
    const importUpdate = cE('button'); importUpdate.type = 'button'; importUpdate.textContent = '更新并新增';
    importUpdate.style.cssText = 'background:#2e7d5b;color:#fff;border:none;border-radius:4px;cursor:pointer;padding:4px 14px;font-size:12pt;';
    function doImport(updateExisting) {
      const importedRows = importTableHtml(area.innerHTML);
      if (!importedRows.length) { alert('未识别到表格数据'); return; }

      // 1. 从 UI 读当前快照（副本）+ 每行的原值元数据
      const metas = [];
      {
        let idx = 0;
        const allRowObjects = collectUnifiedRows(); // [{...row}]
        for (const tr of tbody.querySelectorAll('tr')) {
          if (!tr._row || rowIsEmpty(tr._row)) continue;
          const copy = allRowObjects[idx] || { ...tr._row };
          metas.push({ row: copy });
          idx++;
        }
      }

      // 2. 名称匹配工具
      function namesOfRow(row) {
        const p = parseBGMID(row.BGMID || '');
        return new Set([
          String(row.中文 ?? '').trim(),
          String(row.名称 ?? '').trim(),
          String(p.中文 ?? '').trim(),
          String(p.名称 ?? '').trim(),
        ].filter(Boolean));
      }
      function namesOfImport(ir) {
        const p = parseBGMID(ir['BGMID'] || '');
        return new Set([
          String(ir['中文'] ?? '').trim(),
          String(ir['名称'] ?? '').trim(),
          String(p.中文 ?? '').trim(),
          String(p.名称 ?? '').trim(),
        ].filter(Boolean));
      }

      const newRows = [];
      let updated = 0, added = 0;

      for (const ir of importedRows) {
        const importNames = namesOfImport(ir);
        if (!importNames.size) continue;

        let matchedMeta = null;
        for (const meta of metas) {
          const s = namesOfRow(meta.row);
          let hit = false;
          for (const k of importNames) if (s.has(k)) { hit = true; break; }
          if (hit) { matchedMeta = meta; break; }
        }

        if (matchedMeta && updateExisting) {
          // 修改的是副本 meta.row，后续重建时生效
          for (const [k, v] of Object.entries(ir)) {
            if (v === '' || v == null) continue;
            matchedMeta.row[k] = v;
          }
          updated++;
          console.log('[导入] 更新已有行', { name: [...importNames][0], fields: Object.keys(ir) });
        } else if (!matchedMeta) {
          const newRow = {
            下集: ir['下集'] || '', 中文: ir['中文'] || '', 名称: ir['名称'] || '', 年: ir['年'] || '',
            开播: ir['开播'] || '', 放送: ir['放送'] || '', 最大: ir['最大'] || '', 初始: ir['初始'] || '',
            前季: ir['前季'] || '', 更新: ir['更新'] || '', BGMID: ir['BGMID'] || '',
            资源: ir['资源'] || '', 规则: ir['规则'] || '', 延周: ir['延周'] || '', 延日: ir['延日'] || '',
            已下载: ir['已下载'] || '',
          };
          newRows.push(newRow);
          added++;
          console.log('[导入] 新增行', { name: [...importNames][0] });
        }
      }

      // 3. 重建 UI（编辑缓存，不写 bangumiData）
      // buildRow 内部会用 storedRowSnapshot(row) 作为基准 → 已有行对比存储，新增行对比空
      tbody.innerHTML = '';
      for (const meta of metas) buildRow(meta.row);
      for (const row of newRows) buildRow(row);

      ensureTrailingEmpty();
      rebuildDividerRows();
      adjustAdaptiveColumns();
      updateDelayNameHighlight();

      // 4. 立即写草稿
      flushDraftSave();

      ov.remove();
      alert(`导入完成：更新 ${updated} 行，新增 ${added} 行（尚未保存，点"保存"写入实际数据）`);
    }
    importOnlyNew.addEventListener('click', () => doImport(false));
    importUpdate.addEventListener('click', () => doImport(true));
    const cancelBtn = cE('button'); cancelBtn.type = 'button'; cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'padding:4px 14px;font-size:12pt;';
    cancelBtn.addEventListener('click', () => ov.remove());
    btnRow.append(importOnlyNew, importUpdate, cancelBtn);
    box.append(title, hint, area, btnRow);
    ov.appendChild(box); document.body.appendChild(ov);
    area.focus();
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  });

  function collectUnifiedRows() {
    const result = [];
    for (const tr of tbody.querySelectorAll('tr')) {
      const row = tr._row; if (!row) continue;
      if (rowIsEmpty(row)) continue;
      const out = { ...row };
      if (out.下集 != null && String(out.下集).trim() !== '') {
        const n = parseInt(String(out.下集), 10);
        if (Number.isFinite(n)) out.下集 = String(n);
      }
      result.push(out);
    }
    return result;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    try {
      const newRows = collectUnifiedRows().map(r => {
        const out = { ...r };
        out.已下载 = parseDownloadedToList(out.已下载);
        out.BGMID = cleanBGMID(out.BGMID);
        const parsed = parseBGMID(out.BGMID);
        for (const f of ['名称', '中文', '年', '开播', '最大']) {
          const def = String(parsed[f] ?? '').trim();
          const val = String(out[f] ?? '').trim();
          if (def && val === def) out[f] = '';
        }
        cleanRowObject(out);
        return out;
      });
      const bd = getValue('bangumiData') ?? {};
      bd.rows = newRows;
      bd.delay = collectDelayData();
      delete bd.tracking; delete bd.trackingDownloaded;
      setValue('bangumiData', bd);
      clearDraft();
      setDiscardBtnEnabled(false);
      setValue(LAST_KEY, {
        id: dialog.querySelector('#inpLast').value,
        match: dialog.querySelector('#inpLastDownload').value,
        viewed: dialog.querySelector('#inpLastViewed').value,
      });
      // 保存后，三个输入框的临时修改标记清除
      lastModified.viewed = false;
      lastModified.id = false;
      lastModified.match = false;
      refreshLastEditedMark();
      loadDatas();
      onHandleItems(setDisplayHighlight);
      try { window.dispatchEvent(new CustomEvent('acgrip-bangumi-saved')); } catch {}
      const newRuleKeys = new Set(Object.keys(collectTrackingFromRows(newRows)).filter(k => !oldTrackingKeys.has(k)));

      // 删除 UI 上所有空行（保留最后一个作为输入位，由 ensureTrailingEmpty 补）
      const emptyTrs = [];
      for (const tr of tbody.children) {
        if (tr._row && rowIsEmpty(tr._row)) emptyTrs.push(tr);
      }
      for (const tr of emptyTrs) tr.remove();
      ensureTrailingEmpty();

      // 关键：保存后先把快照重置为已保存值，再 sortMainRows
      // 这样 rebuildDividerRows 的 END 判定使用新值，已完结→未完结的行能正确回到原位
      for (const tr of tbody.querySelectorAll('tr')) {
        if (!tr._row) continue;
        tr._originalValues = snapshotRowValues(tr._row);
        refreshTempEditedMark(tr);
      }

      sortMainRows();
      showToast('已保存');

      // 保存后重置快照，清除临时编辑标记
      for (const tr of tbody.querySelectorAll('tr')) {
        if (!tr._row) continue;
        tr._originalValues = snapshotRowValues(tr._row);
        refreshTempEditedMark(tr);
      }
      if (newRuleKeys.size && lastViewed) setTimeout(() => { downloadSince(lastViewed, newRuleKeys).catch(err => console.error(err)); }, 100);
    } catch (err) { alert('数据错误，请检查：' + err.message); }
  });

  dialog.querySelector('#gmEditCancel').addEventListener('click', () => hideDialog());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hideDialog(); });
  dialog.querySelector('#discardChangesBtn').addEventListener('click', () => {
    if (!confirm('将丢弃所有未保存的更改，恢复到上次保存的状态，确定？')) return;
    clearDraft();
    setDiscardBtnEnabled(false);
    _gmEditShow = null;
    _gmEditOverlay = null;
    _gmEditHide = null;
    _gmEditRelayout = null;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    try { localStorage.setItem(PANEL_OPEN_KEY, '1'); } catch {}  // 重建后保持打开
    showEditDialog();
  });
  /* ---- 全局 Esc / Ctrl+S ---- */
  const escKeyHandler = (e) => {
    if (overlay.style.display === 'none') return;
    if (e.key !== 'Escape') return;
    const ae = document.activeElement;
    const activeCell = ae?._acgripCell ?? ae?.closest('td')?._acgripCell;
    if (activeCell?._editing) return;
    const importOv = document.getElementById('importOverlay');
    if (importOv) { importOv.remove(); e.preventDefault(); e.stopPropagation(); return; }
    const selected = getSelectedRows();
    if (selected.length > 1) {
      const activeTr = ae?.closest?.('tr');
      let target = (activeTr && activeTr._row && selected.includes(activeTr)) ? activeTr : selAnchorTr;
      if (!target || !target._row) target = selected[0];
      selectSingle(target);
      selAnchorTr = target;
      e.preventDefault(); e.stopPropagation();
      return;
    }
    e.preventDefault(); e.stopPropagation();
    hideDialog();
  };
  const saveKeyHandler = (e) => {
    if (overlay.style.display === 'none') return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      if (document.getElementById('importOverlay')) return;
      e.preventDefault(); e.stopPropagation();
      form.requestSubmit();
    }
  };
  // 首次挂载由 _gmEditShow 统一处理
  /** 根据视口宽度决定是"并排显示"还是"居中覆盖" */
  function layoutOverlay() {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const origTable =
          document.querySelector('body > .container > table') ||
          document.querySelector('.container > table') ||
          document.querySelector('.container table') ||
          document.querySelector('table');

    const prevMaxW = dialog.style.maxWidth;
    dialog.style.maxWidth = 'none';
    void dialog.offsetWidth;
    const naturalW = dialog.getBoundingClientRect().width;
    dialog.style.maxWidth = prevMaxW;

    const splitThreshold = 1400;
    const canSplit = vw >= splitThreshold;

    if (canSplit) {
      document.body.classList.add('acgrip-split');
      overlay.style.left = '50vw';
      overlay.style.right = '0';
      overlay.style.justifyContent = 'flex-start';
      overlay.style.alignItems = 'flex-start';
      overlay.style.background = 'transparent';
      overlay.style.pointerEvents = 'none';
      overlay.style.padding = '8px 8px 8px 0';
      dialog.style.pointerEvents = 'auto';
      dialog.style.maxWidth = 'calc(50vw - 16px)';
      dialog.style.maxHeight = `calc(${vh}px - 16px)`;
      dialog.style.marginTop = '8px';
    } else {
      document.body.classList.remove('acgrip-split');
      overlay.style.left = '0';
      overlay.style.right = '0';
      overlay.style.justifyContent = 'center';
      overlay.style.alignItems = 'center';
      overlay.style.background = 'rgba(0,0,0,0.8)';
      overlay.style.pointerEvents = 'auto';
      overlay.style.padding = '';
      dialog.style.pointerEvents = 'auto';
      dialog.style.maxWidth = `${Math.min(naturalW, vw - 40)}px`;
      dialog.style.maxHeight = `calc(${vh}px - 20px)`;
      dialog.style.marginTop = '';
    }

    // 先让浏览器完成布局（acgrip-split 生效后 session-bar 移到新位置）
    // 再计算浮标位置，确保拿到最新的 session-bar.getBoundingClientRect()
    void document.body.offsetWidth;
    requestAnimationFrame(() => positionDisplay());
  }
  _gmEditRelayout = layoutOverlay;
  hideDialog = () => {
    saveLastCellState();
    flushDraftSave();
    overlay.style.display = 'none';
    try { localStorage.setItem(PANEL_OPEN_KEY, '0'); } catch {}
    document.body.classList.remove('acgrip-split');
    void document.body.offsetWidth;
    requestAnimationFrame(() => positionDisplay());
    _gmEditRelayout = null;
    document.removeEventListener('keydown', escKeyHandler, true);
    document.removeEventListener('keydown', saveKeyHandler, true);
  };
  let _layoutResizeTimer = null;
  const layoutResizeHandler = () => {
    // 无论 UI 是否打开，都跟随调整悬浮位置
    if (_layoutResizeTimer) clearTimeout(_layoutResizeTimer);
    _layoutResizeTimer = setTimeout(() => {
      _layoutResizeTimer = null;
      // 1) 决定是否并排（仅当 UI 显示时切换）
      const uiVisible = overlay.isConnected && overlay.style.display !== 'none';
      if (uiVisible) {
        layoutOverlay();
      } else {
        // UI 未显示：若之前处于 split，需要根据新宽度决定去留
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const shouldSplit = vw >= 1400;
        if (document.body.classList.contains('acgrip-split') !== shouldSplit) {
          if (shouldSplit) document.body.classList.add('acgrip-split');
          else document.body.classList.remove('acgrip-split');
        }
      }
      // 2) 无论何时都重算浮标位置
      void document.body.offsetWidth;
      requestAnimationFrame(() => positionDisplay());
    }, 150);
  };
  window.addEventListener('resize', layoutResizeHandler);
  _gmEditShow = () => {
    overlay.style.display = 'flex';
    try { localStorage.setItem(PANEL_OPEN_KEY, '1'); } catch {}
    document.removeEventListener('keydown', escKeyHandler, true);
    document.addEventListener('keydown', escKeyHandler, true);
    document.removeEventListener('keydown', saveKeyHandler, true);
    document.addEventListener('keydown', saveKeyHandler, true);
    selfAdaptiveTextarea();
    // 打开时按当前草稿状态刷新按钮
    setDiscardBtnEnabled(!!localStorage.getItem(DRAFT_KEY));
    requestAnimationFrame(() => {
      layoutOverlay();
      requestAnimationFrame(() => {
        layoutOverlay();
        restoreLastCellState();
      });
    });
  };
  overlay._syncRowUpdate = (rule, newNext) => {
    let changed = false;
    for (const tr of tbody.querySelectorAll('tr')) {
      const row = tr._row;
      if (!row) continue;
      if ((row.规则 || '').trim() !== rule) continue;

      const oldVal = String(row.下集 ?? '');
      // 无条件写入新值
      row.下集 = String(newNext);

      const nextInput = tr.querySelector('.u-next');
      const cell = nextInput && nextInput._acgripCell;
      const isEditing = !!(cell && cell._editing);

      if (nextInput) {
        if (isEditing) {
          // 编辑态：更新 _original（避免 Esc 后回退到旧值），保留用户输入
          if (cell) cell._original = nextInput.value;
        } else {
          // 非编辑态：立即更新显示为新的 pad2 值
          nextInput.value = pad2Display(newNext);
        }
      }

      // 强制刷新派生字段（播出时间、高亮、总集等）
      if (typeof tr._updateDerived === 'function') tr._updateDerived();

      scheduleDraftSave();
      if (oldVal !== String(newNext)) changed = true;
      console.log('[面板同步]', { rule, old: oldVal, new: newNext, editing: isEditing, changed });
      break;
    }
    return changed;
  };
  _gmEditHide = hideDialog;
  _gmEditOverlay = overlay;

  selfAdaptiveTextarea();
  _gmEditShow();
}

/* ============ 文本域自适应 ============ */
function selfAdaptiveTextarea() {
  const adjust = (ta) => {
    if (ta.classList && ta.classList.contains('u-downloaded')) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    ta.style.maxHeight = '70vh';
  };
  document.body.querySelectorAll('textarea').forEach(adjust);
  document.addEventListener('input', (e) => { if (e.target?.nodeName === 'TEXTAREA') adjust(e.target); });
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.nodeName === 'TEXTAREA') adjust(node);
        node.querySelectorAll?.('textarea').forEach(adjust);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/* ============ 通用工具 ============ */
function pad(num, pad = '0', total = 2) { return num.toString().padStart(total, pad); }
function onHandleItems(method, doc) {
  loadDatas();
  const list = [...gE('tr', 'all', doc ?? document)];
  list.reverse();
  for (const item of list) {
    const a = gE('.title .title a', item); if (!a) continue;
    const [href, title] = [a.getAttribute('href'), a.innerHTML.replace(/\s+/g, ' ')];
    const { found, key } = matchTitle(title);
    method({ item, a, found, key, title, href });
  }
}
function evalFormula(expr, vars) {
  if (expr === '' || expr == null) return NaN;
  const s = String(expr);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  let e = s;
  for (const [k, v] of Object.entries(vars)) e = e.replace(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), String(v ?? 0));
  if (!/^[\d\s+\-*/().]+$/.test(e)) return NaN;
  try { return Function('"use strict";return (' + e + ')')(); } catch { return NaN; }
}
function sleep(ms, subsecond = true) {
  if (!ms || ms <= 0) return;
  if (!subsecond || ms > _1s) return new Promise(resolve => setTimeout(resolve, ms));
  ms = Math.max(ms, 50);
  sleep.prototype.timerWorker ??= creatWorker();
  return sleep.prototype.timerWorker(ms);
  function creatWorker() {
    const code = `let timerMap={};self.onmessage=(e)=>{const{id,ms}=e.data;timerMap[id]=setTimeout(()=>{self.postMessage({id});delete timerMap[id];},ms);};`;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    const callbacks = new Map();
    let idCounter = 0;
    worker.onmessage = (e) => { const { id } = e.data; const r = callbacks.get(id); if (!r) return; r(); callbacks.delete(id); };
    return (ms) => new Promise((resolve) => { const id = idCounter++; callbacks.set(id, resolve); worker.postMessage({ id, ms }); });
  }
}
async function until(condition, delay, subsecond = true) {
  try {
    let result;
    delay = Math.max(50, delay ?? 50);
    while (!(result = await condition())) await sleep(delay, subsecond);
    return result;
  } catch (err) { console.error(err); }
}
function $doc(h) { const doc = document.implementation.createHTMLDocument(''); doc.documentElement.innerHTML = h; return doc; }
function cE(name) { return document.createElement(name); }
function gE(ele, mode, parent) {
  if (typeof ele === 'object') return ele;
  if (mode === undefined && parent === undefined) return (isNaN(ele * 1)) ? document.querySelector(ele) : document.getElementById(ele);
  if (mode === 'all') return (parent === undefined) ? document.querySelectorAll(ele) : parent.querySelectorAll(ele);
  if (typeof mode === 'object' && parent === undefined) return mode.querySelector(ele);
}

/* ============ AJAX（1s 节流） ============ */
function initAjax() {
  const $ajax = {
    debug: false, interval: _1s, max: 4, tid: null, error: null, conn: 0, queue: [],
    insert: function (url, data, method, context = {}, headers = {}) { return $ajax.fetch(url, data, method, context, headers, true); },
    fetch: function (url, data, method, context = {}, headers = {}, isInsert = false) {
      return new Promise((resolve, reject) => { $ajax.add(method, url, data, resolve, reject, context, headers, isInsert); });
    },
    add: function (method, url, data, onload, onerror, context = {}, headers = {}, isInsert = false) {
      method = !data ? 'GET' : method ?? 'POST';
      if (method === 'POST') {
        headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
        if (data && typeof data === 'object') data = Object.entries(data).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
      }
      context.onload = onload; context.onerror = onerror;
      if (isInsert) $ajax.queue.unshift({ method, url, data, headers, context, onload: $ajax.onload, onerror: $ajax.onerror });
      else $ajax.queue.push({ method, url, data, headers, context, onload: $ajax.onload, onerror: $ajax.onerror });
      $ajax.next();
    },
    next: function () {
      if (!$ajax.queue.length || $ajax.tid) return;
      if ($ajax.conn < $ajax.max) $ajax.timer();
    },
    getLast: function () { const v = window.localStorage.getItem('acgrip_last_post'); return v === null ? undefined : JSON.parse(v); },
    setLast: function (last) { window.localStorage.setItem('acgrip_last_post', JSON.stringify(last)); },
    timer: function () {
      function ontimer() {
        $ajax.tid = null;
        $ajax.setLast(new Date().getTime());
        if (!$ajax.queue.length) return;
        if ($ajax.conn < $ajax.max) { $ajax.send(); $ajax.timer(); }
      }
      $ajax.tid = setTimeout(ontimer, $ajax.interval);
    },
    send: function () { const current = $ajax.queue.shift(); GM_xmlhttpRequest(current); $ajax.conn++; },
    onload: function (r) {
      $ajax.conn--;
      const text = r.responseText;
      if (r.status !== 200) { $ajax.error = `${r.status} ${r.statusText}: ${r.finalUrl}`; r.context.onerror?.(new Error($ajax.error)); }
      else if (text === 'state lock limiter in effect') { $ajax.error = text; r.context.onerror?.(new Error($ajax.error)); }
      else { r.context.onload?.(text); $ajax.next(); }
    },
    onerror: function (r) {
      $ajax.conn--;
      $ajax.error = `${r.status} ${r.statusText}: ${r.finalUrl}`;
      r.context.onerror?.(new Error($ajax.error));
      $ajax.next();
    },
  };
  window.addEventListener('unhandledrejection', (e) => { console.error($ajax.error, e); });
  return $ajax;
}

/* =====================================================================
 *  供 其他脚本在acg.rip调用
 *  暴露面保持最小：只读 bangumiData、刷新 _airDate、通用 GM 存取
 * ===================================================================== */
if (/^acg\.rip$/i.test(location.hostname)) {
  unsafeWindow.acgripApi = {
    version: '1.2',

    /** 读取 bangumiData（含原脚本已写入的 _airDate 字段） */
    getBangumiData: () => getValue('bangumiData'),

    /** 刷新 _airDate 后返回最新 bangumiData（幂等） */
    refreshAirDates: () => {
      try { precomputeAirDatesGlobal(); } catch (e) { console.error('[acgripApi] refreshAirDates:', e); }
      return getValue('bangumiData');
    },

    /** 通用存取：桥接可读写自己的 GM 键，无需引入 GM_* 权限 */
    getValue,
    setValue,
  };
  console.log('[acgripApi] 已暴露 v1.2');
}