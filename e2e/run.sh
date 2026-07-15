#!/usr/bin/env bash
# Comprehensive end-to-end check of the skills feature, exercising REAL processes
# (a real upstream MCP server + the real `ratel-local serve` driven by a real MCP
# client over stdio) — not unit mocks. Covers all three layers:
#
#   A. GATEWAY (pull path) — tool surface, the two reserved buckets (skills not
#      starved by tools), invoke_tool round-trip, get_skill_content + its error path.
#   B. LIFECYCLE — `skill activate → list → deactivate` is reversible & non-destructive.
#   C. PUSH path — the preload hook + REAL project-signal detection (same prompt,
#      different repo → different skill), and the clear-winner gate staying silent.
#
# This is a LOCAL/manual check, not a CI job: it needs the unified SDK linked and
# built (the SDK isn't published yet). Prereqs:
#   cd ../ratel/src/sdk/ts && pnpm build
#   cd ../../../../ratel-local
#   mv node_modules/@ratel-ai/sdk node_modules/@ratel-ai/sdk.orig
#   ln -s ../ratel/src/sdk/ts node_modules/@ratel-ai/sdk
#   pnpm build
#   bash e2e/run.sh          # → "19 passed, 0 failed"
#   rm node_modules/@ratel-ai/sdk && mv node_modules/@ratel-ai/sdk.orig node_modules/@ratel-ai/sdk
set -u
RMCP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$RMCP/dist/bin.js"
PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
no()   { echo "  ✗ $1${2:+ — $2}"; FAIL=$((FAIL+1)); }

skill_md() { # dir name desc triggers stacks marker
  mkdir -p "$1/$2"
  printf -- '---\nname: %s\ndescription: %s\ntriggers: [%s]\nstacks: [%s]\n---\n%s\nFollow these steps...\n' \
    "$2" "$3" "$4" "$5" "$6" > "$1/$2/SKILL.md"
}

echo "═══ PART A — GATEWAY (real \`ratel-local serve\` driven by a real MCP client) ═══"
HGW="$(mktemp -d)"
skill_md "$HGW/.ratel/skills" supabase-auth "Set up Supabase authentication: RLS policies, auth helpers, sessions." "login,signup,authentication,rls" "supabase,next,react" "BODY-MARKER-SUPABASE-AUTH"
skill_md "$HGW/.ratel/skills" frontend-react "React/Next UI component patterns and layout." "dashboard,page,form" "react,next" "BODY-MARKER-FRONTEND"
printf '{"mcpServers":{"up":{"type":"stdio","command":"node","args":["%s/e2e/upstream.mjs"]}}}' "$RMCP" > "$HGW/config.json"
E2E_HOME="$HGW" E2E_BIN="$BIN" E2E_CONFIG="$HGW/config.json" node "$RMCP/e2e/driver.mjs"
[ $? -eq 0 ] && PASS=$((PASS+6)) || FAIL=$((FAIL+1))   # driver prints + returns its own 6 checks
rm -rf "$HGW"

echo ""
echo "═══ PART B — LIFECYCLE (activate → list → deactivate is reversible) ═══"
HLC="$(mktemp -d)"
mkdir -p "$HLC/.claude/skills/alpha" "$HLC/.claude/skills/beta"
printf -- '---\nname: alpha\ndescription: Alpha skill.\n---\nALPHA-BODY\n' > "$HLC/.claude/skills/alpha/SKILL.md"
printf -- '---\nname: beta\ndescription: Beta skill.\n---\nBETA-BODY\n' > "$HLC/.claude/skills/beta/SKILL.md"

HOME="$HLC" node "$BIN" skill activate --yes >/dev/null 2>&1
{ [ -f "$HLC/.claude/skills/alpha/SKILL.md" ] && [ -f "$HLC/.claude/skills/beta/SKILL.md" ]; } && ok "activate: native ~/.claude/skills stay in place" || no "activate: native skills missing"
{ grep -q 'disable-model-invocation: true' "$HLC/.claude/skills/alpha/SKILL.md" && grep -q 'disable-model-invocation: true' "$HLC/.claude/skills/beta/SKILL.md"; } && ok "activate: native skills marked invoke-only" || no "activate: native skills not marked invoke-only"
{ [ -L "$HLC/.ratel/skills/alpha" ] && [ -L "$HLC/.ratel/skills/beta" ]; } && ok "activate: skills linked into Ratel-managed ~/.ratel/skills" || no "activate: not linked in managed dir"
[ -f "$HLC/.ratel/skill-manifest.json" ] && ok "activate: manifest written (records managed links)" || no "activate: no manifest"

LIST="$(HOME="$HLC" node "$BIN" skill list 2>&1)"
{ echo "$LIST" | grep -q alpha && echo "$LIST" | grep -q beta; } && ok "list: reports both managed skills" || no "list: missing entries" "$LIST"

HOME="$HLC" node "$BIN" skill deactivate --yes >/dev/null 2>&1
{ [ -f "$HLC/.claude/skills/alpha/SKILL.md" ] && [ -f "$HLC/.claude/skills/beta/SKILL.md" ]; } && ok "deactivate: native skills remain in ~/.claude/skills" || no "deactivate: native skills missing"
{ ! grep -q 'disable-model-invocation' "$HLC/.claude/skills/alpha/SKILL.md" && ! grep -q 'disable-model-invocation' "$HLC/.claude/skills/beta/SKILL.md"; } && ok "deactivate: invoke-only marker removed" || no "deactivate: invoke-only marker remains"
grep -q ALPHA-BODY "$HLC/.claude/skills/alpha/SKILL.md" 2>/dev/null && ok "deactivate: content intact after round-trip (non-destructive)" || no "deactivate: content lost"
{ [ ! -e "$HLC/.ratel/skills/alpha" ] && [ ! -e "$HLC/.ratel/skills/beta" ]; } && ok "deactivate: managed links removed" || no "deactivate: still in managed dir"
echo "$(cat "$HLC/.ratel/skill-manifest.json" 2>/dev/null)" | tr -d ' \n' | grep -q '"managed":\[\]' && ok "deactivate: manifest emptied" || no "deactivate: manifest not empty"
rm -rf "$HLC"

echo ""
echo "═══ PART C — PUSH PATH (preload hook + REAL project-signal detection) ═══"
HP="$(mktemp -d)"
skill_md "$HP/.ratel/skills" frontend-react "React/Next UI component patterns and layout." "dashboard,page,form" "react,next" "BODY-FE"
skill_md "$HP/.ratel/skills" django-admin "Django admin and server-rendered views." "dashboard,admin,page" "django,python" "BODY-DJ"
mkdir -p "$HP/reactproj" "$HP/djangoproj" "$HP/neutral"
printf '{"dependencies":{"next":"15","react":"19"}}' > "$HP/reactproj/package.json"
printf '[project]\nname="x"\ndependencies=["Django>=5"]\n' > "$HP/djangoproj/pyproject.toml"

# 2>/dev/null is intentional: it mirrors how Claude Code consumes the hook —
# it reads STDOUT only. (A regression once wrote the nudge to stderr.)
hook() { echo "{\"prompt\":\"$1\",\"cwd\":\"$2\",\"session_id\":\"s$3\"}" | HOME="$HP" node "$BIN" skill preload-hook 2>/dev/null; }
R_REACT="$(hook 'build me a dashboard' "$HP/reactproj" 1)"
R_DJANGO="$(hook 'build me a dashboard' "$HP/djangoproj" 2)"
R_NEUTRAL="$(hook 'build me a dashboard' "$HP/neutral" 3)"
echo "$R_REACT"  | grep -q 'frontend-react' && ok "react repo: 'build a dashboard' → frontend-react fires" || no "react repo wrong" "$R_REACT"
echo "$R_DJANGO" | grep -q 'django-admin'   && ok "django repo: SAME prompt → django-admin fires (signal flips winner)" || no "django repo wrong" "$R_DJANGO"
{ [ -z "$R_NEUTRAL" ] || ! echo "$R_NEUTRAL" | grep -q 'get_skill_content'; } && ok "neutral repo (no manifest): tie → fires NOTHING" || no "neutral should be silent" "$R_NEUTRAL"
rm -rf "$HP"

echo ""
echo "════════════════════════════════════════════"
echo "TOTAL: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && echo "✅ END-TO-END: EVERYTHING WORKS" || { echo "❌ SOMETHING IS BROKEN"; exit 1; }
