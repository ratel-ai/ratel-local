# Claude Code Plugin and Extension Ecosystem Research

Last researched: 2026-06-10.

This document summarizes the current Claude Code extension ecosystem, focused on hooks, skills, MCP, plugins, subagents, slash-command behavior, permissions, and the nearest equivalents to Codex-style apps. It relies primarily on current official Claude Code documentation under `code.claude.com/docs/en`, which the older `docs.anthropic.com/en/docs/claude-code/...` pages redirect to.

## Executive Summary

Claude Code has a real plugin system, but it is organized around composable local artifacts rather than a single "app" abstraction:

- **Skills** are prompt/instruction packages discovered from `SKILL.md` files and invoked automatically or via `/skill-name` [skills docs](https://code.claude.com/docs/en/skills).
- **Plugins** bundle skills, command-style skills, subagents, hooks, MCP servers, LSP servers, themes, output styles, monitors, executables, and limited default settings [plugins reference](https://code.claude.com/docs/en/plugins-reference).
- **Hooks** are lifecycle automations configured in JSON settings, plugin hook files, skill frontmatter, or subagent frontmatter. Handlers may be shell commands, HTTP endpoints, MCP tools, prompt hooks, or experimental agent hooks [hooks reference](https://code.claude.com/docs/en/hooks).
- **MCP servers** expose external tools and resources to Claude Code, configured by CLI commands, JSON files, managed policy, or plugins [MCP docs](https://code.claude.com/docs/en/mcp).
- **Subagents** are specialized agents with their own context, tools, model, permissions, skills, MCP scope, hooks, memory, and optional isolation [subagents docs](https://code.claude.com/docs/en/sub-agents).
- **Slash commands** remain important, but custom commands have effectively merged into skills. Files in `.claude/commands/*.md` still work, while `.claude/skills/<name>/SKILL.md` is the recommended form [skills docs](https://code.claude.com/docs/en/skills).

Claude Code does **not** appear to have a Codex-like "app connector" concept as a distinct product abstraction. The closest equivalents are:

- Remote or local **MCP servers**, which expose tools/resources/prompts and can connect to SaaS systems.
- **Plugins**, which package MCP servers together with skills, agents, hooks, commands, binaries, and settings.
- **Channels**, which are MCP-like external event integrations that can push messages into sessions; they are documented separately and are gated by managed settings such as `channelsEnabled` and `allowedChannelPlugins` [settings docs](https://code.claude.com/docs/en/settings).

## Configuration Scopes and Files

Claude Code uses hierarchical scopes for most extension surfaces [settings docs](https://code.claude.com/docs/en/settings):

| Scope | Location | Typical use |
| --- | --- | --- |
| Managed | Server-managed settings, OS policy, or system `managed-settings.json` | Organization controls and security policy |
| User | `~/.claude/` | Personal settings, skills, agents, plugins |
| Project | `.claude/` in repo | Team-shared settings, skills, agents, hooks |
| Local | `.claude/settings.local.json` | Per-project personal overrides, normally gitignored |

Important files and directories:

| Surface | User | Project | Notes |
| --- | --- | --- | --- |
| Settings | `~/.claude/settings.json` | `.claude/settings.json`, `.claude/settings.local.json` | Settings reload during sessions for most keys, including `permissions` and `hooks` [settings docs](https://code.claude.com/docs/en/settings). |
| OAuth/session/per-project state | `~/.claude.json` | N/A | Stores OAuth session, user/local MCP config, allowed tools, trust settings, caches [settings docs](https://code.claude.com/docs/en/settings). |
| MCP servers | `~/.claude.json` | `.mcp.json` | Local and user scope live in `~/.claude.json`; project scope lives in `.mcp.json` [MCP docs](https://code.claude.com/docs/en/mcp). |
| Skills | `~/.claude/skills/<skill>/SKILL.md` | `.claude/skills/<skill>/SKILL.md` | Enterprise and plugin skills also exist [skills docs](https://code.claude.com/docs/en/skills). |
| Commands | `~/.claude/commands/*.md` | `.claude/commands/*.md` | Legacy/custom command files still work, but skills are recommended [skills docs](https://code.claude.com/docs/en/skills). |
| Subagents | `~/.claude/agents/*.md` | `.claude/agents/*.md` | Managed and plugin subagents also exist [subagents docs](https://code.claude.com/docs/en/sub-agents). |
| Plugins | Settings-managed | Settings-managed | Installed/enabled through `/plugin` and `claude plugin ...`; plugin roots contain `.claude-plugin/plugin.json` plus component directories [plugins reference](https://code.claude.com/docs/en/plugins-reference). |

Settings precedence is managed, command-line, local, project, then user. Permission rules merge differently from simple scalar settings [settings docs](https://code.claude.com/docs/en/settings).

## Plugins

Claude Code plugins package multiple extension surfaces behind a marketplace/install lifecycle [plugins reference](https://code.claude.com/docs/en/plugins-reference).

### Plugin Structure

A plugin may contain:

```text
plugin-root/
  .claude-plugin/
    plugin.json
  skills/
    example-skill/
      SKILL.md
  commands/
    status.md
  agents/
    security-reviewer.md
  output-styles/
    terse.md
  themes/
    dracula.json
  monitors/
    monitors.json
  hooks/
    hooks.json
  bin/
    my-tool
  settings.json
  .mcp.json
  .lsp.json
  scripts/
    helper.sh
```

Official docs call out that component directories such as `skills/`, `commands/`, `agents/`, `output-styles/`, `themes/`, `monitors/`, and `hooks/` must live at the plugin root, not inside `.claude-plugin/` [plugins reference](https://code.claude.com/docs/en/plugins-reference). A root `CLAUDE.md` in a plugin is not loaded as project context; plugin context should be shipped through skills, agents, or hooks [plugins reference](https://code.claude.com/docs/en/plugins-reference).

Notable plugin component behavior:

- `skills/` contains normal skills using `<name>/SKILL.md`.
- `commands/` contains flat Markdown command-style skills. New plugins should prefer `skills/`.
- `agents/` contains subagent Markdown files.
- `hooks/hooks.json` is the default plugin hook configuration.
- `.mcp.json` contributes MCP servers.
- `bin/` executables are added to the Bash tool `PATH` while the plugin is enabled.
- `settings.json` currently supports only the `agent` and `subagentStatusLine` keys as plugin defaults [plugins reference](https://code.claude.com/docs/en/plugins-reference).

### Plugin Namespacing

Plugin skills use a `plugin-name:skill-name` namespace, so they do not conflict with personal or project skills [skills docs](https://code.claude.com/docs/en/skills). Plugin subagents are also namespaced; recursively nested plugin agent files include their subfolder path in the scoped identifier, such as `my-plugin:review:security` [subagents docs](https://code.claude.com/docs/en/sub-agents).

### Plugin Commands and Lifecycle

Claude Code has both interactive `/plugin ...` commands and `claude plugin ...` CLI commands. Documented behavior includes:

- Install official MCP server scaffolding plugin with `/plugin install mcp-server-dev@claude-plugins-official`; if the marketplace is missing, add it with `/plugin marketplace add anthropics/claude-plugins-official`, then run `/reload-plugins` [MCP docs](https://code.claude.com/docs/en/mcp).
- Use `/reload-plugins` after changes to plugin `hooks/`, `.mcp.json`, `agents/`, and `output-styles/` [skills docs](https://code.claude.com/docs/en/skills).
- Use `claude plugin validate` or `/plugin validate` for manifest, frontmatter, and hook schema checks [plugins reference](https://code.claude.com/docs/en/plugins-reference).
- Use `claude --debug` to inspect plugin loading, manifest errors, skill/agent/hook registration, and MCP initialization [plugins reference](https://code.claude.com/docs/en/plugins-reference).
- `claude plugin tag` creates plugin release git tags and can optionally push them [plugins reference](https://code.claude.com/docs/en/plugins-reference).

The docs also describe plugin token-cost reporting: "always-on" listing text cost and "on-invoke" component cost [plugins reference](https://code.claude.com/docs/en/plugins-reference).

### Distribution and Marketplace Controls

Documented plugin distribution centers on marketplaces and plugin IDs such as `mcp-server-dev@claude-plugins-official` [MCP docs](https://code.claude.com/docs/en/mcp). Managed settings can control marketplace behavior:

- `enabledPlugins` can force-enable vetted plugins.
- `extraKnownMarketplaces`, `strictKnownMarketplaces`, and `blockedMarketplaces` govern what marketplaces users can add or fetch from [settings docs](https://code.claude.com/docs/en/settings).
- `strictPluginOnlyCustomization` is listed as a plugin-related setting, indicating admins can restrict customization to plugins, though the exact operational details should be verified against the current settings reference before relying on it [settings docs](https://code.claude.com/docs/en/settings).

## Skills

Skills are reusable instruction bundles following the Agent Skills open standard, with Claude Code-specific extensions such as invocation controls, subagent execution, and dynamic context injection [skills docs](https://code.claude.com/docs/en/skills).

### Basic Format

Every skill is a directory with a required `SKILL.md`:

```markdown
---
description: Summarizes uncommitted changes and flags risks. Use when the user asks what changed.
---

## Instructions

Summarize the current diff and identify risks.
```

The YAML frontmatter tells Claude when and how to use the skill. The Markdown body is loaded only when the skill is used, avoiding the constant context cost of putting everything in `CLAUDE.md` [skills docs](https://code.claude.com/docs/en/skills).

### Discovery and Precedence

Skill locations:

- Enterprise managed skills: organization-wide.
- Personal: `~/.claude/skills/<skill-name>/SKILL.md`.
- Project: `.claude/skills/<skill-name>/SKILL.md`.
- Plugin: `<plugin>/skills/<skill-name>/SKILL.md` [skills docs](https://code.claude.com/docs/en/skills).

Precedence for same-name non-plugin skills is enterprise, then personal, then project. Plugin skills are namespaced as `plugin-name:skill-name`, avoiding conflicts [skills docs](https://code.claude.com/docs/en/skills).

Claude Code watches existing skill directories for changes. Editing `SKILL.md` under personal/project/added-directory skill folders takes effect during the current session, but creating a top-level skill directory that did not exist at session start requires restart. For a skill folder that is also a plugin, changes outside `SKILL.md` require `/reload-plugins` [skills docs](https://code.claude.com/docs/en/skills).

Project skills are discovered from `.claude/skills/` in the starting directory and parent directories up to repo root, and nested `.claude/skills/` directories can be discovered on demand as work moves into subdirectories. Skills inside directories added via `--add-dir` or `/add-dir` are loaded automatically, but `permissions.additionalDirectories` grants file access only and does not load skills [skills docs](https://code.claude.com/docs/en/skills).

### Invocation and Slash Commands

Skills can be invoked:

- Automatically, when Claude matches the user request to the skill description.
- Directly, via `/skill-name`.
- For plugin skills, via `/plugin-name:skill-name`.

Custom commands have been merged into skills. `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` both create `/deploy`; if a command and skill share a name, the skill takes precedence [skills docs](https://code.claude.com/docs/en/skills).

Bundled prompt-based skills include `/code-review`, `/batch`, `/debug`, `/loop`, and `/claude-api`, unless disabled by `disableBundledSkills` [skills docs](https://code.claude.com/docs/en/skills). The commands reference lists built-in commands and bundled skill commands such as `/branch`, `/btw`, `/cd`, `/claude-api`, `/clear`, `/code-review`, `/color`, and `/compact` [commands reference](https://code.claude.com/docs/en/commands).

### Skill Content and Tools

Skills may include supporting files such as templates, examples, scripts, and reference docs. The `SKILL.md` should reference those files so Claude knows when to load them [skills docs](https://code.claude.com/docs/en/skills).

Skills can use dynamic context injection with lines like:

```markdown
!`git diff HEAD`
```

Claude Code runs the command and replaces the line with output before Claude sees the skill content [skills docs](https://code.claude.com/docs/en/skills).

Claude Code supports `${CLAUDE_SKILL_DIR}` in skill instructions for resolving bundled scripts regardless of whether the skill is personal, project, or plugin-installed [skills docs](https://code.claude.com/docs/en/skills).

Skills can pre-approve tools through frontmatter such as:

```yaml
allowed-tools: Bash(python3 *)
```

This lets a skill use specific tool patterns without asking each time, subject to the broader permission model [skills docs](https://code.claude.com/docs/en/skills).

### Visibility Controls

The `/skills` menu can write `skillOverrides` into `.claude/settings.local.json`. Possible values are:

- `"on"`: listed to Claude and shown in `/`.
- `"name-only"`: only the name is listed to Claude, still shown in `/`.
- `"user-invocable-only"`: hidden from Claude, shown in `/`.
- `"off"`: hidden from Claude and `/`.

Absent skills default to `"on"`. Plugin skills are not affected by `skillOverrides`; manage plugin skills through `/plugin` [skills docs](https://code.claude.com/docs/en/skills).

## Hooks

Hooks are user-defined automations that run at specific Claude Code lifecycle events. They can inspect JSON event context and optionally return decisions [hooks reference](https://code.claude.com/docs/en/hooks).

### Hook Locations

Hooks can be defined in:

- `~/.claude/settings.json` for all projects.
- `.claude/settings.json` for committed project hooks.
- `.claude/settings.local.json` for local project hooks.
- Managed policy settings.
- Plugin `hooks/hooks.json`.
- Skill or agent frontmatter while that component is active [hooks reference](https://code.claude.com/docs/en/hooks).

Enterprise admins can set `allowManagedHooksOnly` to block user, project, and plugin hooks except hooks from plugins force-enabled in managed `enabledPlugins` [hooks reference](https://code.claude.com/docs/en/hooks).

### Hook Configuration Shape

Hooks are JSON with three layers:

1. Hook event, such as `PreToolUse`.
2. Matcher group, such as `Bash` or `Edit|Write`.
3. Hook handlers, such as command, HTTP, MCP tool, prompt, or agent handlers.

Example:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh",
            "args": []
          }
        ]
      }
    ]
  }
}
```

For command hooks, the event JSON is passed on stdin. For HTTP hooks, it is the POST body. Handlers can output JSON decisions or rely on exit-code behavior [hooks reference](https://code.claude.com/docs/en/hooks).

### Hook Handler Types

Supported handler types:

- `command`: run a shell command. Receives JSON on stdin; returns through stdout and exit code.
- `http`: POST event JSON to a URL; response body uses the same output format as command hooks.
- `mcp_tool`: call a tool on an already-connected MCP server; text output is treated like command stdout.
- `prompt`: send a prompt to a Claude model for single-turn yes/no evaluation.
- `agent`: spawn a subagent with tools such as Read, Grep, and Glob. Agent hooks are documented as experimental [hooks reference](https://code.claude.com/docs/en/hooks).

Common handler fields include `type`, optional `if`, `timeout`, `statusMessage`, and `once`. `once` only applies to hooks declared in skill frontmatter [hooks reference](https://code.claude.com/docs/en/hooks).

Command-specific fields include `command`, optional `args`, `async`, `asyncRewake`, and `shell`. Supplying `args` uses exec form rather than shell form [hooks reference](https://code.claude.com/docs/en/hooks).

### Matchers and Tool Rules

Matchers are interpreted as:

- `"*"`, empty, or omitted: match all.
- Only letters/digits/underscore/pipe: exact match or pipe-separated exact alternatives.
- Anything else: JavaScript regular expression [hooks reference](https://code.claude.com/docs/en/hooks).

For tool events, matchers apply to `tool_name`. MCP tools appear as normal tools named `mcp__<server>__<tool>`, such as `mcp__github__search_repositories`. Use regex-like matchers such as `mcp__memory__.*` to match a whole MCP server [hooks reference](https://code.claude.com/docs/en/hooks).

The `if` field uses permission rule syntax, for example `Bash(git *)` or `Edit(*.ts)`. It is only evaluated on tool events. There is no `&&`, `||`, or list syntax; use multiple handlers for multiple conditions [hooks reference](https://code.claude.com/docs/en/hooks).

### Hook Events

Documented events include:

- Session lifecycle: `SessionStart`, `Setup`, `InstructionsLoaded`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`, `SessionEnd`.
- User/message lifecycle: `UserPromptSubmit`, `UserPromptExpansion`, `MessageDisplay`, `Notification`.
- Tool lifecycle: `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`.
- Agent/task lifecycle: `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`.
- Environment/config lifecycle: `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`.
- MCP elicitation: `Elicitation`, `ElicitationResult` [hooks reference](https://code.claude.com/docs/en/hooks).

Some events support decision control, such as blocking or denying tool calls, adding context, retrying denied calls, or controlling stop behavior. Others are informational or ignore output. Exact input/output schemas vary by event and should be checked in the hook reference before implementing a handler [hooks reference](https://code.claude.com/docs/en/hooks).

### Hook Security Controls

Relevant settings:

- `disableAllHooks`: disables all hooks and custom status line [settings docs](https://code.claude.com/docs/en/settings).
- `allowManagedHooksOnly`: managed setting that permits only managed hooks, SDK hooks, and hooks from managed-force-enabled plugins [settings docs](https://code.claude.com/docs/en/settings).
- `allowedHttpHookUrls`: allowlist for HTTP hook URLs. Supports `*` wildcard. Defined arrays merge across scopes [settings docs](https://code.claude.com/docs/en/settings).
- `httpHookAllowedEnvVars`: restricts which environment variables HTTP hooks may interpolate into headers [settings docs](https://code.claude.com/docs/en/settings).

The hook docs include explicit security guidance: hooks execute user-defined commands and can affect tool permissions, so hook source and scope matter [hooks reference](https://code.claude.com/docs/en/hooks).

## MCP

Claude Code supports MCP for connecting external tools and resources [MCP docs](https://code.claude.com/docs/en/mcp).

### Transports and Installation

Supported configuration examples include:

```bash
claude mcp add --transport http notion https://mcp.notion.com/mcp
claude mcp add --transport sse asana https://mcp.asana.com/sse
claude mcp add --env AIRTABLE_API_KEY=YOUR_KEY --transport stdio airtable -- npx -y airtable-mcp-server
```

HTTP is documented as the recommended remote transport. SSE is deprecated where HTTP is available. Stdio servers run as local processes and receive `CLAUDE_PROJECT_DIR` in their environment [MCP docs](https://code.claude.com/docs/en/mcp).

When configuring MCP via JSON in `.mcp.json`, `~/.claude.json`, or `claude mcp add-json`, `type: "streamable-http"` is accepted as an alias for `http` [MCP docs](https://code.claude.com/docs/en/mcp).

### MCP Scopes

MCP server scopes:

| Scope | Loads in | Shared? | Stored in |
| --- | --- | --- | --- |
| Local | Current project only | No | `~/.claude.json`, under the current project path |
| Project | Current project only | Yes | `.mcp.json` in project root |
| User | All projects | No | `~/.claude.json` |

Project-scoped `.mcp.json` uses:

```json
{
  "mcpServers": {
    "shared-server": {
      "command": "/path/to/server",
      "args": [],
      "env": {}
    }
  }
}
```

Administrators can also deploy managed MCP configuration [MCP docs](https://code.claude.com/docs/en/mcp).

### Plugin MCP Servers

Plugins can include `.mcp.json`, and installed plugin MCP servers appear in `/mcp` with indicators showing they came from plugins. The documented benefits are bundled distribution, automatic setup, and team consistency [MCP docs](https://code.claude.com/docs/en/mcp).

### MCP Permissions and Policy

Managed settings can restrict MCP:

- `allowedMcpServers`: allowlist for servers users may configure.
- `deniedMcpServers`: denylist; denylist takes precedence.
- `allowManagedMcpServersOnly`: only managed allowlist applies.
- `allowAllClaudeAiMcps`: load claude.ai connectors alongside deployed `managed-mcp.json` [settings docs](https://code.claude.com/docs/en/settings).

MCP tools participate in the normal tool permission and hook model. They appear as `mcp__<server>__<tool>` in hook matchers and permission-like patterns [hooks reference](https://code.claude.com/docs/en/hooks).

The MCP docs explicitly warn to trust servers before connecting them, because servers fetching external content can expose prompt-injection risk [MCP docs](https://code.claude.com/docs/en/mcp).

## Subagents and Agents

Subagents are specialized assistants with independent context windows, prompts, tools, permissions, models, MCP scope, and hooks [subagents docs](https://code.claude.com/docs/en/sub-agents).

### Locations and Formats

Subagents can come from:

- Project `.claude/agents/`.
- User `~/.claude/agents/`.
- Managed admin deployment.
- Plugins.
- CLI `--agents` JSON for session-only definitions [subagents docs](https://code.claude.com/docs/en/sub-agents).

Claude Code scans `.claude/agents/` and `~/.claude/agents/` recursively. In user/project scopes, identity comes from the `name` frontmatter field, not the file path. Duplicate names within one scope may result in one being discarded without warning. Plugin agent subfolders become part of the scoped identifier [subagents docs](https://code.claude.com/docs/en/sub-agents).

The `--agents` flag accepts JSON equivalent to file frontmatter fields, including `description`, `prompt`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `isolation`, and `color` [subagents docs](https://code.claude.com/docs/en/sub-agents).

### Capabilities and Extension Integration

Subagents can:

- Be selected automatically when Claude sees a matching task.
- Be invoked explicitly.
- Run in foreground or background.
- Use specific tools or disallow tools.
- Scope MCP servers to the subagent.
- Preload skills.
- Define hooks in frontmatter.
- Use permission modes and persistent memory [subagents docs](https://code.claude.com/docs/en/sub-agents).

Hooks have subagent-specific events (`SubagentStart`, `SubagentStop`) and can also be defined directly in agent frontmatter [hooks reference](https://code.claude.com/docs/en/hooks).

## Permissions Model

Claude Code permissions are configured primarily through `settings.json` and related managed policy [settings docs](https://code.claude.com/docs/en/settings).

Example:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run test *)",
      "Read(~/.zshrc)"
    ],
    "deny": [
      "Bash(curl *)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)"
    ]
  }
}
```

Notable controls:

- `allow`, `ask`, and `deny` permission rules use a tool-pattern syntax also reused by hook `if` conditions [settings docs](https://code.claude.com/docs/en/settings).
- `allowManagedPermissionRulesOnly` can prevent user/project settings from defining `allow`, `ask`, or `deny`, leaving only managed rules [settings docs](https://code.claude.com/docs/en/settings).
- Hooks can participate in permission decisions for events such as `PreToolUse`, `PermissionRequest`, and `PermissionDenied` [hooks reference](https://code.claude.com/docs/en/hooks).
- Subagents have their own permission modes and tool restrictions [subagents docs](https://code.claude.com/docs/en/sub-agents).
- Skills can use `allowed-tools` frontmatter to pre-approve specific tool patterns, subject to broader policy [skills docs](https://code.claude.com/docs/en/skills).
- Managed settings parse invalid security-enforcement fields carefully. For example, invalid `allowedMcpServers` is enforced as an empty allowlist until fixed, while some version constraints fail open by design [settings docs](https://code.claude.com/docs/en/settings).

## Apps and Tooling Concepts

Claude Code does not currently document a single Codex-like "app" abstraction that groups authenticated connectors under an app namespace. Instead:

- **MCP servers/connectors** are the core tool integration model. The MCP docs mention the Anthropic Directory for reviewed connectors and say Directory connectors use the same MCP infrastructure as Claude Code [MCP docs](https://code.claude.com/docs/en/mcp).
- **Plugins** are the packaging/distribution abstraction for tools plus agent UX. A plugin can include MCP servers, skills, agents, hooks, binaries, themes, output styles, monitors, and settings [plugins reference](https://code.claude.com/docs/en/plugins-reference).
- **Channels** are the closest documented equivalent to external event apps. MCP servers can act as channels that push messages into a session, and managed settings can gate channel plugins with `channelsEnabled` and `allowedChannelPlugins` [MCP docs](https://code.claude.com/docs/en/mcp), [settings docs](https://code.claude.com/docs/en/settings).
- **Slash commands/skills** are the user-facing command surface, not an app surface. They can invoke workflows and orchestrate tools.

For a Codex comparison, Claude Code's equivalent stack is probably "plugin + MCP server + skills + optional subagents/hooks" rather than "app connector".

## Practical Recipes

### Add a Team-Shared Skill

```text
.claude/
  skills/
    deploy/
      SKILL.md
```

Then invoke with `/deploy`, or let Claude auto-select it from its `description` [skills docs](https://code.claude.com/docs/en/skills).

### Add a Team-Shared MCP Server

```bash
claude mcp add --transport http paypal --scope project https://mcp.paypal.com/mcp
```

This writes `.mcp.json` in the project root [MCP docs](https://code.claude.com/docs/en/mcp).

### Block Risky Shell Commands with a Hook

Configure `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh"
          }
        ]
      }
    ]
  }
}
```

The script reads JSON from stdin and can return `permissionDecision: "deny"` with a reason [hooks reference](https://code.claude.com/docs/en/hooks).

### Package a Plugin MCP Server

Create a plugin root with:

```text
.claude-plugin/plugin.json
.mcp.json
skills/<workflow>/SKILL.md
hooks/hooks.json
bin/<helper>
```

Validate with `claude plugin validate` or `/plugin validate`; debug loading with `claude --debug` [plugins reference](https://code.claude.com/docs/en/plugins-reference).

## Unknowns and Gaps

- **Marketplace internals**: Official docs show marketplace commands and managed restrictions, but do not fully specify all marketplace index formats, cache locations, trust prompts, or update resolution behavior in the pages reviewed.
- **Plugin manifest schema details**: The plugin reference documents structure and validation, but this research should be supplemented with the current `plugin.json` schema before implementing a generator.
- **Plugin install storage paths**: The public docs reviewed here describe plugin roots and commands, but not every on-disk cache/install directory.
- **Prompt and agent hook stability**: Agent hooks are explicitly experimental in the hook docs; prompt hook behavior should be treated as model-dependent and verified for sensitive enforcement uses [hooks reference](https://code.claude.com/docs/en/hooks).
- **Channels**: Channels appear to be important for app-like external event delivery, but they are documented separately from MCP and plugins. More research is needed if channel plugins are in scope.
- **Managed settings edge cases**: Managed policy has many security controls, but the precise merge behavior for some plugin-specific settings should be verified before designing enterprise distribution.
- **App concept**: No distinct Codex-like app connector abstraction was found in the official Claude Code docs reviewed. MCP connectors, plugins, and channels are the nearest equivalents.

## Source Index

- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code commands reference](https://code.claude.com/docs/en/commands)
