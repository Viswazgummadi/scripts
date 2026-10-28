# scripts

Personal scripts. Each folder is self-contained.

## terminal/

Reproduces my terminal on any Linux machine (new or existing): zsh + oh-my-zsh, starship prompt,
`cat` → bat (`.md` → glow), `ls` → eza, delta for diff/git, fzf, fd, ripgrep, plus a few extras.

```sh
git clone git@github.com:Viswazgummadi/scripts.git ~/scripts
~/scripts/terminal/setup.sh          # then open a new terminal (or: exec zsh)
rm -rf ~/scripts                     # optional: everything was copied into $HOME, nothing points back here
```

Options: `--dry-run`, `--no-sudo`, `--user-local` (everything as binaries in `~/.local/bin`, no root),
`--no-packages` (configs only), `--no-bashrc`, `--link` (symlink instead of copy; keep the clone then), `--chsh`.
See `setup.sh --help`.

- Packages come from apt / dnf / yum / pacman / zypper / apk / brew; whatever is missing is downloaded as a
  prebuilt binary into `~/.local/bin`.
- Config files from `terminal/files/` are **copied** into `$HOME`. Existing files (including dangling links
  from an older symlink install) are moved to `~/.terminal-setup-backup/<time>/`, never deleted.
- `~/.bashrc` gets a small block so an interactive bash hands over to zsh. It never fires for `bash -c`,
  scripts or pipes. One-off skip: `NO_ZSH=1 bash`; undo: delete the `terminal-setup` block.
- Machine- or project-specific settings go in `~/.zshrc.local` (created from `files/zshrc.local.example`,
  never committed).
- Re-running is safe.
