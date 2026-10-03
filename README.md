# Huddle

A group-only workspace where people give AI agents a goal, agents collaborate in a shared conversation, and a person verifies the result.

**Local-first. NVIDIA Build and local Ollama. No paid-provider presets or silent paid fallbacks.**

## What it does

- Create a group with a goal and clear acceptance criteria
- Connect model endpoints and create agents with their own roles, instructions, and supported reasoning settings
- Let several agents share a model, or give different agents different connections
- Run bounded conversations with agent membership events and saved text deliverables
- Pause, resume, cancel, and review work; completion requires human acceptance
- Save conversations and run state in SQLite on the server
- Continue working when the browser is closed, while the server remains running
- Try an explicitly labeled deterministic demo without credentials

This is a working first version for collaborative reasoning and text deliverables, not a system that can guarantee every problem is solvable. Agents do not have a code execution sandbox, web browser, or permission to act on external accounts. Their agreement is not proof of correctness.

## Quick start

Requires **Node.js 24 or later**. There are no runtime packages to install.

```sh
npm start
```

Open **http://127.0.0.1:4310**. Create a demo group to explore the full workflow without an API key.

To change server options, copy `.env.example` to `.env` and restart. The app uses Node's built-in SQLite API, which may print an experimental warning on some Node versions.

```sh
cp .env.example .env
npm start
```

Never commit `.env`, runtime databases, or the keyring. They are excluded by `.gitignore`.

## Real models

### NVIDIA Build

Use your own NVIDIA developer account and a model you are entitled to use. Configure a connection in the app or set the documented server environment variables. Do not paste credentials into conversations, issues, screenshots, or source files.

Free developer access is for prototyping and is subject to NVIDIA's current terms and quotas. Huddle does not promise unlimited free inference or change provider billing settings. There is no fallback to another provider when a request fails.

### Local Ollama

Install Ollama separately and download a suitable model on the server's machine. Enable the local provider according to `.env.example`. Model availability and speed depend on your hardware. Ollama cloud subscriptions are not used by the local adapter.

### Multiple agents

A model connection defines how to reach a model. An agent defines a name, role, instructions, and its selected connection. Reusing one connection creates multiple personas using that model, not several separately trained models. Reasoning controls only work when the selected endpoint/model supports them.

See [provider notes](docs/PROVIDERS.md) for official references, costs, and data-sharing considerations.

## Run controls and completion

A run has finite turn and conservative reservation budgets. Displayed budget units are safety estimates, not metered billing tokens. The server controls scheduling, retries, and state transitions. A model can suggest that work is ready for review but cannot mark an arbitrary real-world task as successfully completed. Review the deliverable, check each criterion, and explicitly accept the result.

Closing the browser does not stop the scheduler. Stopping the server suspends execution; persisted work is recovered after a graceful restart. After an unclean crash, startup fails closed on its stale lock until the operator verifies the old process is stopped and removes that lock. See the [server notes](server/README.md) for the recovery procedure. Network interruptions can cause a provider request to be retried: avoid assuming exactly-once external inference even though persisted turns are fenced against duplicate commits.

## Security and deployment

The default server binds only to loopback. It is a **single-owner workspace**, not a production multi-tenant social network. Anyone authorized to access one instance shares that workspace.

For remote hosting, configure the access secret and exact public origin described in `.env.example`, use a TLS reverse proxy, secure your host and backups, and keep runtime data private. Do not expose a development instance directly to the internet. Public source code does not make private conversations public.

Connected model requests include group context. Only send content you are allowed to share with the chosen model provider. Generic endpoint origins require operator configuration; arbitrary browser-supplied network destinations are not accepted.

## Development

```sh
npm run check
npm test
npm run dev
```

- `server/` — HTTP API, SQLite persistence, provider adapters, background orchestration
- `public/` — responsive group-messaging interface
- `tests/` — automated checks
- `docs/` — provider and validation notes

See [validation results](docs/VALIDATION.md), [frontend notes](docs/FRONTEND.md), and [server architecture/API](server/README.md).

## License

MIT for this application's source code. Model weights, model APIs, and third-party services have their own licenses and terms.
