# Ratel Local UI

Local UI development uses the real `ratel-local ui` API server and Vite for the React app.

From the workspace root:

```bash
pnpm dev:ui
```

That command:

- asks the daemon for a UI session with `ratel-local ui --no-open`;
- starts Vite on `127.0.0.1`;
- wires Vite's `/api` proxy through `RATEL_LOCAL_API_TARGET`;
- prints and opens the Vite URL with the API session token already attached.

Start the daemon with `ratel-local setup` if it is not running.

Optional port overrides:

```bash
RATEL_LOCAL_UI_API_PORT=5731 RATEL_LOCAL_UI_VITE_PORT=5173 pnpm dev:ui
```

Use the printed `Vite UI` URL. It has the `?t=...` token that the app sends as the
`Authorization: Bearer ...` header for API requests.
