# Security

## Supported versions

Only `main` is supported. Fixes land there, and there are no release branches.

## Reporting a vulnerability

Report it privately, through the repository's "Report a vulnerability" button
on the Security tab (GitHub's private vulnerability reporting). Please don't
describe it in a public pull request.

## Scope

In scope:

- `lotuspod serve`;
- the Cloudflare Access check, in `src/lotuspod/access.py`;
- the agent socket and its credentials;
- the page policy, what a published page may run.

Out of scope:

- someone else's deployment of Lotuspod;
- Cloudflare itself.
