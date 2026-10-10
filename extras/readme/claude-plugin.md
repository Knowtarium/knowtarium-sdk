# Knowtarium for Claude Code

[Knowtarium](https://knowtarium.com) keeps a team's knowledge as end-to-end encrypted notes that
people and agents work on together. This plugin connects Claude Code to your Knowtarium workspace:
Claude can search and read your notes, write them (or propose changes where a folder asks for
approval), and check a person's edits against related notes.

## Install

```text
/plugin marketplace add Knowtarium/knowtarium-plugins
/plugin install knowtarium@knowtarium
```

On Claude Code 2.1.275 or later, one line does both:
`/plugin install knowtarium --marketplace Knowtarium/knowtarium-plugins`. From a shell (Claude
Code 2.1.292 or later): `claude plugin install knowtarium --marketplace Knowtarium/knowtarium-plugins`.

Then connect this computer once: ask Claude to connect Knowtarium, or run
`npx knowtarium connect --no-agents` in a terminal, from your home folder (the plugin already adds
the server). Either way your browser opens, you sign in and approve this computer, and no password,
token or key goes in Claude's settings. You need Node.js 20 or later.

If you ran `npx knowtarium connect` with knowtarium 0.1.2 or earlier, Claude Code has a Knowtarium
entry of its own too. Run `npx knowtarium@latest agents` once, from your home folder, to bring it up
to date (older versions ran npx in the project folder), or run
`claude mcp remove --scope user knowtarium` to keep only the plugin's.

## What it adds

- **The `knowtarium` MCP server**: the tools Claude uses to search, read, write and check notes.
- **A skill for working in a Knowtarium workspace** (`knowtarium-conventions`): how it works, how Claude's changes
  land, and how to check a person's edit.

## What it runs, sends and stores

- **It runs** `node ${CLAUDE_PLUGIN_ROOT}/server/launch.mjs -y knowtarium@{{version}} mcp` (see
  `.mcp.json`). The launcher, a small script in this plugin, runs `npx -y knowtarium@{{version}} mcp`
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
  opens `app.knowtarium.com` in your browser so you can approve this computer. Your IP address
  reaches the API with each request; the API doesn't record it. Whatever Claude reads goes to its AI
  provider under that provider's terms, like anything else you give it.
- **It stores** the connection, encrypted, in your app data folder, with its key in the OS
  keychain (or, where there is none, in a file only you can read), and an encrypted local copy of
  your notes.
- **On Windows**, Claude Code looks for the `node` above in the project folder first, so a
  `node.exe` placed in a project you open would start instead of Node.js. For the hardened setup on
  Windows, run `npx knowtarium agents` from your home folder instead of using this plugin: the
  entry it writes names `cmd.exe` by its full path and runs npx from your home folder too.
- **People stay in charge**: Claude's changes are signed as its own and can be undone, folders can
  ask for approval first, and Claude can't delete notes or mark a note as checked by a person.
  Note text, comments and diffs reach Claude as data to read, never as instructions to follow.

## Versions

Plugin version {{version}} runs `knowtarium` {{version}}: each release of the plugin pins the
release of the package it was tested with. To update, refresh the marketplace, then the plugin, and
restart Claude Code:

```sh
claude plugin marketplace update knowtarium
claude plugin update knowtarium@knowtarium
```

Inside Claude Code, `/plugin marketplace update knowtarium`, then `/plugin` and **Update now**,
does the same.

## Links

- [Privacy policy]({{privacyPolicy}})
- [Security](https://knowtarium.com/security)
- [Terms]({{termsOfService}})
- [Source code]({{repository}})
- [Report a problem]({{support}}) or write to {{email}}

MIT licensed, see [LICENSE](LICENSE).
