# Server implementation notes

Run with Node.js 24+ using `npm start` from the repository root. No runtime dependencies are required. The browser is a client; closing it does not pause work. The Node process must remain alive.

## Model connections and profiles

`GET/POST /api/connections`, `PATCH /api/connections/:id`, `GET/POST /api/agents`, and `PATCH /api/agents/:id` manage two separate registries. A connection specifies a provider/model; profiles specify their role, name, instructions, connection and optional supported reasoning effort. Multiple profiles can share one connection. No separately trained or externally autonomous agents are implied.

Provider types are `demo`, `nvidia`, `ollama`, and `compatible`. NVIDIA uses only `https://integrate.api.nvidia.com/v1`. Ollama requires `OLLAMA_ENABLED=true`, an operator-configured loopback origin, and an already locally installed model returned by `/api/tags`. Cloud models and automatic model downloads are disabled. Generic compatible HTTPS endpoints require their exact origin in `HUDDLE_ALLOWED_API_ORIGINS`; removal from that allowlist revokes future calls. Redirects are not followed. Huddle does not configure billing or promise any third-party endpoint is free.

Write-only `apiKey` values are encrypted using AES-256-GCM in SQLite. The random master key is stored in the runtime data directory's `.huddle-keyring` (mode 0600), or `HUDDLE_SECRET_KEY_FILE`. Never commit or publicly back up either file. This protects against a database-only disclosure, not an attacker who controls the server or obtains both files. The server can decrypt its keys to send explicitly started model requests. GET responses contain only `hasApiKey`, never a secret. An empty `apiKey` PATCH clears the encrypted key; omitted `apiKey` preserves it. `apiKeyEnv` may refer only to `NVIDIA_API_KEY` or `HUDDLE_API_KEY_*` variables. An encrypted key takes precedence over an environment reference. Changing a connection’s destination (origin or path) cannot silently reuse either credential. Re-enter the API key, choose a different environment reference, or explicitly clear both credentials. A newly entered key clears the old environment fallback; a new environment reference clears the old encrypted key.

Reasoning effort is sent only for explicitly declared supporting connections and only when the profile selects a non-default effort. Support is operator-declared, not automatically tested; the upstream model may still reject a mistaken declaration. Internal reasoning fields are never displayed or persisted. Conversation output is limited to conclusions, critiques, evidence summaries and text artifacts.

## Groups and the scheduler

- `GET/POST /api/groups`: list/create groups; `?archived=true` lists archived groups
- `GET /api/groups/:id`: full group, profiles, messages, criteria, runs and artifacts
- `POST /api/groups/:id/actions`: `start`, `pause`, `resume`, `cancel`, `retry`, `accept`, `archive`, `restore`
- `POST /api/groups/:id/messages`: a human message
- `POST /api/groups/:id/members`: invite one saved profile
- `POST /api/groups/:id/criteria/:criterionId`: human criterion acceptance during review

Every group mutation requires the current integer `expectedVersion`; stale updates receive HTTP 409. Creation takes `title`, `goal`, `criteria`, `initialAgentIds`, `maxAgents`, `maxTurns`, and `maxTokens`. `provider` can select seed profiles when explicit IDs are omitted. One profile coordinates initially. Each remaining selected candidate performs a durable, budgeted model turn to assess whether its own role can contribute, then joins only if it self-nominates. Existing members take turns in round-robin order. The group cannot recruit unselected profiles or exceed its human-set roster cap. A human can explicitly invite an additional saved profile within that cap. Sample and live agents cannot mix.

Each turn is persisted as a run with an epoch. Pausing, cancellation, new human context, membership changes and active settings changes invalidate the old epoch and abort the request. A late response cannot commit. The run response, artifact and messages commit atomically; a unique index prevents duplicate persisted agent turns. Model requests may still happen more than once following an interruption or crash: exactly-once external inference is not promised.

On a graceful restart, previously running groups resume from their last committed turn. Interrupted attempts retain their reserved budget. A single-process lock prevents multiple schedulers owning a database. After an unclean kill, startup fails closed if the lock remains. Verify the PID in `data/huddle.sqlite.lock` is not running, then remove only that stale lock and restart. Never remove a live process's lock. This intentional manual recovery avoids a concurrent stale-lock takeover race.

The scheduler has at most three in-flight group jobs. Maximum limits are 40 committed turns, 120 attempts, 12 group profiles and 200,000 conservative token budget units per group. Custom lower caps apply. Up to two retries follow transient network/timeout/HTTP 429/5xx failures, with abortable exponential backoff and bounded Retry-After. Every attempt reserves budget, including failed/interrupted calls and self-nomination. A group's `tokensUsed` is the conservative reservation total (UTF-8 prompt bytes plus a capped output allowance and framing margin), **not measured billing usage**. Budget is never automatically reset or refunded. Deterministic demo turns reserve 100 demonstration units and consume no model tokens.

A model may request the `review` state only when an artifact exists. It cannot set criterion acceptance or the `completed` state. The human must review and explicitly accept every criterion, then accept the overall result. Resuming work clears earlier acceptance. Agreement between personas is not proof of external task completion.

## Access and HTTP defenses

One instance is a single-owner workspace. Session tokens are random, hashed in the database, HttpOnly and SameSite=Strict. All authorized browsers share the operator workspace. Ownership checks still apply internally; this is not a multi-tenant account system.

Default binding is loopback. A non-loopback bind **or public origin** requires a 24-character-or-longer access secret. Remote deployment also requires TLS and a correctly configured trusted reverse proxy. `HUDDLE_PUBLIC_ORIGIN` is exact; forwarded host headers are not trusted. Workspace unlock uses `POST /api/session`. Changing the configured access secret invalidates all old sessions.

API mutations require a matching Origin and JSON content type. Host checking defends against browser DNS rebinding. Requests, response size, stored text, groups, profiles and connections are bounded. API rate limits are process-local. Provider failures never echo upstream response bodies, keys or prompts. CSP and UI escaping treat model/user output as untrusted.

## Verification

`npm test` covers deterministic orchestration and nomination, human-only acceptance, optimistic concurrency, ownership, pause/late-response fences, restart recovery, budgets, mocked provider 429/timeout/errors, key encryption/redaction, local-model restrictions, allowlist revocation, sample/live isolation, HTTP origins/auth/body limits and frontend escaping.

Real NVIDIA, Ollama and third-party inference are not tested by the automated suite. Mock responses validate protocol/error behavior only. Configure a fresh private credential or already installed local model yourself to test real inference. Never put a chat-pasted key in a fixture or configuration.
