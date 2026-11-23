#!/bin/sh
# Keep make usable from shells whose default Node is older than this project.
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
required_node=$(cat "$project_dir/.nvmrc")

node_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const required = process.argv[1].split(".").map(Number);
    const current = process.versions.node.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (current[i] !== required[i]) process.exit(current[i] > required[i] ? 0 : 1);
    }
  ' "$required_node"
}

if ! node_is_supported; then
  node_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/v$required_node/bin"
  if [ -x "$node_bin/node" ]; then
    PATH="$node_bin:$PATH"
    export PATH
  fi
  if ! node_is_supported; then
    echo "Node $required_node or newer is required. Run 'nvm install' and 'nvm use' in $project_dir, then retry make." >&2
    exit 1
  fi
fi

exec "$@"
