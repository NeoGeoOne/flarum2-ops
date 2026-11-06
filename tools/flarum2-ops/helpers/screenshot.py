"""flarum2-ops screenshot matrix (Playwright, headless Chromium).

Reads a JSON request on stdin:
  {"base_url": "http://127.0.0.1:8080", "pages": ["/", "/all"],
   "schemes": ["light", "dark", "light-hc", "dark-hc"],
   "viewports": [1440, 390], "out_dir": "/abs/dir"}

For each page x scheme x viewport it captures a full-page PNG and records
console errors, failed requests (network errors and HTTP >= 400) and whether
Flarum's loading-error fallback is visible. Writes JSON to stdout.

Scheme handling: "light"/"dark" use prefers-color-scheme emulation (what a
guest with forum color_scheme=auto sees); "*-hc" variants force the
data-theme attribute on <html>, which is how Flarum switches its high-contrast
palettes. Read-only: it only loads pages as a guest.
"""

import json
import sys
import time


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"invalid JSON request: {exc}"}))
        return 1
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({
            "error": "python playwright is not installed for this interpreter "
                     f"({sys.executable}). Use a python3 that has Playwright or set FLARUM2_OPS_PYTHON."
        }))
        return 1

    base = req["base_url"].rstrip("/")
    pages = req.get("pages") or ["/"]
    schemes = req.get("schemes") or ["light", "dark"]
    viewports = req.get("viewports") or [1440, 390]
    out_dir = req["out_dir"]

    shots = []
    problems = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            for vw in viewports:
                for scheme in schemes:
                    emulate = "dark" if scheme.startswith("dark") else "light"
                    ctx = browser.new_context(
                        viewport={"width": vw, "height": 900 if vw > 600 else 844},
                        color_scheme=emulate,
                        device_scale_factor=1,
                        is_mobile=vw <= 600,
                        has_touch=vw <= 600,
                    )
                    page = ctx.new_page()
                    console_errors = []
                    failed = []
                    page.on("console", lambda m, ce=console_errors: ce.append(m.text[:300]) if m.type == "error" else None)
                    page.on("pageerror", lambda e, ce=console_errors: ce.append(f"pageerror: {str(e)[:300]}"))
                    page.on("requestfailed", lambda r, f=failed: f.append(f"{r.url[:200]} ({r.failure})"))
                    page.on("response", lambda r, f=failed: f.append(f"{r.url[:200]} -> {r.status}") if r.status >= 400 else None)
                    for path in pages:
                        console_errors.clear()
                        failed.clear()
                        url = base + path
                        try:
                            page.goto(url, wait_until="networkidle", timeout=45000)
                        except Exception as exc:  # noqa: BLE001 - report and continue
                            problems.append(f"{url} [{scheme} {vw}px]: navigation failed: {exc}")
                            continue
                        if scheme.endswith("-hc"):
                            page.evaluate("t => document.documentElement.setAttribute('data-theme', t)", scheme)
                        try:
                            page.wait_for_selector("#app .App, .App", timeout=15000)
                        except Exception:  # noqa: BLE001
                            problems.append(f"{url} [{scheme} {vw}px]: the Flarum app did not render")
                        time.sleep(0.4)
                        fallback_visible = page.evaluate(
                            """() => { const el = document.querySelector('#flarum-loading-error, .LoadingError');
                                       return !!el && el.offsetParent !== null; }"""
                        )
                        theme = page.evaluate("() => document.documentElement.getAttribute('data-theme')")
                        slug = path.strip("/").replace("/", "_") or "home"
                        name = f"{slug}__{scheme}__{vw}.png"
                        page.screenshot(path=f"{out_dir}/{name}", full_page=True)
                        entry = {
                            "file": name,
                            "url": url,
                            "scheme": scheme,
                            "data_theme": theme,
                            "viewport": vw,
                            "console_errors": list(console_errors),
                            "failed_requests": list(failed),
                            "loading_error_visible": bool(fallback_visible),
                        }
                        shots.append(entry)
                        if console_errors or failed or fallback_visible:
                            problems.append(f"{name}: {len(console_errors)} console error(s), {len(failed)} failed request(s)"
                                            + (", loading-error fallback visible" if fallback_visible else ""))
                    ctx.close()
        finally:
            browser.close()

    print(json.dumps({"out_dir": out_dir, "count": len(shots), "shots": shots, "problems": problems, "ok": not problems}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
