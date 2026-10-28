# scripts

Personal scripts. Each folder is self-contained.

## terminal/

Reproduces my terminal on any Linux machine (new or existing): zsh + oh-my-zsh, starship prompt,
`cat` → bat (`.md` → glow), `ls` → eza, delta for diff/git, fzf, fd, ripgrep, plus a few extras.

```sh
git clone git@github.com:Viswazgummadi/scripts.git ~/scripts
~/scripts/terminal/setup.sh          # then: exec zsh
```

Options: `--dry-run`, `--no-sudo`, `--user-local` (everything as binaries in `~/.local/bin`, no root),
`--no-packages` (configs only), `--copy` (copy instead of symlink), `--chsh`. See `setup.sh --help`.

- Packages come from apt / dnf / yum / pacman / zypper / apk / brew; whatever is missing is downloaded as a
  prebuilt binary into `~/.local/bin`.
- Config files live in `terminal/files/` and are **symlinked** into `$HOME`, so editing them here edits the
  live setup. Existing files are moved to `~/.terminal-setup-backup/<time>/`, never deleted.
- Machine- or project-specific settings go in `~/.zshrc.local` (created from `files/zshrc.local.example`,
  never committed).
- Re-running is safe.
