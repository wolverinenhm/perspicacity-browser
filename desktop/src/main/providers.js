'use strict';
// Model providers for the SHADOW agent.
//
// Every provider must return one JSON action matching ACTION_SCHEMA; agent.validateAction()
// checks the result again, so a provider that ignores the format only costs a retry, it can
// never widen what the agent may do.
//
// Most hosted models speak the OpenAI Chat Completions protocol, so one client covers
// OpenAI, DeepSeek, Kimi, Qwen, Gemini, Mistral, Groq, OpenRouter, xAI, GLM, Together,
// LM Studio and any custom endpoint. Ollama and Anthropic use their own APIs.
//
// Structured output differs per service. Each entry starts at the strongest mode it is known
// to support (json_schema > json_object > prompt-only) and steps down automatically when the
// server rejects the response_format, remembering the result for the session.

const { ACTION_SCHEMA, SYSTEM_PROMPT } = require('./agent');

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * id -> provider description. `endpoint` is the default base URL (user can override);
 * `model` the default model (user can change, or pick from "List models").
 */
const PROVIDERS = {
  ollama: {
    name: 'Ollama (on this computer)', kind: 'ollama', local: true, needsKey: false,
    endpoint: 'http://127.0.0.1:11434', model: 'llama3.1',
    hint: 'Private: nothing leaves your computer. Any model with structured output, e.g. llama3.1, qwen2.5.',
  },
  lmstudio: {
    name: 'LM Studio (on this computer)', kind: 'openai', local: true, needsKey: false,
    endpoint: 'http://127.0.0.1:1234/v1', model: '', format: 'json_schema',
    hint: 'Private: start the LM Studio server, load a model, then pick it with "List models".',
  },
  anthropic: {
    name: 'Claude (Anthropic)', kind: 'anthropic', needsKey: true,
    endpoint: '', model: 'claude-opus-5-5', keyHint: 'sk-ant-...',
    hint: 'Get a key at console.anthropic.com.',
  },
  openai: {
    name: 'OpenAI (ChatGPT models)', kind: 'openai', needsKey: true,
    endpoint: 'https://api.openai.com/v1', model: 'gpt-5-mini', format: 'json_schema', keyHint: 'sk-...',
    hint: 'Get a key at platform.openai.com.',
  },
  gemini: {
    name: 'Google Gemini', kind: 'openai', needsKey: true,
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', format: 'json_schema', keyHint: 'AIza...',
    hint: 'Get a key at aistudio.google.com.',
  },
  deepseek: {
    name: 'DeepSeek', kind: 'openai', needsKey: true,
    endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', format: 'json_object', temperature: true, keyHint: 'sk-...',
    hint: 'Get a key at platform.deepseek.com.',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)', kind: 'openai', needsKey: true,
    endpoint: 'https://api.moonshot.ai/v1', model: 'kimi-k2-0905-preview', format: 'json_object', temperature: true, keyHint: 'sk-...',
    hint: 'Get a key at platform.moonshot.ai. Mainland China accounts: set the endpoint to https://api.moonshot.cn/v1.',
  },
  qwen: {
    name: 'Qwen (Alibaba Cloud Model Studio)', kind: 'openai', needsKey: true,
    endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', format: 'json_object', temperature: true, keyHint: 'sk-...',
    hint: 'Get a key in Alibaba Cloud Model Studio. Mainland China accounts: set the endpoint to https://dashscope.aliyuncs.com/compatible-mode/v1.',
  },
  mistral: {
    name: 'Mistral AI', kind: 'openai', needsKey: true,
    endpoint: 'https://api.mistral.ai/v1', model: 'mistral-medium-latest', format: 'json_schema', temperature: true,
    hint: 'Get a key at console.mistral.ai.',
  },
  xai: {
    name: 'xAI (Grok)', kind: 'openai', needsKey: true,
    endpoint: 'https://api.x.ai/v1', model: 'grok-4', format: 'json_schema', keyHint: 'xai-...',
    hint: 'Get a key at console.x.ai.',
  },
  glm: {
    name: 'GLM (Zhipu / Z.ai)', kind: 'openai', needsKey: true,
    endpoint: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6', format: 'json_object', temperature: true,
    hint: 'Get a key at z.ai. Mainland China accounts: set the endpoint to https://open.bigmodel.cn/api/paas/v4.',
  },
  groq: {
    name: 'Groq', kind: 'openai', needsKey: true,
    endpoint: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', format: 'json_object', temperature: true, keyHint: 'gsk_...',
    hint: 'Get a key at console.groq.com.',
  },
  together: {
    name: 'Together AI', kind: 'openai', needsKey: true,
    endpoint: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', format: 'json_object', temperature: true,
    hint: 'Get a key at api.together.ai.',
  },
  openrouter: {
    name: 'OpenRouter (hundreds of models)', kind: 'openai', needsKey: true,
    endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini', format: 'json_object', keyHint: 'sk-or-...',
    hint: 'One key for models from many companies. Get it at openrouter.ai.',
  },
  custom: {
    name: 'Custom (any OpenAI-compatible API)', kind: 'openai', needsKey: false,
    endpoint: '', model: '', format: 'json_schema',
    hint: 'Enter the base URL that ends before /chat/completions, for example https://host/v1. A key is optional.',
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);
const FORMATS = ['json_schema', 'json_object', 'none'];

/** Format mode that worked for provider+model, learned at runtime. */
const learnedFormat = new Map();

function endpointFor(id, cfg) {
  const p = PROVIDERS[id];
  const custom = cfg && cfg.endpoints && typeof cfg.endpoints[id] === 'string' ? cfg.endpoints[id].trim() : '';
  return (custom || p.endpoint).replace(/\/+$/, '');
}

function modelFor(id, cfg) {
  const m = cfg && cfg.models && typeof cfg.models[id] === 'string' ? cfg.models[id].trim() : '';
  return m || PROVIDERS[id].model;
}

/** Public catalog for the settings UI. */
function catalog() {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return { id, name: p.name, endpoint: p.endpoint, model: p.model, needsKey: p.needsKey, local: Boolean(p.local), keyHint: p.keyHint || '', hint: p.hint, kind: p.kind };
  });
}

function withTimeout(signal) {
  const t = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** Pulls the JSON object out of a reply that may be fenced or wrapped in prose. */
function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) return s;
  try { JSON.parse(s); return s; } catch (_) { /* fall through */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenced) {
    const inner = fenced[1].trim();
    try { JSON.parse(inner); return inner; } catch (_) { /* fall through */ }
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}

const SCHEMA_REMINDER = [
  'Reply with only a JSON object (no prose, no code fences) with exactly these keys:',
  '"thought" (string), "action" (one of click, type, select, navigate, scroll, wait, done), "id" (string),',
  '"text" (string), "submit" (boolean), "url" (string), "direction" ("up", "down" or ""), "answer" (string).',
  `JSON schema: ${JSON.stringify(ACTION_SCHEMA)}`,
].join('\n');

function messageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('');
  return '';
}

function looksLikeFormatError(status, body) {
  return (status === 400 || status === 422 || status === 404 || status === 501)
    && /response_format|json_schema|json_object|structured|schema|format/i.test(body);
}

class ProviderError extends Error {}

/** fetch() with an error that says which host could not be reached and why. */
async function request(name, url, init, fetchImpl) {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw e;
    let host = url;
    try { host = new URL(url).host; } catch (_) { /* keep url */ }
    const why = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || 'network error';
    throw new ProviderError(`Could not reach ${name} at ${host} (${why}). Check your connection and the endpoint.`);
  }
}

function httpError(name, status, body, model) {
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = (j.error && (j.error.message || j.error)) || j.message || j.detail || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch (_) { detail = String(body || '').slice(0, 200); }
  const hint = status === 401 || status === 403 ? ' Check the API key in Settings.'
    : status === 404 ? ` Check the model name ("${model}") and endpoint.`
      : status === 429 ? ' Rate limited or out of credit.'
        : '';
  return new ProviderError(`${name} returned HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}.${hint}`);
}

/** OpenAI Chat Completions protocol (used by most providers). */
async function callOpenAICompatible(id, cfg, apiKey, messages, signal, fetchImpl = fetch) {
  const p = PROVIDERS[id];
  const base = endpointFor(id, cfg);
  const model = modelFor(id, cfg);
  if (!base) throw new ProviderError(`${p.name}: set the endpoint URL in Settings.`);
  if (!model) throw new ProviderError(`${p.name}: choose a model in Settings ("List models" shows what is available).`);
  if (p.needsKey && !apiKey) throw new ProviderError(`No ${p.name} API key saved. Add one in Settings.`);

  const cacheKey = `${id}|${base}|${model}`;
  let start = FORMATS.indexOf(learnedFormat.get(cacheKey) || p.format || 'json_object');
  if (start < 0) start = 1;
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (id === 'openrouter') headers['x-title'] = 'Perspicacity';

  for (let i = start; i < FORMATS.length; i++) {
    const mode = FORMATS[i];
    const system = mode === 'json_schema' ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${SCHEMA_REMINDER}`;
    const body = { model, messages: [{ role: 'system', content: system }, ...messages], stream: false };
    if (p.temperature) body.temperature = 0.1;
    if (mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'agent_action', strict: true, schema: ACTION_SCHEMA } };
    else if (mode === 'json_object') body.response_format = { type: 'json_object' };

    const res = await request(p.name, `${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(signal) }, fetchImpl);
    const text = await res.text();
    if (!res.ok) {
      if (i < FORMATS.length - 1 && looksLikeFormatError(res.status, text)) continue;
      throw httpError(p.name, res.status, text, model);
    }
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new ProviderError(`${p.name} sent a reply that is not JSON.`); }
    const choice = data.choices && data.choices[0];
    const msg = choice && choice.message;
    if (msg && msg.refusal) throw new ProviderError('The model declined this step.');
    learnedFormat.set(cacheKey, mode);
    return extractJson(messageText(msg));
  }
  throw new ProviderError(`${p.name} rejected every output format.`);
}

async function callOllama(cfg, messages, signal, fetchImpl = fetch) {
  const base = endpointFor('ollama', cfg);
  const model = modelFor('ollama', cfg);
  const res = await request('Ollama', `${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: ACTION_SCHEMA,
      options: { temperature: 0.1 },
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    }),
    signal: withTimeout(signal),
  }, fetchImpl);
  if (!res.ok) throw new ProviderError(`Ollama returned HTTP ${res.status}. Is it running at ${base} with model "${model}" pulled?`);
  const data = await res.json();
  return data && data.message ? extractJson(data.message.content) : '';
}

async function callAnthropic(cfg, apiKey, messages, signal) {
  if (!apiKey) throw new ProviderError('No Anthropic API key saved. Add one in Settings.');
  // Lazy-load: the SDK is only needed when the user picks this provider.
  const Anthropic = require('@anthropic-ai/sdk');
  const AnthropicClient = Anthropic.default || Anthropic;
  const opts = { apiKey };
  const base = endpointFor('anthropic', cfg);
  if (base) opts.baseURL = base;
  const client = new AnthropicClient(opts);
  const response = await client.beta.messages.create({
    model: modelFor('anthropic', cfg),
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ACTION_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages,
  }, { signal: withTimeout(signal) });
  if (response.stop_reason === 'refusal') throw new ProviderError('The model declined this step.');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/** Returns decide(messages, signal) for the configured provider. */
function makeDecider(cfg, apiKey, fetchImpl) {
  const id = PROVIDERS[cfg.provider] ? cfg.provider : 'ollama';
  const kind = PROVIDERS[id].kind;
  if (kind === 'ollama') return (m, s) => callOllama(cfg, m, s, fetchImpl);
  if (kind === 'anthropic') return (m, s) => callAnthropic(cfg, apiKey, m, s);
  return (m, s) => callOpenAICompatible(id, cfg, apiKey, m, s, fetchImpl);
}

/** Lists model ids the provider offers (for the settings picker). */
async function listModels(id, cfg, apiKey, fetchImpl = fetch) {
  const p = PROVIDERS[id];
  if (!p) throw new ProviderError('unknown provider');
  if (p.needsKey && !apiKey) throw new ProviderError(`Save a ${p.name} API key first.`);
  const signal = AbortSignal.timeout(20_000);
  if (p.kind === 'anthropic') {
    const Anthropic = require('@anthropic-ai/sdk');
    const AnthropicClient = Anthropic.default || Anthropic;
    const opts = { apiKey };
    const base = endpointFor(id, cfg);
    if (base) opts.baseURL = base;
    const client = new AnthropicClient(opts);
    const ids = [];
    for await (const m of client.models.list({ limit: 100 }, { signal })) ids.push(m.id);
    return ids;
  }
  const base = endpointFor(id, cfg);
  if (!base) throw new ProviderError('Set the endpoint URL first.');
  if (p.kind === 'ollama') {
    const res = await request('Ollama', `${base}/api/tags`, { signal }, fetchImpl);
    if (!res.ok) throw new ProviderError(`Ollama returned HTTP ${res.status}. Is it running at ${base}?`);
    const data = await res.json();
    return (data.models || []).map((m) => m.name || m.model).filter(Boolean).sort();
  }
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await request(p.name, `${base}/models`, { headers, signal }, fetchImpl);
  const text = await res.text();
  if (!res.ok) throw httpError(p.name, res.status, text, '');
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new ProviderError(`${p.name} sent a model list that is not JSON.`); }
  const list = Array.isArray(data) ? data : data.data || data.models || [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name || '')).map((s) => s.replace(/^models\//, '')).filter(Boolean).sort();
}

module.exports = {
  PROVIDERS, PROVIDER_IDS, catalog, endpointFor, modelFor, extractJson,
  makeDecider, listModels, callOpenAICompatible, callOllama, callAnthropic, ProviderError,
  _learnedFormat: learnedFormat,
};
