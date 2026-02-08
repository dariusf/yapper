#!/bin/bash

# get absolute path to directory of this script
set -x
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)

until node "$SCRIPT_DIR/yapper.js"; do
  echo "crashed with exit code $?" >&2
  sleep 1
done
