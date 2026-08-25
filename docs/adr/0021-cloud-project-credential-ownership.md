# 21. Cloud project identity and credential ownership

Date: 2026-08-25

## Status

Accepted

## Context

ADR 0013 gave the Cloud credential one consumer, the OTLP relay. ADR 0018 gated
it, along with every other Cloud surface, on `RATEL_FEATURE_CLOUD_TELEMETRY`.

There is now a second consumer: the `protocol/v1` catalog loader pulls a
project's published skills from `GET /v1/catalog` with the same Bearer
credential. It cannot reach one — the credential loads only inside
`if (featureFlags.cloudTelemetry)` (`daemon.ts:362-365`), so a product feature
would depend on an observability flag.

The credential is also the project selection: `api_keys.project_id` is NOT NULL
with a foreign key to `projects.id`, and no request carries a project parameter.
A daemon serving several local projects therefore needs several keys. That is a
present requirement, not a projection — the first operator runs two Cloud
projects.

`apiKeyEnv` cannot serve this. It resolves against the daemon's `process.env`
(`retrieval-preflight.ts:143,147`), and the daemon is one login-scoped process
whose environment is fixed by its service definition: there is no supported way
to put a per-project variable in it, and anything put there is readable by every
project it serves.

## Decision

- **One credential, several consumers.** Load it whenever any Cloud consumer is
  enabled, never inside the telemetry branch. Each consumer keeps its own gate;
  neither implies the other.

- **Secrets live only under `~/.ratel/`.** The store becomes
  `~/.ratel/cloud.json`, `0600` inside a `0700` directory, reading
  `cloud-traces.json` as a fallback: its flat `{endpoint, apiKey}` becomes the
  root `tracesEndpoint` plus a single profile, which becomes the `default`.
  A new guard rejects `cloud.apiKey` in layered configuration, modelled on the
  one already refusing `apiKey` on embedding sources (`config.ts:139`).
  `cloud.profile` is a name and stays allowed.

- **Credentials are named profiles, not paths.** AWS profiles, `kubectl`
  contexts and `vercel link` all key on a name. Keying on a path makes a moved
  directory a wrong binding, forces a definition of _project_ that survives
  monorepo packages and git worktrees, and cannot be shared with a team.

- **A project selects a profile by name** under `cloud.profile`, and
  `RATEL_PROFILE` overrides it as `AWS_PROFILE` does. The ADR 0013 environment
  pair stays above both: it supplies a credential outright rather than selecting
  a stored one, and remains a single-run override that is never written to disk. A name is not a secret, so
  that file is committable and a team inherits the binding by cloning.

- **An unknown profile name is an error** that names the profile and the file
  which asked for it — never a silent fall back to `default`. Sending one
  project's telemetry to another project's Cloud account while reporting success
  is the failure this design exists to prevent.

- **The endpoint belongs to the deployment, not the profile.** One value at the
  root of the store, defaulting to `DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT`
  (`cloud/settings.ts:6`); logs and catalog derive from it by swapping the
  terminal path segment, as `deriveCloudOtlpLogsEndpoint` already does.

- **ADR 0013's rules stand**, now protecting two consumers: the key is consumed
  into memory at startup, `RATEL_API_KEY` is deleted from the daemon environment
  before any subprocess can inherit it, and it never reaches layered config,
  daemon state, logs, or HTTP responses. Saving a key reconfigures every enabled
  consumer in place, without a restart.

## Shape

Two files, two jobs. Only one of them has scopes:

| file                            | holds                   | scopes                                   |
| ------------------------------- | ----------------------- | ---------------------------------------- |
| `~/.ratel/cloud.json`           | the secrets             | **none** — user level only, one location |
| `config.json` → `cloud.profile` | a name that selects one | `user`, `project`, `local`               |

The store has no scopes because it holds secrets, and a project-scope copy would
sit inside a repository. The selection is layered like every other key, merged
`user → project → local` with the last write winning
(`context-snapshot.ts:260-272`, `config.ts:531-541`).

```jsonc
// ~/.ratel/cloud.json — secrets, user-level, 0600. Never inside a repository.
{
  // Optional; this is the default. Logs and catalog derive from it.
  "tracesEndpoint": "https://cloud.ratel.sh/api/v1/traces",
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

Resolution:

| selector                                                           | resolves to                              |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `RATEL_API_KEY` (with `RATEL_CLOUD_OTLP_TRACES_ENDPOINT`)          | those values, no profile involved        |
| `RATEL_PROFILE=acme`                                               | `profiles.acme`                          |
| `cloud.profile`, nearest scope wins (`local` > `project` > `user`) | that profile                             |
| nothing selects a profile                                          | `profiles[default]`                      |
| selected name is undefined                                         | error, naming the profile and its source |

Which is reported, so a wrong binding is seen rather than inferred:

```text
$ ratel-local traces status
Claude Code  configured   Redacted        ~/.claude/settings.json
Cloud telemetry feature: enabled
Cloud profile: acme (from ./.ratel/config.json)
Cloud relay: configured
```

## Configuration surface

Storing a credential and selecting one touch different files, so they get
different verbs:

```bash
# Store a credential. No --scope: a secret has one legal home.
ratel-local cloud add acme

# Select one. Takes --scope, like every other layered setting.
ratel-local cloud use acme --scope project   # <project root>/.ratel/config.json, committed
ratel-local cloud use acme --scope local     # <project root>/.ratel/config.local.json, this machine
ratel-local cloud use personal --scope user  # ~/.ratel/config.json, everything else

ratel-local cloud list                       # profiles, the default, what resolves here
```

The asymmetry is the design: `cloud add` is the only path that handles a secret
and never writes into a repository, while `cloud use` writes only a name and so
follows the ordinary scope rules. It refuses a name no profile defines, so a
broken selection fails when it is made rather than at the next daemon start.

The inline prompt in `traces enable` stays for first-run onboarding, but its
condition must change. It fires today on `!cloudConfigured` (`traces.ts:173`), a
single global boolean, so once any credential exists a second can never be added
interactively. It must fire when **the profile that resolves here** has no
credential.

## Consequences

- The catalog works with telemetry off, and telemetry with the catalog off.
- Moving a directory no longer changes which credential is used, and "what
  exactly is a project" stops being a question this ADR has to answer: monorepo
  packages, workspace roots and worktrees each declare a profile or inherit one,
  and the declaration travels with the code.
- The selection is committable, so a team shares one binding without sharing a
  secret. This diverges deliberately from `vercel link`, which gitignores its
  project reference; a profile name carries nothing of value, so sharing is the
  point.
- ADR 0018's clause that the flag gates credential loading no longer holds.
  The rest of ADR 0018 stands.
- A second feature flag must reach installed services, and ADR 0020's restart
  reconfiguration is written against a single flag entry. Generalising that
  editor is the point at which moving the service-file editors into their own
  module stops being hygiene and becomes necessary.
- This ADR states a policy — secrets never in layered configuration — that the
  codebase does not yet keep. `mcpServers[].clientSecret` is a first-class field
  for an OAuth client secret in a committable file, and `mcpServers[].env`
  accepts literal values. The obvious repair, extending the existing
  `expandEnvPlaceholders` indirection (already applied to `url` and `headers`,
  `gateway.ts:417,455`) to those two fields, does not work: placeholders resolve
  against the daemon's `process.env`, which an installed service cannot populate
  — the same limitation that closes `apiKeyEnv` above, and one `url` and
  `headers` already carry today. Upstream MCP secrets therefore need what this
  ADR gives Cloud credentials, a user-level store referenced by name, which is a
  second ADR rather than a clause of this one.

- Two standards are knowingly unmet, both about acquisition and storage rather
  than the model above: a key pasted once and never recoverable is behind the
  device authorization grant (RFC 8628) that `gh` has always used and Vercel
  adopted in September 2025, and a plaintext key at `0600` is behind the OS
  keychain. The v1 wire contract is frozen on `Bearer <key>` with `sha256(key)`
  lookup, so any acquisition flow must **mint** keys rather than replace them —
  at which point the loader's `401 → hard failure` becomes `401 → refresh,
retry once, then fail`.
