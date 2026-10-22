# Shell customization

Use local files to extend the container shell without replacing its defaults.
Create them under `{config}/settings/`, not directly in your host home directory.
See [configuration paths](CONFIGURATION.md#paths).

For interactive [zsh](https://zsh.sourceforge.io/Doc/) aliases, prompts, and keybindings, edit `{config}/settings/.zshrc.local`:

```zsh
alias ll='ls -la'
```

For environment setup that must also apply to non-interactive commands, edit `{config}/settings/.profile.local`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Both paths are included in the generated `settings` list:

```toml
settings = ["~/.zshrc.local", "~/.profile.local"]
```

Start a new `sandbox` or `sandbox run` session to use the changes.
For session environment variables without shell code, use [`env`](CONFIGURATION.md#session-environment).
