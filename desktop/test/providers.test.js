'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/main/providers');
const { validateAction, handlesFromOutline } = require('../src/main/agent');
const { Settings } = require('../src/main/settings');

const ACTION = { thought: 'go', action: 'click', id: 'e1', text: '', submit: false, url: '', direction: '', answer: '' };
const snap = { outline: '[e1] button "Go"' };
snap.handles = handlesFromOutline(snap.outline);
const msgs = [{ role: 'user', content: 'TASK: x' }];

/** Fake fetch that records requests and answers from a queue of [status, body]. */
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = replies.shift() || [200, {}];
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
  };
  fn.calls = calls;
  return fn;
}
const chat = (content) => [200, { choices: [{ message: { role: 'assistant', content } }] }];

test('every provider has a name, kind and sensible defaults', () => {
  for (const id of P.PROVIDER_IDS) {
    const p = P.PROVIDERS[id];
    assert.ok(p.name && ['ollama', 'anthropic', 'openai'].includes(p.kind), id);
    if (p.endpoint) assert.match(p.endpoint, /^https?:\/\//, id);
    if (!p.local && id !== 'custom' && p.kind === 'openai') assert.match(p.endpoint, /^https:\/\//, id);
  }
  for (const id of ['openai', 'deepseek', 'kimi', 'qwen', 'gemini', 'mistral', 'groq', 'openrouter', 'xai', 'glm', 'custom']) assert.ok(P.PROVIDERS[id], id);
});

test('OpenAI gets a strict JSON schema, the key as a bearer token, and no temperature', async () => {
  P._learnedFormat.clear();
  const f = fakeFetch([chat(JSON.stringify(ACTION))]);
  const out = await P.makeDecider({ provider: 'openai', models: {}, endpoints: {} }, 'sk-test', f)(msgs);
  assert.strictEqual(validateAction(out, snap).action, 'click');
  const c = f.calls[0];
  assert.strictEqual(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(c.init.headers.authorization, 'Bearer sk-test');
  assert.strictEqual(c.body.model, 'gpt-5-mini');
  assert.strictEqual(c.body.response_format.type, 'json_schema');
  assert.strictEqual(c.body.response_format.json_schema.strict, true);
  assert.strictEqual(c.body.temperature, undefined);
  assert.strictEqual(c.body.messages[0].role, 'system');
});

test('DeepSeek, Kimi and Qwen use JSON mode with the schema in the prompt, and honour overrides', async () => {
  for (const id of ['deepseek', 'kimi', 'qwen']) {
    P._learnedFormat.clear();
    const f = fakeFetch([chat(JSON.stringify(ACTION))]);
    const cfg = { provider: id, models: { [id]: 'my-model' }, endpoints: { [id]: 'https://example.cn/v1/' } };
    await P.makeDecider(cfg, 'k', f)(msgs);
    const c = f.calls[0];
    assert.strictEqual(c.url, 'https://example.cn/v1/chat/completions', id);
    assert.strictEqual(c.body.model, 'my-model');
    assert.strictEqual(c.body.response_format.type, 'json_object');
    assert.match(c.body.messages[0].content, /JSON schema/);
  }
});

test('an unsupported response_format steps down and the working mode is remembered', async () => {
  P._learnedFormat.clear();
  const f = fakeFetch([
    [400, { error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." } }],
    [400, { error: { message: 'response_format json_object is not supported' } }],
    chat(`Sure! \`\`\`json\n${JSON.stringify(ACTION)}\n\`\`\``),
    chat(JSON.stringify(ACTION)),
  ]);
  const decide = P.makeDecider({ provider: 'custom', models: { custom: 'm' }, endpoints: { custom: 'http://127.0.0.1:9/v1' } }, '', f);
  const out = await decide(msgs);
  assert.strictEqual(validateAction(out, snap).id, 'e1');
  assert.deepStrictEqual(f.calls.map((c) => c.body.response_format && c.body.response_format.type), ['json_schema', 'json_object', undefined]);
  assert.strictEqual(f.calls[0].init.headers.authorization, undefined);
  await decide(msgs);
  assert.strictEqual(f.calls[3].body.response_format, undefined);
});

test('errors are readable and other failures are not retried', async () => {
  P._learnedFormat.clear();
  await assert.rejects(P.makeDecider({ provider: 'openai', models: {}, endpoints: {} }, '', fakeFetch([]))(msgs), /No OpenAI .*API key/);
  await assert.rejects(P.makeDecider({ provider: 'custom', models: {}, endpoints: {} }, '', fakeFetch([]))(msgs), /endpoint URL/);
  const f = fakeFetch([[401, { error: { message: 'Incorrect API key provided' } }]]);
  await assert.rejects(P.makeDecider({ provider: 'deepseek', models: {}, endpoints: {} }, 'bad', f)(msgs), /HTTP 401: Incorrect API key provided\. Check the API key/);
  assert.strictEqual(f.calls.length, 1);
  await assert.rejects(P.makeDecider({ provider: 'openai', models: {}, endpoints: {} }, 'k', fakeFetch([[200, { choices: [{ message: { refusal: 'no' } }] }]]))(msgs), /declined/);
});

test('extractJson finds the object in fenced or chatty replies', () => {
  const j = JSON.stringify(ACTION);
  assert.strictEqual(P.extractJson(j), j);
  assert.strictEqual(P.extractJson(`\`\`\`json\n${j}\n\`\`\``), j);
  assert.strictEqual(P.extractJson(`Here you go: ${j} Hope that helps.`), j);
});

test('listModels reads OpenAI-style, Gemini-style and Ollama lists', async () => {
  let f = fakeFetch([[200, { data: [{ id: 'b' }, { id: 'a' }] }]]);
  assert.deepStrictEqual(await P.listModels('openai', {}, 'k', f), ['a', 'b']);
  assert.strictEqual(f.calls[0].url, 'https://api.openai.com/v1/models');
  f = fakeFetch([[200, { data: [{ id: 'models/gemini-2.5-flash' }] }]]);
  assert.deepStrictEqual(await P.listModels('gemini', {}, 'k', f), ['gemini-2.5-flash']);
  f = fakeFetch([[200, { models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:latest' }] }]]);
  assert.deepStrictEqual(await P.listModels('ollama', {}, null, f), ['llama3.1:latest', 'qwen2.5:7b']);
  assert.strictEqual(f.calls[0].url, 'http://127.0.0.1:11434/api/tags');
  await assert.rejects(P.listModels('kimi', {}, null, fakeFetch([])), /API key first/);
});

test('the OpenAI-compatible client works against a real HTTP server', async () => {
  P._learnedFormat.clear();
  let seen = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ACTION) } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const cfg = { provider: 'lmstudio', models: { lmstudio: 'local-model' }, endpoints: { lmstudio: `http://127.0.0.1:${server.address().port}/v1` } };
    const out = await P.makeDecider(cfg, null)(msgs);
    assert.strictEqual(validateAction(out, snap).action, 'click');
    assert.strictEqual(seen.url, '/v1/chat/completions');
    assert.strictEqual(seen.auth, undefined);
    assert.strictEqual(seen.body.model, 'local-model');
  } finally {
    server.close();
  }
});

test('0.1.x settings and the old Anthropic key carry over', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psp-settings-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ agent: { provider: 'anthropic', ollamaUrl: 'http://10.0.0.5:11434', ollamaModel: 'qwen2.5', anthropicModel: 'claude-x' } }));
  const s = new Settings(dir, null);
  s.writeSecret('anthropicApiKey', 'sk-ant-old');
  const a = s.get().agent;
  assert.strictEqual(a.provider, 'anthropic');
  assert.strictEqual(a.endpoints.ollama, 'http://10.0.0.5:11434');
  assert.strictEqual(a.models.ollama, 'qwen2.5');
  assert.strictEqual(a.models.anthropic, 'claude-x');
  assert.strictEqual(s.readApiKey('anthropic'), 'sk-ant-old');
  s.writeApiKey('anthropic', 'sk-ant-new');
  assert.strictEqual(s.readApiKey('anthropic'), 'sk-ant-new');
  assert.ok(!s.hasSecret('anthropicApiKey'));
  s.update({ agent: { provider: 'nope', endpoints: { kimi: 'javascript:alert(1)', qwen: 'https://user:pw@x.com/v1' } } });
  assert.strictEqual(s.get().agent.provider, 'ollama');
  assert.strictEqual(s.get().agent.endpoints.kimi, '');
  assert.strictEqual(s.get().agent.endpoints.qwen, '');
});

test('an unreachable endpoint names the host', async () => {
  const f = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  await assert.rejects(P.listModels('kimi', {}, 'k', f), /Could not reach Kimi \(Moonshot AI\) at api\.moonshot\.ai \(ENOTFOUND\)/);
});
