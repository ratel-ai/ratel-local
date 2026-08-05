import { type QueryKey, queryOptions } from "@tanstack/react-query";
import { type JsonRequestInit, requestRatelApi } from "@/lib/ratel-api";
import { type RuntimeUiContext, runtimeContextKey } from "@/lib/runtime-context";

export const ratelQueryKeys = {
  all: ["ratel"] as const,
  context: (context: RuntimeUiContext) =>
    [...ratelQueryKeys.all, "context", runtimeContextKey(context)] as const,
  config: (context: RuntimeUiContext) => [...ratelQueryKeys.context(context), "config"] as const,
  skills: (context: RuntimeUiContext) => [...ratelQueryKeys.context(context), "skills"] as const,
  skill: (context: RuntimeUiContext, id: string) =>
    [...ratelQueryKeys.skills(context), id] as const,
  agentHosts: (context: RuntimeUiContext) =>
    [...ratelQueryKeys.context(context), "agent-hosts"] as const,
  clients: (context: RuntimeUiContext) => [...ratelQueryKeys.context(context), "clients"] as const,
  projects: () => [...ratelQueryKeys.all, "projects"] as const,
  cloudTraces: () => [...ratelQueryKeys.all, "cloud-traces"] as const,
};

export function ratelApiQueryOptions<T>(input: {
  context: RuntimeUiContext;
  init?: JsonRequestInit;
  path: string;
  queryKey: QueryKey;
  signal?: AbortSignal;
  token: string;
}) {
  return queryOptions({
    queryKey: input.queryKey,
    queryFn: ({ signal }) =>
      requestRatelApi<T>(
        { context: input.context, token: input.token },
        input.path,
        input.init
          ? { ...input.init, signal: combineAbortSignals(signal, input.signal) }
          : { signal: combineAbortSignals(signal, input.signal) },
      ),
  });
}

function combineAbortSignals(querySignal: AbortSignal, externalSignal?: AbortSignal): AbortSignal {
  return externalSignal ? AbortSignal.any([querySignal, externalSignal]) : querySignal;
}
