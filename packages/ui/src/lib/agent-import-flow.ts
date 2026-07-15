export async function linkThenRefreshImportPreview<T>(
  link: () => Promise<boolean>,
  loadImportPreview: () => Promise<T>,
): Promise<T | null> {
  if (!(await link())) return null;
  return loadImportPreview();
}

export function importStatuslineAction(
  status: "not-installed" | "installed" | "other" | undefined,
) {
  if (status === "other") {
    return {
      actionLabel: "Replace statusline",
      description:
        "Import is complete. Replace the existing non-Ratel Claude Code statusline with the standalone Ratel statusline?",
      force: true,
      title: "Replace the existing statusline?",
    } as const;
  }
  return {
    actionLabel: "Install statusline",
    description:
      "Import is complete. Install the standalone Claude Code statusline to show context usage and Ratel telemetry.",
    force: false,
    title: "Install the Ratel statusline?",
  } as const;
}
