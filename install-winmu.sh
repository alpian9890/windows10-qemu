#!/usr/bin/env bash
set -euo pipefail

OWNER="${OWNER:-alpian9890}"
REPO="${REPO:-windows10-qemu}"
TAG="${TAG:-assets}"
ASSET="${ASSET:-winmu-linux-x64}"
TARGET="${TARGET:-/usr/bin/winmu}"
TMP_FILE="$(mktemp)"

cleanup() {
  rm -f "$TMP_FILE"
}

trap cleanup EXIT

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Script installer harus dijalankan sebagai root." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  echo "curl atau wget wajib tersedia." >&2
  exit 1
fi

URL="https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${ASSET}"

echo "Mengunduh ${ASSET} dari GitHub Release..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TMP_FILE" "$URL"
else
  wget -qO "$TMP_FILE" "$URL"
fi

install -m755 "$TMP_FILE" "$TARGET"
echo "winmu terpasang di ${TARGET}"
