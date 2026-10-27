#!/usr/bin/env bash
# Sets yagura up on this machine: checks the tools it needs, installs and builds it, puts `yagura` on your PATH,
# and adds one marked block to your shell's rc file. Safe to run again.
#
#   scripts/setup.sh                 install, build, link, edit the rc file
#   scripts/setup.sh --no-rc         leave shell rc files alone (the PATH line is printed instead)
#   scripts/setup.sh --no-build      skip pnpm install and build (already built)
#   scripts/setup.sh --bin <dir>     where to link `yagura` (default ~/.local/bin)
#   scripts/setup.sh --uninstall     remove the link and the rc block; ~/.yagura is never touched
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
EDIT_RC=1
BUILD=1
UNINSTALL=0
BEGIN="# >>> yagura >>>"
END="# <<< yagura <<<"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-rc) EDIT_RC=0 ;;
    --no-build) BUILD=0 ;;
    --bin) BIN_DIR="${2:?--bin needs a directory}"; shift ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
bad() { printf '  ✗ %s\n' "$*"; }
note() { printf '  · %s\n' "$*"; }

rc_file() {
  case "$(basename "${SHELL:-}")" in
    zsh) echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ -f "$HOME/.bashrc" ] || [ "$(uname)" != "Darwin" ]; then echo "$HOME/.bashrc"; else echo "$HOME/.bash_profile"; fi
      ;;
    *) echo "" ;;
  esac
}

strip_block() {
  local file="$1" tmp
  [ -f "$file" ] || return 0
  grep -qF "$BEGIN" "$file" || return 0
  tmp="$(mktemp)"
  awk -v b="$BEGIN" -v e="$END" '
    held != "" && $0 != b { printf "%s", held } { held = "" }
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip { next }
    $0 == "" { held = "\n"; next }
    { print }
    END { printf "%s", held }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

if [ "$UNINSTALL" = 1 ]; then
  say "Removing yagura's setup"
  if [ -L "$BIN_DIR/yagura" ]; then rm "$BIN_DIR/yagura"; ok "removed $BIN_DIR/yagura"; else note "no link at $BIN_DIR/yagura"; fi
  RC="$(rc_file)"
  if [ -n "$RC" ] && [ -f "$RC" ] && grep -qF "$BEGIN" "$RC"; then strip_block "$RC"; ok "removed the yagura block from $RC"; else note "no yagura block in ${RC:-your rc file}"; fi
  note "left ${YAGURA_HOME:-$HOME/.yagura} alone; delete it yourself if you want the data gone"
  exit 0
fi

say "Checking this machine"
FAILED=0

if command -v node > /dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 22 ]; then ok "node $(node -v)"; else bad "node $(node -v): need 22 or newer (.nvmrc pins $(cat "$ROOT/.nvmrc"))"; FAILED=1; fi
else
  bad "node not found: install Node $(cat "$ROOT/.nvmrc") (see .nvmrc)"
  FAILED=1
fi

if command -v pnpm > /dev/null; then
  ok "pnpm $(pnpm -v)"
else
  bad "pnpm not found: try 'corepack enable' (Node ships corepack), or see https://pnpm.io/installation"
  FAILED=1
fi

if command -v git > /dev/null; then
  GIT_VERSION="$(git --version | awk '{print $3}')"
  GIT_MAJOR="${GIT_VERSION%%.*}"
  GIT_MINOR="$(echo "$GIT_VERSION" | cut -d. -f2)"
  if [ "$GIT_MAJOR" -gt 2 ] || { [ "$GIT_MAJOR" -eq 2 ] && [ "$GIT_MINOR" -ge 38 ]; }; then ok "git $GIT_VERSION"; else bad "git $GIT_VERSION: need 2.38 or newer"; FAILED=1; fi
else
  bad "git not found"
  FAILED=1
fi

if [ "$FAILED" = 1 ]; then
  say ""
  say "Fix the lines marked ✗ and run this again."
  exit 1
fi

if [ "$BUILD" = 1 ]; then
  say ""
  say "Installing and building"
  (cd "$ROOT" && pnpm install --frozen-lockfile && pnpm -r build)
fi

MAIN="$ROOT/apps/cli/dist/main.js"
if [ ! -f "$MAIN" ]; then
  bad "$MAIN is missing: run without --no-build"
  exit 1
fi
chmod +x "$MAIN"

say ""
say "Linking the yagura command"
mkdir -p "$BIN_DIR"
ln -sf "$MAIN" "$BIN_DIR/yagura"
ok "$BIN_DIR/yagura → $MAIN"

PATH_LINE="case \":\$PATH:\" in *\":$BIN_DIR:\"*) ;; *) export PATH=\"$BIN_DIR:\$PATH\" ;; esac"
RC="$(rc_file)"
case ":$PATH:" in *":$BIN_DIR:"*) ON_PATH=1 ;; *) ON_PATH=0 ;; esac

say ""
say "Shell setup"
if [ "$EDIT_RC" = 0 ]; then
  note "left rc files alone. To put yagura on your PATH, add this to your shell's rc file:"
  say "      $PATH_LINE"
elif [ -z "$RC" ]; then
  note "your shell (${SHELL:-unknown}) is not bash or zsh. Add this to its startup file:"
  say "      $PATH_LINE"
else
  touch "$RC"
  strip_block "$RC"
  {
    printf '\n%s\n' "$BEGIN"
    printf '%s\n' "$PATH_LINE"
    printf '%s\n' "$END"
  } >> "$RC"
  ok "wrote the yagura block to $RC (between '$BEGIN' and '$END')"
  [ "$ON_PATH" = 1 ] || note "open a new terminal, or run: source $RC"
fi

say ""
say "Other tools yagura uses"
SHELL_NAME="$(basename "${SHELL:-bash}")"
if command -v claude > /dev/null; then
  ok "claude found at $(command -v claude); log in by running it once if you have not"
else
  KIND="$("$SHELL_NAME" -ic 'type -t claude' 2> /dev/null | tail -n 1 || true)"
  case "$KIND" in
    function | alias)
      WRAPPER="$BIN_DIR/yagura-claude"
      printf '#!/usr/bin/env %s\nexec %s -ic '"'"'claude "$@"'"'"' claude "$@"\n' "$SHELL_NAME" "$SHELL_NAME" > "$WRAPPER"
      chmod +x "$WRAPPER"
      note "claude is a shell $KIND in your rc file; yagura starts agents without a shell, so it cannot see that."
      note "wrote $WRAPPER, which runs your $KIND through an interactive shell."
      if "$MAIN" set harness.claude.bin "\"$WRAPPER\"" > /dev/null; then
        ok "set harness.claude.bin to $WRAPPER"
      else
        note "could not set it; run: yagura set harness.claude.bin '\"$WRAPPER\"'"
      fi
      note "if your rc file prints anything at startup, agent output gets mixed with it; then copy what the $KIND does (env vars, proxy, the real binary) into the wrapper instead."
      ;;
    *) bad "claude not found: yagura runs agents through it by default" ;;
  esac
fi
if command -v gh > /dev/null; then
  if gh auth status > /dev/null 2>&1; then ok "gh is logged in"; else note "gh found but not logged in: run 'gh auth login'"; fi
else
  note "gh not found (only needed for GitHub repos)"
fi
if command -v glab > /dev/null; then
  if glab auth status > /dev/null 2>&1; then ok "glab is logged in"; else note "glab found but not logged in: run 'glab auth login --hostname <host>'"; fi
else
  note "glab not found (only needed for GitLab repos)"
fi

say ""
say "Done. Start it with:  yagura start"
say "Then open http://127.0.0.1:7300 and add a repo. State lives in ${YAGURA_HOME:-$HOME/.yagura}."
