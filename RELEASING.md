# Releasing

The `version` in `package.json` drives everything that ships: the npm package, the Claude Desktop
bundle (`knowtarium-<version>.mcpb`, its manifest version), the Claude Code plugin and its
marketplace entry, and the server command agents get (`npx -y knowtarium@<version> mcp`). Nothing is
published from a development machine by accident: `pnpm build:extras` refuses a private package,
version `0.0.0`, or a version npm doesn't have, unless `--dev` is passed, and a `--dev` build is
named and titled as a development build and is never distributed. The publish workflow refuses a
private package and version `0.0.0` too.

## Owner decisions before the first release

These stay as they are until the owner decides; nothing in this repo changes them on its own.

- **`"private": true`**: npm refuses to publish a private package, and so does the publish
  workflow. Drop it for the first public release.
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

1. Set the version in `package.json` (and settle the owner decisions above for the first release).
2. `pnpm shrinkwrap`: regenerates `npm-shrinkwrap.json`, which pins the transitive dependencies
   `npx` installs. `pnpm test:dist` fails while it doesn't match `package.json`.
3. `pnpm check`, `pnpm build`, `pnpm test:dist`, then `pnpm build:extras --dev` and
   `node scripts/check-node.js <node binaries>` with Node binaries of the lowest supported version
   (`engines` and `bundleNodeMinimum`, 20.0.0) and newer. CI's `node-versions` job does this on every
   push with Node 20.0.0 and 22 from `actions/setup-node`; locally, download them into a temporary
   folder from nodejs.org (never install them): the CLI and the unpacked bundle must answer under
   each.
4. Commit, then tag and push the tag: `git tag v<version> && git push origin v<version>`. The
   publish workflow (`.github/workflows/publish.yml`) checks that the package isn't private, that
   the version isn't `0.0.0` and that the tag matches it, runs `pnpm check`, then `npm publish`,
   whose `prepublishOnly` builds and runs `pnpm test:dist`. It needs the `NPM_TOKEN` repository
   secret: an npm granular access token that can publish `knowtarium` (with 2FA for writes, an
   automation token or one allowed to bypass it). The bundles point at this version, so npm comes
   first.
5. `pnpm build:extras`: now that `knowtarium@<version>` is on npm, it builds the release bundle and
   plugin into `dist-extras/` and validates them (`mcpb validate`, a started server answering
   `tools/list`, `claude plugin validate --strict`).
6. Publish the bundles: the `.mcpb` to the Claude Desktop extension directory, the plugin folder
   to the public plugin repository (its marketplace), and the skill to its public repository.

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

`extras/extras.config.json` holds what the manifests show: the display name, description, author,
homepage, repository, the lowest Node the bundle declares (`bundleNodeMinimum`: Claude Desktop runs
it on its own, undocumented Node version), the privacy policy URL (`https://knowtarium.com/privacy`,
a placeholder until that page exists; the Claude Desktop directory requires a real one), and the
platforms whose OS keychain binary goes into the bundle (elsewhere the CLI keeps its key in a
private file).
