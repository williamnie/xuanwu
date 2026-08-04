import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  PiConversationStreamError,
  streamPiConversationMessage,
} from './piConversationStream.js';

const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;

test.before(() => {
  globalThis.document = {
    cookie: '',
    removeEventListener() {},
  };
  globalThis.localStorage = {
    getItem(key) {
      return key === 'xuanwu-auth-token' ? 'test-token' : '';
    },
  };
  globalThis.window = {
    clearTimeout,
    fetch,
    setTimeout,
  };
});

test.after(() => {
  restoreGlobal('document', originalDocument);
  restoreGlobal('localStorage', originalLocalStorage);
  restoreGlobal('window', originalWindow);
});

test('POST SSE sends auth headers/body and preserves cross-chunk delta order through completion', async () => {
  let received = null;
  const events = [];
  const result = await withServer(async (request, response) => {
    received = {
      body: await requestBody(request),
      headers: request.headers,
      method: request.method,
      url: request.url,
    };
    response.writeHead(201, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    const payload = [
      sse('accepted', { conversation_id: 'conv-1', status: 'accepted', turn_id: 'turn-1' }),
      sse('start', { conversation_id: 'conv-1', status: 'running', turn_id: 'turn-1' }),
      sse('assistant_text_delta', { conversation_id: 'conv-1', delta: 'hel', turn_id: 'turn-1' }),
      sse('assistant_text_delta', { conversation_id: 'conv-1', delta: 'lo', turn_id: 'turn-1' }),
      sse('completed', {
        conversation_id: 'conv-1',
        message_count: 2,
        status: 'completed',
        text: 'hello',
        title: 'Greeting',
        turn_id: 'turn-1',
      }),
    ].join('');
    for (let index = 0; index < payload.length; index += 7) {
      response.write(payload.slice(index, index + 7));
    }
    response.end();
  }, (baseUrl) => streamPiConversationMessage(
    'conv-1',
    { prompt: 'hello', target_project_id: 'runner' },
    {
      fetch: relativeFetch(baseUrl),
      onEvent: (event) => events.push(event),
    },
  ));

  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/api/pi/conversations/conv-1/messages');
  assert.equal(received.headers.accept, 'text/event-stream');
  assert.equal(received.headers.authorization, 'Bearer test-token');
  assert.equal(received.headers['content-type'], 'application/json');
  assert.equal(received.headers['x-codex-client'], 'xuanwu-web');
  assert.deepEqual(JSON.parse(received.body), { prompt: 'hello', target_project_id: 'runner' });
  assert.deepEqual(
    events.filter((event) => event.event === 'assistant_text_delta').map((event) => event.data.delta),
    ['hel', 'lo'],
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.title, 'Greeting');
});

test('provider failure surfaces the backend message without retrying the POST', async () => {
  let requests = 0;
  await assert.rejects(
    withServer((_request, response) => {
      requests += 1;
      response.writeHead(201, { 'Content-Type': 'text/event-stream' });
      response.end([
        sse('accepted', { conversation_id: 'conv-2', turn_id: 'turn-2' }),
        sse('failed', {
          conversation_id: 'conv-2',
          error: { code: 'provider_error', message: 'provider quota exceeded' },
          status: 'failed',
          turn_id: 'turn-2',
        }),
      ].join(''));
    }, (baseUrl) => streamPiConversationMessage('conv-2', { prompt: 'fail' }, {
      fetch: relativeFetch(baseUrl),
    })),
    (error) => {
      assert.ok(error instanceof PiConversationStreamError);
      assert.equal(error.kind, 'provider');
      assert.equal(error.message, 'provider quota exceeded');
      return true;
    },
  );
  assert.equal(requests, 1);
});

test('a disconnected accepted stream reports background-running ambiguity and never retries POST', async () => {
  let requests = 0;
  await assert.rejects(
    withServer((_request, response) => {
      requests += 1;
      response.writeHead(201, { 'Content-Type': 'text/event-stream' });
      response.write(sse('accepted', { conversation_id: 'conv-3', turn_id: 'turn-3' }));
      setTimeout(() => response.destroy(), 20);
    }, (baseUrl) => streamPiConversationMessage('conv-3', { prompt: 'disconnect' }, {
      fetch: relativeFetch(baseUrl),
    })),
    (error) => {
      assert.ok(error instanceof PiConversationStreamError);
      assert.equal(error.kind, 'disconnected');
      assert.equal(error.backgroundRunning, true);
      assert.match(error.message, /可能仍在后台运行/);
      return true;
    },
  );
  assert.equal(requests, 1);
});

test('AbortController closes the current stream without starting another request', async () => {
  let requests = 0;
  const controller = new AbortController();
  const result = await withServer((_request, response) => {
    requests += 1;
    response.writeHead(201, { 'Content-Type': 'text/event-stream' });
    response.write(sse('accepted', { conversation_id: 'conv-4', turn_id: 'turn-4' }));
  }, (baseUrl) => streamPiConversationMessage('conv-4', { prompt: 'stop' }, {
    fetch: relativeFetch(baseUrl),
    signal: controller.signal,
    onEvent(event) {
      if (event.event === 'accepted') controller.abort();
    },
  }));

  assert.deepEqual(result, { status: 'aborted', turn_id: 'turn-4' });
  assert.equal(requests, 1);
});

function relativeFetch(baseUrl) {
  return (input, init) => fetch(new URL(input, baseUrl), init);
}

function sse(event, data) {
  return `id: ${data.turn_id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function requestBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function restoreGlobal(name, value) {
  if (typeof value === 'undefined') {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
