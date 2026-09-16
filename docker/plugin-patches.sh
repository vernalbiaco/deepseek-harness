#!/bin/sh
# Apply or check the dsh-llm-local-token module patches in the running harness
# stack. `apply` copies patches/dsh-llm-local-token/*.js into each patched
# service's profile, restarts that service's container so the process loads
# them, then restarts its `<service>-proxy` sidecar: the sidecar shares the
# service's network namespace, which the restart replaced, and rejoins it only
# when it starts again. `check` reports the routes each service's plugin
# registers, and whether the profile field the model catalog needs is in place:
# the routes alone stay healthy while the picker is broken.
#
# `apply` first compares every installed module against the upstream hash it
# was patched against, and copies nothing anywhere unless all of them match: a
# patched copy built on a different base would silently drop the installed
# release's own changes to that module.
#
# `index.js` is patched by an in-place edit rather than a copy. It is the one
# patched module that differs between releases, so a full copy would pin the
# patch to a single version and drop every other release's own changes; the
# edit adds one missing field and is a no-op once a release declares it.
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
# `profileOf` in the plugin's index.js builds the pi-ai provider profile the
# adapter reads. ResolvedPiAiProviderProfile in packages/llm/llm-pi-ai
# requires `modelErrors`; releases through 1.5.1 omit it, so modelOf throws
# "Cannot read properties of undefined (reading 'get')" once per route the
# plugin serves and the model picker lists those routes as failed groups.
# Nothing else notices: the usage route reads no profile, so the quota badge
# and `check` below stay healthy while the picker is broken.
#
# Anchored on the adjacent required field, which every release patched so far
# writes exactly once, so one edit serves 1.3.2 and 1.5.1 alike.
anchor="    configuredMaxTokens: new Map(),"
field="    modelErrors: new Map(),"
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

# The plugin directory inside one service's profile.
plugin_dir() {
  echo "/root/.dsh/profiles/$1/node_modules/dsh-llm-local-token"
}

# Whether the installed index.js declares the field the model catalog needs.
model_errors_state() {
  if docker exec "$1" grep -q "^ *modelErrors:" "$(plugin_dir "$2")/lib/index.js" 2>/dev/null; then
    echo "modelErrors declared"
  else
    echo "modelErrors MISSING, so the model picker reports this plugin's routes as failed"
  fi
}

# Add the missing `modelErrors` to `profileOf`, once. Args: service, container,
# file. Reports what it did, and dies rather than guessing when the release
# does not write the anchor exactly once.
add_model_errors() {
  did="$(docker exec "$2" node -e '
const fs = require("fs")
const [file, anchor, field] = process.argv.slice(1)
const lines = fs.readFileSync(file, "utf8").split("\n")
if (lines.some(line => /^\s*modelErrors:/.test(line))) {
  console.log("already present")
  process.exit(0)
}
const at = lines.flatMap((line, index) => line === anchor ? [index] : [])
if (at.length !== 1) {
  console.error(`profileOf anchor appears ${at.length} times, expected 1`)
  process.exit(1)
}
if (!fs.existsSync(`${file}.orig`)) fs.copyFileSync(file, `${file}.orig`)
lines.splice(at[0], 0, field)
fs.writeFileSync(file, lines.join("\n"))
console.log("added")
' "$3" "$anchor" "$field")" || die "$1 runs an index.js this edit does not know; reread profileOf before patching"
  docker exec "$2" node --check "$3" >/dev/null 2>&1 || die "$1: the patched index.js does not parse"
  echo "$1: profileOf modelErrors $did"
}

apply() {
  for svc in $services; do
    id="$(container "$svc")"
    if [ -z "$id" ]; then
      echo "skip $svc: not running in project $project"
      continue
    fi
    pkg="$(plugin_dir "$svc")"
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
    add_model_errors "$svc" "$id" "$lib/index.js"
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
      echo "$svc: $found; $(model_errors_state "$id" "$svc")"
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
