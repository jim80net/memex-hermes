#!/bin/sh
# Downloads the prebuilt memex-hermes binary for the current platform.
# Usage: ./bin/install.sh [version]
#   version defaults to "latest"
#
# Source release: https://github.com/jim80net/memex-hermes/releases
# Asset naming:   memex-hermes-<os>-<arch>.{tar.gz,zip}
# Verification:   checksums.txt (sha256 + asset name) bundled with the release
set -e

REPO="jim80net/memex-hermes"
VERSION="${1:-latest}"
DIR="$(cd "$(dirname "$0")" && pwd)"

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux*)  PLATFORM_OS="linux" ;;
    Darwin*) PLATFORM_OS="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM_OS="win32" ;;
    *)
      echo "Unsupported OS: $OS" >&2
      exit 1
      ;;
  esac

  case "$ARCH" in
    x86_64|amd64) PLATFORM_ARCH="x64" ;;
    aarch64|arm64) PLATFORM_ARCH="arm64" ;;
    *)
      echo "Unsupported architecture: $ARCH" >&2
      exit 1
      ;;
  esac

  echo "${PLATFORM_OS}-${PLATFORM_ARCH}"
}

PLATFORM="$(detect_platform)"
echo "Detected platform: $PLATFORM" >&2

# Only the platforms the release CI actually builds have published binaries.
# Keep this list in lockstep with build.ts PLATFORMS and the release-please.yml
# `build` matrix. darwin-x64 (Intel Mac) and win32-arm64 are NOT built yet, so
# we fail fast with a clear message instead of 404-ing on a missing asset.
case "$PLATFORM" in
  linux-x64|linux-arm64|darwin-arm64|win32-x64) ;;
  *)
    echo "Unsupported platform: $PLATFORM. Prebuilt binaries are published for" \
         "linux-x64, linux-arm64, darwin-arm64, win32-x64." >&2
    exit 1
    ;;
esac

if [ "$PLATFORM_OS" = "win32" ]; then
  ASSET="memex-hermes-${PLATFORM}.zip"
else
  ASSET="memex-hermes-${PLATFORM}.tar.gz"
fi

if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi

URL="${BASE_URL}/${ASSET}"
CHECKSUM_URL="${BASE_URL}/checksums.txt"

# Download helper with 12-second timeout (fits within hook's 15s timeout)
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --max-time 12 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=12 -O "$2" "$1"
  else
    echo "Neither curl nor wget found. Install one and retry." >&2
    exit 1
  fi
}

echo "Downloading $URL..." >&2
TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT
download "$URL" "$TMPFILE"

# Verify checksum. Per the hermes-plugin-packaging "SHA256 mismatch aborts
# the install" Scenario, a hard mismatch is a fatal error; a missing
# checksums.txt (older release) degrades to a warning so the install
# continues — older artifacts predate the checksum convention.
CHECKSUM_FILE="$(mktemp)"
trap 'rm -f "$TMPFILE" "$CHECKSUM_FILE"' EXIT
if download "$CHECKSUM_URL" "$CHECKSUM_FILE" 2>/dev/null; then
  EXPECTED_HASH="$(grep "  ${ASSET}$" "$CHECKSUM_FILE" | cut -d' ' -f1)"
  if [ -n "$EXPECTED_HASH" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL_HASH="$(sha256sum "$TMPFILE" | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL_HASH="$(shasum -a 256 "$TMPFILE" | cut -d' ' -f1)"
    else
      ACTUAL_HASH=""
      echo "Warning: no sha256sum or shasum available, skipping checksum verification" >&2
    fi
    if [ -n "$ACTUAL_HASH" ] && [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
      echo "Checksum mismatch! Expected $EXPECTED_HASH, got $ACTUAL_HASH" >&2
      exit 1
    fi
    echo "Checksum verified." >&2
  fi
else
  echo "Warning: checksums.txt not available, skipping verification" >&2
fi

# Extract to a temp directory under $DIR for atomic same-filesystem mv.
EXTRACT_DIR="$(mktemp -d "$DIR/.install-XXXXXX")"
trap 'rm -rf "$TMPFILE" "$CHECKSUM_FILE" "$EXTRACT_DIR"' EXIT

echo "Extracting to $DIR..." >&2
case "$ASSET" in
  *.tar.gz) tar -xzf "$TMPFILE" -C "$EXTRACT_DIR" ;;
  *.zip)    unzip -o "$TMPFILE" -d "$EXTRACT_DIR" ;;
esac

# Move the binary as memex.bin so the wrapper script finds it
if [ -f "$EXTRACT_DIR/memex-hermes" ]; then
  mv "$EXTRACT_DIR/memex-hermes" "$DIR/memex.bin"
  chmod +x "$DIR/memex.bin"
elif [ -f "$EXTRACT_DIR/memex-hermes.exe" ]; then
  mv "$EXTRACT_DIR/memex-hermes.exe" "$DIR/memex.exe"
  chmod +x "$DIR/memex.exe" 2>/dev/null || true
fi

# Copy ONNX shared libraries alongside the binary
for lib in "$EXTRACT_DIR"/*.so* "$EXTRACT_DIR"/*.dylib "$EXTRACT_DIR"/*.dll; do
  [ -f "$lib" ] && cp "$lib" "$DIR/"
done

echo "Installed memex-hermes ($PLATFORM) version ${VERSION} to $DIR" >&2
