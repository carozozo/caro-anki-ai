#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
homebrew_installer='https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'
NVM_DIR=${NVM_DIR:-"$HOME/.nvm"}
export NVM_DIR

die () { printf '%s\n' "$1" >&2; exit 1; }

load_homebrew () {
  for candidate in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$candidate" ] || continue
    eval "$("$candidate" shellenv)"
    return
  done
  return 1
}

install_homebrew () {
  command -v curl >/dev/null 2>&1 || die 'curl is required to install Homebrew.'
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl -fsSL "$homebrew_installer" -o "$installer"
  /bin/bash "$installer"
  rm -f "$installer"
  trap - EXIT HUP INT TERM
  load_homebrew || die 'Homebrew was installed but could not be loaded.'

  shellenv_line="eval \"\$($(command -v brew) shellenv)\""
  touch "$HOME/.zprofile"
  grep -Fqx "$shellenv_line" "$HOME/.zprofile" || printf '\n%s\n' "$shellenv_line" >> "$HOME/.zprofile"
}

ensure_homebrew () { load_homebrew || install_homebrew; }

load_nvm () {
  nvm_prefix=$(brew --prefix nvm 2>/dev/null) || return 1
  [ -s "$nvm_prefix/nvm.sh" ] || return 1
  . "$nvm_prefix/nvm.sh"
}

install_nvm () {
  brew list --formula nvm >/dev/null 2>&1 || brew install nvm
  mkdir -p "$NVM_DIR"

  nvm_prefix=$(brew --prefix nvm)
  nvm_dir_line='export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"'
  nvm_source_line="[ -s \"$nvm_prefix/nvm.sh\" ] && \\. \"$nvm_prefix/nvm.sh\""
  touch "$HOME/.zshrc"
  grep -Fqx "$nvm_dir_line" "$HOME/.zshrc" || printf '\n%s\n' "$nvm_dir_line" >> "$HOME/.zshrc"
  grep -Fqx "$nvm_source_line" "$HOME/.zshrc" || printf '%s\n' "$nvm_source_line" >> "$HOME/.zshrc"
  load_nvm || die 'NVM was installed but could not be loaded.'
}

ensure_nvm () { ensure_homebrew; install_nvm; }

node_is_supported () {
  command -v node >/dev/null 2>&1 \
    && node -e "if (Number(process.versions.node.split('.')[0]) < 26) process.exit(1)"
}

python_is_supported () {
  for candidate in python3.13 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' && return
  done
  return 1
}

install_formula () {
  formula=$1
  if brew list --formula "$formula" >/dev/null 2>&1; then
    brew upgrade "$formula"
  else
    brew install "$formula"
  fi
}

[ "$(uname -s)" = Darwin ] || die 'This bootstrap supports macOS only.'

ensure_nvm
nvm install 26
nvm alias default 26
nvm use 26
node_is_supported || die 'Node.js 26 or newer could not be installed.'

if ! python_is_supported; then
  ensure_homebrew
  python_is_supported || install_formula python@3.13
  export PATH="$(brew --prefix python@3.13)/bin:$PATH"
fi
python_is_supported || die 'Python 3.9 or newer could not be installed.'

cd "$project_root"
if [ ! -f .env ]; then
  cp .env.example .env
  printf 'Created %s/.env from .env.example.\n' "$project_root"
fi

sh scripts/sh/install-caro-anki-dev.sh
npm run validate

printf '\nDevelopment environment is ready.\n'
printf 'App: /Applications/Caro Anki Dev.app\n'
printf 'Start the browser server: npm run dev\n'
