# Releasing

AgentScout ships two coordinated npm packages (`@agentscout/client`, `@agentscout/cli`) plus a
Claude Code plugin. They MUST be published together, in dependency order, at the same version. The
shared `@agentx402-ai/core` is released separately from [its own repo](https://github.com/agentx402-ai/core).

## Version sources (keep in sync)

Six sources move in lockstep on every release — five in this repo, plus one cross-repo pin:

1. `client/package.json` — the published `@agentscout/client` version
2. `cli/package.json` — the published `@agentscout/cli` version
3. `client/src/index.ts` (`VERSION`) — reported by the SDK
4. `cli/src/version.ts` (`VERSION`) — `agentscout --version` and the MCP server handshake
5. `plugin/agentscout/.claude-plugin/plugin.json` (`version`)
6. `agentx402-ai/claude-plugins` → `.claude-plugin/marketplace.json` (the `agentscout` plugin's
   `source.ref`) — the cross-repo pin the shared marketplace serves; synced on release (step 7).

The CI `versions` job cross-checks all **five in-repo** sources AND the cli→client dependency
range (`cli/package.json`'s `@agentscout/client` must be `^<clientVersion>`); it fails if any
diverge. The sixth (marketplace) pin lives in another repo and is synced automatically on release.

## Publish order (required)

Each higher package depends on a lower one at `^0.x`, so publish bottom-up:

1. `npm publish -w client` — `@agentscout/client` (depends on the already-published `@agentx402-ai/core`)
2. `npm publish -w cli` — `@agentscout/cli` (depends on `@agentscout/client`)

Do NOT publish a higher package before the one it depends on, or `npm install` will
`E404` for consumers until the dependency lands. If you also changed `@agentx402-ai/core`,
release it first from its own repo and bump the `^` range in `client`/`cli`.

## Steps

1. Bump every version source above (the five in-repo sources and the cli→client dep range) to the
   new version.
2. Update `CHANGELOG.md` — add a dated `## [<version>]` section for the release.
3. `npm ci && npm run lint && npm run build && npm test` — all green.
4. `npm pack --dry-run --workspaces` — confirm each tarball's contents.
5. Publish in the order above.
6. Cut the GitHub Release: `gh release create v<version> --generate-notes`. This tags AND
   publishes a Release — a plain `git push --tags` will NOT fire the publish or the marketplace
   auto-sync. Publishing the Release runs `publish.yml` (OIDC trusted publishing, client then cli).
7. The marketplace pin then syncs automatically: publishing the Release dispatches to
   `agentx402-ai/claude-plugins` (`.github/workflows/notify-marketplace.yml` here), which pins the
   `agentscout` plugin's `source.ref` to `v<version>`. Manual fallback: re-run
   `notify-marketplace.yml` via `workflow_dispatch` with the release tag.
