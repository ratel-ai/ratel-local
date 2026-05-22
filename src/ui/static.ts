export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Ratel MCP</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fafafa;
    --panel: #ffffff;
    --text: #111;
    --muted: #666;
    --line: #e6e6e6;
    --accent: #2a5bd7;
    --danger: #c0392b;
    --ok: #2e7d32;
    --warn: #b26a00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e0f12;
      --panel: #16181d;
      --text: #e8e8e8;
      --muted: #9ba1ad;
      --line: #2a2d36;
      --accent: #6892ff;
      --danger: #ff6b5a;
      --ok: #6cc56e;
      --warn: #f0a851;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    display: flex;
    align-items: baseline;
    gap: 16px;
    flex-wrap: wrap;
  }
  header h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  header .meta { color: var(--muted); font-size: 12px; }
  main { padding: 20px 24px; max-width: 1100px; margin: 0 auto; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
  .tab {
    padding: 8px 14px;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .tab:hover:not(.active) { color: var(--text); }
  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .panel h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    padding: 10px 0;
    border-top: 1px solid var(--line);
    align-items: center;
  }
  .row:first-of-type { border-top: none; }
  .row .name { font-weight: 600; }
  .row .summary { color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pill {
    display: inline-block;
    padding: 1px 8px;
    font-size: 11px;
    border-radius: 999px;
    border: 1px solid var(--line);
    margin-left: 6px;
    color: var(--muted);
  }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .pill.danger { color: var(--danger); border-color: var(--danger); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button.action, button.primary, button.danger {
    font: inherit;
    padding: 5px 10px;
    border-radius: 4px;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: white; }
  button.danger { color: var(--danger); border-color: var(--danger); }
  button:hover:not(:disabled) { filter: brightness(1.05); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .toolbar .left, .toolbar .right { display: flex; gap: 6px; align-items: center; }
  .empty { color: var(--muted); font-style: italic; padding: 12px 0; }
  .modal-bg {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 50;
  }
  .modal {
    background: var(--panel);
    border-radius: 8px;
    padding: 20px;
    width: min(560px, 92vw);
    max-height: 88vh;
    overflow: auto;
    border: 1px solid var(--line);
  }
  .modal h3 { margin: 0 0 14px; font-size: 15px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .field input, .field select, .field textarea {
    width: 100%; padding: 6px 8px;
    font: inherit;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
  }
  .field textarea { min-height: 60px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .toast {
    position: fixed; bottom: 16px; right: 16px;
    background: var(--panel); color: var(--text);
    padding: 10px 14px; border-radius: 6px;
    border: 1px solid var(--line);
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    max-width: 360px;
    z-index: 100;
  }
  .toast.error { border-color: var(--danger); color: var(--danger); }
  details summary { cursor: pointer; color: var(--muted); padding: 4px 0; }
  pre {
    background: var(--bg);
    padding: 8px;
    border-radius: 4px;
    border: 1px solid var(--line);
    overflow: auto;
    margin: 4px 0 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 600px) { .grid-2 { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Ratel MCP</h1>
  <span class="meta" id="meta-home"></span>
  <span class="meta" id="meta-project"></span>
</header>

<main>
  <div class="tabs" id="scope-tabs">
    <button class="tab active" data-scope="user">user</button>
    <button class="tab" data-scope="project">project</button>
    <button class="tab" data-scope="local">local</button>
  </div>

  <div class="panel">
    <div class="toolbar">
      <div class="left"><strong id="scope-label">user</strong> <span class="meta" id="scope-path"></span></div>
      <div class="right">
        <button class="action" id="refresh-btn">Refresh</button>
        <button class="primary" id="add-btn">+ Add server</button>
      </div>
    </div>
    <div id="server-list"></div>
  </div>

  <div class="panel">
    <h2>Agent interop</h2>
    <div class="actions">
      <button class="action" id="import-btn">Import from agent</button>
      <button class="action" id="link-btn">Link agent to Ratel</button>
    </div>
    <p class="meta" style="margin-top: 8px;">Import migrates agent entries into Ratel. Link rewrites the detected agent to point at Ratel for entries already in Ratel.</p>
  </div>

  <div class="panel">
    <h2>Backups</h2>
    <div id="backup-list"></div>
  </div>
</main>

<div id="modal-root"></div>
<div id="toast-root"></div>

<script>
(() => {
  const TOKEN = new URLSearchParams(window.location.search).get("t") || "";
  if (!TOKEN) {
    document.body.innerHTML = '<main><h1>Missing session token</h1><p>Open the URL printed by <code>ratel-mcp ui</code>.</p></main>';
    return;
  }

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === false || v === null || v === undefined) continue;
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return node;
  };

  let state = { scope: "user", config: null };

  async function api(path, init = {}) {
    const headers = Object.assign({ Authorization: "Bearer " + TOKEN }, init.headers || {});
    if (init.body && typeof init.body !== "string") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(init.body);
    }
    const res = await fetch(path, Object.assign({}, init, { headers }));
    let body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = (body && body.error) || (res.status + " " + res.statusText);
      throw new Error(msg);
    }
    return body;
  }

  function toast(message, kind) {
    const root = $("#toast-root");
    root.innerHTML = "";
    const t = el("div", { class: "toast" + (kind === "error" ? " error" : "") }, message);
    root.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 4500);
  }

  function closeModal() { $("#modal-root").innerHTML = ""; }

  function openModal(title, body, actions) {
    const root = $("#modal-root");
    root.innerHTML = "";
    const bg = el(
      "div",
      { class: "modal-bg", onclick: (e) => { if (e.target === bg) closeModal(); } },
      el("div", { class: "modal" },
        el("h3", {}, title),
        body,
        el("div", { class: "modal-actions" }, ...actions),
      ),
    );
    root.appendChild(bg);
  }

  function pillFor(authStatus) {
    if (!authStatus || authStatus === "n/a") return null;
    const cls = authStatus === "ok" ? "ok" : authStatus === "expired" ? "warn" : "danger";
    return el("span", { class: "pill " + cls }, authStatus);
  }

  function summaryOf(entry) {
    const type = entry.type || "stdio";
    if (type === "stdio") {
      const args = (entry.args || []).join(" ");
      return "[" + type + "] " + (entry.command || "<no command>") + (args ? " " + args : "");
    }
    return "[" + type + "] " + (entry.url || "<no url>");
  }

  function renderServers() {
    const list = $("#server-list");
    list.innerHTML = "";
    const scopeData = state.config && state.config.scopes && state.config.scopes[state.scope];
    $("#scope-label").textContent = state.scope;
    $("#scope-path").textContent = scopeData && scopeData.path ? scopeData.path : "(no project root)";
    if (!scopeData || !scopeData.available) {
      list.appendChild(el("div", { class: "empty" }, "Scope not available — no project root detected."));
      return;
    }
    const servers = (scopeData.config && scopeData.config.mcpServers) || {};
    const names = Object.keys(servers);
    if (names.length === 0) {
      list.appendChild(el("div", { class: "empty" }, "No servers in this scope. Click \\u201c+ Add server\\u201d to create one."));
      return;
    }
    for (const name of names) {
      const entry = servers[name];
      const authStatus = (scopeData.authStatus && scopeData.authStatus[name]) || null;
      const row = el("div", { class: "row" },
        el("div", {},
          el("div", {}, el("span", { class: "name" }, name), pillFor(authStatus)),
          el("div", { class: "summary" }, summaryOf(entry)),
        ),
        el("div", { class: "actions" },
          el("button", { class: "action", onclick: () => showDetails(name, entry) }, "details"),
          el("button", { class: "action", onclick: () => openEdit(name, entry) }, "edit"),
          (entry.type === "http" || entry.type === "sse")
            ? el("button", { class: "action", onclick: () => doAuth(name) }, "auth")
            : null,
          el("button", { class: "danger", onclick: () => doRemove(name) }, "remove"),
        ),
      );
      list.appendChild(row);
    }
  }

  function renderBackups() {
    const list = $("#backup-list");
    list.innerHTML = "";
    const backups = (state.config && state.config.backups) || [];
    if (backups.length === 0) {
      list.appendChild(el("div", { class: "empty" }, "No backups."));
      return;
    }
    backups.forEach((m, idx) => {
      const action = el("div", { class: "actions" });
      if (idx === 0) {
        action.appendChild(el("button", { class: "action", onclick: () => doUndo() }, "Undo (latest)"));
      }
      const row = el("div", { class: "row" },
        el("div", {},
          el("div", {}, el("span", { class: "name" }, m.action + " \\u00b7 " + m.createdAt)),
          el("div", { class: "summary" }, (m.entries || []).map((e) => e.originalPath).join(", ")),
        ),
        action,
      );
      list.appendChild(row);
    });
  }

  function renderMeta() {
    $("#meta-home").textContent = state.config ? "home: " + state.config.homeDir : "";
    $("#meta-project").textContent =
      state.config && state.config.projectRoot ? "project: " + state.config.projectRoot : "(no project root)";
  }

  function render() {
    renderMeta();
    renderServers();
    renderBackups();
  }

  async function refresh() {
    try {
      state.config = await api("/api/config");
      render();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function showDetails(name, entry) {
    openModal(
      "Server: " + name,
      el("div", {},
        el("pre", {}, JSON.stringify(entry, null, 2)),
      ),
      [el("button", { class: "action", onclick: closeModal }, "Close")],
    );
  }

  function entryFormFields(entry) {
    const form = el("div", {});
    const fType = entry.type || "stdio";

    const f = (label, key, value, opts = {}) => {
      const id = "f-" + key;
      const input = opts.textarea
        ? el("textarea", { id })
        : opts.select
          ? el("select", { id })
          : el("input", { id, type: "text" });
      if (opts.select) {
        for (const o of opts.select) {
          input.appendChild(el("option", { value: o }, o));
        }
        input.value = value || opts.select[0];
      } else {
        input.value = value || "";
      }
      form.appendChild(el("div", { class: "field" }, el("label", { for: id }, label), input));
      return () => input.value;
    };

    const get = {};
    get.type = f("Type", "type", fType, { select: ["stdio", "http", "sse"] });
    get.description = f("Description", "description", entry.description || "", { textarea: true });

    // stdio fields
    get.command = f("Command (stdio)", "command", entry.command || "");
    get.args = f("Args (one per line)", "args", (entry.args || []).join("\\n"), { textarea: true });
    get.env = f("Env (KEY=VALUE per line)", "env",
      Object.entries(entry.env || {}).map(([k, v]) => k + "=" + v).join("\\n"),
      { textarea: true });
    get.cwd = f("CWD (stdio)", "cwd", entry.cwd || "");

    // http/sse fields
    get.url = f("URL (http/sse)", "url", entry.url || "");
    get.headers = f("Headers (Name: Value per line)", "headers",
      Object.entries(entry.headers || {}).map(([k, v]) => k + ": " + v).join("\\n"),
      { textarea: true });
    get.clientId = f("OAuth client_id", "clientId", entry.clientId || "");
    get.clientSecret = f("OAuth client_secret (plaintext)", "clientSecret", entry.clientSecret || "");
    get.callbackPort = f("OAuth callback port", "callbackPort", entry.callbackPort != null ? String(entry.callbackPort) : "");
    get.scope = f("OAuth scope", "scope", entry.scope || "");

    return {
      element: form,
      read() {
        const t = get.type();
        const out = { type: t };
        const desc = get.description().trim();
        if (desc) out.description = desc;
        if (t === "stdio") {
          const cmd = get.command().trim();
          if (cmd) out.command = cmd;
          const args = get.args().split("\\n").map((s) => s.trim()).filter(Boolean);
          if (args.length) out.args = args;
          const env = {};
          for (const line of get.env().split("\\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const eq = trimmed.indexOf("=");
            if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
          }
          if (Object.keys(env).length) out.env = env;
          const cwd = get.cwd().trim();
          if (cwd) out.cwd = cwd;
        } else {
          const url = get.url().trim();
          if (url) out.url = url;
          const headers = {};
          for (const line of get.headers().split("\\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const colon = trimmed.indexOf(":");
            if (colon > 0) headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
          }
          if (Object.keys(headers).length) out.headers = headers;
          const cid = get.clientId().trim();
          if (cid) out.clientId = cid;
          const cs = get.clientSecret().trim();
          if (cs) out.clientSecret = cs;
          const cp = get.callbackPort().trim();
          if (cp) {
            const n = Number(cp);
            if (Number.isInteger(n) && n >= 0 && n <= 65535) out.callbackPort = n;
          }
          const sc = get.scope().trim();
          if (sc) out.scope = sc;
        }
        return out;
      },
    };
  }

  function openAdd() {
    const fields = entryFormFields({});
    const nameInput = el("input", { type: "text", id: "f-name" });
    const nameField = el("div", { class: "field" }, el("label", { for: "f-name" }, "Name"), nameInput);
    fields.element.insertBefore(nameField, fields.element.firstChild);
    openModal(
      "Add server to " + state.scope,
      fields.element,
      [
        el("button", { class: "action", onclick: closeModal }, "Cancel"),
        el("button", { class: "primary", onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) { toast("Name is required", "error"); return; }
          try {
            await api("/api/servers", { method: "POST", body: { scope: state.scope, name, entry: fields.read() } });
            closeModal();
            toast("Added " + name);
            await refresh();
          } catch (err) { toast(err.message, "error"); }
        } }, "Add"),
      ],
    );
  }

  function openEdit(name, entry) {
    const fields = entryFormFields(entry);
    openModal(
      "Edit " + name + " [" + state.scope + "]",
      fields.element,
      [
        el("button", { class: "action", onclick: closeModal }, "Cancel"),
        el("button", { class: "primary", onclick: async () => {
          try {
            await api("/api/servers/" + encodeURIComponent(name), {
              method: "PATCH",
              body: { scope: state.scope, entry: fields.read() },
            });
            closeModal();
            toast("Updated " + name);
            await refresh();
          } catch (err) { toast(err.message, "error"); }
        } }, "Save"),
      ],
    );
  }

  async function doRemove(name) {
    if (!confirm("Remove \\"" + name + "\\" from " + state.scope + "?")) return;
    try {
      await api("/api/servers/" + encodeURIComponent(name), {
        method: "DELETE",
        body: { scope: state.scope },
      });
      toast("Removed " + name);
      await refresh();
    } catch (err) { toast(err.message, "error"); }
  }

  async function doAuth(name) {
    toast("Starting OAuth for " + name + "\\u2026 a browser window will open.");
    try {
      const res = await api("/api/auth/" + encodeURIComponent(name), { method: "POST", body: {} });
      const lines = (res.log || []).join("\\n");
      toast("Auth: " + (lines || "done"));
      await refresh();
    } catch (err) { toast(err.message, "error"); }
  }

  async function doImport() {
    if (!confirm("Import all detected agent MCP servers into Ratel?")) return;
    try {
      const res = await api("/api/import", { method: "POST", body: {} });
      toast("Import complete\\n" + (res.log || []).slice(-3).join("\\n"));
      await refresh();
    } catch (err) { toast(err.message, "error"); }
  }

  async function doLink() {
    if (!confirm("Rewrite the detected agent to point at Ratel for shared entries?")) return;
    try {
      const res = await api("/api/link", { method: "POST", body: {} });
      toast("Link complete\\n" + (res.log || []).slice(-3).join("\\n"));
      await refresh();
    } catch (err) { toast(err.message, "error"); }
  }

  async function doUndo() {
    if (!confirm("Restore files from the latest backup?")) return;
    try {
      const res = await api("/api/backups/undo", { method: "POST", body: {} });
      toast("Undo: " + (res.log || []).join("\\n"));
      await refresh();
    } catch (err) { toast(err.message, "error"); }
  }

  // Wire up
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      state.scope = btn.dataset.scope;
      render();
    });
  });
  $("#refresh-btn").addEventListener("click", refresh);
  $("#add-btn").addEventListener("click", openAdd);
  $("#import-btn").addEventListener("click", doImport);
  $("#link-btn").addEventListener("click", doLink);

  refresh();
})();
</script>
</body>
</html>
`;
