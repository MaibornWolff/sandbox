# Docker Sandbox - Base Image
# Debian with mise and Python - runtimes and tools are installed via user Dockerfile
# Run `sandbox init` to configure your sandbox and select tools to install

FROM debian:trixie

ARG DEBIAN_FRONTEND=noninteractive

# Host user UID/GID for permission matching
ARG HOST_UID=1000
ARG HOST_GID=1000

# System packages and tools (including zsh and X11 utilities)
# Remove Docker's auto-clean that invalidates cache mounts
RUN rm -f /etc/apt/apt.conf.d/docker-clean

# Using BuildKit cache mounts to cache apt downloads
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget unzip git openssh-client bash zsh jq less neovim tmux \
    nodejs python3 python-is-python3 python3-pip \
    build-essential pkg-config ripgrep fd-find fzf netcat-openbsd socat rsync \
    xclip xsel imagemagick x11-utils \
    ffmpeg libavcodec-extra \
    zsh-autosuggestions locales man-db procps iproute2 gosu iptables tcpdump dnsmasq squid dnsutils \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
  && locale-gen;

# Install mise from official Debian repository
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    install -dm 755 /etc/apt/keyrings \
    && curl -fSs https://mise.jdx.dev/gpg-key.pub > /etc/apt/keyrings/mise-archive-keyring.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.jdx.dev/deb stable main" > /etc/apt/sources.list.d/mise.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends mise;

# Create sandbox group and user with host UID/GID (NO sudo access)
# Handle case where GID already exists with different name (e.g., "users" on Windows)
RUN if getent group ${HOST_GID} >/dev/null; then \
      existing_group=$(getent group ${HOST_GID} | cut -d: -f1); \
      if [ "$existing_group" != "sandbox" ]; then \
        groupmod -n sandbox "$existing_group"; \
      fi; \
    else \
      groupadd -g ${HOST_GID} sandbox; \
    fi \
  && useradd -m -u ${HOST_UID} -g sandbox -s /bin/zsh sandbox

# === BUILD STRATEGY ===
# All RUN commands execute as root to avoid cache mount permission issues on Windows.
# HOME is set to /home/sandbox so tools install to the correct location.
# Ownership is fixed via chown before the entrypoint switches to sandbox user.

# Environment configuration (set before tool installation)
ENV HOME=/home/sandbox
ENV XDG_CONFIG_HOME=/home/sandbox/.config
ENV XDG_CACHE_HOME=/home/sandbox/.cache
ENV XDG_DATA_HOME=/home/sandbox/.local/share
ENV NPM_CONFIG_CACHE=/home/sandbox/.npm
# Stable npm prefix so global packages survive Node.js version switches via mise
ENV NPM_CONFIG_PREFIX=/home/sandbox/.npm-global
ENV EDITOR=nvim
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Disable telemetry for common developer tools
ENV DO_NOT_TRACK=1
ENV DISABLE_TELEMETRY=1
ENV DISABLE_ERROR_REPORTING=1
ENV DISABLE_BUG_COMMAND=1
ENV CLAUDE_CODE_ENABLE_TELEMETRY=0
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Add mise shims and npm global bin to PATH for subsequent RUN commands
ENV PATH="/home/sandbox/.npm-global/bin:/home/sandbox/.local/bin:/home/sandbox/.local/share/mise/shims:$PATH"

# Source the central profile for non-interactive bash commands
ENV BASH_ENV=/home/sandbox/.profile

WORKDIR /home/sandbox

# Create mise and npm directories
RUN mkdir -p /home/sandbox/.local/share/mise/installs /home/sandbox/.local/share/mise/downloads /home/sandbox/.npm-global

# Fix ownership of sandbox user's home directory
RUN chown -R sandbox:sandbox /home/sandbox

# Copy shell configuration files directly to home
COPY --chown=sandbox:sandbox configs/profile /home/sandbox/.profile
COPY --chown=sandbox:sandbox configs/bashrc /home/sandbox/.bashrc
COPY --chown=sandbox:sandbox configs/bash_profile /home/sandbox/.bash_profile
COPY --chown=sandbox:sandbox configs/zshrc /home/sandbox/.zshrc
COPY --chown=sandbox:sandbox configs/zshenv /home/sandbox/.zshenv

# === RUNTIME: managed entrypoint ===
# The container runtime's init process runs as PID 1 to reap orphaned session
# children and forward signals. The Node entrypoint starts as root to configure
# network policy and repair mount ownership. Session commands and settings
# backsync run as the unprivileged sandbox user through gosu.
COPY scripts/exec-entrypoint.sh /usr/local/bin/exec-entrypoint.sh
COPY scripts/sandbox-container-tools /usr/local/bin/sandbox-container-tools
COPY scripts/sandbox-wrapper.sh /usr/local/bin/sandbox
RUN chmod +x /usr/local/bin/exec-entrypoint.sh /usr/local/bin/sandbox-container-tools /usr/local/bin/sandbox
ENTRYPOINT ["/usr/local/bin/sandbox-container-tools", "entrypoint"]
CMD ["zsh"]
