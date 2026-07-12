"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const { buildProviders } = require("./config/providers");
const { createApp } = require("./app");

const PROXY_PORT = 8877;
const DIR = path.join(__dirname, "..");

const tlsOptions = {
  key: fs.readFileSync(path.join(DIR, "certs", "server-key.pem"), "utf8"),
  cert: fs.readFileSync(path.join(DIR, "certs", "server-fullchain.pem"), "utf8"),
  sessionTimeout: 0,
  minVersion: "TLSv1.2",
  honorCipherOrder: true,
};

function startServer() {
  const providers = buildProviders();
  const configured = Object.keys(providers);
  if (configured.length === 0) {
    console.error("No providers configured. Set at least one API key in .env");
    process.exit(1);
  }

  const handleRequest = createApp(providers);
  const server = https.createServer(tlsOptions, handleRequest);

  server.on("tlsClientError", (err, tlsSocket) => {
    console.error(`[proxy] TLS CLIENT ERROR: ${err.message} (code: ${err.code || "none"}, remote: ${tlsSocket.remoteAddress}:${tlsSocket.remotePort})`);
    tlsSocket.destroy();
  });

  server.on("clientError", (err, socket) => {
    console.error(`[proxy] HTTP CLIENT ERROR: ${err.message} (code: ${err.code || "none"})`);
    socket.destroy();
  });

  server.on("error", (err) => {
    console.error(`[proxy] SERVER ERROR: ${err.message}`);
  });

  server.on("secureConnection", (tlsSocket) => {
    console.log(`[proxy] TLS connection from ${tlsSocket.remoteAddress}:${tlsSocket.remotePort} (ALPN: ${tlsSocket.alpnProtocol || "none"})`);
  });

  server.listen(PROXY_PORT, "127.0.0.1", () => {
    console.log(`\n  Claude → Multi-Backend Proxy (HTTPS)`);
    console.log(`  Listening:    https://127.0.0.1:${PROXY_PORT}`);
    console.log(`  Providers:    ${configured.join(", ")}`);

    for (const [key, ep] of Object.entries(providers)) {
      if (ep.modelMap) {
        console.log(`  ${ep.label}:`);
        for (const [cModel, uModel] of Object.entries(ep.modelMap)) {
          console.log(`    ${cModel} → ${uModel}`);
        }
      } else {
        console.log(`  ${ep.label}: ${ep.model || "image pipeline"}`);
      }
    }
    console.log("");
  });
}

startServer();
