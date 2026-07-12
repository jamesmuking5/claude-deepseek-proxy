# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Node.js HTTPS proxy and a Gemini vision MCP server. Request routing, model mapping, streaming, and validation live in `proxy/server.js`; integration checks live in `proxy/test-proxy.js`. TLS helpers are under `certs/`. The ES module MCP service is in `mcp-gemini-vision/`. Root `setup.*` scripts install and configure the project; `start.*` and `ecosystem.config.js` launch services.

## Build, Test, and Development Commands

- `setup.bat` (Windows) or `./setup.sh` (Linux/macOS): configure API keys, generate certificates, install the local CA, and prepare Claude Desktop.
- `node proxy/server.js`: run the proxy directly on `https://localhost:8877`.
- `start.bat` or `./start.sh`: use the platform launcher for normal local operation.
- `node proxy/test-proxy.js`: test an already-running proxy; live-provider checks require keys in `.env`.
- `cd mcp-gemini-vision && npm install && npm start`: install and run the Gemini image-analysis MCP server.
- `pm2 start ecosystem.config.js`: run the proxy through PM2 for persistent local use.

There is no compilation step or root package script. Before submitting, run `node --check proxy/server.js` and `node --check proxy/test-proxy.js`.

## Coding Style & Naming Conventions

Match existing JavaScript: two-space indentation, semicolons, double quotes, and `camelCase` identifiers. Use `UPPER_SNAKE_CASE` for constants. Keep provider behavior in clearly named configuration branches. Maintain parallel `.bat` and `.sh` behavior where practical. No formatter or linter is configured, so follow surrounding style.

## Testing Guidelines

Add integration cases to `proxy/test-proxy.js`, preserving its numbered-test pattern and explicit pass/fail summary. Cover both successful routing and failure behavior, especially malformed payloads, streaming events, TLS, and optional-provider fallbacks. Never put real credentials or generated certificate material in fixtures or commits.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, `fix(setup):`, `docs:`, `refactor:`, and `chore:`. Write an imperative, specific subject and keep each commit scoped to one concern. Pull requests should explain the affected provider or setup path, list commands run, note required environment variables, and include relevant terminal output. Link issues when applicable; screenshots are only useful for Claude Desktop configuration or setup UI changes.

## Security & Configuration

Copy `.env.example` to `.env` and keep all API keys local. Do not weaken localhost binding, TLS verification, payload limits, input validation, or CORS protections without documenting the security impact. Treat files generated under `certs/` as machine-specific secrets.
