#!/bin/sh
set -eu

# Railway attaches volumes only when the container starts. On a fresh volume
# the mount root belongs to root, not the unprivileged node account.
if [ -n "${CLOUDY_EMBED_MEDIA_DIR:-}" ]; then
  case "$CLOUDY_EMBED_MEDIA_DIR" in
    /cloudy-media/*)
      if [ ! -d /cloudy-media ]; then
        echo "[EMBED_MEDIA] The configured Railway media volume is not mounted." >&2
        exit 1
      fi
      chown node:node /cloudy-media
      mkdir -p "$CLOUDY_EMBED_MEDIA_DIR"
      chown node:node "$CLOUDY_EMBED_MEDIA_DIR"
      if ! su-exec node sh -c '[ -w "$CLOUDY_EMBED_MEDIA_DIR" ]'; then
        echo "[EMBED_MEDIA] Media storage is not writable as the node user." >&2
        exit 1
      fi
      echo "[EMBED_MEDIA] Persistent banner storage writable by node."
      ;;
    *)
      echo "[EMBED_MEDIA] Unsupported media directory. Expected /cloudy-media/..." >&2
      exit 1
      ;;
  esac
fi

# Cloudy never runs with root privileges.
exec su-exec node "$@"
