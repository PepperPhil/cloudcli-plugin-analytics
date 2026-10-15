<div align="center">
  <img src="https://raw.githubusercontent.com/siteboon/claudecodeui/main/public/logo.svg" alt="CloudCLI" width="64" height="64">
  <h1>Analytics — CloudCLI Plugin</h1>
  <p>Cost, cache, token and latency analytics for Claude Code and OpenCode in <a href="https://github.com/siteboon/claudecodeui">CloudCLI UI</a></p>
</div>

<p align="center">
  <a href="https://cloudcli.ai/docs/plugin-overview">Plugin Docs</a> · Forked from <a href="https://github.com/cloudcli-ai/cloudcli-plugin-starter">cloudcli-plugin-starter</a>
</p>

---

A real-time monitor for Claude Code and OpenCode, including GitHub Copilot
models, in a CloudCLI tab:

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

Ranges are 1h, 24h, 7d and 30d. Tool filter is all, Claude Code or OpenCode.
Scope is either all projects or the selected project. Auto-refresh is 5s, 15s,
1m or off, and pauses while the tab is hidden. Everything is read locally;
nothing leaves the machine.

## Requirements

- Node.js ≥ 22.5 for OpenCode tracking. It uses the built-in `node:sqlite`
  module, so there are no npm runtime dependencies. On older Node versions the
  Claude Code data still works and the tab shows a warning for OpenCode.

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

## Plugin structure

```
cloudcli-plugin-analytics/
  manifest.json         # Plugin metadata
  package.json          # Build and test scripts (no runtime dependencies)
  tsconfig.json         # TypeScript configuration (unchanged from the starter)
  src/
    types.ts            # Plugin API type definitions (unchanged from the starter)
    index.ts            # Frontend entry point: mount/unmount, rendering, polling
    server.ts           # Backend entry point: HTTP server, /stats and /health
    collector.ts        # Claude Code transcript parser and the shared aggregator
    opencode.ts         # OpenCode SQLite reader
    pricing.ts          # Anthropic price table and token helpers
    collector.test.ts   # Unit tests (npm test)
  dist/                 # Compiled output (auto-generated, not committed)
  icon.svg              # Tab icon
```

## Backend — server subprocess

`dist/server.js` follows the starter contract. It listens on a random port on
`127.0.0.1` and prints `{"ready": true, "port": N}` to stdout. The host
proxies `api.rpc()` calls to it. It uses no secrets. Because the host passes
only `PATH`, `HOME`, `NODE_ENV` and `PLUGIN_NAME`, all data paths are derived
from `HOME`.

- `GET /stats?range=1h|24h|7d|30d[&tool=all|claude|opencode][&project=/abs/path]`
- `GET /health`

### Claude Code

Reads `~/.claude/projects/**/*.jsonl` incrementally. It re-reads only the
bytes appended since the last poll, and only files modified inside the
selected range.

| Metric | Source |
|---|---|
| tokens / cost | `assistant.message.usage` (deduped by `message.id`) |
| latency | `assistant` timestamp − matching `api-request` (`requestRef`), else − parent entry timestamp |
| turn duration | `system` / `turn_duration` |
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
| turn duration / prompts | user message → last completed assistant reply to it |
| reported cost | `session.cost` |
| subagents | sessions with `parent_id` roll up into the root session |

GitHub Copilot bills by subscription and premium requests, so OpenCode's $
figures for Copilot models are API-equivalent, not what you pay. "prompts"
in the by-tool table counts user prompts, which is what premium requests are
based on (before the model multiplier).

Node prints an `ExperimentalWarning` for `node:sqlite` to stderr when the
server starts. The host only logs it.

## Development

```bash
npm run dev    # recompile on change
npm test       # build and run the unit tests
```

## Security

The plugin reads local files only (`~/.claude/projects` and the OpenCode
database, read-only) and makes no network requests. As with every CloudCLI
plugin, the frontend runs in the host's JS context with no sandbox. Review the
source before installing.

## License

MIT. See [LICENSE](LICENSE).
