import { cn } from "@/lib/utils";

// Reuse the same brand marks the Agent Setup page ships. The Ratel mark is the
// app favicon (a square cream "R"), served from /public at the site root.
const CLAUDE_ICON_SRC = new URL("../assets/claudecode-color.svg", import.meta.url).href;
const CODEX_ICON_SRC = new URL("../assets/codex-color.svg", import.meta.url).href;
const RATEL_ICON_SRC = "/favicon.svg";

/** Where a skill comes from / is hosted: an agent's folder, or Ratel itself. */
export type SkillSource = "claude" | "codex" | "ratel";

const SOURCE_META: Record<SkillSource, { label: string; src: string }> = {
  claude: { label: "Claude Code", src: CLAUDE_ICON_SRC },
  codex: { label: "Codex", src: CODEX_ICON_SRC },
  ratel: { label: "Ratel", src: RATEL_ICON_SRC },
};

export function sourceLabel(source: SkillSource): string {
  return SOURCE_META[source].label;
}

/** A small badge showing which platform a skill belongs to. */
export function SourceIcon({ source, className }: { source: SkillSource; className?: string }) {
  const meta = SOURCE_META[source];
  return (
    <span
      aria-label={meta.label}
      className={cn(
        "grid size-6 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background",
        className,
      )}
      role="img"
      title={meta.label}
    >
      <img alt="" aria-hidden="true" className="size-4" src={meta.src} />
    </span>
  );
}
