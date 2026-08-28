# 21. Cloud project identity and credential ownership

Date: 2026-08-25

## Status

Accepted

## Context

ADR 0013 gave the Cloud credential one consumer, the OTLP relay, and ADR 0018
gated every Cloud surface on `RATEL_FEATURE_CLOUD_TELEMETRY`.

There is now a second consumer: the `protocol/v1` catalog loader pulls a
project's published skills from `GET /v1/catalog` with the same Bearer
credential. It cannot reach one, because the credential loads only inside the
telemetry branch — a product feature would depend on an observability flag.

The credential is also the project selection: `api_keys.project_id` is NOT NULL
with a foreign key to `projects.id`, and no request carries a project parameter.
A daemon serving several local projects therefore needs several keys. That is a
present requirement, not a projection — the first operator runs two Cloud
projects.

`apiKeyEnv` cannot serve this: it resolves against the daemon's `process.env`,
and the daemon is one login-scoped process whose environment its service
definition fixes. Nothing can put a per-project variable there, and anything put
there is readable by every project it serves.

## Decision

- **One credential, several consumers.** Load it whenever any Cloud consumer is
  enabled, never inside the telemetry branch. Each consumer keeps its own gate;
  neither implies the other.

- **Secrets live only under `~/.ratel/`,** in `~/.ratel/cloud.json` at `0600`
  inside a `0700` directory. Layered configuration is committable, so a guard
  rejects `cloud.apiKey` there, as one already refuses `apiKey` on embedding
  sources. `cloud.profile` is a name and stays allowed.

- **Credentials are named profiles, not paths.** AWS profiles, `kubectl`
  contexts and `vercel link` all key on a name. Keying on a path makes a moved
  directory a wrong binding, forces a definition of _project_ that survives
  monorepo packages and git worktrees, and cannot be shared with a team.

- **A project selects a profile by name** under `cloud.profile`, and
  `RATEL_PROFILE` overrides it as `AWS_PROFILE` does. ADR 0013's environment
  pair stays above both: it supplies a credential outright rather than selecting
  a stored one, and is never written to disk.

- **An unknown profile name is an error** that names the profile and the file
  which asked for it — never a silent fall back to `default`. Serving one
  project from another project's Cloud account while reporting success is the
  failure this design exists to prevent, so `doctor` also reports it from the
  files alone, before anything reaches Cloud.

- **The deployment belongs to the store, the paths to the protocol.** `baseUrl`
  names the deployment; the signal paths are constants. A signal that must sit
  elsewhere takes its own full endpoint, and `doctor` warns when the three stop
  sharing an origin: forgetting one while moving deployment looks identical to
  aiming one somewhere on purpose.

- **ADR 0013's rules stand**, now protecting two consumers: the key is consumed
  into memory at startup, `RATEL_API_KEY` is deleted from the daemon environment
  before any subprocess can inherit it, and it never reaches layered config,
  daemon state, logs, or HTTP responses. Saving a key reconfigures every enabled
  consumer in place, without a restart.

## Shape

Two files, two jobs. Only the selection has scopes, because a project-scope copy
of the store would sit inside a repository.

| file                            | holds                   | scopes                                   |
| ------------------------------- | ----------------------- | ---------------------------------------- |
| `~/.ratel/cloud.json`           | the secrets             | **none** — user level only, one location |
| `config.json` → `cloud.profile` | a name that selects one | `user`, `project`, `local`               |

```jsonc
// ~/.ratel/cloud.json — secrets, user-level, 0600. Never inside a repository.
{
  // All optional. Without them every signal sits on https://cloud.ratel.sh.
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

Resolution:

| selector                                                           | resolves to                              |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `RATEL_API_KEY` (with `RATEL_CLOUD_OTLP_TRACES_ENDPOINT`)          | those values, no profile involved        |
| `RATEL_PROFILE=acme`                                               | `profiles.acme`                          |
| `cloud.profile`, nearest scope wins (`local` > `project` > `user`) | that profile                             |
| nothing selects a profile                                          | `profiles[default]`                      |
| selected name is undefined                                         | error, naming the profile and its source |

`cloud.profile` reaches the catalog only. The relay receives opaque bytes from an
exporter configured once per user. Codex ignores `otel` in project-scoped config, so telemetry resolves per daemon, from the environment or the store default.

Two commands report the binding, because each surface can only name what it
knows. The daemon deletes `RATEL_API_KEY` from its own environment and an
installed service has none a CLI run can read, so only the daemon can name the
credential its relay holds; `cloud.profile` is a local file the CLI reads
directly.

```text
$ ratel-local traces status
Cloud relay: configured
Cloud credential: profile "personal" (store default)

$ ratel-local cloud list
acme      (cloud.profile)
personal  (default)
Cloud skills here: "acme" (cloud.profile in ./.ratel/config.json)
```

## Configuration surface

Storing a credential and selecting one touch different files, so they get
different verbs. `cloud add` is the only path that handles a secret, so it takes
no `--scope` and fails without a terminal rather than report success having
stored nothing. `cloud use` writes only a name, follows the ordinary scope rules,
and refuses a name no profile defines, so a broken selection fails when it is
made rather than at the next daemon start.

```bash
ratel-local cloud add acme                   # ~/.ratel/cloud.json, no --scope

ratel-local cloud use acme --scope project   # <project root>/.ratel/config.json, committed
ratel-local cloud use acme --scope local     # <project root>/.ratel/config.local.json, this machine
ratel-local cloud use personal --scope user  # ~/.ratel/config.json, everything else

ratel-local cloud list                       # profiles, the default, what resolves here
```

`traces enable` points at `cloud add` instead of prompting for a key inline. Its
prompt fired on a single global boolean, so once any credential existed a second
could never be entered through it — the ceiling this ADR exists to lift.

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
- ADR 0018's clause that the flag gates credential loading no longer holds. The
  rest of ADR 0018 stands.
- ADR 0020's restart reconfiguration was written against a single flag entry and
  now rewrites any named flag, since a second one has to reach installed
  services.
- This ADR states a policy the codebase does not yet keep: `mcpServers` still
  holds `clientSecret` and literal `env` values in committable files. Extending
  `expandEnvPlaceholders` to them does not work, because placeholders resolve
  against an environment an installed service cannot populate — the same
  limitation that closes `apiKeyEnv` above. Upstream MCP secrets need the same
  user-level store referenced by name, which is a second ADR.
- Two standards are knowingly unmet, both about acquisition and storage rather
  than the model above: a pasted key is behind the device authorization grant
  (RFC 8628), and a plaintext key at `0600` is behind the OS keychain. The v1
  wire contract is frozen on `Bearer <key>` with `sha256(key)` lookup, so any
  acquisition flow must **mint** keys rather than replace them — at which point
  the loader's `401 → hard failure` becomes `401 → refresh, retry once, fail`.
