// ==UserScript==
// @name         acg.rip torrent auto download
// @namespace    http://tampermonkey.net/
// @version      2026.05.15
// @description  acg.rip torrent auto download
// @author       WayneFerdon
// @include        *acg.rip*
// @updateURL https://github.com/WayneFerdon/acg.rip_torrent_auto_download/raw/refs/heads/main/acg.rip_torrent_auto_download.user.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

const tracking = GM_getValue('tracking', [
  /\[ANi\]( Kirio Fan( C|c)lub \/)* 霧尾粉絲後援會 - /,
  '[ANi] 關於我在無意間被隔壁的天使變成廢柴這件事 2 - ',
  '[ANi] 關於我轉生變成史萊姆這檔事 第四季 - ',
  /\[ANi\]( I Want to End This Love Game \/)* 想結束這場「我愛你」的遊戲 - /,
  /\[ANi\]( Tsue to Tsurugi no Wistoria \/)* 杖與劍的魔劍譚 Season 2 - /,
  /\[ANi\]( Marikas Love *Meter Malfunction \/)* 茉莉花同學的好感度壞得很徹底 - /,
  /\[ANi\]( The Beginning After the End (S02 )*\/)* 終末起點 第(二| 2 )季 - /,
  /\[ANi\] 木頭風紀委員和迷你裙 JK 的故事 - /,
  '[ANi] 女神「異世界轉生想成為什麼」我「勇者的肋骨」 - ',
  '[ANi] 黑貓與魔女的教室 - ',
  '[ANi] The Food Diary of Miss Maid / 女僕小姐的貪吃日常 - ',
  '[ANi] 女騎士成為蠻族新娘 - ',
  '[ANi] Mistress Kanan Is Devilishly Easy / 容易對付的惡魔大人 - ',
  '[ANi] KILL BLUE / 殺手青春 - ',
  '[ANi] Pardon the Intrusion Im Home / 我回來了，他又來打擾了！ - ',
  '[ANi] Ichijyoma Mankitsu Gurashi / 一疊間漫畫咖啡廳日常 - ',
  '[ANi] Magical Sisters LuluttoLilly / 魔法姊妹露露特莉莉 - ',
  '【极影字幕·毁片党】灰原的第二轮青春新游戏 ',
]);

const $ajax = initAjax();
const colors = { last: 'palegreen', tracking: 'crimson', downloaded: 'rebeccapurple' }
let last = GM_getValue('last', null);
let downloaded = GM_getValue('downloaded', {});
Object.keys(downloaded).forEach(k => {
  if (tracking.map(t=>t.source ?? t).includes(k)) return;
  delete downloaded[k];
});

onHandle();
new MutationObserver(mutations => mutations.forEach(onHandle)).observe(document.documentElement, { childList: true });

function onHandle() {
  onHandleItems(setDisplayHighlight);
  setTimeHover();
  if (!window.location.href.endsWith('.rip/')) return;
  asyncDownloadTorrents();
}

function setTimeHover() {
  for (const timeObj of gE('time', 'all')) {
    if (gE('.local', timeObj)) continue;
    const opt = {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    };
    const gap = timeObj.innerHTML.match(`(分)|(时)|(天)|(月)|(年)`)?.reverse().findIndex(x=>x);
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
  let page = 1, html, done;
  const url2num = (url) => 1*url.replace('/t/', '');
  while (!done && !html?.includes(last) && page <= 20) {
    if (page === 1) {
      console.log('on index page');
      html = document.documentElement.outerHTML;
    } else {
      console.log('fetching page:', page);
      html = await $ajax.fetch(`/page/${page}`);
    }
    page++;
    let delay = 0;
    onHandleItems(({ item, found, title, href })=> {
      if (url2num(href) <= url2num(last)) {
        done = true;
        return;
      }
      if (!found || downloaded[found]?.includes(href)) return;
      console.log('download:', href, title, item, gE('.action>a', item));
      window.open(href + '.torrent');//, '_self');
      (downloaded[found] ??= []).push(href);
    });
  }

  const newLast = gE('.title .title a', gE('tr', 'all')[1]).getAttribute('href');
  if (url2num(newLast) > url2num(last)) {
    GM_setValue('last', newLast);
  }
  GM_setValue('downloaded', downloaded);
  onHandleItems(setDisplayHighlight);

}

function onHandleItems(method, doc) {
  gE('tr', 'all', doc??document).forEach(item => {
    const a = gE('.title .title a', item);
    if (!a) return;
    const [href, title] = [a.getAttribute('href'), a.innerHTML.replace(/\s+/g, ' ')];
    let found = tracking.find(t => t instanceof RegExp ? title.match(t) : title.includes(t));
    found = found?.source ?? found;
    method({ item, a, found, title, href });
  });
}
function pauseAsync(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function $doc(h) {
  const doc = document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = h;
  return doc;
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
        r.context.onerror?.();
      } else if (text === 'state lock limiter in effect') {
        $ajax.error = text;
        r.context.onerror?.();
      } else {
        r.context.onload?.(text);
        $ajax.next();
      }
    },
    onerror: function (r) {
      $ajax.conn--;
      $ajax.error = `${r.status} ${r.statusText}: ${r.finalUrl}`;
      r.context.onerror?.();
      $ajax.next();
    },
  };
  window.addEventListener('unhandledrejection', (e) => { console.error($ajax.error, e); });
  return $ajax;
}
