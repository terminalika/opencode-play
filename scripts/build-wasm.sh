#!/usr/bin/env sh
# Builds the pi build of terminalika into wasm/.
#
#   npm run build:wasm
#
# Needs Go 1.24+. Source of the games, in order of preference:
#   1. a sibling checkout ../../terminalika-core (the usual terminalika/
#      layout), through a throwaway go.work, so the newest games ship even
#      before they are tagged;
#   2. otherwise the published terminalika-core pinned in go/go.mod.
# The output is committed, so this only has to run for newer games or engine
# changes.
set -eu
cd "$(dirname "$0")/../go"
src_dir=$(pwd)
out="$src_dir/../wasm"
mkdir -p "$out"

core_dir="$src_dir/../../terminalika-core"
if [ -d "$core_dir" ] && [ -f "$core_dir/go.mod" ]; then
	core_dir=$(cd "$core_dir" && pwd)
	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	printf 'go 1.24.0\n\nuse (\n\t%s\n\t%s\n)\n' "$src_dir" "$core_dir" > "$work/go.work"
	export GOWORK="$work/go.work"
	source="sibling checkout $core_dir @ $(git -C "$core_dir" rev-parse --short HEAD 2>/dev/null || echo '?')$(git -C "$core_dir" diff --quiet 2>/dev/null || echo ' (dirty)')"
else
	export GOWORK=off
	source="published $(go list -m github.com/terminalika/terminalika-core)"
fi

GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/terminalika.wasm" .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"
chmod 644 "$out/terminalika.wasm" "$out/wasm_exec.js"

{
	echo "built:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "go:     $(go version | cut -d' ' -f3)"
	echo "core:   $source"
	echo "tcell:  $(go list -m github.com/gdamore/tcell/v2 | cut -d' ' -f2)"
} > "$out/build-info.txt"

cat "$out/build-info.txt"
ls -la "$out/terminalika.wasm"
