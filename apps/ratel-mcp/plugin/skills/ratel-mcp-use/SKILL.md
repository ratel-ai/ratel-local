---
name: ratel-mcp-use
description: Use Ratel MCP's search_tools and invoke_tool gateway to find and call specialized upstream tools.
---

# Ratel MCP Use

Use this skill when the user asks for a task that may need a specialized MCP tool exposed through Ratel.

## Tool Selection

Before falling back to generic shell, web, browser, or built-in tools, search the Ratel catalog:

1. Call `search_tools` with a focused query for the capability needed.
2. Inspect the returned tool IDs, upstream names, descriptions, and input schemas.
3. Call `invoke_tool` with the chosen `toolId` and arguments.
4. If `invoke_tool` returns `{ "error": "needs_auth", "upstream": "<name>" }`, run or ask the user to run the Ratel auth flow for that upstream.

Hosts may display these tools as plain `search_tools` / `invoke_tool` or as MCP-qualified names such as `mcp__ratel-mcp__search_tools` and `mcp__ratel-mcp__invoke_tool`.

## Constraints

- Do not call upstream tools directly when the same tool is available through Ratel.
- Treat Ratel search results as capability candidates, not proof that a tool is safe for destructive actions.
- Ask for user confirmation before using tools that delete, overwrite, publish, spend money, or send messages.
- Prefer narrow search queries and minimal tool arguments.
