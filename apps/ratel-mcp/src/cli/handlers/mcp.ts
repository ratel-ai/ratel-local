import { ArgError } from "../args.js";
import { runAdd } from "./add.js";
import { runEdit } from "./edit.js";
import { runMcpGet } from "./get.js";
import { runMcpAuth } from "./mcp-auth.js";
import { runMcpList } from "./mcp-list.js";
import { runRemove } from "./remove.js";
import type { HandlerCtx } from "./types.js";

export const MCP_USAGE = `usage: ratel-mcp mcp <verb> [args...]

Verbs:
  add     add an MCP server entry (Claude-compatible: ratel-mcp mcp add [flags] <name> -- <command> [args...]
                                   or ratel-mcp mcp add [flags] <name> <url>)
  remove  remove an entry from a Ratel scope
  list    list MCP servers configured across Ratel scopes
  get     show one entry's resolved details
  edit    edit fields on an existing entry (interactive when no flags supplied)
  auth    drive an interactive OAuth flow for one or all http/sse upstreams that need authorization

To import agent MCP configs and skills, see \`ratel-mcp import\`.
To point an agent at Ratel, see \`ratel-mcp link\`.
To start the gateway, see \`ratel-mcp serve\`.`;

export async function runMcp(ctx: HandlerCtx): Promise<void> {
  const { verb } = ctx.argv;
  switch (verb) {
    case "add":
      await runAdd(ctx);
      return;
    case "remove":
      await runRemove(ctx);
      return;
    case "list":
      await runMcpList(ctx);
      return;
    case "get":
      await runMcpGet(ctx);
      return;
    case "edit":
      await runEdit(ctx);
      return;
    case "auth":
      await runMcpAuth(ctx);
      return;
    default:
      throw new ArgError(`unknown mcp verb: ${verb}`);
  }
}
