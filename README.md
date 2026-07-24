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

This README tracks the `0.6.0-rc.0` release candidate, matching the package
version pinned by the bundled plugin. Use that exact version while validating
this release; stable releases use the `latest` npm tag.

The CLI and UI prefer the `ratel-local` plugin when linking because it bundles the gateway and agent skills. If plugin installation fails, Ratel Local reports the failure and applies the reviewed explicit MCP gateway fallback instead. An enabled plugin is recognized as an existing Ratel connection, so importing does not add a second gateway and `link` becomes a no-op. If the Codex plugin is enabled but its bundled Ratel MCP server is disabled, `link` re-enables that server. Agent Setup offers **Fix duplicate installation** when both the plugin and an explicit Ratel MCP entry are present, and **Switch to plugin** for MCP-only installations. Both actions preserve the existing MCP connection unless plugin installation succeeds, and only recognized Ratel entries are removed.

### Complete interactive onboarding

#### 1. Install the CLI

Node.js 20 or newer is required.

```bash
npm install --global @ratel-ai/ratel-local@0.6.0-rc.0
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

Re-running setup is safe. A matching daemon and existing agent links are
reported as no-ops.

If you do not have a global installation, run the release-pinned package:

```bash
npx -y @ratel-ai/ratel-local@0.6.0-rc.0 setup
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

Add new upstreams directly after onboarding:

```bash
ratel-local mcp add --scope user context7 -- npx -y @upstash/context7-mcp
ratel-local mcp list
```

### Verify capability search

Ask the agent to call Ratel Local explicitly:

```text
Call Ratel's search_capabilities tool with:
{"query":"look up current React framework documentation","topKTools":3,"topKSkills":1}
Return the raw result.
```

The result should contain a `tools` bucket with matching upstream tools and a `skills` bucket. You are now using Ratel Local's on-demand capability search.

For troubleshooting and the complete setup guide, see the [Ratel Local quickstart](https://docs.ratel.sh/docs/local/quickstart).

For configuration scopes, OAuth, skills, the local UI, telemetry, and library usage, see the [Ratel Local Docs](https://docs.ratel.sh/docs/local).

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
