#!/bin/bash

set -x
until $@; do
  echo "crashed with exit code $?" >&2
  sleep 1
done
