#!/bin/sh
# Builds the bundled Anki runtime: the official Anki backend plus the JSON bridge, frozen into a
# self-contained executable by PyInstaller. Caro Anki then needs neither an external Python nor an
# installed Anki Desktop.
#
# Output: tmp/anki-runtime/anki-helper/ (a `--onedir` distribution; ship the whole directory).
# Rebuild when the bridge, build script, or dependency versions change; force with ANKI_RUNTIME_FORCE=1.
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
anki_version="${ANKI_VERSION:-25.9.4}"
pyinstaller_version="${PYINSTALLER_VERSION:-6.22.3}"
build_dir="$project_root/tmp/anki-build"
dist_dir="$project_root/tmp/anki-runtime"
staging_dir="$project_root/tmp/anki-runtime.next"
venv="$build_dir/venv"
helper="$dist_dir/anki-helper/anki-helper"
staging_helper="$staging_dir/anki-helper/anki-helper"
bridge="$project_root/backend/anki_bridge.py"
build_script="$project_root/scripts/sh/build-anki-runtime.sh"
stamp="$build_dir/deps-anki$anki_version-pyinstaller$pyinstaller_version"
runtime_stamp="$dist_dir/anki-helper/.build-versions"
staging_stamp="$staging_dir/anki-helper/.build-versions"
runtime_key="anki=$anki_version pyinstaller=$pyinstaller_version"

die () { printf '%s\n' "$1" >&2; exit 1; }

# Any Python 3.9+ can host the build environment; Anki's own bundled interpreter is preferred because
# it is the exact version the runtime is built for.
find_python () {
  if [ -n "${ANKI_BUILD_PYTHON:-}" ]; then
    printf '%s' "$ANKI_BUILD_PYTHON"
    return
  fi
  for candidate in "$HOME/Library/Application Support/AnkiProgramFiles"/python/cpython-*/bin/python3.* \
    "$(command -v python3.13 || true)" "$(command -v python3 || true)"; do
    [ -x "$candidate" ] || continue
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
      printf '%s' "$candidate"
      return
    fi
  done
}

[ -f "$bridge" ] || die "Missing $bridge"

if [ -x "$helper" ] && [ "${ANKI_RUNTIME_FORCE:-0}" != 1 ] \
  && [ "$helper" -nt "$bridge" ] && [ "$helper" -nt "$build_script" ] \
  && [ -f "$runtime_stamp" ] && [ "$(cat "$runtime_stamp")" = "$runtime_key" ]; then
  printf 'Anki runtime is up to date: %s\n' "$helper"
  exit 0
fi

python=$(find_python)
[ -n "$python" ] || die 'Python 3.9 or newer is required to build the Anki runtime.'

mkdir -p "$build_dir"
[ -x "$venv/bin/python" ] || "$python" -m venv "$venv"

if [ ! -f "$stamp" ]; then
  printf 'Installing build dependencies (anki==%s, pyinstaller==%s)…\n' "$anki_version" "$pyinstaller_version"
  rm -f "$build_dir"/deps-*
  "$venv/bin/python" -m pip install --disable-pip-version-check --quiet --upgrade pip
  "$venv/bin/python" -m pip install --disable-pip-version-check --quiet \
    "anki==$anki_version" "pyinstaller==$pyinstaller_version"
  touch "$stamp"
fi

printf 'Freezing the Anki backend…\n'
rm -rf "$staging_dir" "$build_dir/work"
"$venv/bin/pyinstaller" --noconfirm --clean --log-level WARN \
  --name anki-helper --onedir --console \
  --distpath "$staging_dir" --workpath "$build_dir/work" --specpath "$build_dir" \
  --collect-submodules anki --exclude-module aqt --exclude-module PyQt6 \
  "$bridge"

# The runtime is useless if it cannot answer, so prove it on a throwaway collection before shipping it.
printf 'Verifying the runtime…\n'
smoke_dir="$build_dir/smoke"
rm -rf "$smoke_dir"
mkdir -p "$smoke_dir"
result=$(printf '%s\n' '{"action":"deckNames","params":{}}' \
  | "$staging_helper" "$smoke_dir/collection.anki2") || die 'The built Anki runtime failed to start.'
rm -rf "$smoke_dir"
case "$result" in
  *'"error": null'*) ;;
  *) die "The built Anki runtime returned an unexpected result: $result" ;;
esac
printf '%s\n' "$runtime_key" > "$staging_stamp"
rm -rf "$dist_dir"
mv "$staging_dir" "$dist_dir"

printf '\nBuilt: %s (%s)\n' "$helper" "$(du -sh "$dist_dir/anki-helper" | cut -f1)"
