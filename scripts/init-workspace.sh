#!/bin/bash
# ============================================================
# init-workspace.sh — Initialise /workspace on first boot
# ============================================================
# This runs before the bridge server starts. It:
#   1. Ensures /workspace exists
#   2. If a TEMPLATE_URL is set, downloads & extracts the template
#   3. If a GIT_REPO_URL is set, clones it instead
#   4. Installs project dependencies if package.json exists
#   5. Starts the bridge server
# ============================================================

set -e

WORKSPACE="/workspace"
PROJECT_DIR="${WORKSPACE}/project"

echo "🚀 Initialising workspace..."

# ── Claude CLI auth (subscription mode) ───────────────────────
# When CLAUDE_AUTH_JSON is set (by cloud provisioning), write it
# to the expected config path so the CLI uses the user's subscription.
if [ -n "$CLAUDE_AUTH_JSON" ]; then
    mkdir -p /root/.config/claude-code
    echo "$CLAUDE_AUTH_JSON" > /root/.config/claude-code/auth.json
    chmod 600 /root/.config/claude-code/auth.json
    echo "✅ Claude CLI credentials injected"
fi

# --- Template or Git clone (only if project dir doesn't exist yet) ---
if [ ! -d "$PROJECT_DIR" ] || [ -z "$(ls -A $PROJECT_DIR 2>/dev/null)" ]; then
    mkdir -p "$PROJECT_DIR"

    if [ -n "$GIT_REPO_URL" ]; then
        echo "📦 Cloning from $GIT_REPO_URL..."
        git clone "$GIT_REPO_URL" "$PROJECT_DIR"

    elif [ -n "$TEMPLATE_URL" ]; then
        echo "📦 Downloading template from $TEMPLATE_URL..."
        curl -fsSL "$TEMPLATE_URL" -o /tmp/template.tar.gz
        tar -xzf /tmp/template.tar.gz -C "$PROJECT_DIR" --strip-components=1
        rm -f /tmp/template.tar.gz

    elif [ -n "$TEMPLATE_NAME" ]; then
        echo "📦 Creating project from template: $TEMPLATE_NAME"
        case "$TEMPLATE_NAME" in
            nextjs)
                npx --yes create-next-app@latest "$PROJECT_DIR" \
                    --typescript --tailwind --eslint --app \
                    --src-dir --import-alias "@/*" --no-turbopack \
                    --use-npm
                ;;
            vite-react)
                npx --yes create-vite@latest "$PROJECT_DIR" \
                    --template react-ts
                ;;
            vanilla)
                mkdir -p "$PROJECT_DIR"
                cat > "$PROJECT_DIR/index.html" << 'HTMLEOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My App</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; background: #0a0a0a; color: #ededed; }
        h1 { font-size: 3rem; }
    </style>
</head>
<body>
    <h1>Hello World 🚀</h1>
    <script src="main.js"></script>
</body>
</html>
HTMLEOF
                cat > "$PROJECT_DIR/main.js" << 'JSEOF'
console.log('Hello from your new project!');
JSEOF
                ;;
            *)
                echo "⚠️  Unknown template: $TEMPLATE_NAME — starting with empty project"
                ;;
        esac

    else
        echo "ℹ️  No template specified — starting with empty workspace"
    fi
else
    echo "✅ Existing project found at $PROJECT_DIR"
fi

# --- Copy .env.dummy to .env.local if no .env.local exists ---
if [ -f "$PROJECT_DIR/.env.dummy" ] && [ ! -f "$PROJECT_DIR/.env.local" ]; then
    cp "$PROJECT_DIR/.env.dummy" "$PROJECT_DIR/.env.local"
    echo "📋 Copied .env.dummy → .env.local"
fi

# --- Install dependencies if needed ---
if [ -f "$PROJECT_DIR/package.json" ] && [ ! -d "$PROJECT_DIR/node_modules" ]; then
    echo "📥 Installing dependencies..."
    cd "$PROJECT_DIR"
    npm install
    cd /app
fi

echo "✅ Workspace ready!"
echo ""

# --- Start the bridge server ---
echo "🌉 Starting Claude Code Bridge..."
exec node /app/dist/server.js
