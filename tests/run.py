#!/usr/bin/env python3
"""Runs the extension's tests in headless Chrome.

The suites are plain ES modules that import the real files in src/, so there is no
build step and no Node. This script serves the repo over a local HTTP server, opens
tests/runner.html in headless Chrome, and prints the results it posts back.

    python3 tests/run.py                 # all fast suites (a few seconds)
    python3 tests/run.py --ocr           # also run real OCR on sample floorplans (~1 min)
    python3 tests/run.py --suite queue   # one suite (repeatable)

Set CHROME=/path/to/chrome to use a different browser binary.
"""

import argparse
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests")
CACHE = os.path.join(TESTS, ".cache", "floorplans")

FAST_SUITES = ["extract", "listings", "pageModel", "estimate", "site", "queue"]
CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
]
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"


def find_chrome():
    if os.environ.get("CHROME"):
        return os.environ["CHROME"]
    for candidate in CHROME_CANDIDATES:
        path = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if path and os.path.exists(path):
            return path
    sys.exit("Could not find Chrome. Set CHROME=/path/to/chrome.")


def download_floorplans():
    """The OCR suite reads real floorplans; they're cached locally, not committed."""
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(TESTS, "fixtures", "floorplans.json")) as f:
        floorplans = json.load(f)
    for i, fp in enumerate(floorplans):
        target = os.path.join(CACHE, "%d.img" % i)
        if os.path.exists(target):
            continue
        print("  downloading floorplan %d/%d" % (i + 1, len(floorplans)))
        req = urllib.request.Request(fp["url"], headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as res, open(target, "wb") as out:
            out.write(res.read())


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(
        http.server.SimpleHTTPRequestHandler.extensions_map,
        **{".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}
    )
    results = None
    finished = threading.Event()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/results":
            Handler.results = json.loads(body)
            Handler.finished.set()
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ocr", action="store_true", help="also run real OCR on sample floorplans (slow)")
    parser.add_argument("--suite", action="append", help="run only this suite (repeatable)")
    parser.add_argument("--timeout", type=int, default=600, help="seconds before giving up")
    args = parser.parse_args()

    suites = args.suite or (FAST_SUITES + (["ocr"] if args.ocr else []))
    if "ocr" in suites:
        download_floorplans()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/tests/runner.html?suites=%s" % (server.server_port, ",".join(suites))

    profile = tempfile.mkdtemp(prefix="rmse-tests-")
    chrome = subprocess.Popen(
        [find_chrome(), "--headless=new", "--user-data-dir=" + profile, "--no-first-run",
         "--disable-gpu", "--hide-scrollbars", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        if not Handler.finished.wait(args.timeout):
            sys.exit("Timed out after %ds waiting for results." % args.timeout)
    finally:
        chrome.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    failed = 0
    total = 0
    for suite in Handler.results:
        print("\n%s" % suite["suite"])
        if suite.get("crash"):
            failed += 1
            print("  CRASH  %s" % suite["crash"])
        for r in suite.get("results", []):
            total += 1
            mark = "  ok   " if r["ok"] else "  FAIL "
            note = r.get("note") or r.get("error") or ""
            print("%s%s%s" % (mark, r["name"], ("  — " + note) if note else ""))
            failed += 0 if r["ok"] else 1

    print("\n%d passed, %d failed" % (total - failed, failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
