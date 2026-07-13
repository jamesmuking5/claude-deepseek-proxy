"use strict";

const { getRequired, getOptional, parseModelMap, validateBaseUrl } = require("./env");

function parseBool(raw, label) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${label} must be "true" or "false", got: ${raw}`);
}

function parseChoice(raw, label, choices) {
  if (!choices.includes(raw)) {
    throw new Error(`${label} must be one of: ${choices.join(", ")}`);
  }
  return raw;
}

function buildProviders() {
  const providers = {};

  // Reasoning/thinking is always on unless THINKING=false in .env, which
  // forces minimal reasoning effort on providers that support the control.
  const thinkingEnabled = parseBool(getOptional("THINKING", null), "THINKING") ?? true;

  const deepseekKey = getOptional("DEEPSEEK_API_KEY", null);
  if (deepseekKey) {
    providers.deepseek = {
      id: "deepseek",
      label: "DeepSeek",
      protocol: "anthropic",
      baseUrl: "https://api.deepseek.com",
      basePath: "/anthropic",
      apiKey: deepseekKey,
      modelMap: {
        "claude-sonnet-4-5": "deepseek-v4-flash",
        "claude-sonnet-4-6": "deepseek-v4-flash",
        "claude-opus-4-7": "deepseek-v4-pro",
        "claude-haiku-4-5-20251001": "deepseek-v4-flash",
      },
      defaultModel: "deepseek-v4-flash",
      capabilities: {
        streaming: true,
        tools: true,
        parallelToolCalls: true,
        vision: false,
        reasoning: true,
        streamUsage: true,
      },
    };
  }

  const zaiKey = getOptional("ZAI_API_KEY", null);
  if (zaiKey) {
    providers.zai = {
      id: "zai",
      label: "Z.AI GLM-5.2",
      protocol: "anthropic",
      baseUrl: "https://api.z.ai",
      basePath: "/api/anthropic",
      apiKey: zaiKey,
      modelMap: {
        "claude-opus-4-8": "glm-5.2",
      },
      defaultModel: "glm-5.2",
      capabilities: {
        streaming: true,
        tools: true,
        parallelToolCalls: false,
        vision: false,
        reasoning: true,
        streamUsage: true,
      },
    };
  }

  const xaiKey = getOptional("XAI_API_KEY", null);
  if (xaiKey) {
    const reasoningEffort = parseChoice(
      getOptional("XAI_REASONING_EFFORT", "low"),
      "XAI_REASONING_EFFORT",
      ["low", "medium", "high"]
    );
    providers.xai = {
      id: "xai",
      label: "xAI Grok 4.5",
      protocol: "openai-chat",
      baseUrl: "https://api.x.ai/v1",
      basePath: "/chat/completions",
      tokenizePath: "/tokenize-text",
      apiKey: xaiKey,
      reasoningEffort,
      thinkingEnabled,
      modelMap: parseModelMap(getOptional("XAI_MODEL_MAP", null), "XAI_MODEL_MAP") || {
        "claude-opus-4-9": "grok-4.5",
      },
      defaultModel: "grok-4.5",
      capabilities: {
        streaming: true,
        tools: true,
        parallelToolCalls: true,
        vision: false,
        reasoning: true,
        streamUsage: true,
      },
    };
  }

  const geminiKey = getOptional("GEMINI_API_KEY", null);
  if (geminiKey) {
    providers.gemini = {
      id: "gemini",
      label: "Gemini Flash",
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      basePath: "/v1beta/models",
      apiKey: geminiKey,
      model: "gemini-2.5-flash",
      modelMap: null,
      defaultModel: "gemini-2.5-flash",
      capabilities: {
        streaming: true,
        tools: false,
        parallelToolCalls: false,
        vision: true,
        reasoning: false,
        streamUsage: true,
      },
    };
  }

  const opencodeKey = getOptional("OPENCODE_API_KEY", null);
  if (opencodeKey) {
    providers.opencode = {
      id: "opencode",
      label: "OpenCode Go",
      protocol: "openai-chat",
      baseUrl: "https://opencode.ai",
      basePath: "/zen/go/v1/chat/completions",
      apiKey: opencodeKey,
      modelMap: {
        "claude-sonnet-4-5": "deepseek-v4-flash",
        "claude-sonnet-4-6": "deepseek-v4-flash",
        "claude-opus-4-7": "deepseek-v4-flash",
        "claude-haiku-4-5-20251001": "deepseek-v4-flash",
      },
      defaultModel: "deepseek-v4-flash",
      capabilities: {
        streaming: true,
        tools: true,
        parallelToolCalls: true,
        vision: false,
        reasoning: false,
        streamUsage: false,
      },
    };
  }

  const genericBaseUrl = getOptional("OPENAI_COMPAT_BASE_URL", null);
  const genericKey = getOptional("OPENAI_COMPAT_API_KEY", null);
  const genericModelMap = parseModelMap(
    getOptional("OPENAI_COMPAT_MODEL_MAP", null),
    "OPENAI_COMPAT_MODEL_MAP"
  );
  if (genericBaseUrl && genericKey && genericModelMap) {
    const cleanUrl = validateBaseUrl(genericBaseUrl, "OPENAI_COMPAT_BASE_URL");
    providers.openai_compat = {
      id: "openai_compat",
      label: "OpenAI-Compatible",
      protocol: "openai-chat",
      baseUrl: cleanUrl,
      basePath: "/chat/completions",
      apiKey: genericKey,
      modelMap: genericModelMap,
      defaultModel: Object.values(genericModelMap)[0],
      capabilities: {
        streaming: true,
        tools: parseBool(getOptional("OPENAI_COMPAT_TOOLS", null), "OPENAI_COMPAT_TOOLS") ?? false,
        parallelToolCalls: parseBool(getOptional("OPENAI_COMPAT_PARALLEL_TOOLS", null), "OPENAI_COMPAT_PARALLEL_TOOLS") ?? false,
        vision: parseBool(getOptional("OPENAI_COMPAT_VISION", null), "OPENAI_COMPAT_VISION") ?? false,
        reasoning: parseBool(getOptional("OPENAI_COMPAT_REASONING", null), "OPENAI_COMPAT_REASONING") ?? false,
        streamUsage: parseBool(getOptional("OPENAI_COMPAT_STREAM_USAGE", null), "OPENAI_COMPAT_STREAM_USAGE") ?? false,
      },
    };
  }

  return providers;
}

module.exports = { buildProviders };
