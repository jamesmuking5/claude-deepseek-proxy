# TODO

## Client model-ID gotchas (Claude Code gates features by model ID)

Claude clients decide feature availability from the *Claude* model ID in the
map, not from the real upstream model. When choosing which Claude ID to map a
provider to, remember:

- **Effort/reasoning slider**: only shown for model IDs Claude Code knows are
  effort-capable (Fable 5, Opus 4.5+). Mapping to a made-up ID
  (`claude-opus-4-9`) or older ID silently hides the slider (found 2026-07-13).
- **Context window budgeting**: the client budgets/compacts against the
  *claimed* model's context (e.g. Fable 5 = 1M). If the upstream model's real
  context is smaller (grok-4.5, deepseek), the client will happily build
  prompts the upstream rejects with a 400 once history grows. No proxy-side
  guard exists yet — consider clamping/erroring early or documenting per-map
  safe IDs.
- **max_tokens**: client picks its default (e.g. 32000) from the claimed
  model's output limit; must not exceed the upstream's real cap.
- **Vision/attachments**: client enables image attach if the claimed Claude
  model has vision; the provider's `capabilities.vision` flag must match the
  real upstream or requests fail. NOTE: xai config currently has
  `vision: false` while Grok 4.5 supports vision — verify and flip.
- **count_tokens accuracy**: local byte/4 estimate (and xAI tokenize) differ
  from the claimed model's tokenizer, so the client's context meter drifts
  from upstream reality.
- **Model self-identification**: the upstream model will claim to be the
  mapped Claude model in conversation; cosmetic.

## Planned

- **Sampling-parameter policy per provider (temperature/top_p/penalties)**
  Anthropic temp is 0–1, OpenAI-compat 0–2 (1.0 = neutral) — verbatim
  passthrough (current behavior) is semantically wrong in both directions,
  and reasoning models either ignore temperature (Grok, DeepSeek-reasoner)
  or reject it with 400 (OpenAI o-series). Interim plan: drop temp/top_p for
  providers flagged `reasoning: true`, passthrough otherwise, optional
  per-provider hard override (e.g. `XAI_TEMPERATURE=0.7`). Full
  mode/scale/per-param matrix belongs in the SQLite + Web UI config
  (see below) — flat .env cannot express per-provider × per-parameter
  policies sanely.

- **SQLite-backed config + Web UI** to replace the (possibly outdated)
  `setup.sh` / `setup.bat` flow: manage providers, API keys, model maps, and
  per-provider reasoning-level mapping (incl. allowed effort vocabularies per
  upstream, e.g. OpenAI `minimal|low|medium|high` vs xAI grok-mini `low|high`)
  through a GUI instead of hand-edited .env files.

## From model audits (2026-07-14, see optimization-discussion-*.md)

Grok audited the pre-refactor monolith (stale worktree) — most of its
correctness findings are obsolete; DeepSeek audited current code but its
headline keep-alive finding is wrong (Node 22 `https.globalAgent` already
defaults to `keepAlive: true`; Grok's report correctly downgraded this).
Surviving items:

- **Graceful shutdown**: `server.js` has no SIGINT/SIGTERM handler — every
  `pm2 restart` kills in-flight streams, which clients then retry (double
  billing). Handle signals: stop accepting, drain active streams, exit.
- **Early oversized-body reject**: check `Content-Length` against the 50MB
  cap before buffering instead of after.
- **Anthropic passthrough hot path**: each SSE event is JSON.parse +
  transform (model rewrite only) + JSON.stringify; a targeted string
  replace or passthrough would skip both. Low priority, measurable only
  on very long streams.
- **`certs/generate-certs.mjs` broken**: produced PEMs Node rejects with
  `ERR_OSSL_ASN1_WRONG_TAG` (Grok, E2-verified). Setup path needs rework —
  folds into the SQLite + Web UI setup plan.

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
