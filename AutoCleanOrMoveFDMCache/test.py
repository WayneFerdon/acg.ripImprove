# ----------------------------------------------------------------
# Author: WayneFerdon wayneferdon@hotmail.com
# Date: 2026-10-19 03:55:36
# LastEditors: WayneFerdon wayneferdon@hotmail.com
# LastEditTime: 2026-10-19 03:57:09
# FilePath: \undefinede:\Wayne Custaf Laqinoa Ferdon\OneDrive\OneDrive\Tools\AutoCleanOrMoveFDMCache\test.py
# ----------------------------------------------------------------
# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.
# ----------------------------------------------------------------

import urllib.parse, re, os, sys

def extract_filename_from_url(url):
    if not url: return ""
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme == 'file':
            path = urllib.parse.unquote(parsed.path)
            if path.startswith('/') and sys.platform == 'win32':
                path = path[1:]
            return os.path.basename(path)
        qp = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)
        if 'filename' in qp and qp['filename'][0]:
            return os.path.basename(qp['filename'][0])
        disp_raw = qp.get('response-content-disposition', [None])[0]
        if disp_raw:
            disp = urllib.parse.unquote(disp_raw)
            m = re.search(r"filename\*\s*=\s*utf-8''([^;]+)", disp, re.I)
            if m: return os.path.basename(urllib.parse.unquote(m.group(1)).strip().strip('"'))
            m = re.search(r"filename\s*=\s*([^;]+)", disp, re.I)
            if m: return os.path.basename(urllib.parse.unquote(m.group(1)).strip().strip('"'))
        b = os.path.basename(urllib.parse.unquote(parsed.path))
        if b and '.' in b and not b.endswith('.'): return b
    except Exception: pass
    return ""

url = r"""https://dl-pc-zb.pds.quark.cn/9yZ3oKvf/2776112341/573c77d2b97a42dab277de93653d51c56ad4ff42/6ad4ff42cd99c1405d2448e6aad4b3dcaff8fd1f?Expires=1792667747&OSSAccessKeyId=LTAI5tJJpWQEfrcKHnd1LqsZ&Signature=3QVuhflXdSEhjmTZqpU8%2B5R%2B480%3D&x-oss-traffic-limit=503316480&response-content-disposition=attachment%3B%20filename%3D%25E6%258B%259C%25E6%2589%2598%25E4%25BA%2586%25E5%2586%25B0%25E7%25AE%25B1%2520since%2520201493.mp4%3Bfilename%2A%3Dutf-8%27%27%25E6%258B%259C%25E6%2589%2598%25E4%25BA%2586%25E5%2586%25B0%25E7%25AE%25B1%2520since%2520201493.mp4&abt=8_0_&dfi=193"""

print("解析结果:", repr(extract_filename_from_url(url)))