[中文](./README.zh.md)

# pi-model-filter

A pi extension that rebuilds a provider's model list at session start from a declared remote catalog, and lets you drop individual models by exact id.

## Install

Install from npm (recommended):

```bash
pi install npm:pi-model-filter
```

Alternatively, install straight from the repository:

```bash
pi install git:github.com/ZouZhao321/pi-model-filter
```

During local development, install the checkout by its path instead, e.g. for a clone directory named `model-filter`:

```bash
pi install ./model-filter
```

## What it does

The package declares a single extension entry (`./src/index.ts`) in its `pi` manifest. The extension registers no tools or commands; it works through the provider registry and two session events.

- On `session_start`, reads the provider declarations from `providers.json`. For every declared provider it first registers the model list composed from the last catalog cache (when one exists), then refreshes that list in the background.
- The refresh fetches the provider's model catalog over HTTP, merges it with model metadata (cost, reasoning levels, context window), removes the excluded ids, applies the extras overlay, and re-registers the provider.
- Re-registration uses `registerProvider` with `models`, which replaces the provider's whole model list. That is what makes removal possible at all: `models.json` only upserts entries and cannot delete a built-in model.
- Requests use a 10 s timeout and at most 3 attempts, with no delay in between, retrying HTTP 408, 425, 429, 500, 502, 503 and 504 plus transport errors.
- Setting `PI_OFFLINE` skips all requests; the extension then keeps serving the previously cached list.
- A failed refresh keeps the list that is already registered and appends one JSON line to the request log.
- On `session_shutdown` the session is marked as ended. Responses that arrive after that point still update the cache and the log, but no longer call the registration API.
- Only models whose catalog entry lists `/chat/completions` in `endpoints` are kept (providers that declare `endpoints`). Metadata comes either from a markdown table in an npm package or from pi's own provider model list, whichever the declaration names.

## Configuration

All files live in the plugin data directory `~/.pi/agent/model-filter/`.

### `providers.json`

Maps a provider id to its declaration. A provider declares either a full source or a reference to another provider's source.

| Key          | Meaning                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `source`     | Reference to another entry in the file. A referencing entry may only add `name`.                                           |
| `name`       | Display name registered with the provider.                                                                                 |
| `baseUrl`    | Optional base URL; also the value substituted for `{baseUrl}` in the catalog URL.                                          |
| `api`        | pi API id used for every model of this provider (e.g. `openai-completions`).                                               |
| `compat`     | Optional pass-through of pi's `compat` object.                                                                             |
| `catalog`    | Where the model list comes from and how to parse it.                                                                       |
| `metadata`   | Optional source of model metadata (`pi-model-list`, or `npm-package-doc` with `package`, `file`, `versionUrl`, `fileUrl`). |
| `extras`     | File name (inside the data directory) of the extras overlay.                                                               |
| `exclusions` | File name (inside the data directory) of the exclusion list.                                                               |

`catalog` takes `kind` (`http-model-list`), `url`, optional `requestHeaders` (a string, or `{ "generator": "uuid" }` for a per-request random value), optional `authHeader` (`bearer` sends the provider's own API key), `envelope` (`openai-data-array`), and `fields`, which maps pi's field names (`id`, `name`, `contextWindow`, `endpoints`) to the field names in the response.

`metadata.kind` is either `pi-model-list` (reuse the list pi itself fetched) or `npm-package-doc`, which reads a markdown table from an npm package and needs `format` (`markdown-table`), `columns` (column indexes for `id`, `name`, `contextWindow`, `thinkingLevel`, `cost`) and `valueParsers` (`contextWindow`: `size-suffix`, `thinkingLevel`: `comma-list`, `cost`: `price-slash-cache`).

The optional `compat` object and every `metadata` value are passed through to pi unchanged.

### Exclusion list

`provider id -> [model id, ...]`, matched against the full id (no wildcards). The default file is `model-exclude.json`:

```json
{
  "opencode-go": ["glm-5.3", "kimi-k3"]
}
```

### Extras overlay

`provider id -> model id -> extra model fields`, in `model-extras.json` by default. `maxTokens` and `input` only fill in when neither the metadata nor the defaults provide them; every other key overrides whatever the composition produced, which is the manual fix-up path for bad upstream data.

```json
{
  "some-provider": {
    "some-model": { "maxTokens": 32768, "input": ["text", "image"] }
  }
}
```

### Defaults and other files

- `maxTokens` defaults to `16384`, `input` to `["text"]`, `contextWindow` to `0`, and cost to zeros.
- `reasoning` is `true` whenever the metadata lists at least one thinking level.
- `catalog-<provider>.json` and `metadata-<provider>.json` hold the last successful responses; they are what a session starts from before the background refresh lands.
- `requests.log` receives one JSON object per line (`at`, `provider`, `url`, `outcome`, `durationMs`, and on failure `attempts`, `status`, `error`; on success also `attempts`, `idCount`, `registered`, `pendingExtras`).
- `PI_OFFLINE` — set this environment variable to stop the extension from making any request.

## Development

```bash
npm ci
npm run lint          # eslint
npm run lint:fix      # eslint --fix
npm run format        # prettier --write .
npm run format:check  # prettier --check .
npm run typecheck     # tsc --noEmit
npm run test          # vitest run
```

`npm ci` also runs `prepare`, which installs the Husky `pre-commit` hook (lint-staged, then `typecheck` and `test`).

## License

MIT
