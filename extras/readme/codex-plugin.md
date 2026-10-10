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

Or add the marketplace, then install Knowtarium from the Plugins Directory in the app. Then connect
this computer once: run `npx knowtarium connect` in a terminal, or ask Codex to connect Knowtarium.
Either way your browser opens, you sign in and approve this computer, and no password, token or key
goes in Codex's settings. You need Node.js 20 or later.

## What it adds

- **The `knowtarium` MCP server**: the tools Codex uses to search, read, write and check notes.
- **The `knowtarium-conventions` skill**: how a Knowtarium workspace works, how Codex's changes
  land, and how to check a person's edit.

## What it runs, sends and stores

- **It runs** `node ${PLUGIN_ROOT}/server/launch.mjs`, a small launcher in this plugin. The
  launcher runs `npx -y knowtarium@{{version}} mcp` (through `cmd /c` on Windows): npx downloads
  the open source [`knowtarium`](https://www.npmjs.com/package/knowtarium) package at exactly
  version {{version}}, with the dependency versions its shrinkwrap pins, from your npm registry, and
  starts its MCP server on stdio. Its source is at {{repository}}.
- **It sends** encrypted data only, and only to the Knowtarium sync API at `{{apiHost}}`. Notes,
  file and folder names, comments and history are encrypted and decrypted on this computer
  (XChaCha20-Poly1305 with libsodium); Knowtarium's servers store ciphertext they can't read.
  Connecting opens `app.knowtarium.com` in your browser so you can approve this computer.
- **It stores** the connection, encrypted, in your app data folder, with its key in the OS
  keychain (or, where there is none, in a file only you can read), and an encrypted local copy of
  your notes.
- **People stay in charge**: Codex's changes are signed as its own and can be undone, folders can
  ask for approval first, and Codex can't delete notes or mark a note as verified by a person.
  Note text, comments and diffs reach Codex as data to read, never as instructions to follow.

## Versions

Plugin version {{version}} runs `knowtarium` {{version}}. Each release of the plugin pins the
release of the package it was tested with; `codex plugin marketplace upgrade knowtarium` fetches a
new one.

## Links

- [Privacy policy]({{privacyPolicy}})
- [Terms]({{termsOfService}})
- [Source code]({{repository}})
- [Report a problem]({{support}}) or write to {{email}}

MIT licensed, see [LICENSE](LICENSE).
