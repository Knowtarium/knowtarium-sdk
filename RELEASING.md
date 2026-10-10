# Releasing

The `version` in `package.json` drives everything that ships: the npm package, the Claude Desktop
bundle (`knowtarium-<version>.mcpb`, its manifest version), the Claude Code and Codex plugins in
the [knowtarium-plugins](https://github.com/Knowtarium/knowtarium-plugins) marketplace, the MCP
Registry entry (`server.json`), and the server command agents get
(`npx -y knowtarium@<version> mcp`). Nothing is published from a development machine by accident:
`pnpm build:extras` refuses a private package, version `0.0.0`, or a version npm doesn't have,
unless `--dev` is passed, and a `--dev` build is named and titled as a development build and is
never distributed. The publish workflow refuses a private package and version `0.0.0` too.

## Owner decisions

These stay as they are until the owner decides; nothing in this repo changes them on its own.

- **Public package** (owner, since 0.1.0). `package.json` has no `"private": true` any more; npm,
  the publish workflow and `pnpm build:extras` all refuse a private package, so putting it back
  stops every release.
- **License: MIT** (owner, 2026-10-07). `package.json` says `"license": "MIT"` and `LICENSE` holds
  the text, copyright Magentix Studio UG (haftungsbeschränkt). npm ships `LICENSE` with the package
  on its own.
- **Public repository, provenance on** (owner, 2026-10-09). `publishConfig.provenance` is `true`:
  npm records which GitHub Actions run built the package. That works because the repository is
  public and its URL, `Knowtarium/knowtarium-sdk`, matches `repository` in `package.json`; keep the
  two in step if the repository ever moves.
- **`homepage` and `bugs`**: `homepage` is `https://knowtarium.com`; `bugs` points at this
  repository's GitHub issues, with support@knowtarium.com as the email. The privacy policy URL in
  `extras/extras.config.json` is `https://knowtarium.com/privacy`, which is live.

## Order

1. Set the version in `package.json` and in `server.json` (its `version` and the npm package's
   `version`; `pnpm build:extras` refuses a `server.json` that doesn't match).
2. `pnpm shrinkwrap`: regenerates `npm-shrinkwrap.json`, which pins the transitive dependencies
   `npx` installs. `pnpm test:dist` fails while it doesn't match `package.json`.
3. `pnpm check`, `pnpm build`, `pnpm test:dist`, then `pnpm build:extras --dev` and
   `node scripts/check-node.js <node binaries>` with Node binaries of the lowest supported version
   (`engines` and `bundleNodeMinimum`, 20.0.0) and newer. CI's `node-versions` job does this on every
   push with Node 20.0.0 and 22 from `actions/setup-node`; locally, download them into a temporary
   folder from nodejs.org (never install them): the CLI and the unpacked bundle must answer under
   each.
4. **npm.** Commit, then tag and push the tag: `git tag v<version> && git push origin v<version>`.
   The publish workflow (`.github/workflows/publish.yml`) checks that the package isn't private,
   that the version isn't `0.0.0` and that the tag matches it, runs `pnpm check`, then
   `npm publish`, whose `prepublishOnly` builds and runs `pnpm test:dist`. It signs in to npm
   through trusted publishing, with no token: on npmjs.com, `knowtarium`'s settings name this
   repository (`Knowtarium/knowtarium-sdk`) and the workflow file `publish.yml` as its trusted
   publisher, and npm checks that GitHub Actions run before it accepts the package. Renaming the
   workflow file or moving the repository means updating that setting. Everything else points at
   this version, so npm comes first.
5. **GitHub Release, on its own.** When the publish run succeeds, the release-assets workflow
   (`.github/workflows/release-assets.yml`) builds the bundle from the tag with
   `pnpm build:extras` and creates the GitHub Release `v<version>` with three files:
   `knowtarium-<version>.mcpb`, the same file as `knowtarium.mcpb`, and `SHA256SUMS`. The stable
   name makes
   `https://github.com/Knowtarium/knowtarium-sdk/releases/latest/download/knowtarium.mcpb`
   always download the newest bundle (GitHub serves release files as downloads), so the web app
   and the plugins' READMEs link it. The release is marked latest only when the version is npm's
   `latest`, and a prerelease version (`1.2.0-beta.1`) is a prerelease. The workflow also runs on
   every push to main and does nothing until `package.json`'s version is tagged and on npm, or once
   its release has all three files; it never replaces a file a release already has (a release
   with only some of them stops it with an error: delete those files on GitHub, then run it again).
   The bundle is built by a job with a read-only token; only the last job, which runs no code from
   the repository, gets `contents: write` to create the release and upload the files, and
   `id-token: write` and `attestations: write` to sign each bundle's build provenance
   (`gh attestation verify knowtarium.mcpb --repo Knowtarium/knowtarium-sdk` checks a download).
   The release notes link the npm version, say how to update agents and where the plugins are,
   and end with GitHub's comparison with the previous release; edit them on GitHub to say what
   changed. Every action in the workflows is pinned to a full commit SHA, with its version in a
   comment: to update one, resolve the new tag with
   `git ls-remote https://github.com/<owner>/<repo>.git 'refs/tags/<tag>' 'refs/tags/<tag>^{}'`
   (the `^{}` line is the commit of an annotated tag) and replace both. Claude
   Desktop's extension directory no longer takes `.mcpb` files, so this download is how people
   get the bundle.

   **Running it by hand.** A run after a publish has a concurrency group of its own (per tag), so
   a push to main can't replace it while it waits; pushes and manual runs share one, where GitHub
   keeps only the newest waiting run. The release job, the only one that writes, takes turns per
   tag, so two runs never both create a release. If a release lacks its files after a publish, open the repository's **Actions** tab, pick **Release assets**, and
   **Run workflow** on `main`: it finishes whatever the current version's release lacks. If an
   upload failed partway, GitHub may leave a **draft** release, or a release with only some files:
   delete the draft (or those files) on the **Releases** page, then run the workflow again.

   **0.1.2.** The release is built from its tag, so `knowtarium-0.1.2.mcpb` carries the 0.1.2
   manifest: no `tools` list, `icons`, `support`, `documentation` or `claude_desktop` floor.
   Those arrive with 0.1.3, the first version built with this `build:extras`.

6. **Plugins.** `pnpm build:extras` (now that `knowtarium@<version>` is on npm, a release build)
   writes the plugins repository to `dist-extras/marketplace/` and validates it
   (`claude plugin validate --strict` on the marketplace and the Claude Code plugin, the Codex
   plugin against the Agent Plugins schemas in `extras/schemas/`). Copy it over a clone of
   [knowtarium-plugins](https://github.com/Knowtarium/knowtarium-plugins), keeping its `.git`,
   then commit and push to main:

   ```sh
   rsync -a --delete --exclude .git dist-extras/marketplace/ ../plugins/
   git -C ../plugins add -A && git -C ../plugins commit -m "Knowtarium <version>"
   ```

   Nothing in that repository is edited by hand. It holds a Claude Code marketplace
   (`.claude-plugin/marketplace.json`, plugin `plugins/claude/knowtarium`) and a Codex one
   (`.agents/plugins/marketplace.json`, plugin `plugins/codex/knowtarium` in the portable Agent
   Plugins format), so neither client reads the other's files. The version is set only in each
   plugin's manifest, and the pinned server command (`-y knowtarium@<version> mcp`) is written into
   each plugin's MCP config, where a directory scanner sees it. People get an update when the
   version changes; updating the marketplace only refreshes the listing, so it takes two steps:
   `claude plugin marketplace update knowtarium`, then `claude plugin update knowtarium@knowtarium`
   (Claude Code), or `codex plugin marketplace upgrade knowtarium`, then
   `codex plugin add knowtarium@knowtarium` again (Codex). The marketplace must stay named
   `knowtarium`: the web app tells people to run `/plugin install knowtarium@knowtarium`.

7. **MCP Registry (optional).** `server.json` describes the npm package for the
   [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.Knowtarium/knowtarium`
   (`mcpName` in `package.json`, which the registry checks against the published package). 0.1.2
   can't be registered: the 0.1.2 package on npm has no `mcpName`. **0.1.3 is the first version
   that can have a registry entry.** With
   [`mcp-publisher`](https://modelcontextprotocol.io/registry/quickstart), signed in as an
   **owner** of the Knowtarium GitHub organization (the registry grants `io.github.Knowtarium/*`
   only to org owners, and the name is case sensitive):
   `mcp-publisher login github`, then `mcp-publisher publish` in this folder. The entry lists only
   the npm package; the bundle could be added as an `mcpb` package with the `fileSha256` from the
   release's `SHA256SUMS`.

## The shrinkwrap

The package ships `npm-shrinkwrap.json` because it is published CLI-first: people run it with
`npx knowtarium` and agents with `npx -y knowtarium@<version> mcp`, and the shrinkwrap makes those
install exactly the transitive versions tested here instead of whatever the ranges resolve to on
the day. The trade-off falls on the SDK side. npm also honors a dependency's shrinkwrap, so a
project that installs `knowtarium` with npm to use `knowtarium/client` or `/core` gets these exact
versions too: no deduplication with its own `zod`, `yaml` or `diff` (two copies in its bundle),
and a fixed transitive dependency only arrives with a new knowtarium release. pnpm and Yarn ignore
a dependency's shrinkwrap, so the web app and the sync API (pnpm) are unaffected. If the SDK ever
gets outside users of its own, publish it as a separate package without a shrinkwrap and keep the
shrinkwrap on the CLI package.

## Settings

`extras/extras.config.json` holds what the manifests show: the display name, descriptions,
author, homepage, repository, documentation, support, privacy policy and terms URLs, the Codex
presentation (short description, prompts, brand color), the lowest Claude Desktop version the
bundle declares (`claudeDesktopMinimum`, 1.0.0 as Anthropic's build-mcpb skill uses for manifest
0.3), the lowest Node it declares (`bundleNodeMinimum`: Claude Desktop runs it on its own,
undocumented Node version), and the platforms whose OS keychain binary goes into the bundle
(elsewhere the CLI keeps its key in a private file). The plugin READMEs, which say what each
plugin runs, sends and stores, come from `extras/readme/`; the icon is `extras/icon.png`; the
schemas the build checks against are copies in `extras/schemas/` (Agent Plugins 1.0.0, the MCP
Registry's `server.json` schema of 2025-12-11). The bundle manifest's `tools` list comes from the
real tool definitions (`src/cli/mcp/catalog.ts`), never by hand.
