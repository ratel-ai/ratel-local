# Changelog

All notable changes to this package are documented here. The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added the off-by-default `RATEL_FEATURE_CLOUD_CATALOG=1` daemon flag. When it
  is on, the daemon pulls published Cloud skills into the snapshot using the
  saved Cloud API key. Local skills of the same id win; a failed pull warns.
- Added context snapshot diagnostics in the UI shell so catalog and other
  resolve warnings are visible without failing the page.

### Changed
- Made `daemon restart` reconfigure the Cloud telemetry feature flag in an
  installed launchd or systemd service when `RATEL_FEATURE_CLOUD_TELEMETRY` is
  present in the invoking environment (`=1` enables, any other value disables,
  absent preserves). Restart now waits for the stopped daemon to release its
  port, and confirms the restarted daemon adopted the change through the new
  `cloudTelemetry` field on `/api/daemon/status`.
- Made `daemon restart` reconfigure `RATEL_FEATURE_CLOUD_CATALOG` the same way,
  independently of Cloud telemetry, and confirm the result through
  `cloudCatalog` on `/api/daemon/status`.

### Removed
- Removed the deprecated `search_tools` alias from MCP discovery and call dispatch. Agents now have a single capability-search entry point: `search_capabilities`.

### Fixed
- Removed duplicate upstream metadata from capability search responses: Ratel keeps `server.description` and omits `server.instructions` only when their strings are exactly equal; distinct metadata remains unchanged.
- Held a rejected Cloud catalog API key for 60 seconds after HTTP 401 or 403,
  so a revoked key is not retried on every context resolve.

## [0.8.2] - 2026-08-19

### Fixed
- Made `mcp list` resolve the scoped OAuth credential key and resource fingerprint used by the gateway, so authenticated HTTP/SSE servers are no longer reported as unauthenticated.
- Made the connector keep initial catalog requests pending until the daemon handshake succeeds or actually fails, instead of switching to the bootstrap-only surface after a hardcoded timeout.

## [0.8.1] - 2026-08-19

### Fixed
- Made connector recovery probe daemon health before taking lifecycle action, attach to an already-running daemon without restarting it, and return the recovery tool result before asking hosts to refresh their tool catalog.
- Made `daemon start` idempotent on macOS and Linux so a healthy daemon and its active MCP sessions are preserved; explicit `daemon restart` retains restart semantics.
- Added bounded automatic connector reattachment behind the off-by-default `RATEL_FEATURE_CONNECTOR_RECOVERY=1` rollout flag.
- Made `ratel-local connect --help` print connector usage instead of starting a live MCP bridge.
- Expanded bootstrap-mode guidance to distinguish a missing or stopped daemon from a temporarily detached connector.

## [0.8.0] - 2026-08-14

### Added
- Added one persistent per-user daemon with a lightweight project-scoped `connect` bridge, canonical project registration, isolated user/project/local configuration, reusable generation-safe gateways, loopback authentication, and live client and gateway status in the UI.
- Added the idempotent `ratel-local setup` wizard for daemon installation, version replacement, plugin-first Claude Code and Codex linking, and separately previewed MCP/skill import. Scoped control-plane mutations are revision checked, recoverable, and backed up where restoration is supported.
- Added a daemon-owned OTLP log relay for native Claude Code and Codex events, deriving the Cloud `/logs` endpoint from the saved trace endpoint and preserving protobuf payloads unchanged. Host-aware levels now offer Claude Redacted, Tool details, and Full content, and Codex Redacted traces, Tool activity, and Prompt content. Existing `traces enable` and setup automation remain on the safest Redacted level; every content-bearing CLI and Agent Setup change requires explicit privacy confirmation.
- Added the off-by-default `RATEL_FEATURE_CLOUD_TELEMETRY=1` daemon feature flag. It gates Cloud credential loading, loopback relay routes, Ratel runtime export, native exporter mutations, setup prompts, and UI controls together, and is persisted explicitly into installed launchd/systemd services.
- Added daemon-owned Ratel Cloud trace export: native Claude Code, Codex, and daemon-hosted Ratel SDK OTLP/HTTP protobuf traces use the same bounded loopback relay without merging, correlating, decoding, or rewriting payloads. The Settings page persists the Cloud endpoint and API key for foreground and background daemons; the relay is available only behind the feature flag and returns `503` until configured.
- Added opt-in native trace exporter setup for Claude Code and Codex through Agent Setup, `ratel-local traces`, and the final optional setup step. The daemon derives the live loopback endpoint, applies atomic secret-free user-config mutations, repairs stale ports, and requires explicit irreversible conflict overwrite. Interactive CLI and Agent Setup flows can collect a missing Ratel Cloud API key through masked input and save it directly to the daemon; non-interactive runs remain secret-free.
- Added opt-in `semantic` and `hybrid` retrieval with scoped, atomic configuration; validated local, Hugging Face, Ollama, and OpenAI-compatible embedding sources; fail-closed dense startup; and generation-safe OAuth reconnect behavior. BM25 remains the model-free default.
- Added `ratel-local retrieval status|configure|reset|prepare` and Settings-page retrieval controls, with transactional scoped writes, model/source preflight, explicit cache, memory, multilingual, privacy, trace, and reconnect guidance, and packed-package smoke CI for five native targets.

### Changed
- Renamed the Retrieval page to Settings and grouped Ratel Cloud and retrieval configuration there.
- The bundled plugin now runs `ratel-local connect` against the persistent daemon. After upgrading from the stable 0.5 line, run `ratel-local setup` once to install or replace the service and reconcile selected agent plugins; existing Ratel configuration remains in place.
- Simplified retrieval settings to one save flow with human-readable labels and copy. Cached dense models verify behind Save, while missing models require explicit download confirmation before settings are committed.
- Upgraded and exactly pinned `@ratel-ai/sdk` to 0.9.1, moved runtime telemetry initialization out of the SDK onto the explicitly retained legacy OTLP initializer, and pinned that initializer's compatible telemetry vocabulary so npm cannot hoist a breaking patch. The published package now requires Node.js 20.6 or newer. Direct SDK consumers must await `ToolCatalog.register()` and `SkillCatalog.register()`; Ratel Local awaits every registration and batches gateway skills in one call.
- Stable plugin installation follows the repository's default `main` branch. Immutable tag pinning and marketplace reconciliation remain isolated to explicitly versioned prerelease packages.

### Fixed
- Kept connector discovery and invocation on the live daemon catalog while the initial daemon attachment is still in flight, and handled stale bootstrap calls locally instead of forwarding them as unknown gateway tools.
- Resolved passive tool-usage hook paths from either the Codex or Claude Code plugin-root environment so both hosts can run the shared hooks.
- Forced every managed Claude telemetry level, including Redacted, to disable raw API body capture; file-backed raw capture is reported as custom sensitive content instead of Redacted.
- Made malformed Cloud settings and Ratel telemetry-provider initialization fail open so the Local daemon and MCP gateway remain available.
- Prevented clean global installs from resolving incompatible SDK or legacy telemetry patch releases and crashing before the CLI could start; packed-package validation now enforces the reviewed compatibility pins.
- Made setup reuse a stable locally installed CLI for its login service instead of fetching an unpublished version through `npx`; setup and agent onboarding now use welcoming progress and simpler import guidance, and uninstall clears stale runtime state instead of reporting an old PID or version.
- Added real byte and percentage progress for Hugging Face retrieval-model downloads in Settings, plus friendly loading states for direct daemon lifecycle commands, CLI retrieval preparation, and agent linking.
- Hid Ratel Cloud settings and native telemetry-export controls unless the daemon is running with the Cloud telemetry feature flag enabled.
- Fixed OAuth dynamic registration for strict native-app providers: Ratel now registers the callback port it actually opened, declares a native client, and safely replaces stale registrations created with a different callback (including the old `:0` placeholder).

## [0.6.0-rc.1] - 2026-07-31

### Changed
- Replaced the legacy symlink-based skill manager with scoped reference/copy registrations. Global native imports automatically mark the host skill manual-only, while project/local registrations never edit repository-owned skill metadata.
- The daemon safely migrates verified legacy skill links to user-scoped references on startup; `ratel-local doctor --fix` provides the same recoverable migration explicitly. Ambiguous or externally changed entries are left untouched with diagnostics.
- Removed the deprecated `skill activate` and `skill deactivate` compatibility commands.

### Fixed
- Preserved the setup-time PATH separately in macOS launchd and Linux systemd daemon services so npm/npx cannot reorder agent plugin executables ahead of the user's working installation. Agent command startup failures now report the command and PATH source used.
- Skill imports can now keep the first deterministic harness copy when Claude Code and Codex expose the same skill ID, report later copies as skipped duplicates, and skip existing user registrations so repeated imports are no-ops.

## [0.6.0-rc.0] - 2026-07-24

### Added
- Added a versioned canonical-root project registry, project-aware HTTP/CLI/UI flows, URL-scoped daemon pages, connector v2 metadata, and an active-client read model.
- Added a single provenance-preserving MCP/skill snapshot resolver, scoped OAuth stores, deterministic runtime revisions, and generational gateways that keep existing sessions on their acquired revision.
- Added recoverable scoped mutations with cross-process locking, CAS previews, journals, rollback/recovery, opaque skill discovery candidates, owned-copy markers, and safe local Git excludes.
- Added `ratel-local doctor` for transaction recovery plus project, snapshot, and legacy OAuth diagnostics with stable actionable codes.
- Added `ratel-local connect`, a lightweight stdio MCP bridge that carries the agent's resolved project root to the persistent daemon and exposes actionable daemon status/start/setup tools while the daemon is unavailable.
- Added the idempotent `ratel-local setup` wizard, which installs a missing daemon login service, starts an installed service, replaces an incompatible daemon version, or reports an already-running matching daemon. It supports `--yes` automation and a custom first-install `--port`.
- Expanded `ratel-local setup` into complete onboarding: after making the daemon ready it detects Claude Code and Codex, connects selected agents through the existing plugin-first link flow, and separately offers the transactional MCP/skill import preview. Repeatable `--agent`, `--agent auto`, and `--daemon-only` support explicit automation; plain `--yes` remains daemon-only and never imports native configuration.

### Changed
- Prerelease `link` and setup flows now pin the single Ratel marketplace to the immutable tag matching the package version for both Codex and Claude Code, reconcile existing plugin installs onto that channel, and attempt to restore the stable plugin when an RC switch fails.
- New agent links use `ratel-local connect`; `serve --config` remains as the legacy explicit-config runtime.
- Skills now support explicit user/project/local reference or copy registrations. `skill activate` and `skill deactivate` remain deprecated user-scope compatibility wrappers.
- The daemon reconciles disk state on every gateway acquire and uses targeted parent/resource watchers for near-immediate invalidation.
- CLI and UI agent imports apply Ratel and native-agent config rewrites as one recoverable transaction.
- Rebuilt the browser UI around the persistent daemon with global and project-scoped routes, dedicated project and MCP-client views, and a cloud-aligned visual system across tools, skills, and agent setup.

### Fixed
- Hardened the daemon and UI control plane with loopback-only authenticated requests, validated installed-service identity, safe canonical project admission, and serialized project-root mutations.
- Routed OAuth through live daemon gateways, preserving results across bulk authentication while keeping scoped stores isolated.
- Restored the legacy skill lifecycle aliases and tightened automated setup argument validation so existing workflows fail clearly instead of being silently misinterpreted.

## [0.5.0] - 2026-07-24

### Changed
- Made the Ratel Local plugin the preferred link path in both CLI and UI flows so Codex and Claude Code receive the bundled agent skills; when plugin installation fails, linking reports the failure and applies the reviewed, backed-up explicit MCP gateway fallback.
- Made Claude Code and Codex linking plugin-aware: enabled `ratel-local` plugins now count as host-level Ratel connections in CLI/UI import and link flows, avoiding a second explicit gateway; linking re-enables a disabled Codex plugin MCP server; explicit-plus-plugin duplicates are detected without silently deleting user configuration.
- Strengthened the MCP server instructions so agents search Ratel capabilities before answering substantive requests or concluding that a workflow is unavailable, while exempting casual conversation and pure writing or reasoning.
- Renamed Ratel MCP to Ratel Local: the repository moved from `ratel-ai/ratel-mcp` to `ratel-ai/ratel-local`, the npm package changed from `@ratel-ai/mcp-server` to `@ratel-ai/ratel-local`, and the CLI changed from `ratel-mcp` to `ratel-local`. This is a breaking package/CLI rename: reinstall the new package and rename `$RATEL_MCP_BIN` to `$RATEL_LOCAL_BIN`. Existing agent gateway entries named `ratel-mcp` remain recognized during import/link migration, while rewritten entries use `ratel-local`.

### Fixed
- Added Agent Setup actions to fix duplicate plugin-plus-MCP installations and promote MCP-only installations to the plugin for both Claude Code and Codex. Plugin promotion removes the explicit fallback only after installation succeeds, and cleanup preserves unrelated MCP entries.

## [0.4.0] - 2026-06-30

### Changed
- **`ratel-mcp mcp link` and `ratel-mcp mcp import` now install the Claude Code statusline automatically** once they finish wiring up Claude Code, instead of requiring a separate `ratel-mcp statusline install` step. A pre-existing non-Ratel statusline is left untouched (reported as a note, not an error).

## [0.3.1] - 2026-06-18

### Changed
- **Skills page (`ratel-mcp ui`) now emphasizes only Ratel-managed skills.** When no skills are managed it shows an empty state with an "Import skills" action instead of listing Claude Code / Codex skills inline. External skills are brought in through a dedicated, paginated import dialog, each row badged by source. The bulk "Manage all" button is replaced by "Import skills"; "Unmanage all", per-skill "Stop managing", and the "New skill" form are unchanged.

### Added
- **Skill import in Agent Setup (`ratel-mcp ui`).** Each agent gets a per-agent "Import skills" flow alongside the existing MCP import/link, plus an "N skills not managed by Ratel" hint on its card and detail page, mirroring the native-tools hint.

## [0.3.0] - 2026-06-17

### Added
- **Skills, served through the gateway.** When a skill catalog is configured, `createMcpServer` / `buildGatewayFromConfig` expose `get_skill_content` alongside `search_capabilities` + `invoke_tool`, and `search_capabilities` returns a `skills` bucket beside `tools`.
- `ratel-mcp skill` CLI: `activate` / `deactivate` move skills between an agent's folder and the Ratel-managed `~/.ratel/skills` so the gateway serves them; `list` shows managed skills; `suggest` ranks skills for a prompt.
- Prompt-aware preload hook: `skill preload-hook` is a Claude Code `UserPromptSubmit` entrypoint that ranks skills against the prompt (lexical match, project-stack tie-break, clear-winner gate) and nudges the agent toward the best skill; `skill install-hook` / `uninstall-hook` register it in `settings.json` (`--scope user|project`).
- **Skills from Claude Code and Codex.** Skills are sourced from both `~/.claude/skills` and `~/.codex/skills`. The manifest records which agent each managed skill came from, so unmanaging one returns it to that agent's folder (Claude → Claude, Codex → Codex). A name present in both agents is listed once per agent and is independently manageable.
- **Skills in the browser UI (`ratel-mcp ui`).** The Skills page groups skills into "Managed by Ratel" (served through the gateway) and "Not managed" (available in Claude Code / Codex), each row badged with its source (Claude / Codex / Ratel). Per-skill "Manage with Ratel" / "Stop managing" plus bulk actions and a "New skill" form. Each skill has a full detail page that renders its instructions as Markdown in read mode and edits the raw `description` / `tags` / instructions in place (managed skills only); the page shows the skill's origin agent. Backed by `GET /api/skills`, `GET` / `PATCH /api/skills/{id}`, `POST /api/skills` (create) and `POST /api/skills/{activate,deactivate}`.
- `ratel-mcp ui` subcommand — a loopback-only browser UI mirroring the CLI, protected by a per-session bearer token. It can view, add, edit, remove, and OAuth-authorize MCP servers across all three scopes; inspect backups; and run agent setup flows. Flags: `--port N`, `--no-open`.
- Agent setup support for both Claude Code and Codex, including host detection, per-agent status, import/link previews, and apply endpoints for the UI.
- Codex MCP config support via `~/.codex/config.toml` and project `.codex/config.toml`.
- `ratel-mcp mcp import` and `ratel-mcp mcp link` now accept `--agent auto|claude-code|codex` so CLI users can target a specific supported agent instead of relying on automatic detection.
- UI assets and navigation for agent links, including Claude Code and Codex branding.

### Changed
- Consume `@ratel-ai/sdk@^0.2.0`: the new discovery tool is `search_capabilities` (returns a `tools` and a `skills` bucket), and the skill model folds author `triggers` into the indexed `tags` and `stacks` into non-indexed `metadata` (ratel ADR-0012).
- Reworked agent import/link internals around supported agent host adapters instead of Claude-only handling.
- Made CLI and README import/link language agent-neutral where the flow now supports multiple agents.
- Backup handling now uses the newer manifest/listing model across CLI and UI routes.
- UI routes now expose preview/apply workflows for importing agent MCP servers into Ratel and linking agents back to the Ratel gateway.

### Removed
- Removed the old backup undo command.

### Fixed
- A skill's `SKILL.md` is rewritten in place on edit: frontmatter keys Ratel doesn't manage (`allowed-tools`, `model`, custom keys, comments) are preserved, the write is atomic, and `description` / `tags` containing quotes or backslashes round-trip without accumulating escape characters (the loader now decodes escaped scalars).
- Agent rewrites consistently install the `ratel-mcp` gateway command.

### Backward compatibility
- The gateway still advertises the deprecated `search_tools` (its pre-0.2.0 tools-only `{ groups }` result) alongside `search_capabilities`, so MCP clients that reference `search_tools` by name keep working unchanged. Its description flags it as deprecated; prefer `search_capabilities`.

## [0.2.0] - 2026-05-12

### Added
- `ratel-mcp` CLI bin shipped alongside the library. Subcommands: `serve`, `mcp add` / `remove` / `list` / `get` / `edit` / `import` / `link` / `auth`, `backup list`. Run via `npx @ratel-ai/mcp-server <verb>` or a global `pnpm add -g`.
- Source split: `src/lib/` (library) + `src/cli/` (CLI) + `src/index.ts` (library entrypoint) + `src/bin.ts` (CLI entrypoint).

### Changed
- Package now hosted in [`ratel-ai/ratel-mcp`](https://github.com/ratel-ai/ratel-local); previously shipped from the `ratel-ai/ratel` monorepo as one of several workspace packages. Library API surface is unchanged.
- The Claude Code rewrite (`mcp import` / `link`) plants `command: "ratel-mcp"` (was `"ratel"` when this lived inside `@ratel-ai/cli`).
- Bin-locator env var renamed `$RATEL_BIN` → `$RATEL_MCP_BIN`.

### Note
- Extracted from [`ratel-ai/ratel@v0.1.5`](https://github.com/ratel-ai/ratel/tree/v0.1.5). `@ratel-ai/cli` in the source repo still depends on `@ratel-ai/mcp-server@^0.1.5` (library-only, pre-CLI) until its own follow-up refactor lands.
