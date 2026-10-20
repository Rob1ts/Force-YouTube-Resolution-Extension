#!/usr/bin/env python3
"""End-to-end test for the packaged Firefox extension.

The test serves the same mock YouTube player used by the Chromium Playwright
test at http://www.youtube.com:<port>/. Firefox is configured through
network.dns.localDomains so the page keeps the real youtube.com hostname (and
therefore exercises the production manifest matches, host checks, and
world: "MAIN" content script exactly as shipped).

Requirements:
  - Firefox 128 or newer
  - geckodriver on PATH, or GECKODRIVER pointing to the executable
  - Selenium for Python (pip install selenium)

Usage:
  python test/firefox-e2e.py

Environment:
  FIREFOX_BINARY  Firefox executable (defaults to common install locations)
  GECKODRIVER     geckodriver executable (defaults to PATH)
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

try:
    from selenium import webdriver
    from selenium.common.exceptions import TimeoutException, WebDriverException
    from selenium.webdriver.firefox.options import Options
    from selenium.webdriver.firefox.service import Service
    from selenium.webdriver.support.ui import WebDriverWait
except ImportError:  # pragma: no cover - environment guidance
    print("Selenium for Python is required: pip install selenium", file=sys.stderr)
    raise SystemExit(2)

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "test" / "fixtures"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
XPI = ROOT / "dist" / f"force-youtube-resolution-firefox-{VERSION}.xpi"
ADDON_ID = "force-youtube-resolution@local"


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class FixtureHandler(SimpleHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlparse(self.path).path
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        filename = "watch.html" if path == "/watch" else "home.html"
        body = (FIXTURES / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if os.environ.get("YTMQ_VERBOSE"):
            print("  fixture:", fmt % args)


def find_firefox() -> str:
    explicit = os.environ.get("FIREFOX_BINARY")
    candidates = [
        explicit,
        r"C:\Program Files\Mozilla Firefox\firefox.exe",
        r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
        "/usr/bin/firefox",
        "/usr/local/bin/firefox",
        "/Applications/Firefox.app/Contents/MacOS/firefox",
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_file():
            return candidate
    found = shutil.which("firefox")
    if found:
        return found
    raise RuntimeError("Firefox was not found; set FIREFOX_BINARY.")


def find_geckodriver() -> str | None:
    explicit = os.environ.get("GECKODRIVER")
    candidates = [
        explicit,
        ROOT / "test-results" / "geckodriver" / "geckodriver.exe",
        ROOT / "test-results" / "geckodriver" / "geckodriver",
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_file():
            return str(candidate)
    return shutil.which("geckodriver")


def make_driver(firefox_binary: str, geckodriver: str | None):
    options = Options()
    options.binary_location = firefox_binary
    options.add_argument("-headless")
    # Required by Firefox 138+ before Marionette permits chrome context, which
    # this test uses only to discover the extension's temporary UUID.
    options.add_argument("-remote-allow-system-access")
    options.set_preference("network.dns.localDomains", "www.youtube.com,youtube.com")
    options.set_preference("network.proxy.type", 0)
    options.set_preference("network.dns.disableIPv6", True)
    options.set_preference("browser.startup.page", 0)
    options.set_preference("browser.startup.homepage", "about:blank")

    service = Service(executable_path=geckodriver) if geckodriver else Service()
    return webdriver.Firefox(service=service, options=options)


def wait_for(condition, timeout=20, interval=0.1, message="condition"):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            value = condition()
            if value:
                return value
        except WebDriverException as error:
            last_error = error
        time.sleep(interval)
    detail = f" (last error: {last_error})" if last_error else ""
    raise AssertionError(f"Timed out waiting for {message}{detail}")


def get_status(driver):
    return driver.execute_script(
        "return (window.__ytmqStatuses && window.__ytmqLastStatus) "
        "? window.__ytmqLastStatus() : null;"
    )


def wait_for_status(driver, expected, timeout=20):
    def check():
        status = get_status(driver)
        if status and all(status.get(key) == value for key, value in expected.items()):
            return status
        return None

    return wait_for(check, timeout, message=f"status {expected}")


def get_calls(driver):
    return driver.execute_script("return window.__ytmqCalls ? window.__ytmqCalls.slice() : [];")


def range_calls(driver, quality):
    return [call for call in get_calls(driver)
            if call.get("type") == "range" and call.get("min") == quality and call.get("max") == quality]


def wait_for_range_call(driver, quality, timeout=20):
    return wait_for(lambda: range_calls(driver, quality), timeout,
                    message=f"setPlaybackQualityRange({quality}, {quality})")


def wait_for_quality(driver, quality, timeout=20):
    return wait_for(lambda: driver.execute_script("return window.__ytmqQuality;") == quality,
                    timeout, message=f"playback quality {quality}")


def wait_for_storage(driver, expected, timeout=10):
    script = """
        const wanted = arguments[0];
        const done = arguments[arguments.length - 1];
        browser.storage.local.get(null).then((stored) => {
            done(Object.entries(wanted).every(([key, value]) => stored[key] === value));
        }).catch(() => done(false));
    """

    def check():
        return driver.execute_async_script(script, expected)

    return wait_for(check, timeout, message=f"stored settings {expected}")


def set_quality_in_popup(driver, quality):
    driver.execute_script(
        """
        const select = document.getElementById('quality');
        if (!select) throw new Error('quality select is missing');
        select.value = arguments[0];
        if (select.value !== arguments[0]) throw new Error('quality option is missing');
        select.dispatchEvent(new Event('change', { bubbles: true }));
        """,
        quality,
    )
    wait_for_storage(driver, {"maxQuality": quality})


def set_enabled_in_popup(driver, enabled):
    checked = driver.execute_script(
        "return document.getElementById('toggle').getAttribute('aria-checked') === 'true';"
    )
    if checked != enabled:
        driver.find_element("id", "toggle").click()
    wait_for_storage(driver, {"enabled": enabled})


def switch_to(driver, handle):
    driver.switch_to.window(handle)


def discover_extension_uuid(driver, timeout=15):
    def lookup():
        try:
            driver.set_context("chrome")
            result = driver.execute_script(
                """
                const policy = WebExtensionPolicy.getByID(arguments[0]);
                return policy ? { uuid: policy.mozExtensionHostname, active: policy.active } : null;
                """,
                ADDON_ID,
            )
            return result if result and result.get("uuid") and result.get("active") else None
        finally:
            driver.set_context("content")

    return wait_for(lookup, timeout, message="temporary extension UUID")


def run():
    if not XPI.is_file():
        raise SystemExit(f"Missing {XPI}; run npm run build first.")

    firefox_binary = find_firefox()
    geckodriver = find_geckodriver()
    server = FixtureServer(("127.0.0.1", 0), FixtureHandler)
    port = server.server_address[1]
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    print(f"Firefox: {firefox_binary}")
    print(f"geckodriver: {geckodriver or 'PATH'}")
    print(f"Mock YouTube: http://www.youtube.com:{port}/")

    driver = make_driver(firefox_binary, geckodriver)
    try:
        driver.set_script_timeout(10)
        driver.install_addon(str(XPI), temporary=True)
        extension = discover_extension_uuid(driver)
        print(f"Extension UUID: {extension['uuid']}")

        popup_handle = driver.current_window_handle
        driver.get(f"moz-extension://{extension['uuid']}/popup.html")
        wait_for(lambda: driver.execute_script(
            f"return document.getElementById('version').textContent === 'v{VERSION}';"
        ), message="popup to initialize")
        wait_for(lambda: driver.execute_script(
            "return document.getElementById('statusCard').dataset.state;"
        ) == "inactive", message="popup disconnected state")

        print("1. Popup settings persisted through the extension storage API")
        set_quality_in_popup(driver, "1080")
        set_enabled_in_popup(driver, True)

        print("2. Main-world script receives config and forces 1080p")
        driver.switch_to.new_window("tab")
        video_handle = driver.current_window_handle
        driver.get(f"http://www.youtube.com:{port}/watch?v=TESTVIDEO01")
        wait_for_range_call(driver, "hd1080")
        wait_for_quality(driver, "hd1080")
        wait_for_status(driver, {
            "state": "active",
            "targetQuality": "hd1080",
            "preference": "1080",
            "videoId": "TESTVIDEO01",
        })

        print("3. Manual quality changes are overridden")
        before = len(get_calls(driver))
        driver.execute_script("window.__ytmqSetQuality('hd720');")
        wait_for_quality(driver, "hd1080")
        assert len(get_calls(driver)) > before

        # Real YouTube does not emit yt-player-quality-changed reliably. The
        # watchdog must recover after a silent change to automatic quality.
        before = len(get_calls(driver))
        driver.execute_script("window.__ytmqSetQuality('auto', false);")
        wait_for_quality(driver, "hd1080")
        assert len(get_calls(driver)) > before
        wait_for_status(driver, {"state": "active", "targetQuality": "hd1080"})

        print("4. Ads are left alone and quality is restored afterwards")
        driver.execute_script(
            "window.__ytmqSetAd(true); window.__ytmqSetQuality('large');"
        )
        time.sleep(1.0)
        assert driver.execute_script("return window.__ytmqQuality;") == "large"
        wait_for_status(driver, {"state": "waiting", "reason": "ad"})
        driver.execute_script("window.__ytmqSetAd(false);")
        wait_for_quality(driver, "hd1080")
        wait_for_status(driver, {"state": "active", "targetQuality": "hd1080"})

        print("5. An unavailable cap reports fallback instead of failing")
        driver.execute_script(
            "window.__ytmqSetAvailable(['hd1080', 'hd720', 'large', 'medium']);"
        )
        switch_to(driver, popup_handle)
        set_quality_in_popup(driver, "1440")
        switch_to(driver, video_handle)
        wait_for_range_call(driver, "hd1080")
        wait_for_status(driver, {
            "state": "fallback",
            "targetQuality": "hd1080",
            "preference": "1440",
            "reason": "preference-unavailable",
        })

        # Restore the full quality list and a 1080p cap for the toggle test.
        driver.execute_script("""
            window.__ytmqSetAvailable([
                'auto', 'highres', 'hd2160', 'hd1440', 'hd1080', 'hd720',
                'large', 'medium', 'small', 'tiny'
            ]);
        """)
        switch_to(driver, popup_handle)
        set_quality_in_popup(driver, "1080")
        switch_to(driver, video_handle)
        wait_for_quality(driver, "hd1080")
        wait_for_status(driver, {"state": "active", "targetQuality": "hd1080"})

        print("6. Disabling stops all forcing and re-enabling restores it")
        switch_to(driver, popup_handle)
        set_enabled_in_popup(driver, False)
        switch_to(driver, video_handle)
        wait_for_status(driver, {"state": "disabled", "enabled": False})
        before = len([c for c in get_calls(driver) if c.get("type") in ("range", "set")])
        driver.execute_script("window.__ytmqSetQuality('hd720');")
        time.sleep(1.2)
        assert driver.execute_script("return window.__ytmqQuality;") == "hd720"
        after = len([c for c in get_calls(driver) if c.get("type") in ("range", "set")])
        assert after == before, "disabled extension must not call the player"

        switch_to(driver, popup_handle)
        set_enabled_in_popup(driver, True)
        switch_to(driver, video_handle)
        wait_for_quality(driver, "hd1080")
        wait_for_status(driver, {
            "state": "active", "enabled": True, "targetQuality": "hd1080"
        })

        print("7. SPA navigation is detected and the new video is forced")
        driver.execute_script("window.__ytmqNavigate('/watch?v=SECONDVIDEO');")
        wait_for_status(driver, {"videoId": "SECONDVIDEO"})
        wait_for_quality(driver, "hd1080")

        print("8. Leaving the video page pauses forcing")
        driver.execute_script("window.__ytmqNavigate('/');")
        wait_for_status(driver, {"state": "inactive", "reason": "not-video"})

        print("9. Invalid storage values are sanitized back to the default")
        driver.execute_script("window.__ytmqNavigate('/watch?v=THIRDVIDEO1');")
        wait_for_quality(driver, "hd1080")
        switch_to(driver, popup_handle)
        driver.execute_script(
            "return browser.storage.local.set({ maxQuality: '\"><img src=x onerror=alert(1)>' });"
        )
        switch_to(driver, video_handle)
        wait_for_range_call(driver, "highres")
        wait_for_quality(driver, "highres")
        wait_for_status(driver, {
            "state": "active",
            "targetQuality": "highres",
            "preference": "highest",
        })

        renderer_errors = driver.execute_script(
            "return Array.isArray(window.__ytmqErrors) ? window.__ytmqErrors : [];"
        )
        assert renderer_errors == [], f"page errors: {renderer_errors}"

        print("\nFirefox E2E passed: popup storage -> content bridge -> MAIN-world "
              "player control, ads, fallback, toggle, navigation, sanitization.")
    finally:
        try:
            driver.quit()
        except Exception:
            pass
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    try:
        run()
    except (AssertionError, TimeoutException, RuntimeError) as error:
        print(f"\nFirefox E2E failed: {error}", file=sys.stderr)
        raise SystemExit(1)
