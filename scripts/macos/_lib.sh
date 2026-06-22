#!/usr/bin/env bash
# Shared helpers for macOS component scripts.
have() { command -v "$1" >/dev/null 2>&1; }
dl()   { curl -fsSL "$1" -o "$2"; }
# Run a shell command with a native macOS admin (GUI password) prompt.
admin_run() { /usr/bin/osascript -e "do shell script \"$*\" with administrator privileges"; }
arch_tag() { case "$(uname -m)" in arm64) echo arm64 ;; *) echo x64 ;; esac; }
