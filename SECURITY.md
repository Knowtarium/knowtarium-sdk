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

## Supported versions

Only the latest release on npm gets security fixes. Run `npx knowtarium@latest agents` to update
the version your agents use; knowtarium asks you to update when Knowtarium stops supporting your
version.
