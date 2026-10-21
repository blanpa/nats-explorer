# Mirrors the GitHub "ubuntu-latest" runner closely enough to build and test the
# Linux desktop app and the Windows installer without installing anything on
# the host. Usage: see scripts/build-desktop.sh --docker
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config \
      libgtk-3-dev libwebkit2gtk-4.1-dev \
      nsis xvfb imagemagick x11-apps dpkg-dev file zip \
    && rm -rf /var/lib/apt/lists/*
ARG GO_VERSION=1.26.0
RUN curl -fsSL https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:/root/go/bin:$PATH
RUN go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0
# appimagetool as a plain binary (no FUSE needed with --appimage-extract-and-run),
# with the AppImage runtime next to it, both pinned and checked.
COPY fetch-appimagetool.sh /tmp/fetch-appimagetool.sh
RUN /tmp/fetch-appimagetool.sh /usr/local/bin && rm /tmp/fetch-appimagetool.sh
WORKDIR /src
