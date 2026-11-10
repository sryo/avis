#!/usr/bin/env bash
# avis installer — clones the skill to ~/.agents/skills/avis and links it into
# ~/.claude/skills.
# Re-runnable: pulls an existing clone, leaves a link that's already right.
# Never replaces a directory or a link to somewhere else; it says what it found.
#
# Overrides:
#   AVIS_REPO=...   git URL to clone from
#   AVIS_DIR=...    install location (default: ~/.agents/skills/avis)

set -euo pipefail

AVIS_REPO="${AVIS_REPO:-https://github.com/sryo/avis.git}"
AVIS_DIR="${AVIS_DIR:-$HOME/.agents/skills/avis}"
CLAUDE_LINK="$HOME/.claude/skills/avis"

[[ "$(uname -s)" == "Darwin" ]] || { echo "avis only works on macOS (it reaches your browser through perch)." >&2; exit 1; }

command -v git >/dev/null || { echo "git not found. Run: xcode-select --install" >&2; exit 1; }

# link SRC DEST: make DEST a symlink to SRC unless something else is already there.
link() {
  local src="$1" dest="$2"
  if [[ -L "$dest" ]]; then
    if [[ "$(readlink "$dest")" == "$src" ]]; then
      echo "$dest already links to $src"
    else
      echo "$dest links to $(readlink "$dest"), not $src; leaving it."
    fi
  elif [[ -e "$dest" ]]; then
    echo "$dest exists and isn't a link; leaving it."
  else
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$src" "$dest"
    echo "Linked $dest -> $src"
  fi
}

if [[ ! -e "$AVIS_DIR" && -L "$CLAUDE_LINK" && -f "$CLAUDE_LINK/SKILL.md" ]]; then
  echo "avis already installed: $CLAUDE_LINK -> $(readlink "$CLAUDE_LINK"). Leaving it."
  echo "To install a fresh copy instead, remove that link and run this again."
else
  if [[ -f "$AVIS_DIR/SKILL.md" ]]; then
    if [[ -d "$AVIS_DIR/.git" ]]; then
      echo "avis already at $AVIS_DIR — pulling latest..."
      git -C "$AVIS_DIR" pull --ff-only
    else
      echo "avis already at $AVIS_DIR (local, no git repo — skipping pull)..."
    fi
  elif [[ -e "$AVIS_DIR" ]]; then
    echo "$AVIS_DIR exists but holds no avis. Move it or set AVIS_DIR." >&2
    exit 1
  else
    echo "Cloning avis to $AVIS_DIR..."
    mkdir -p "$(dirname "$AVIS_DIR")"
    git clone --quiet "$AVIS_REPO" "$AVIS_DIR"
  fi
  link "$AVIS_DIR" "$CLAUDE_LINK"
fi

cat <<'EOF'

avis installed. Restart your agent if it doesn't show up, then run /avis on a page.
avis needs an agent running on your Mac; cloud agents can't reach your browser.
EOF
