"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { SSEParser } = require("../../transport/sse.js");

describe("SSEParser — buffer accounting", () => {
  it("dispatches single event", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    parser.feed('data: {"x":1}\n\n');
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], { x: 1 });
  });

  it("handles multi-line data concatenation", () => {
    // Multiple data: lines concatenate with \n — non-JSON content now
    // throws SSE_PARSE_ERROR instead of passing null to callback
    const parser = new SSEParser(() => {}, () => {});
    parser.feed("data: first\n");
    assert.throws(() => {
      parser.feed("data: second\n\n");
    }, { code: "SSE_PARSE_ERROR" });
  });

  it("handles [DONE] sentinel", () => {
    let doneFired = false;
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => { doneFired = true; }
    );
    parser.feed('data: {"x":1}\n\n');
    parser.feed("data: [DONE]\n\n");
    assert.strictEqual(events.length, 1);
    assert.ok(doneFired);
  });

  it("processes multi-megabyte stream of small events without buffer overflow", () => {
    // The buffer limit applies to CURRENT incomplete line/event data, not cumulative.
    // A stream containing many small, properly-terminated events across multiple
    // megabytes must continue normally — each event is dispatched and buffers cleared.
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );

    // Generate ~2MB of small SSE events, fed in chunks to simulate streaming
    const totalEvents = 20000;
    const chunks = [];
    let currentChunk = "";
    for (let i = 0; i < totalEvents; i++) {
      const line = `data: {"i":${i}}\n\n`;
      currentChunk += line;
      if (currentChunk.length >= 4096) {
        chunks.push(currentChunk);
        currentChunk = "";
      }
    }
    if (currentChunk) chunks.push(currentChunk);

    for (const chunk of chunks) {
      parser.feed(chunk);
    }

    assert.strictEqual(events.length, totalEvents,
      `all ${totalEvents} events must be dispatched across ~2MB stream`);
    assert.strictEqual(events[0].i, 0);
    assert.strictEqual(events[totalEvents - 1].i, totalEvents - 1);
  });

  it("throws on single unterminated line exceeding max buffer", () => {
    const parser = new SSEParser(() => {}, () => {});
    // Feed a huge line without \n — should trigger the buffer limit
    const hugeLine = "data: " + "x".repeat(1024 * 1024);
    assert.throws(() => {
      parser.feed(hugeLine);
    }, /SSE buffer exceeded/);
  });

  it("throws on accumulated unterminated data exceeding max buffer", () => {
    const parser = new SSEParser(() => {}, () => {});
    // Feed partial lines that never terminate, accumulating past limit
    assert.throws(() => {
      for (let i = 0; i < 1100; i++) {
        parser.feed("x".repeat(1000));
      }
    }, /SSE buffer exceeded/);
  });

  it("resets buffer tracking after each dispatched event", () => {
    // After dispatching an event, internal buffers are cleared.
    // The next event starts fresh — this is what enables multi-MB streams.
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    // Feed a near-limit event, dispatch, then another near-limit event
    const bigPayload = "x".repeat(500000);
    parser.feed(`data: {"a":"${bigPayload}"}\n\n`);
    assert.strictEqual(events.length, 1);
    // Second big event should work because buffers were cleared after first
    parser.feed(`data: {"b":"${bigPayload}"}\n\n`);
    assert.strictEqual(events.length, 2);
  });

  it("handles CRLF line endings", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    parser.feed('data: {"x":1}\r\n\r\n');
    assert.strictEqual(events.length, 1);
  });

  it("skips comment lines", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    parser.feed(": this is a comment\n");
    parser.feed('data: {"x":1}\n\n');
    assert.strictEqual(events.length, 1);
  });

  it("flush processes remaining incomplete line", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    // Feed data without any newline — stays in _lineBuf, not dispatched
    parser.feed('data: {"x":1}');
    assert.strictEqual(events.length, 0, "no dispatch without blank line");
    // Flush should process the incomplete line
    parser.flush();
    assert.strictEqual(events.length, 1);
  });

  it("accepts data:value without space", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    parser.feed('data:{"x":1}\n\n');
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], { x: 1 });
  });

  it("accepts event:name without space", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed, eventType) => events.push({ parsed, eventType }),
      () => {}
    );
    parser.feed('event:myevent\n');
    parser.feed('data:{"x":1}\n\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].eventType, "myevent");
  });

  it("accepts event: name with space", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed, eventType) => events.push({ parsed, eventType }),
      () => {}
    );
    parser.feed('event: myevent\n');
    parser.feed('data: {"x":1}\n\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].eventType, "myevent");
  });

  it("mixes data: and data: value in same event (multiline concat)", () => {
    // Non-JSON concatenated data: throws SSE_PARSE_ERROR
    const parser = new SSEParser(() => {}, () => {});
    parser.feed("data:first\n");
    assert.throws(() => {
      parser.feed("data: second\n\n");
    }, { code: "SSE_PARSE_ERROR" });
  });

  it("handles fragmented data: prefix across chunks", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    // Feed "dat" then "a: {\"x\":1}\n\n" — should reconstruct data: prefix
    parser.feed("dat");
    parser.feed('a: {"x":1}\n\n');
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], { x: 1 });
  });

  it("handles data:value with CRLF", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    parser.feed('data:{"y":2}\r\n\r\n');
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], { y: 2 });
  });

  it("throws SSE_PARSE_ERROR on malformed JSON in complete event", () => {
    const parser = new SSEParser(() => {}, () => {});
    assert.throws(() => {
      parser.feed("data: not valid json\n\n");
    }, { code: "SSE_PARSE_ERROR" });
  });

  it("throws SSE_PARSE_ERROR on malformed JSON at flush", () => {
    const parser = new SSEParser(() => {}, () => {});
    parser.feed("data: not valid json");
    assert.throws(() => {
      parser.flush();
    }, { code: "SSE_PARSE_ERROR" });
  });

  it("_dispatch with empty _dataBuf resets _eventType", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed, eventType) => events.push({ parsed, eventType }),
      () => {}
    );
    // First event with event type
    parser.feed('event: mytype\n');
    parser.feed('data: {"x":1}\n\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].eventType, "mytype");
    // Blank line with no accumulated data — _dispatch with empty _dataBuf
    parser.feed('\n\n');
    // Another event without explicit event type — should use empty string
    parser.feed('data: {"y":2}\n\n');
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].eventType, "", "_eventType must be reset after empty dispatch");
  });

  it("valid JSON fragmented across chunks parses correctly", () => {
    const events = [];
    const parser = new SSEParser(
      (parsed) => events.push(parsed),
      () => {}
    );
    // Chunk 1: partial JSON, chunk 2: completes it
    parser.feed('data: {"a":');
    parser.feed('1}\n\n');
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0], { a: 1 });
  });
});
