<h1 align="center">
  <img alt="Knowtarium" src="https://raw.githubusercontent.com/Knowtarium/knowtarium-sdk/main/.github/assets/logo.png" width="420">
</h1>

Connect your AI agents to your [Knowtarium](https://knowtarium.com) workspace, end-to-end
encrypted.

Knowtarium keeps a team's knowledge as notes in the Open Knowledge Format (OKF): plain Markdown
files with a little frontmatter that people and agents both read. `knowtarium` is the command-line
tool that connects this computer to a workspace and adds Knowtarium to Claude Code, Codex,
Cursor, OpenCode and Claude Desktop. Agents can then search and read the notes, change them (saved
at once and signed as the agent's, or proposed for a person's approval in folders that ask for
it), and check a person's edits against related notes. Your notes are decrypted
only on your devices, never on Knowtarium's servers.

## Install

You need Node.js 20 or later (22 or 24 recommended). Then, in a terminal, from your home folder
(npx trusts the folder it runs in, so not from inside a project):

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
then ask Claude to connect Knowtarium. Claude Desktop shows the extension's tools, icon and support
links. **Claude Code** and **Codex** can also use the Knowtarium plugin from
[knowtarium-plugins](https://github.com/Knowtarium/knowtarium-plugins), which adds the server and a
skill for working in a Knowtarium workspace (`knowtarium-conventions`):

```sh
# Claude Code
/plugin marketplace add Knowtarium/knowtarium-plugins
/plugin install knowtarium@knowtarium
# or, from a shell (Claude Code 2.1.292 or later)
claude plugin install knowtarium --marketplace Knowtarium/knowtarium-plugins
# Codex
codex plugin marketplace add Knowtarium/knowtarium-plugins
codex plugin add knowtarium@knowtarium
```

All of them run the same server as `npx knowtarium connect` sets up. With a plugin, connect this
computer by asking your agent to connect Knowtarium, or with `npx knowtarium connect --no-agents`:
the plugin already adds the server (`connect` and `agents` leave an agent with the plugin unticked,
so it doesn't run twice, but always update an entry of its own that an earlier `connect` added,
and say how to remove it).

On Windows, Claude Code (like other Node-based clients) looks for the plugin's `node` in the
project folder first, so a `node.exe` placed in a project you open would start instead of Node.js.
For the hardened setup on Windows, use `npx knowtarium agents` instead of the Claude Code plugin:
the entry it writes names `cmd.exe` by its full path. Knowtarium isn't in the MCP Registry yet: an
agent that installs servers from a registry writes a bare `npx knowtarium@<version> mcp`, which
runs npx in the project folder, so use one of the ways above.

## Commands

| Command                                             | What it does                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `connect [--no-agents] [--yes] [--dry-run]`         | Connect this computer to a workspace (opens the browser), then set up agents     |
| `agents [--yes] [--dry-run] [--agent <id>]...`      | Add Knowtarium to `claude-code`, `codex`, `cursor`, `opencode`, `claude-desktop` |
| `status [--offline] [--json]`                       | Show the connected workspaces, their access and changes, token and local cache   |
| `disconnect [--workspace <id>] [--all]`             | Revoke this computer's access and delete its local keys and cache                |
| `convert <vault> <out> --person <name> [--dry-run]` | Convert an Obsidian vault into an OKF bundle in a new folder, offline            |
| `validate <folder> [--strict] [--json]`             | Check a folder of OKF notes, offline                                             |
| `mcp [--actor <producer/version>] [--no-live]`      | Run the MCP server on stdio (agents start this themselves)                       |

Run `knowtarium help`, or `knowtarium <command> --help`, for details. `login` is the same as
`connect`.

`agents` only adds or updates Knowtarium's own entry in each agent's settings (Claude Code's in
`$CLAUDE_CONFIG_DIR` and Codex's in `$CODEX_HOME` when you set those). Other servers and settings
stay as they are, the previous file is backed up next to it, and `--dry-run` shows the changes
without writing anything. The entry runs npx from your home folder, never from the project an
agent has open, so a project can't swap in its own code for Knowtarium's.

`convert` and `validate` work without an account. `convert` only reads your vault: it writes a
new folder with the converted notes, an `index.md` per folder and a report of everything it
renamed, linked or left out. `validate` checks paths, frontmatter, required fields and links.

If `knowtarium` says to update, run `npx knowtarium@latest agents` from your home folder. It points
your agents at the new version. Then restart them.

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
  is a proposal a person approves first. Agents can't delete notes or mark a note as checked by a
  person, and a note reaches them only after its version's signature is checked against the
  workspace owner's key.
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
- [Report a problem](https://github.com/Knowtarium/knowtarium-sdk/issues) or write to
  support@knowtarium.com
- [DEVELOPING.md](DEVELOPING.md): how the package is built, the SDK it also ships
  (`knowtarium/crypto`, `/protocol`, `/core`, `/client`) and how to work on it
