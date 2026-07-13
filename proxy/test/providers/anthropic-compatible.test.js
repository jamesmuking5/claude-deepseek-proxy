"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { PassThrough } = require("stream");
const { send, pipeSSE } = require("../../providers/anthropic-compatible");

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function baseProvider(mockUrl) {
  return {
    id: "mock",
    protocol: "anthropic",
    baseUrl: mockUrl,
    basePath: "",
    modelMap: { "claude-test": "upstream-test" },
    defaultModel: "upstream-test",
    apiKey: "sk-mock",
    capabilities: { streaming: true, tools: true, parallelToolCalls: true, vision: false, reasoning: true, streamUsage: true },
  };
}

function baseParsed(overrides) {
  return {
    model: "claude-test",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
    stream: false,
    ...overrides,
  };
}

describe("Anthropic-compatible provider — non-stream", () => {
  it("preserves the /v1/messages upstream path", async () => {
    let receivedPath;
    const mock = await startMockServer((req, res) => {
      receivedPath = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant",
        model: "upstream-test", content: [], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    const provider = baseProvider(mock.url + "/api/anthropic");
    await send(provider, baseParsed(), "claude-test", "/v1/messages?beta=true");
    assert.strictEqual(receivedPath, "/api/anthropic/v1/messages");
    mock.server.close();
  });

  it("preserves the /v1/messages/count_tokens upstream path", async () => {
    let receivedPath;
    const mock = await startMockServer((req, res) => {
      receivedPath = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 42 }));
    });
    const provider = baseProvider(mock.url + "/api/anthropic");
    await send(provider, baseParsed(), "claude-test", "/v1/messages/count_tokens?beta=true");
    assert.strictEqual(receivedPath, "/api/anthropic/v1/messages/count_tokens");
    mock.server.close();
  });

  it("returns translated error on upstream 4xx", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bad request" } }));
    });
    const provider = baseProvider(mock.url);
    const result = await send(provider, baseParsed(), "claude-test");
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.isStream, false);
    assert.ok(result.body.error.type);
    mock.server.close();
  });

  it("returns translated error on upstream 5xx", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("Internal error");
    });
    const provider = baseProvider(mock.url);
    const result = await send(provider, baseParsed(), "claude-test");
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.isStream, false);
    mock.server.close();
  });

  it("returns translated response on success", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant",
        model: "upstream-test",
        content: [{ type: "text", text: "Hello from upstream!" }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
    const provider = baseProvider(mock.url);
    const result = await send(provider, baseParsed(), "claude-test");
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.isStream, false);
    assert.strictEqual(result.body.model, "claude-test");
    assert.strictEqual(result.body.content[0].text, "Hello from upstream!");
    mock.server.close();
  });
});

describe("Anthropic-compatible provider — stream errors", () => {
  it("buffers body and translates error on stream 4xx", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.write('{"error":{"type":"authentication_error","message":"Invalid key"}}');
      res.end();
    });
    const provider = baseProvider(mock.url);
    const result = await send(provider, baseParsed({ stream: true }), "claude-test");
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.isStream, false);
    assert.ok(result.body.error.type);
    mock.server.close();
  });

  it("buffers body and translates error on stream 5xx", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.write("Service Unavailable");
      res.end();
    });
    const provider = baseProvider(mock.url);
    const result = await send(provider, baseParsed({ stream: true }), "claude-test");
    assert.strictEqual(result.status, 503);
    assert.strictEqual(result.isStream, false);
    mock.server.close();
  });

  it("connection error rejects", async () => {
    const provider = baseProvider("http://127.0.0.1:19999");
    try {
      await send(provider, baseParsed({ stream: false }), "claude-test");
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e.message.includes("ECONNREFUSED") || e.message.includes("connect"));
    }
  });
});

describe("Anthropic-compatible pipeSSE — errors and cancellation", () => {
  it("client disconnect triggers STREAM_CANCELLED", async () => {
    let reqCloseHandler = null;
    const mockReq = {
      on(event, handler) {
        if (event === "close") reqCloseHandler = handler;
      },
      once() {},
      removeListener() {},
    };

    const mockRes = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      once() {},
      on() {},
      removeListener() {},
      end() { this.writableEnded = true; },
    };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "test",
      headers: { "content-type": "text/event-stream" },
      status: 200,
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);

    upstream.write('data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');

    reqCloseHandler();

    let settled = false;
    try { await pipePromise; } catch (e) {
      if (e.code === "STREAM_CANCELLED") settled = true;
    }
    assert.strictEqual(settled, true);
    upstream.end();
  });

  it("response close triggers STREAM_CANCELLED", async () => {
    let resCloseHandler = null;
    const mockReq = {
      on() {},
      once() {},
      removeListener() {},
    };

    const mockRes = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      once() {},
      on(event, handler) {
        if (event === "close") resCloseHandler = handler;
      },
      removeListener() {},
      end() { this.writableEnded = true; },
    };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "test",
      headers: { "content-type": "text/event-stream" },
      status: 200,
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);

    upstream.write('data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');

    resCloseHandler();

    let settled = false;
    try { await pipePromise; } catch (e) {
      if (e.code === "STREAM_CANCELLED") settled = true;
    }
    assert.strictEqual(settled, true);
    upstream.end();
  });

  it("stream error fails with clean promise rejection", async () => {
    const mockReq = { on() {}, once() {}, removeListener() {} };
    const mockRes = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      once() {},
      on() {},
      removeListener() {},
      end() { this.writableEnded = true; },
    };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "test",
      headers: { "content-type": "text/event-stream" },
      status: 200,
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);

    upstream.write('data: {"type":"message_start"}\n\n');
    upstream.emit("error", new Error("upstream reset"));

    let caught = false;
    try { await pipePromise; } catch (e) {
      caught = true;
      assert.ok(e.message.includes("upstream reset"));
    }
    assert.strictEqual(caught, true);
  });

  it("non-JSON SSE line passed through as raw", async () => {
    const written = [];
    const mockReq = { on() {}, once() {}, removeListener() {} };
    const mockRes = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write(data) { written.push(data); return true; },
      once() {},
      on() {},
      removeListener() {},
      end() { this.writableEnded = true; },
    };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "test",
      headers: { "content-type": "text/event-stream" },
      status: 200,
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);
    upstream.write("data: not-json-data\n\n");
    upstream.write('event: custom\ndata: {"x":1}\n\n');
    upstream.end();
    await pipePromise;

    const allText = written.join("");
    assert.ok(allText.includes("not-json-data"), "non-JSON data line should pass through");
    assert.ok(allText.includes('"x":1'), "valid JSON should be transformed");
  });

  it("skips [DONE] sentinel", async () => {
    const written = [];
    const mockReq = { on() {}, once() {}, removeListener() {} };
    const mockRes = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write(data) { written.push(data); return true; },
      once() {},
      on() {},
      removeListener() {},
      end() { this.writableEnded = true; },
    };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "test",
      headers: { "content-type": "text/event-stream" },
      status: 200,
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);
    upstream.write('data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    upstream.write("data: [DONE]\n\n");
    upstream.end();
    await pipePromise;

    assert.ok(!written.some(w => w.includes("[DONE]")), "[DONE] must not be forwarded");
  });
});

describe("Anthropic-compatible pipeSSE — backpressure", () => {
  it("preserves queued lines after upstream end before drain", async () => {
    const written = [];
    let drainHandler = null;
    let writeCount = 0;

    const mockReq = { on() {}, once() {}, removeListener() {} };
    const mockRes = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write(data) {
        writeCount++;
        written.push(data);
        if (writeCount === 1) return false;
        return true;
      },
      once(event, handler) { if (event === "drain") drainHandler = handler; },
      on() {},
      removeListener() {},
      end() { this.writableEnded = true; },
    };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "test",
      headers: { "content-type": "text/event-stream" },
      status: 200,
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);

    upstream.write('data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"x","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    upstream.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    upstream.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n');
    upstream.write('data: {"type":"content_block_stop","index":0}\n\n');
    upstream.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    upstream.write('data: {"type":"message_stop"}\n\n');
    upstream.end();

    // Let event loop process end event
    await new Promise(r => setImmediate(r));

    drainHandler();
    await pipePromise;

    const all = written.join("");
    assert.ok(all.includes("message_start"));
    assert.ok(all.includes("message_stop"));
    assert.ok(written.length > 2, "all queued lines must be written after drain");
  });
});
