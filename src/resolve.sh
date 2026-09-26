#!/bin/bash
# Pass a result through to Alfred's clipboard object.
# Large results arrive as "dtfile:<path>" (written by devtoolbox.js to the workflow cache).
case "$1" in
  dtfile:*)
    f="${1#dtfile:}"
    case "$f" in
      "$alfred_workflow_cache"/result-*.txt) cat "$f" ;;
      *) printf '%s' "$1" ;;
    esac ;;
  *) printf '%s' "$1" ;;
esac
