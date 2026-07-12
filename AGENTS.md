# Repository Guidelines

## Project Structure & Module Organization

This repository contains a modular Node.js HTTPS proxy and a Gemini vision MCP server.

```
proxy/
├── server.js                  Composition root — loads config, TLS, starts HTTPS
├── app.js                     HTTP routing, JSON validation, probe interception,
│                              adapter dispatch, error normalization
├── config/
│   ├── env.js                 .env loader, validation helpers (URL, model maps)
│   └── providers.js           Provider definitions with capabilities, model maps
├── routing/
│   └── resolve-provider.js    Model→provider resolution, image auto-routing,
│                              capability gating, precedence rules
├── protocols/
│   ├── anthropic.js           Native Anthropic passthrough + SSE state
│   ├── openai-chat.js         Anthropic↔OpenAI Chat Completions conversion
│   │                          (request, response, streaming, tool calls, schema)
│   └── gemini.js              Anthropic↔Gemini conversion + SSE state
├── providers/
│   ├── anthropic-compatible.js  DeepSeek, Z.AI (passthrough + model restore)
│   ├── openai-compatible.js     OpenCode, generic /v1/chat/completions backends
│   └── gemini.js                Image OCR pipeline (describe → inject → forward)
├── transport/
│   ├── http.js                  HTTP/HTTPS request builder, streaming + non-streaming
│   └── sse.js                   SSE parser with bounded buffering, CRLF/LF handling
└── test/
    ├── protocols/               Protocol converter unit tests
    ├── routing/                 Routing logic unit tests
    └── integration/             Full-stack tests with mock upstreams
```

TLS helpers are under `certs/`. The ES module MCP service is in `mcp-gemini-vision/`.
Root `setup.*` scripts install and configure the project; `start.*` and
`ecosystem.config.js` launch services.

## Build, Test, and Development Commands

- `setup.bat` (Windows) or `./setup.sh` (Linux/macOS): configure API keys, generate certificates, install the local CA, and prepare Claude Desktop.
- `node proxy/server.js`: run the proxy directly on `https://localhost:8877`.
- `start.bat` or `./start.sh`: use the platform launcher for normal local operation.
- `pnpm test`: run the offline test suite with Node 22's built-in `node:test` (no API keys needed).
- `pnpm run test:coverage`: run tests with `--experimental-test-coverage`.
- `pnpm run test:live`: run `proxy/test-proxy.js` against an already-running proxy (requires API keys).
- `pnpm run check`: syntax-check `server.js` and run the offline test suite.
- `cd mcp-gemini-vision && npm install && npm start`: install and run the Gemini image-analysis MCP server.
- `pm2 start ecosystem.config.js`: run the proxy through PM2 for persistent local use.

There is no compilation step. The package uses `pnpm@11.11.0` as the package manager;
`node --test` is the test runner (available via `pnpm test`).

## Coding Style & Naming Conventions

Match existing JavaScript: two-space indentation, semicolons, double quotes, and
`camelCase` identifiers. Use `UPPER_SNAKE_CASE` for constants. Each module exposes
a focused public API; provider behavior is isolated in `providers/`, protocol
conversion in `protocols/`. No formatter or linter is configured, so follow
surrounding style.

## Testing Guidelines

Unit tests live in `proxy/test/protocols/` and `proxy/test/routing/`. Integration
tests live in `proxy/test/integration/`. Use Node 22 `node:test` and `node:assert/strict`.

Cover both successful conversion/routing and failure behavior: malformed payloads,
streaming events, unsupported features, tool calls, schema preservation, and
provider fallbacks. Integration tests use mock HTTP upstreams — no API keys or
internet access required.

Never put real credentials or generated certificate material in fixtures or commits.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`,
`fix(setup):`, `docs:`, `refactor:`, and `chore:`. Write an imperative, specific
subject and keep each commit scoped to one concern. Pull requests should explain
the affected provider or setup path, list commands run, note required environment
variables, and include relevant terminal output. Link issues when applicable.

## Security & Configuration

Copy `.env.example` to `.env` and keep all API keys local. The generic
`OPENAI_COMPAT_*` backend is disabled unless base URL, API key, and at least one
model mapping are present. HTTP is only permitted for loopback hosts.

Do not weaken localhost binding, TLS verification, payload limits, input validation,
or CORS protections without documenting the security impact. Treat files generated
under `certs/` as machine-specific secrets.
