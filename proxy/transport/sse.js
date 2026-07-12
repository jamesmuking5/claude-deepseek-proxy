"use strict";

const SSE_MAX_BUFFER = 1024 * 1024;

class SSEParser {
  constructor(onEvent, onDone) {
    this._onEvent = onEvent;
    this._onDone = onDone;
    this._lineBuf = "";
    this._eventType = "";
    this._dataBuf = "";
  }

  feed(chunk) {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    this._lineBuf += str;

    if (this._lineBuf.length + this._dataBuf.length > SSE_MAX_BUFFER) {
      throw new Error("SSE buffer exceeded — un-terminated line or event too large");
    }

    const lines = this._lineBuf.split("\n");
    this._lineBuf = lines.pop() || "";

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        this._dispatch();
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        const v = line[6] === " " ? line.slice(7) : line.slice(6);
        this._eventType = v.trim();
        continue;
      }
      if (line.startsWith("data:")) {
        const v = line[5] === " " ? line.slice(6) : line.slice(5);
        this._dataBuf += (this._dataBuf ? "\n" : "") + v;
        continue;
      }
    }
  }

  _dispatch() {
    if (this._dataBuf === "") {
      this._eventType = "";
      return;
    }

    if (this._dataBuf === "[DONE]") {
      this._eventType = "";
      this._dataBuf = "";
      if (this._onDone) this._onDone();
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(this._dataBuf);
    } catch (e) {
      const err = new Error("SSE parse error: invalid JSON in event data");
      err.code = "SSE_PARSE_ERROR";
      throw err;
    }

    this._onEvent(parsed, this._eventType, this._dataBuf);
    this._eventType = "";
    this._dataBuf = "";
  }

  flush() {
    if (this._lineBuf) {
      const line = this._lineBuf.endsWith("\r") ? this._lineBuf.slice(0, -1) : this._lineBuf;
      this._lineBuf = "";
      if (line.startsWith("data:")) {
        const v = line[5] === " " ? line.slice(6) : line.slice(5);
        this._dataBuf += (this._dataBuf ? "\n" : "") + v;
        this._dispatch();
      }
    }
  }
}

module.exports = { SSEParser };
