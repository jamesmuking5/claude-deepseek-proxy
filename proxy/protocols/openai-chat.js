"use strict";

const ANTHROPIC_ONLY_SCHEMA_KEYS = new Set([
  "$anthropic",
  "x-anthropic",
  "anthropic",
]);

const FINISH_MAP = {
  "stop": "end_turn",
  "length": "max_tokens",
  "tool_calls": "tool_use",
  "function_call": "tool_use",
  "content_filter": "refusal",
};

function simplifyContent(parts) {
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function preserveSchema(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(preserveSchema);

  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (ANTHROPIC_ONLY_SCHEMA_KEYS.has(k)) continue;
    cleaned[k] = preserveSchema(v);
  }
  return cleaned;
}

function anthropicToOpenAIBody(parsed, provider) {
  const openAIMessages = [];
  let systemContent = "";

  if (parsed.system) {
    if (typeof parsed.system === "string") {
      systemContent = parsed.system;
    } else if (Array.isArray(parsed.system)) {
      for (const block of parsed.system) {
        if (block.type === "text") {
          systemContent += (systemContent ? "\n" : "") + block.text;
        } else {
          const err = new Error("Unsupported system content block type: " + block.type);
          err.status = 400;
          err.type = "invalid_request_error";
          throw err;
        }
      }
    }
  }

  for (const msg of parsed.messages || []) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      systemContent += (systemContent ? "\n" : "") + text;
      continue;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        openAIMessages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolResults = [];
        const contentParts = [];
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            const content = typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
            toolResults.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: content,
            });
          } else if (block.type === "text") {
            contentParts.push({ type: "text", text: block.text });
          } else if (block.type === "image" && block.source) {
            if (!provider.capabilities.vision) {
              const err = new Error("Vision is not supported by this provider");
              err.status = 400;
              err.type = "invalid_request_error";
              throw err;
            }
            const mime = block.source.media_type || "image/jpeg";
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${mime};base64,${block.source.data}` },
            });
          }
        }
        for (const tr of toolResults) {
          openAIMessages.push(tr);
        }
        if (contentParts.length > 0) {
          openAIMessages.push({ role: "user", content: simplifyContent(contentParts) });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        openAIMessages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        const toolCalls = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "tool_use") {
            if (!provider.capabilities.tools) {
              const err = new Error("Tool use is not supported by this provider");
              err.status = 400;
              err.type = "invalid_request_error";
              throw err;
            }
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input || {}),
              },
            });
          }
        }
        const entry = { role: "assistant" };
        if (textParts.length > 0) entry.content = textParts.join("\n");
        else entry.content = null;
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;
        openAIMessages.push(entry);
      }
    }
  }

  if (systemContent) {
    openAIMessages.unshift({ role: "system", content: systemContent });
  }

  const body = {
    model: parsed.model,
    messages: openAIMessages,
    stream: !!parsed.stream,
  };

  const maxTokens = parsed.max_tokens;
  if (maxTokens !== undefined && maxTokens > 0) {
    if (provider.id === "opencode") {
      body.max_tokens = maxTokens;
    } else {
      body.max_completion_tokens = maxTokens;
    }
  }

  if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) body.top_p = parsed.top_p;
  if (parsed.stop_sequences && parsed.stop_sequences.length > 0) {
    body.stop = parsed.stop_sequences;
  }

  if (parsed.tools && Array.isArray(parsed.tools)) {
    if (!provider.capabilities.tools) {
      const err = new Error("Tool use is not supported by this provider");
      err.status = 400;
      err.type = "invalid_request_error";
      throw err;
    }
    body.tools = parsed.tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: preserveSchema(t.input_schema),
      },
    }));

    if (parsed.tool_choice) {
      const tc = parsed.tool_choice;
      if (tc.type === "any") {
        body.tool_choice = "required";
      } else if (tc.type === "auto") {
        body.tool_choice = "auto";
      } else if (tc.type === "tool" && tc.name) {
        body.tool_choice = { type: "function", function: { name: tc.name } };
      }
    }
  }

  return body;
}

function openAIToAnthropicResponse(raw, origModel) {
  const choice = raw.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input = {};
      if (tc.function && tc.function.arguments) {
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = { _raw: tc.function.arguments };
        }
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name || "unknown",
        input: input,
      });
    }
  }

  const finishReason = choice.finish_reason || "stop";
  const usage = raw.usage || {};

  return {
    id: "msg_" + Math.random().toString(36).substring(2, 15),
    type: "message",
    role: "assistant",
    model: origModel,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: FINISH_MAP[finishReason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

class OpenAISSEState {
  constructor(origModel) {
    this.origModel = origModel;
    this.started = false;
    this.finished = false;
    this.blockIndex = 0;
    this.toolStates = [];
    this.activeTextBlock = -1;
  }

  transform(chunk) {
    if (this.finished) return null;

    const choice = chunk.choices?.[0] || {};
    const delta = choice.delta || {};
    const finishReason = choice.finish_reason;
    const text = delta.content || "";
    const toolCalls = delta.tool_calls || [];

    const events = [];

    if (!this.started) {
      this.started = true;
      events.push({
        type: "message_start",
        message: {
          id: "msg_" + Math.random().toString(36).substring(2, 15),
          type: "message",
          role: "assistant",
          model: this.origModel,
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }

    for (const tc of toolCalls) {
      const idx = tc.index !== undefined ? tc.index : 0;
      if (!this.toolStates[idx]) {
        this.toolStates[idx] = {
          id: "",
          name: "",
          blockIdx: -1,
          started: false,
          pendingArgs: [],
        };
      }
      const ts = this.toolStates[idx];

      if (tc.id) ts.id = tc.id;
      if (tc.function?.name) ts.name += tc.function.name;

      const argFrag = tc.function?.arguments || "";

      if (!ts.started) {
        if (argFrag) ts.pendingArgs.push(argFrag);

        const idReady = !!ts.id;
        const nameReady = !!ts.name;
        const hasPendingArgs = ts.pendingArgs.length > 0;

        if (idReady && nameReady && hasPendingArgs) {
          ts.started = true;
          ts.blockIdx = this.blockIndex++;
          events.push({
            type: "content_block_start",
            index: ts.blockIdx,
            content_block: { type: "tool_use", id: ts.id, name: ts.name, input: {} },
          });
          for (const d of ts.pendingArgs) {
            events.push({
              type: "content_block_delta",
              index: ts.blockIdx,
              delta: { type: "input_json_delta", partial_json: d },
            });
          }
          ts.pendingArgs = [];
        }
      } else {
        if (argFrag) {
          events.push({
            type: "content_block_delta",
            index: ts.blockIdx,
            delta: { type: "input_json_delta", partial_json: argFrag },
          });
        }
      }
    }

    if (text) {
      if (this.activeTextBlock === -1) {
        this.activeTextBlock = this.blockIndex++;
        events.push({
          type: "content_block_start",
          index: this.activeTextBlock,
          content_block: { type: "text", text: "" },
        });
      }
      events.push({
        type: "content_block_delta",
        index: this.activeTextBlock,
        delta: { type: "text_delta", text: text },
      });
    }

    if (finishReason && !this.finished) {
      this.finished = true;

      let hasIncomplete = false;
      for (const ts of this.toolStates) {
        if (ts && !ts.started && ts.id) {
          hasIncomplete = true;
          events.push({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Incomplete tool call in stream: id='" + ts.id + "' name='" + ts.name + "' missing arguments or name",
            },
          });
        }
      }

      if (!hasIncomplete) {
        for (let i = 0; i < this.blockIndex; i++) {
          events.push({ type: "content_block_stop", index: i });
        }

        events.push({
          type: "message_delta",
          delta: {
            stop_reason: FINISH_MAP[finishReason] || "end_turn",
            stop_sequence: null,
          },
          usage: {
            input_tokens: chunk.usage?.prompt_tokens || 0,
            output_tokens: chunk.usage?.completion_tokens || 0,
          },
        });

        events.push({ type: "message_stop" });
      }
    }

    return events.length > 0 ? events : null;
  }
}

function translateError(upstreamStatus, upstreamBody) {
  let upstreamMsg = `Upstream error ${upstreamStatus}`;
  try {
    const parsed = JSON.parse(upstreamBody);
    if (parsed.error?.message) upstreamMsg = parsed.error.message;
  } catch {}

  return {
    status: upstreamStatus >= 400 && upstreamStatus < 500 ? 400 : 502,
    body: {
      type: "error",
      error: {
        type: upstreamStatus >= 500 ? "api_error" : "invalid_request_error",
        message: upstreamMsg,
      },
    },
  };
}

module.exports = {
  preserveSchema,
  anthropicToOpenAIBody,
  openAIToAnthropicResponse,
  OpenAISSEState,
  FINISH_MAP,
  translateError,
};
