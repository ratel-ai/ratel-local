<div align="center">
  <h1>Ratel Local</h1>
  <p>MCP Gateway that fronts Claude Code / Codex / Cursor with capability search.</p>

  <p>
    <a href="https://docs.ratel.sh/docs/local">Ratel Local Docs</a> •
    <a href="https://github.com/ratel-ai/ratel">Ratel</a> •
    <a href="https://benchmark.ratel.sh">Benchmarks</a> •
    <a href="https://discord.gg/75vAPdjYqT">Discord</a>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@ratel-ai/ratel-local"><img src="https://img.shields.io/npm/v/@ratel-ai/ratel-local?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel-local"><img src="https://img.shields.io/github/stars/ratel-ai/ratel-local?style=social" alt="GitHub stars" /></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
    <a href="https://discord.gg/75vAPdjYqT"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord" /></a>
  </p>
</div>

Ratel Local gives coding agents one searchable catalog instead of every tool schema from every upstream MCP server. Tools and skill instructions enter context only when the agent needs them, with no agent-code changes.

It ships as the npm package `@ratel-ai/ratel-local` and the `ratel-local` CLI. The package also exposes library APIs for serving a Ratel `ToolCatalog` over MCP.

## Why Ratel Local

- **Smaller context:** upstream tool schemas and skill bodies stay out of the prompt until they are relevant.
- **Better tool selection:** capability search gives the model a focused set of choices. See the [benchmarks](https://benchmark.ratel.sh).
- **Fits existing setups:** bring the MCP servers you already use in Claude Code, Codex, Cursor, and other MCP clients.
- **Runs locally:** Ratel Local runs on your machine; configuration and upstream credentials are stored locally.

## Quickstart

The recommended entrypoint is the complete `setup` wizard. It prepares the
persistent daemon, detects Claude Code and Codex, connects the agents you
select, and offers existing MCP servers and skills as a separate reviewed
import.

This README tracks the `0.8.2` stable release, matching the package version
pinned by the bundled plugin. Unqualified npm installs resolve the `latest`
dist-tag; the examples below remain exact-versioned for reproducibility.

The CLI and UI prefer the `ratel-local` plugin when linking because it bundles
the gateway and agent skills. Stable builds use the **Ratel** marketplace from
the repository's default `main` branch. Prerelease builds alone pin the same
marketplace identity to their immutable matching release tag: Codex uses
`--ref`, while Claude Code uses the equivalent `owner/repo@ref` source. Stable
`0.8.2` therefore carries no RC branch or tag override.

If an agent already has the plugin, `link` reconciles that marketplace channel and reinstalls the plugin. It verifies that an RC tag exists before changing a working installation and attempts to restore the stable plugin if an RC switch fails after removal. When stable is restored, the command preserves that connection but reports the RC setup as failed rather than claiming the requested channel is active. If no usable plugin remains, a new link uses the reviewed explicit MCP gateway fallback; a failed existing-plugin reconciliation stops with an error. Importing still recognizes an enabled plugin as an existing Ratel connection and does not add a second gateway. If the Codex plugin is enabled but its bundled Ratel MCP server is disabled, `link` re-enables that server. Agent Setup offers **Fix duplicate installation** when both the plugin and an explicit Ratel MCP entry are present, and **Switch to plugin** for MCP-only installations. Both actions preserve the existing MCP connection unless plugin installation succeeds, and only recognized Ratel entries are removed.

### Complete interactive onboarding

#### 1. Install the CLI

Node.js 20.6 or newer is required.

```bash
npm install --global @ratel-ai/ratel-local@0.8.2
ratel-local --version
```

#### 2. Run setup

```bash
ratel-local setup
```

The wizard:

- installs, upgrades, or starts the per-user daemon;
- detects Claude Code and Codex and asks which agents to connect;
- installs the Ratel Local plugin for each selected agent, using the reviewed
  explicit MCP connector only if plugin installation fails;
- separately offers to preview MCP servers and skills from selected agents;
- asks for confirmation before committing an import and backs up changed
  configuration.

Re-running setup is safe. A matching daemon is reported as a no-op, while
existing plugin links are checked against the package's stable or prerelease
marketplace channel.

If you do not have a global installation, run the release-pinned package:

```bash
npx -y @ratel-ai/ratel-local@0.8.2 setup
```

#### 3. Confirm Ratel Local and restart

```bash
# Claude Code
claude mcp get ratel-local

# Codex
codex mcp get ratel-local --json
```

Confirm that `ratel-local` is connected or enabled, then restart Claude Code or start a new Codex session.

### Safe automation

Plain `--yes` retains the old safe behavior and changes only the daemon:

```bash
ratel-local setup --yes
ratel-local setup --daemon-only --yes
```

Agent changes require explicit selection. Repeat `--agent`, or use `auto` to
connect every detected supported agent:

```bash
ratel-local setup --yes --agent claude-code --agent codex
ratel-local setup --yes --agent auto
```

Automated setup never imports native MCP servers or skills. Use the explicit
expert command when migration is intended:

```bash
ratel-local import --yes --agent claude-code
ratel-local import --yes --agent codex
```

`--port N` selects the first-install daemon port. `--daemon-only` cannot be
combined with `--agent`.

### Expert commands

The lower-level workflows remain available for targeted repair, scripting, and
debugging:

```bash
# Daemon lifecycle
ratel-local daemon install
ratel-local daemon start
ratel-local daemon status

# Connect without importing native entries
ratel-local link --agent claude-code
ratel-local link --agent codex

# Preview and confirm one agent migration
ratel-local import --agent claude-code
ratel-local import --agent codex
```

`daemon start` is idempotent: when the service is already healthy it leaves the
daemon and active MCP sessions running. During a slow cold start, the connector
waits for the daemon handshake and then exposes the complete catalog. Bootstrap
tools appear only after attachment actually fails or a live connection is later
lost; they check status before recovery and can safely attach to the running
service. Set `RATEL_FEATURE_CONNECTOR_RECOVERY=1` on connector processes to opt
into bounded automatic reattachment after later daemon interruptions; this
rollout flag is off by default.

Add new upstreams directly after onboarding:

```bash
ratel-local mcp add --scope user context7 -- npx -y @upstash/context7-mcp
ratel-local mcp list
```

### Opt-in semantic and hybrid retrieval

BM25 remains the model-free default. The `0.7.0` feature line adds scoped
semantic and hybrid retrieval with explicit model preflight:

```bash
ratel-local retrieval status
ratel-local retrieval configure --scope project --method hybrid --source built-in
ratel-local retrieval prepare --scope project
```

Reconnect the affected agent after changing retrieval so it acquires the new
immutable gateway generation. See the [retrieval configuration and preflight
guide](docs/retrieval.md) for local, Hugging Face, Ollama, and
OpenAI-compatible embedding sources plus privacy and memory guidance.

### Experimental Cloud telemetry

Native Claude Code and Codex telemetry relay plus Ratel runtime trace export
ship dark. Enable the daemon-wide feature explicitly before configuring an API
key or native exporter:

```bash
# New installation or interactive foreground setup
RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local setup

# Existing background service
ratel-local daemon uninstall
RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local daemon install

ratel-local traces status
```

Only the exact value `1` enables the feature. Setup persists the enabled flag in
new macOS launchd and Linux systemd service definitions. See the [Cloud OTLP
relay and native exporter setup contract](docs/cloud-otlp-relay.md) for privacy
levels, precedence, failure behavior, and rollback instructions.

### Verify capability search

Ask the agent to call Ratel Local explicitly:

```text
Call Ratel's search_capabilities tool with:
{"query":"look up current React framework documentation","topKTools":3,"topKSkills":1}
Return the raw result.
```

The result should contain a `tools` bucket with matching upstream tools and a `skills` bucket. You are now using Ratel Local's on-demand capability search.

For troubleshooting and the complete setup guide, see the [Ratel Local quickstart](https://docs.ratel.sh/docs/local/quickstart).

For configuration scopes, OAuth, skills, the local UI, telemetry, and library usage, see the [Ratel Local Docs](https://docs.ratel.sh/docs/local). Repository contributors can also read the [retrieval configuration and preflight guide](docs/retrieval.md) and the [Cloud OTLP relay and native exporter setup contract](docs/cloud-otlp-relay.md).

## How it works

Ratel Local reads your layered `mcpServers` configuration, connects to each upstream, and registers its tools in one Ratel catalog.

Your MCP client sees capability tools instead of the full upstream catalog. `search_capabilities` finds relevant tools and skills, and `invoke_tool` runs a selected tool.

When skills are configured, `get_skill_content` loads their instructions.

The CLI manages upstreams, agent imports and links, OAuth, skills, backups, the browser UI, and the Claude Code statusline. The docs are the source of truth for commands and configuration.

## Development

Development requires Node.js 24+ and pnpm 10+.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

See [CONTRIBUTING.md](https://github.com/ratel-ai/ratel-local/blob/main/CONTRIBUTING.md) for the development workflow.

## License

MIT. See [LICENSE.md](LICENSE.md).
