const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8787', 10);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || 'api.justwoker.icu';
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || 'sk-IEr4A0KR0RqyeNy5xBpCba6GWciti5ModqF7iTcJdX8upXAw';
const COMPLETIONS_PATH = process.env.UPSTREAM_COMPLETIONS_PATH || '/v1/completions';
const MODELS_PATH = process.env.UPSTREAM_MODELS_PATH || '/v1/models';
const TARGET_MODEL = process.env.TARGET_MODEL || 'replay-aigateway/claude-opus-4.8';

const CLAUDE_MODEL_IDS = new Set(['claude-opus-4-8', 'replay-aigateway/claude-opus-4.8']);
const DEFAULT_MAX_TOKENS = 1024;

function pickModel(requested) {
  if (CLAUDE_MODEL_IDS.has(requested)) return requested;
  return TARGET_MODEL;
}

function upstreamRequest(path, body, stream) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = https.request(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${UPSTREAM_KEY}`,
          'Content-Type': 'application/json',
          'User-Agent': 'claude-bridge/1.0',
          ...(stream ? { Accept: 'text/event-stream' } : { Accept: 'application/json' }),
        },
      },
      (res) => resolve(res)
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function upstreamGetModels() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: UPSTREAM_HOST,
        port: 443,
        path: MODELS_PATH,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${UPSTREAM_KEY}`,
          'User-Agent': 'claude-bridge/1.0',
          Accept: 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function mapToolChoice(tc) {
  if (!tc || typeof tc !== 'object') return tc;
  if (tc.type === 'auto' || tc.type === 'any') return tc.type === 'any' ? 'required' : 'auto';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  if (tc.type === 'none') return 'none';
  return undefined;
}

function anthropicMessagesToOpenAI(messages, system) {
  const out = [];
  if (system) {
    let sysText = '';
    if (typeof system === 'string') sysText = system;
    else if (Array.isArray(system)) {
      sysText = system
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    }
    if (sysText) out.push({ role: 'system', content: sysText });
  }
  for (const m of messages || []) {
    const role = m.role;
    if (typeof m.content === 'string') {
      if (role === 'assistant' || role === 'user') out.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    if (role === 'assistant') {
      const textParts = [];
      const toolUses = [];
      for (const b of m.content) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'tool_use') toolUses.push(b);
      }
      const msg = { role: 'assistant' };
      if (textParts.length) msg.content = textParts.join('\n');
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        }));
      }
      out.push(msg);
    } else if (role === 'user') {
      const textAcc = [];
      for (const b of m.content) {
        if (b.type === 'text') {
          textAcc.push(b.text);
        } else if (b.type === 'image' && b.source) {
          const src = b.source;
          const url = src.type === 'base64'
            ? `data:${src.media_type || 'image/png'};base64,${src.data}`
            : (src.url || '');
          out.push({
            role: 'user',
            content: [
              ...(textAcc.length ? [{ type: 'text', text: textAcc.join('\n') }] : []),
              { type: 'image_url', image_url: { url } },
            ],
          });
          textAcc.length = 0;
        } else if (b.type === 'tool_result') {
          if (textAcc.length) {
            out.push({ role: 'user', content: textAcc.join('\n') });
            textAcc.length = 0;
          }
          let content = b.content;
          if (Array.isArray(content)) {
            content = content
              .map((x) => {
                if (x && x.type === 'text') return x.text;
                if (x && x.type === 'image' && x.source && x.source.data) return `![image](data:${x.source.media_type || 'image/png'};base64,${x.source.data})`;
                return JSON.stringify(x);
              })
              .join('\n');
          }
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(content == null ? '' : content) });
        }
      }
      if (textAcc.length) out.push({ role: 'user', content: textAcc.join('\n') });
    }
  }
  return out;
}

function mapThinkingToEffort(thinking) {
  if (!thinking || typeof thinking !== 'object') return undefined;
  if (thinking.type === 'disabled') return undefined;
  if (thinking.effort) return thinking.effort;
  if (thinking.type === 'adaptive') return 'high';
  if (thinking.type === 'enabled') return 'high';
  return undefined;
}

function convertAnthropicRequest(body) {
  const messages = anthropicMessagesToOpenAI(body.messages, body.system);
  const req = {
    model: pickModel(body.model),
    max_tokens: body.max_tokens || DEFAULT_MAX_TOKENS,
    messages,
  };
  if (body.stream) req.stream = true;
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  if (body.stop_sequences && body.stop_sequences.length) req.stop = body.stop_sequences;

  const effort = body.reasoning_effort || mapThinkingToEffort(body.thinking);
  if (effort) req.reasoning_effort = effort;

  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }
  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice !== undefined) req.tool_choice = toolChoice;
  return req;
}

function mapStopReason(reason) {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    default: return null;
  }
}

function convertOpenAIResponse(openai, requestedModel) {
  const choice = openai.choices && openai.choices[0] ? openai.choices[0] : {};
  const message = choice.message || {};
  const content = [];
  if (message.reasoning_content || (message.reasoning && message.reasoning.content)) {
    const rc = message.reasoning_content || message.reasoning.content || '';
    if (rc) content.push({ type: 'thinking', thinking: rc, signature: '' });
  }
  if (message.content != null) content.push({ type: 'text', text: message.content });
  for (const tc of message.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function && tc.function.arguments); } catch (e) { input = {}; }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function && tc.function.name, input });
  }
  const usage = openai.usage || {};
  return {
    id: openai.id || 'msg_' + crypto.randomBytes(8).toString('hex'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

function anthropicEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function handleNonStream(upRes, res, requestedModel) {
  let body = '';
  upRes.on('data', (c) => (body += c));
  upRes.on('end', () => {
    res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
    if (upRes.statusCode >= 200 && upRes.statusCode < 300) {
      try {
        const openai = JSON.parse(body);
        res.end(JSON.stringify(convertOpenAIResponse(openai, requestedModel)));
      } catch (e) {
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Bad upstream response: ' + e.message } }));
      }
    } else {
      res.end(body);
    }
  });
}

function handleStream(upRes, res, requestedModel) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const model = requestedModel;
  const msgId = 'msg_' + crypto.randomBytes(8).toString('hex');
  let started = false;
  let textBlockOpen = false;
  let thinkingBlockIndex = -1;
  const toolStates = new Map();
  let nextBlockIndex = 0;
  let done = false;
  let outputTokens = 0;
  let stopReason = null;

  function emit(name, data) { if (!done) res.write(anthropicEvent(name, data)); }

  function openThinkingBlock() {
    if (thinkingBlockIndex >= 0) return;
    thinkingBlockIndex = nextBlockIndex++;
    emit('content_block_start', { type: 'content_block_start', index: thinkingBlockIndex, content_block: { type: 'thinking', thinking: '', signature: '' } });
  }

  function openTextBlock() {
    if (textBlockOpen) return;
    textBlockOpen = true;
    const index = nextBlockIndex++;
    emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  }

  function closeAllBlocks() {
    if (thinkingBlockIndex >= 0) {
      emit('content_block_stop', { type: 'content_block_stop', index: thinkingBlockIndex });
      thinkingBlockIndex = -1;
    }
    if (textBlockOpen) {
      emit('content_block_stop', { type: 'content_block_stop', index: 0 });
      textBlockOpen = false;
    }
    for (const [key, state] of toolStates) {
      emit('content_block_stop', { type: 'content_block_stop', index: state.blockIndex });
      toolStates.delete(key);
    }
  }

  function finishStream() {
    if (done) return;
    closeAllBlocks();
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    emit('message_stop', { type: 'message_stop' });
    done = true;
    res.end();
  }

  function handleChunk(obj) {
    const choice = obj.choices && obj.choices[0] ? obj.choices[0] : {};
    const delta = choice.delta || {};
    if (obj.usage) {
      outputTokens = obj.usage.completion_tokens || 0;
    }
      if (!started) {
        started = true;
        emit('message_start', {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        emit('ping', { type: 'ping' });
      }
      if (delta.content) {
        openTextBlock();
        emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
      }
      const reasoningDelta =
        (delta.reasoning_content != null ? delta.reasoning_content : '') ||
        (delta.reasoning && delta.reasoning.content != null ? delta.reasoning.content : '');
      if (reasoningDelta) {
        openThinkingBlock();
        emit('content_block_delta', { type: 'content_block_delta', index: thinkingBlockIndex, delta: { type: 'thinking_delta', thinking: reasoningDelta } });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const key = tc.index == null ? 0 : tc.index;
          if (!toolStates.has(key)) {
            const id = tc.id || 'toolu_' + crypto.randomBytes(6).toString('hex');
            toolStates.set(key, { blockIndex: nextBlockIndex++, id, name: (tc.function && tc.function.name) || '', args: '' });
            emit('content_block_start', {
              type: 'content_block_start',
              index: toolStates.get(key).blockIndex,
              content_block: { type: 'tool_use', id, name: toolStates.get(key).name, input: {} },
            });
          }
          const state = toolStates.get(key);
          if (tc.id) state.id = tc.id;
          if (tc.function) {
            if (tc.function.name) { state.name = tc.function.name; }
            if (tc.function.arguments) {
              state.args += tc.function.arguments;
              emit('content_block_delta', { type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
            }
          }
        }
      }
      if (choice.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason);
        finishStream();
      }
    }

  let buffer = '';
  upRes.setEncoding('utf8');
  upRes.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { finishStream(); return; }
      if (!payload) continue;
      try { handleChunk(JSON.parse(payload)); } catch (e) { /* ignore partial */ }
    }
  });
  upRes.on('end', () => {
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try { handleChunk(JSON.parse(payload)); } catch (e) {}
        }
      }
    }
    finishStream();
  });
  upRes.on('error', () => finishStream());
  res.on('close', () => { done = true; if (upRes.destroy) upRes.destroy(); });
}

function handleMessages(req, res, bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
    return;
  }
  const requestedModel = body.model || TARGET_MODEL;
  const converted = convertAnthropicRequest(body);
  const stream = !!body.stream;

  upstreamRequest(COMPLETIONS_PATH, converted, stream)
    .then((upRes) => {
      if (stream) handleStream(upRes, res, requestedModel);
      else handleNonStream(upRes, res, requestedModel);
    })
    .catch((err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err.message || err) } }));
    });
}

function handleModels(req, res) {
  upstreamGetModels()
    .then(({ status, body }) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (status >= 200 && status < 300) {
        try {
          const parsed = JSON.parse(body);
          const data = (parsed.data || []).map((m) => ({
            type: 'model',
            id: m.id,
            display_name: m.id,
            created_at: m.created,
          }));
          res.end(JSON.stringify({ data, object: 'list', success: true }));
        } catch (e) {
          res.end(body);
        }
      } else {
        res.end(body);
      }
    })
    .catch((err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err.message || err) } }));
    });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    handleModels(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handleMessages(req, res, body));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Not found: ${req.method} ${url.pathname}` } }));
});

server.listen(PORT, () => {
  console.log(`claude-bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Anthropic -> ${UPSTREAM_HOST}${COMPLETIONS_PATH}`);
  console.log(`target model: ${TARGET_MODEL}`);
});