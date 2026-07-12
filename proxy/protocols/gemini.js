"use strict";

const STOP_REASON_MAP = {
  "STOP": "end_turn",
  "MAX_TOKENS": "max_tokens",
  "SAFETY": "end_turn",
  "RECITATION": "end_turn",
};

function preserveSchema(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(preserveSchema);
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    cleaned[k] = preserveSchema(v);
  }
  return cleaned;
}

function anthropicToGeminiContents(parsed) {
  const contents = [];
  let systemInstruction = null;
  const systemParts = [];

  for (const msg of parsed.messages || []) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") {
        systemParts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") systemParts.push({ text: block.text });
        }
      }
      continue;
    }

    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          let mimeType = "image/jpeg";
          let data = "";
          if (block.source) {
            mimeType = block.source.media_type || "image/jpeg";
            data = block.source.data || "";
          }
          parts.push({ inlineData: { mimeType, data } });
        } else if (block.type === "tool_use") {
          parts.push({
            text: JSON.stringify({
              type: "tool_use",
              name: block.name,
              input: block.input,
              id: block.id,
            }),
          });
        } else if (block.type === "tool_result") {
          parts.push({
            text: JSON.stringify({
              type: "tool_result",
              tool_use_id: block.tool_use_id,
              content: block.content,
            }),
          });
        }
      }
    }
    contents.push({ role, parts });
  }

  if (systemParts.length > 0) {
    systemInstruction = { parts: systemParts };
  }

  const genConfig = {};
  if (parsed.max_tokens) genConfig.maxOutputTokens = Math.min(parsed.max_tokens, 8192);
  if (parsed.temperature !== undefined) genConfig.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) genConfig.topP = parsed.top_p;

  const body = { contents, generationConfig: genConfig };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  return body;
}

function geminiToAnthropicResponse(geminiResp, origModel) {
  const candidate = geminiResp.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];

  const content = [];
  for (const part of parts) {
    if (part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      content.push({
        type: "tool_use",
        id: "toolu_" + Math.random().toString(36).substring(2, 15),
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  const usage = geminiResp.usageMetadata || {};
  return {
    id: "msg_" + Math.random().toString(36).substring(2, 15),
    type: "message",
    role: "assistant",
    model: origModel,
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    stop_reason: STOP_REASON_MAP[candidate.finishReason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    },
  };
}

class GeminiSSEState {
  constructor(origModel) {
    this.origModel = origModel;
    this.started = false;
    this.blockStarted = false;
  }

  transform(chunk) {
    const candidates = chunk.candidates || [];
    if (candidates.length === 0) return null;

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

    const candidate = candidates[0];
    const parts = candidate.content?.parts || [];
    const texts = parts.filter(p => p.text).map(p => p.text);

    if (texts.length > 0 && !this.blockStarted) {
      this.blockStarted = true;
      events.push({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    }

    if (texts.length > 0) {
      events.push({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: texts.join("") },
      });
    }

    if (candidate.finishReason) {
      if (this.blockStarted) {
        events.push({ type: "content_block_stop", index: 0 });
      }
      events.push({
        type: "message_delta",
        delta: {
          stop_reason: STOP_REASON_MAP[candidate.finishReason] || "end_turn",
          stop_sequence: null,
        },
        usage: {
          input_tokens: chunk.usageMetadata?.promptTokenCount || 0,
          output_tokens: chunk.usageMetadata?.candidatesTokenCount || 0,
        },
      });
      events.push({ type: "message_stop" });
    }

    return events.length > 0 ? events : null;
  }
}

function translateError(upstreamStatus, upstreamBody) {
  return {
    status: 502,
    body: {
      type: "error",
      error: {
        type: "api_error",
        message: `Gemini error ${upstreamStatus}: ${upstreamBody.substring(0, 500)}`,
      },
    },
  };
}

module.exports = {
  anthropicToGeminiContents,
  geminiToAnthropicResponse,
  GeminiSSEState,
  translateError,
};
