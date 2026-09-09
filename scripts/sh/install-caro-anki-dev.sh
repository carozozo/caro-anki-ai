#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
app_name='Caro Anki Dev.app'
build_path="$project_root/tmp/$app_name"
install_path="/Applications/$app_name"
tmp_dir="$project_root/tmp"

command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 26 or newer is required.' >&2; exit 1; }
node -e "if (Number(process.versions.node.split('.')[0]) < 26) process.exit(1)" || {
  printf 'Node.js 26 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
}

cd "$project_root"
rm -rf "$build_path"
find "$tmp_dir" -maxdepth 1 -name 'electron.part*' -delete 2>/dev/null || true
sh scripts/sh/build-anki-runtime.sh
if [ -d node_modules ]; then
  npm install
else
  npm ci
fi
npx install-electron
npm run desktop:build-dev

for file in Contents/MacOS/Electron Contents/Resources/app/main.js \
  Contents/Resources/anki-runtime/anki-helper/anki-helper \
  Contents/Resources/anki-runtime/anki-helper/_internal; do
  [ -e "$build_path/$file" ] || { printf 'Build is incomplete: missing %s\n' "$file" >&2; exit 1; }
done

mkdir -p /Applications
rm -rf "$install_path"
ditto "$build_path" "$install_path"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$install_path"
rm -rf "$build_path"

printf '\nInstalled: %s\nOpen with Spotlight: Caro Anki Dev\n' "$install_path"
