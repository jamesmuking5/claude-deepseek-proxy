"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { describeImages, stripImagesAndInjectDescription, hasImages } = require("../../providers/gemini");

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
    id: "gemini",
    protocol: "gemini",
    baseUrl: mockUrl,
    basePath: "",
    model: "gemini-2.0-flash",
    apiKey: "fake-key",
    capabilities: { streaming: false, tools: false, vision: true, reasoning: false },
  };
}

describe("describeImages — Gemini provider", () => {
  it("returns description for successful image response", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: "A cat sitting on a windowsill" }] },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
      }));
    });
    const provider = baseProvider(mock.url);
    const parsed = {
      messages: [{ role: "user", content: [
        { type: "text", text: "Describe" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
      ]}],
    };
    const result = await describeImages(provider, parsed);
    assert.strictEqual(result, "A cat sitting on a windowsill");
    mock.server.close();
  });

  it("returns empty string on HTTP error", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Overloaded" } }));
    });
    const provider = baseProvider(mock.url);
    const parsed = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] };
    const result = await describeImages(provider, parsed);
    assert.strictEqual(result, "");
    mock.server.close();
  });

  it("returns empty string on 4xx", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const provider = baseProvider(mock.url);
    const result = await describeImages(provider, { messages: [{ role: "user", content: "Hi" }] });
    assert.strictEqual(result, "");
    mock.server.close();
  });

  it("returns empty string on malformed JSON", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json");
    });
    const provider = baseProvider(mock.url);
    const result = await describeImages(provider, { messages: [{ role: "user", content: "Hi" }] });
    assert.strictEqual(result, "");
    mock.server.close();
  });

  it("returns empty string on missing candidates", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    });
    const provider = baseProvider(mock.url);
    const result = await describeImages(provider, { messages: [{ role: "user", content: "Hi" }] });
    assert.strictEqual(result, "");
    mock.server.close();
  });

  it("returns empty string on missing content parts", async () => {
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates: [{}] }));
    });
    const provider = baseProvider(mock.url);
    const result = await describeImages(provider, { messages: [{ role: "user", content: "Hi" }] });
    assert.strictEqual(result, "");
    mock.server.close();
  });

  it("connection error propagates as rejection", async () => {
    const provider = baseProvider("http://127.0.0.1:19999");
    try {
      await describeImages(provider, { messages: [{ role: "user", content: "Hi" }] });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e.message.includes("ECONNREFUSED") || e.message.includes("connect"),
        "connection error must propagate");
    }
  });
});

describe("stripImagesAndInjectDescription", () => {
  it("injects description into message with images", () => {
    const parsed = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      }],
    };
    stripImagesAndInjectDescription(parsed, "A cat on a windowsill");
    assert.strictEqual(parsed.messages[0].content.length, 1);
    assert.strictEqual(parsed.messages[0].content[0].type, "text");
    assert.ok(parsed.messages[0].content[0].text.includes("cat"));
    assert.ok(parsed.messages[0].content[0].text.includes("What is this?"));
  });

  it("injects description when no user text present", () => {
    const parsed = {
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      }],
    };
    stripImagesAndInjectDescription(parsed, "Photo of a dog");
    assert.strictEqual(parsed.messages[0].content[0].text, "Photo of a dog");
  });

  it("uses fallback text when description empty", () => {
    const parsed = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Explain" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      }],
    };
    stripImagesAndInjectDescription(parsed, "");
    assert.ok(parsed.messages[0].content[0].text.includes("[Immagine non analizzabile]"));
  });

  it("uses fallback text when description null", () => {
    const parsed = {
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
      }],
    };
    stripImagesAndInjectDescription(parsed, null);
    assert.strictEqual(parsed.messages[0].content[0].text, "Immagine caricata");
  });

  it("skips messages without content array", () => {
    const parsed = {
      messages: [{ role: "user", content: "plain text" }],
    };
    stripImagesAndInjectDescription(parsed, "ignored");
    assert.strictEqual(parsed.messages[0].content, "plain text");
  });

  it("preserves non-image, non-text blocks in content", () => {
    const parsed = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Check" },
          { type: "tool_result", tool_use_id: "t1", content: "result" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      }],
    };
    stripImagesAndInjectDescription(parsed, "Description");
    // tool_result preserved, image removed, text+description prepended
    const types = parsed.messages[0].content.map(c => c.type);
    assert.ok(types.includes("tool_result"), "non-image non-text blocks preserved");
    assert.ok(types.includes("text"));
    assert.strictEqual(types.filter(t => t === "image").length, 0, "image blocks removed");
  });
});

describe("hasImages", () => {
  it("returns true when messages contain images", () => {
    const parsed = {
      messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
    };
    assert.strictEqual(hasImages(parsed), true);
  });

  it("returns false when no images", () => {
    const parsed = {
      messages: [{ role: "user", content: "text only" }],
    };
    assert.strictEqual(hasImages(parsed), false);
  });

  it("returns false for empty messages array", () => {
    assert.strictEqual(hasImages({}), false);
  });
});
