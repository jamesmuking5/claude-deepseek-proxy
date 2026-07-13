"use strict";

const { sendRequest, sendStreamRequest } = require("../transport/http");
const protocol = require("../protocols/anthropic");

async function send(provider, parsed, origModel, requestUrl = "/messages") {
  const upstreamModel = provider.modelMap[origModel] || provider.defaultModel;
  const { body, path, headers } = protocol.buildRequest(parsed, upstreamModel, provider);

  const requestPath = new URL(requestUrl, "http://localhost").pathname;
  const allowedPaths = new Set([
    "/messages",
    "/messages/count_tokens",
    "/v1/messages",
    "/v1/messages/count_tokens",
  ]);
  if (!allowedPaths.has(requestPath)) {
    return {
      status: 404,
      body: { type: "error", error: { type: "not_found_error", message: "Unsupported messages endpoint" } },
      isStream: false,
    };
  }

  const url = provider.baseUrl + path + requestPath;

  if (body.stream) {
    return streamResponse(url, headers, body, origModel);
  }
  return nonStreamResponse(url, headers, body, origModel);
}

async function nonStreamResponse(url, headers, body, origModel) {
  const resp = await sendRequest(url, "POST", headers, body);
  if (resp.status >= 400) {
    const translated = protocol.translateError(resp.status, resp.body);
    return { status: translated.status, body: translated.body, isStream: false };
  }
  const translated = protocol.translateNonStream(resp, origModel);
  return { status: resp.status, body: translated, isStream: false };
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
    status,
    headers: respHeaders,
    isStream: true,
    stream,
    request,
    origModel,
  };
}

function pipeSSE(streamResult, res, req) {
  const { stream, origModel, request: upstreamReq } = streamResult;
  const sseState = new protocol.SSEState(origModel);
  const MAX_QUEUE = 1000;
  const eventQueue = [];
  let settled = false;
  let upstreamEnded = false;
  let draining = false;
  let upstreamPaused = false;
  let _resolve, _reject;
  let buf = "";

  res.writeHead(streamResult.status, {
    "Content-Type": streamResult.headers["content-type"] || "application/json",
  });

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
    _resolve(sseState.summary());
  }

  function drainQueue() {
    draining = true;
    while (eventQueue.length > 0) {
      const line = eventQueue.shift();
      const ok = res.write(line);
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

  function enqueueRaw(line) {
    if (settled) return;
    if (eventQueue.length >= MAX_QUEUE) {
      throw new Error("Event queue overflow: too many pending SSE lines");
    }
    eventQueue.push(line);
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
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";

    const writes = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const v = line[5] === " " ? line.substring(6) : line.substring(5);
        const data = v.trim();
        if (data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          const transformed = sseState.transform(event);
          writes.push("data: " + JSON.stringify(transformed) + "\n\n");
        } catch {
          writes.push(line + "\n");
        }
      } else if (line) {
        writes.push(line + "\n");
      }
    }

    for (const w of writes) {
      enqueueRaw(w);
    }
  }

  function onStreamEnd() {
    if (settled) return;
    if (buf) enqueueRaw(buf + "\n");
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

    stream.on("data", onStreamData);
    stream.on("end", onStreamEnd);
    stream.on("error", onStreamError);
  });
}

module.exports = { send, pipeSSE };
