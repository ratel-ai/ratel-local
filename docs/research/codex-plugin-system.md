# Codex Plugin System Research

Last researched: 2026-06-10.

This note focuses on the current Codex plugin system as documented by OpenAI and as observed in the local Codex installation on this machine. Official documentation is still relatively sparse in a few areas, so this document separates documented behavior from local observations and open questions.

## Executive Summary

Codex plugins are the installable distribution unit for reusable Codex extensions. A plugin can bundle skills, app integrations, MCP servers, lifecycle hooks, and presentation assets. OpenAI documents plugins as reusable workflows that can include [skills, apps, and MCP servers](https://developers.openai.com/codex/plugins), and the plugin authoring guide now also documents packaged lifecycle hooks in the plugin bundle structure and manifest.

The core plugin entry point is a manifest at `.codex-plugin/plugin.json`. Plugins are discovered through marketplaces, installed into a Codex cache under `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`, and enabled/disabled through `~/.codex/config.toml` ([Build plugins](https://developers.openai.com/codex/plugins/build)).

Skills are instruction bundles with progressive disclosure. MCP servers expose tools and server instructions. Apps/connectors appear to bridge Codex plugins to ChatGPT app connections, usually through a plugin-local `.app.json` mapping. Hooks run deterministic lifecycle scripts and require trust review unless managed by policy.

The read/write tool permission model appears to combine:

- plugin and app metadata such as `interface.capabilities: ["Read", "Write"]`;
- app/MCP tool annotations such as `readOnlyHint`, `destructiveHint`, and `openWorldHint`;
- Codex config controls for app destructive tools, app OpenAPI tool includes/excludes, and MCP tool approval modes.

The exact UI rule that divides app tools into read and write sections is not fully documented in the Codex plugin docs. The closest official source is the Apps SDK annotation reference, which requires tool descriptors to declare whether a tool is read-only, destructive, or open-world ([Apps SDK reference, annotations](https://developers.openai.com/apps-sdk/reference)).

## Sources Used

Official sources:

- [Codex Plugins overview](https://developers.openai.com/codex/plugins)
- [Codex Build plugins](https://developers.openai.com/codex/plugins/build)
- [Codex Agent Skills](https://developers.openai.com/codex/skills)
- [Codex Hooks](https://developers.openai.com/codex/hooks)
- [Codex MCP](https://developers.openai.com/codex/mcp)
- [Codex Permissions](https://developers.openai.com/codex/permissions)
- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference)
- [Apps SDK Reference](https://developers.openai.com/apps-sdk/reference)
- [OpenAI Codex GitHub README](https://github.com/openai/codex)

Local observed sources:

- `~/.codex/skills/.system/plugin-creator/SKILL.md`
- `~/.codex/skills/.system/plugin-creator/references/plugin-json-spec.md`
- `~/.codex/skills/.system/plugin-creator/references/installing-and-updating.md`
- installed plugin cache under `~/.codex/plugins/cache/`
- installed plugin examples including `openai-curated/github`, `openai-curated/linear`, `openai-curated/notion`, `openai-bundled/browser`, `openai-primary-runtime/documents`, and `claude-plugins-official/expo`
- local CLI help from `codex plugin --help` and `codex plugin marketplace --help`

## Plugin Structure

Documented plugin structure:

```text
my-plugin/
  .codex-plugin/
    plugin.json          # required
  skills/
    my-skill/
      SKILL.md           # optional skill
  hooks/
    hooks.json           # optional lifecycle hooks
  .app.json              # optional app or connector mappings
  .mcp.json              # optional MCP server configuration
  assets/                # optional icons, logos, screenshots
```

OpenAI documents that only `plugin.json` belongs inside `.codex-plugin/`; `skills/`, `hooks/`, `assets/`, `.mcp.json`, and `.app.json` should live at the plugin root ([Build plugins, plugin structure](https://developers.openai.com/codex/plugins/build)).

The manifest can include:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Bundle reusable skills and app integrations.",
  "author": {
    "name": "Your team",
    "email": "team@example.com",
    "url": "https://example.com"
  },
  "homepage": "https://example.com/plugins/my-plugin",
  "repository": "https://github.com/example/my-plugin",
  "license": "MIT",
  "keywords": ["research", "crm"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "Reusable skills and apps",
    "longDescription": "Distribute skills and app integrations together.",
    "developerName": "Your team",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://example.com",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "defaultPrompt": [
      "Use My Plugin to summarize new CRM notes.",
      "Use My Plugin to triage new customer follow-ups."
    ],
    "brandColor": "#10A37F",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "screenshots": ["./assets/screenshot-1.png"]
  }
}
```

Documented manifest path rules:

- Manifest paths are relative to the plugin root and should start with `./`.
- Visual assets should generally be under `./assets/`.
- `skills`, `apps`, `mcpServers`, and `hooks` point to their corresponding bundled components.
- If hooks live at the default `./hooks/hooks.json`, the `hooks` manifest field is optional because Codex checks that default file automatically ([Build plugins, path rules](https://developers.openai.com/codex/plugins/build)).

Local observations:

- Installed plugins in `~/.codex/plugins/cache` consistently use `.codex-plugin/plugin.json`.
- Examples:
  - GitHub plugin has `skills: "./skills/"` and `apps: "./.app.json"`.
  - Expo plugin has `skills: "./skills/"` and `mcpServers: "./.mcp.json"`.
  - Browser plugin has `skills: "./skills/"` and bundled assets.
- Some cached plugins include compatibility manifests such as `.claude-plugin/plugin.json` or `.cursor-plugin/plugin.json`; Codex’s documented required manifest remains `.codex-plugin/plugin.json`.

## Skills

Officially, skills extend Codex with task-specific capabilities. A skill is a directory with required `SKILL.md`, optional `scripts/`, `references/`, `assets/`, and optional `agents/openai.yaml` UI metadata ([Codex Agent Skills](https://developers.openai.com/codex/skills)).

Minimal skill:

```markdown
---
name: hello
description: Greet the user with a friendly message.
---

Greet the user warmly and ask how you can help.
```

Skill discovery and loading:

- Codex begins with each skill’s name, description, and file path in context.
- Codex loads the full `SKILL.md` body only when it decides to use the skill.
- The initial skill list is capped to protect context size, roughly 2% of the model context window or 8,000 characters when context is unknown.
- A skill can be activated explicitly by mentioning it, using `/skills`, or typing `$` in CLI/IDE; Codex can also choose a skill implicitly based on its `description`.
- Codex detects skill changes automatically; restart Codex if updates do not appear.

Skill search locations documented by OpenAI:

| Scope | Location |
| --- | --- |
| Repo | `$CWD/.agents/skills` |
| Repo parent directories | `$CWD/../.agents/skills` up to repo root |
| Repo root | `$REPO_ROOT/.agents/skills` |
| User | `$HOME/.agents/skills` |
| Admin | `/etc/codex/skills` |
| System | bundled with Codex by OpenAI |

Local observations:

- This session also exposes skills from `~/.codex/skills`, `~/.agents/skills`, and plugin cache paths. The official docs emphasize `$HOME/.agents/skills`, while local runtime context includes `~/.codex/skills` system and user skill roots.
- Plugin skills appear namespaced in the prompt as `plugin-name:skill-name`, for example `expo:expo-module` and `notion:notion-knowledge-capture`.
- Standalone skills appear without plugin namespace, for example `skill-creator`, `plugin-creator`, and `openai-docs`.

## Hooks

Hooks are a Codex extensibility framework for deterministic scripts during the agent lifecycle. Official examples include logging conversations, scanning prompts for secrets, creating memories, running validation when a turn stops, and customizing prompting by directory ([Codex Hooks](https://developers.openai.com/codex/hooks)).

Documented hook behavior:

- Hooks are enabled by default.
- Disable them with:

```toml
[features]
hooks = false
```

- `hooks` is the canonical feature key; `codex_hooks` remains a deprecated alias.
- Matching hooks from multiple files all run.
- Multiple matching command hooks for the same event launch concurrently.
- Non-managed command hooks must be reviewed and trusted before they run.
- Managed hooks from system, MDM, cloud, or `requirements.toml` sources are trusted by policy and cannot be disabled from the user hook browser.
- `/hooks` in the CLI lets users inspect hook sources, review changes, trust hooks, or disable individual non-managed hooks.

Documented hook discovery:

- `~/.codex/hooks.json`
- `~/.codex/config.toml`
- `<repo>/.codex/hooks.json`
- `<repo>/.codex/config.toml`
- enabled plugins through plugin-bundled hooks

Project-local hooks only load when the project `.codex/` layer is trusted.

Hook config shape:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.codex/hooks/session_start.py",
            "statusMessage": "Loading session notes"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py\"",
            "statusMessage": "Checking Bash command"
          }
        ]
      }
    ]
  }
}
```

Events explicitly documented include:

- `SessionStart`
- `SubagentStart`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PreCompact`
- `PostCompact`
- `UserPromptSubmit`
- `SubagentStop`
- `Stop`

Plugin hooks:

- Enabled plugins can include lifecycle hooks alongside skills, MCP servers, and apps.
- Installing or enabling a plugin does not automatically trust its hooks.
- Plugin-bundled hooks are non-managed hooks and are skipped until the user reviews and trusts the current hook definition.
- The default plugin hook file is `hooks/hooks.json`.
- A plugin manifest `hooks` entry overrides default discovery and can be a single path, an array of paths, an inline hooks object, or an array of inline hooks objects.
- Plugin hook commands receive `PLUGIN_ROOT` and `PLUGIN_DATA`; Codex also sets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` for compatibility ([Build plugins, bundled MCP servers and lifecycle hooks](https://developers.openai.com/codex/plugins/build)).

Local caveat:

- The local `plugin-creator` reference file currently says validation rejects unsupported manifest fields such as `hooks`, while the current official OpenAI docs document `hooks` as supported in plugin manifests. Treat the local validator note as stale or version-specific unless confirmed against the installed Codex build. If authoring a plugin today, prefer the official docs but validate with the local `plugin-creator` tooling and the running Codex version.

## MCP Servers

MCP connects Codex to third-party tools and context. Codex supports MCP servers in the CLI and IDE extension ([Codex MCP](https://developers.openai.com/codex/mcp)).

Documented supported MCP features:

- STDIO servers:
  - launched as local processes;
  - support environment variables.
- Streamable HTTP servers:
  - configured by URL;
  - support bearer token authentication;
  - support OAuth via `codex mcp login <server-name>` when the server supports OAuth.
- Server instructions:
  - Codex reads the MCP `instructions` field returned during initialization and uses it as server-wide guidance alongside the server’s tools.
  - OpenAI recommends putting cross-tool workflows, constraints, and rate limits in `instructions`, with the first 512 characters self-contained.

User/project config shape:

```toml
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["LOCAL_TOKEN"]

[mcp_servers.context7.env]
MY_ENV_VAR = "MY_ENV_VALUE"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }

[mcp_servers.chrome_devtools]
url = "http://localhost:3000/mcp"
enabled_tools = ["open", "screenshot"]
disabled_tools = ["screenshot"]
default_tools_approval_mode = "prompt"
startup_timeout_sec = 20
tool_timeout_sec = 45
enabled = true

[mcp_servers.chrome_devtools.tools.open]
approval_mode = "approve"
```

Important options:

- `command`, `args`, `env`, `env_vars`, `cwd` for STDIO servers.
- `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers` for HTTP servers.
- `startup_timeout_sec`, `tool_timeout_sec`.
- `enabled`.
- `required`.
- `enabled_tools` and `disabled_tools`.
- `default_tools_approval_mode`, with documented values `auto`, `prompt`, and `approve`.
- per-tool `tools.<tool>.approval_mode`.

Plugin-provided MCP:

OpenAI documents that installed plugins can bundle MCP servers in their plugin manifest. These servers are launched from the plugin, so user config does not set the transport command. Users can still control enablement and tool policy under `plugins.<plugin>.mcp_servers.<server>` ([Codex MCP, plugin-provided MCP servers](https://developers.openai.com/codex/mcp)).

```toml
[plugins."sample@test".mcp_servers.sample]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["read", "search"]

[plugins."sample@test".mcp_servers.sample.tools.search]
approval_mode = "approve"
```

Plugin `.mcp.json`:

The `mcpServers` manifest field can point to `.mcp.json` containing either a direct server map or a wrapped object. The official build docs show `mcp_servers`, while locally observed Expo uses `mcpServers`.

Direct server map:

```json
{
  "docs": {
    "command": "docs-mcp",
    "args": ["--stdio"]
  }
}
```

Wrapped server map:

```json
{
  "mcp_servers": {
    "docs": {
      "command": "docs-mcp",
      "args": ["--stdio"]
    }
  }
}
```

Local observed Expo plugin:

```json
{
  "mcpServers": {
    "expo": {
      "type": "http",
      "url": "https://mcp.expo.dev/mcp"
    }
  }
}
```

Unknown/gap:

- Official docs say direct map or wrapped `mcp_servers`; local examples use wrapped `mcpServers`. This suggests Codex accepts legacy or compatibility casing, but that compatibility is not clearly documented on the build page.

## Apps and Connectors

Plugins can include apps: connections to tools like GitHub, Slack, or Google Drive, letting Codex read information and take actions in those systems ([Codex Plugins overview](https://developers.openai.com/codex/plugins)).

Documented install behavior:

- If a plugin includes apps, Codex may prompt the user to install or sign in to those apps in ChatGPT during setup or first use.
- Removing a plugin removes the plugin bundle, but bundled apps stay installed until managed in ChatGPT.
- Data sent through a bundled app is subject to that app’s terms and privacy policy.

Manifest and `.app.json`:

- The plugin manifest points to apps with `"apps": "./.app.json"`.
- Official plugin docs state `.app.json` points at one or more apps or connectors, but do not fully document the schema.

Local observed `.app.json` shape:

```json
{
  "apps": {
    "github": {
      "id": "connector_76869538009648d5b282a4bb21c3d157"
    }
  }
}
```

Observed installed plugin examples:

- GitHub plugin maps `"github"` to a `connector_...` ID.
- Linear plugin has `.app.json` and one `linear` skill.
- Notion plugin has `.app.json`, skills, and `agents/openai.yaml`.
- Vercel plugin has `.app.json`, skills, agents, commands, website assets, and plugin metadata.

Apps vs MCP:

- In OpenAI’s public platform docs, ChatGPT apps are built on MCP concepts. The Apps SDK reference describes tool descriptors, `_meta`, components, tool annotations, and resource metadata ([Apps SDK reference](https://developers.openai.com/apps-sdk/reference)).
- In Codex plugin packaging, `.app.json` appears to be a pointer from the plugin to a ChatGPT/Codex connector or app registration rather than a full MCP server definition. Full custom tool server definitions belong in `.mcp.json`.

Unknown/gap:

- The official Codex plugin docs do not yet document the full `.app.json` schema, how connector IDs are minted, or how app entries map to the lazy-loaded MCP tools exposed in a Codex thread.

## App and Tool Permission Model

There are three overlapping permission surfaces:

1. Codex local execution permissions, covering filesystem and network access for local commands.
2. MCP tool approval policies, covering whether Codex may call specific MCP tools automatically or with prompts.
3. App/connectors tool permissions, covering external service read/write/destructive behavior.

### Local Filesystem and Network Permissions

Codex permission profiles are beta. They define filesystem and network boundaries for local commands. Built-ins are `:read-only`, `:workspace`, and `:danger-full-access` ([Codex Permissions](https://developers.openai.com/codex/permissions)).

Older sandbox settings still exist:

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
writable_roots = ["/path/to/project"]
```

Permission profiles do not compose with older sandbox settings. If `sandbox_mode` is present, Codex uses older sandbox settings instead of `default_permissions` unless managed policy forces permission profiles.

This local filesystem model is separate from app connector permissions.

### MCP Tool Approval

For MCP servers, Codex exposes tool allow/deny and approval controls:

```toml
[mcp_servers.chrome_devtools]
enabled_tools = ["open", "screenshot"]
disabled_tools = ["screenshot"]
default_tools_approval_mode = "prompt"

[mcp_servers.chrome_devtools.tools.open]
approval_mode = "approve"
```

Plugin-provided MCP servers use the same policy under:

```toml
[plugins."plugin-name@marketplace".mcp_servers.server-name]
```

Official docs describe values `auto`, `prompt`, and `approve`; they do not map these values in detail to every UI approval state.

### App Tool Read/Write Grouping

The user-visible model where tools appear divided into read/write sections is only partially documented.

Relevant documented pieces:

- Plugin interface metadata can declare `capabilities`, commonly including `"Read"` and `"Write"` in official examples ([Build plugins manifest example](https://developers.openai.com/codex/plugins/build)).
- Codex config has app-related defaults such as `apps._default.destructive_enabled`, described as the default allow/deny for app tools with `destructive_hint = true` ([Codex configuration reference](https://developers.openai.com/codex/config-reference)).
- Apps SDK tool descriptors should use annotations:
  - `readOnlyHint`: tool only retrieves or computes information and does not create, update, delete, or send data outside ChatGPT.
  - `destructiveHint`: tool may delete or overwrite user data.
  - `openWorldHint`: tool publishes content or reaches outside the current user’s account.
  - `idempotentHint`: optional, repeated calls have no extra effect.
- The Apps SDK docs explicitly say these hints influence how ChatGPT frames tool calls to the user, but servers must still enforce authorization logic ([Apps SDK annotations](https://developers.openai.com/apps-sdk/reference)).

Practical inference:

- Tools with `readOnlyHint: true` likely appear in or are treated as read tools.
- Tools without `readOnlyHint`, or with write/destructive/open-world behavior, likely appear in write/action sections.
- Tools with `destructiveHint: true` are subject to stronger approval UX and config such as `apps._default.destructive_enabled`.

Local observed prompt context:

- App/connector tools are lazy-loaded through `tool_search`.
- Tool discovery text says some sources expose tools for repositories, issues, pull requests, Gmail, Linear, Vercel, node REPL, and Ratel Local.
- In the session instructions, tools from deferred MCP/app sources are described as coming from upstream MCP servers and may require app auth. This supports the idea that connector tools and plugin tools are exposed as MCP-like tools to the model, but does not document the read/write UI grouping.

Unknown/gap:

- Official docs do not currently explain the exact algorithm Codex uses to split app tools into read and write sections in the UI.
- Official docs do not fully document how `interface.capabilities` interacts with tool annotations, connector OAuth scopes, or per-tool app permissions.
- Official docs do not show a full `.app.json` file with read/write tools.

## Marketplace, Installation, Distribution, and Cache Behavior

Documented marketplace behavior:

- A marketplace is a JSON catalog of plugins.
- Codex can read:
  - official curated marketplace;
  - repo marketplace at `$REPO_ROOT/.agents/plugins/marketplace.json`;
  - legacy-compatible marketplace at `$REPO_ROOT/.claude-plugin/marketplace.json`;
  - personal marketplace at `~/.agents/plugins/marketplace.json`.
- Marketplace files contain top-level `name`, optional `interface.displayName`, and ordered `plugins[]`.
- Plugin entries should include `policy.installation`, `policy.authentication`, and `category`.
- `source.path` should be relative to the marketplace root, start with `./`, and remain inside the marketplace root.
- Local `source` can also be a plain string path.
- Git-backed entries can use `"source": "url"` or `"source": "git-subdir"` and may specify `ref` or `sha`.
- If Codex cannot resolve one marketplace entry, it skips that plugin entry instead of failing the whole marketplace ([Build plugins, marketplace section](https://developers.openai.com/codex/plugins/build)).

Example marketplace entry:

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "plugin-name",
      "source": {
        "source": "local",
        "path": "./plugins/plugin-name"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Installation/cache:

- Codex installs plugins into `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`.
- For local plugins, docs say `$VERSION` is `local`, and Codex loads the installed copy from cache rather than directly from the marketplace entry.
- Local observed cache paths include:
  - `~/.codex/plugins/cache/openai-curated/github/d947469e/`
  - `~/.codex/plugins/cache/openai-curated/notion/c6ea566d/`
  - `~/.codex/plugins/cache/openai-bundled/browser/26.608.12217/`
  - `~/.codex/plugins/cache/claude-plugins-official/expo/1.1.0/`
- That suggests non-local or curated plugins may cache by version string, content hash, or release token depending on source.

CLI:

Official build docs document:

```sh
codex plugin marketplace add owner/repo
codex plugin marketplace add owner/repo --ref main
codex plugin marketplace add https://github.com/example/plugins.git --sparse .agents/plugins
codex plugin marketplace add ./local-marketplace-root
codex plugin marketplace list
codex plugin marketplace upgrade
codex plugin marketplace upgrade marketplace-name
codex plugin marketplace remove marketplace-name
```

Local CLI observations:

- `codex plugin --help` in this environment only lists the `marketplace` command.
- `codex plugin marketplace --help` lists `add`, `upgrade`, and `remove`.
- `codex plugin list` is not available locally, despite older local `plugin-creator` guidance mentioning it.
- This may be version skew between docs, skill guidance, and installed CLI help.

Plugin enable/disable:

The overview docs say an installed plugin can be disabled in `~/.codex/config.toml`:

```toml
[plugins."gmail@openai-curated"]
enabled = false
```

The build docs say Codex stores each plugin on/off state in `~/.codex/config.toml`.

Update/reinstall:

Local `plugin-creator` guidance recommends adding a Codex cachebuster suffix to the plugin version during local development:

```text
0.1.0 -> 0.1.0+codex.local-YYYYMMDD-HHMMSS
```

Then reinstall from the marketplace and start a new thread so Codex picks up new skills and tools. This cachebuster flow is local observed guidance, not clearly described in public OpenAI docs.

## Practical Authoring Checklist

1. Start with a local skill if the workflow is only for one repo or one personal use case.
2. Build a plugin when you need distribution, marketplace installation, app integrations, MCP config, or packaged hooks.
3. Create `.codex-plugin/plugin.json` with at least `name`, `version`, `description`, and component pointers as needed.
4. Put skills under `skills/<skill-name>/SKILL.md`.
5. Put MCP server definitions in `.mcp.json` and reference it with `"mcpServers": "./.mcp.json"`.
6. Put app connector mappings in `.app.json` and reference it with `"apps": "./.app.json"`.
7. Put lifecycle hooks in `hooks/hooks.json` unless you need custom paths or inline hook objects.
8. Use `interface` metadata for install surfaces and declare `capabilities` honestly.
9. Add the plugin to a marketplace at `$REPO_ROOT/.agents/plugins/marketplace.json` or `~/.agents/plugins/marketplace.json`.
10. Install/reinstall through the Codex plugin UI or CLI marketplace flow.
11. Start a new thread after installing or updating a plugin.
12. For app/MCP tools, annotate tools accurately as read-only, destructive, open-world, or idempotent at the server descriptor level.

## Open Questions and Gaps

- `.app.json` schema: official Codex docs mention `.app.json` but do not fully specify its schema or connector ID lifecycle.
- Read/write grouping: official docs do not explain the exact UI grouping algorithm for app tools. The Apps SDK annotations are the best public signal.
- Manifest validation vs docs: local `plugin-creator` references say `hooks` may be rejected by validation, while current official docs document `hooks` support. Confirm against the target Codex version before shipping hook-heavy plugins.
- MCP casing: official build docs show `mcp_servers`, while local Expo plugin uses `mcpServers`. Compatibility is observed but not clearly documented.
- CLI surface: official docs mention marketplace `list`; local `codex plugin marketplace --help` in this environment omits `list`, and `codex plugin list` is not recognized.
- Cache versions: official docs specify `local` for local plugins, but local curated caches use values like `d947469e`, `c6ea566d`, and semantic versions. The exact cache key policy for each marketplace/source type is not fully documented.
- App tool permissions: Codex config includes app-specific permission keys, but the public docs do not yet provide a cohesive model tying app installation, OAuth scopes, tool annotations, read/write grouping, destructive gating, and approval prompts together.
