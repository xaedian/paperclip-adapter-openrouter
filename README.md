# Paperclip OpenRouter External Adapter

**OpenRouter adapter for Paperclip** - gives every agent access to 300+ models
(50+ free) through a single OpenRouter API key, with token streaming, a full
multi-turn tool-calling loop against Paperclip's REST API, and guarded
workspace-local execution (shell, git, file tools, project tooling).

> Self-contained external adapter plugin: installs through Paperclip's Adapter
> Manager (npm or local path). No Paperclip source patches required.
> Tested against Paperclip `2026.818`+. Other versions are untested.

---

## Features

| | |
|---|---|
| **Token streaming** | Live SSE deltas into the run transcript (`stream` toggle, non-stream fallback) |
| **Local execution** | Workspace-confined `run_command` / `read_file` / `write_file` / `list_dir` with output caps and kill-on-timeout |
| **Paperclip tools** | get_issue, update_issue_status, add_comment, list_comments, create_sub_issue, list_issues, list_agents, hire_agent (approval-gated), request_approval |
| **Issue lifecycle** | Run-lock checkout, in_progress/done/blocked transitions, final output posted as a comment |
| **Secrets-native** | API key resolves from the Paperclip Secrets Manager at runtime - no files, no machine env vars |
| **Cost tracking** | Real USD cost per run via OpenRouter `/generation`, fed into budgets |
| **Model discovery** | Full live catalog (~400 models, no key needed) with static fallback |
| **Declarative config UI** | Native agent-form rendering without custom React |

## Requirements

- Paperclip `2026.818`+ (tested version)
- An OpenRouter API key - <https://openrouter.ai/keys>
- Node 20+ on the Paperclip host (for local-path installs)

## Install

### Option A - from npm

In Paperclip: **Settings → Instance → Adapters → Install Adapter → npm package**
and enter `@xaedian/paperclip-adapter-openrouter`.

Or via API:

```http
POST /api/adapters/install
Content-Type: application/json

{ "packageName": "@xaedian/paperclip-adapter-openrouter" }
```

### Option B - local path

```bash
git clone https://github.com/xaedian/paperclip-adapter-openrouter
cd paperclip-adapter-openrouter
npm install && npm run build
```

Then **Install Adapter → Local path**, or:

```http
POST /api/adapters/install
{ "packageName": "/absolute/path/to/paperclip-adapter-openrouter", "isLocalPath": true }
```

## Setup

### 1. Store the API key as a Paperclip secret (once per company)

Company → Secrets → create:

- **Name**: `OPENROUTER_API_KEY`
- **Value**: your `sk-or-v1-...` key
- **Provider**: local_encrypted

The adapter resolves this at runtime through the agent's own governed
secrets surface (`POST /api/agents/me/secrets/:key/value`). Nothing is stored
in plaintext files, machine environment variables, or agent configs.

### 2. Bind the secret to each agent

Agents reference the secret through a Paperclip **environment binding** in
their adapter config - Paperclip resolves it before execution and audits every
access:

```json
{
  "env": {
    "OPENROUTER_API_KEY": {
      "type": "secret_ref",
      "secretId": "<your-secret-uuid>"
    }
  }
}
```

**Include this in the hire payload** and the agent is granted runtime access
automatically at creation - no manual step. For agents already hired, add the
same block via Agent config (or grant access manually under
*Agent → Secrets → API Access*).

Leave the agent's *API key* field blank unless it needs its own billing
identity (a literal key or another `{{SECRET_NAME}}`).

### 3. Verify

Run **Test Environment** on the agent or check the first run log for:

```
[openrouter] using API key from paperclip_secret
```

## Environment variables surfaced to agents

The adapter injects real runtime facts into every prompt automatically:

| Variable | Injected as |
|---|---|
| *(derived)* | Workspace root for the run |
| *(configured)* | Any variable listed in the agent's `environmentVars` config (see below) |

Set these once at the OS level (User environment variables); agents discover
them without any prompt engineering. On Windows the prompt also documents the
two classic gotchas: shells run **cmd.exe** (not git-bash), and PATH
assignments must be quoted (`set "PATH=%PATH%;..."`) because PATH entries can
contain parentheses.

## Configuration reference

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | `openrouter/auto` | Any OpenRouter model id. `:free` suffix = free tier. |
| `apiKey` | string | - | **Per-agent override only.** Literal key or ``{{SECRET_NAME}}``. Leave blank to use the fleet secret (requires the env binding + grant from Setup). |
| `stream` | boolean | `true` | SSE token streaming into the transcript. |
| `enableLocalExec` | boolean | `true` | Workspace-confined exec tools (see below). |
| `workspaceDir` | string | host-managed per-agent workspace | Absolute root for exec tools. |
| `systemPrompt` | string | sensible default | Base system message. |
| `instructionsFilePath` | string | - | Markdown file used as system prompt (overrides `systemPrompt`). |
| `temperature` | number | `0.7` | Sampling temperature. |
| `maxTokens` | number | `16384` | Auto-clamped to the model's advertised maximum. |
| `topP` | number | `1` | Nucleus sampling. |
| `maxTurns` | number | `30` | Max tool-loop round-trips per run. |
| `requestTimeoutSec` | number | `600` | Per-request timeout. |
| `reasoning` | boolean | `false` | Extended thinking (reasoning-capable models). |
| `transforms` | string[] | - | e.g. `["middle-out"]`. |
| `route` | string | `fallback` | `fallback` / `no-fallback` (legacy value auto-mapped). |
| `autoApprove` | boolean | `false` | Skip approval gate on `hire_agent`. |
| `skillsDir` | string | `~/.openrouter-adapter/skills` | SKILL.md folders injected into prompts. |
| `environmentNotes` | string | - | Extra facts appended to every run's Environment block. Fleet-wide tier lives in `~/.openrouter-adapter/config.json`. |
| `environmentVars` | string[] | `["COMSPEC"]` | OS env vars surfaced into the Environment block when set on the host. Fleet-wide tier lives in `~/.openrouter-adapter/config.json`. |

## Local execution tools

When enabled, four tools operate strictly inside the agent's workspace:

- `run_command` - shell execution (cmd.exe on Windows), output capped at
  200 KB, process-tree kill at timeout (default 120 s, max 900 s)
- `read_file` / `write_file` - UTF-8 text, 1 MB cap, parent dirs auto-created
- `list_dir` - capped at 500 entries

Path traversal outside the workspace root is denied. Point an agent at a real
project with `workspaceDir` (e.g. `C:\projects\my-app`)
and it can build, test, and commit like a CLI-based agent - while staying
pure HTTP.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `API key not found in any tier` | Secret missing, or the agent hasn't been granted access (step 2 above). The run log shows `secret tier:` diagnostics when enabled builds. |
| Writes rejected: `Responsible user is unavailable` | Beta governance quirk affecting bundled-routine wakes; assignment/comment-driven wakes stamp correctly. |
| `spawn npm ENOENT` during install | Upstream Windows bug in the installer route - use local-path install instead. |
| Empty output, `finish_reason=length` | Model exhausted its token budget (often on reasoning). Raise `maxTokens`. |
| Free model "fakes" tool calls as text | Model limitation - use `openai/gpt-oss-120b:free` or `gpt-4o-mini`. |

## Known limitations

- Non-streaming inside tool-result round-trips (deltas stream for assistant/thinking text).
- No async approval resume; no vision/multimodal attachments.
- Repeat-call protection trips after 3 identical consecutive calls.

## Development

```bash
npm install
npm run typecheck
npm run build
```

Depends only on the public `@paperclipai/adapter-utils`.

## Credits

Forked from
[talhamahmood666/paperclip-adapter-openrouter](https://github.com/talhamahmood666/paperclip-adapter-openrouter)
and modernized for Paperclip's external adapter plugin system.

## License

MIT
