# @xaedian/paperclip-adapter-openrouter

**OpenRouter adapter for Paperclip** — give every agent access to 300+ models
(50+ free) through a single OpenRouter API key, with a full multi-turn
tool-calling loop against Paperclip's REST API.

> v2 is rewritten as a **self-contained external adapter plugin**: it installs
> through Paperclip's Adapter Manager (npm or local path) with **zero patches**
> to Paperclip source. The old fork-and-patch flow (cloning into
> `packages/adapters/`, applying `REGISTRY_PATCHES.md`) is gone.

Works with Paperclip `>= 2026.4xx` (plugin-store era; typechecked against
`2026.817.0`).

---

## What it does

- **Multi-turn tool loop** — model calls tools, the adapter executes them,
  results feed back until done, `maxTurns`, or repeat-loop protection trips
- **9 built-in Paperclip tools** — get_issue, update_issue_status, add_comment,
  list_comments, create_sub_issue, list_issues, list_agents, hire_agent
  (approval-gated by default), request_approval
- **Issue lifecycle management** — checks out the run lock, moves the issue to
  in_progress at start and done/blocked at end
- **Final output posted as an issue comment** so other agents and humans see it
- **Cost tracking** — real USD cost per run via OpenRouter's `/generation` API,
  fed into Paperclip budgets (`usageBasis: per_run`)
- **Dynamic model discovery** — live model list from OpenRouter with static fallback
- **Declarative config schema** — renders a native agent-config form in the UI
  (no custom React needed)
- **Skills** — loads SKILL.md folders from an operator-managed directory into
  the system prompt
- **Reasoning support** — thinking models emit separate `thinking` transcript entries

## Quick start

### 1. Get an OpenRouter API key

Create one at <https://openrouter.ai/keys>. Free models work at $0 balance but
are capped (~50 requests/day); adding $5 of credits unlocks 1000 free-model
requests/day plus paid models.

You can provide the key three ways (first match wins):

1. **Per-agent config** `apiKey` field (supports Paperclip secret refs:
   store it as a company secret named `OPENROUTER_API_KEY` and set the config
   value to `{{OPENROUTER_API_KEY}}`) — recommended
2. **Server env var** `OPENROUTER_API_KEY`
3. Not set → runs fail fast with a clear error

### 2. Install the adapter

#### Option A — npm package (Adapter Manager)

1. Publish or install this package where your Paperclip server can reach it.
2. In Paperclip: **Settings → Instance → Adapters → Install Adapter → npm package**
   and enter `@xaedian/paperclip-adapter-openrouter`.
3. Or via API:

   ```http
   POST /api/adapters/install
   Content-Type: application/json

   { "packageName": "@xaedian/paperclip-adapter-openrouter", "version": "latest" }
   ```

#### Option B — local path (no publishing)

```bash
git clone https://github.com/xaedian/paperclip-adapter-openrouter
cd paperclip-adapter-openrouter
npm install && npm run build
```

Then in Paperclip: **Settings → Instance → Adapters → Install Adapter → Local path**
and select the repo folder. Or:

```http
POST /api/adapters/install
Content-Type: application/json

{ "packageName": "/absolute/path/to/paperclip-adapter-openrouter", "isLocalPath": true }
```

After install the adapter appears under External Adapters as type `openrouter`.

### 3. Hire an agent

Org Chart → Hire Agent → Adapter Type **OpenRouter** → pick any model id
(`openai/gpt-4o-mini` for best tool-calling reliability, `openai/gpt-oss-120b:free`
for free tier) → **Test Environment** validates your key and lists models.

## Agent JWT / tool-call auth

The adapter declares `supportsLocalAgentJwt: true`, so the host mints a scoped
agent JWT per run (`PAPERCLIP_AGENT_JWT_SECRET` must be set on the server for
this to work). The adapter uses that JWT **only** to call Paperclip's REST API
as the agent. Your OpenRouter key never touches Paperclip and the JWT is never
sent to OpenRouter.

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | `openrouter/auto` | Any OpenRouter model id. `:free` suffix = free tier. |
| `apiKey` | string | env var | `sk-or-v1-...`. Supports `{{SECRET_REF}}`. |
| `systemPrompt` | string | sensible default | Base system message. |
| `instructionsFilePath` | string | — | Markdown file used as system prompt (overrides `systemPrompt`). |
| `temperature` | number | `0.7` | Sampling temperature. |
| `maxTokens` | number | `4096` | Max completion tokens per turn. |
| `topP` | number | `1` | Nucleus sampling. |
| `maxTurns` | number | `25` | Max tool-loop round-trips per run. |
| `requestTimeoutSec` | number | `300` | Per-request timeout. |
| `reasoning` | boolean | `false` | Extended thinking (reasoning-capable models). |
| `transforms` | string[] | — | e.g. `["middle-out"]`. |
| `route` | string | `fallback` | `"fallback"` or `"no-fallback"`. |
| `autoApprove` | boolean | `false` | Skip approval gate on `hire_agent`. Keep off in production. |
| `skillsDir` | string | `~/.openrouter-adapter/skills` | Skills root scanned for SKILL.md folders. |

## Known limitations

- **No token streaming inside the loop** — non-streaming is more reliable for
  tool calls across heterogeneous models.
- **Some free models fake tool calls** (emit `<tool_call>` as plain text).
  Use `openai/gpt-oss-120b:free` or `openai/gpt-4o-mini` if tool calling misbehaves.
- **Free-tier rate limits** are enforced by OpenRouter (429s are retried once,
  then surface as `provider_quota` errors).
- **No async approval resume** — a run that requests an approval completes;
  the outcome applies on the next wake.
- **No vision/multimodal attachments.**

## Development

```bash
npm install
npm run typecheck
npm run build
node smoke.mjs   # optional manual check
```

The package depends only on the public `@paperclipai/adapter-utils` (the same
dependency first-party external adapters use), so it tracks Paperclip releases
without patching. Contract types (`AdapterExecutionContext`,
`AdapterExecutionResult`, `ServerAdapterModule`, ...) come from that package.

## Credits

Forked from [talhamahmood666/paperclip-adapter-openrouter](https://github.com/talhamahmood666/paperclip-adapter-openrouter)
(v2 tool-loop implementation), modernized for Paperclip's external adapter
plugin system.

## License

MIT
