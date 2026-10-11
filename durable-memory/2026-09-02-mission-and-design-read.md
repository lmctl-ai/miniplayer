# miniplayer — mission & design phase state (2026-09-02)

## Mission (from math meta-lead, /home/mma/repos/egtry-books-math/math.lmctl:Lead)

Build **miniplayer**, a lightweight opencode:
- One-shot prompt only — NO session resume, NO tool calls.
- Must drive ALL providers / LLMs (like opencode).
- Participates in the mail lane via its runner: incoming message = prompt, whole reply = mailed response. Replies must be self-contained, single-turn, complete.
- Phase: DESIGN ONLY, no code yet. Design read sent to math Lead; clarify before implementing.

Sibling references:
- ../opencode — full agent; provider abstraction to mirror (Vercel AI SDK, models.dev catalog, `provider/model` IDs).
- The model catalog (schema-version-1 JSON, ~3936 records, OpenRouter + LiteLLM sources) — published at https://lmctl.com/dataset/model_list.json.

## Key facts gathered

### opencode provider abstraction
- Model IDs are `provider/model`; registry fetched from models.dev (cached, bundle fallback).
- All calls normalized to Vercel AI SDK `LanguageModelV3`; per-provider `api.npm` routing key, fallback `@ai-sdk/openai-compatible`.
- Auth: per-provider env-var list from catalog → config `options.apiKey` → auth.json store.
- Minimal subset for miniplayer: catalog + `provider/model` parse + AI SDK factory map + openai-compatible fallback + env-key resolution + `generateText()`. Drop: streaming, tools, sessions, OAuth, plugins, npm auto-install.
- Key files: packages/opencode/src/provider/provider.ts, packages/core/src/models-dev.ts, packages/opencode/src/session/llm.ts.

### Model catalog
- model_list.json ≈ 10.5 MB (fine to load whole in a CLI), schema_version 1, `records[]` with: record_id, source (openrouter|litellm), provider (TWO unreconciled vocabularies), mode, gateway_id, vendor_model_id, canonical_slug, context_window, pricing (per-token USD), capabilities (tri-state flags, null = unknown).
- Chat filter: `mode === "chat"` (3098 rows), NOT capability flags. All 420 OpenRouter rows are chat, priced, uniform gateway_id → path of least resistance.
- Lookup policy: exact match only on source_model_id / gateway_id / vendor_model_id / canonical_slug; no fuzzy matching.
- No lookup code shipped — miniplayer filters the JSON itself.
- Catalog built from OpenRouter API + LiteLLM prices JSON; published to the public URL above.

## Design read (sent to math Lead 2026-09-02)

See reply file sent via lmctl chat — summary:
1. Enumerate/select: load the catalog's model_list.json, filter mode==="chat", exact-match selection per the catalog lookup policy; `miniplayer models` list command with provider/price/capability filters.
2. One-shot call: Node 20+ ESM (no build step), Vercel AI SDK `generateText()`, small provider factory map + openai-compatible fallback, env-var keys per provider, `provider/model` IDs (opencode convention).
3. Mail-lane output contract: stdout = complete self-contained reply only; diagnostics to stderr; nonzero exit on failure; runner wraps mail.
4. Open questions for math: (a) OpenRouter-first (420 uniform rows, one key) vs all-providers-direct v1; (b) catalog dependency: local read vs published snapshot fetch-with-cache; (c) reconciling catalog provider vocab with SDK provider ids for litellm-source rows; (d) plain Node ESM vs TS.

## Next steps
- Await math Lead's answers to the 4 questions, then produce implementation plan and delegate to Coder (gpt-5.6-sol) / Reviewer (claude-opus-5).

## GREENLIGHT from math Lead (2026-09-02) + Lead's design decisions

Math's answers (details are Lead's calls; direction given):
1. End state is provider-general (operator directive). v1: minimal scope but all-providers
   ARCHITECTURE — the factory map + openai-compatible fallback IS the approach; wiring OpenRouter
   first is acceptable since adding providers = map entries.
2. v1 reads a local copy of the catalog (model_list.json) directly. Published-fetch is a later enhancement.
3. litellm provider-vocab mapping: Lead's domain; the catalog schema fields are source of truth.
4. Language: Lead's domain.

Lead's decisions for v1:
- **Language**: plain Node 20+ ESM (minimal footprint, no build step) + `ai` (Vercel AI SDK).
- **Catalog**: local read of the catalog JSON, overridable via MINIPLAYER_CATALOG.
- **Routing**: openrouter-source rows → OpenRouter gateway via openai-compatible
  (OPENROUTER_API_KEY, baseURL https://openrouter.ai/api/v1), model id = gateway_id.
  litellm-source rows → small static map litellm_provider→SDK factory (openai, anthropic,
  gemini→google) with env-var keys; unmapped provider = clear error. Unknown npm → openai-compatible.
- **Output contract**: stdout = complete self-contained reply ONLY; diagnostics to stderr;
  nonzero exit on failure. One-shot, no session, no tool calls.
- **Process**: Coder writes, Reviewer cross-reviews (author != reviewer), incremental commits.

## Current status
- 2026-09-03: math Lead issued the full TASK: v1 runner + auto-nudge 5-way RESPONSE CLASSIFIER as
  first consumer (spec in project-root `miniplayer-prep.md`). Labels: escalation / task-done /
  all-done / rate-limited / error, output `{label, reason, confidence}` JSON, classification entirely
  in-prompt. Post-v1 validation targets (keep model swappable): codex/gpt-5.3-codex-spark,
  claude/claude-haiku-4-5, dsh/deepseek-v4-flash. Reply format to math: last line UPPERCASE
  `DONE <summary>` or `BLOCKED <reason>`.
- First Coder delegation (2026-09-02) was lost with the session — Coder got the prompt, produced no
  work (repo still empty). Re-delegated 2026-09-03 as combined task
  `.lmctl-outbox/coder-task-v1b.md` (runner core + classifier), running in background.
- Next: Coder builds → Reviewer cross-reviews → Lead gates → end-to-end classify demo → report DONE
  to math Lead.

## v1 COMPLETE (2026-09-04, Coder gpt-5.6-sol, HEAD 4a49823)

8 incremental commits, 15/15 tests green. Live e2e classification via OpenRouter
`deepseek/deepseek-v4-flash-20260423`: input "catalog migration complete, two more queued tasks" →
`{"label":"task-done","reason":"...","confidence":0.95}`. Deviation: `deepseek/deepseek-v4-flash`
ambiguous across sources → documented alias pins the openrouter canonical slug. Native
openai/anthropic/google calls untested (no keys). Reviewer cross-review still owed.

## Enhancement wave (operator/math 2026-09-08, lmauto dogfood 2026-09-05)

Consumers: lmauto auto-nudge double-check (live, direct CLI shell-out, fails open on non-zero exit),
lmbee #128 --miniplayer-verify. Confirmed CLI contract: stdout = one JSON line, exit 0/1/2
(2 = invalid classification object). New work delegated to Coder:
1. DEFAULT selector + provider POOL: bare `miniplayer run` must work zero-config. Resolution:
   `-m` (force, escape hatch kept) > config `pool` (random + rate-limit failover) > config `model`
   > BUILT-IN default pool (cheap catalog-real ids). Full-pool exhaustion → stderr + exit 1.
2. Provider gaps: add litellm_provider mappings `moonshot` (MOONSHOT_API_KEY) and `deepseek`
   (DEEPSEEK_API_KEY) — both openai-compatible; verify baseURLs against ../opencode catalog.
   Gemini pool name: real catalog id is gemini-3.7-flash (no "3.8").
3. README: clarify bare vs prefixed selector forms, document pool/default/exit codes.
4. Tests for pool/failover/exhaustion/-m-bypass + new mappings.

lmauto teamfile (for replies): /home/mma/repos/lmauto/lmauto.lmctl.

## Pool build COMPLETE (2026-09-12, Coder, HEAD 91e6846)

6 commits, 24/24 tests. Resolution: `-m` > config pool > config model > built-in 6-model pool
(random, keyless-skipped, 429-only failover, exhaustion → exit 1 + empty stdout). moonshot
(https://api.moonshot.ai/v1) + deepseek (https://api.deepseek.com) mappings added, baseURLs verified
against opencode's models.dev snapshot. Contract confirmed to lmauto (delivered, msg_tcl_21920):
`-m` escape hatch kept, pool in config.json, shell-out shape endorsed. lmauto flagged: this host has
NO raw provider keys (session/OAuth only) — operator provisioning issue.
NOTE: math v1 DONE report (.lmctl-outbox/reply-math-v1-done.md) NOT yet delivered — math Lead
terminal-held; retry task killed by restart 2026-09-13. RESEND after deepseek-default lands.

## Operator model decision (2026-09-13)

DEFAULT = `deepseek/deepseek-flash` via metered DeepSeek API (DEEPSEEK_API_KEY). NOT in the
catalog (0 exact matches) → Coder adding direct provider passthrough (`<routed-provider>/<model>`
resolves without a catalog row; catalog stays source of truth for listing/metadata). deepseek-flash
= primary built-in default; pool failover retained. Verify `echo test | miniplayer run` (needs key).
Delegated to Coder 2026-09-13 (background). Then: Reviewer cross-review of whole tree → resend
consolidated report to math.

## deepseek-flash default COMPLETE + live e2e (2026-09-13, HEAD 29d6e3b, 29/29 tests)

Coder added `src/selector.js` passthrough (alias → catalog exact → direct `<routed-provider>/<model>`)
and put `deepseek/deepseek-flash` first in the built-in pool (failover = rest of pool). Deviation:
added MINIPLAYER_CONFIG env override because operator had provisioned ~/.config/miniplayer/config.json
(model: deepseek-v4-flash + deepseek apiKey). LEAD-VERIFIED LIVE: `echo test | miniplayer run` → real
DeepSeek completion exit 0; `classify` → valid task-done JSON exit 0 (via config path; env-key path
shares the same credential-resolution code, DEEPSEEK_API_KEY not in env).
Outstanding: (1) Reviewer cross-review IN FLIGHT (bash-284g8gh6); (2) consolidated math report
(.lmctl-outbox/reply-math-consolidated.md) delivery retrying (bash-8r0uza7a); (3) after review
verdict: ping lmauto (ack credential flag + pool-landed notice) and forward verdict to math.

## Reviewer verdict: SHIP-AFTER-FIXES (2026-09-13, claude-opus-5)

Empirically reproduced findings. P0-1: prefixed litellm `vendor_model_id` sent verbatim →
gemini/moonshot built-in pool entries unreachable (strip `${provider}/` prefix for route.modelId).
P1: bad pool entry / unroutable provider aborts whole run instead of skip; zero-arg help on stdout
exit 0 (→ stderr+1); MINIPLAYER_CONFIG typo silently ignored; passthrough model-id unvalidated
(regex `/^[A-Za-z0-9._:-]+$/`). P2 batch: env threading, models DI, EPIPE stack trace, dead
resolveModel, bad README example, `--` terminator. Key coverage adds: "401 does not roam",
prefixed-vendor-id regression, CLI-level exit 2, config error paths. Fixes delegated to Coder
(coder-task-v4-review-fixes.md, bash-zyvlnztx). After green: focused re-review → final math/lmauto
pings. lmauto coordination DONE (msg_tcl_21952): host config (deepseek-v4-flash) vs source default
(deepseek/deepseek-flash passthrough) compose cleanly; contract unchanged.

## FINAL STATE (2026-09-13, HEAD cdb035b, 50/50 tests)

All work complete: v1 + pool + deepseek-flash default + review fixes + re-review SHIP + both P2
nits (config env threading; config-pool skip warning on stderr; fixture cleanup). Live-verified
end-to-end multiple times via DeepSeek.
Ollama: Windows-host server reachable from WSL at http://172.18.32.1:11434 with qwen2.5:14b —
see durable-memory/local_ollama_qwen25.md (all 3 endpoints tested; openai-compatible /v1 works;
candidate zero-cost pool provider later).
Open loops (async delivery only): consolidated report to math (retry loop; math Lead terminal-held
since 09-09) and SHIP notice to lmauto (retry loop; was busy with operator). Both prompt files are
final — any attempt that lands delivers current truth.

## qwen2.5-local wave (operator decisions 2026-09-13/14, supersedes deepseek-default)

- Bake-off v1 (12 samples, #128/#146 labels): qwen2.5:14b 11/12 = deepseek 11/12, parity.
  Operator independently confirmed 3/3 on live cases. Verdict: ADEQUATE.
- Landed: ollama provider (openai-compat, OLLAMA_HOST or localhost:11434, no key, 29 catalog rows +
  passthrough; commits ce908c5..930b6c3); connectivity failover (ECONNREFUSED/reset/timeout-ish
  network errors roam; 401/400/500 abort); `poolOrdered: true` config option (7cba756..8fa872d,
  60/60 tests). Live: miniplayer classify -m ollama/qwen2.5:14b → correct task-done/escalation JSON.
- IN FLIGHT (Coder, coder-task-v8): built-in default becomes ollama/qwen2.5:14b primary +
  deepseek/deepseek-flash pinned failover; FINITE 60s/call timeout (AbortSignal, env
  MINIPLAYER_REQUEST_TIMEOUT_MS) with timeout failover-eligible — fleet bug #167 context; blackhole
  failover test required. Then: fuller bake-off v2 (16 harder cases, bash-3dz4k0gj), lmauto config
  coordination (pool ["ollama/qwen2.5:14b","deepseek/deepseek-v4-flash"] + poolOrdered), final math
  report (update reply-math-consolidated.md + restart retry loop).

## WAVE COMPLETE (2026-09-14, HEAD 88d32ef, 66/66 tests)

- Fuller bake-off: qwen 14/16 vs deepseek 13/16 (hard-only 13/14 vs 12/14) — adequate, confirmed.
- Landed: ollama/qwen2.5:14b pinned built-in primary + deepseek pinned failover (0326b0c); 60s/call
  AbortSignal timeout, env>config override, abort covers SDK retries, timeout failover-eligible
  (0512e46); post-drain explicit exit (88d32ef, Node held aborted sockets ~10s). Lead-verified:
  healthy zero-config → qwen answers; blackhole 10.255.255.1 @3000ms → failover error in 3.2s.
  Coder: blackhole→deepseek answered in 3.3s @2000ms. task175 confirmation folded into math report.
- Delivery loops running: final consolidated math report (bash-4gt7inot), lmauto qwen config flip
  (bash-nekzhqxo; pool+poolOrdered+OLLAMA_HOST/baseURL, zero consumer changes). Earlier lmauto SHIP
  notice superseded by the qwen message (never delivered; dropped intentionally).
- Open: lmauto to send exact #128/#146 prompts + real samples for verbatim confirmation; lmauto
  applies the config flip on the daemon host.
- #175 response folded into math report: numbers pick = shipped default 60s, daemon config
  `requestTimeoutMs: 30000` (warm qwen calls 3–25s; blackhole failover ~31s; refused = instant);
  both math action items already DONE empirically. Delivery loops: math (bash-bn11w0zg), lmauto
  qwen config (bash-1zwpowbc).
- lmauto APPLIED the config flip on the daemon host and live-verified end-to-end (delivered
  2026-09-14, attempt 1). The free-local-primary classifier layer is LIVE.
- #175 CLOSED both sides: lmplayer2 confirmed AbortSignal.timeout honored on the real
  @ai-sdk/openai transport with generation defaults unchanged (regression test
  packages/opencode/test/provider/header-timeout.test.ts); miniplayer's per-call bounds confirmed.
- Only open loop: math consolidated report delivery (bash-ignbgckm, 30min cadence; math Lead
  terminal-held since 09-09 — content final).

## lmauto flip applied + ambiguity finding (2026-09-14)

lmauto applied the config flip (used provider.ollama.baseURL config override instead of systemd
env) and live-verified lmbee's exact spawn shape. FINDING: `deepseek/deepseek-v4-flash` is
AMBIGUOUS in the catalog (litellm + openrouter rows) → config-pool entry was being SKIPPED with a
warning — the safety net was dead. Verified fixes: `deepseek/deepseek-flash` → passthrough
(direct:deepseek/deepseek-flash, uses existing deepseek key); bare `deepseek-v4-flash` → unique
litellm row. Also verified NO fall-through: an all-skipped config pool exits 1 exhausted (built-in
pool never leaks in). Corrected config for lmauto: second pool entry = `deepseek/deepseek-flash`.
Verbatim-template bake-off (lmauto's exact #128/#146 buildPrompt, 10 cases incl. real epic #65)
running (bash-ablfgbxr); reply to lmauto + math report update after. Consider README note on
ambiguous-id disambiguation (batch into next Coder task).

## 2026-09-15 wrap

- Verbatim bake-off DONE: qwen 7/10 = deepseek 7/10, 10/10 agreement on lmauto's exact templates.
  3 shared misses = template-level over-flagging (#146 on_hold/quiet-in_progress; #128 commit-mention
  reads as report) — lmauto's tuning call. Reply sent (reply-lmauto-verbatim.md).
- Failover selector fix handed to lmauto: use `deepseek/deepseek-flash` (passthrough), NOT
  `deepseek/deepseek-v4-flash` (ambiguous → skipped). Verified no fall-through on all-skipped pool.
- EconomyCoder BLOCKED on dsh infra: seed turn fails (`reason=error, no assistant text`) even after
  teamfile model fix deepseek-flash→deepseek-v4-flash (fix is correct, stays). Reported to math in
  consolidated report. Trial task (README ambiguity note) stays queued for it.
- lmcron contract reply loop (bash-v8hlj0md) and math report loop still retrying against busy/
  terminal-held receivers; contents final.

## Pilot: token-saving Lead behavior (operator via math, 2026-09-15)

Reviewer is now EXCEPTION-ONLY. Lead assigns + sanity-checks (real verification, not read-through).
Invoke Reviewer when: auth/credentials/secrets; writes outside repo (publish/deploy/S3/remotes/
other teams' surfaces); schema/migration; deletes/overwrites existing work; irreversible; blast
radius beyond own lane; already-failed-once fixes; or Lead cannot verify the claim. author !=
reviewer still holds when invoked. EconomyCoder-first for routine bounded work (currently blocked
on dsh seed infra); expensive Coder for hard diagnosis. Report pilot leaks (things a Reviewer would
have caught) to math — that's the evaluation data.

## Ledger + EconomyCoder resolution (2026-09-15/17)

- EconomyCoder moved dsh→agy ("Gemini 3.8 Flash (Medium)") by math/operator; dsh has no creds here.
  FIRST TRIAL PASSED Lead sanity check: README ambiguous-selector note (commit b1726e7), accurate
  claims vs code, scoped 10-line diff, 66/66 tests green. Fit for routine bounded tasks.
- lmbee ledger rows CLOSED via `lmbee queue respond` (the durable channel — prose/chat replies do
  NOT close rows): #11512 (classifier contract DONE+live), #11519 (SHIP + qwen wave), #11771
  (quality pass + dead-endpoint failover, both empirical), #12087 (pilot ack + EconomyCoder trial
  result). All referenced reply-math-consolidated.md for detail. LESSON: use `lmbee queue respond
  <id> ... --from miniplayer` to close expects-response rows; lmctl chat replies don't close them.
- lmauto deployed failover-selector fix (build 4fd3fac); qwen-primary live both sides.
- Math consolidated-report chat loop RETIRED — math reads the file directly; queue respond is the
  durable response channel.
