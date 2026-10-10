<h1 align="center">
  <img alt="Knowtarium" src="https://raw.githubusercontent.com/Knowtarium/knowtarium-sdk/main/.github/assets/logo.png" width="420">
</h1>

Connect your AI agents to your [Knowtarium](https://knowtarium.com) workspace, end-to-end
encrypted.

Knowtarium keeps a team's knowledge as notes in the Open Knowledge Format (OKF): plain Markdown
files with a little frontmatter that people and agents both read. `knowtarium` is the command-line
tool that connects this computer to a workspace and adds Knowtarium to Claude Code, Claude
Desktop, Cursor, Codex and OpenCode. Agents can then search and read the notes, change them (saved
at once and signed as the agent's, or proposed for a person's approval in folders that ask for
it), and check a person's edits against related notes. Your notes are decrypted
only on your devices, never on Knowtarium's servers.

## Install

You need Node.js 20 or later (22 or 24 recommended). Then, in a terminal:

```sh
npx knowtarium connect
```

This opens your browser so you can approve this computer in your workspace. Then it lists the
agents it finds, all ticked: press Enter to add Knowtarium to all of them, or untick some first
(arrows move, space toggles, `a` toggles all, Esc adds none). Restart an agent after adding it so
it picks up the new server.

To keep the command around, install it globally with `npm install -g knowtarium` and run
`knowtarium connect`.

**Claude Desktop** can also run the Knowtarium extension, which needs no terminal or Node.js:
download
[knowtarium.mcpb](https://github.com/Knowtarium/knowtarium-sdk/releases/latest/download/knowtarium.mcpb)
(checksums in each [release](https://github.com/Knowtarium/knowtarium-sdk/releases)), open it,
then ask Claude to connect Knowtarium. **Claude Code** and **Codex** can also use the Knowtarium
plugin from [knowtarium-plugins](https://github.com/Knowtarium/knowtarium-plugins):

```sh
# Claude Code
/plugin marketplace add Knowtarium/knowtarium-plugins
/plugin install knowtarium@knowtarium
# Codex
codex plugin marketplace add Knowtarium/knowtarium-plugins
codex plugin add knowtarium@knowtarium
```

All of them run the same server as `npx knowtarium connect` sets up.

## Commands

| Command                                             | What it does                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `connect [--no-agents] [--yes] [--dry-run]`         | Connect this computer to a workspace (opens the browser), then set up agents     |
| `agents [--yes] [--dry-run] [--agent <id>]...`      | Add Knowtarium to `claude-code`, `claude-desktop`, `cursor`, `codex`, `opencode` |
| `status [--offline] [--json]`                       | Show the connected workspaces, their access and changes, token and local cache   |
| `disconnect [--workspace <id>] [--all]`             | Revoke this computer's access and delete its local keys and cache                |
| `convert <vault> <out> --person <name> [--dry-run]` | Convert an Obsidian vault into an OKF bundle in a new folder, offline            |
| `validate <folder> [--strict] [--json]`             | Check a folder of OKF notes, offline                                             |
| `mcp [--actor <producer/version>] [--no-live]`      | Run the MCP server on stdio (agents start this themselves)                       |

Run `knowtarium help`, or `knowtarium <command> --help`, for details. `login` is the same as
`connect`.

`agents` only adds or updates Knowtarium's own entry in each agent's settings. Other servers and
settings stay as they are, the previous file is backed up next to it, and `--dry-run` shows the
changes without writing anything.

`convert` and `validate` work without an account. `convert` only reads your vault: it writes a
new folder with the converted notes, an `index.md` per folder and a report of everything it
renamed, linked or left out. `validate` checks paths, frontmatter, required fields and links.

If `knowtarium` says to update, run `npx knowtarium@latest agents`. It points your agents at the
new version. Then restart them.

## How your data is protected

- **Encrypted on your devices.** Notes, file names, folder names, comments and history are
  encrypted before they leave your computer (XChaCha20-Poly1305 with libsodium). The server stores
  ciphertext and can't read it.
- **Connecting needs your approval.** `connect` shows a page in the web app where you approve this
  computer. The workspace key is sealed to a key pair made on this computer, and the owner's
  signatures are checked before it is accepted. When the browser can't reach the terminal (over
  SSH, say), you confirm a matching code in both places.
- **Keys stay local.** The connection is stored encrypted, with its key in the OS keychain (macOS
  Keychain, Windows Credential Manager or the Secret Service on Linux). Where there is no keychain,
  the key goes in a file only you can read, and `status` says so.
  The agent's signing key for direct changes is sealed in a file of its own (`agent-keys.enc`), so
  an agent still set up with an older `knowtarium` keeps reading its connections. Connecting a
  workspace again revokes the token it replaces.
- **People stay in charge.** By default an agent's change is saved at once, signed with a key made
  on this computer that the workspace owner vouched for when approving it; the web app shows it as
  the agent's, and a person can undo it. Where a workspace or folder asks for approval, the change
  is a proposal a person approves first. Agents can't delete notes, can never mark a note as
  verified by a person, and a note reaches them only after its version's signature is checked
  against the workspace owner's key.
- **Limited access.** You can connect an agent read-only or only to some folders. `disconnect`, or
  the web app's settings, revokes access at any time.

Note text, comments and diffs reach the agent as data to read, never as instructions to follow.
More on how Knowtarium protects your data:
[knowtarium.com/security](https://knowtarium.com/security). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Settings

| Variable              | What it changes                                                             |
| --------------------- | --------------------------------------------------------------------------- |
| `KNOWTARIUM_HOME`     | Where the connection and trust records live (default: your app data folder) |
| `KNOWTARIUM_CACHE`    | Where the encrypted local copy of your notes lives                          |
| `KNOWTARIUM_KEYCHAIN` | `off` keeps the key in a private file instead of the OS keychain            |

## Links

- [Knowtarium](https://knowtarium.com)
- [Privacy policy](https://knowtarium.com/privacy)
- [Security](https://knowtarium.com/security)
- [Report a problem](https://knowtarium.com/support)
- [DEVELOPING.md](DEVELOPING.md): how the package is built, the SDK it also ships
  (`knowtarium/crypto`, `/protocol`, `/core`, `/client`) and how to work on it
