# Security

Knowtarium is end-to-end encrypted: notes, names, attachments and history are encrypted on your
device, and the server stores only ciphertext. This repository holds the code that does it
(`src/crypto`, `src/client` and the CLI), so reports about it matter to us.

## Reporting a vulnerability

Please report it privately, never in a public issue:

- through GitHub's private vulnerability reporting: the **Security** tab of this repository,
  then **Report a vulnerability**, or
- by email to support@knowtarium.com, with "Security" in the subject.

Include what you found, how to reproduce it, and the version (`npx knowtarium --version`). We
answer within a few working days, keep you posted while we fix it, and credit you in the release
notes if you'd like.

## Supported versions

Only the latest release on npm gets security fixes. `npx knowtarium` tells you when a newer one is
out.
