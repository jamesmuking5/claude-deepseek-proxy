"use strict";

function buildRequest(parsed, upstreamModel, provider) {
  parsed.model = upstreamModel;
  return {
    body: parsed,
    path: provider.basePath,
    headers: {
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
  };
}

function translateNonStream(upstreamResp, origModel) {
  const parsed = JSON.parse(upstreamResp.body);
  parsed.model = origModel;
  return parsed;
}

class SSEState {
  constructor(origModel) {
    this.origModel = origModel;
    this.eventCount = 0;
    this.firstEventType = "";
    this.streamUsage = {};
  }

  transform(event) {
    this.eventCount++;
    if (!this.firstEventType) this.firstEventType = event.type;

    if (event.type === "message_start" && event.message) {
      event.message.model = this.origModel;
      if (event.message.usage) Object.assign(this.streamUsage, event.message.usage);
    }
    if (event.type === "message_delta" && event.usage) {
      Object.assign(this.streamUsage, event.usage);
    }

    return event;
  }

  summary() {
    return {
      eventCount: this.eventCount,
      firstEventType: this.firstEventType,
      usage: this.streamUsage,
    };
  }
}

function translateError(upstreamStatus, upstreamBody) {
  return {
    status: upstreamStatus,
    body: {
      type: "error",
      error: {
        type: "api_error",
        message: `Upstream error ${upstreamStatus}: ${upstreamBody.substring(0, 500)}`,
      },
    },
  };
}

module.exports = { buildRequest, translateNonStream, SSEState, translateError };
