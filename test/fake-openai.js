// A tiny stand-in for the OpenAI Responses API, used by test/openai.test.js.
import http from 'node:http';

export async function startFakeOpenAI() {
  const state = { mode: 'ok', chatMode: 'ok', models: ['openrings-ai:latest', 'qwen2.5:7b'], requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-should-retry': 'false', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/v1/models') {
        return send(200, { object: 'list', data: state.models.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'library' })) });
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/models/')) {
        return send(200, { id: decodeURIComponent(req.url.split('/').pop()), object: 'model', created: 1700000000, owned_by: 'openai' });
      }
      // Stand-in for the Open Rings AI engine's management API (used by npm run ai:setup).
      if (req.method === 'GET' && req.url === '/api/version') return send(200, { version: '0.12.0' });
      if (req.method === 'GET' && req.url === '/api/tags') return send(200, { models: state.models.map((name) => ({ name, model: name })) });
      if (req.method === 'POST' && req.url === '/api/pull') {
        const name = JSON.parse(raw).model;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'pulling 1a2b', digest: 'sha256:1a2b', total: 4000, completed: 1000 }) + '\n');
        res.write(JSON.stringify({ status: 'pulling 1a2b', digest: 'sha256:1a2b', total: 4000, completed: 4000 }) + '\n');
        res.write(JSON.stringify({ status: 'pulling 3c4d', digest: 'sha256:3c4d', total: 1000, completed: 1000 }) + '\n');
        state.models.push(name);
        return res.end(JSON.stringify({ status: 'success' }) + '\n');
      }
      if (req.method === 'POST' && req.url === '/api/create') {
        const body = JSON.parse(raw);
        state.created = body;
        if (!state.models.includes(body.from)) return send(404, { error: `model '${body.from}' not found` });
        if (!state.models.includes(`${body.model}:latest`)) state.models.push(`${body.model}:latest`);
        return send(200, { status: 'success' });
      }
      const body = raw ? JSON.parse(raw) : {};
      state.requests.push({ url: req.url, body, headers: req.headers });
      if (state.mode === 'quota') {
        return send(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', code: 'insufficient_quota', param: null } });
      }
      if (req.url === '/v1/chat/completions') {
        // Stand-in for the self-hosted Open Rings AI engine (OpenAI-compatible chat API).
        if (state.chatMode === 'reject_json_schema' && body.response_format?.type === 'json_schema') {
          return send(400, { error: { message: 'response_format json_schema is not supported', type: 'invalid_request_error', code: null, param: 'response_format' } });
        }
        const sys = body.messages?.[0]?.content || '';
        const user = body.messages?.at(-1)?.content || '';
        let data;
        if (/"should_reply"/.test(sys)) data = { should_reply: true, reply_markdown: 'Self-hosted answer: create the IVR in the dialplan. (fake local model)' };
        else if (/"posts"/.test(sys)) data = { posts: [...String(user).matchAll(/<slot number="(\d+)">/g)].map((m) => ({ slot: Number(m[1]), title: `Local model question number ${m[1]} about IVR`, body: 'How do I build an IVR with office hours for 15 extensions?' })) };
        else if (/"body"/.test(sys)) data = { body: 'Thanks. Which file holds the dialplan?' };
        else data = 'OK';
        const content = typeof data === 'string' ? data : '```json\n' + JSON.stringify(data) + '\n```';
        return send(200, {
          id: 'chatcmpl-test', object: 'chat.completion', created: 1700000000, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
        });
      }
      const props = body.text?.format?.schema?.properties || {};
      let data;
      if (props.should_reply) data = { should_reply: true, reply_markdown: 'Open **5060/udp** and **16384-32768/udp** on the VPS firewall. (fake OpenAI)' };
      else if (props.posts) data = { posts: [...String(body.input).matchAll(/<slot number="(\d+)">/g)].map((m) => ({ slot: Number(m[1]), title: `Fake OpenAI question number ${m[1]} about trunks`, body: 'We have 20 extensions and a SIP trunk. Inbound calls fail with 404. What should I check first?' })) };
      else if (props.body) data = { body: 'We are on 0.10.1. Which log shows the dialplan match?' };
      else data = {};
      const content = state.mode === 'refusal'
        ? [{ type: 'refusal', refusal: 'I can not help with that.' }]
        : [{ type: 'output_text', text: JSON.stringify(data), annotations: [] }];
      send(200, {
        id: 'resp_test', object: 'response', created_at: 1700000000, status: 'completed', model: body.model,
        output: [{ type: 'message', id: 'msg_test', status: 'completed', role: 'assistant', content }],
        usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 900 }, output_tokens: 150, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 1350 },
        incomplete_details: null, error: null, parallel_tool_calls: true, tools: [], tool_choice: 'auto', temperature: 1, top_p: 1,
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}
