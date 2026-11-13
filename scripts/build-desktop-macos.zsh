#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  print -u2 'Build this version on an Apple silicon Mac.'
  exit 1
fi

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
export GENERATE_SOURCEMAP=false
export CSC_IDENTITY_AUTO_DISCOVERY=false
export PYTHONPATH="$PWD/translation-agent/src"

yarn install --frozen-lockfile --ignore-scripts --ignore-optional
./node_modules/.bin/electron-rebuild -f -o better-sqlite3
yarn build

uv sync --project translation-agent --locked --python 3.12
uv run --project translation-agent --locked --with pyinstaller==6.16.0 \
  pyinstaller --noconfirm --distpath dist/translation-runtime \
  --workpath dist/pyinstaller koodo-translation.spec

./node_modules/.bin/electron-builder --mac dir --arm64 --publish never \
  --config scripts/desktop-macos.cjs

out="$PWD/dist/mac-arm64"
staged=$(mktemp -d "$PWD/dist/.sign.XXXXXX")
app="Koodo Reader Custom.app"
ditto --noextattr --norsrc "$out/$app" "$staged/$app"
codesign --force --deep --sign - "$staged/$app"
codesign --verify --deep --strict "$staged/$app"
mv "$out/$app" "$staged/unsigned.app"
if ! mv "$staged/$app" "$out/$app"; then
  mv "$staged/unsigned.app" "$out/$app"
  exit 1
fi
print "$out/$app"
