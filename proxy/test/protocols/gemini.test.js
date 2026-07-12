"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const protocol = require("../../protocols/gemini.js");

describe("anthropicToGeminiContents", () => {
  it("converts simple text message", () => {
    const parsed = {
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    assert.strictEqual(result.contents.length, 1);
    assert.strictEqual(result.contents[0].role, "user");
    assert.strictEqual(result.contents[0].parts[0].text, "Hello");
  });

  it("maps assistant role to model", () => {
    const parsed = {
      messages: [{ role: "assistant", content: "Response" }],
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    assert.strictEqual(result.contents[0].role, "model");
  });

  it("converts system messages to systemInstruction", () => {
    const parsed = {
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hi" },
      ],
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    assert.strictEqual(result.contents.length, 1);
    assert.ok(result.systemInstruction);
    assert.strictEqual(result.systemInstruction.parts[0].text, "Be helpful.");
  });

  it("converts system message arrays", () => {
    const parsed = {
      messages: [
        { role: "system", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
        { role: "user", content: "Hi" },
      ],
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    assert.strictEqual(result.systemInstruction.parts.length, 2);
  });

  it("converts image blocks", () => {
    const parsed = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
      }],
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    assert.strictEqual(result.contents[0].parts.length, 2);
    assert.strictEqual(result.contents[0].parts[0].text, "Describe");
    assert.strictEqual(result.contents[0].parts[1].inlineData.mimeType, "image/png");
    assert.strictEqual(result.contents[0].parts[1].inlineData.data, "abc123");
  });

  it("converts tool_use to JSON text", () => {
    const parsed = {
      messages: [{
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "test" } }],
      }],
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    const text = result.contents[0].parts[0].text;
    const parsed2 = JSON.parse(text);
    assert.strictEqual(parsed2.type, "tool_use");
    assert.strictEqual(parsed2.name, "search");
  });

  it("converts tool_result to JSON text", () => {
    const parsed = {
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }],
      }],
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    const text = result.contents[0].parts[0].text;
    const parsed2 = JSON.parse(text);
    assert.strictEqual(parsed2.type, "tool_result");
    assert.strictEqual(parsed2.tool_use_id, "t1");
  });

  it("sets generationConfig with temperature, top_p, max_tokens", () => {
    const parsed = {
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 500,
      temperature: 0.7,
      top_p: 0.9,
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    assert.strictEqual(result.generationConfig.maxOutputTokens, 500);
    assert.strictEqual(result.generationConfig.temperature, 0.7);
    assert.strictEqual(result.generationConfig.topP, 0.9);
  });

  it("caps maxOutputTokens at 8192", () => {
    const parsed = {
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 16000,
    };
    const result = protocol.anthropicToGeminiContents(parsed);
    assert.strictEqual(result.generationConfig.maxOutputTokens, 8192);
  });
});

describe("geminiToAnthropicResponse", () => {
  it("maps text response", () => {
    const geminiResp = {
      candidates: [{ content: { parts: [{ text: "Hello!" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    };
    const result = protocol.geminiToAnthropicResponse(geminiResp, "test");
    assert.strictEqual(result.content[0].text, "Hello!");
    assert.strictEqual(result.stop_reason, "end_turn");
    assert.strictEqual(result.usage.input_tokens, 10);
    assert.strictEqual(result.usage.output_tokens, 5);
  });

  it("maps MAX_TOKENS to max_tokens stop reason", () => {
    const geminiResp = {
      candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }],
    };
    const result = protocol.geminiToAnthropicResponse(geminiResp, "test");
    assert.strictEqual(result.stop_reason, "max_tokens");
  });

  it("returns empty text for empty response", () => {
    const geminiResp = {
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: {},
    };
    const result = protocol.geminiToAnthropicResponse(geminiResp, "test");
    assert.strictEqual(result.content[0].text, "");
  });

  it("handles missing usage metadata", () => {
    const geminiResp = {
      candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }],
    };
    const result = protocol.geminiToAnthropicResponse(geminiResp, "test");
    assert.strictEqual(result.usage.input_tokens, 0);
  });
});

describe("GeminiSSEState", () => {
  it("emits message_start and content on first chunk", () => {
    const state = new protocol.GeminiSSEState("test");
    const events = state.transform({
      candidates: [{ content: { parts: [{ text: "H" }] } }],
    });
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].type, "message_start");
    assert.strictEqual(events[1].type, "content_block_start");
    assert.strictEqual(events[2].type, "content_block_delta");
  });

  it("emits delta for subsequent text chunks", () => {
    const state = new protocol.GeminiSSEState("test");
    state.transform({ candidates: [{ content: { parts: [{ text: "H" }] } }] });
    const events = state.transform({
      candidates: [{ content: { parts: [{ text: "i" }] } }],
    });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, "content_block_delta");
  });

  it("emits complete stop sequence on finish", () => {
    const state = new protocol.GeminiSSEState("test");
    state.transform({ candidates: [{ content: { parts: [{ text: "H" }] } }] });
    const events = state.transform({
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
    });
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].type, "content_block_stop");
    assert.strictEqual(events[1].type, "message_delta");
    assert.strictEqual(events[2].type, "message_stop");
  });
});
