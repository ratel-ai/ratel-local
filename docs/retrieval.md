# Retrieval configuration

Ratel Local uses model-free BM25 retrieval unless a user, project, or local scope explicitly
selects `semantic` or `hybrid`. The retrieval block is atomic: the rightmost scope that defines
`retrieval` replaces the complete earlier block rather than merging individual fields.

## Inspect and change retrieval

```bash
# Show user/project/local overrides and the effective value.
ratel-local retrieval status

# Keep the user scope model-free.
ratel-local retrieval configure --scope user --method bm25

# Use the pinned built-in model for one project.
ratel-local retrieval configure \
  --scope project \
  --method hybrid \
  --source built-in

# Remove the project override and inherit the user scope again.
ratel-local retrieval reset --scope project
```

`configure` and `reset` use the same revision checks, transaction journal, backup, and local
Git-exclude safeguards as the rest of Ratel Local's scoped control plane.

After a dense retrieval or OAuth change, reconnect the affected agent/context so it acquires a new
gateway generation. Existing leases drain on their old immutable generation. Restart the whole
daemon only when reconnecting the client is unavailable.

## Embedding sources

### Built-in

Omitting `embedding`, or selecting `--source built-in`, uses the SDK 0.5.2 pinned
`BAAI/bge-small-en-v1.5` model.

```json
{
  "retrieval": {
    "method": "semantic"
  }
}
```

The built-in model downloads into the Hugging Face cache when first prepared and adds roughly
130 MB of resident process memory while loaded. It is shared by the tool and skill catalogs. It is
English-focused; choose an appropriate multilingual Hugging Face model when non-English recall is
important.

### Hugging Face

```bash
ratel-local retrieval configure \
  --scope project \
  --method hybrid \
  --source huggingface \
  --model intfloat/multilingual-e5-small \
  --revision main \
  --download
```

`--download` controls whether dense startup may fetch a missing explicit Hugging Face model.
`retrieval prepare` always opts the preflight into downloading a missing Hugging Face model without
changing the persisted startup policy.

### Local model directory

```bash
ratel-local retrieval configure \
  --scope local \
  --method semantic \
  --source local \
  --model ~/.cache/models/bge-small
```

Local paths must be absolute or start with `~/`. Model metadata and retrieval queries stay on the
machine.

### Ollama

```bash
ratel-local retrieval configure \
  --scope project \
  --method semantic \
  --source ollama \
  --model nomic-embed-text
```

Ollama runs outside the Ratel Local process. Preflight sends a representative embedding request to
confirm that the configured local service and model are available.

### OpenAI-compatible endpoint

```bash
export EMBEDDING_API_KEY=...

ratel-local retrieval configure \
  --scope project \
  --method hybrid \
  --source endpoint \
  --url https://api.example.com/v1/embeddings \
  --model text-embedding-3-small \
  --api-key-env EMBEDDING_API_KEY
```

Literal API keys are rejected. `apiKeyEnv` names an environment variable that the daemon must
receive. Tool and skill metadata are sent to the endpoint while indexing, and retrieval queries are
sent during search. Choose an endpoint only when that transfer matches the data policy for the
selected scope.

## Preflight

```bash
# Prepare the effective merged configuration.
ratel-local retrieval prepare

# Prepare/check only the project override.
ratel-local retrieval prepare --scope project
```

Preflight does not start the gateway:

- BM25 returns immediately without a model or network request.
- Built-in and Hugging Face sources download when missing, load, and embed a representative tool.
- Local sources load and embed a representative tool.
- Ollama and endpoint sources send one representative embedding request.
- Endpoint preflight fails before the request when its `apiKeyEnv` is absent.

The browser UI exposes the same source choices and preflight action under **Retrieval**.

## Storage and lifecycle

- Hugging Face models use the normal Hugging Face cache.
- In-process built-in, Hugging Face, and local models use roughly 130 MB while loaded; actual
  consumption varies with the selected model.
- Tool and skill vectors remain in memory and rebuild for each new scoped gateway generation,
  including process startup or a retrieval revision.
- Local retrieval traces remain under `~/.ratel/telemetry`.
- BM25 is always the zero-download, zero-embedding-request path.
