# Knowtarium for Codex

[Knowtarium](https://knowtarium.com) keeps a team's knowledge as end-to-end encrypted notes that
people and agents work on together. This plugin connects Codex to your Knowtarium workspace: Codex
can search and read your notes, write them (or propose changes where a folder asks for approval),
and check a person's edits against related notes.

## Install

```sh
codex plugin marketplace add Knowtarium/knowtarium-plugins
codex plugin add knowtarium@knowtarium
```

Or, once the marketplace is added, type `/plugins` in Codex to open the plugin browser and install
Knowtarium from the `knowtarium` marketplace (Knowtarium isn't in OpenAI's public plugin directory).

Then connect this computer once: ask Codex to connect Knowtarium, or run
`npx knowtarium connect --no-agents` in a terminal (the plugin already adds the server). Either way
your browser opens, you sign in and approve this computer, and no password, token or key goes in
Codex's settings. You need Node.js 20 or later.

If you ran `npx knowtarium connect` before installing the plugin, Codex has a Knowtarium entry of
its own too, which runs instead of the plugin's server. Run `npx knowtarium@latest agents` once to
bring it up to date (older versions ran npx in the project folder), or remove
`[mcp_servers.knowtarium]` from `~/.codex/config.toml` to use the plugin's.

## What it adds

- **The `knowtarium` MCP server**: the tools Codex uses to search, read, write and check notes.
- **A skill for working in a Knowtarium workspace** (`knowtarium-conventions`): how it works, how Codex's changes
  land, and how to check a person's edit.

## What it runs, sends and stores

- **It runs** `node ${PLUGIN_ROOT}/server/launch.mjs -y knowtarium@{{version}} mcp` (see
  `mcp.json`). The launcher, a small script in this plugin, runs `npx -y knowtarium@{{version}} mcp`
  from your home folder, never the project folder (so nothing a project plants in
  `node_modules` or `.npmrc` runs instead), through Windows' own `cmd.exe` on Windows: npx downloads
  the open source [`knowtarium`](https://www.npmjs.com/package/knowtarium) package at exactly
  version {{version}}, with the dependency versions its shrinkwrap pins, from your npm registry, and
  starts its MCP server on stdio. Its source is at {{repository}}.
- **It talks** only to the Knowtarium sync API at `{{apiHost}}`. Note text, file and folder
  names, comments and history are encrypted on this computer before they're sent, and decrypted
  only here (XChaCha20-Poly1305 with libsodium). The API never sees note content or names: it sees
  IDs and how they nest, versions, sizes, timestamps, signatures and public keys, your account
  email, and which agent changed what (the full list: https://knowtarium.com/security). Connecting
  opens `app.knowtarium.com` in your browser so you can approve this computer.
- **It stores** the connection, encrypted, in your app data folder, with its key in the OS
  keychain (or, where there is none, in a file only you can read), and an encrypted local copy of
  your notes.
- **People stay in charge**: Codex's changes are signed as its own and can be undone, folders can
  ask for approval first, and Codex can't delete notes or mark a note as checked by a person.
  Note text, comments and diffs reach Codex as data to read, never as instructions to follow.

## Versions

Plugin version {{version}} runs `knowtarium` {{version}}: each release of the plugin pins the
release of the package it was tested with. To update, refresh the marketplace, then add the plugin
again, which installs the new version:

```sh
codex plugin marketplace upgrade knowtarium
codex plugin add knowtarium@knowtarium
```

## Links

- [Privacy policy]({{privacyPolicy}})
- [Security](https://knowtarium.com/security)
- [Terms]({{termsOfService}})
- [Source code]({{repository}})
- [Report a problem]({{support}}) or write to {{email}}

MIT licensed, see [LICENSE](LICENSE).
