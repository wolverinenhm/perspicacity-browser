package org.perspicacity.browser;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.SystemClock;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.perspicacity.core.agent.Providers;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * On a real device/emulator WebView: a Shadow tab loads a form, the agent decides through the
 * real OpenAI-compatible provider client against a scripted local model, approvals are asked,
 * and the form is submitted with real (trusted) touch and editing input.
 */
@RunWith(AndroidJUnit4.class)
public class AgentEndToEndTest {
    private static final String FORM = "<!doctype html><html><head><title>form</title>"
            + "<meta name=viewport content='width=device-width,initial-scale=1'></head><body>"
            + "<h1>Contact</h1><form id=f><label>Name <input id=name name=name style='font-size:20px'></label> "
            + "<button id=go type=submit style='font-size:20px;padding:12px'>Send</button></form><script>"
            + "let trusted='untrusted';document.getElementById('go').addEventListener('click',e=>{trusted=e.isTrusted?'trusted':'untrusted';});"
            + "document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();"
            + "document.title='submitted:'+document.getElementById('name').value+':'+trusted;});</script></body></html>";

    /** Tiny HTTP/1.1 server: GET /form and POST /v1/chat/completions (scripted model). */
    static final class MiniServer implements Runnable {
        final ServerSocket socket;
        final List<JSONObject> chatRequests = Collections.synchronizedList(new ArrayList<>());
        final List<String> auth = Collections.synchronizedList(new ArrayList<>());
        int step;

        MiniServer() throws Exception {
            socket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(this, "mini-server");
            t.setDaemon(true);
            t.start();
        }

        int port() { return socket.getLocalPort(); }

        @Override public void run() {
            while (!socket.isClosed()) {
                try (Socket c = socket.accept()) { handle(c); } catch (Exception ignored) { }
            }
        }

        private void handle(Socket c) throws Exception {
            InputStream in = c.getInputStream();
            BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String request = r.readLine();
            if (request == null) return;
            int length = 0;
            String authorization = null;
            String line;
            while ((line = r.readLine()) != null && !line.isEmpty()) {
                String l = line.toLowerCase();
                if (l.startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                if (l.startsWith("authorization:")) authorization = line.substring(14).trim();
            }
            char[] body = new char[length];
            int got = 0;
            while (got < length) { int n = r.read(body, got, length - got); if (n < 0) break; got += n; }
            String type = "text/html";
            String out;
            if (request.startsWith("GET /form")) {
                out = FORM;
            } else if (request.startsWith("POST /v1/chat/completions")) {
                JSONObject req = new JSONObject(new String(body, 0, got));
                chatRequests.add(req);
                auth.add(authorization);
                JSONArray msgs = req.getJSONArray("messages");
                String user = msgs.getJSONObject(msgs.length() - 1).getString("content");
                out = new JSONObject().put("choices", new JSONArray().put(new JSONObject().put("message",
                        new JSONObject().put("role", "assistant").put("content", decide(user))))).toString();
                type = "application/json";
            } else {
                byte[] nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.UTF_8);
                c.getOutputStream().write(nf);
                return;
            }
            byte[] bytes = out.getBytes(StandardCharsets.UTF_8);
            OutputStream os = c.getOutputStream();
            os.write(("HTTP/1.1 200 OK\r\nContent-Type: " + type + "; charset=utf-8\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            os.write(bytes);
            os.flush();
        }

        private String decide(String page) throws Exception {
            JSONObject a = new JSONObject().put("thought", "").put("action", "done").put("id", "").put("text", "").put("submit", false)
                    .put("url", "").put("direction", "").put("answer", "");
            switch (step++) {
                case 0: a.put("action", "type").put("id", handle(page, "textbox \"Name")).put("text", "perspicacity"); break;
                case 1: a.put("action", "click").put("id", handle(page, "button \"Send\"")); break;
                default: a.put("answer", "Form sent.");
            }
            return a.toString();
        }

        private static String handle(String page, String what) {
            Matcher m = Pattern.compile("\\[(e\\d+)\\] " + Pattern.quote(what)).matcher(page);
            return m.find() ? m.group(1) : "e99";
        }
    }

    private static void waitFor(String what, long ms, java.util.function.BooleanSupplier ok) {
        long end = SystemClock.uptimeMillis() + ms;
        while (SystemClock.uptimeMillis() < end) {
            if (ok.getAsBoolean()) return;
            SystemClock.sleep(200);
        }
        throw new AssertionError("timed out waiting for " + what);
    }

    @Test
    public void agentSubmitsAFormInAShadowTab() throws Exception {
        Context ctx = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putBoolean("routeTor", false).commit();
        MiniServer server = new MiniServer();
        String base = "http://127.0.0.1:" + server.port();

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            AtomicReference<MainActivity.Tab> tab = new AtomicReference<>();
            AtomicReference<MainActivity> activity = new AtomicReference<>();
            scenario.onActivity(a -> {
                activity.set(a);
                Providers.Config cfg = new Providers.Config();
                cfg.provider = "custom";
                cfg.models.put("custom", "test-model");
                cfg.endpoints.put("custom", base + "/v1");
                a.agent().saveConfig(cfg);
                a.agent().setApiKey("custom", "test-key");
                MainActivity.Tab t = a.newTab(true);
                assertTrue("a Shadow tab opened", t != null && t.shadow);
                tab.set(t);
                a.navigate(t, base + "/form");
            });
            waitFor("the form to load", 30_000, () -> tab.get().progress >= 100 && "form".equals(tab.get().title));

            List<String> approvals = Collections.synchronizedList(new ArrayList<>());
            AtomicReference<String> startError = new AtomicReference<>("not started");
            scenario.onActivity(a -> startError.set(a.agent().start(tab.get(), "Send the contact form with the name perspicacity", false,
                    (description, action, site) -> { approvals.add(description); return true; }, new long[] {50, 100})));
            assertNull(startError.get());
            waitFor("the agent to finish", 90_000, () -> !activity.get().agent().running());

            String log = String.join("\n", activity.get().agent().log());
            assertEquals(log, "submitted:perspicacity:trusted", tab.get().title);
            assertEquals(log, 2, approvals.size());
            assertEquals(3, server.chatRequests.size());
            for (JSONObject req : server.chatRequests) {
                assertEquals("test-model", req.getString("model"));
                assertEquals("json_schema", req.getJSONObject("response_format").getString("type"));
            }
            assertEquals("Bearer test-key", server.auth.get(0));
            assertTrue(activity.get().agent().ledgerReport(), activity.get().agent().ledgerReport().startsWith("Chain verified"));
        } finally {
            server.socket.close();
            ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().remove("routeTor").commit();
        }
    }
}
