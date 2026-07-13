# TODO

## Planned

- **SQLite-backed config + Web UI** to replace the (possibly outdated)
  `setup.sh` / `setup.bat` flow: manage providers, API keys, model maps, and
  per-provider reasoning-level mapping (incl. allowed effort vocabularies per
  upstream, e.g. OpenAI `minimal|low|medium|high` vs xAI grok-mini `low|high`)
  through a GUI instead of hand-edited .env files.

## Deferred

- **Surface upstream reasoning as thinking blocks (openai-chat streaming)**
  Grok/DeepSeek reasoning models stream `reasoning_content` deltas; the proxy
  currently drops them, so reasoning is invisible in the client UI (tokens are
  still billed as output and counted correctly via `mapUsage`). The removed
  implementation (see discarded branch history around commit `5e8b562`,
  `feat(openai-chat): emit thinking blocks`) emitted them as Anthropic
  `thinking` blocks with a fixed synthetic signature
  (`gateway-synthetic-signature-v1`) and closed the block with a
  `signature_delta` before the first text/tool block. If restored:
  - emit `content_block_start` (type `thinking`) on first `reasoning_content` delta
  - stream `thinking_delta`s, close with `signature_delta` + `content_block_stop`
    before any text or tool_use block starts
  - drop thinking blocks when translating assistant history back to OpenAI
    format (already the case today)

## Known limitations (inherent to OpenAI-compatible upstreams)

- No `cache_control` breakpoints — prefix caching is implicit/upstream-managed.
- `message_start` reports `input_tokens: 0`; real usage arrives in `message_delta`.
- No `ping` SSE events; `top_k`, document/PDF blocks, `redacted_thinking`
  are ignored (no OpenAI equivalent).
- Tool-list churn (e.g. Claude Code deferred tool loading) breaks upstream
  prefix caches — client-side behavior, not fixable in the proxy.
