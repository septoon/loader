#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_file="$project_root/runtime/secrets/loader.env"

if [[ ! -r "$environment_file" ]]; then
  echo "Не найден production environment: $environment_file" >&2
  exit 1
fi

set -a
source "$environment_file"
set +a

node_binary="${LOADER_NODE_BINARY:-node}"
exec "$node_binary" "$project_root/dist/server/server/media-sftp.js"
