"use strict";

const https = require("https");
const http = require("http");

const DEFAULT_TIMEOUT = 120000;
const DEFAULT_CONNECT_TIMEOUT = 15000;

function buildRequest(url, method, headers, body, timeout) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const transport = isHttps ? https : http;

  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const defaultHeaders = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(bodyStr),
  };

  const allHeaders = Object.assign({}, defaultHeaders, headers);

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: method || "POST",
    headers: allHeaders,
    timeout: timeout || DEFAULT_TIMEOUT,
  };

  return { transport, options, bodyStr };
}

function sendRequest(url, method, headers, body, timeout) {
  return new Promise((resolve, reject) => {
    const { transport, options, bodyStr } = buildRequest(url, method, headers, body, timeout);

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: raw,
        });
      });
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timeout after ${options.timeout}ms`));
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

function sendStreamRequest(url, method, headers, body, timeout) {
  return new Promise((resolve, reject) => {
    const { transport, options, bodyStr } = buildRequest(url, method, headers, body, timeout);

    const req = transport.request(options, (res) => {
      resolve({
        status: res.statusCode,
        headers: res.headers,
        stream: res,
        request: req,
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timeout after ${options.timeout}ms`));
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = { buildRequest, sendRequest, sendStreamRequest };
