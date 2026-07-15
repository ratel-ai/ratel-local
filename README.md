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
    <a href="https://www.npmjs.com/package/@ratel-ai/mcp-server"><img src="https://img.shields.io/npm/v/@ratel-ai/mcp-server?label=npm&color=cb3837" alt="npm" /></a>
    <a href="https://github.com/ratel-ai/ratel-local"><img src="https://img.shields.io/github/stars/ratel-ai/ratel-local?style=social" alt="GitHub stars" /></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
    <a href="https://discord.gg/75vAPdjYqT"><img src="https://img.shields.io/discord/1478702964003705015?logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord" /></a>
  </p>
</div>

Ratel Local gives coding agents one searchable catalog instead of every tool schema from every upstream MCP server. Tools and skill instructions enter context only when the agent needs them, with no agent-code changes.

It ships as the npm package `@ratel-ai/mcp-server` and the `ratel-mcp` CLI. The package also exposes library APIs for serving a Ratel `ToolCatalog` over MCP.

## Why Ratel Local

- **Smaller context:** upstream tool schemas and skill bodies stay out of the prompt until they are relevant.
- **Better tool selection:** capability search gives the model a focused set of choices. See the [benchmarks](https://benchmark.ratel.sh).
- **Fits existing setups:** bring the MCP servers you already use in Claude Code, Codex, Cursor, and other MCP clients.
- **Runs locally:** Ratel Local runs on your machine; configuration and upstream credentials are stored locally.

## Quickstart

Choose the setup that matches where you are starting:

- **Migrate existing MCP servers:** install the CLI and import the servers already configured in Claude Code or Codex.
- **Start fresh with the plugin:** let the plugin start Ratel Local, then add upstreams directly to Ratel Local configuration.

Use one path per agent. Installing the plugin and then accepting the import rewrite registers Ratel Local twice.

### Migrate an existing MCP setup

#### 1. Install the CLI

Node.js 20 or newer is required.

```bash
npm install --global @ratel-ai/mcp-server
ratel-mcp --version
```

#### 2. Import the agent's MCP servers

Run the command for your agent from the project where you use those servers:

```bash
# Claude Code
ratel-mcp import --agent claude-code

# Codex
ratel-mcp import --agent codex
```

The CLI and UI use the same import sequence. If the source agent is not linked, the first step offers to link and continue, continue without linking, or cancel. The confirmed import writes selected entries to Ratel, removes those MCP entries from the source agent, and marks selected native skills invoke-only. Skipping the link is useful when importing for another linked agent, but the imported MCPs and skills are no longer directly usable from the unlinked source agent. The wizard preserves MCP scopes and backs up every changed MCP or agent config file. Skill management is reversible: use **Stop managing** in the UI or `ratel-mcp skill deactivate` to remove Ratel's link and restore its metadata changes.

Claude Code then offers a separate, skippable Ratel statusline step. Linking itself only installs the Ratel gateway entry; install or reinstall the statusline manually with `ratel-mcp statusline install`.

If your upstreams are already in Ratel Local configuration, `link` adds Ratel Local to the agent without importing or removing native entries:

```bash
ratel-mcp link --agent claude-code
ratel-mcp link --agent codex
```

Native entries remain directly exposed, so their schemas still enter the agent's context without capability search.

#### 3. Confirm Ratel Local and restart

```bash
# Claude Code
claude mcp get ratel-mcp

# Codex
codex mcp get ratel-mcp --json
```

Confirm that `ratel-mcp` is connected or enabled, then restart Claude Code or start a new Codex session.

### Start fresh with the plugin

#### 1. Install Ratel Local

```bash
# Claude Code
claude plugin marketplace add ratel-ai/ratel-local
claude plugin install ratel-mcp@ratel

# Codex
codex plugin marketplace add ratel-ai/ratel-local
codex plugin add ratel-mcp@ratel
```

Reload or restart Claude Code, then start a new Codex session.

#### 2. Add an upstream

The plugin does not install the global CLI, so use `npx`:

```bash
npx -y @ratel-ai/mcp-server@latest mcp add \
  --scope user context7 -- npx -y @upstash/context7-mcp

npx -y @ratel-ai/mcp-server@latest mcp list
```

Restart the agent after changing the configuration.

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
