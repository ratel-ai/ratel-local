import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export interface SnapshotDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  path?: string;
}

function bySeverity(a: SnapshotDiagnostic, b: SnapshotDiagnostic): number {
  if (a.severity === b.severity) return 0;
  return a.severity === "error" ? -1 : 1;
}

export function ContextDiagnostics({ diagnostics }: { diagnostics: SnapshotDiagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-6 pt-6" data-slot="context-diagnostics">
      {[...diagnostics].sort(bySeverity).map((diagnostic) => (
        // Codes are not unique: one cause can emit several diagnostics.
        <Alert
          key={`${diagnostic.code}:${diagnostic.path ?? ""}:${diagnostic.message}`}
          variant={diagnostic.severity === "error" ? "destructive" : "default"}
        >
          <AlertTitle className="font-mono text-xs">{diagnostic.code}</AlertTitle>
          <AlertDescription>
            {diagnostic.message}
            {diagnostic.path && (
              <span className="mt-1 block truncate font-mono text-xs opacity-80">
                {diagnostic.path}
              </span>
            )}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
