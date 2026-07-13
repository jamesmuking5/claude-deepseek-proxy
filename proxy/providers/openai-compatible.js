"use strict";

const { sendRequest, sendStreamRequest } = require("../transport/http");
const { SSEParser } = require("../transport/sse");
const protocol = require("../protocols/openai-chat");

async function send(provider, parsed, origModel, requestUrl = "/messages") {
  const upstreamModel = provider.modelMap[origModel] || provider.defaultModel;
  const requestPath = new URL(requestUrl, "http://localhost").pathname;

  if (requestPath === "/messages/count_tokens" || requestPath === "/v1/messages/count_tokens") {
    return countTokens(provider, parsed, upstreamModel);
  }

  const startedAt = Date.now();
  parsed.model = upstreamModel;

  let openAIBody;
  try {
    openAIBody = protocol.anthropicToOpenAIBody(parsed, provider);
  } catch (e) {
    return {
      status: e.status || 400,
      body: { type: "error", error: { type: e.type || "invalid_request_error", message: e.message } },
      isStream: false,
    };
  }

  if (openAIBody.reasoning_effort) {
    console.log(`[proxy] [${provider.id}] reasoning effort: ${openAIBody.reasoning_effort}`);
  }

  const url = provider.baseUrl + provider.basePath;
  const headers = {
    "Authorization": "Bearer " + provider.apiKey,
  };

  if (openAIBody.stream) {
    return streamResponse(url, headers, openAIBody, origModel, provider.id, startedAt);
  }
  return nonStreamResponse(url, headers, openAIBody, origModel, provider.id, startedAt);
}

function tokenizationText(parsed, upstreamModel) {
  return JSON.stringify({
    ...parsed,
    model: upstreamModel,
    stream: false,
  });
}

async function countTokens(provider, parsed, upstreamModel) {
  const startedAt = Date.now();
  const text = tokenizationText(parsed, upstreamModel);

  if (!provider.tokenizePath) {
    const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(text) / 4));
    console.log(`[proxy] [${provider.id}] local token estimate: ${inputTokens} (${Date.now() - startedAt}ms)`);
    return { status: 200, body: { input_tokens: inputTokens }, isStream: false };
  }

  const url = provider.baseUrl + provider.tokenizePath;
  const headers = { "Authorization": "Bearer " + provider.apiKey };
  const resp = await sendRequest(url, "POST", headers, { model: upstreamModel, text });

  if (resp.status >= 400) {
    const translated = protocol.translateError(resp.status, resp.body);
    return { status: translated.status, body: translated.body, isStream: false };
  }

  let raw;
  try {
    raw = JSON.parse(resp.body);
  } catch {
    return {
      status: 502,
      body: { type: "error", error: { type: "api_error", message: "Invalid JSON from tokenizer upstream" } },
      isStream: false,
    };
  }

  if (!Array.isArray(raw.token_ids)) {
    return {
      status: 502,
      body: { type: "error", error: { type: "api_error", message: "Tokenizer upstream omitted token_ids" } },
      isStream: false,
    };
  }

  console.log(`[proxy] [${provider.id}] token count: ${raw.token_ids.length} (${Date.now() - startedAt}ms)`);
  return { status: 200, body: { input_tokens: raw.token_ids.length }, isStream: false };
}

async function nonStreamResponse(url, headers, body, origModel, providerId, startedAt) {
  const resp = await sendRequest(url, "POST", headers, body);
  console.log(`[proxy] [${providerId}] upstream response: status=${resp.status}, total=${Date.now() - startedAt}ms`);
  if (resp.status >= 400) {
    const translated = protocol.translateError(resp.status, resp.body);
    return { status: translated.status, body: translated.body, isStream: false };
  }
  let raw;
  try {
    raw = JSON.parse(resp.body);
  } catch {
    return {
      status: 502,
      body: { type: "error", error: { type: "api_error", message: "Invalid JSON from upstream" } },
      isStream: false,
    };
  }
  const translated = protocol.openAIToAnthropicResponse(raw, origModel);
  return { status: 200, body: translated, isStream: false };
}

async function streamResponse(url, headers, body, origModel, providerId, startedAt) {
  const { status, headers: respHeaders, stream, request } = await sendStreamRequest(url, "POST", headers, body);
  const headersAt = Date.now();
  console.log(`[proxy] [${providerId}] upstream headers: status=${status}, ttfb=${headersAt - startedAt}ms`);

  if (status >= 400) {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    return new Promise((resolve) => {
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const translated = protocol.translateError(status, raw);
        resolve({ status: translated.status, body: translated.body, isStream: false });
      });
    });
  }

  return {
    status: 200,
    headers: respHeaders,
    isStream: true,
    stream,
    request,
    origModel,
    providerId,
    startedAt,
  };
}

function pipeSSE(streamResult, res, req) {
  const { stream, origModel, providerId, startedAt, request: upstreamReq } = streamResult;
  const sseState = new protocol.OpenAISSEState(origModel);
  const MAX_QUEUE = 1000;
  const eventQueue = [];
  let settled = false;
  let upstreamEnded = false;
  let draining = false;
  let upstreamPaused = false;
  let _resolve, _reject;
  let parser;
  let firstEventLogged = false;
  let firstContentLogged = false;

  res.writeHead(200, { "Content-Type": "text/event-stream" });

  function cleanup() {
    if (upstreamReq && !upstreamReq.destroyed) upstreamReq.destroy();
    if (stream && !stream.destroyed) stream.destroy();
    req.removeListener("close", onReqClose);
    res.removeListener("close", onResClose);
    res.removeListener("drain", drainQueue);
    stream.removeListener("data", onStreamData);
    stream.removeListener("end", onStreamEnd);
    stream.removeListener("error", onStreamError);
  }

  function fail(err) {
    if (settled) return;
    settled = true;
    eventQueue.length = 0;
    cleanup();
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
    } else if (!res.writableEnded) {
      res.write("event: error\ndata: " + JSON.stringify({
        type: "error",
        error: { type: "api_error", message: err.message },
      }) + "\n\n");
      res.end();
    }
    _reject(err);
  }

  function tryFinalize() {
    if (!upstreamEnded) return;
    if (draining) return;
    if (eventQueue.length > 0) return;
    if (settled) return;
    settled = true;
    cleanup();
    if (!res.writableEnded) res.end();
    if (startedAt) {
      console.log(`[proxy] [${providerId}] upstream stream complete: total=${Date.now() - startedAt}ms`);
    }
    _resolve();
  }

  function drainQueue() {
    draining = true;
    while (eventQueue.length > 0) {
      const ev = eventQueue.shift();
      const ok = res.write("event: " + ev.type + "\ndata: " + JSON.stringify(ev) + "\n\n");
      if (!ok) {
        if (!upstreamPaused) {
          upstreamPaused = true;
          stream.pause();
        }
        res.once("drain", drainQueue);
        return;
      }
    }
    draining = false;
    if (upstreamPaused && !settled && !upstreamEnded) {
      upstreamPaused = false;
      stream.resume();
    }
    tryFinalize();
  }

  function enqueue(events) {
    if (settled) return;
    for (const ev of events) {
      if (eventQueue.length >= MAX_QUEUE) {
        throw new Error("Event queue overflow: too many pending SSE events");
      }
      eventQueue.push(ev);
    }
    if (!draining) drainQueue();
  }

  function onReqClose() {
    if (settled) return;
    const err = new Error("Stream cancelled: client disconnect");
    err.code = "STREAM_CANCELLED";
    fail(err);
  }

  function onResClose() {
    if (settled) return;
    const err = new Error("Stream cancelled: response close");
    err.code = "STREAM_CANCELLED";
    fail(err);
  }

  function onStreamData(chunk) {
    if (settled) return;
    try {
      parser.feed(chunk);
    } catch (e) {
      fail(e);
    }
  }

  function onStreamEnd() {
    if (settled) return;
    try {
      parser.flush();
    } catch (e) {
      fail(e);
      return;
    }
    upstreamEnded = true;
    tryFinalize();
  }

  function onStreamError(err) {
    fail(err);
  }

  req.on("close", onReqClose);
  res.on("close", onResClose);

  return new Promise((resolve, reject) => {
    _resolve = resolve;
    _reject = reject;

    parser = new SSEParser(
      (parsed, _eventType, _rawData) => {
        if (settled) return;
        if (!firstEventLogged) {
          firstEventLogged = true;
          if (startedAt) console.log(`[proxy] [${providerId}] first upstream event: ${Date.now() - startedAt}ms`);
        }
        if (!firstContentLogged && parsed.choices?.some(choice => choice.delta?.content)) {
          firstContentLogged = true;
          if (startedAt) console.log(`[proxy] [${providerId}] first upstream content: ${Date.now() - startedAt}ms`);
        }
        const events = sseState.transform(parsed);
        if (!events) return;
        const evs = Array.isArray(events) ? events : [events];
        for (const ev of evs) {
          if (ev.type === "message_start" && ev.message?.model) {
            ev.message.model = origModel;
          }
        }
        enqueue(evs);
      },
      () => {
        // [DONE] from upstream — do not forward to Anthropic clients
      }
    );

    stream.on("data", onStreamData);
    stream.on("end", onStreamEnd);
    stream.on("error", onStreamError);
  });
}

module.exports = { send, pipeSSE };
