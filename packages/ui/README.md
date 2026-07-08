# Ratel Local UI

Local UI development uses the real `ratel-mcp ui` API server and Vite for the React app.

From the workspace root:

```bash
pnpm dev:ui
```

That command:

- starts `ratel-mcp ui --no-open` on `127.0.0.1`;
- starts Vite on `127.0.0.1`;
- chooses alternate free ports when the defaults are busy;
- wires Vite's `/api` proxy through `RATEL_MCP_API_TARGET`;
- prints the Vite URL with the API session token already attached.

Optional port overrides:

```bash
RATEL_MCP_UI_API_PORT=5731 RATEL_MCP_UI_VITE_PORT=5173 pnpm dev:ui
```

Use the printed `Vite UI` URL. It has the `?t=...` token that the app sends as the
`Authorization: Bearer ...` header for API requests.
