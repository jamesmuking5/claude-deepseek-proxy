"use strict";

const { hasImages } = require("../providers/gemini");

const PRIORITY_ORDER = ["opencode", "xai", "zai", "deepseek", "gemini", "openai_compat"];

function resolveProvider(providers, parsed) {
  const origModel = parsed.model || "unknown";

  if (hasImages(parsed)) {
    const modelProvider = resolveModelProvider(providers, origModel);
    if (modelProvider && modelProvider.capabilities.vision) {
      return {
        provider: modelProvider,
        upstreamModel: modelProvider.modelMap
          ? (modelProvider.modelMap[origModel] || modelProvider.defaultModel)
          : modelProvider.defaultModel,
        imagePipeline: false,
      };
    }

    const gemini = providers.gemini;
    if (gemini && gemini.capabilities.vision) {
      return {
        provider: gemini,
        upstreamModel: gemini.model,
        imagePipeline: true,
      };
    }

    return {
      error: {
        status: 400,
        body: {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "No vision-capable provider configured. Set GEMINI_API_KEY for image support.",
          },
        },
      },
    };
  }

  const provider = resolveModelProvider(providers, origModel);
  if (provider) {
    return {
      provider,
      upstreamModel: provider.modelMap
        ? (provider.modelMap[origModel] || provider.defaultModel)
        : provider.defaultModel,
      imagePipeline: false,
    };
  }

  return {
    error: {
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `No provider configured for model: ${origModel}`,
        },
      },
    },
  };
}

function resolveModelProvider(providers, origModel) {
  for (const key of PRIORITY_ORDER) {
    const provider = providers[key];
    if (!provider || !provider.apiKey) continue;
    if (provider.modelMap && provider.modelMap[origModel]) {
      return provider;
    }
  }

  for (const key of PRIORITY_ORDER) {
    const provider = providers[key];
    if (!provider || !provider.apiKey) continue;
    if (provider.protocol === "anthropic" && provider.modelMap) {
      return provider;
    }
  }

  return null;
}

module.exports = { resolveProvider, PRIORITY_ORDER };
