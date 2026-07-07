const https = require("https");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const HOST = "localhost";
const PORT = 8877;
const PASS = process.env.PASS === "1";

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: HOST, port: PORT, path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  let ok = 0, fail = 0;

  // ── Test 1: Health GET ──
  console.log("\n=== [TEST 1] GET / (health) ===");
  const r1 = await new Promise((resolve) => {
    https.get(`https://${HOST}:${PORT}`, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
  });
  console.log(`Status: ${r1.status}`);
  console.log(`Body: ${r1.body.substring(0, 200)}`);
  if (r1.status === 200) { ok++; console.log("  ✓ PASS"); } else { fail++; console.log("  ✗ FAIL"); }

  // ── Test 2: Probe (max_tokens=1) ──
  console.log("\n=== [TEST 2] Probe (max_tokens=1) ===");
  const r2 = await post("/messages", {
    model: "claude-sonnet-4-5", max_tokens: 1,
    messages: [{ role: "user", content: "Ciao!" }],
  });
  console.log(`Status: ${r2.status}`);
  console.log(`Body: ${r2.body.substring(0, 200)}`);
  if (r2.status === 200 && JSON.parse(r2.body).content?.[0]?.text === "Hi") { ok++; console.log("  ✓ PASS"); } else { fail++; console.log("  ✗ FAIL"); }

  // ── Test 3: Bad JSON ──
  console.log("\n=== [TEST 3] Bad JSON ===");
  const r3 = await new Promise((resolve) => {
    const data = "non valido";
    const req = https.request({
      hostname: HOST, port: PORT, path: "/messages", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.write(data);
    req.end();
  });
  console.log(`Status: ${r3.status}`);
  console.log(`Body: ${r3.body}`);
  if (r3.status === 400) { ok++; console.log("  ✓ PASS"); } else { fail++; console.log("  ✗ FAIL"); }

  // ── Test 4: OPTIONS (CORS preflight) ──
  console.log("\n=== [TEST 4] OPTIONS (CORS) ===");
  const r4 = await new Promise((resolve) => {
    const req = https.request({
      hostname: HOST, port: PORT, path: "/messages", method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "POST" },
    }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d, cors: res.headers["access-control-allow-origin"] }));
    });
    req.end();
  });
  console.log(`Status: ${r4.status}, CORS: ${r4.cors}`);
  // CORS intentionally disabled for security (no Access-Control-Allow-Origin)
  if (r4.status === 200) { ok++; console.log("  ✓ PASS"); } else { fail++; console.log("  ✗ FAIL"); }

  // ── Test 5: Real DeepSeek streaming ──
  console.log("\n=== [TEST 5] DeepSeek streaming ===");
  const r5Stream = { status: 0, body: "" };
  try {
    await new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: "claude-sonnet-4-5", max_tokens: 100, stream: true,
        messages: [{ role: "user", content: "Say hello in one word." }],
      });
      const req = https.request({
        hostname: HOST, port: PORT, path: "/messages", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      }, (res) => {
        r5Stream.status = res.statusCode;
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => { r5Stream.body = Buffer.concat(chunks).toString(); resolve(); });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    });
    const hasMessageStart = r5Stream.body.includes('"type":"message_start"');
    const hasContentDelta = r5Stream.body.includes('"type":"content_block_delta"');
    console.log(`Status: ${r5Stream.status}, has message_start: ${hasMessageStart}, has content_delta: ${hasContentDelta}`);
    if (r5Stream.status === 200 && hasMessageStart && hasContentDelta) { ok++; console.log("  ✓ PASS"); } else { fail++; console.log("  ✗ FAIL"); }
  } catch (e) {
    console.log(`Error: ${e.message}`);
    fail++; console.log("  ✗ FAIL");
  }

  // ── Test 6: Image pipeline (graceful fallback) ──
  console.log("\n=== [TEST 6] Image pipeline (graceful fallback) ===");
  // Test 6 (previously test 5)
  const r6 = await post("/messages", {
    model: "claude-sonnet-4-5", max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" } }] }],
  });
  console.log(`Status: ${r6.status}`);
  const r6body = JSON.parse(r6.body);
  const r6text = JSON.stringify(r6body);
  const hasImageFallback = r6text.includes("[Immagine non analizzabile]");
  console.log(`Has image fallback text: ${hasImageFallback}`);
  if (r6.status === 200 && hasImageFallback) { ok++; console.log("  ✓ PASS"); } else { fail++; console.log("  ✗ FAIL"); }

  // ── Summary ──
  console.log(`\n━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${ok} passed, ${fail} failed`);
  console.log(`━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch(console.error);
