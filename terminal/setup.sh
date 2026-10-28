#!/usr/bin/env bash
# setup.sh — reproduce the whole terminal setup on any Linux box (new or existing).
#
#   terminal/setup.sh [options]
#
# What it sets up (nothing project-specific; that goes in ~/.zshrc.local):
#   shell      zsh + oh-my-zsh + autosuggestions / syntax-highlighting / completions, starship prompt
#   viewing    bat (cat -> bat, .md -> glow), eza (ls), delta (diff / git pager), fzf, fd, ripgrep
#   extras     tldr, ncdu, dust, duf, hyperfine, shellcheck, sd   (best effort, package manager only)
#   configs    files/*  ->  ~/.zshrc  ~/.config/{starship.toml,bat/config,glow/glow.yml}  ~/.nanorc
#              + delta settings in `git config --global` (only keys not set yet)
#
# Packages come from the system package manager (apt dnf yum pacman zypper apk brew) when sudo works;
# anything still missing is fetched as a prebuilt binary into ~/.local/bin (no root needed).
# Everything is COPIED into $HOME, so once it has run you can delete the clone: nothing points back at it.
# Safe to re-run: existing files are moved to ~/.terminal-setup-backup/<time>/ first, never deleted.
#
# Options:
#   -n, --dry-run     show what would happen, change nothing
#   --no-sudo         never use sudo (skip system packages; binaries go to ~/.local/bin)
#   --user-local      install everything as binaries in ~/.local/bin, ignore system packages
#   --no-packages     skip tool installation entirely, only deploy the configs
#   --link            symlink the configs to this clone instead of copying (then do NOT delete the clone)
#   --no-bashrc       do not add the "start zsh from bash" block to ~/.bashrc
#   --chsh            also make zsh the login shell (off by default: shared accounts!)
#   -h, --help        this text
#
# Needs: bash, curl (or wget), tar, git. zsh itself must come from the package manager
# (or conda: `conda install -c conda-forge zsh`) — it cannot be fetched as a plain binary.

set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC=$HERE/files
BIN=$HOME/.local/bin
BACKUP=$HOME/.terminal-setup-backup/$(date +%Y%m%d-%H%M%S)

DRY=0; NO_SUDO=0; USER_LOCAL=0; NO_PKGS=0; COPY=1; CHSH=0; BASHRC=1
for a in "$@"; do
  case $a in
    -n|--dry-run) DRY=1 ;;
    --no-sudo) NO_SUDO=1 ;;
    --user-local) USER_LOCAL=1; NO_SUDO=1 ;;
    --no-packages) NO_PKGS=1 ;;
    --copy) COPY=1 ;;
    --link) COPY=0 ;;
    --no-bashrc) BASHRC=0 ;;
    --chsh) CHSH=1 ;;
    -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a (try --help)" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'; else B=; G=; Y=; R=; Z=; fi
FAILED=""
step() { printf '\n%s== %s%s\n' "$B" "$*" "$Z"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$Z" "$*"; }
fail() { printf '  %s✗%s %s\n' "$R" "$Z" "$*"; FAILED="$FAILED $1"; }
have() { command -v "$1" >/dev/null 2>&1; }
# present = usable now (under --user-local only what we put in ~/.local/bin counts)
present() { if [ $USER_LOCAL = 1 ]; then [ -x "$BIN/$1" ]; else have "$1"; fi; }
do_() { if [ $DRY = 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

[ -d "$SRC" ] || { echo "missing $SRC (clone the whole repo)" >&2; exit 1; }
case $(uname -s) in Linux|Darwin) ;; *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;; esac

# ------------------------------------------------------------------ system packages
detect_pm() {
  for p in apt-get dnf yum pacman zypper apk brew; do have $p && { echo $p; return; }; done
  echo none
}
PM=$(detect_pm)

SUDO=""
if [ "$(id -u)" != 0 ] && [ $NO_SUDO = 0 ] && [ "$PM" != brew ]; then
  if have sudo && { sudo -n true 2>/dev/null || [ -t 0 ]; }; then SUDO=sudo; else NO_SUDO=1; fi
fi

pm_pkgs() {   # package names per manager; each is tried on its own, unknown ones are skipped
  case $PM in
    apt-get) echo "zsh git curl less nano fzf ripgrep bat fd-find eza git-delta glow starship tealdeer ncdu hyperfine shellcheck duf du-dust sd" ;;
    dnf|yum) echo "zsh git curl less nano fzf ripgrep bat fd-find eza git-delta starship tealdeer ncdu hyperfine ShellCheck duf dust sd" ;;
    pacman)  echo "zsh git curl less nano fzf ripgrep bat fd eza git-delta glow starship tealdeer ncdu hyperfine shellcheck duf dust sd" ;;
    zypper)  echo "zsh git curl less nano fzf ripgrep bat fd eza delta starship tealdeer ncdu hyperfine ShellCheck duf dust sd" ;;
    apk)     echo "zsh git curl less nano fzf ripgrep bat fd eza delta glow starship tealdeer ncdu hyperfine shellcheck duf dust sd" ;;
    brew)    echo "zsh git curl less nano fzf ripgrep bat fd eza git-delta glow starship tealdeer ncdu hyperfine shellcheck duf dust sd" ;;
  esac
}
pm_install() {
  case $PM in
    apt-get) DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "$@" ;;
    dnf)     $SUDO dnf install -y -q "$@" ;;
    yum)     $SUDO yum install -y -q "$@" ;;
    pacman)  $SUDO pacman -S --noconfirm --needed "$@" ;;
    zypper)  $SUDO zypper --non-interactive install "$@" ;;
    apk)     $SUDO apk add --quiet "$@" ;;
    brew)    brew install "$@" ;;
  esac
}

install_packages() {
  step "System packages ($PM)"
  if [ "$PM" = none ]; then warn "no supported package manager found"; return; fi
  if [ $NO_SUDO = 1 ] && [ "$PM" != brew ]; then warn "no usable sudo — skipping system packages (binaries go to $BIN)"; return; fi
  [ "$PM" = apt-get ] && do_ $SUDO apt-get update -qq
  local p ok_list="" skip_list=""
  for p in $(pm_pkgs); do
    if [ $DRY = 1 ]; then printf '  [dry-run] %s install %s\n' "$PM" "$p"; continue; fi
    if pm_install "$p" >/dev/null 2>&1; then ok_list="$ok_list $p"; else skip_list="$skip_list $p"; fi
  done
  [ -n "$ok_list" ]   && ok "installed / present:$ok_list"
  [ -n "$skip_list" ] && warn "not available from $PM (binaries or skipped):$skip_list"
}

# Debian/Ubuntu ship these under other names; give them the usual ones in ~/.local/bin
fix_renamed_tools() {
  [ $USER_LOCAL = 1 ] && return
  mkdir -p "$BIN" 2>/dev/null
  have bat || { have batcat && do_ ln -sf "$(command -v batcat)" "$BIN/bat"; }
  have fd  || { have fdfind && do_ ln -sf "$(command -v fdfind)" "$BIN/fd"; }
}

# ------------------------------------------------------------------ prebuilt binaries (no root)
case $(uname -m) in
  x86_64|amd64)  ARCH=x86_64;  GOARCH=amd64; GLOWARCH=x86_64; TRIP_MUSL=x86_64-unknown-linux-musl;  TRIP_RG=x86_64-unknown-linux-musl ;;
  aarch64|arm64) ARCH=aarch64; GOARCH=arm64; GLOWARCH=arm64;  TRIP_MUSL=aarch64-unknown-linux-musl; TRIP_RG=aarch64-unknown-linux-gnu ;;
  *)             ARCH=; GOARCH=; GLOWARCH=; TRIP_MUSL=; TRIP_RG= ;;
esac

fetch() { # url dest
  if have curl; then curl -fsSL --retry 2 -o "$2" "$1"; elif have wget; then wget -q -O "$2" "$1"; else return 1; fi
}
latest_tag() { # owner/repo -> v1.2.3
  curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$1/releases/latest" 2>/dev/null | sed 's#.*/tag/##'
}

# bin_install <tool>  — download the tool's release tarball and drop the binary in ~/.local/bin
bin_install() {
  local tool=$1 repo tag url exe=$1 tmp f
  case $tool in
    starship) repo=starship/starship ;;
    bat)      repo=sharkdp/bat ;;
    fd)       repo=sharkdp/fd ;;
    rg)       repo=BurntSushi/ripgrep ;;
    fzf)      repo=junegunn/fzf ;;
    delta)    repo=dandavison/delta ;;
    glow)     repo=charmbracelet/glow ;;
    eza)      repo=eza-community/eza ;;
    *) return 1 ;;
  esac
  [ -n "$ARCH" ] && [ "$(uname -s)" = Linux ] || { warn "$tool: no prebuilt binary for $(uname -s)/$(uname -m)"; return 1; }
  if [ $DRY = 1 ]; then printf '  [dry-run] download %s release -> %s/%s\n' "$repo" "$BIN" "$exe"; return 0; fi
  tag=$(latest_tag "$repo")
  [ -n "$tag" ] || { warn "$tool: cannot reach github.com"; return 1; }
  local base=https://github.com/$repo/releases/download/$tag
  case $tool in
    starship) url=$base/starship-$TRIP_MUSL.tar.gz ;;
    bat)      url=$base/bat-$tag-$TRIP_MUSL.tar.gz ;;
    fd)       url=$base/fd-$tag-$TRIP_MUSL.tar.gz ;;
    rg)       url=$base/ripgrep-$tag-$TRIP_RG.tar.gz ;;
    fzf)      url=$base/fzf-${tag#v}-linux_$GOARCH.tar.gz ;;
    delta)    url=$base/delta-$tag-$TRIP_RG.tar.gz ;;
    glow)     url=$base/glow_${tag#v}_Linux_$GLOWARCH.tar.gz ;;
    eza)      url=https://github.com/$repo/releases/latest/download/eza_$TRIP_RG.tar.gz ;;
  esac
  tmp=$(mktemp -d) || return 1
  if fetch "$url" "$tmp/a.tar.gz" && tar -xzf "$tmp/a.tar.gz" -C "$tmp"; then
    f=$(find "$tmp" -type f -name "$exe" | head -1)
    if [ -n "$f" ]; then
      mkdir -p "$BIN" && install -m 755 "$f" "$BIN/$exe" && { rm -rf "$tmp"; return 0; }
    fi
  fi
  rm -rf "$tmp"; return 1
}

install_binaries() {
  step "Prebuilt binaries -> $BIN (for anything the package manager did not provide)"
  local t got="" bad=""
  for t in starship bat fd rg fzf delta glow eza; do
    present $t && continue
    if bin_install $t; then got="$got $t"; else bad="$bad $t"; fi
  done
  [ -n "$got" ] && ok "downloaded:$got"
  [ -n "$bad" ] && fail "binaries:$bad" && warn "could not get:$bad"
  [ -z "$got$bad" ] && ok "nothing to fetch, all tools present"
  case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN is not on PATH in this shell (the installed ~/.zshrc adds it)";; esac
}

# ------------------------------------------------------------------ oh-my-zsh + plugins
clone() { # url dir
  [ -d "$2/.git" ] && { ok "$(basename "$2") present"; return 0; }
  have git || { fail "$(basename "$2") (git missing)"; return 1; }
  if do_ git clone --depth 1 -q "$1" "$2"; then ok "cloned $(basename "$2")"; else fail "$(basename "$2")"; fi
}
install_omz() {
  step "oh-my-zsh and plugins"
  local zsh_dir=$HOME/.oh-my-zsh pl=$HOME/.oh-my-zsh/custom/plugins
  clone https://github.com/ohmyzsh/ohmyzsh.git "$zsh_dir"
  clone https://github.com/zsh-users/zsh-autosuggestions "$pl/zsh-autosuggestions"
  clone https://github.com/zsh-users/zsh-syntax-highlighting "$pl/zsh-syntax-highlighting"
  clone https://github.com/zsh-users/zsh-completions "$pl/zsh-completions"
}

# ------------------------------------------------------------------ config files
backup() { # path
  [ -e "$1" ] || [ -L "$1" ] || return 0
  do_ mkdir -p "$BACKUP" && do_ mv "$1" "$BACKUP/$(echo "$1" | tr '/' '_')"
}
deploy() { # <file under files/> <destination>
  local src=$SRC/$1 dst=$2
  [ -f "$src" ] || { fail "missing $src"; return; }
  if [ $COPY = 0 ] && [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then ok "$dst (already linked)"; return; fi
  if [ $COPY = 1 ] && [ -f "$dst" ] && [ ! -L "$dst" ] && cmp -s "$src" "$dst"; then ok "$dst (already identical)"; return; fi
  do_ mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    if [ -f "$dst" ] && [ ! -L "$dst" ] && cmp -s "$src" "$dst"; then do_ rm -f "$dst"; else backup "$dst"; fi
  fi
  if [ $COPY = 1 ]; then do_ cp "$src" "$dst"; else do_ ln -s "$src" "$dst"; fi
  ok "$dst"
}
deploy_nanorc() {   # nano errors on an include with no match, so drop it where nano ships no syntaxes
  local dst=$HOME/.nanorc
  if ls /usr/share/nano/*.nanorc >/dev/null 2>&1 || ls /usr/local/share/nano/*.nanorc >/dev/null 2>&1; then
    deploy nano/nanorc "$dst"; return
  fi
  warn "no system nano syntax files; installing ~/.nanorc without that include"
  [ -e "$dst" ] || [ -L "$dst" ] && backup "$dst"
  if [ $DRY = 1 ]; then echo "  [dry-run] write $dst"; else grep -v '^include "/usr/share/nano' "$SRC/nano/nanorc" > "$dst"; fi
  ok "$dst"
}
deploy_configs() {
  step "Config files ($([ $COPY = 1 ] && echo "copied into \$HOME" || echo "symlinked to $SRC"))"
  deploy zshrc "$HOME/.zshrc"
  deploy starship.toml "$HOME/.config/starship.toml"
  deploy bat-config "$HOME/.config/bat/config"
  deploy glow.yml "$HOME/.config/glow/glow.yml"
  deploy nano/llvm.nanorc "$HOME/.config/nano/llvm.nanorc"
  deploy_nanorc
  if [ ! -e "$HOME/.zshrc.local" ]; then
    do_ cp "$SRC/zshrc.local.example" "$HOME/.zshrc.local" && ok "~/.zshrc.local (template: per-machine settings go here)"
  else
    ok "~/.zshrc.local kept"
  fi
}

# delta pager settings, only where the key is not set yet (never overrides your own choices)
git_delta_config() {
  step "git: delta settings"
  have git || { warn "git missing"; return; }
  local k v n=0
  while IFS='=' read -r k v; do
    [ -z "$k" ] && continue
    if [ -z "$(git config --global --get "$k" 2>/dev/null)" ]; then do_ git config --global "$k" "$v"; n=$((n+1)); fi
  done <<'EOF'
delta.line-numbers=true
delta.navigate=true
delta.side-by-side=false
delta.syntax-theme=Monokai Extended
delta.file-style=bold yellow
delta.file-decoration-style=yellow ol ul
delta.hunk-header-style=file line-number syntax
delta.hunk-header-decoration-style=blue box
EOF
  ok "$n delta setting(s) added"
}

setup_bashrc() {   # make an interactive bash hand over to zsh (guarded; `NO_ZSH=1 bash` skips it)
  step "bash -> zsh"
  local rc=$HOME/.bashrc mark="# >>> terminal-setup: start zsh >>>"
  if [ $BASHRC = 0 ]; then ok "~/.bashrc untouched (--no-bashrc)"; return; fi
  if ! have zsh && [ ! -x "$BIN/zsh" ]; then warn "zsh not installed, so ~/.bashrc was not changed"; return; fi
  if [ -f "$rc" ] && grep -qF "$mark" "$rc"; then ok "~/.bashrc already starts zsh"; return; fi
  if [ $DRY = 1 ]; then echo "  [dry-run] append the zsh start block to $rc"; return; fi
  cat >> "$rc" <<'BLOCK'

# >>> terminal-setup: start zsh >>>
# Interactive bash hands over to zsh. Skip once with:  NO_ZSH=1 bash
case $- in
  *i*)
    # only a real terminal session: never for `bash -ic 'cmd'`, scripts or tools that pipe into bash
    if [ -z "${ZSH_VERSION:-}" ] && [ -z "${NO_ZSH:-}" ] && [ -z "${BASH_EXECUTION_STRING:-}" ] && [ -t 0 ] && [ -t 1 ]; then
      PATH="$HOME/.local/bin:$PATH"
      if command -v zsh >/dev/null 2>&1; then SHELL=$(command -v zsh); export SHELL; exec zsh; fi
    fi ;;
esac
# <<< terminal-setup <<<
BLOCK
  ok "~/.bashrc now starts zsh (undo: delete the 'terminal-setup' block; one-off skip: NO_ZSH=1 bash)"
}

post_steps() {
  step "Finishing"
  have bat && do_ bat cache --build >/dev/null 2>&1
  have tldr && { do_ tldr --update >/dev/null 2>&1 && ok "tldr pages updated"; }
  if [ $CHSH = 1 ]; then
    local z; z=$(command -v zsh)
    if [ -n "$z" ] && grep -qx "$z" /etc/shells 2>/dev/null; then do_ chsh -s "$z" && ok "login shell -> $z"
    else warn "--chsh: zsh ($z) is not listed in /etc/shells; left the login shell alone"; fi
  else
    ok "login shell untouched (use --chsh, or just run \`zsh\`)"
  fi
}

report() {
  step "Check"
  local t v miss=""
  for t in zsh git bat fd rg fzf delta glow eza starship tldr ncdu dust duf hyperfine shellcheck sd nano; do
    if have $t || [ -x "$BIN/$t" ]; then
      v=$( { "$BIN/$t" --version 2>/dev/null || $t --version 2>/dev/null; } | head -1 | cut -c1-48 )
      printf '  %s✓%s %-11s %s\n' "$G" "$Z" "$t" "$v"
    else miss="$miss $t"; fi
  done
  [ -n "$miss" ] && warn "not installed:$miss"
  if [ $DRY = 0 ] && have zsh; then
    local out
    out=$(PATH="$BIN:$PATH" zsh -ic 'exit' 2>&1 </dev/null | grep -v "can't change option: zle")
    if [ -z "$out" ]; then ok "zsh starts cleanly"; else warn "zsh printed output on startup:"; printf '%s\n' "$out" | head -5 | sed 's/^/      /'; fi
  fi
  if ! have zsh; then fail "zsh (install it with your package manager, or conda install -c conda-forge zsh)"; fi
  if [ -n "$FAILED" ]; then printf '\n%sSome steps failed:%s%s\n' "$R" "$Z" "$FAILED"; else printf '\n%sDone.%s Open a new terminal or run:  exec zsh\n  The configs were copied, so this clone can be deleted now.  (backups, if any: %s)\n' "$G" "$Z" "$BACKUP"; fi
}

[ $DRY = 1 ] && echo "(dry run: nothing will be changed)"
if [ $NO_PKGS = 0 ]; then
  [ $USER_LOCAL = 0 ] && install_packages
  [ $USER_LOCAL = 0 ] && fix_renamed_tools
  install_binaries
fi
install_omz
deploy_configs
git_delta_config
setup_bashrc
post_steps
report
[ -z "$FAILED" ]
