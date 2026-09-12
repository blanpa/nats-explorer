---
layout: default
title: License
nav_order: 7
---

# License

NATS Explorer is licensed under the
[GNU Affero General Public License v3.0 or later](https://github.com/blanpa/nats-explorer/blob/main/LICENSE).
Copyright 2026 blanpa.

---

## In short

| You want to | |
|:--|:--|
| Use it, at work or at home | Yes, no conditions |
| Run the server for your team, internally | Yes, no conditions |
| Read, change and build the source for yourself | Yes |
| Ship a changed version to others | Yes -- under the AGPL, with your changes' source |
| Offer a changed version as a hosted service | Yes -- its users have to be able to get that source |
| Put it into a closed-source product | Not under this license -- [ask](https://github.com/blanpa/nats-explorer/issues) |

The one obligation the AGPL adds over the GPL is the last two rows: for software
reached over a network, *using* it counts as receiving it. If you modify NATS
Explorer and let other people use that version -- as a download or as a URL --
those people have to be able to get the modified source under the same license.
An unmodified deployment inside your own organisation triggers nothing at all.

{: .note }
This page is a summary written for orientation, not legal advice. Only the
[license text](https://github.com/blanpa/nats-explorer/blob/main/LICENSE) is
binding.

---

## If you host a modified version

Set `SOURCE_URL` to where your source is, and the "source" link in the status bar
and the login dialog points there instead of at this project:

```bash
SOURCE_URL=https://git.example.org/ops/nats-explorer
```

That link is how the users of your deployment get the source, which is what
section 13 asks for. Packagers can stamp the same value into the binary with
`-ldflags "-X main.defaultSource=…"`. An unmodified deployment needs nothing: the
link already leads to this project at the commit or release tag the binary was
built from.

---

## The name

"NATS Explorer" and the project's marks are **not** covered by the AGPL. A
modified version has to be distributed under a different name and may not suggest
that it is endorsed by this project. That is the usual split: the code is free,
the name identifies who stands behind a build.

NATS is a trademark of the Linux Foundation / CNCF. This project is not affiliated
with or endorsed by the NATS project.

---

## Contributing

Contributions are licensed under the AGPL v3.0 or later -- see
[CONTRIBUTING.md](https://github.com/blanpa/nats-explorer/blob/main/CONTRIBUTING.md).
Nothing else is asked of you.

---

## Dependencies

NATS Explorer builds on other people's work, all of it under permissive licenses:

| | |
|:--|:--|
| [nats.go](https://github.com/nats-io/nats.go), [nats-server](https://github.com/nats-io/nats-server) | Apache-2.0 |
| [cel-go](https://github.com/cel-expr/cel-go) | Apache-2.0 |
| [chi](https://github.com/go-chi/chi) | MIT |
| [gorilla/websocket](https://github.com/gorilla/websocket) | BSD-2-Clause |
| [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) | BSD-3-Clause |
| [Wails](https://wails.io/) | MIT |
| [React](https://react.dev/), [Zustand](https://zustand.docs.pmnd.rs/), [Radix UI](https://www.radix-ui.com/), [Tailwind CSS](https://tailwindcss.com/), [Lucide](https://lucide.dev/) | MIT |

The full set with versions is in `go-server/go.mod` and the `package.json` files.
Building on Apache and MIT dependencies is what makes the AGPL choice possible;
the reverse -- an Apache project on AGPL dependencies -- would not work.

---

## History

Releases up to and including 0.1.0-alpha.3 were MIT, 0.2.0 was Apache-2.0. Both
grants stand for those releases -- a license already given is not revoked
retroactively. The AGPL applies from the next release on.
