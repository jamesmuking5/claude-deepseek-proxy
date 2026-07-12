"use strict";

const fs = require("fs");
const path = require("path");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  fs.readFileSync(filePath, "utf8").split("\n").forEach((line) => {
    const idx = line.indexOf("=");
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    if (!key || key.startsWith("#")) return;
    const value = line.slice(idx + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  });
}

function getRequired(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function getOptional(key, fallback) {
  const val = process.env[key];
  return val !== undefined && val !== "" ? val : fallback;
}

function parseModelMap(raw, label) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object mapping Claude model IDs to upstream model IDs`);
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) return null;
  return parsed;
}

function validateBaseUrl(url, label) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error(`${label} must use https:// or http:// protocol`);
    }
    if (u.protocol === "http:") {
      const host = u.hostname.toLowerCase();
      if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
        throw new Error(`${label}: HTTP is only permitted for loopback hosts (localhost, 127.0.0.1, ::1)`);
      }
    }
    return url.replace(/\/+$/, "");
  } catch (e) {
    if (e.message.includes(label)) throw e;
    throw new Error(`${label} is not a valid URL: ${e.message}`);
  }
}

const ENV_PATH = path.join(__dirname, "..", "..", ".env");
loadEnv(ENV_PATH);

module.exports = { loadEnv, getRequired, getOptional, parseModelMap, validateBaseUrl, ENV_PATH };
