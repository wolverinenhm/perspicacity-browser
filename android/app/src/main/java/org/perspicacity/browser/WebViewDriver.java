package org.perspicacity.browser;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.webkit.WebView;

import org.json.JSONObject;
import org.json.JSONTokener;
import org.perspicacity.core.agent.AgentProtocol;
import org.perspicacity.core.agent.AgentRun;

import java.security.SecureRandom;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Lets the agent see and act on one Shadow tab's WebView. The agent never gets the DOM: it
 * gets the outline from SNAPSHOT (same as desktop/src/main/snapshot.js) with opaque handles
 * valid for one snapshot generation. Clicks are real touch events at the element's position
 * and typing goes through the editing pipeline, so pages see ordinary user input.
 *
 * Android WebView has no isolated worlds, so unlike desktop the handle table lives in the
 * page's own world under a random per-session name (documented in docs/IMPLEMENTATION.md).
 */
final class WebViewDriver implements AgentRun.Driver {
    interface TabAccess {
        WebView web();
        String url();
        int progress();
    }

    private static final long JS_TIMEOUT_MS = 10_000;
    private final TabAccess tab;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final String state;

    WebViewDriver(TabAccess tab) {
        this.tab = tab;
        byte[] r = new byte[8];
        new SecureRandom().nextBytes(r);
        StringBuilder b = new StringBuilder("__psp");
        for (byte x : r) b.append(String.format("%02x", x & 0xff));
        state = b.toString();
    }

    // ---- scripts (keep in sync with desktop/src/main/snapshot.js) ---------------------------
    private String snapshotScript() {
        return "(() => {\n"
                + "  const st = (window['" + state + "'] = window['" + state + "'] || { gen: 0, els: new Map() });\n"
                + "  st.gen += 1; st.els = new Map();\n"
                + "  const clean = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);\n"
                + "  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;\n"
                + "    const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };\n"
                + "  const roleOf = (el) => { const r = el.getAttribute('role'); if (r) return r; const t = el.tagName;\n"
                + "    if (t === 'A') return 'link'; if (t === 'BUTTON') return 'button'; if (t === 'SELECT') return 'combobox'; if (t === 'TEXTAREA') return 'textbox';\n"
                + "    if (t === 'INPUT') { const ty = (el.type || 'text').toLowerCase();\n"
                + "      return ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', search: 'searchbox', range: 'slider', file: 'file' })[ty] || 'textbox'; }\n"
                + "    if (el.isContentEditable) return 'textbox'; return 'generic'; };\n"
                + "  const nameOf = (el) => clean(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) ||\n"
                + "    el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||\n"
                + "    (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '') ||\n"
                + "    el.innerText || el.getAttribute('name') || '', 80);\n"
                + "  const sel = 'h1,h2,h3,a[href],button,input:not([type=hidden]),select,textarea,summary,' +\n"
                + "    '[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=\"\"],[contenteditable=true]';\n"
                + "  const lines = []; let n = 0;\n"
                + "  for (const el of document.querySelectorAll(sel)) {\n"
                + "    if (n >= 250) break; if (!visible(el)) continue;\n"
                + "    if (/^H[1-3]$/.test(el.tagName)) { const t = clean(el.innerText, 100); if (t) lines.push('#'.repeat(Number(el.tagName[1])) + ' ' + t); continue; }\n"
                + "    const id = 'e' + (++n); st.els.set(id, el); const role = roleOf(el);\n"
                + "    let line = '[' + id + '] ' + role + ' \"' + nameOf(el) + '\"';\n"
                + "    if (el.disabled) line += ' (disabled)';\n"
                + "    if (role === 'checkbox' || role === 'radio') line += el.checked ? ' (checked)' : ' (unchecked)';\n"
                + "    if (el.tagName === 'INPUT' && el.type === 'password') line += ' (password)';\n"
                + "    else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) line += ' value=\"' + clean(el.value, 40) + '\"';\n"
                + "    if (el.tagName === 'SELECT') line += ' options=[' + Array.from(el.options).slice(0, 8).map((o) => clean(o.text, 20)).join(' | ') + ']';\n"
                + "    if (el.tagName === 'A') { try { const u = new URL(el.href); line += ' -> ' + u.host + clean(u.pathname, 40); } catch (_) {} }\n"
                + "    lines.push(line);\n"
                + "  }\n"
                + "  return { gen: st.gen, url: location.href, title: clean(document.title, 120), outline: lines.join('\\n'),\n"
                + "    text: clean(document.body ? document.body.innerText : '', 3000), count: n };\n"
                + "})()";
    }

    private String withElement(int gen, String handle, String body) {
        return "(() => { const st = window['" + state + "'];\n"
                + "  if (!st || st.gen !== " + gen + ") return { error: 'stale' };\n"
                + "  const el = st.els.get(" + JSONObject.quote(handle) + ");\n"
                + "  if (!el || !el.isConnected) return { error: 'gone' };\n"
                + body + "\n})()";
    }

    private String locateScript(int gen, String handle) {
        return withElement(gen, handle,
                "  el.scrollIntoView({ block: 'center', inline: 'center' });\n"
                        + "  const r = el.getBoundingClientRect(); const vv = window.visualViewport || { offsetLeft: 0, offsetTop: 0, scale: 1 };\n"
                        + "  const k = vv.scale * (window.devicePixelRatio || 1);\n"
                        + "  return { x: (r.left + r.width / 2 - vv.offsetLeft) * k, y: (r.top + r.height / 2 - vv.offsetTop) * k, w: r.width, h: r.height };");
    }

    private String focusScript(int gen, String handle) {
        return withElement(gen, handle,
                "  el.focus();\n"
                        + "  if (typeof el.select === 'function') el.select();\n"
                        + "  else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }\n"
                        + "  return { ok: document.activeElement === el };");
    }

    private static String insertTextScript(String text) {
        return "(() => { const t = " + JSONObject.quote(text) + ";\n"
                + "  if (document.execCommand('insertText', false, t)) return { ok: true };\n"
                + "  const el = document.activeElement; if (!el || !('value' in el)) return { ok: false };\n"
                + "  el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));\n"
                + "  return { ok: true }; })()";
    }

    private String selectScript(int gen, String handle, String option) {
        return withElement(gen, handle,
                "  if (el.tagName !== 'SELECT') return { error: 'not a list' };\n"
                        + "  const want = " + JSONObject.quote(option) + ".trim().toLowerCase();\n"
                        + "  const opt = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === want) ||\n"
                        + "    Array.from(el.options).find((o) => o.text.trim().toLowerCase().includes(want));\n"
                        + "  if (!opt) return { error: 'no such option' };\n"
                        + "  el.focus(); el.value = opt.value;\n"
                        + "  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));\n"
                        + "  return { ok: true, chosen: opt.text };");
    }

    // ---- plumbing ---------------------------------------------------------------------------
    private interface UiCall<T> { T call() throws Exception; }

    private <T> T onMain(UiCall<T> c) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return c.call();
        AtomicReference<T> out = new AtomicReference<>();
        AtomicReference<Exception> err = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        main.post(() -> {
            try { out.set(c.call()); } catch (Exception e) { err.set(e); } finally { done.countDown(); }
        });
        if (!done.await(JS_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw new Exception("the page did not respond");
        if (err.get() != null) throw err.get();
        return out.get();
    }

    /** Runs a script in the tab and returns its JSON result as an object. */
    private JSONObject eval(String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        main.post(() -> {
            WebView w = tab.web();
            if (w == null) { done.countDown(); return; }
            w.evaluateJavascript(script, v -> { result.set(v); done.countDown(); });
        });
        if (!done.await(JS_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw new Exception("the page did not respond");
        String v = result.get();
        if (v == null || v.equals("null")) return new JSONObject();
        Object parsed = new JSONTokener(v).nextValue();
        return parsed instanceof JSONObject ? (JSONObject) parsed : new JSONObject();
    }

    private void waitForLoad(long maxMs) throws InterruptedException {
        long end = SystemClock.uptimeMillis() + maxMs;
        while (SystemClock.uptimeMillis() < end) {
            if (tab.progress() >= 100) return;
            Thread.sleep(150);
        }
    }

    // ---- Driver -----------------------------------------------------------------------------
    @Override
    public AgentProtocol.Snapshot snapshot() throws Exception {
        waitForLoad(15_000);
        JSONObject o = eval(snapshotScript());
        AgentProtocol.Snapshot s = new AgentProtocol.Snapshot();
        s.gen = o.optInt("gen", 0);
        s.url = o.optString("url", tab.url());
        s.title = o.optString("title", "");
        s.outline = o.optString("outline", "");
        s.text = o.optString("text", "");
        s.count = o.optInt("count", 0);
        s.handles = AgentProtocol.handlesFromOutline(s.outline);
        if (s.gen == 0) throw new Exception("could not read the page (is JavaScript on?)");
        return s;
    }

    @Override
    public String currentUrl() { return tab.url(); }

    @Override
    public String perform(AgentProtocol.Action act, int gen) throws Exception {
        switch (act.action) {
            case "click": {
                JSONObject loc = eval(locateScript(gen, act.id));
                if (loc.has("error")) throw new Exception("element " + act.id + " is " + loc.optString("error") + "; take a new look at the page");
                Thread.sleep(250); // let scrollIntoView settle
                loc = eval(locateScript(gen, act.id));
                if (loc.has("error")) throw new Exception("element " + act.id + " is " + loc.optString("error"));
                tap((float) loc.optDouble("x"), (float) loc.optDouble("y"));
                Thread.sleep(700);
                waitForLoad(15_000);
                return "clicked " + act.target;
            }
            case "type": {
                JSONObject f = eval(focusScript(gen, act.id));
                if (f.has("error")) throw new Exception("element " + act.id + " is " + f.optString("error"));
                onMain(() -> { tab.web().requestFocus(); return null; });
                JSONObject r = eval(insertTextScript(act.text));
                if (!r.optBoolean("ok")) throw new Exception("could not type into " + act.target);
                if (act.submit) {
                    onMain(() -> {
                        WebView w = tab.web();
                        long t = SystemClock.uptimeMillis();
                        w.dispatchKeyEvent(new KeyEvent(t, t, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0));
                        w.dispatchKeyEvent(new KeyEvent(t, t + 40, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER, 0));
                        return null;
                    });
                    Thread.sleep(700);
                    waitForLoad(15_000);
                }
                return "typed into " + act.target + (act.submit ? " and pressed Enter" : "");
            }
            case "select": {
                JSONObject r = eval(selectScript(gen, act.id, act.text));
                if (r.has("error")) throw new Exception("could not choose \"" + act.text + "\": " + r.optString("error"));
                return "chose " + r.optString("chosen", act.text);
            }
            case "navigate": {
                onMain(() -> { tab.web().loadUrl(act.url); return null; });
                Thread.sleep(500);
                waitForLoad(30_000);
                return "opened " + act.url;
            }
            case "scroll": {
                eval("window.scrollBy({ top: " + ("up".equals(act.direction) ? -1 : 1) + " * Math.round(innerHeight * 0.8), behavior: 'instant' }); ({ ok: true })");
                return "scrolled " + act.direction;
            }
            case "wait":
                Thread.sleep(1500);
                return "waited";
            default:
                return "nothing done";
        }
    }

    private void tap(float x, float y) throws Exception {
        final long t = SystemClock.uptimeMillis();
        touch(t, t, MotionEvent.ACTION_DOWN, x, y);
        Thread.sleep(70);
        touch(t, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y);
    }

    private void touch(long downTime, long eventTime, int action, float x, float y) throws Exception {
        onMain(() -> {
            MotionEvent e = MotionEvent.obtain(downTime, eventTime, action, x, y, 0);
            e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            tab.web().dispatchTouchEvent(e);
            e.recycle();
            return null;
        });
    }
}
