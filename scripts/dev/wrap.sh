#!/bin/bash
# wrap.sh — run one of the vendor coding CLIs as a BUILDER (full tool access inside one worktree) or as a DRAFTER (read-only text).
#
#   wrap.sh build <gpt|grok|gemini> <worktree> <prompt-file> [out-file]   # autonomous build in <worktree>; log + final text to out-file
#   wrap.sh draft <gpt|grok|gemini> <prompt-file> [out-file]              # read-only drafting (no file edits)
#
# Commander directive 2026-11-04 20:37: offload building to GPT (Codex), Grok (grok CLI) and Gemini (Antigravity `agy`),
# not only Claude. Flags verified from each CLI's --help on 2026-11-04 (QUENCH):
#   codex exec  -C <dir> -s workspace-write|read-only --skip-git-repo-check [--json] [-m <model>] "<prompt>"
#   grok        --cwd <dir> --always-approve --output-format json --prompt-file <f> --max-turns <n> [--tools ""] [-m <model>]
#   agy         --mode auto|plan --dangerously-skip-permissions --add-dir <dir> --output-format json --print-timeout <d> -p=<prompt>
# Secrets: never put credentials in a prompt file; the CLIs inherit the shell env, so run with a minimal env for drafting.
set -uo pipefail
MODE="${1:?build|draft}"; PROVIDER="${2:?gpt|grok|gemini}"; shift 2
if [ "$MODE" = build ]; then WT="${1:?worktree}"; PROMPT="${2:?prompt-file}"; OUT="${3:-$PROMPT.out}"; else WT="$PWD"; PROMPT="${1:?prompt-file}"; OUT="${2:-$PROMPT.out}"; fi
[ -f "$PROMPT" ] || { echo "prompt file missing: $PROMPT" >&2; exit 2; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ); echo "[$STAMP] wrap $MODE $PROVIDER wt=$WT prompt=$PROMPT" >> "$OUT"
case "$PROVIDER" in
  gpt)
    SANDBOX=$([ "$MODE" = build ] && echo workspace-write || echo read-only)
    MODEL="${WRAP_GPT_MODEL:-}"; MARGS=(); [ -n "$MODEL" ] && MARGS=(-m "$MODEL")
    # stdin must be closed: codex exec otherwise waits for "additional input from stdin" forever under a non-TTY.
    codex exec -C "$WT" -s "$SANDBOX" --skip-git-repo-check "${MARGS[@]}" "$(cat "$PROMPT")" < /dev/null >> "$OUT" 2>&1; RC=$? ;;
  grok)
    TOOLS=(); [ "$MODE" = draft ] && TOOLS=(--tools "")
    MODEL="${WRAP_GROK_MODEL:-}"; MARGS=(); [ -n "$MODEL" ] && MARGS=(-m "$MODEL")
    grok --cwd "$WT" --always-approve --output-format json --prompt-file "$PROMPT" --max-turns "${WRAP_MAX_TURNS:-60}" "${TOOLS[@]}" "${MARGS[@]}" >> "$OUT" 2>&1; RC=$? ;;
  gemini)
    AMODE=$([ "$MODE" = build ] && echo auto || echo plan)
    MODEL="${WRAP_GEMINI_MODEL:-gemini-4-argon-medium}"
    (cd "$WT" && agy --mode "$AMODE" --dangerously-skip-permissions --add-dir "$WT" --output-format json --model "$MODEL" --print-timeout "${WRAP_TIMEOUT:-0}" -p="$(cat "$PROMPT")") >> "$OUT" 2>&1; RC=$? ;;
  *) echo "unknown provider $PROVIDER" >&2; exit 2 ;;
esac
echo "[$(date -u +%Y%m%dT%H%M%SZ)] wrap exit=$RC" >> "$OUT"; exit $RC
