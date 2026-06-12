---
name: ratel-mcp-setup
description: Configure Ratel MCP, import existing MCP servers, link agents to the Ratel gateway, or prepare upstream tools for use through Ratel.
---

# Ratel MCP Setup

Use this skill when the user wants to configure Ratel MCP, import MCP servers from an agent, link an agent to Ratel, add upstream MCP servers, or prepare the gateway for first use.

## Workflow

1. Inspect the current Ratel configuration before making changes.
   - Use `ratel-mcp mcp list` for a quick view.
   - Ratel scopes are user, project, and local.
2. Add upstream MCP servers with `ratel-mcp mcp add`.
   - For stdio upstreams, use `ratel-mcp mcp add --scope <scope> <name> -- <command> [args...]`.
   - For HTTP upstreams, use `ratel-mcp mcp add --scope <scope> <name> <url> --transport http`.
3. Import existing agent MCP entries when the user is migrating.
   - Use `ratel-mcp mcp import --agent codex` for Codex.
   - Use `ratel-mcp mcp import --agent claude-code` for Claude Code.
4. Link an agent only when the user wants that agent's native config rewritten to point at Ratel.
   - Use `ratel-mcp mcp link --agent codex`.
   - Use `ratel-mcp mcp link --agent claude-code`.
5. For HTTP/SSE upstreams, run `ratel-mcp mcp auth` when auth is needed.

## Plugin Behavior

When installed as a plugin, the bundled MCP server starts with `ratel-mcp serve --auto-config`. It loads the user Ratel config and, when a project root is discoverable, the project and local Ratel configs too.

Do not duplicate upstream MCP definitions into the plugin `.mcp.json`. The plugin `.mcp.json` should only start the Ratel gateway; upstream tools belong in Ratel config files.
