<div align="center">
  <img src="https://raw.githubusercontent.com/siteboon/claudecodeui/main/public/logo.svg" alt="CloudCLI" width="64" height="64">
  <h1>Analytics — CloudCLI Plugin</h1>
  <p>Cost, cache, token and latency analytics for Claude Code and OpenCode, Claude plan limits and session health in <a href="https://github.com/siteboon/claudecodeui">CloudCLI UI</a></p>
</div>

<p align="center">
  <a href="https://cloudcli.ai/docs/plugin-overview">Plugin Docs</a> · Based on <a href="https://github.com/cloudcli-ai/cloudcli-plugin-starter">cloudcli-plugin-starter</a>
</p>

---

One tab instead of three: a real-time usage monitor for Claude Code and
OpenCode (including GitHub Copilot models), your Claude plan limits, and PRISM
session health.

**Usage**

- **Cost:** $ for the selected range and the last hour, per tool, model,
  project and session. The session table also shows each tool's own session
  cost counter.
- **Cache hit rate:** `cache_read / (input + cache writes + cache reads)`,
  overall, per bucket, per tool, per model and per session, color-coded.
- **Tokens:** input, output (incl. reasoning), cache writes and cache reads.
- **Latency:** p50, p95 and average from the time a request is sent until the
  first response block is written, plus average turn duration.
- **Live sessions:** sessions written to in the last 2 minutes get a green
  dot. Subagent requests are counted with their parent session.
- **Plan limits:** the 5-hour session window and weekly limits of your Claude
  plan, with time to reset (needs Claude Code signed in with a claude.ai
  account).
- **Subscriptions:** what your requests would have cost at API prices against
  the matching share of your Claude (detected from your login) and GitHub
  Copilot fees, per range and for the last 30 days.

Ranges are 1h, 24h, 7d and 30d. Tool filter is all, Claude Code or OpenCode.
Scope is all projects, the selected project or the open session. A session
belongs to the directory it was started in, and the project scope matches that
directory exactly, so nested projects (e.g. `~/app` inside `~`) stay separate.
Auto-refresh is 5s, 15s,
1m or off, and pauses while the tab is hidden.

**Health** (optional, needs [PRISM](https://github.com/jakeefr/prism))

Grades the Claude Code sessions of the selected project, or of every project,
across token efficiency, tool health, context hygiene, CLAUDE.md adherence and
session continuity, and lists the top issues (retry loops, consecutive tool
failures, CLAUDE.md re-reads, truncated sessions). The overview sorts projects
worst first.

## Requirements

- CloudCLI UI. The plugin has no npm runtime dependencies.
- OpenCode tracking reads SQLite with the built-in `node:sqlite` (Node ≥ 22.5)
  or, on older Node versions, with the `better-sqlite3` copy CloudCLI ships.
- Plan limits: Claude Code signed in with a claude.ai account (Pro, Max, Team).
  API-key and cloud-provider setups have no plan limits.
- Health: [PRISM](https://github.com/jakeefr/prism) on PATH or in
  `~/.local/bin` (Python 3.11+): `pipx install prism-cc`. Without it the
  health page shows the install hint; everything else works.

## Prices

Costs are estimates from [LiteLLM's price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json),
which uses the same model ids as Claude Code and includes cache-write and
long-prompt rates. The plugin downloads it in the background at start and then
daily, and keeps a copy in `~/.cache/cloudcli-analytics/litellm-prices.json`.
Offline, it uses that copy or a built-in table. The footer says which source
is in use; "update prices" fetches the list now.

Models without an exact price are priced like their model family and shown
with "≈"; models without any price show "—". Both are listed in a **prices**
card. Add or correct prices in `~/.config/cloudcli-analytics/prices.json`, in
$ per million tokens. Keys match any model name that contains them
(case-insensitive) and win over every other source:

```json
{
  "claude-opus-6": { "input": 5, "output": 25, "cacheRead": 0.5 },
  "my-gateway-model": { "input": 1, "output": 4 }
}
```

Cache writes are derived from `input` (1.25× for 5m, 2× for 1h);
`cacheRead` defaults to 0.1× `input`. The file is re-read when it changes, and
past requests are re-priced.

## Subscriptions

The Claude plan comes from your Claude Code login (Pro $20, Max 5x $100,
Max 20x $200 list prices per month). **edit** in the subscriptions card sets
your own price (for example in EUR or an annual plan), turns the Claude
comparison off, or adds GitHub Copilot, which can't be detected. EUR prices are
converted with a rate you set. Settings live in
`~/.config/cloudcli-analytics/settings.json`.

"value" is the API-equivalent cost of the requests in the range divided by the
fee's share for that range (fee × range ÷ 30 days); above 1× the subscription
pays off. Claude compares against Claude Code's costs, Copilot against
OpenCode's `github-copilot/*` models. Subscriptions cover every project, so
the comparison ignores the project and session filter.

## Installation

**From git** (recommended): Open **Settings > Plugins** in CloudCLI UI, paste
`https://github.com/PepperPhil/cloudcli-plugin-analytics`, and click
**Install**. The host clones the repo, runs `npm install --ignore-scripts` and
`npm run build`, and the plugin is ready to enable.

**Manual:**

```bash
git clone https://github.com/PepperPhil/cloudcli-plugin-analytics.git ~/.claude-code-ui/plugins/cloudcli-plugin-analytics
cd ~/.claude-code-ui/plugins/cloudcli-plugin-analytics
npm install
npm run build
```

Then open **Settings > Plugins**. "Analytics" should appear. Enable it to add
the tab.

**Upgrading from 1.1.x:** the plugin id changed from `analytics` to
`usage-analytics`, so CloudCLI treats it as a new plugin. Enable it again in
**Settings > Plugins**; the old `analytics` entry in
`~/.claude-code-ui/plugins.json` can be removed.

## Plugin structure

```
cloudcli-plugin-analytics/
  manifest.json         # Plugin metadata
  package.json          # Build and test scripts (no runtime dependencies)
  tsconfig.json         # TypeScript configuration (unchanged from the starter)
  src/
    types.ts            # Plugin API type definitions
    index.ts            # Frontend entry point: mount/unmount, rendering, polling
    server.ts           # Backend entry point: HTTP server, /stats and /health
    collector.ts        # Claude Code transcript parser and the shared aggregator
    opencode.ts         # OpenCode SQLite reader
    pricing.ts          # Price lookup (own, LiteLLM, built-in) and token helpers
    remote-prices.ts    # LiteLLM price list download and cache
    subscriptions.ts    # Plan detection and fee comparison
    limits.ts           # Claude plan limits
    prism.ts            # PRISM runner
    cloudcli.ts         # CloudCLI app session id → tool session ids
    sqlite.ts           # Read-only SQLite (node:sqlite or CloudCLI's better-sqlite3)
    *.test.ts           # Unit tests (npm test)
  dist/                 # Compiled output (auto-generated, not committed)
  icon.svg              # Tab icon
```

## Backend — server subprocess

`dist/server.js` follows the starter contract. It listens on a random port on
`127.0.0.1` and prints `{"ready": true, "port": N}` to stdout. The host
proxies `api.rpc()` calls to it. It uses no secrets. Because the host passes
only `PATH`, `HOME`, `NODE_ENV` and `PLUGIN_NAME`, all data paths are derived
from `HOME`.

- `GET /stats?range=1h|24h|7d|30d[&tool=all|claude|opencode][&project=/abs/path][&session=id][&current=id]`
- `GET /limits`: plan limits, cached for a minute
- `GET /prism[?project=/abs/path][&refresh=1]`: PRISM report, cached for 5 minutes
- `POST /prices/refresh`: download the price list now
- `GET /settings`, `PUT /settings`: subscription settings
- `GET /health`

### Claude Code

Reads `~/.claude/projects/**/*.jsonl` incrementally. It re-reads only the
bytes appended since the last poll, and only files modified inside the
selected range.

| Metric | Source |
|---|---|
| tokens / cost | `assistant.message.usage` (deduped by `message.id`) |
| latency | `assistant` timestamp − matching `api-request` (`requestRef`), else − parent entry timestamp |
| turn duration | `system` / `turn_duration` (written by the interactive CLI only) |
| prompts | `user` entries with text or image content (not tool results, meta or subagent entries) |
| project | first `cwd` in the transcript |
| reported cost | latest `cost-state.totalCostUSD` (resets when a session is resumed) |
| session title | `ai-title`, else `last-prompt` |

Prices live in `src/pricing.ts` (Anthropic first-party rates, 2026-10). Cache
writes are 1.25× input for the 5m TTL and 2× for the 1h TTL. Fast mode is
priced at 2×. Models that aren't in the price table show "—".

### OpenCode

Opens `~/.local/share/opencode/opencode.db` read-only. Only rows updated since
the last poll are read. The last 30 days are kept in memory.

| Metric | Source |
|---|---|
| tokens / cost | assistant `message.data.tokens` / `.cost` (OpenCode's own estimate) |
| model | `providerID/modelID`, e.g. `github-copilot/gpt-5.6-terra` (shown as `copilot/…`) |
| latency | first non-`step-start` `part` − message creation |
| turn duration | user message → last completed assistant reply to it |
| prompts | user messages in root sessions |
| project | `session.directory` |
| reported cost | `session.cost` |
| subagents | sessions with `parent_id` roll up into the root session |

GitHub Copilot bills by subscription and premium requests, so OpenCode's $
figures for Copilot models are API-equivalent, not what you pay. "prompts"
in the by-tool table counts user prompts, which is what premium requests are
based on (before the model multiplier).

Node prints an `ExperimentalWarning` for `node:sqlite` to stderr when the
server starts. The host only logs it.

### Plan limits

Reads the OAuth access token from `~/.claude/.credentials.json` and calls
`https://api.anthropic.com/api/oauth/usage`, the endpoint the Claude apps use.
It is unofficial and may change; the card then shows the error and the rest of
the tab is unaffected. The plugin never writes the credentials file and never
uses the refresh token: when the token has expired, running any `claude`
command refreshes it.

### Health

Runs `prism analyze --json [--project <path>]` with the path as an argument,
never through a shell, and caches the report per project for 5 minutes.

## Development

```bash
npm run dev    # recompile on change
npm test       # build and run the unit tests
```

## Security

The plugin reads local files: `~/.claude/projects`, the OpenCode database,
the `sessions` table of CloudCLI's database (`~/.cloudcli/auth.db`, to map
CloudCLI's session ids to the tools' own) and your price file. Databases are
opened read-only.

It makes two kinds of network request: the plan-limits call sends your Claude
OAuth access token from `~/.claude/.credentials.json` to `api.anthropic.com`,
the same thing Claude Code does, and the price list is downloaded from
`raw.githubusercontent.com` without any data of yours. Usage data never leaves
the machine. Health runs
the locally installed `prism` CLI, which reads `~/.claude/projects` and makes
no network calls. As with every CloudCLI
plugin, the frontend runs in the host's JS context with no sandbox. Review the
source before installing.

## Credits

- Plan limits adapted from [cloudcli-plugin-claude-usage](https://github.com/HandyS11/cloudcli-plugin-claude-usage) by HandyS11 (MIT).
- Health is powered by [PRISM](https://github.com/jakeefr/prism); the runner is adapted from [cloudcli-plugin-prism](https://github.com/jakeefr/cloudcli-plugin-prism) by jakeefr (MIT).
- Started from [cloudcli-plugin-starter](https://github.com/cloudcli-ai/cloudcli-plugin-starter).

## License

MIT. See [LICENSE](LICENSE).
