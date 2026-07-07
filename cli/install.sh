#!/bin/sh
# Desk CLI installer — installs the `desk` command WITHOUT cloning the repo.
#
#   curl -fsSL https://raw.githubusercontent.com/lucrua/desk-public/main/cli/install.sh | sh
#
# Then:
#   desk config      # set your Desk URL + auth
#   desk help
#
# Env overrides:
#   DESK_CLI_BASE  base URL for the CLI files (default: GitHub raw, branch main)
#   DESK_CLI_HOME  where the files land       (default: ~/.desk/cli)
#   DESK_BIN_DIR   where the `desk` launcher lands (default: ~/.local/bin)
set -eu

BASE="${DESK_CLI_BASE:-https://raw.githubusercontent.com/lucrua/desk-public/main/cli}"
CLI_HOME="${DESK_CLI_HOME:-$HOME/.desk/cli}"
BIN_DIR="${DESK_BIN_DIR:-$HOME/.local/bin}"

# 1. Require Node >= 20.
if ! command -v node >/dev/null 2>&1; then
  echo "desk: Node.js >= 20 is required, but 'node' is not on your PATH." >&2
  exit 1
fi
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "desk: Node.js >= 20 required (found $(node -v))." >&2
  exit 1
fi

# 2. Downloader (curl or wget).
fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "desk: need curl or wget to download." >&2; exit 1; fi
}

# 3. Download the zero-dependency runtime files.
echo "desk: installing from $BASE"
mkdir -p "$CLI_HOME/lib"
for f in desk.mjs lib/config.mjs; do
  fetch "$BASE/$f" "$CLI_HOME/$f"
done
chmod +x "$CLI_HOME/desk.mjs"

# 4. Put a `desk` launcher on PATH (a wrapper — robust across node locations).
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/desk" <<EOF
#!/bin/sh
exec node "$CLI_HOME/desk.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/desk"
echo "desk: installed -> $BIN_DIR/desk"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    echo "desk: $BIN_DIR is not on your PATH. Add it, e.g.:"
    echo "      echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile && . ~/.profile"
    ;;
esac

echo
echo "Next:"
echo "  desk config      # set your Desk URL + auth (saved for reuse)"
echo "  desk help"
