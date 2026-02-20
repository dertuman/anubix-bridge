#!/bin/bash
# ============================================================
# init-workspace.sh — Initialise /workspace on boot
# ============================================================
# 1. Inject Claude CLI credentials if provided
# 2. Set up project (pre-built template copy > git clone > template scaffold)
# 3. Copy .env.dummy → .env.local if needed
# 4. Install deps if needed
# 5. Auto-start dev server
# 6. Start the bridge server
# ============================================================

set -e

WORKSPACE="/workspace"
PROJECT_DIR="${WORKSPACE}/project"
TALKARTECH_URL="https://github.com/dertuman/talkartech-fullstack-template-supabase.git"

echo "🚀 Initialising workspace..."

# ── Claude CLI auth (subscription mode) ───────────────────────
if [ -n "$CLAUDE_AUTH_JSON" ]; then
    mkdir -p /root/.config/claude-code
    echo "$CLAUDE_AUTH_JSON" > /root/.config/claude-code/auth.json
    chmod 600 /root/.config/claude-code/auth.json
    echo "✅ Claude CLI credentials injected"
fi

# --- Project setup (only if project dir doesn't exist yet) ---
if [ ! -d "$PROJECT_DIR" ] || [ -z "$(ls -A $PROJECT_DIR 2>/dev/null)" ]; then
    mkdir -p "$PROJECT_DIR"

    if [ -n "$GIT_REPO_URL" ]; then
        # Check for pre-built template (instant copy vs slow clone + npm install)
        if [ "$GIT_REPO_URL" = "$TALKARTECH_URL" ] && [ -d "/opt/templates/talkartech" ]; then
            echo "⚡ Using pre-built talkartech template..."
            cp -a /opt/templates/talkartech/. "$PROJECT_DIR/"
        else
            echo "📦 Cloning from $GIT_REPO_URL..."
            git clone "$GIT_REPO_URL" "$PROJECT_DIR"
        fi

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

# --- Auto-start dev server if project has a "dev" script ---
if [ -f "$PROJECT_DIR/package.json" ] && grep -q '"dev"' "$PROJECT_DIR/package.json"; then
    echo "🖥️  Starting dev server on port 3000..."
    cd "$PROJECT_DIR"
    PORT=3000 npm run dev > /tmp/devserver.log 2>&1 &
    cd /app
fi

# --- Start the bridge server ---
echo "🌉 Starting Claude Code Bridge..."
exec node /app/dist/server.js
