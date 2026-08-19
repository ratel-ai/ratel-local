import {
  type MutationKey,
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useRatelApp } from "@/App";
import { ratelQueryKeys } from "@/lib/ratel-query";

type Message<TData, TVariables> = string | ((data: TData, variables: TVariables) => string);

export function useRatelMutation<TData = unknown, TVariables = void>(options: {
  invalidate?: false | QueryKey[];
  mutationFn: (variables: TVariables) => Promise<TData>;
  mutationKey?: MutationKey;
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>;
  successMessage: Message<TData, TVariables>;
}) {
  const { context } = useRatelApp();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: options.mutationFn,
    mutationKey: options.mutationKey,
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "The action failed");
    },
    onSuccess: async (data, variables) => {
      const message =
        typeof options.successMessage === "function"
          ? options.successMessage(data, variables)
          : options.successMessage;
      toast.success(message);

      const invalidations =
        options.invalidate === false
          ? []
          : (options.invalidate ?? [ratelQueryKeys.context(context)]).map((queryKey) =>
              queryClient.invalidateQueries({ queryKey }),
            );
      await Promise.all([options.onSuccess?.(data, variables), ...invalidations]);
    },
  });
}
