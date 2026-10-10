# Security

Knowtarium is end-to-end encrypted: notes, names, attachments and history are encrypted on your
device, and the server stores your notes only as ciphertext. This repository holds the code that
does it (`src/crypto`, `src/client` and the CLI), so reports about it matter to us. How Knowtarium
protects your data: [knowtarium.com/security](https://knowtarium.com/security).

## Reporting a vulnerability

Please report it privately, never in a public issue: email support@knowtarium.com, with
"Security" in the subject.

Include what you found, how to reproduce it, and the version in your agent's config
(`knowtarium@x.y.z`). We answer within a few working days, keep you posted while we fix it, and
credit you in the release notes if you'd like.

## Known limits

- **The Claude Code plugin on Windows.** Claude Code, like other Node-based clients on Windows,
  looks for the plugin's `node` in the project folder first, so a `node.exe` placed in a project
  you open would start instead of Node.js. On Windows, `npx knowtarium agents` gives the hardened
  setup: it names `cmd.exe` by its full path and runs npx from your home folder.
- **Commands you type.** `npx knowtarium connect` and `npx knowtarium@latest agents` run npx in
  the terminal's current folder, where npm trusts what the folder contains (a `node_modules` or
  `.npmrc` a project planted). Run them from your home folder, not from inside a project.
- **MCP registry installs.** An agent that installs Knowtarium from a registry listing writes a
  bare `npx knowtarium@<version> mcp`, which runs in the project folder, where npm trusts what the
  project contains. Use `npx knowtarium agents`, the plugins or the Claude Desktop extension.

## Supported versions

Only the latest release on npm gets security fixes. Run `npx knowtarium@latest agents` from your
home folder to update the version your agents use; knowtarium asks you to update when Knowtarium
stops supporting your version.
