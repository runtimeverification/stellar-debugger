FROM node:22-bookworm

# --- System packages -------------------------------------------------------
# git/sudo/less: base dev convenience. libdbus-1-3: required by the Stellar CLI.
# build-essential/clang/pkg-config/libssl: needed to compile Rust contracts and
# any from-source crates. curl/xz/jq: used by the toolchain installers below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    sudo \
    ca-certificates \
    less \
    curl \
    xz-utils \
    jq \
    build-essential \
    clang \
    pkg-config \
    libssl-dev \
    libdbus-1-3 \
  && rm -rf /var/lib/apt/lists/*

# Give the default `node` user passwordless sudo (convenient inside the container)
RUN echo "node ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node

# Bootstrap Claude Code via npm so the `claude` CLI exists, then switch to the
# native installer as the node user. The native install lives under ~/.local/bin,
# which node owns, so auto-updates work without sudo or a writable npm prefix.
RUN npm install -g @anthropic-ai/claude-code

# --- Stellar CLI (prebuilt) ------------------------------------------------
# Used by the debugger to build Soroban contracts (`stellar contract build`).
ARG STELLAR_CLI_VERSION=26.1.0
RUN curl -sSL \
      "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
    | tar xz -C /usr/local/bin stellar \
  && stellar --version

# --- Nix prep --------------------------------------------------------------
# Single-user Nix is installed under /nix as the `node` user (no systemd in the
# container). Pre-create /nix with node ownership so the installer can write it.
RUN mkdir -p /nix && chown -R node /nix

USER node
WORKDIR /workspace

RUN claude install

# --- Rust toolchain (Soroban contracts) ------------------------------------
ENV RUSTUP_HOME=/home/node/.rustup \
    CARGO_HOME=/home/node/.cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal \
  && /home/node/.cargo/bin/rustup target add wasm32v1-none wasm32-unknown-unknown

# --- uv (Python package manager for komet-node) ----------------------------
RUN curl -LsSf https://astral.sh/uv/install.sh | sh

# --- Nix + kup + komet semantics -------------------------------------------
# komet-node executes contracts via the K-based `komet` semantics. We install
# the K toolchain through Runtime Verification's `kup` (Nix-based), pulling
# prebuilt binaries from RV's binary cache rather than compiling from source.
ENV NIX_CONFIG="experimental-features = nix-command flakes"
RUN curl -L https://nixos.org/nix/install | sh -s -- --no-daemon --yes
ENV PATH="/home/node/.nix-profile/bin:/home/node/.local/bin:/home/node/.cargo/bin:${PATH}"
# Mark `node` as a trusted Nix user and pre-register RV's binary caches. kup
# otherwise prompts interactively to add these substituters, and the build dies
# with EOFError on input() since stdin is closed. When the user is trusted, kup
# skips the prompt and passes the caches as flags instead. Keys are kup's own.
RUN sudo mkdir -p /etc/nix \
  && printf '%s\n' \
      'trusted-users = root node' \
      'extra-substituters = https://k-framework.cachix.org https://k-framework-binary.cachix.org' \
      'extra-trusted-public-keys = k-framework.cachix.org-1:jeyMXB2h28gpNRjuVkehg+zLj62ma1RnyyopA/20yFE= k-framework-binary.cachix.org-1:pJedQ8iG19BW3v/DMMmiRVtwRBGO3fyMv2Ws0OpBADs=' \
    | sudo tee -a /etc/nix/nix.conf
RUN curl -L https://kframework.org/install | bash \
  && kup install komet

# --- komet-node (local Stellar testnet on K semantics) ---------------------
# Installed into a dedicated venv; exposes `python -m komet_node`.
# (Finalized after live verification — see scripts/install-komet-node.sh.)
ENV KOMET_NODE_VENV=/home/node/.komet-node
COPY --chown=node:node install-komet-node.sh /tmp/install-komet-node.sh
RUN bash /tmp/install-komet-node.sh
