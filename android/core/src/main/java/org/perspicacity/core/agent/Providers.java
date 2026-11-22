package org.perspicacity.core.agent;

import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Model providers for the agent (mirror of desktop/src/main/providers.js; keep in sync).
 *
 * One OpenAI Chat Completions client covers OpenAI, Gemini, DeepSeek, Kimi, Qwen, Mistral,
 * xAI, GLM, Groq, Together, OpenRouter, LM Studio and custom endpoints; Ollama and Anthropic
 * use their own HTTP APIs. Each provider starts at the strongest structured-output mode it
 * supports and steps down (json_schema, json_object, prompt-only) when the server rejects it.
 * Whatever comes back is validated again by AgentProtocol.validate().
 */
public final class Providers {
    private Providers() { }

    public static final int REQUEST_TIMEOUT_MS = 120_000;
    public static final String ANTHROPIC_VERSION = "2026-10-21";

    public static final class Provider {
        public final String id, name, kind, endpoint, model, format, keyHint, hint;
        public final boolean local, needsKey, temperature;

        Provider(String id, String name, String kind, boolean local, boolean needsKey, String endpoint, String model,
                 String format, boolean temperature, String keyHint, String hint) {
            this.id = id; this.name = name; this.kind = kind; this.local = local; this.needsKey = needsKey;
            this.endpoint = endpoint; this.model = model; this.format = format; this.temperature = temperature;
            this.keyHint = keyHint; this.hint = hint;
        }

        /** Name without the parenthesised detail, for compact labels. */
        public String shortName() { int i = name.indexOf(" ("); return i > 0 ? name.substring(0, i) : name; }
    }

    private static final Map<String, Provider> MAP = new LinkedHashMap<>();
    private static void add(Provider p) { MAP.put(p.id, p); }
    static {
        add(new Provider("ollama", "Ollama (on your network)", "ollama", true, false, "", "llama3.1", null, false, "",
                "Private: runs on your own computer. Set the endpoint to that computer's address on your Wi-Fi, e.g. http://192.168.1.10:11434 (start Ollama with OLLAMA_HOST=0.0.0.0)."));
        add(new Provider("lmstudio", "LM Studio (on your network)", "openai", true, false, "", "", "json_schema", false, "",
                "Private: start the LM Studio server on your computer with network access on, set the endpoint to e.g. http://192.168.1.10:1234/v1, then pick a model with List models."));
        add(new Provider("anthropic", "Claude (Anthropic)", "anthropic", false, true, "https://api.anthropic.com", "claude-opus-5-5", null, false, "sk-ant-...",
                "Get a key at console.anthropic.com."));
        add(new Provider("openai", "OpenAI (ChatGPT models)", "openai", false, true, "https://api.openai.com/v1", "gpt-5-mini", "json_schema", false, "sk-...",
                "Get a key at platform.openai.com."));
        add(new Provider("gemini", "Google Gemini", "openai", false, true, "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash", "json_schema", false, "AIza...",
                "Get a key at aistudio.google.com."));
        add(new Provider("deepseek", "DeepSeek", "openai", false, true, "https://api.deepseek.com/v1", "deepseek-chat", "json_object", true, "sk-...",
                "Get a key at platform.deepseek.com."));
        add(new Provider("kimi", "Kimi (Moonshot AI)", "openai", false, true, "https://api.moonshot.ai/v1", "kimi-k2-0905-preview", "json_object", true, "sk-...",
                "Get a key at platform.moonshot.ai. Mainland China accounts: set the endpoint to https://api.moonshot.cn/v1."));
        add(new Provider("qwen", "Qwen (Alibaba Cloud Model Studio)", "openai", false, true, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen-plus", "json_object", true, "sk-...",
                "Get a key in Alibaba Cloud Model Studio. Mainland China accounts: set the endpoint to https://dashscope.aliyuncs.com/compatible-mode/v1."));
        add(new Provider("mistral", "Mistral AI", "openai", false, true, "https://api.mistral.ai/v1", "mistral-medium-latest", "json_schema", true, "",
                "Get a key at console.mistral.ai."));
        add(new Provider("xai", "xAI (Grok)", "openai", false, true, "https://api.x.ai/v1", "grok-4", "json_schema", false, "xai-...",
                "Get a key at console.x.ai."));
        add(new Provider("glm", "GLM (Zhipu / Z.ai)", "openai", false, true, "https://api.z.ai/api/paas/v4", "glm-4.6", "json_object", true, "",
                "Get a key at z.ai. Mainland China accounts: set the endpoint to https://open.bigmodel.cn/api/paas/v4."));
        add(new Provider("groq", "Groq", "openai", false, true, "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", "json_object", true, "gsk_...",
                "Get a key at console.groq.com."));
        add(new Provider("together", "Together AI", "openai", false, true, "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "json_object", true, "",
                "Get a key at api.together.ai."));
        add(new Provider("openrouter", "OpenRouter (hundreds of models)", "openai", false, true, "https://openrouter.ai/api/v1", "openai/gpt-5-mini", "json_object", false, "sk-or-...",
                "One key for models from many companies. Get it at openrouter.ai."));
        add(new Provider("custom", "Custom (any OpenAI-compatible API)", "openai", false, false, "", "", "json_schema", false, "",
                "Enter the base URL that ends before /chat/completions, for example https://host/v1. A key is optional."));
    }

    public static List<Provider> all() { return Collections.unmodifiableList(new ArrayList<>(MAP.values())); }
    public static Provider get(String id) { return MAP.get(id); }
    public static boolean exists(String id) { return id != null && MAP.containsKey(id); }

    /** The user's choice for the agent model. Empty strings mean "provider default". */
    public static final class Config {
        public String provider = "ollama";
        public final Map<String, String> models = new LinkedHashMap<>();
        public final Map<String, String> endpoints = new LinkedHashMap<>();

        public String endpoint(String id) {
            String e = endpoints.get(id);
            e = e == null ? "" : e.trim();
            if (e.isEmpty()) e = MAP.get(id).endpoint;
            while (e.endsWith("/")) e = e.substring(0, e.length() - 1);
            return e;
        }

        public String model(String id) {
            String m = models.get(id);
            m = m == null ? "" : m.trim();
            return m.isEmpty() ? MAP.get(id).model : m;
        }
    }

    /** Accepts only plain http(s) URLs without credentials; returns "" for anything else. */
    public static String cleanEndpoint(String raw) {
        String e = raw == null ? "" : raw.trim();
        if (e.isEmpty()) return "";
        try {
            URI u = new URI(e);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            if (!(scheme.equals("http") || scheme.equals("https")) || u.getHost() == null || u.getUserInfo() != null) return "";
        } catch (Exception ex) {
            return "";
        }
        while (e.endsWith("/")) e = e.substring(0, e.length() - 1);
        return e;
    }

    public interface Decider {
        /** Returns the model's raw reply for one step. */
        String decide(String userMessage) throws Exception;
    }

    public static final class ProviderException extends Exception {
        public ProviderException(String m) { super(m); }
    }

    private static final String[] FORMATS = {"json_schema", "json_object", "none"};
    private static final Map<String, String> LEARNED = new ConcurrentHashMap<>();

    static void forgetLearnedFormats() { LEARNED.clear(); }

    public static Decider decider(Config cfg, String apiKey, Http http) {
        final String id = exists(cfg.provider) ? cfg.provider : "ollama";
        final Provider p = MAP.get(id);
        switch (p.kind) {
            case "ollama": return msg -> callOllama(cfg, msg, http);
            case "anthropic": return msg -> callAnthropic(cfg, apiKey, msg, http);
            default: return msg -> callOpenAICompatible(id, cfg, apiKey, msg, http);
        }
    }

    private static Http.Response request(Provider p, Http http, String method, String url, Map<String, String> headers, String body, int timeoutMs)
            throws ProviderException {
        try {
            return http.send(method, url, headers, body, timeoutMs);
        } catch (IOException e) {
            String host = url;
            try { host = new URI(url).getAuthority(); } catch (Exception ignored) { }
            String why = e.getClass().getSimpleName() + (e.getMessage() != null ? ": " + e.getMessage() : "");
            throw new ProviderException("Could not reach " + p.name + " at " + host + " (" + why + "). Check your connection and the endpoint.");
        }
    }

    static ProviderException httpError(Provider p, Http.Response r, String model) {
        String detail = "";
        try {
            JSONObject j = new JSONObject(r.body);
            Object err = j.opt("error");
            if (err instanceof JSONObject) detail = ((JSONObject) err).optString("message", err.toString());
            else if (err != null) detail = String.valueOf(err);
            else detail = j.optString("message", j.optString("detail", ""));
        } catch (JSONException e) {
            detail = r.body.length() > 200 ? r.body.substring(0, 200) : r.body;
        }
        if (detail.length() > 300) detail = detail.substring(0, 300);
        String hint = r.status == 401 || r.status == 403 ? " Check the API key in Settings."
                : r.status == 404 ? " Check the model name (\"" + model + "\") and endpoint."
                : r.status == 429 ? " Rate limited or out of credit." : "";
        return new ProviderException(p.name + " returned HTTP " + r.status + (detail.isEmpty() ? "" : ": " + detail) + "." + hint);
    }

    private static boolean looksLikeFormatError(Http.Response r) {
        return (r.status == 400 || r.status == 422 || r.status == 404 || r.status == 501)
                && r.body.matches("(?is).*(response_format|json_schema|json_object|structured|schema|format).*");
    }

    static String callOpenAICompatible(String id, Config cfg, String apiKey, String userMessage, Http http) throws Exception {
        Provider p = MAP.get(id);
        String base = cfg.endpoint(id);
        String model = cfg.model(id);
        if (base.isEmpty()) throw new ProviderException(p.name + ": set the endpoint URL in Settings.");
        if (model.isEmpty()) throw new ProviderException(p.name + ": choose a model in Settings (List models shows what is available).");
        if (p.needsKey && (apiKey == null || apiKey.isEmpty())) throw new ProviderException("No " + p.name + " API key saved. Add one in Settings.");

        String cacheKey = id + "|" + base + "|" + model;
        String startMode = LEARNED.containsKey(cacheKey) ? LEARNED.get(cacheKey) : (p.format != null ? p.format : "json_object");
        int start = 1;
        for (int i = 0; i < FORMATS.length; i++) if (FORMATS[i].equals(startMode)) start = i;

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json");
        if (apiKey != null && !apiKey.isEmpty()) headers.put("Authorization", "Bearer " + apiKey);
        if (id.equals("openrouter")) headers.put("X-Title", "Perspicacity");

        for (int i = start; i < FORMATS.length; i++) {
            String mode = FORMATS[i];
            String system = mode.equals("json_schema") ? AgentProtocol.SYSTEM_PROMPT : AgentProtocol.SYSTEM_PROMPT + "\n" + AgentProtocol.SCHEMA_REMINDER;
            JSONObject body = new JSONObject();
            body.put("model", model);
            body.put("stream", false);
            body.put("messages", new JSONArray()
                    .put(new JSONObject().put("role", "system").put("content", system))
                    .put(new JSONObject().put("role", "user").put("content", userMessage)));
            if (p.temperature) body.put("temperature", 0.1);
            if (mode.equals("json_schema")) {
                body.put("response_format", new JSONObject().put("type", "json_schema").put("json_schema",
                        new JSONObject().put("name", "agent_action").put("strict", true).put("schema", new JSONObject(AgentProtocol.SCHEMA_JSON))));
            } else if (mode.equals("json_object")) {
                body.put("response_format", new JSONObject().put("type", "json_object"));
            }
            Http.Response r = request(p, http, "POST", base + "/chat/completions", headers, body.toString(), REQUEST_TIMEOUT_MS);
            if (!r.ok()) {
                if (i < FORMATS.length - 1 && looksLikeFormatError(r)) continue;
                throw httpError(p, r, model);
            }
            JSONObject data;
            try { data = new JSONObject(r.body); } catch (JSONException e) { throw new ProviderException(p.name + " sent a reply that is not JSON."); }
            JSONArray choices = data.optJSONArray("choices");
            JSONObject msg = choices != null && choices.length() > 0 ? choices.getJSONObject(0).optJSONObject("message") : null;
            if (msg != null && !msg.isNull("refusal") && !msg.optString("refusal", "").isEmpty()) throw new ProviderException("The model declined this step.");
            LEARNED.put(cacheKey, mode);
            return AgentProtocol.extractJson(messageText(msg));
        }
        throw new ProviderException(p.name + " rejected every output format.");
    }

    private static String messageText(JSONObject msg) {
        if (msg == null) return "";
        Object c = msg.opt("content");
        if (c instanceof String) return (String) c;
        if (c instanceof JSONArray) {
            StringBuilder b = new StringBuilder();
            JSONArray a = (JSONArray) c;
            for (int i = 0; i < a.length(); i++) {
                Object part = a.opt(i);
                if (part instanceof String) b.append(part);
                else if (part instanceof JSONObject) b.append(((JSONObject) part).optString("text", ""));
            }
            return b.toString();
        }
        return "";
    }

    static String callOllama(Config cfg, String userMessage, Http http) throws Exception {
        Provider p = MAP.get("ollama");
        String base = cfg.endpoint("ollama");
        String model = cfg.model("ollama");
        if (base.isEmpty()) throw new ProviderException("Ollama: set the endpoint to your computer's address in Settings, e.g. http://192.168.1.10:11434.");
        JSONObject body = new JSONObject()
                .put("model", model)
                .put("stream", false)
                .put("format", new JSONObject(AgentProtocol.SCHEMA_JSON))
                .put("options", new JSONObject().put("temperature", 0.1))
                .put("messages", new JSONArray()
                        .put(new JSONObject().put("role", "system").put("content", AgentProtocol.SYSTEM_PROMPT))
                        .put(new JSONObject().put("role", "user").put("content", userMessage)));
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json");
        Http.Response r = request(p, http, "POST", base + "/api/chat", headers, body.toString(), REQUEST_TIMEOUT_MS);
        if (!r.ok()) throw new ProviderException("Ollama returned HTTP " + r.status + ". Is it running at " + base + " with model \"" + model + "\" pulled, and reachable from this phone?");
        JSONObject data = new JSONObject(r.body);
        JSONObject msg = data.optJSONObject("message");
        return msg == null ? "" : AgentProtocol.extractJson(msg.optString("content", ""));
    }

    /** Anthropic Messages API (raw HTTP; see docs/IMPLEMENTATION.md for why not the SDK). */
    static String callAnthropic(Config cfg, String apiKey, String userMessage, Http http) throws Exception {
        Provider p = MAP.get("anthropic");
        if (apiKey == null || apiKey.isEmpty()) throw new ProviderException("No Anthropic API key saved. Add one in Settings.");
        String model = cfg.model("anthropic");
        JSONObject body = new JSONObject()
                .put("model", model)
                .put("max_tokens", 16000)
                .put("fallbacks", "default")
                .put("output_config", new JSONObject()
                        .put("effort", "low")
                        .put("format", new JSONObject().put("type", "json_schema").put("schema", new JSONObject(AgentProtocol.SCHEMA_JSON))))
                .put("system", AgentProtocol.SYSTEM_PROMPT)
                .put("messages", new JSONArray().put(new JSONObject().put("role", "user").put("content", userMessage)));
        Map<String, String> headers = anthropicHeaders(apiKey);
        headers.put("Content-Type", "application/json");
        headers.put("anthropic-beta", "server-side-fallback-2026-07-01");
        Http.Response r = request(p, http, "POST", cfg.endpoint("anthropic") + "/v1/messages", headers, body.toString(), REQUEST_TIMEOUT_MS);
        if (!r.ok()) throw httpError(p, r, model);
        JSONObject data = new JSONObject(r.body);
        if ("refusal".equals(data.optString("stop_reason"))) throw new ProviderException("The model declined this step.");
        StringBuilder text = new StringBuilder();
        JSONArray content = data.optJSONArray("content");
        if (content != null) {
            for (int i = 0; i < content.length(); i++) {
                JSONObject b = content.optJSONObject(i);
                if (b != null && "text".equals(b.optString("type"))) text.append(b.optString("text", ""));
            }
        }
        return AgentProtocol.extractJson(text.toString());
    }

    private static Map<String, String> anthropicHeaders(String apiKey) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("x-api-key", apiKey);
        h.put("anthropic-version", ANTHROPIC_VERSION);
        return h;
    }

    /** Model ids the provider offers, for the settings picker. */
    public static List<String> listModels(String id, Config cfg, String apiKey, Http http) throws Exception {
        Provider p = MAP.get(id);
        if (p == null) throw new ProviderException("unknown provider");
        if (p.needsKey && (apiKey == null || apiKey.isEmpty())) throw new ProviderException("Save a " + p.name + " API key first.");
        String base = cfg.endpoint(id);
        if (base.isEmpty()) throw new ProviderException("Set the endpoint URL first.");
        List<String> out = new ArrayList<>();
        Http.Response r;
        switch (p.kind) {
            case "ollama": {
                r = request(p, http, "GET", base + "/api/tags", new LinkedHashMap<>(), null, 20_000);
                if (!r.ok()) throw new ProviderException("Ollama returned HTTP " + r.status + ". Is it running at " + base + "?");
                JSONArray models = new JSONObject(r.body).optJSONArray("models");
                if (models != null) for (int i = 0; i < models.length(); i++) {
                    JSONObject m = models.optJSONObject(i);
                    if (m != null) { String n = m.optString("name", m.optString("model", "")); if (!n.isEmpty()) out.add(n); }
                }
                break;
            }
            case "anthropic": {
                r = request(p, http, "GET", base + "/v1/models?limit=100", anthropicHeaders(apiKey), null, 20_000);
                if (!r.ok()) throw httpError(p, r, "");
                JSONArray data = new JSONObject(r.body).optJSONArray("data");
                if (data != null) for (int i = 0; i < data.length(); i++) {
                    JSONObject m = data.optJSONObject(i);
                    if (m != null && !m.optString("id", "").isEmpty()) out.add(m.optString("id"));
                }
                break;
            }
            default: {
                Map<String, String> headers = new LinkedHashMap<>();
                if (apiKey != null && !apiKey.isEmpty()) headers.put("Authorization", "Bearer " + apiKey);
                r = request(p, http, "GET", base + "/models", headers, null, 20_000);
                if (!r.ok()) throw httpError(p, r, "");
                JSONArray list;
                String t = r.body.trim();
                try {
                    if (t.startsWith("[")) list = new JSONArray(t);
                    else {
                        JSONObject o = new JSONObject(t);
                        list = o.optJSONArray("data");
                        if (list == null) list = o.optJSONArray("models");
                    }
                } catch (JSONException e) {
                    throw new ProviderException(p.name + " sent a model list that is not JSON.");
                }
                if (list != null) for (int i = 0; i < list.length(); i++) {
                    Object m = list.opt(i);
                    String n = m instanceof String ? (String) m
                            : m instanceof JSONObject ? ((JSONObject) m).optString("id", ((JSONObject) m).optString("name", "")) : "";
                    if (n.startsWith("models/")) n = n.substring("models/".length());
                    if (!n.isEmpty()) out.add(n);
                }
            }
        }
        Collections.sort(out);
        return out;
    }
}
