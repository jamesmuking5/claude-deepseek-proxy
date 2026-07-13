"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { resolveProvider } = require("../../routing/resolve-provider.js");

const makeProviders = (overrides) => {
  const defaults = {
    deepseek: {
      id: "deepseek",
      label: "DeepSeek",
      protocol: "anthropic",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
      modelMap: {
        "claude-sonnet-4-5": "deepseek-v4-flash",
        "claude-opus-4-7": "deepseek-v4-pro",
      },
      defaultModel: "deepseek-v4-flash",
      capabilities: { streaming: true, tools: true, vision: false, reasoning: true },
    },
    gemini: {
      id: "gemini",
      label: "Gemini",
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "key-test",
      model: "gemini-2.5-flash",
      modelMap: null,
      defaultModel: "gemini-2.5-flash",
      capabilities: { streaming: true, tools: false, vision: true, reasoning: false },
    },
  };

  const providers = { ...defaults, ...overrides };
  for (const k of Object.keys(providers)) {
    if (providers[k] === null) delete providers[k];
  }
  return providers;
};

describe("resolveProvider", () => {
  it("routes known model to matching provider", () => {
    const result = resolveProvider(makeProviders(), {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.strictEqual(result.provider.id, "deepseek");
    assert.strictEqual(result.upstreamModel, "deepseek-v4-flash");
    assert.strictEqual(result.imagePipeline, false);
  });

  it("auto-routes images to Gemini when model provider lacks vision", () => {
    const result = resolveProvider(makeProviders(), {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } }] }],
    });
    assert.strictEqual(result.provider.id, "gemini");
    assert.strictEqual(result.imagePipeline, true);
  });

  it("routes images directly to model provider when it has vision", () => {
    const providers = makeProviders({
      deepseek: null,
      gemini: null,
      openai_compat: {
        id: "openai_compat",
        label: "Vision Provider",
        protocol: "openai-chat",
        baseUrl: "https://vision.example",
        apiKey: "sk-v",
        modelMap: { "claude-sonnet-4-5": "vision-model" },
        defaultModel: "vision-model",
        capabilities: { streaming: true, tools: true, vision: true, reasoning: false },
      },
    });
    const result = resolveProvider(providers, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } }] }],
    });
    assert.strictEqual(result.provider.id, "openai_compat");
    assert.strictEqual(result.imagePipeline, false);
  });

  it("falls back to Gemini when model provider lacks vision for images", () => {
    // deepseek has vision:false, gemini has vision:true → gemini wins for images
    const result = resolveProvider(makeProviders(), {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } }] }],
    });
    assert.strictEqual(result.provider.id, "gemini");
    assert.strictEqual(result.imagePipeline, true);
  });

  it("returns error when no vision provider for images", () => {
    const providers = makeProviders({ gemini: null });
    const result = resolveProvider(providers, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } }] }],
    });
    assert.ok(result.error);
  });

  it("prioritizes opencode over deepseek", () => {
    const providers = makeProviders({
      opencode: {
        id: "opencode",
        protocol: "openai-chat",
        apiKey: "sk-test",
        modelMap: { "claude-sonnet-4-5": "deepseek-v4-flash" },
        defaultModel: "deepseek-v4-flash",
        capabilities: { streaming: true, tools: true, vision: false, reasoning: false },
      },
    });
    const result = resolveProvider(providers, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.strictEqual(result.provider.id, "opencode");
  });

  it("routes claude-opus-4-9 to xAI Grok 4.5", () => {
    const providers = makeProviders({
      xai: {
        id: "xai",
        protocol: "openai-chat",
        apiKey: "xai-test",
        modelMap: { "claude-opus-4-9": "grok-4.5" },
        defaultModel: "grok-4.5",
        capabilities: { streaming: true, tools: true, vision: false, reasoning: true },
      },
    });
    const result = resolveProvider(providers, {
      model: "claude-opus-4-9",
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.strictEqual(result.provider.id, "xai");
    assert.strictEqual(result.upstreamModel, "grok-4.5");
  });

  it("skips providers without API key", () => {
    const providers = makeProviders({ deepseek: { ...makeProviders().deepseek, apiKey: null }, gemini: null });
    const result = resolveProvider(providers, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.ok(result.error);
  });

  it("falls back to default for unknown model", () => {
    const result = resolveProvider(makeProviders(), {
      model: "unknown-model",
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.strictEqual(result.provider.id, "deepseek");
    assert.strictEqual(result.upstreamModel, "deepseek-v4-flash");
  });
});
