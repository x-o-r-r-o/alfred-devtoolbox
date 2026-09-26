#!/bin/bash
# Pass a result through to Alfred's clipboard object.
# Large results arrive as "dtfile:<path>" (written by devtoolbox.js to the workflow cache).
# Only files named result-<n>.txt directly inside the cache are read, so text that merely
# looks like "dtfile:<cache>/result-/../../secret.txt" is passed through untouched.
if [[ "$1" == dtfile:* && -n "$alfred_workflow_cache" ]]; then
  f="${1#dtfile:}"
  name="${f#"$alfred_workflow_cache"/}"
  if [[ "$name" != "$f" && "$name" =~ ^result-[0-9]+\.txt$ && -f "$f" ]]; then
    cat "$f"
    exit
  fi
fi
printf '%s' "$1"
