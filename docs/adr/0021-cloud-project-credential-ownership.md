# 21. Cloud project identity and credential ownership

Date: 2026-08-25

## Status

Accepted

## Context

[ADR 0013](0013-daemon-owned-cloud-otlp-trace-relay.md) gave the Cloud credential
one consumer, the OTLP relay, and
[ADR 0018](0018-daemon-wide-cloud-telemetry-feature-boundary.md) gated every
Cloud surface on `RATEL_FEATURE_CLOUD_TELEMETRY`.

There is now a second consumer: the Cloud skill catalog. Its `protocol/v1`
loader pulls a project's published skills from `GET /api/v1/catalog` with the
same Bearer credential. The catalog cannot load that credential today, because
loading sits behind the telemetry branch — a product feature would depend on
`RATEL_FEATURE_CLOUD_TELEMETRY`. The catalog needs its own gate,
`RATEL_FEATURE_CLOUD_CATALOG`.

On Ratel Cloud's API model, the credential is also the project selection:
`api_keys.project_id` is NOT NULL with a foreign key to `projects.id`, and no
request carries a project parameter. A daemon serving several local projects
therefore needs several keys.

Embedding sources already name a key via `apiKeyEnv` (see
[docs/retrieval.md](../retrieval.md)), but that pattern cannot serve this: it
resolves against the daemon's `process.env`, and the daemon is one login-scoped
process whose environment its service definition fixes. Nothing can put a
per-project variable there, and anything put there is readable by every project
it serves. Layered scopes (`user`, `project`, `local`) are
[ADR 0008](0008-canonical-projects-and-scoped-ownership.md).

## Decision

- **The catalog and the relay keep separate stores.** Named profiles in
  `~/.ratel/cloud.json` serve the catalog and load under
  `RATEL_FEATURE_CLOUD_CATALOG`, never behind `RATEL_FEATURE_CLOUD_TELEMETRY`.
  The relay keeps the single-key store
  [ADR 0015](0015-persisted-cloud-trace-settings.md) gave it,
  `~/.ratel/cloud-traces.json`, under `RATEL_FEATURE_CLOUD_TELEMETRY`. Neither
  gate implies the other.

- **Secrets live only under `~/.ratel/`**, in `cloud.json` and
  `cloud-traces.json`, each `0600` inside a `0700` directory. Layered
  configuration is committable, so a guard rejects `cloud.apiKey` there, as one
  already refuses `apiKey` on embedding sources. `cloud.profile` is a name and
  stays allowed.

- **Credentials are named profiles, not paths.** AWS profiles, `kubectl`
  contexts and `vercel link` all key on a name. Keying on a path breaks when a
  directory moves, forces a definition of _project_ across monorepo packages and
  worktrees, and cannot be shared with a team.

- **A project selects a profile by name** under `cloud.profile`. When nothing
  selects a profile, resolution uses `profiles[default]`. When a selector names
  a profile absent from the store, that is an error that names the profile and
  how it was selected — never a silent fall back to `default`. The catalog
  reports `cloud.profile`; `doctor` reports the config file that asked for it,
  from the files alone, before anything reaches Cloud. Selection comes from the
  files alone: an environment override that only acts when it is in the daemon's
  environment, and that no CLI run can see, produces confident wrong answers,
  which is the failure class that this ADR exists to prevent — serving one
  project from another project's Cloud account while reporting success.

- **`baseUrl` in `cloud.json` chooses the Cloud instance; the catalog path is
  fixed by the protocol.** The catalog sits at `/api/v1/catalog` on that
  origin. A catalog that must sit elsewhere takes `catalogEndpoint`, a full URL.
  The relay ignores both: its endpoint lives in `cloud-traces.json`, and logs
  ride that origin at `/api/v1/logs`.

- **ADR 0013's environment pair and relay rules stand.**
  `RATEL_API_KEY` with `RATEL_CLOUD_OTLP_TRACES_ENDPOINT` supplies a credential
  outright rather than selecting a stored profile, stays above layered config,
  and is never written to disk. `RATEL_API_KEY` is consumed
  into memory at startup and deleted from the daemon environment before any
  subprocess can inherit it; it never reaches daemon state, logs, or HTTP
  responses. The catalog reads `cloud.json` on each pull, so `cloud add` is
  visible without a restart. Saving the relay's key reconfigures the relay in
  place, and does not touch the catalog.

## Shape

Three files. Only the selection has scopes, because a project-scope copy of
either store would sit inside a repository.

| file                            | holds                   | scopes                              |
| ------------------------------- | ----------------------- | ----------------------------------- |
| `~/.ratel/cloud.json`           | catalog secrets         | none, user level only, one location |
| `~/.ratel/cloud-traces.json`    | the relay's one key     | none, user level only, one location |
| `config.json` --> `cloud.profile` | a name that selects one | `user`, `project`, `local`          |

```jsonc
// ~/.ratel/cloud.json — secrets, user-level, 0600. Never inside a repository.
{
  // All optional. Without them the catalog sits on https://cloud.ratel.sh.
  "baseUrl": "https://staging.ratel.sh",
  "catalogEndpoint": "https://scratch.example.test/api/v1/catalog",
  "default": "personal",
  "profiles": {
    "personal": { "apiKey": "rtl_…" },
    "acme": { "apiKey": "rtl_…" },
  },
}
```

```jsonc
// <project root>/.ratel/config.json — a name, not a secret. Safe to commit.
{
  "cloud": { "profile": "acme" },
}
```

Catalog resolution. One exception to separate stores: the environment pair is a
current-run override that bypasses both files and points the catalog at
`/api/v1/catalog` on the traces origin.

| selector                                                           | resolves to                         |
| ------------------------------------------------------------------ | ----------------------------------- |
| `RATEL_API_KEY` (with `RATEL_CLOUD_OTLP_TRACES_ENDPOINT`)          | that key; catalog on the traces origin; no profile |
| `cloud.profile`, nearest scope wins (`local` > `project` > `user`) | that profile                        |
| nothing selects a profile                                          | `profiles[default]`                 |
| a selected name is not in the store                                | error, naming the profile and its source |

The relay resolves `RATEL_API_KEY`, else `~/.ratel/cloud-traces.json`, and
nothing else. It receives opaque bytes from Claude Code or Codex exporters
configured once per user; Codex ignores `otel` in project-scoped config, so no
directory identity reaches the relay. Routing telemetry per directory needs a
carrier neither host provides, and is left to its own change.

`cloud list` reports the catalog binding from the files only: the daemon deletes
`RATEL_API_KEY` from its environment, and an installed service has an environment
no CLI run can read. In the sample below, stored profiles come first; `catalog`
is the endpoint in effect; `Cloud skills here` is this directory's binding.

```text
$ ratel-local cloud list
acme  (cloud.profile)
personal  (default)
catalog https://cloud.ratel.sh/api/v1/catalog         default
Cloud skills here: "acme" (cloud.profile in /repo/.ratel/config.json)
  Traces use their own key; run "ratel-local traces status".
```

## Configuration surface

`cloud add` writes the secret store; `cloud use` writes a name at a scope from
[ADR 0008](0008-canonical-projects-and-scoped-ownership.md).

```bash
ratel-local cloud add acme                   # ~/.ratel/cloud.json, no --scope

ratel-local cloud use acme --scope project   # <project root>/.ratel/config.json, committed
ratel-local cloud use acme --scope local     # <project root>/.ratel/config.local.json, this machine
ratel-local cloud use personal --scope user  # ~/.ratel/config.json, everything else

ratel-local cloud list                       # profiles, the default, what resolves here
```

`traces enable` keeps its own inline prompt: it writes the relay's single key,
not a catalog profile.

## Consequences

- The catalog works under `RATEL_FEATURE_CLOUD_CATALOG` with telemetry off, and
  telemetry under `RATEL_FEATURE_CLOUD_TELEMETRY` with the catalog off.
- One account used for both is entered twice, once per store. That is the price
  of keeping the stores separate. It disappears if the relay later reads
  `cloud.json`.
- Moving a directory no longer changes which credential is used. Monorepo
  packages, workspace roots and worktrees each declare a profile or inherit one,
  and the declaration travels with the code.
- The selection is committable, so a team shares one binding without sharing a
  secret. This diverges from `vercel link`, which gitignores its project
  reference; a profile name carries nothing of value, so sharing is the point.
- [ADR 0018](0018-daemon-wide-cloud-telemetry-feature-boundary.md)'s clause that
  the flag gates credential loading no longer holds for the catalog. The rest of
  ADR 0018 stands.
- [ADR 0020](0020-daemon-restart-feature-flag-reconfiguration.md)'s restart
  reconfiguration now rewrites any named flag, because
  `RATEL_FEATURE_CLOUD_CATALOG` must reach installed services.
- This ADR states a policy the codebase does not yet keep: `mcpServers` still
  holds `clientSecret` and literal `env` values in committable files.
  `expandEnvPlaceholders` cannot fix that — placeholders resolve against an
  environment an installed service cannot populate, the same limitation that
  closes `apiKeyEnv` above. Upstream MCP secrets need the same user-level store
  referenced by name, which is a second ADR.
- Out of scope: device-authorization (RFC 8628) and OS keychain storage remain
  unmet on purpose. The v1 wire contract stays `Bearer <key>`.
