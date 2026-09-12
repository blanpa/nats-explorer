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
# appimagetool as a plain binary (no FUSE needed with --appimage-extract-and-run)
RUN curl -fsSL -o /usr/local/bin/appimagetool https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage \
    && chmod +x /usr/local/bin/appimagetool
WORKDIR /src
