# ============================================================
# Claude Code Bridge — Cloud Workspace Container
# ============================================================
# This image bundles the bridge server + Claude Code CLI
# into a single container that can run on Fly.io (or anywhere).
#
# The bridge talks to Claude via the Agent SDK, which in turn
# invokes the Claude Code CLI under the hood. In "sdk" mode it
# uses ANTHROPIC_API_KEY; in "cli" mode it relies on the
# locally-installed claude binary + user subscription.
# ============================================================

# --- Stage 1: Build ---
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install ALL deps (including devDeps for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# --- Stage 2: Runtime ---
FROM node:20

# Install system tools needed by Claude Code and dev workflows
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    procps \
    sudo \
    jq \
    curl \
    wget \
    unzip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally (used by the Agent SDK under the hood)
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled JS from builder stage
COPY --from=builder /app/dist ./dist

# Create data directories (sessions + message logs)
RUN mkdir -p /app/data/messages

# Create workspace directory for user projects
RUN mkdir -p /workspace

# Copy startup script and fix line endings (Windows → Linux)
COPY scripts/init-workspace.sh /app/scripts/init-workspace.sh
RUN sed -i 's/\r$//' /app/scripts/init-workspace.sh && chmod +x /app/scripts/init-workspace.sh

# --- Environment defaults ---
# These can all be overridden at deploy time via fly secrets or env vars
ENV PORT=8080
ENV PREVIEW_FALLBACK_PORT=3000
ENV REPOS_BASE_PATH=/workspace
ENV CLAUDE_MODE=sdk
ENV NODE_ENV=production

# Expose bridge server (preview is served on the same port at /preview/)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["sh", "-c", "curl -f http://localhost:8080/_bridge/health -H \"x-api-key: $BRIDGE_API_KEY\" || exit 1"]

# Start via init script (handles template setup + bridge server)
CMD ["/app/scripts/init-workspace.sh"]
