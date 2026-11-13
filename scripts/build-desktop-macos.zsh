#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"

if (( $# > 1 )) || [[ "${1:-}" != "" && "$1" != "--dmg" ]]; then
  print -u2 'Usage: build-desktop-macos.zsh [--dmg]'
  exit 2
fi

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  print -u2 'Build this version on an Apple silicon Mac.'
  exit 1
fi

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
export GENERATE_SOURCEMAP=false
export CSC_IDENTITY_AUTO_DISCOVERY=false
export PYTHONPATH="$PWD/translation-agent/src"

yarn install --frozen-lockfile --ignore-scripts --ignore-optional
node scripts/rebuild-desktop-sqlite.mjs
binding=node_modules/better-sqlite3/build/Release/better_sqlite3.node
if [[ ! -f "$binding" ]] || ! lipo -verify_arch arm64 "$binding"; then
  print -u2 "Missing arm64 SQLite binding after rebuild: $binding"
  exit 1
fi
yarn build

uv sync --project translation-agent --locked --python 3.12
uv run --project translation-agent --locked --with pyinstaller==6.16.0 \
  pyinstaller --noconfirm --distpath dist/translation-runtime \
  --workpath dist/pyinstaller koodo-translation.spec

./node_modules/.bin/electron-builder --mac dir --arm64 --publish never \
  --config scripts/desktop-macos.cjs

out="$PWD/dist/mac-arm64"
staged=$(mktemp -d "$PWD/dist/.sign.XXXXXX")
product=$(node -p 'require("./scripts/desktop-macos.cjs").productName')
app="$product.app"
verify_sqlite() {
  local bundle="$1"
  if [[ ! -f "$bundle/Contents/Resources/app.asar.unpacked/$binding" ]]; then
    print -u2 "Missing SQLite binding in packaged app: $bundle"
    return 1
  fi
  ELECTRON_RUN_AS_NODE=1 "$bundle/Contents/MacOS/$product" -e '
    const path = require("node:path");
    const Database = require(path.join(process.argv[1], "Contents/Resources/app.asar/node_modules/better-sqlite3"));
    const db = new Database(":memory:");
    try {
      if (db.prepare("SELECT 1 AS ready").get().ready !== 1) {
        throw new Error("Packaged SQLite query failed");
      }
    } finally {
      db.close();
    }
  ' "$bundle"
}
ditto --noextattr --norsrc "$out/$app" "$staged/$app"
codesign --force --deep --sign - "$staged/$app"
codesign --verify --deep --strict "$staged/$app"
verify_sqlite "$staged/$app"
mv "$out/$app" "$staged/unsigned.app"
if ! mv "$staged/$app" "$out/$app"; then
  mv "$staged/unsigned.app" "$out/$app"
  exit 1
fi
print "$out/$app"

if [[ "${1:-}" == "--dmg" ]]; then
  version=$(node -p 'require("./package.json").version')
  revision=$(git rev-parse --short=12 HEAD)
  image="$PWD/dist/${product// /-}-$version-$revision-arm64.dmg"
  mkdir "$staged/dmg"
  ditto --noextattr --norsrc "$out/$app" "$staged/dmg/$app"
  ln -s /Applications "$staged/dmg/Applications"
  hdiutil create -ov -format UDZO -fs HFS+ -volname "$product" \
    -srcfolder "$staged/dmg" "$image"
  hdiutil verify "$image"
  mount=$(mktemp -d "$staged/mount.XXXXXX")
  hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$image"
  trap 'hdiutil detach "$mount"' EXIT
  codesign --verify --deep --strict "$mount/$app"
  verify_sqlite "$mount/$app"
  test -x "$mount/$app/Contents/Resources/translation-runtime/koodo-translation"
  test "$(readlink "$mount/Applications")" = /Applications
  hdiutil detach "$mount"
  trap - EXIT
  print "$image"
fi
