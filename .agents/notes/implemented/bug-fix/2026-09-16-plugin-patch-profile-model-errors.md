# Agent Note: The runtime plugin patch that adds `modelErrors`

Status: implemented

English | [中文](2026-09-16-plugin-patch-profile-model-errors.zh.md)

## Problem

The third-party `dsh-llm-local-token` plugin builds its pi-ai provider profiles in `profileOf` instead of through configuration resolution, so it owns every required member of `ResolvedPiAiProviderProfile` itself. `ResolvedPiAiProviderProfile` in `packages/llm/llm-pi-ai/src/config.ts` requires `modelErrors`, and published releases through 1.5.1 omit it.

`PiAiAdapter.modelOf` reads `profile.modelErrors.get(model)`, so `resolveModelInfo` throws `Cannot read properties of undefined (reading 'get')` for every model on every route the plugin serves. `buildModelCatalog` isolates a throw per provider, so the model picker lists each of the plugin's routes as a failed group and every other provider keeps working. The plugin's `/llm-local-token/usage` route reads no profile, so the quota badge reports both providers and the route-level check stays green while the picker is broken.

## Decision

`docker/plugin-patches.sh` inserts `modelErrors: new Map(),` into the installed `lib/index.js` of every patched profile, anchored on the adjacent `configuredMaxTokens: new Map(),` line. The edit is a no-op when the file already declares the field, and the run stops when the anchor is absent or repeated rather than guessing where the field belongs.

`check` reports that field's presence beside the routes it lists, because a healthy route list does not separate a working model picker from a broken one.

## Alternatives considered

**Read the field defensively in the adapter.** `profile.modelErrors?.get(model)` removes the crash, but the profile arrives over a typed same-process callback, which the trust-TypeScript rule reserves for the static interface. A missing required member is a plugin defect, and tolerating it silently hides the next one.

**Store a patched `index.js` beside the other two modules.** Those modules are byte-identical across 1.3.2 and 1.5.1, so one copy serves either release. `index.js` is not: `web` runs 1.5.1, `api` runs 1.3.2, and 1.5.1 added the image policy and the GLM entries. A stored copy needs one file and one recorded hash per release, and drops every other release's own changes to that file.

## Consequences

The patch set holds two kinds of fix: full-file replacement gated on a recorded upstream hash, and an anchored in-place edit. The edit records no hash because the anchor is its precondition — a release that moves or repeats `configuredMaxTokens: new Map(),` stops the run instead of producing a file nobody inspected.

A release that declares `modelErrors` itself needs no change here. The edit reports `already present`, and the two replaced modules stay hash-gated as before.
