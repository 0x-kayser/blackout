#!/bin/sh
set -eu

# Railway mounts persistent volumes as root. Make only the data directory
# writable by BLACKOUT, then run the application as the unprivileged user.
mkdir -p /data
chown blackout:blackout /data

exec su -s /bin/sh -c 'exec "$@"' -- blackout blackout "$@"
