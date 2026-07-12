"use strict";

const { sendRequest, sendStreamRequest } = require("../transport/http");
const { SSEParser } = require("../transport/sse");
const protocol = require("../protocols/openai-chat");

async function send(provider, parsed, origModel) {
  const upstreamModel = provider.modelMap[origModel] || provider.defaultModel;
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

  const url = provider.baseUrl + provider.basePath;
  const headers = {
    "Authorization": "Bearer " + provider.apiKey,
  };

  if (openAIBody.stream) {
    return streamResponse(url, headers, openAIBody, origModel);
  }
  return nonStreamResponse(url, headers, openAIBody, origModel);
}

async function nonStreamResponse(url, headers, body, origModel) {
  const resp = await sendRequest(url, "POST", headers, body);
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

async function streamResponse(url, headers, body, origModel) {
  const { status, headers: respHeaders, stream, request } = await sendStreamRequest(url, "POST", headers, body);

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
  };
}

function pipeSSE(streamResult, res, req) {
  const { stream, origModel, request: upstreamReq } = streamResult;
  const sseState = new protocol.OpenAISSEState(origModel);
  const MAX_QUEUE = 1000;
  const eventQueue = [];
  let settled = false;
  let upstreamEnded = false;
  let draining = false;
  let upstreamPaused = false;
  let _resolve, _reject;
  let parser;

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
      res.write("data: " + JSON.stringify({
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
    _resolve();
  }

  function drainQueue() {
    draining = true;
    while (eventQueue.length > 0) {
      const ev = eventQueue.shift();
      const ok = res.write("data: " + JSON.stringify(ev) + "\n\n");
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
