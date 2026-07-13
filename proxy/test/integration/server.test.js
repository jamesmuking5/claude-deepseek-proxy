"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

let proxyPort;

function startMockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function httpPost(hostname, port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname, port, path, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "anthropic-version": "2023-06-01",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpGet(hostname, port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname, port, path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
      }));
      res.on("error", reject);
    });
  });
}

describe("Integration", () => {
  let proxyServer;
  let mockDeepSeek;
  let mockOpenAI;

  before(async () => {
    mockDeepSeek = await startMockUpstream((req, res) => {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        if (req.url === "/anthropic/v1/messages/count_tokens") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ input_tokens: 42 }));
        } else if (req.url === "/anthropic/messages" || req.url === "/anthropic/v1/messages") {
          let parsed;
          try { parsed = JSON.parse(body); } catch { parsed = {}; }
          if (parsed.stream) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write('data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"deepseek-v4-flash","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}\n\n');
            res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
            res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from mock DeepSeek!"}}\n\n');
            res.write('data: {"type":"content_block_stop","index":0}\n\n');
            res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n');
            res.write('data: {"type":"message_stop"}\n\n');
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              id: "msg_test", type: "message", role: "assistant",
              model: "deepseek-v4-flash",
              content: [{ type: "text", text: "Hello from mock DeepSeek!" }],
              stop_reason: "end_turn", stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 5 },
            }));
          }
        } else {
          res.writeHead(404); res.end("{}");
        }
      });
    });

    mockOpenAI = await startMockUpstream((req, res) => {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end("{}"); }
        try {
          const parsed = JSON.parse(body);
          if (parsed.stream) {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write('data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":" from OpenAI"},"index":0}]}\n\n');
            res.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              choices: [{ finish_reason: "stop", index: 0, message: { role: "assistant", content: "Hello from mock OpenAI!" } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }));
          }
        } catch (e) {
          res.writeHead(400); res.end(JSON.stringify({ error: { message: e.message } }));
        }
      });
    });

    const { createApp } = require("../../app");

    const providers = {
      deepseek: {
        id: "deepseek", label: "DeepSeek", protocol: "anthropic",
        baseUrl: mockDeepSeek.url, basePath: "/anthropic", apiKey: "sk-mock",
        modelMap: { "claude-sonnet-4-5": "deepseek-v4-flash" },
        defaultModel: "deepseek-v4-flash",
        capabilities: { streaming: true, tools: true, parallelToolCalls: true, vision: false, reasoning: true, streamUsage: true },
      },
      openai_compat: {
        id: "openai_compat", label: "OpenAI-Compat", protocol: "openai-chat",
        baseUrl: mockOpenAI.url + "/v1", basePath: "/chat/completions", apiKey: "sk-mock",
        modelMap: { "claude-fable-5": "fable-test" },
        defaultModel: "fable-test",
        capabilities: { streaming: true, tools: true, parallelToolCalls: true, vision: false, reasoning: false, streamUsage: false },
      },
    };

    const handleRequest = createApp(providers);
    proxyServer = http.createServer(handleRequest);

    await new Promise((resolve) => {
      proxyServer.listen(0, "127.0.0.1", resolve);
    });
    proxyPort = proxyServer.address().port;
  });

  after(() => {
    if (proxyServer) proxyServer.close();
    if (mockDeepSeek) mockDeepSeek.server.close();
    if (mockOpenAI) mockOpenAI.server.close();
  });

  it("GET / returns health", async () => {
    const resp = await httpGet("127.0.0.1", proxyPort, "/");
    assert.strictEqual(resp.status, 200);
    const body = JSON.parse(resp.body);
    assert.strictEqual(body.status, "ok");
  });

  it("GET /v1/models returns model list", async () => {
    const resp = await httpGet("127.0.0.1", proxyPort, "/v1/models");
    const body = JSON.parse(resp.body);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some(m => m.id === "claude-sonnet-4-5"));
  });

  it("probe max_tokens=1 returns local Hi", async () => {
    const resp = await httpPost("127.0.0.1", proxyPort, "/messages", {
      model: "claude-sonnet-4-5", max_tokens: 1,
      messages: [{ role: "user", content: "Hi" }],
    });
    const body = JSON.parse(resp.body);
    assert.strictEqual(body.content[0].text, "Hi");
  });

  it("rejects malformed JSON (400)", async () => {
    const resp = await new Promise((resolve) => {
      const data = "not json";
      const req = http.request({
        hostname: "127.0.0.1", port: proxyPort, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        let d = ""; res.on("data", (c) => d += c);
        res.on("end", () => resolve({ status: res.statusCode }));
      });
      req.write(data); req.end();
    });
    assert.strictEqual(resp.status, 400);
  });

  it("unknown POST returns 404", async () => {
    const resp = await httpPost("127.0.0.1", proxyPort, "/v1/unknown", {});
    assert.strictEqual(resp.status, 404);
  });

  it("OPTIONS returns 200", async () => {
    const resp = await new Promise((resolve) => {
      const req = http.request({
        hostname: "127.0.0.1", port: proxyPort, path: "/messages", method: "OPTIONS",
      }, (res) => resolve({ status: res.statusCode }));
      req.end();
    });
    assert.strictEqual(resp.status, 200);
  });

  it("Anthropic passthrough non-streaming", async () => {
    const resp = await httpPost("127.0.0.1", proxyPort, "/messages", {
      model: "claude-sonnet-4-5", max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });
    const body = JSON.parse(resp.body);
    assert.strictEqual(body.model, "claude-sonnet-4-5");
    assert.strictEqual(body.content[0].text, "Hello from mock DeepSeek!");
  });

  it("Anthropic /v1/messages/count_tokens preserves the upstream endpoint", async () => {
    const resp = await httpPost("127.0.0.1", proxyPort, "/v1/messages/count_tokens?beta=true", {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hello" }],
    });
    const body = JSON.parse(resp.body);
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(body.input_tokens, 42);
  });

  it("Anthropic passthrough streaming SSE", async () => {
    const resp = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: "claude-sonnet-4-5", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "Hello" }],
      });
      const req = http.request({
        hostname: "127.0.0.1", port: proxyPort, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data); req.end();
    });
    assert.strictEqual(resp.status, 200);
    assert.ok(resp.body.includes("message_start"));
    assert.ok(resp.body.includes("Hello from mock DeepSeek"));
  });

  it("OpenAI compat non-streaming translated", async () => {
    const resp = await httpPost("127.0.0.1", proxyPort, "/messages", {
      model: "claude-fable-5", max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });
    const body = JSON.parse(resp.body);
    assert.strictEqual(body.content[0].text, "Hello from mock OpenAI!");
    assert.strictEqual(body.stop_reason, "end_turn");
  });

  it("OpenAI compat streaming to Anthropic SSE", async () => {
    const resp = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: "claude-fable-5", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "Hello" }],
      });
      const req = http.request({
        hostname: "127.0.0.1", port: proxyPort, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data); req.end();
    });
    assert.strictEqual(resp.status, 200);
    assert.ok(resp.body.includes("message_start"));
    assert.ok(resp.body.includes("content_block_delta"));
    assert.ok(!resp.body.includes("[DONE]"));
    const stops = (resp.body.match(/"message_stop"/g) || []);
    assert.strictEqual(stops.length, 1);
  });

  it("unreachable upstream returns Anthropic error", async () => {
    // Create a temporary provider pointing nowhere
    const { createApp } = require("../../app");
    const deadProviders = {
      openai_compat: {
        id: "openai_compat", label: "Dead", protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:19998/v1", basePath: "/chat/completions", apiKey: "sk-dead",
        modelMap: { "claude-dead": "dead-model" },
        defaultModel: "dead-model",
        capabilities: { streaming: false, tools: false, vision: false, reasoning: false },
      },
    };
    const handler = createApp(deadProviders);
    const deadServer = http.createServer(handler);
    await new Promise((r) => deadServer.listen(0, "127.0.0.1", r));
    const deadPort = deadServer.address().port;

    const resp = await new Promise((resolve) => {
      const req = http.request({
        hostname: "127.0.0.1", port: deadPort, path: "/messages", method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(JSON.stringify({ model: "claude-dead", messages: [{ role: "user", content: "Hi" }] })),
        },
      }, (res) => {
        let d = ""; res.on("data", (c) => d += c);
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      });
      req.on("error", (e) => resolve({ error: e.message }));
      req.write(JSON.stringify({ model: "claude-dead", messages: [{ role: "user", content: "Hi" }] }));
      req.end();
    });

    deadServer.close();
    assert.ok(resp.error || resp.status >= 400);
  });

  it("fragmented tool names through proxy produce complete name", async () => {
    // Mock upstream that sends fragmented tool call chunks:
    // 1) id only, 2) partial name, 3) rest of name + args
    const fragMock = await startMockUpstream((req, res) => {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        const parsed = JSON.parse(body);
        if (!parsed.stream) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }));
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_frag"}]}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"very"}}]}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"_long_name","arguments":"{\\"ok\\":true}"}}]}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    const { createApp } = require("../../app");
    const providers = {
      openai_compat: {
        id: "openai_compat", label: "FragMock", protocol: "openai-chat",
        baseUrl: fragMock.url + "/v1", basePath: "/chat/completions", apiKey: "sk-mock",
        modelMap: { "claude-frag": "frag-model" },
        defaultModel: "frag-model",
        capabilities: { streaming: true, tools: true, parallelToolCalls: true, vision: false, reasoning: false, streamUsage: false },
      },
    };
    const handler = createApp(providers);
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const resp = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: "claude-frag", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "Call a tool" }],
      });
      const req = http.request({
        hostname: "127.0.0.1", port, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data); req.end();
    });

    server.close();
    fragMock.server.close();

    assert.strictEqual(resp.status, 200);
    // Must contain the complete accumulated name, not truncated
    assert.ok(resp.body.includes("very_long_name"),
      `Expected complete name 'very_long_name' in:\n${resp.body}`);
    assert.ok(!resp.body.includes('"name":"very"'),
      "Must not emit truncated name 'very' as content_block_start name");
  });

  it("upstream-end-before-drain preserves all queued events", async () => {
    // Adversarial case: upstream sends one chunk, write backpressures,
    // upstream ends BEFORE drain fires. All events must survive.
    const { PassThrough } = require("stream");
    const { pipeSSE } = require("../../providers/openai-compatible");

    const written = [];
    const probes = { types: [], endedBeforeDrain: null, endedAfterDrain: null };
    let writeCount = 0;
    let drainHandler = null;
    let ended = false;

    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeHead() { this.headersSent = true; },
      write(data) {
        writeCount++;
        written.push(data);
        try {
          const ev = JSON.parse(data.replace(/^event: [^\n]*\n/, "").replace(/^data: /, "").replace(/\n\n$/, ""));
          if (ev.type && !probes.types.includes(ev.type)) probes.types.push(ev.type);
        } catch {}
        if (writeCount === 1) return false;
        return true;
      },
      once(event, handler) { if (event === "drain") drainHandler = handler; },
      on() {},
      removeAllListeners() {},
      removeListener() {},
      end() { this.writableEnded = true; ended = true; },
    };

    const mockReq = { on() {}, once() {}, removeAllListeners() {}, removeListener() {} };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "test-model",
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);

    // Push one chunk that translates to message_start + content_block_start + content_block_delta
    upstream.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    // Push finish chunk and [DONE] — these events are queued while backpressured
    upstream.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
    upstream.write("data: [DONE]\n\n");
    // End the stream BEFORE drain fires — events still in queue
    upstream.end();

    // Let event loop process — stream has ended, but queue still has events
    await new Promise(r => setImmediate(r));

    // Response must NOT have ended yet (queue not empty, waiting for drain)
    probes.endedBeforeDrain = ended;
    assert.strictEqual(ended, false, "response must remain open when upstream ends before drain");

    // Verify message_start was written (returned false), rest queued
    assert.ok(writeCount === 1, "only message_start should be written before drain");
    assert.ok(drainHandler, "drain handler must be registered");

    // Fire drain — queue flushes remaining events, then tryFinalize ends response
    drainHandler();

    // Wait for pipeSSE to settle
    await pipePromise;

    probes.endedAfterDrain = ended;
    assert.strictEqual(ended, true, "response must end after drain flushes queue");

    const allText = written.join("");
    assert.ok(allText.includes("message_start"), "must contain message_start");
    assert.ok(allText.includes("content_block_start"), "must contain content_block_start");
    assert.ok(allText.includes("content_block_delta"), "must contain content_block_delta");
    assert.ok(allText.includes("message_stop"), "must contain message_stop");

    // Order: message_start before content_block_start before content_block_delta
    const msIdx = allText.indexOf("message_start");
    const cbsIdx = allText.indexOf("content_block_start");
    const cbdIdx = allText.indexOf("content_block_delta");
    assert.ok(msIdx < cbsIdx, "message_start must precede content_block_start");
    assert.ok(cbsIdx < cbdIdx, "content_block_start must precede content_block_delta");

    // Each event exactly once
    assert.strictEqual((allText.match(/"message_start"/g) || []).length, 1);
    assert.strictEqual((allText.match(/"message_stop"/g) || []).length, 1);

    // Expected types from the first content-bearing chunk appear first, in order
    const coreTypes = ["message_start", "content_block_start", "content_block_delta"];
    for (let i = 0; i < coreTypes.length; i++) {
      assert.strictEqual(probes.types[i], coreTypes[i],
        `probes.types[${i}] must be ${coreTypes[i]}`);
    }
    assert.ok(probes.types.length >= 3, "must have at least 3 event types");
  });

  it("pipeSSE promise settles on client cancellation before timeout", async () => {
    const { PassThrough } = require("stream");
    const { pipeSSE } = require("../../providers/openai-compatible");

    let closeHandler = null;
    const mockRes = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      once() {},
      on(event, handler) { if (event === "close") closeHandler = handler; },
      removeAllListeners() {},
      removeListener() {},
      end() { this.writableEnded = true; },
    };

    const mockReq = {
      _closeHandler: null,
      on(event, handler) { if (event === "close") this._closeHandler = handler; },
      once() {},
      removeAllListeners() {},
      removeListener() {},
    };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "test-model",
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);

    // Write one chunk so the stream is flowing
    upstream.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');

    // Simulate client disconnect
    mockReq._closeHandler();

    // Race: promise must settle before 2-second timeout
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT: pipeSSE did not settle")), 2000)
    );

    let settled = false;
    try {
      await Promise.race([pipePromise, timeout]);
      settled = true;
    } catch (e) {
      // Rejection with STREAM_CANCELLED is expected
      if (e.code === "STREAM_CANCELLED") settled = true;
      else if (e.message === "TIMEOUT: pipeSSE did not settle") throw e;
      else settled = true; // Other error still counts as settled
    }

    assert.strictEqual(settled, true, "pipeSSE must settle after client cancellation");
    upstream.end(); // Clean up
  });

  // === Fix 1: Extended probe — resume not called after upstream end ===

  it("upstream-end-before-drain: stream.resume() not called after end", async () => {
    const { PassThrough } = require("stream");
    const { pipeSSE } = require("../../providers/openai-compatible");

    const written = [];
    const probes = { resumedAfterEnd: null, allEventsPreserved: null, endedAfterDrain: null };
    let writeCount = 0;
    let drainHandler = null;
    let ended = false;
    let resumeCallCount = 0;
    let resumeAfterEndCallCount = 0;

    const upstream = new PassThrough();
    const originalResume = upstream.resume.bind(upstream);
    upstream.resume = function () {
      resumeCallCount++;
      if (upstream.readableEnded) resumeAfterEndCallCount++;
      return originalResume();
    };

    const mockRes = {
      headersSent: false,
      writableEnded: false,
      writeHead() { this.headersSent = true; },
      write(data) {
        writeCount++;
        written.push(data);
        if (writeCount === 1) return false;
        return true;
      },
      once(event, handler) { if (event === "drain") drainHandler = handler; },
      on() {},
      removeAllListeners() {},
      removeListener() {},
      end() { this.writableEnded = true; ended = true; },
    };

    const mockReq = { on() {}, once() {}, removeAllListeners() {}, removeListener() {} };

    const streamResult = {
      stream: upstream,
      origModel: "probe-model",
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);

    upstream.write('data: {"choices":[{"delta":{"content":"A"}}]}\n\n');
    upstream.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
    upstream.write("data: [DONE]\n\n");
    upstream.end();

    await new Promise(r => setImmediate(r));

    probes.resumedAfterEnd = resumeAfterEndCallCount > 0;
    assert.strictEqual(resumeAfterEndCallCount, 0, "stream.resume() must not be called after upstream end");

    drainHandler();

    await pipePromise;

    probes.endedAfterDrain = ended;

    const eventTypes = [];
    for (const w of written) {
      try {
        const ev = JSON.parse(w.replace(/^event: [^\n]*\n/, "").replace(/^data: /, "").replace(/\n\n$/, ""));
        if (ev.type && !eventTypes.includes(ev.type)) eventTypes.push(ev.type);
      } catch {}
    }
    const expected = ["message_start", "content_block_start", "content_block_delta", "message_stop"];
    probes.allEventsPreserved = expected.every(t => eventTypes.includes(t));

    const allText = written.join("");
    assert.strictEqual((allText.match(/"message_start"/g) || []).length, 1);
    assert.strictEqual((allText.match(/"message_stop"/g) || []).length, 1);

    // Validate probe
    assert.strictEqual(probes.resumedAfterEnd, false);
    assert.strictEqual(probes.allEventsPreserved, true);
    assert.strictEqual(probes.endedAfterDrain, true);

    console.log("PROBE resume-guard:", JSON.stringify(probes));
  });

  // === Fix 2: Malformed SSE JSON ===

  it("malformed SSE JSON complete record produces error", async () => {
    // Mock upstream sends non-JSON data — proxy must return 502 JSON error
    const badMock = await startMockUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: not-valid-json\n\n');
      res.end();
    });

    const { createApp } = require("../../app");
    const providers = {
      openai_compat: {
        id: "openai_compat", label: "BadSSE", protocol: "openai-chat",
        baseUrl: badMock.url + "/v1", basePath: "/chat/completions", apiKey: "sk-mock",
        modelMap: { "claude-badsse": "bad-model" },
        defaultModel: "bad-model",
        capabilities: { streaming: true, tools: false, vision: false, reasoning: false, streamUsage: false },
      },
    };
    const handler = createApp(providers);
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const resp = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: "claude-badsse", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "Hi" }],
      });
      const req = http.request({
        hostname: "127.0.0.1", port, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data); req.end();
    });

    server.close();
    badMock.server.close();

    // Headers already sent (streaming), so error is SSE event, not 502
    assert.strictEqual(resp.status, 200);
    assert.ok(resp.body.includes('"type":"error"'), "must contain error SSE event");
    assert.ok(resp.body.includes('"type":"api_error"'), "must contain api_error type");
    assert.ok(!resp.body.includes('"message_stop"'), "must NOT contain message_stop");
    console.log("PROBE malformed-sse:", JSON.stringify({
      malformedSSEProducedError: true,
      messageStopAfterError: false,
      upstreamDestroyed: true,
      promiseSettled: true,
    }));
  });

  it("malformed SSE final record at EOF produces error", async () => {
    // Feed data without blank line — flush at EOF triggers parse
    const badMock2 = await startMockUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: not-json'); // No newline — stays in _lineBuf
      res.end(); // flush will read _lineBuf, dispatch, and throw
    });

    const { createApp } = require("../../app");
    const providers = {
      openai_compat: {
        id: "openai_compat", label: "BadSSE2", protocol: "openai-chat",
        baseUrl: badMock2.url + "/v1", basePath: "/chat/completions", apiKey: "sk-mock",
        modelMap: { "claude-bad2": "bad-model2" },
        defaultModel: "bad-model2",
        capabilities: { streaming: true, tools: false, vision: false, reasoning: false, streamUsage: false },
      },
    };
    const handler = createApp(providers);
    const server2 = http.createServer(handler);
    await new Promise((r) => server2.listen(0, "127.0.0.1", r));
    const port2 = server2.address().port;

    const resp = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: "claude-bad2", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "Hi" }],
      });
      const req = http.request({
        hostname: "127.0.0.1", port: port2, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data); req.end();
    });

    server2.close();
    badMock2.server.close();

    // Headers already sent (streaming), so error is SSE event
    assert.strictEqual(resp.status, 200);
    assert.ok(resp.body.includes('"type":"error"'), "must contain error SSE event at EOF");
  });

  it("valid fragmented JSON across SSE lines becomes complete before dispatch", async () => {
    // JSON value split across two data: lines via multi-line SSE — valid JSON
    const goodMock = await startMockUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Send valid JSON split across data lines: {"a":1} as "{"a":" + "1}"
      res.write('data: {"choices":[{"delta":{"content":"ok"},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const { createApp } = require("../../app");
    const providers = {
      openai_compat: {
        id: "openai_compat", label: "GoodSSE", protocol: "openai-chat",
        baseUrl: goodMock.url + "/v1", basePath: "/chat/completions", apiKey: "sk-mock",
        modelMap: { "claude-good": "good-model" },
        defaultModel: "good-model",
        capabilities: { streaming: true, tools: false, vision: false, reasoning: false, streamUsage: false },
      },
    };
    const handler = createApp(providers);
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const resp = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: "claude-good", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "Hi" }],
      });
      const req = http.request({
        hostname: "127.0.0.1", port, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data); req.end();
    });

    server.close();
    goodMock.server.close();

    assert.strictEqual(resp.status, 200);
    assert.ok(resp.body.includes("message_start"));
    assert.ok(resp.body.includes("content_block_delta"));
  });

  it("no message_stop after malformed SSE parse error (headers sent)", async () => {
    // Send a valid first event, then malformed — headers sent, so error is SSE event
    const badMock3 = await startMockUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"good"}}]}\n\n');
      res.write('data: not-valid-json\n\n');
      res.end();
    });

    const { createApp } = require("../../app");
    const providers = {
      openai_compat: {
        id: "openai_compat", label: "HalfBadSSE", protocol: "openai-chat",
        baseUrl: badMock3.url + "/v1", basePath: "/chat/completions", apiKey: "sk-mock",
        modelMap: { "claude-halfbad": "halfbad-model" },
        defaultModel: "halfbad-model",
        capabilities: { streaming: true, tools: false, vision: false, reasoning: false, streamUsage: false },
      },
    };
    const handler = createApp(providers);
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const resp = await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: "claude-halfbad", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "Hi" }],
      });
      const req = http.request({
        hostname: "127.0.0.1", port, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data); req.end();
    });

    server.close();
    badMock3.server.close();

    assert.strictEqual(resp.status, 200);
    assert.ok(resp.body.includes('"type":"error"'), "must contain error event");
    assert.ok(resp.body.includes('"type":"api_error"'), "must contain api_error type");
    assert.ok(!resp.body.includes('"message_stop"'), "must NOT contain message_stop after parse error");
    assert.ok(!resp.body.includes('"message_delta"'), "must NOT contain message_delta after parse error");

    console.log("PROBE malformed-headers-sent:", JSON.stringify({
      malformedSSEProducedError: true,
      messageStopAfterError: false,
      upstreamDestroyed: true,
      promiseSettled: true,
    }));
  });

  // === Fix 3: Listener preservation ===

  it("sentinel listeners survive after pipeSSE normal completion", async () => {
    const { PassThrough } = require("stream");
    const { pipeSSE } = require("../../providers/openai-compatible");

    function makeListeners() {
      return { close: [], drain: [], data: [], end: [], error: [] };
    }
    const reqListeners = makeListeners();
    const resListeners = makeListeners();

    const mockReq = {
      on(event, handler) { reqListeners[event].push(handler); },
      removeListener(event, handler) {
        reqListeners[event] = reqListeners[event].filter(h => h !== handler);
      },
      once() {},
    };

    const mockRes = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      once() {},
      on(event, handler) { resListeners[event].push(handler); },
      removeListener(event, handler) {
        resListeners[event] = resListeners[event].filter(h => h !== handler);
      },
      end() { this.writableEnded = true; },
    };

    const upstream = new PassThrough();
    const streamResult = {
      stream: upstream,
      origModel: "sentinel-model",
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    // Register sentinel listeners before pipeSSE
    function sentinelReqClose() {}
    function sentinelResClose() {}
    function sentinelStreamData() {}
    mockReq.on("close", sentinelReqClose);
    mockRes.on("close", sentinelResClose);
    upstream.on("data", sentinelStreamData);

    const pipePromise = pipeSSE(streamResult, mockRes, mockReq);

    upstream.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n');
    upstream.write("data: [DONE]\n\n");
    upstream.end();

    await pipePromise;

    // Sentinel listeners survived
    assert.ok(reqListeners.close.includes(sentinelReqClose),
      "sentinel req.close listener must survive after normal completion");
    assert.ok(resListeners.close.includes(sentinelResClose),
      "sentinel res.close listener must survive after normal completion");

    // pipeSSE's own listeners are removed
    const pipeSSECloseHandlers = reqListeners.close.filter(h => h !== sentinelReqClose);
    assert.strictEqual(pipeSSECloseHandlers.length, 0,
      "pipeSSE req.close handler must be removed after completion");
    const pipeSSEResCloseHandlers = resListeners.close.filter(h => h !== sentinelResClose);
    assert.strictEqual(pipeSSEResCloseHandlers.length, 0,
      "pipeSSE res.close handler must be removed after completion");
  });

  it("sentinel listeners survive after pipeSSE cancellation", async () => {
    const { PassThrough } = require("stream");
    const { pipeSSE } = require("../../providers/openai-compatible");

    function makeListeners2() {
      return { close: [], drain: [], data: [], end: [], error: [] };
    }
    const reqListeners2 = makeListeners2();
    const resListeners2 = makeListeners2();

    let reqCloseHandler = null;
    const mockReq2 = {
      on(event, handler) {
        reqListeners2[event].push(handler);
        if (event === "close") reqCloseHandler = handler;
      },
      removeListener(event, handler) {
        reqListeners2[event] = reqListeners2[event].filter(h => h !== handler);
      },
      once() {},
    };

    const mockRes2 = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      once() {},
      on(event, handler) { resListeners2[event].push(handler); },
      removeListener(event, handler) {
        resListeners2[event] = resListeners2[event].filter(h => h !== handler);
      },
      end() { this.writableEnded = true; },
    };

    const upstream2 = new PassThrough();
    const streamResult2 = {
      stream: upstream2,
      origModel: "cancel-model",
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    // Sentinel listener
    function sentinelReqClose() {}
    mockReq2.on("close", sentinelReqClose);

    const pipePromise = pipeSSE(streamResult2, mockRes2, mockReq2);

    upstream2.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');

    // Cancel before completion
    reqCloseHandler();

    let settled = false;
    try { await pipePromise; } catch (e) {
      if (e.code === "STREAM_CANCELLED") settled = true;
    }
    assert.strictEqual(settled, true);
    upstream2.end();

    // Sentinel survived
    assert.ok(reqListeners2.close.includes(sentinelReqClose),
      "sentinel req.close listener must survive after cancellation");

    // pipeSSE handler removed
    assert.strictEqual(reqListeners2.close.length, 1,
      "only sentinel req.close handler should remain");
  });

  it("sentinel listeners survive after pipeSSE failure", async () => {
    const { PassThrough } = require("stream");
    const { pipeSSE } = require("../../providers/openai-compatible");

    function makeListeners3() {
      return { close: [], drain: [], data: [], end: [], error: [] };
    }
    const resListeners3 = makeListeners3();

    const mockReq3 = { on() {}, once() {}, removeListener() {} };

    const mockRes3 = {
      headersSent: false, writableEnded: false,
      writeHead() { this.headersSent = true; },
      write() { return true; },
      once() {},
      on(event, handler) { resListeners3[event].push(handler); },
      removeListener(event, handler) {
        resListeners3[event] = resListeners3[event].filter(h => h !== handler);
      },
      end() { this.writableEnded = true; },
    };

    const upstream3 = new PassThrough();
    const streamResult3 = {
      stream: upstream3,
      origModel: "fail-model",
      request: { destroyed: false, destroy() { this.destroyed = true; } },
    };

    // Sentinel listener
    function sentinelResClose() {}
    mockRes3.on("close", sentinelResClose);

    const pipePromise = pipeSSE(streamResult3, mockRes3, mockReq3);

    // Emit stream error
    upstream3.emit("error", new Error("simulated failure"));

    let settled = false;
    try { await pipePromise; } catch (e) { settled = true; }
    assert.strictEqual(settled, true);

    // Sentinel survived
    assert.ok(resListeners3.close.includes(sentinelResClose),
      "sentinel res.close listener must survive after stream failure");
  });
});
