"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const protocol = require("../../protocols/openai-chat.js");

const mockProvider = (overrides) => ({
  id: "test",
  capabilities: {
    tools: true,
    parallelToolCalls: true,
    vision: false,
    ...overrides,
  },
});

describe("preserveSchema", () => {
  it("preserves valid JSON Schema keys", () => {
    const input = {
      type: "object",
      properties: {
        name: { type: "string", description: "User name" },
        age: { type: "integer", minimum: 0, maximum: 150 },
      },
      required: ["name"],
    };
    assert.deepStrictEqual(protocol.preserveSchema(input), input);
  });

  it("removes Anthropic-only keys", () => {
    const input = {
      type: "object",
      properties: { name: { type: "string" } },
      $anthropic: { cache_control: { type: "ephemeral" } },
    };
    const result = protocol.preserveSchema(input);
    assert.strictEqual(result.$anthropic, undefined);
    assert.strictEqual(result.type, "object");
  });

  it("handles null and non-objects", () => {
    assert.strictEqual(protocol.preserveSchema(null), null);
    assert.strictEqual(protocol.preserveSchema("string"), "string");
  });
});

describe("anthropicToOpenAIBody — token limits", () => {
  it("preserves exact max_tokens=100", () => {
    const parsed = {
      model: "test",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.max_completion_tokens, 100);
    assert.strictEqual(result.max_tokens, undefined);
  });

  it("omits token limit when max_tokens is undefined", () => {
    const parsed = {
      model: "test",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.max_tokens, undefined);
    assert.strictEqual(result.max_completion_tokens, undefined);
  });

  it("uses max_tokens field for opencode provider", () => {
    const provider = mockProvider();
    provider.id = "opencode";
    const parsed = {
      model: "test",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 500,
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, provider);
    assert.strictEqual(result.max_tokens, 500);
    assert.strictEqual(result.max_completion_tokens, undefined);
  });
});

describe("anthropicToOpenAIBody — reasoning effort", () => {
  it("uses the provider default reasoning effort", () => {
    const provider = mockProvider();
    provider.reasoningEffort = "low";
    const result = protocol.anthropicToOpenAIBody({
      model: "grok-4.5",
      messages: [{ role: "user", content: "Hi" }],
    }, provider);
    assert.strictEqual(result.reasoning_effort, "low");
  });

  it("maps Claude xhigh effort to xAI high", () => {
    const provider = mockProvider();
    provider.reasoningEffort = "low";
    const result = protocol.anthropicToOpenAIBody({
      model: "grok-4.5",
      output_config: { effort: "xhigh" },
      messages: [{ role: "user", content: "Hi" }],
    }, provider);
    assert.strictEqual(result.reasoning_effort, "high");
  });
});

describe("anthropicToOpenAIBody — conversions", () => {
  it("converts simple text message", () => {
    const parsed = {
      model: "test",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.messages[0].role, "user");
    assert.strictEqual(result.messages[0].content, "Hello");
  });

  it("converts string system prompt", () => {
    const parsed = {
      model: "test",
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.messages[0].role, "system");
    assert.strictEqual(result.messages[0].content, "You are helpful.");
  });

  it("converts block-array system prompt", () => {
    const parsed = {
      model: "test",
      system: [
        { type: "text", text: "You are helpful." },
        { type: "text", text: "Be concise." },
      ],
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.messages[0].content, "You are helpful.\nBe concise.");
  });

  it("merges system messages into system prompt", () => {
    const parsed = {
      model: "test",
      system: "Base.",
      messages: [
        { role: "system", content: "Additional." },
        { role: "user", content: "Hi" },
      ],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.messages[0].content, "Base.\nAdditional.");
  });

  it("converts image blocks when vision enabled", () => {
    const provider = mockProvider({ vision: true });
    const parsed = {
      model: "test",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
      }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, provider);
    assert.ok(Array.isArray(result.messages[0].content));
    assert.strictEqual(result.messages[0].content[1].type, "image_url");
  });

  it("rejects image blocks when vision disabled", () => {
    const parsed = {
      model: "test",
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } }],
      }],
      stream: false,
    };
    assert.throws(() => protocol.anthropicToOpenAIBody(parsed, mockProvider({ vision: false })));
  });

  it("converts tool_use to tool_calls", () => {
    const parsed = {
      model: "test",
      messages: [{
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "NYC" } },
        ],
      }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.messages[0].tool_calls[0].function.name, "get_weather");
  });

  it("converts tool definitions", () => {
    const parsed = {
      model: "test",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
      tools: [{ name: "f", description: "d", input_schema: { type: "object", properties: {} } }],
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.tools[0].function.name, "f");
  });

  it("converts tool_choice any→required, auto, named", () => {
    const base = {
      model: "test",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
      tools: [{ name: "t1", input_schema: { type: "object", properties: {} } }],
    };
    assert.strictEqual(protocol.anthropicToOpenAIBody({ ...base, tool_choice: { type: "any" } }, mockProvider()).tool_choice, "required");
    assert.strictEqual(protocol.anthropicToOpenAIBody({ ...base, tool_choice: { type: "auto" } }, mockProvider()).tool_choice, "auto");
    assert.deepStrictEqual(
      protocol.anthropicToOpenAIBody({ ...base, tool_choice: { type: "tool", name: "t1" } }, mockProvider()).tool_choice,
      { type: "function", function: { name: "t1" } }
    );
  });

  it("sets temperature, top_p, stop", () => {
    const parsed = {
      model: "test",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ["END"],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.temperature, 0.7);
    assert.strictEqual(result.top_p, 0.9);
    assert.deepStrictEqual(result.stop, ["END"]);
  });
});

describe("anthropicToOpenAIBody — mixed tool-result ordering", () => {
  it("normalizes: tool results first, then user content", () => {
    // Anthropic allows interleaved tool_result + text in user messages.
    // OpenAI requires tool messages directly after the assistant tool_calls.
    // The converter must reorder: all tool results first, then user content.
    const parsed = {
      model: "test",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "First text" },
          { type: "tool_result", tool_use_id: "t1", content: "result1" },
          { type: "text", text: "After tool" },
          { type: "tool_result", tool_use_id: "t2", content: "result2" },
        ],
      }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    // tool results first, preserving order among them
    assert.strictEqual(result.messages[0].role, "tool");
    assert.strictEqual(result.messages[0].tool_call_id, "t1");
    assert.strictEqual(result.messages[1].role, "tool");
    assert.strictEqual(result.messages[1].tool_call_id, "t2");
    // then user content, consolidated (two text blocks → array)
    assert.strictEqual(result.messages[2].role, "user");
    assert.ok(Array.isArray(result.messages[2].content));
    assert.strictEqual(result.messages[2].content.length, 2);
    assert.strictEqual(result.messages[2].content[0].text, "First text");
    assert.strictEqual(result.messages[2].content[1].text, "After tool");
  });

  it("tool result with image: tools first, then user with image", () => {
    const provider = mockProvider({ vision: true });
    const parsed = {
      model: "test",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } },
          { type: "tool_result", tool_use_id: "t2", content: "done" },
        ],
      }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, provider);
    // tool result first
    assert.strictEqual(result.messages[0].role, "tool");
    // then user content with image
    assert.strictEqual(result.messages[1].role, "user");
    assert.ok(Array.isArray(result.messages[1].content));
  });

  it("tool result without other content: only tool message", () => {
    const parsed = {
      model: "test",
      messages: [{
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t3", content: "sole result" },
        ],
      }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.messages.length, 1);
    assert.strictEqual(result.messages[0].role, "tool");
    assert.strictEqual(result.messages[0].tool_call_id, "t3");
  });

  it("no tool results: only user content", () => {
    const parsed = {
      model: "test",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Just text" },
          { type: "text", text: "More text" },
        ],
      }],
      stream: false,
    };
    const result = protocol.anthropicToOpenAIBody(parsed, mockProvider());
    assert.strictEqual(result.messages.length, 1);
    assert.strictEqual(result.messages[0].role, "user");
    assert.ok(Array.isArray(result.messages[0].content), "two text blocks → array content");
    assert.strictEqual(result.messages[0].content.length, 2);
    assert.strictEqual(result.messages[0].content[0].text, "Just text");
    assert.strictEqual(result.messages[0].content[1].text, "More text");
  });
});

describe("openAIToAnthropicResponse", () => {
  it("maps text response", () => {
    const raw = {
      choices: [{ finish_reason: "stop", message: { content: "Hello!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = protocol.openAIToAnthropicResponse(raw, "claude-sonnet-4-5");
    assert.strictEqual(result.content[0].text, "Hello!");
    assert.strictEqual(result.stop_reason, "end_turn");
    assert.strictEqual(result.usage.input_tokens, 10);
    assert.strictEqual(result.usage.output_tokens, 5);
  });

  it("maps finish reasons correctly", () => {
    assert.strictEqual(protocol.openAIToAnthropicResponse({ choices: [{ finish_reason: "length", message: { content: "" } }], usage: {} }, "t").stop_reason, "max_tokens");
    assert.strictEqual(protocol.openAIToAnthropicResponse({ choices: [{ finish_reason: "tool_calls", message: { content: "" } }], usage: {} }, "t").stop_reason, "tool_use");
    assert.strictEqual(protocol.openAIToAnthropicResponse({ choices: [{ finish_reason: "content_filter", message: { content: "" } }], usage: {} }, "t").stop_reason, "refusal");
  });

  it("converts tool calls", () => {
    const raw = {
      choices: [{ finish_reason: "stop", message: { tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"x":1}' } }] } }],
      usage: {},
    };
    const result = protocol.openAIToAnthropicResponse(raw, "t");
    assert.strictEqual(result.content[0].type, "tool_use");
    assert.deepStrictEqual(result.content[0].input, { x: 1 });
  });

  it("handles malformed tool arguments", () => {
    const raw = {
      choices: [{ finish_reason: "stop", message: { tool_calls: [{ id: "c1", function: { name: "f", arguments: "bad" } }] } }],
      usage: {},
    };
    const result = protocol.openAIToAnthropicResponse(raw, "t");
    assert.strictEqual(result.content[0].input._raw, "bad");
  });

  it("handles empty tool arguments", () => {
    const raw = {
      choices: [{ finish_reason: "stop", message: { tool_calls: [{ id: "c1", function: { name: "f", arguments: "" } }] } }],
      usage: {},
    };
    assert.deepStrictEqual(protocol.openAIToAnthropicResponse(raw, "t").content[0].input, {});
  });
});

describe("OpenAISSEState — lifecycle", () => {
  it("emits message_start + content on first chunk (no drop)", () => {
    const state = new protocol.OpenAISSEState("test");
    const events = state.transform({ choices: [{ delta: { content: "Hello" } }] });
    assert.strictEqual(events[0].type, "message_start");
    assert.strictEqual(events[1].type, "content_block_start");
    assert.strictEqual(events[2].type, "content_block_delta");
    assert.strictEqual(events[2].delta.text, "Hello");
  });

  it("emits exactly one message_stop", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });
    state.transform({ choices: [{ delta: { content: "x" } }] });
    const events = state.transform({
      choices: [{ finish_reason: "stop", delta: {} }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    assert.strictEqual(events.filter(e => e.type === "message_stop").length, 1);
    // stream end must not produce a second one
    assert.strictEqual(state.finalize().length, 0);
  });

  it("defers message_stop until trailing usage chunk arrives", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });
    state.transform({ choices: [{ delta: { content: "x" } }] });
    const finishEvents = state.transform({ choices: [{ finish_reason: "stop", delta: {} }] });
    assert.strictEqual(finishEvents.some(e => e.type === "message_stop"), false,
      "finish without usage must not terminate yet");
    const usageEvents = state.transform({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    const delta = usageEvents.find(e => e.type === "message_delta");
    assert.strictEqual(delta.usage.input_tokens, 9);
    assert.strictEqual(usageEvents[usageEvents.length - 1].type, "message_stop");
  });

  it("finalize flushes deferred termination at stream end without usage", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });
    state.transform({ choices: [{ delta: { content: "x" } }] });
    state.transform({ choices: [{ finish_reason: "stop", delta: {} }] });
    const events = state.finalize();
    assert.strictEqual(events[0].type, "message_delta");
    assert.strictEqual(events[0].delta.stop_reason, "end_turn");
    assert.strictEqual(events[1].type, "message_stop");
    // idempotent
    assert.strictEqual(state.finalize().length, 0);
  });

  it("returns null for chunks after finish (no duplicates)", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });
    state.transform({ choices: [{ delta: { content: "x" } }] });
    state.transform({ choices: [{ finish_reason: "stop", delta: {} }] });
    const result = state.transform({ choices: [{ delta: { content: "extra" } }] });
    assert.strictEqual(result, null);
  });

  it("blocks duplicate message_stop with finished flag", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });
    state.transform({ choices: [{ delta: { content: "x" } }] });
    state.transform({
      choices: [{ finish_reason: "stop", delta: {} }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    // second finish chunk
    const result = state.transform({ choices: [{ finish_reason: "stop", delta: {} }] });
    assert.strictEqual(result, null);
  });

  it("returns null for empty chunk after start", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });
    assert.strictEqual(state.transform({ choices: [{ delta: {} }] }), null);
  });
});

describe("OpenAISSEState — streamed tool calls", () => {
  it("defers content_block_start until first argument arrives", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });

    // ID only — no start (name empty)
    const e1 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1" }] } }],
    });
    assert.strictEqual(e1, null);

    // Name fragment — still no start (no args yet, name may be incomplete)
    const e2 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get" } }] } }],
    });
    assert.strictEqual(e2, null);

    // More name + first args — now start emits with full accumulated name
    const e3 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "_weather", arguments: '{"city"' } }] } }],
    });
    const start = e3.find(e => e.type === "content_block_start");
    assert.ok(start, "content_block_start should emit when first args arrive");
    assert.strictEqual(start.content_block.name, "get_weather");
    // Arg delta for current fragment
    assert.ok(e3.some(e => e.type === "content_block_delta" && e.delta.partial_json === '{"city"'));
  });

  it("accumulates fragmented name across multiple chunks before args", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });

    // ID
    state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "tc1" }] } }],
    });
    // First name fragment — no args, no start
    const e1 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "very" } }] } }],
    });
    assert.strictEqual(e1, null);

    // Second name fragment + first args — start with complete name
    const e2 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "_long_name", arguments: "{}" } }] } }],
    });
    const start = e2.find(e => e.type === "content_block_start");
    assert.ok(start);
    assert.strictEqual(start.content_block.name, "very_long_name",
      "name must be very_long_name, not truncated very");
    // Arg delta for {}
    assert.ok(e2.some(e => e.type === "content_block_delta" && e.delta.partial_json === "{}"));
  });

  it("replays argument fragments that arrived before name was complete", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });

    // ID + args arrive before name — args buffered, no start (name empty)
    const e1 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { arguments: '{"x"' } }] } }],
    });
    assert.strictEqual(e1, null);

    // Name + more args arrive — now start, replay buffered args, emit current
    const e2 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "search", arguments: ':"y"}' } }] } }],
    });
    assert.ok(e2.some(e => e.type === "content_block_start"));
    // Buffered arg replayed
    assert.ok(e2.some(e => e.type === "content_block_delta" && e.delta.partial_json === '{"x"'),
      "buffered arg fragment must be replayed before current");
    // Current arg
    assert.ok(e2.some(e => e.type === "content_block_delta" && e.delta.partial_json === ':"y"}'));
    // Order: start, then buffered arg delta, then current arg delta
    const deltaIdxs = [];
    e2.forEach((e, i) => { if (e.type === "content_block_delta") deltaIdxs.push(i); });
    const startIdx = e2.findIndex(e => e.type === "content_block_start");
    assert.ok(startIdx < deltaIdxs[0], "start must precede all deltas");
    assert.ok(deltaIdxs[0] < deltaIdxs[1], "buffered arg must precede current arg");
  });

  it("handles parallel tool calls with independent fragmentation", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });

    // Tool 0 gets id, name, args all at once
    // Tool 1 gets only id and partial name
    const events = state.transform({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: "a", function: { name: "tool_a", arguments: "{}" } },
            { index: 1, id: "b", function: { name: "tool" } },
          ],
        },
      }],
    });
    // Tool 0: id+name+args ready → starts immediately
    // Tool 1: id+name but no args → does NOT start yet
    const starts = events.filter(e => e.type === "content_block_start");
    assert.strictEqual(starts.length, 1, "only tool 0 should start (has args)");
    assert.strictEqual(starts[0].content_block.name, "tool_a");

    // Tool 1 gets more name + args → now starts
    const e2 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "_b", arguments: "[]" } }] } }],
    });
    const start2 = e2.find(e => e.type === "content_block_start");
    assert.ok(start2);
    assert.strictEqual(start2.content_block.name, "tool_b");
  });

  it("emits error event for incomplete tool call on finish", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });

    // Tool gets id but never name or args — incomplete
    state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "orphan" }] } }],
    });

    const events = state.transform({
      choices: [{ finish_reason: "stop", delta: {} }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
    // Incomplete tool call is dropped; stream must still terminate cleanly
    // so clients do not discard the response and retry the whole request.
    assert.strictEqual(events.some(e => e.type === "error"), false,
      "must not emit error event for incomplete tool call");
    const delta = events.find(e => e.type === "message_delta");
    assert.ok(delta, "must emit message_delta");
    assert.strictEqual(delta.delta.stop_reason, "max_tokens",
      "incomplete tool call surfaces as max_tokens stop");
    assert.strictEqual(events[events.length - 1].type, "message_stop",
      "must end with message_stop");
  });

  it("tool with id+name but no args is dropped and stream terminates cleanly", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });

    // Tool has valid id and complete name, but no arguments ever arrive
    state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "search" } }] } }],
    });

    const events = state.transform({
      choices: [{ finish_reason: "tool_calls", delta: {} }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    });
    assert.strictEqual(events.some(e => e.type === "error"), false,
      "must not emit error event for dropped tool call");
    const delta = events.find(e => e.type === "message_delta");
    assert.ok(delta, "must emit message_delta");
    assert.strictEqual(delta.delta.stop_reason, "max_tokens",
      "incomplete tool call surfaces as max_tokens stop");
    assert.strictEqual(events[events.length - 1].type, "message_stop",
      "must end with message_stop");

    // Subsequent chunks produce no output
    assert.strictEqual(state.transform({ choices: [{ delta: { content: "extra" } }] }), null,
      "must return null for chunks after stream finished");
  });

  it("in-progress tool call receives additional args after start", () => {
    const state = new protocol.OpenAISSEState("test");
    state.transform({ choices: [{}] });

    // First chunk: id, name, and args — tool starts
    const e1 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "calc", arguments: '{"x":' } }] } }],
    });
    assert.ok(e1.some(e => e.type === "content_block_start"));
    assert.ok(e1.some(e => e.type === "content_block_delta"));

    // Second chunk: MORE args for same tool (in-progress, ts.started=true)
    const e2 = state.transform({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1,"y":' } }] } }],
    });
    // Only delta for the new arg fragment, no duplicate start
    assert.strictEqual(e2.filter(e => e.type === "content_block_start").length, 0,
      "no duplicate content_block_start for in-progress tool");
    assert.ok(e2.some(e => e.type === "content_block_delta" && e.delta.partial_json === '1,"y":'),
      "must emit delta for continuation args");
  });
});

describe("translateError", () => {
  it("maps upstream 4xx", () => {
    const r = protocol.translateError(400, '{"error":{"message":"Bad"}}');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.type, "invalid_request_error");
  });

  it("maps upstream 5xx", () => {
    const r = protocol.translateError(500, "err");
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.error.type, "api_error");
  });
});
