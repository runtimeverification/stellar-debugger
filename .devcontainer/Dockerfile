FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    sudo \
    ca-certificates \
    less \
  && rm -rf /var/lib/apt/lists/*

# Give the default `node` user passwordless sudo (convenient inside the container)
RUN echo "node ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node

# Install Claude Code globally so `claude` is on PATH for the node user
RUN npm install -g @anthropic-ai/claude-code

USER node
WORKDIR /workspace
