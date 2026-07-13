"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { send } = require("../../providers/openai-compatible");

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function baseProvider(baseUrl, overrides = {}) {
  return {
    id: "xai",
    protocol: "openai-chat",
    baseUrl,
    basePath: "/chat/completions",
    tokenizePath: "/tokenize-text",
    apiKey: "xai-mock",
    reasoningEffort: "low",
    modelMap: { "claude-opus-4-9": "grok-4.5" },
    defaultModel: "grok-4.5",
    capabilities: {
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      vision: false,
      reasoning: true,
      streamUsage: true,
    },
    ...overrides,
  };
}

function baseParsed(overrides = {}) {
  return {
    model: "claude-opus-4-9",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
    stream: false,
    ...overrides,
  };
}

describe("OpenAI-compatible provider — token counting", () => {
  it("uses xAI tokenize-text instead of chat completions", async () => {
    let receivedPath;
    let receivedBody;
    let authorization;
    const mock = await startMockServer((req, res) => {
      receivedPath = req.url;
      authorization = req.headers.authorization;
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token_ids: [{ token_id: 1 }, { token_id: 2 }, { token_id: 3 }] }));
      });
    });

    const result = await send(
      baseProvider(mock.url),
      baseParsed(),
      "claude-opus-4-9",
      "/v1/messages/count_tokens?beta=true"
    );

    assert.strictEqual(receivedPath, "/tokenize-text");
    assert.strictEqual(authorization, "Bearer xai-mock");
    assert.strictEqual(receivedBody.model, "grok-4.5");
    assert.ok(receivedBody.text.includes("Hello"));
    assert.deepStrictEqual(result.body, { input_tokens: 3 });
    mock.server.close();
  });

  it("uses a local estimate when the provider has no tokenizer endpoint", async () => {
    const provider = baseProvider("http://unused.invalid", { id: "generic", tokenizePath: undefined });
    const result = await send(
      provider,
      baseParsed(),
      "claude-opus-4-9",
      "/v1/messages/count_tokens"
    );

    assert.strictEqual(result.status, 200);
    assert.ok(result.body.input_tokens > 0);
  });
});

describe("OpenAI-compatible provider — xAI request", () => {
  it("sends low reasoning effort by default", async () => {
    let receivedBody;
    const mock = await startMockServer((req, res) => {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "working" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }));
      });
    });

    const result = await send(baseProvider(mock.url), baseParsed(), "claude-opus-4-9", "/v1/messages");
    assert.strictEqual(receivedBody.reasoning_effort, "low");
    assert.strictEqual(result.body.content[0].text, "working");
    mock.server.close();
  });
});
