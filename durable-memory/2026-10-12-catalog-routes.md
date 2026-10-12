# Catalog routes: zero-config providers (2026-10-12)

Owner goal: miniplayer handles all well-known providers with ZERO config; setup is exporting the
provider's standard key env var.

- lmprice (branch `miniplayer-column`, commits 07a07c0 0636040) adds `miniplayer: null | {id,
  provider, model, sdk, base_url, key_env}` to every record, derived from its
  data/miniplayer-providers.json. The published catalog carries it after the next lmprice build;
  until then records lack it and the built-in table answers.
- miniplayer: a record with the column is routed from it alone; selectors match `miniplayer.id`
  first; `<provider>/<any-model>` uses the provider's catalog route (brand-new models); unknown
  providers list the known ones. LITELLM_PROVIDERS stays as the fallback, routes unchanged.
- Precedence: baseURL = config > OLLAMA_HOST (ollama) > record > SDK default; key = env[key_env] >
  config apiKey (plaintext, discouraged). Keyless (key_env null) sends no Authorization header.
- Behaviour changes: `-m openai/gpt-6` now picks the routed direct-OpenAI record even when an
  OpenRouter record has gateway_id `openai/gpt-6` (previously that OpenRouter record);
  missing-key text is now `Missing API key for <p>: export <KEY_ENV>=... (or set
  provider.<p>.apiKey in the config; discouraged)` on every route; an unknown provider prefix
  appends the known-provider list to "No model matches selector ...".
- New commands: `miniplayer providers [--json]`, `miniplayer models --routed [--provider p]
  [--json]`, `--json` on `models`.
- Tests: tests/catalog-routes.test.js + fixtures/catalog-routes.json; throwaway mutation run 5/5.
- Unverified: the real published catalog with the column (not built yet); live provider calls
  (tests use a local OpenAI-compatible endpoint); two lmprice table entries are themselves
  marked unverified there (fireworks_ai key env, perplexity base URL).
