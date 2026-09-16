#!/bin/sh
# Apply or check the dsh-llm-local-token module patches in the running harness
# stack. `apply` copies patches/dsh-llm-local-token/*.js into each patched
# service's profile, restarts that service's container so the process loads
# them, then restarts its `<service>-proxy` sidecar: the sidecar shares the
# service's network namespace, which the restart replaced, and rejoins it only
# when it starts again. `check` reports the routes each service's plugin
# registers.
#
# `apply` first compares every installed module against the upstream hash it
# was patched against, and copies nothing anywhere unless all of them match: a
# patched copy built on a different base would silently drop the installed
# release's own changes to that module.
#
# Both act on running containers found by their Compose labels, never on a
# Compose file set. A file set resolved from the invoking checkout can differ
# from the one the stack was started with, and Compose then recreates the
# service with that other configuration. DSH_STACK_PROJECT names the Compose
# project; when it is empty, the project is the only one running a patched
# service from the dsh image.
#
# Usage: docker/plugin-patches.sh apply|check
set -eu

action="${1:-}"
services="${PATCHED_SERVICES:-web api}"
repo="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
patches="$repo/patches/dsh-llm-local-token"
modules="claude-keychain.js token-store.js"
# The image's entrypoint, which identifies a dsh container whatever its tag.
dsh_entrypoint="/app/apps/cli/lib/bin.js"
# Seconds `check` waits for a restarted service's route; 0 checks once.
check_wait="${PLUGIN_CHECK_WAIT:-0}"

die() {
  echo "plugin-patches: $*" >&2
  exit 1
}

# The running container of one Compose service in the stack project, or nothing.
container() {
  ids="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1")"
  case "$(printf '%s' "$ids" | grep -c .)" in
    0|1) printf '%s' "$ids" ;;
    *) die "project $project runs several $1 containers; scale it to one" ;;
  esac
}

# The single Compose project running a patched service from the dsh image.
detect_project() {
  found=""
  for svc in $services; do
    for id in $(docker ps -q --filter "label=com.docker.compose.service=$svc"); do
      case "$(docker inspect -f '{{json .Config.Entrypoint}}' "$id")" in
        *"$dsh_entrypoint"*)
          found="$found$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id")
" ;;
      esac
    done
  done
  projects="$(printf '%s' "$found" | sort -u | grep . || true)"
  case "$(printf '%s' "$projects" | grep -c .)" in
    0) die "no running Compose project serves $services from the dsh image; start the stack or set DSH_STACK_PROJECT" ;;
    1) printf '%s' "$projects" ;;
    *) die "several Compose projects serve $services from the dsh image: $(printf '%s' "$projects" | tr '\n' ' '); set DSH_STACK_PROJECT" ;;
  esac
}

# The published module each patched copy was written against. Upstream 1.3.2
# and 1.5.1 ship both modules byte-identical, so one patched copy serves either
# release; regenerate the copy in patches/dsh-llm-local-token against any
# release that reports a mismatch here.
base_hash() {
  case "$1" in
    claude-keychain.js) echo 171bca11d97d3f1c36af931f999036df45a0eab7836cfd86ca057de236d7ae1f ;;
    token-store.js) echo 223fa5f29788c41ec1f36bd0570468dbfdf592910ec14295c78320c370192864 ;;
    *) die "no recorded upstream hash for $1" ;;
  esac
}

# The module as the release published it: the backup a previous apply made, or
# else the installed file, which this run has not replaced yet.
published_hash() {
  docker exec "$1" sh -c "sha256sum '$2.orig' 2>/dev/null || sha256sum '$2'" 2>/dev/null | cut -d' ' -f1
}

apply() {
  for svc in $services; do
    id="$(container "$svc")"
    if [ -z "$id" ]; then
      echo "skip $svc: not running in project $project"
      continue
    fi
    pkg="/root/.dsh/profiles/$svc/node_modules/dsh-llm-local-token"
    lib="$pkg/lib"
    if ! docker exec "$id" test -d "$lib"; then
      echo "skip $svc: dsh-llm-local-token is not installed in profile $svc"
      continue
    fi
    changed=""
    for f in $modules; do
      [ "$(published_hash "$id" "$lib/$f")" = "$(base_hash "$f")" ] || changed="$changed $f"
    done
    if [ -n "$changed" ]; then
      # Parsed here rather than in the container: the version only names the
      # release in the message, and a container without the tooling would put
      # its own error text where the version belongs.
      version="$(docker exec "$id" cat "$pkg/package.json" 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
      [ -n "$version" ] || version=unknown
      die "$svc runs dsh-llm-local-token $version, which no longer ships what the patched copies were built on:$changed; regenerate patches/dsh-llm-local-token against this release before applying"
    fi
    for f in $modules; do
      docker exec "$id" sh -c "test -f '$lib/$f.orig' || cp '$lib/$f' '$lib/$f.orig'"
      docker cp "$patches/$f" "$id:$lib/$f" >/dev/null
    done
    echo "patched $svc"
    docker restart "$id" >/dev/null
    echo "restarted $svc"
    sidecar="$(container "$svc-proxy")"
    if [ -n "$sidecar" ]; then
      docker restart "$sidecar" >/dev/null
      echo "restarted $svc-proxy"
    fi
  done
}

# The comma-separated providers a service's usage route lists, or nothing.
routes() {
  docker exec "$1" node -e 'fetch("http://127.0.0.1:"+process.argv[1]+"/llm-local-token/usage").then(r=>r.json()).then(d=>console.log(d.providers.map(p=>p.provider).join(", "))).catch(()=>{})' "$2" 2>/dev/null | tr -d '\r' || true
}

check() {
  for svc in $services; do
    id="$(container "$svc")"
    if [ -z "$id" ]; then
      echo "$svc: not running"
      continue
    fi
    case "$svc" in api) port=3081 ;; *) port=3080 ;; esac
    waited=0
    found="$(routes "$id" "$port")"
    while [ -z "$found" ] && [ "$waited" -lt "$check_wait" ]; do
      sleep 2
      waited=$((waited + 2))
      found="$(routes "$id" "$port")"
    done
    if [ -z "$found" ]; then
      echo "$svc: usage route unavailable (plugin not loaded?)"
    else
      echo "$svc: $found"
    fi
  done
}

case "$action" in
  apply|check) ;;
  *) die "usage: docker/plugin-patches.sh apply|check" ;;
esac
project="${DSH_STACK_PROJECT:-}"
if [ -z "$project" ]; then
  project="$(detect_project)"
elif [ -z "$(docker ps -q --filter "label=com.docker.compose.project=$project")" ]; then
  die "Compose project $project has no running containers"
fi
"$action"
