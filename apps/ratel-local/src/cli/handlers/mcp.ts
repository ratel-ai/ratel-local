import { ArgError } from "../args.js";
import { runAdd } from "./add.js";
import { runEdit } from "./edit.js";
import { runMcpGet } from "./get.js";
import { runMcpAuth } from "./mcp-auth.js";
import { runMcpList } from "./mcp-list.js";
import { runRemove } from "./remove.js";
import type { CliServerMutator, HandlerCtx } from "./types.js";

export const MCP_USAGE = `usage: ratel-local mcp <verb> [args...]

Verbs:
  add     add an MCP server entry (Claude-compatible: ratel-local mcp add [flags] <name> -- <command> [args...]
                                   or ratel-local mcp add [flags] <name> <url>)
  remove  remove an entry from a Ratel scope
  list    list MCP servers configured across Ratel scopes
  get     show one entry's resolved details
  edit    edit fields on an existing entry (interactive when no flags supplied)
  auth    drive an interactive OAuth flow for one or all http/sse upstreams that need authorization

To import agent MCP configs and skills, see \`ratel-local import\`.
To point an agent at Ratel, see \`ratel-local link\`.
To start the gateway, see \`ratel-local serve\`.

Scopes:
  --scope user     write ~/.ratel/config.json (default)
  --scope project  write <current-project>/.ratel/config.json
  --scope local    write <current-project>/.ratel/config.local.json`;

export async function runMcp(
  ctx: HandlerCtx,
  options: { mutateServer?: CliServerMutator } = {},
): Promise<void> {
  const { verb } = ctx.argv;
  switch (verb) {
    case "add":
      await runAdd(ctx, { mutateServer: options.mutateServer });
      return;
    case "remove":
      await runRemove(ctx, { mutateServer: options.mutateServer });
      return;
    case "list":
      await runMcpList(ctx);
      return;
    case "get":
      await runMcpGet(ctx);
      return;
    case "edit":
      await runEdit(ctx, { mutateServer: options.mutateServer });
      return;
    case "auth":
      await runMcpAuth(ctx);
      return;
    default:
      throw new ArgError(`unknown mcp verb: ${verb}`);
  }
}
