"use strict";

const { resolveProvider } = require("./routing/resolve-provider");
const anthropicCompat = require("./providers/anthropic-compatible");
const openaiCompat = require("./providers/openai-compatible");
const geminiProvider = require("./providers/gemini");

const MAX_PAYLOAD = 50 * 1024 * 1024;

function createApp(providers) {
  return function handleRequest(req, res) {
    console.log(`[proxy] >>> ${req.method} ${req.url} (content-type=${req.headers["content-type"] || "none"})`);

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      return res.end();
    }

    if (req.method === "GET") {
      return handleGet(req, res, providers);
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Method not allowed" },
      }));
    }

    if (!req.url.startsWith("/messages") && !req.url.startsWith("/v1/messages")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        type: "error",
        error: { type: "not_found_error", message: "Not found: " + req.url },
      }));
    }

    let body = "";
    let bodyChunks = 0;

    req.on("data", (chunk) => {
      body += chunk;
      bodyChunks++;
      if (body.length > MAX_PAYLOAD) {
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "Payload too large" },
          }));
        }
        req.destroy();
      }
    });

    req.on("end", () => {
      if (req.destroyed) return;

      let parsed;
      try {
        parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object") {
          throw new Error("Payload must be a JSON object");
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Invalid JSON" },
        }));
      }

      handlePost(req, res, parsed, providers).catch((e) => {
        console.error("[proxy] unhandled async error:", e.message);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            type: "error",
            error: { type: "api_error", message: e.message || "Internal error" },
          }));
        }
      });
    });

    req.on("error", (err) => {
      console.error("[proxy] client error:", err.message);
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Client error" },
        }));
      }
    });
  };
}

function handleGet(req, res, providers) {
  if (req.url === "/v1/models" || req.url.startsWith("/v1/models?")) {
    const modelIds = new Set();
    for (const ep of Object.values(providers)) {
      if (ep.modelMap) {
        for (const cModel of Object.keys(ep.modelMap)) modelIds.add(cModel);
      }
    }
    const data = Array.from(modelIds).map(id => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "proxy",
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data }));
  }

  const models = {};
  for (const [key, ep] of Object.entries(providers)) {
    if (ep.modelMap) {
      for (const [cModel, uModel] of Object.entries(ep.modelMap)) {
        models[cModel] = `${key}:${uModel}`;
      }
    }
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({
    status: "ok",
    proxy: "claude-deepseek-proxy",
    endpoints: Object.values(providers).map(p => p.label).join(" + "),
    models,
  }));
}

async function handlePost(req, res, parsed, providers) {
  const origModel = parsed.model || "unknown";

  logRequest(parsed, origModel);

  if (parsed.max_tokens !== undefined && parsed.max_tokens <= 1 && !parsed.stream) {
    const probeResp = {
      id: "msg_" + Math.random().toString(36).substring(2, 15),
      type: "message",
      role: "assistant",
      model: origModel,
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    };
    console.log("[proxy] ← PROBE response");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(probeResp));
  }

  const resolved = resolveProvider(providers, parsed);

  if (resolved.error) {
    res.writeHead(resolved.error.status, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(resolved.error.body));
  }

  const { provider, upstreamModel, imagePipeline } = resolved;

  console.log(`[proxy] endpoint: ${provider.id} (${provider.label}), upstreamModel: ${upstreamModel}`);

  if (imagePipeline) {
    return handleImagePipeline(req, res, parsed, origModel, providers);
  }

  return dispatchProvider(req, res, parsed, origModel, provider, upstreamModel);
}

async function dispatchProvider(req, res, parsed, origModel, provider, upstreamModel) {
  if (provider.protocol === "anthropic") {
    console.log(`[proxy] model map: ${origModel} → ${upstreamModel}`);

    const result = await anthropicCompat.send(provider, parsed, origModel);

    if (result.isStream) {
      return anthropicCompat.pipeSSE(result, res, req).then((summary) => {
        if (summary) {
          console.log(`[proxy] ← SSE stream complete: ${summary.eventCount} events, first=${summary.firstEventType}`);
          if (summary.usage) {
            console.log(`[proxy] ← tokens: input=${summary.usage.input_tokens || 0}, output=${summary.usage.output_tokens || 0}`);
          }
        }
      });
    }

    if (!res.headersSent) {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    }
    return;
  }

  if (provider.protocol === "openai-chat") {
    console.log(`[proxy] [${provider.id}] model map: ${origModel} → ${upstreamModel}`);

    const result = await openaiCompat.send(provider, parsed, origModel);

    if (result.isStream) {
      return openaiCompat.pipeSSE(result, res, req);
    }

    if (!res.headersSent) {
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    }
    return;
  }

  if (!res.headersSent) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: `Unknown protocol: ${provider.protocol}` },
    }));
  }
}

async function handleImagePipeline(req, res, parsed, origModel, providers) {
  const geminiEp = providers.gemini;
  if (!geminiEp) {
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "No image-capable provider configured" },
      }));
    }
    return;
  }

  console.log("[proxy] [IMAGE] === Image → Gemini OCR → text backend pipeline ===");

  const imageDescription = await geminiProvider.describeImages(geminiEp, parsed);
  console.log(`[proxy] [IMAGE] description: ${imageDescription ? imageDescription.substring(0, 200) + "..." : "(none)"}`);

  geminiProvider.stripImagesAndInjectDescription(parsed, imageDescription);

  const resolved = resolveProvider(providers, parsed);
  if (resolved.error) {
    if (!res.headersSent) {
      res.writeHead(resolved.error.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resolved.error.body));
    }
    return;
  }

  const { provider, upstreamModel } = resolved;
  console.log(`[proxy] [IMAGE] model map: ${origModel} → ${upstreamModel} (via ${provider.label})`);

  return dispatchProvider(req, res, parsed, origModel, provider, upstreamModel);
}

function logRequest(parsed, origModel) {
  const sysType = typeof parsed.system;
  const sysInfo = parsed.system
    ? (sysType === "string" ? `string(${parsed.system.length}c)` : `array[${parsed.system.length}]`)
    : "none";
  const msgCount = (parsed.messages || []).length;
  const toolCount = (parsed.tools || []).length;

  console.log(`[proxy] ┌─ REQUEST`);
  console.log(`[proxy] │  model:       ${origModel}`);
  console.log(`[proxy] │  max_tokens:  ${parsed.max_tokens}`);
  console.log(`[proxy] │  stream:      ${!!parsed.stream}`);
  console.log(`[proxy] │  system:      ${sysInfo}`);
  console.log(`[proxy] │  messages:    ${msgCount}`);
  console.log(`[proxy] │  tools:       ${toolCount}`);
  console.log(`[proxy] └─ END REQUEST`);
}

module.exports = { createApp };
