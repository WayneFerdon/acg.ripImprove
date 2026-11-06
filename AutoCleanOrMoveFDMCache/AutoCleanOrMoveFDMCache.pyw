# ----------------------------------------------------------------
# Author: WayneFerdon wayneferdon@hotmail.com
# Date: 2026-10-19 01:05:38
# LastEditors: WayneFerdon wayneferdon@hotmail.com
# LastEditTime: 2026-10-19 20:58:38
# FilePath: \undefinede:\Wayne Custaf Laqinoa Ferdon\OneDrive\OneDrive\Tools\AutoCleanOrMoveFDMCache\AutoCleanOrMoveFDMCache.pyw
# ----------------------------------------------------------------
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
# ----------------------------------------------------------------

import os
import re
import sys
import time
import json
import ctypes
import hashlib
import sqlite3
import shutil
import threading
import urllib.parse
import ctypes
from ctypes import wintypes

# ================= 配置区 =================
DB_PATH = r"C:\Users\WayneFerdon\AppData\Local\Softdeluxe\Free Download Manager\db.sqlite"
TARGET_DIR = r"F:\番組"
FILENAME_REGEX = r"\[(Ani|Nekomoe kissaten)\]|1080p\.mp4"
URL_REGEX = r"quark\.c"
DEFAULT_DOWNLOAD_DIR = r"C:\Users\WayneFerdon\Downloads"

FORCE_SCAN_INTERVAL = 1
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

LOG_FILE = os.path.join(BASE_DIR, "fdm_mover.log")

# ============ 夸克云端删除桥 ============
# 页面（油猴脚本 QuarkAutoAssistant）通过 http://127.0.0.1:BRIDGE_PORT/pending 查询
# "哪些文件已经下载完成并搬走"，删完云端后 POST /ack 回报。
BRIDGE_PORT = 8732
PENDING_PATH = os.path.join(BASE_DIR, "quark_pending_delete.json")
PENDING_TTL = 7 * 24 * 3600          # 待删条目最多保留 7 天（文件一直没在云端出现就丢弃）
_pending_lock = threading.Lock()

def _pending_load():
    try:
        with open(PENDING_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            now = time.time()
            return [x for x in data if isinstance(x, dict)
                    and (now - float(x.get("at") or 0)) < PENDING_TTL]
    except Exception:
        pass
    return []

def _pending_save(items):
    tmp = PENDING_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PENDING_PATH)

def add_pending_delete(url, name):
    """登记"这个云端文件本地已有完整副本，可以删了"。按 url 去重。"""
    if not url:
        return
    try:
        with _pending_lock:
            items = [x for x in _pending_load() if x.get("url") != url]
            items.append({"url": url, "name": name or "", "at": int(time.time())})
            _pending_save(items)
        log_msg(f"☁️ 已登记云端待删: {name or url[:70]}")
    except Exception as e:
        log_msg(f"⚠️ 登记待删失败: {e}")

def ack_pending_delete(urls):
    if not urls:
        return 0
    s_ = set(urls)
    try:
        with _pending_lock:
            items = _pending_load()
            keep = [x for x in items if x.get("url") not in s_]
            n = len(items) - len(keep)
            if n:
                _pending_save(keep)
        if n:
            log_msg(f"☁️ 页面已删除云端文件 {n} 个")
        return n
    except Exception as e:
        log_msg(f"⚠️ 确认待删失败: {e}")
        return 0

def _norm_queued_name(v):
    """文件名归一化：去掉 FDM 自动加的 (1)/(2) 副本后缀"""
    s = str(v or '').strip()
    return re.sub(r'\s*\(\d+\)(?=\.[^.]+$)', '', s)


def _norm_queued_path(u):
    """取 URL 的 path 部分：签名参数会变，path 才是同一个文件的稳定标识"""
    try:
        return urllib.parse.urlsplit(str(u or '')).path or ''
    except Exception:
        return ''


def _last_result_category(blob):
    """从 FDM downloads.lastResult（UTF-16 结构）里取错误类别：
       成功/无结果 → ''；失败 → 'HttpError' / 'GenericError' 等。"""
    if not blob:
        return ''
    raw = bytes(blob)
    texts = []
    for enc in ('utf-16-be', 'utf-16-le'):
        try:
            texts.append(raw.decode(enc, errors='ignore'))
        except Exception:
            pass
    for text in texts:
        m = re.search(r'([A-Za-z]{3,}Error)', text)
        if not m:
            continue
        cat = m.group(1)
        if cat.lower() in ('noerror', 'noterror'):
            continue
        return cat
    return ''


def _task_state(finished_time, last_result_time, last_result):
    """返回 (state, error_category)。
       done   已完成（finishedTime > 0）
       error  失败（有 Error 类别，且未完成）
       stopped 有结果但未完成、且不是 Error（暂停/取消等）
       active 排队或下载中"""
    try:
        ft = int(finished_time or 0)
    except Exception:
        ft = 0
    try:
        lrt = int(last_result_time or 0)
    except Exception:
        lrt = 0
    cat = _last_result_category(last_result)
    if ft > 0:
        return 'done', cat
    if cat:
        return 'error', cat
    if lrt > 0:
        return 'stopped', cat
    return 'active', cat


def _query_queued(body):
    """判断某个直链在 FDM 里的任务状态。

    queued=True 只在"已有任务且不是异常状态"时返回：
      - active / done / stopped  → queued=True
      - error（HttpError 等）    → queued=False + exists=True + state=error，
                                   油猴继续轮询，等重新触发后状态变化
      - 没有任务                 → queued=False + exists=False
    匹配顺序：完整 URL → URL path（签名不同也能命中）→ 文件名。
    只认最近 windowSec 秒内创建的记录，避免命中旧任务。
    """
    urls = [str(u) for u in (body.get('urls') or []) if u]
    if not urls:
        return {"ok": True, "queued": False, "exists": False, "reason": "no-url"}
    name = str(body.get('name') or '').strip()
    want_name = _norm_queued_name(name)
    want_paths = {p for p in (_norm_queued_path(u) for u in urls) if p}
    try:
        window = float(body.get('windowSec') or 180)
    except Exception:
        window = 180.0
    now = time.time()

    if not os.path.exists(DB_PATH):
        return {"ok": False, "queued": False, "exists": False, "error": "db-missing"}

    con = None
    try:
        # 只读连接，避免与 FDM 写入互相阻塞
        con = sqlite3.connect('file:%s?mode=ro' % DB_PATH.replace('\\', '/'), uri=True, timeout=2)
        cur = con.cursor()
        cur.execute(
            "SELECT id, url, title, preferredFileTitle, creationTime, finishedTime, "
            "lastResult, lastResultTime "
            "FROM downloads ORDER BY id DESC LIMIT 300"
        )
        for row in cur.fetchall():
            rid, rurl, title, pref, ct, ft, lr, lrt = row
            rurl = rurl or ''
            ct = int(ct or 0)
            if ct <= 0:
                continue
            age = now - ct
            if age < -30 or age > window:
                continue
            match = None
            if rurl in urls:
                match = 'url'
            elif _norm_queued_path(rurl) in want_paths:
                match = 'path'
            elif want_name and (_norm_queued_name(title) == want_name
                                or _norm_queued_name(pref) == want_name):
                match = 'name'
            if not match:
                continue
            state, cat = _task_state(ft, lrt, lr)
            info = {
                "ok": True, "exists": True, "match": match, "taskId": rid,
                "creationTime": ct, "finishedTime": int(ft or 0),
                "state": state, "error": cat, "ageMs": int(age * 1000),
            }
            if state == 'error':
                # 异常任务不算"入队完成"：让油猴继续等状态变化
                return {**info, "queued": False}
            return {**info, "queued": True}
        return {"ok": True, "queued": False, "exists": False, "scanned": 300, "windowSec": window}
    except Exception as e:
        return {"ok": False, "queued": False, "exists": False, "error": str(e)}
    finally:
        try:
            if con:
                con.close()
        except Exception:
            pass


def _query_errors(body):
    """列出最近 windowSec 内处于 error 状态的 FDM 任务，供油猴在批量下载前修正记录。"""
    try:
        window = float(body.get('windowSec') or 24 * 3600)
    except Exception:
        window = 24 * 3600.0
    try:
        limit = int(body.get('limit') or 300)
    except Exception:
        limit = 300
    now = time.time()

    if not os.path.exists(DB_PATH):
        return {"ok": False, "error": "db-missing", "items": []}

    con = None
    try:
        con = sqlite3.connect('file:%s?mode=ro' % DB_PATH.replace('\\', '/'), uri=True, timeout=2)
        cur = con.cursor()
        cur.execute(
            "SELECT id, url, title, preferredFileTitle, creationTime, finishedTime, "
            "lastResult, lastResultTime "
            "FROM downloads ORDER BY id DESC LIMIT 1500"
        )
        items = []
        for row in cur.fetchall():
            rid, rurl, title, pref, ct, ft, lr, lrt = row
            try:
                ft = int(ft or 0)
                lrt = int(lrt or 0)
            except Exception:
                continue
            state, cat = _task_state(ft, lrt, lr)
            if state != 'error':
                continue
            if lrt > 0 and (now - lrt) > window:
                continue
            url = rurl or ''
            items.append({
                "taskId": rid,
                "url": url,
                "path": _norm_queued_path(url),
                "name": _norm_queued_name(title or pref or ''),
                "error": cat,
                "creationTime": int(ct or 0),
                "lastResultTime": lrt,
                "ageMs": int((now - lrt) * 1000) if lrt > 0 else None,
            })
            if len(items) >= limit:
                break
        return {"ok": True, "count": len(items), "windowSec": window, "items": items}
    except Exception as e:
        return {"ok": False, "error": str(e), "items": []}
    finally:
        try:
            if con:
                con.close()
        except Exception:
            pass


def _start_bridge_server():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def _send(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self._send({})

        def do_GET(self):
            if self.path.startswith("/pending"):
                items = _pending_load()
                self._send({"ok": True, "count": len(items), "items": items})
            elif self.path.startswith("/queued"):
                try:
                    q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    body = {
                        "urls": q.get("url") or [],
                        "name": (q.get("name") or [""])[0],
                        "windowSec": (q.get("windowSec") or [""])[0],
                    }
                except Exception:
                    body = {}
                self._send(_query_queued(body))
            elif self.path.startswith("/errors"):
                try:
                    q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    body = {
                        "windowSec": (q.get("windowSec") or [""])[0],
                        "limit": (q.get("limit") or [""])[0],
                    }
                except Exception:
                    body = {}
                self._send(_query_errors(body))
            else:
                self._send({"ok": False, "error": "not found"}, 404)

        def do_POST(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
            except Exception:
                body = {}
            if self.path.startswith("/ack"):
                self._send({"ok": True, "acked": ack_pending_delete(body.get("urls") or [])})
            elif self.path.startswith("/queued"):
                self._send(_query_queued(body))
            elif self.path.startswith("/errors"):
                self._send(_query_errors(body))
            else:
                self._send({"ok": False, "error": "not found"}, 404)

        def log_message(self, *args):
            pass

    try:
        srv = ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), Handler)
    except OSError as e:
        log_msg(f"⚠️ 云端删除桥启动失败（127.0.0.1:{BRIDGE_PORT} 被占用？）: {e}")
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    log_msg(f"🌉 云端删除桥已启动: http://127.0.0.1:{BRIDGE_PORT}/pending")
# =====================================

_LOG_TAIL_READ = 8192      # 从文件尾部最多读这么多字节来定位最后一行
_last_count = 0            # 仅供显示参考，不再作为判定依据
_console_last_len = 0
_console_dirty = False

TEMP_SUFFIXES = ('.fdmdownload', '.fdm', '.part', '.download', '.crdownload', '.tmp')
processed_ids = set()
log_cache = {}
# ==========================================

# ================= 日志模块（文件尾部驱动的去重） =================

def _fmt_count(n):
    return f" (+{n})" if n > 0 else ""

def _last_line_info():
    """返回 (最后一行起始字节偏移, 最后一行文本)。文件空/无内容返回 (0, '')。
    行尾统一 rstrip(b'\\r\\n')，兼容 \\n、\\r\\n、末尾多个空行。"""
    try:
        size = os.path.getsize(LOG_FILE)
    except OSError:
        return 0, ""
    if size <= 0:
        return 0, ""
    try:
        with open(LOG_FILE, "rb") as f:
            read_size = min(size, _LOG_TAIL_READ)
            f.seek(size - read_size)
            tail = f.read()
    except Exception:
        return 0, ""

    # 去掉尾部所有 \r / \n（处理 \r\n 和多空行）
    end = len(tail)
    while end > 0 and tail[end - 1] in (0x0A, 0x0D):
        end -= 1
    if end == 0:
        return 0, ""

    start_in_tail = tail.rfind(b"\n", 0, end) + 1
    line_bytes = tail[start_in_tail:end]
    line_start = (size - read_size) + start_in_tail
    try:
        return line_start, line_bytes.decode("utf-8", errors="replace")
    except Exception:
        return 0, ""

def _match_last_line(line_text, msg):
    """若 line_text 是 '[ts] msg' 或 '[ts] msg (+N)'，返回 N（无 +N 时 0）；否则 None。
    不依赖 re.escape / $ 边界：先剥离 ' (+N)' 后缀，再看 msg 是否为剩余文本的后缀。"""
    if not line_text:
        return None
    line_text = line_text.rstrip()
    msg = msg.rstrip()
    if not line_text or not msg:
        return None

    n = 0
    m = re.search(r' \(\+(\d+)\)$', line_text)
    if m:
        n = int(m.group(1))
        line_text = line_text[:m.start()]

    if not line_text.endswith(msg):
        return None
    prefix = line_text[:-len(msg)]          # 剩下的应是 '[ts] '
    if prefix.startswith('[') and '] ' in prefix and '\n' not in prefix:
        return n
    return None

def log_msg(*args):
    global _last_count, _console_last_len, _console_dirty

    msg = " ".join(map(str, args))
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')

    # ---------- 文件：以"最后一行是否与 msg 匹配"为唯一依据 ----------
    line_start, last_line = _last_line_info()
    prev_count = _match_last_line(last_line, msg) if last_line else None

    if prev_count is not None:
        new_count = prev_count + 1
        new_line = f"[{timestamp}] {msg}{_fmt_count(new_count)}"
        try:
            with open(LOG_FILE, "r+b") as f:
                f.seek(line_start)
                f.write((new_line + "\n").encode("utf-8"))
                f.truncate()
            _last_count = new_count
        except Exception as e:
            _last_count = 0
            if sys.stdout:
                try:
                    print(f"❌ 无法写入日志文件: {e}", flush=True)
                except Exception:
                    pass
    else:
        new_line = f"[{timestamp}] {msg}"
        try:
            with open(LOG_FILE, "ab") as f:
                f.write((new_line + "\n").encode("utf-8"))
            _last_count = 0
        except Exception as e:
            _last_count = 0
            if sys.stdout:
                try:
                    print(f"❌ 无法写入日志文件: {e}", flush=True)
                except Exception:
                    pass

    # ---------- 控制台：与文件分支保持一致 ----------
    if sys.stdout:
        try:
            tty = sys.stdout.isatty()
        except Exception:
            tty = False

        if prev_count is not None:
            if tty:
                line = f"[{timestamp}] {msg}{_fmt_count(_last_count)}"
                pad = max(0, _console_last_len - len(line))
                try:
                    sys.stdout.write("\r" + line + " " * pad)
                    sys.stdout.flush()
                except Exception:
                    pass
                _console_last_len = len(line)
                _console_dirty = True
        else:
            if _console_dirty and tty:
                try:
                    sys.stdout.write("\n")
                except Exception:
                    pass
                _console_dirty = False
            line = f"[{timestamp}] {msg}"
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except Exception:
                pass
            _console_last_len = len(line)
# ================================================================

if sys.stdout:
    try:
        # 日志里有 emoji；控制台/管道若是 GBK 会直接抛 UnicodeEncodeError 把进程打死
        sys.stdout.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
    except Exception:
        try:
            sys.stdout.reconfigure(line_buffering=True)
        except Exception:
            pass

def is_temp_file(filename):
    return any(filename.lower().endswith(suffix) for suffix in TEMP_SUFFIXES)

def log_throttled(key, msg):
    now = time.time()
    if now - log_cache.get(key, 0) > 15:
        log_msg(msg)
        log_cache[key] = now

def get_unique_filename(dst):
    if not os.path.exists(dst):
        return dst
    base, ext = os.path.splitext(dst)
    i = 1
    new_dst = f"{base} ({i}){ext}"
    while os.path.exists(new_dst):
        i += 1
        new_dst = f"{base} ({i}){ext}"
    return new_dst

def _file_md5(path, chunk_size=4 * 1024 * 1024):
    h = hashlib.md5()
    with open(path, "rb") as f:
        while True:
            buf = f.read(chunk_size)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def _same_content(a, b):
    """大小 + 内容哈希都一致才算同一个文件。
    只比大小是会出事的：目标里若残留一个"大小刚好相同"的坏文件，会被误判成已完成而删掉好的源文件。"""
    try:
        if os.path.getsize(a) != os.path.getsize(b):
            return False
        return _file_md5(a) == _file_md5(b)
    except Exception:
        return False


def _find_identical_in_dir(dir_path, src, src_size, exclude=None):
    """在目标目录里找"内容完全相同"的文件（不论文件名）。
    先用大小筛（大小不同必然不同），只对同大小的候选算 MD5，避免无谓读盘。
    找到返回路径，否则 None。"""
    try:
        if not os.path.isdir(dir_path):
            return None
        ex = os.path.abspath(exclude) if exclude else None
        same_size = []
        with os.scandir(dir_path) as it:
            for entry in it:
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    if entry.name.lower().endswith(".part"):
                        continue
                    if ex and os.path.abspath(entry.path) == ex:
                        continue
                    if entry.stat().st_size != src_size:
                        continue
                    same_size.append(entry.path)
                except OSError:
                    continue
        if not same_size:
            return None
        src_hash = _file_md5(src)
        for cand in same_size:
            try:
                if _file_md5(cand) == src_hash:
                    return cand
            except Exception:
                continue
    except Exception as e:
        log_msg(f"⚠️ 目标目录查重失败（按普通移动处理）: {e}")
    return None


def _native_move(src, dst):
    """优先用系统原生移动：
         同卷 → MoveFileExW 直接改名（不复制，零风险）；
         跨卷 → MoveFileExW(MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH)，
                由内核完成复制并写穿，返回时数据已落盘，避免用户态复制"没写完就报成功"。
       失败返回 False，由调用方退回安全复制。"""
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        fn = kernel32.MoveFileExW
        fn.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        MOVEFILE_COPY_ALLOWED = 0x2
        MOVEFILE_WRITE_THROUGH = 0x8
        if fn(str(src), str(dst), MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH):
            return True
        log_msg(f"⚠️ 原生移动失败（WinError {ctypes.get_last_error()}）: {os.path.basename(src)}")
    except Exception as e:
        log_msg(f"⚠️ 原生移动不可用: {e}")
    return False


def _move_done(src, dst, size):
    """真正完成移动：目标存在、大小一致、源已消失"""
    try:
        if not os.path.isfile(dst):
            return False
        if os.path.getsize(dst) != size:
            return False
        return not os.path.exists(src)
    except OSError:
        return False


def _copy_move(src, dst, src_size, chunk_size):
    """兜底方案：写 .part → flush + fsync → 读回哈希校验 → 原子改名 → 删源。
       任何一步不过都不会碰源文件，也不会把半截文件顶到目标名上。"""
    part = dst + ".part"
    try:
        h = hashlib.md5()
        copied = 0
        last_log = time.time()
        with open(src, "rb") as fsrc, open(part, "wb") as fdst:
            while True:
                buf = fsrc.read(chunk_size)
                if not buf:
                    break
                fdst.write(buf)
                h.update(buf)
                copied += len(buf)
                now = time.time()
                if now - last_log >= 5:
                    pct = (copied / src_size * 100) if src_size else 0
                    log_msg(f"   ...复制进度 {copied / 1024 / 1024:.1f}/{src_size / 1024 / 1024:.1f} MB ({pct:.1f}%)")
                    last_log = now
            fdst.flush()
            os.fsync(fdst.fileno())      # 先保证落盘，再谈"成功"

        try:
            part_size = os.path.getsize(part)
        except OSError:
            part_size = -1
        if part_size != src_size:
            log_msg(f"❌ 复制大小不一致（{part_size} != {src_size}），放弃: {os.path.basename(src)}")
            try: os.remove(part)
            except Exception: pass
            return None

        if _file_md5(part) != h.hexdigest():
            log_msg(f"❌ 复制内容校验失败，放弃: {os.path.basename(src)}")
            try: os.remove(part)
            except Exception: pass
            return None

        try:
            shutil.copystat(src, part)
        except Exception:
            pass

        os.replace(part, dst)            # 原子顶替，目标名下永远只会出现完整文件
        try:
            os.remove(src)
        except Exception as e:
            log_msg(f"⚠️ 复制完成但源文件被占用，移动未完成（不通知删云端，下轮重试）: {e}")
            return None
        if os.path.exists(src):
            log_msg("⚠️ 源文件仍存在，移动未完成（不通知删云端）")
            return None

        log_msg(f"✅ 复制校验完成并已删除源文件: {os.path.basename(dst)}")
        return dst
    except Exception as e:
        log_msg(f"❌ 复制过程发生错误: {os.path.basename(src)} -> {e}")
        try:
            if os.path.exists(part):
                os.remove(part)
        except Exception:
            pass
        return None


def safe_move(src, dst, chunk_size=4 * 1024 * 1024):
    """移动文件，成功返回最终路径（失败/未完成返回 None）。
       顺序：原生移动 → 兜底安全复制。
       只有"目标校验通过 **且** 源已消失"才算成功；调用方据此才去通知删除云端副本。"""
    try:
        if not os.path.isfile(src):
            return None
        src_size = os.path.getsize(src)
        if src_size <= 0:
            log_msg(f"⚠️ 源文件大小为 0，跳过移动: {os.path.basename(src)}")
            return None

        dst_dir = os.path.dirname(os.path.abspath(dst)) or "."
        try:
            os.makedirs(dst_dir, exist_ok=True)
        except Exception:
            pass

        need_rename = False
        if os.path.exists(dst):
            if _same_content(src, dst):
                log_msg(f"ℹ️ 目标已存在且内容一致，删除源文件: {os.path.basename(src)}")
                try:
                    os.remove(src)
                except Exception as e:
                    log_msg(f"⚠️ 源文件被占用，无法删除: {e}")
                    return None
                return dst if not os.path.exists(src) else None
            need_rename = True

        # ★ 目标目录里已有内容完全相同的文件（不管叫什么名字）：
        #   直接删掉新下载的这份，视为"已移动完成"，省一次大文件写入；
        #   云端删除仍按新文件名走（调用方用的是 final_title，与本函数返回路径无关）。
        dup = _find_identical_in_dir(dst_dir, src, src_size, exclude=dst)
        if dup:
            log_msg(f"♻️ 目标目录已有相同内容（{os.path.basename(dup)}），直接删除新文件: {os.path.basename(src)}")
            try:
                os.remove(src)
            except Exception as e:
                log_msg(f"⚠️ 相同内容已存在，但新文件删不掉（下轮重试）: {e}")
                return None
            if os.path.exists(src):
                log_msg("⚠️ 新文件仍存在，视为未完成（不通知删云端）")
                return None
            return dup if not os.path.exists(src) else None

        if need_rename:
            dst = get_unique_filename(dst)
            log_msg(f"⚠️ 目标存在同名文件，自动重命名为: {os.path.basename(dst)}")

        log_msg(f"📦 移动: {os.path.basename(src)} ({src_size / 1024 / 1024:.1f} MB) -> {dst}")

        # ① 原生移动（同卷改名；跨卷由系统复制并写穿）
        if _native_move(src, dst):
            if _move_done(src, dst, src_size):
                log_msg(f"✅ 原生移动完成: {os.path.basename(dst)}")
                return dst
            log_msg("⚠️ 原生移动声称成功但校验不通过，回退安全复制")
            try:
                if os.path.exists(dst) and os.path.getsize(dst) != src_size and os.path.exists(src):
                    os.remove(dst)
            except Exception:
                pass

        # ② 兜底：安全复制
        return _copy_move(src, dst, src_size, chunk_size)
    except Exception as e:
        log_msg(f"❌ 移动异常: {os.path.basename(src)} -> {e}")
        return None

def cleanup_stale_parts(max_age_sec=3600):
    """清掉异常中断留下的 *.part（只在启动时跑，距离上次修改超过 max_age_sec 才删）"""
    try:
        if not os.path.isdir(TARGET_DIR):
            return
        now = time.time()
        for name in os.listdir(TARGET_DIR):
            if not name.lower().endswith(".part"):
                continue
            p = os.path.join(TARGET_DIR, name)
            try:
                if now - os.path.getmtime(p) < max_age_sec:
                    continue
                os.remove(p)
                log_msg(f"🧹 清理残留临时文件: {name}")
            except Exception:
                pass
    except Exception as e:
        log_msg(f"⚠️ 清理 .part 失败: {e}")


def get_db_file_signature():
    sig = {}
    for suffix in ['', '-wal', '-shm']:
        p = DB_PATH + suffix
        if os.path.exists(p):
            try:
                sig[p] = (os.path.getmtime(p), os.path.getsize(p))
            except OSError:
                pass
    return sig

def extract_filename_from_url(url):
    """从下载 URL 中提取真实文件名，兼容：
       - file:// 本地路径
       - ?filename=xxx 参数
       - ?response-content-disposition=... filename=xxx / filename*=utf-8''xxx  (夸克/OSS CDN 常见)
       - 路径 basename（带扩展名时兜底）
    """
    if not url:
        return ""
    try:
        parsed = urllib.parse.urlparse(url)

        # 1) file://
        if parsed.scheme == 'file':
            path = urllib.parse.unquote(parsed.path)
            if path.startswith('/') and sys.platform == 'win32':
                path = path[1:]
            return os.path.basename(path)

        # parse_qs 会自动 decode 一次
        query_params = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)

        # 2) 直接 filename=xxx
        if 'filename' in query_params and query_params['filename'][0]:
            return os.path.basename(query_params['filename'][0])

        # 3) response-content-disposition（此处需要再 unquote 一次，因为它本身被编码过）
        disp_raw = query_params.get('response-content-disposition', [None])[0]
        if disp_raw:
            disp = urllib.parse.unquote(disp_raw)
            # RFC 5987: filename*=utf-8''...
            m = re.search(r"filename\*\s*=\s*utf-8''([^;]+)", disp, re.IGNORECASE)
            if m:
                return os.path.basename(urllib.parse.unquote(m.group(1)).strip().strip('"'))
            # 普通 filename=
            m = re.search(r"filename\s*=\s*([^;]+)", disp, re.IGNORECASE)
            if m:
                return os.path.basename(urllib.parse.unquote(m.group(1)).strip().strip('"'))

        # 4) 兜底：路径 basename，必须带扩展名才返回，避免拿到纯 hash
        basename = os.path.basename(urllib.parse.unquote(parsed.path))
        if basename and '.' in basename and not basename.endswith('.'):
            return basename
    except Exception:
        pass
    return ""

def decode_binary_strings(binary_data):
    if not binary_data:
        return []
    try:
        # 该字段是 UTF-16-LE（小端），不是 BE
        decoded = binary_data.decode('utf-16-le', errors='ignore')
        matches = re.findall(r'[\u4e00-\u9fff a-zA-Z0-9_\-\.]{3,}', decoded)
        ignore_list = {'writeOffset', 'details', 'format', 'fps', 'contentType',
                       'application/pdf', 'lang', 'video', 'audio', 'mp4', 'jpg',
                       'png', 'filename', 'bitrate', 'width', 'height', 'type'}
        return [m.strip() for m in matches if m.strip().lower() not in ignore_list]
    except Exception:
        return []

def move_to_recycle_bin(filepath):
    if not os.path.exists(filepath):
        return False
    
    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR)
        ]

    FO_DELETE = 3
    FOF_ALLOWUNDO = 0x0040
    FOF_NOCONFIRMATION = 0x0010
    FOF_NOERRORUI = 0x0400
    FOF_SILENT = 0x0004

    fileop = SHFILEOPSTRUCTW()
    fileop.hwnd = None
    fileop.wFunc = FO_DELETE
    fileop.pFrom = os.path.abspath(filepath) + '\0'
    fileop.pTo = None
    fileop.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT

    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(fileop))
    return result == 0

def clean_torrent_files(directory, filename):
    if not filename or not directory:
        return
    
    base_name, ext = os.path.splitext(filename)
    if ext.lower() != '.torrent':
        base_name = filename
        ext = '.torrent'

    pattern = re.compile(rf"^{re.escape(base_name)}(?:\s*\(\d+\))?{re.escape(ext)}$", re.IGNORECASE)

    try:
        for f in os.listdir(directory):
            if pattern.match(f) and not is_temp_file(f):
                full_path = os.path.join(directory, f)
                if os.path.isfile(full_path):
                    if move_to_recycle_bin(full_path):
                        log_msg(f"🗑️ 已移入回收站: {f}")
                    else:
                        log_msg(f"❌ 移入回收站失败: {f}")
    except Exception as e:
        log_msg(f"清理种子文件时出错: {e}")

def process_db():
    if not os.path.exists(DB_PATH):
        log_throttled("db_missing", f"⚠️ 数据库文件不存在: {DB_PATH}")
        return

    conn = None
    try:
        conn = sqlite3.connect(DB_PATH, timeout=5)
        cursor = conn.cursor()

        cursor.execute(
            "SELECT id, url, webPageUrl, destinationPath, title, "
            "preferredFileTitle, files, preferredFileExt, creationTime, finishedTime "
            "FROM downloads"
        )
        rows = cursor.fetchall()
        log_throttled("db_read", f"📖 已读取 {len(rows)} 条下载记录")

        for idx, row in enumerate(rows, 1):
            task_id, url, web_page_url, dest_path, title, preferred_title, \
                files_raw, preferred_ext, creation_time, finished_time = row

            url = url or ""
            web_page_url = web_page_url or ""
            dest_path = dest_path or ""
            title = title or ""
            preferred_title = preferred_title or ""
            creation_time = creation_time or 0
            finished_time = finished_time or 0

            is_torrent = (".torrent" in url.lower()) or (".torrent" in web_page_url.lower())

            if is_torrent:
                if finished_time <= 0:
                    continue

                torrent_name = title or preferred_title or extract_filename_from_url(url)
                if not torrent_name:
                    continue

                torrent_dir = dest_path if dest_path else DEFAULT_DOWNLOAD_DIR
                task_key = f"torrent_{task_id}"
                if task_key in processed_ids:
                    continue

                log_msg(f"🔍 发现已完成种子任务 #{task_id}: {torrent_name}")
                torrent_stem = re.sub(r'\.torrent$', '', torrent_name, flags=re.IGNORECASE)

                media_exts = (".mp4", ".mkv", ".avi", ".mov", ".webm", ".flv", ".wmv",
                            ".pdf", ".zip", ".rar", ".7z", ".jpg", ".jpeg", ".png", ".txt")

                def _try_move(path, fname):
                    """尝试把单个文件移到 TARGET_DIR，返回是否成功"""
                    if not os.path.isfile(path) or is_temp_file(fname):
                        return False
                    if not any(fname.lower().endswith(ext) for ext in media_exts):
                        return False
                    dst = os.path.join(TARGET_DIR, os.path.basename(fname))
                    log_msg(f"➡️ 移动种子文件: {fname}")
                    return safe_move(path, dst)

                moved_any = False

                # ---------- 方案 1：从 files 字段解码 ----------
                actual_files = decode_binary_strings(files_raw) if files_raw else []
                if actual_files:
                    log_msg(f"   files 字段解码出 {len(actual_files)} 个候选字符串")

                for fname in actual_files:
                    candidates = [
                        os.path.join(torrent_dir, fname),
                        os.path.join(torrent_dir, os.path.basename(fname)),
                        os.path.join(torrent_dir, torrent_stem, fname),
                        os.path.join(torrent_dir, torrent_stem, os.path.basename(fname)),
                    ]
                    for c in candidates:
                        if os.path.exists(c):
                            if _try_move(c, os.path.basename(c)):
                                moved_any = True
                            break

                # ---------- 方案 2：兜底扫描目录，按 torrent 关键词匹配 ----------
                if not moved_any and os.path.isdir(torrent_dir):
                    tokens = [t for t in re.split(r'[\s\.\-_\[\]\(\)]+', torrent_stem)
                            if len(t) >= 5 and not t.isdigit()]
                    keywords = [t.lower() for t in tokens[:6]]
                    log_msg(f"   ⚠️ files 字段未解出可用文件，兜底扫描目录（关键词: {keywords}）")

                    try:
                        for entry in os.listdir(torrent_dir):
                            full = os.path.join(torrent_dir, entry)
                            if os.path.isdir(full):
                                # 子文件夹（多文件 torrent 常见）
                                for sub in os.listdir(full):
                                    if keywords and not any(k in sub.lower() for k in keywords):
                                        continue
                                    if _try_move(os.path.join(full, sub), sub):
                                        moved_any = True
                            else:
                                if keywords and not any(k in entry.lower() for k in keywords):
                                    continue
                                if _try_move(full, entry):
                                    moved_any = True
                    except Exception as e:
                        log_msg(f"   ❌ 兜底扫描失败: {e}")

                if not moved_any:
                    log_msg(f"   ⚠️ 种子任务 #{task_id} 未找到可移动的媒体文件，仅做种子清理")

                # ---------- 清理 .torrent ----------
                if not torrent_name.lower().endswith(".torrent"):
                    torrent_name += ".torrent"
                clean_torrent_files(torrent_dir, torrent_name)

                processed_ids.add(task_key)
                continue

            matched = False
            if URL_REGEX and (re.search(URL_REGEX, url, re.IGNORECASE)
                              or re.search(URL_REGEX, web_page_url, re.IGNORECASE)):
                matched = True
            if not matched and FILENAME_REGEX:
                check_title = title or preferred_title or extract_filename_from_url(url)
                if check_title and re.search(FILENAME_REGEX, check_title, re.IGNORECASE):
                    matched = True
            if not matched:
                continue
            if finished_time <= 0:
                continue

            final_title = title or preferred_title or extract_filename_from_url(url)
            if not final_title and files_raw:
                for s in decode_binary_strings(files_raw):
                    if any(s.lower().endswith(ext) for ext in
                           [".mp4", ".pdf", ".mkv", ".zip", ".rar", ".avi", ".jpg", ".png", ".txt"]):
                        final_title = s
                        break
            final_dir = dest_path if dest_path else DEFAULT_DOWNLOAD_DIR
            if not final_title:
                continue

            file_path = os.path.join(final_dir, final_title)
            if not os.path.exists(file_path) or is_temp_file(file_path):
                continue

            if task_id in processed_ids:
                try:
                    os.remove(file_path)
                    log_msg(f"🧹 已清理之前残留的源文件: {final_title}")
                except Exception:
                    pass
                continue

            dest_file = os.path.join(TARGET_DIR, final_title)
            log_msg(f"➡️ 处理任务 #{task_id}: {final_title}")
            final_path = safe_move(file_path, dest_file)
            if final_path:
                processed_ids.add(task_id)
                # 只有移动真正完成（目标校验通过、源已消失）才通知页面删云端；
                # 没完成就什么都不做，下一轮重试，绝不让"删除"跑在"移动"前面
                add_pending_delete(url, final_title)
            else:
                log_msg(f"⏸ 移动未完成，本轮不通知删除云端: {final_title}")

    except sqlite3.Error as e:
        log_msg(f"[数据库错误] {e}")
    finally:
        if conn:
            conn.close()

def main():
    # 放在 main() 开头
    import msvcrt
    _LOCK_PATH = os.path.join(BASE_DIR, "fdm_mover.lock")
    _lock_fp = open(_LOCK_PATH, "w")
    try:
        msvcrt.locking(_lock_fp.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        if sys.stdout:
            print("已有实例在运行，退出。")
        sys.exit(0)
    # 进程退出后文件句柄关闭，锁自动释放

    log_msg("=" * 60)
    log_msg(f"监控数据库: {DB_PATH}")
    log_msg(f"目标文件夹: {TARGET_DIR}")
    log_msg(f"日志文件绝对路径: {LOG_FILE}")
    log_msg(f"数据库存在: {os.path.exists(DB_PATH)}")
    log_msg(f"目标目录存在: {os.path.isdir(TARGET_DIR)}")
    log_msg("=" * 60)

    _start_bridge_server()
    cleanup_stale_parts()
    log_msg("执行首次扫描...")
    process_db()
    log_msg("首次扫描完成，进入监控循环。")
    last_sig = get_db_file_signature()
    last_force_scan_time = time.time()

    while True:
        try:
            time.sleep(1)
            current_sig = get_db_file_signature()
            current_time = time.time()

            if current_sig != last_sig or (current_time - last_force_scan_time >= FORCE_SCAN_INTERVAL):
                if current_sig != last_sig:
                    last_sig = current_sig
                
                process_db()
                last_force_scan_time = current_time
                
        except KeyboardInterrupt:
            log_msg("用户中断，退出。")
            break
        except Exception as e:
            log_msg(f"[监控异常] {e}")
            time.sleep(5)

if __name__ == "__main__":
    main()