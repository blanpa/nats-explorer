---
layout: default
title: Privacy
nav_order: 9
---

# Privacy

NATS Explorer collects no data about you or your use of it. It has no
analytics, no telemetry and no crash reporting, and it has no account to sign
in to. This applies to the desktop app from every source (GitHub, Flathub,
the Microsoft Store, winget) and to the server binary and the Docker image.

## What it connects to

- **The servers you add**: NATS servers, their monitoring endpoints, SSH
  bastions and, on a server installation, the identity provider set in
  `OIDC_ISSUER`. Nothing goes anywhere else.
- **GitHub, once a day**: a request for the newest release, so the status
  bar can say when there is one. It sends nothing but the request itself;
  GitHub sees the address it comes from, as with any download (see
  [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).
  It can be switched off under *Settings → Updates*. When you choose
  **Update** in the desktop app, it downloads that release's files from
  GitHub as well. Installations from Flathub or the Microsoft Store do
  neither: the store brings the updates.

## What it keeps, and where

Everything stays on your computer, or on the machine the server binary runs on:

- connections, request templates and preferences in `settings.json`,
- credentials (passwords, tokens, NKey seeds, credentials files, TLS keys) in
  the system keyring, or in `secrets.json` readable only by your user where
  there is no keyring,
- the recorded messages in `history.db`, kept for 3 days by default, which
  can be shortened, switched off or deleted in the settings,
- an `audit.log` of the changes made through it (what was changed, when, and
  on a server with accounts by whom).

The [Installation]({{ site.baseurl }}{% link installation.md %}) page lists the
directories. Deleting the directory removes all of it.

## Questions

Open an [issue](https://github.com/blanpa/nats-explorer/issues) on GitHub.
