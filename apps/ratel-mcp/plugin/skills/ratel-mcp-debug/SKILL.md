---
name: ratel-mcp-debug
description: Diagnose Ratel MCP plugin startup, missing tools, auth failures, empty catalogs, or broken upstream MCP servers.
---

# Ratel MCP Debug

Use this skill when Ratel MCP is installed but tools are missing, the gateway fails to start, auth fails, or an upstream behaves unexpectedly.

## Checks

1. Confirm Node and npx are available.
   - The plugin starts `npx -y @ratel-ai/mcp-server@0.3.0-rc.0 serve --auto-config`.
   - Node 20 or newer is required.
2. Confirm Ratel config exists.
   - User: `~/.ratel/config.json`
   - Project: `<project>/.ratel/config.json`
   - Local: `<project>/.ratel/config.local.json`
3. Run `ratel-mcp mcp list` to verify configured upstreams.
4. Run `ratel-mcp serve --auto-config` from the relevant project to reproduce startup outside the host.
5. For HTTP/SSE upstreams, run `ratel-mcp mcp auth --check` or `ratel-mcp mcp auth <name>`.
6. In Claude Code, run `/mcp` and `/reload-plugins` after plugin changes.
7. In Codex, restart the thread after plugin install or manifest changes.

## Common Findings

- Empty catalog: no Ratel configs were found or all configs have empty `mcpServers`.
- Missing project tools: the host did not expose a useful project root; set `RATEL_PROJECT_ROOT` or run from the project directory.
- First startup failure: `npx` may need network access to resolve the pinned npm package.
- Auth needed: an upstream returned 401 or 403; complete the Ratel auth flow and retry.
