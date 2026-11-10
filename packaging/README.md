# Store packaging

Where the desktop app is published besides the GitHub release, what each
channel needs once, and how it is kept up to date. Every channel here is free.

| Channel | App ID | Built by | Updated by |
|:-- |:-- |:-- |:-- |
| Flathub | `io.github.blanpa.nats-explorer` | `flatpak` job, `scripts/flatpak.sh` | `flathub` job: a pull request to the Flathub repository |
| Microsoft Store | Partner Center product identity | `desktop-windows` job, `scripts/build-msix.ps1` | upload of the `store-msix` artifact in Partner Center |
| winget | `blanpa.NATSExplorer` | the NSIS installer of the release | `winget` job: a pull request to `microsoft/winget-pkgs` |

macOS stays a direct download (DMG): the Mac App Store and notarization both
need the paid Apple Developer Program.

Installations from Flathub and the Microsoft Store report themselves as such
(`distribution` in `/api/app`, detected at runtime), and the UI leaves updates
to the store instead of looking on GitHub.

## Flathub

Flathub builds from source without network access. `scripts/flatpak.sh`
lists everything the build downloads: the Go modules from `go.sum` (served to
`go build` as a `file://` module proxy) and the npm packages of the UI,
resolved by npm from the same `package.json` files (Bun's lockfile has no
Flatpak tooling). The runtime is GNOME 51, which has webkit2gtk-4.1.

```bash
scripts/flatpak.sh build            # local test build in Flathub's image (Docker), then the smoke test
scripts/flatpak.sh flathub v0.7.0   # the files for the Flathub repository, built from the tag
```

First submission (once):

1. Log in on [flathub.org](https://flathub.org) with the GitHub account
   `blanpa`; that verifies the `io.github.blanpa` prefix.
2. Fork [flathub/flathub](https://github.com/flathub/flathub), create a branch
   from `new-pr`, put the output of `scripts/flatpak.sh flathub <tag>` in its
   root and open a pull request against `new-pr`, as the
   [submission guide](https://docs.flathub.org/docs/for-app-authors/submission) describes.
   `bot, build` in a comment starts a test build.
3. After review, Flathub creates `flathub/io.github.blanpa.nats-explorer`
   with you as maintainer.

Afterwards: a token that can push branches to that repository as the
secret `FLATHUB_TOKEN`, and the repository variable `FLATHUB_ENABLED=true`.
Each tag then opens an update pull request there; merging it publishes.

## Microsoft Store

The Store takes the MSIX and signs it itself, so no certificate is needed,
and Store installations show no SmartScreen warning.

First submission (once):

1. Register a free individual developer account in
   [Partner Center](https://partner.microsoft.com/dashboard) (identity
   check with an ID document).
2. Reserve the name *NATS Explorer* (Apps and games → New product → MSIX or
   PWA app). If the name is refused because of the NATS trademark, a name
   like *Explorer for NATS* works the same way; only the listing changes.
3. Product identity shows `Package/Identity/Name`,
   `Package/Identity/Publisher` and `Package/Properties/PublisherDisplayName`.
   Put them into the repository variables `MSIX_IDENTITY_NAME`,
   `MSIX_PUBLISHER` and `MSIX_PUBLISHER_DISPLAY_NAME`.
4. Run the release workflow (a tag, or `workflow_dispatch` for a test) and
   download the `store-msix` artifact.
5. Create a submission: upload the `.msix`, category *Developer tools*,
   privacy policy URL https://blanpa.github.io/nats-explorer/privacy.html,
   screenshots from `docs/screenshots/`, the capability `runFullTrust`
   explained as "a desktop app that connects to NATS servers".

Each later release: a new submission with the new `store-msix` artifact.
The version has to grow with every upload; it is the release's X.Y.Z.0.

## winget

The package points at the NSIS installer of the GitHub release (per-user,
silent install with `/S`, installer type `nullsoft`, product code `NATS ExplorerNATS Explorer`).

First submission (once): a pull request to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) with the
manifests for the current release, made with
[Komac](https://github.com/russellbanks/Komac) or `wingetcreate new
<installer URL>`.

Afterwards: fork `microsoft/winget-pkgs` under `blanpa`, a classic token with
the `public_repo` and `workflow` scopes as the secret `WINGET_TOKEN`, and the
repository variable `WINGET_ENABLED=true`. Each tag then opens the update
pull request.

## With every release

The release commit adds the version to the `<releases>` of
`go-server/build/linux/io.github.blanpa.nats-explorer.metainfo.xml`;
`scripts/check-packaging.sh` (CI) fails when the newest changelog version is
missing there.
