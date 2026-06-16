// ==UserScript==
// @name         acg.ripImprove
// @namespace    http://tampermonkey.net/
// @version      2026.06.16
// @description  acg.rip torrent auto download
// @author       WayneFerdon
// @include        *acg.rip*
// @downloadURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/acg.ripImprove.user.js
// @updateURL https://github.com/WayneFerdon/acg.ripImprove/raw/refs/heads/main/acg.ripImprove.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

const _1s = 1000;
const _1m = 60 * _1s;
const _1h = 60 * _1m;
const _1d = 24 * _1h;
const colors = { last: 'palegreen', tracking: 'crimson', downloaded: 'rebeccapurple' }
const timeOpt = {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
};
const $ajax = initAjax();
let trackingItems, tracking, downloaded, last, lastDownload;

onHandle();
new MutationObserver(mutations => mutations.forEach(onHandle)).observe(document.documentElement, { childList: true });
autoReload();

function loadDatas() {
  trackingItems = GM_getValue('tracking') ?? {};
  tracking = Object.keys(trackingItems).map(t => t.match(/^\/.*\/$/) ? new RegExp(t.replace(/^\/|\/$/g, '')) : t);
  downloaded = Object.fromEntries(Object.entries(GM_getValue('trackingDownloaded')).filter(([k, v]) => tracking.map(t=>t.source ?? t).includes(k)));
  last = GM_getValue('last');
  lastDownload = GM_getValue('lastDownload');
}

function onHandle() {
  onHandleItems(setDisplayHighlight);
  setTimeHover();
  if (!window.location.href.replace('page/1', '').endsWith('.rip/')) return;
  asyncDownloadTorrents();
}

function setTimeHover() {
  for (const timeObj of gE('time', 'all')) {
    if (gE('.local', timeObj)) continue;
    const gap = timeObj.innerHTML.match(`(分)|(时)|(天)|(月)|(年)`)?.reverse().findIndex(x=>x);
    let opt = JSON.parse(JSON.stringify(timeOpt));
    if (gap >= 3) opt.day = undefined;
    if (gap >= 2) opt.month = undefined;
    if (gap >= 1) opt.year = undefined;
    if (gap === 0) {
      [opt.hour, opt.minute, opt.second] = [undefined, undefined, undefined];
      opt.year = "2-digit";
    }
    timeObj.defaultHTML = timeObj.innerHTML;
    timeObj.hoverHTML = `<span class="local" style="color:cyan">${new Date(timeObj.getAttribute('datetime') * 1000).toLocaleString("zh-CN", opt).replaceAll('/', '-')}</span>`;
    timeObj.addEventListener('mouseenter', ()=>{ timeObj.innerHTML = timeObj.hoverHTML; });
    timeObj.addEventListener('mouseleave', () => { timeObj.innerHTML = timeObj.defaultHTML; });
  }
}

function setDisplayHighlight({ item, a, found, href }) {
  const color = found ? downloaded[found]?.includes(href) ? colors.downloaded : colors.tracking : href === last ? colors.last : undefined;
  [item, ...gE('a', 'all', item)].forEach(a => { a.style.color = color??a.style.color });
}

async function asyncDownloadTorrents () {
  let page = 0, html, done;
  const url2num = url => 1*url.replace('/t/', '');
  while (!done && !html?.includes(last) && page++ <= 10) {
    console.log('fetching page:', page);
    html = page === 1 ? document.documentElement.outerHTML : await $ajax.fetch(`/page/${page}`);
    onHandleItems(({ item, found, title, href })=> {
      if (done = url2num(href) <= url2num(last)) return true;
      if (!found || downloaded[found]?.includes(href)) return false;
      window.open(href + '.torrent');//, '_self');
      (downloaded[found] ??= []).push(href);
      GM_setValue('lastDownload', found);
    });
  }

  const newLast = gE('.title .title a', gE('tr', 'all')[1]).getAttribute('href');
  if (url2num(newLast) > url2num(last)) GM_setValue('last', last = newLast);
  GM_setValue('trackingDownloaded', downloaded);
  onHandleItems(setDisplayHighlight);
}

async function autoReload() {
  const index = gE('.post-index'), display = cE('span');
  index.parentNode.insertBefore(display, index);

  let min = Infinity, mini, done;
  (async () => {
    while (!done) {
      loadDatas();
      const date = new Date();
      let [d,h,m,s] = [(date.getDay()||7)-1, date.getHours(), date.getMinutes(), date.getSeconds()];
      const current = (((d*_1d/_1h+h)*_1h/_1m+m)*_1m/_1s+s)*_1s;

      for (let [item, time] of Object.entries(trackingItems).filter(([i,t])=>t)) {
        item = item.match(/^\/.*\/$/) ? item.replace(/^\/|\/$/g, '') : item;
        if (lastDownload === item) continue;
        time = (Math.floor(time/100/100)+6)*_1d+Math.floor((time/100)%100)*_1h+time%100*_1m;
        const remain = (time-current+2*_1h)%(7*_1d)-2*_1h;
        if (remain < min) [min, mini] = [remain, item];
        display.style.color = remain > 0 ? 'unset' : display.style.color='red';
      };
      if (min < 0) min = -min;
      await pauseAsync(_1s);
    }
  })();

  let remain, waited = 0, miniPrev=mini, minPrev=min;
  let opt = JSON.parse(JSON.stringify(timeOpt));
  [opt.year, opt.month, opt.day]=[];
  const start = (new Date()).toLocaleString("zh-CN", opt);
  while ((remain=(minPrev-waited)) > 0) {
    if (mini !== miniPrev) [minPrev, miniPrev, waited] = [min, mini, 0];
    const time = `${pad(Math.floor(remain/_1h),' ')}:${pad(Math.floor(remain%_1h/_1m))}:${pad(Math.floor(remain%_1m/_1s))}`;
    document.title = time;
    display.innerText = `\n@${start}\n${time} ${mini}`;
    waited += _1s;
    await pauseAsync(_1s);
  }
  done = true;
  window.location = window.location.href;
}

function pad(num, pad='0', total=2) {
  return num.toString().padStart(total, pad);
}

function onHandleItems(method, doc) {
  loadDatas();
  for (const item of gE('tr', 'all', doc??document)) {
    const a = gE('.title .title a', item);
    if (!a) continue;
    const [href, title] = [a.getAttribute('href'), a.innerHTML.replace(/\s+/g, ' ')];
    let found = tracking.find(t => t instanceof RegExp ? title.match(t) : title.includes(t));
    found = found?.source ?? found;
    if (method({ item, a, found, title, href })) return;
  }
}

function pauseAsync(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function $doc(h) {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = h;
  return doc;
}

function cE(name) { // 创建元素
  return document.createElement(name);
}

function gE(ele, mode, parent) { // 获取元素
  if (typeof ele === 'object') {
    return ele;
  } if (mode === undefined && parent === undefined) {
    return (isNaN(ele * 1)) ? document.querySelector(ele) : document.getElementById(ele);
  } if (mode === 'all') {
    return (parent === undefined) ? document.querySelectorAll(ele) : parent.querySelectorAll(ele);
  } if (typeof mode === 'object' && parent === undefined) {
    return mode.querySelector(ele);
  }
}

function initAjax() {
  const $ajax = {
    debug: false,
    interval: 300, // DO NOT DECREASE THIS NUMBER, OR IT MAY TRIGGER THE SERVER'S LIMITER AND YOU WILL GET BANNED
    max: 4,
    tid: null,
    error: null,
    conn: 0,
    queue: [],

    insert: function (url, data, method, context = {}, headers = {}) {
      return $ajax.fetch(url, data, method, context, headers, true);
    },
    fetch: function (url, data, method, context = {}, headers = {}, isInsert = false) {
      return new Promise((resolve, reject) => {
        $ajax.add(method, url, data, resolve, reject, context, headers, isInsert);
      });
    },
    repeat: function (count, func, ...args) {
      const list = [];
      for (let i = 0; i < count; i++) {
        list.push(func(...args));
      }
      return list;
    },
    add: function (method, url, data, onload, onerror, context = {}, headers = {}, isInsert = false) {
      method = !data ? 'GET' : method ?? 'POST';
      if (method === 'POST') {
        headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
        if (data && typeof data === 'object') {
          data = Object.entries(data).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
        }
      } else if (method === 'JSON') {
        method = 'POST';
        headers['Content-Type'] ??= 'application/json';
        if (data && typeof data === 'object') {
          data = JSON.stringify(data);
        }
      }
      context.onload = onload;
      context.onerror = onerror;
      if (isInsert) {
        $ajax.queue.unshift({ method, url, data, headers, context, onload: $ajax.onload, onerror: $ajax.onerror });
      } else {
        $ajax.queue.push({ method, url, data, headers, context, onload: $ajax.onload, onerror: $ajax.onerror });
      }
      $ajax.next();
    },
    next: function () {
      if (!$ajax.queue.length) {
        return;
      }
      if ($ajax.tid) {
        if (!$ajax.conn) {
          clearTimeout($ajax.tid);
          $ajax.tid = null;
          $ajax.timer();
          $ajax.send();
        }
      } else {
        if ($ajax.conn < $ajax.max) {
          $ajax.timer();
          $ajax.send();
        }
      }
    },
    getLast: function () {
      const v = window.localStorage.getItem('acgrip_last_post');
      return v === null ? undefined : JSON.parse(v);
    },
    setLast: function (last) {
      window.localStorage.setItem('acgrip_last_post', JSON.stringify(last));
    },
    timer: function () {
      function ontimer() {
        const now = new Date().getTime();
        const last = $ajax.getLast();
        if (last && now - last >= $ajax.interval) {
          $ajax.next();
          return;
        }
        $ajax.setLast(now);
        $ajax.tid = null;
        $ajax.next();
      };
      $ajax.tid = setTimeout(ontimer, $ajax.interval);
    },
    simplify: function (r) {
      const info = {};
      info.url = r.url;
      if (r.data) info.data = r.data;
      if (r.method) info.method = r.method;
      if (r.context && JSON.stringify(r.context) !== JSON.stringify({})) info.context = r.context;
      if (r.headers && JSON.stringify(r.headers) !== JSON.stringify({})) info.headers = r.headers;
      return info;
    },
    send: function () {
      const current = $ajax.queue.shift();
      GM_xmlhttpRequest(current);
      $ajax.conn++;
      if (!$ajax.debug) return;
      const remain = $ajax.queue.map($ajax.simplify);
      console.log('$ajax.send:', $ajax.simplify(current), ... remain?.length ? ['remain:', remain] : []);
    },
    onload: function (r) {
      $ajax.conn--;
      const text = r.responseText;
      if (r.status !== 200) {
        $ajax.error = `${r.status} ${r.statusText}: ${r.finalUrl}`;
        r.context.onerror?.(new Error($ajax.error));
      } else if (text === 'state lock limiter in effect') {
        $ajax.error = text;
        r.context.onerror?.(new Error($ajax.error));
      } else {
        r.context.onload?.(text);
        $ajax.next();
      }
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
