# Anubix Bridge

The real-time connection layer between [Anubix](https://github.com/topics/anubix) clients (web & native) and Claude Code. Express + WebSocket server that runs on Fly.io (one machine per user) or locally for development.

## Repositories

| Repo                                         | What it does                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **`anubix-bridge`** (this repo)              | Express + WebSocket server. Connects clients to Claude Code via the Agent SDK. Each user gets their own machine. |
| **`anubix-web`**                             | Browser client. Users connect to the bridge from here to build and manage their apps.                            |
| **`anubix-native`**                          | React Native mobile client (iOS/Android). Same functionality as web.                                             |
| **`talkartech-fullstack-template-supabase`** | Next.js + Clerk + Supabase starter template. Gets copied onto the Fly.io machine when a user creates an app.     |

## Architecture

```
anubix-web / anubix-native
    |
    | WebSocket (wss://) + REST API (https://)
    v
anubix-bridge (Fly.io machine or local + tunnel)
    |
    | Claude Agent SDK
    v
Claude Code CLI --> Anthropic API
    |
    | Full terminal access
    v
/workspace/project (user's app, e.g. next dev)
    |
    | Proxied through bridge at /preview/
    v
Live preview in client
```

## How It Works

1. User opens Anubix (web or native), enters their bridge URL + API key
2. Client connects via WebSocket to `/ws/:sessionId`
3. User types a message -> bridge sends it to Claude Code SDK
4. Claude Code reads/writes files, runs commands on the machine
5. Responses stream back to the client in real-time
6. The user's app (`next dev`) runs on the same machine, proxied through `/preview/`

### Key Features

- **WebSocket with reconnection** — Message sequencing (`seq`) so clients can resume from where they left off
- **Tool approval flow** — Client gets notified when Claude wants to run a tool, user can approve/deny
- **Multi-session** — Multiple sessions per machine, each with its own conversation
- **Live preview** — HTTP + WebSocket proxy to the user's dev server
- **Claude via CLI** — Default `CLAUDE_MODE=cli` uses your Claude Code subscription (no `ANTHROPIC_API_KEY` in `.env`; avoids accidental leaks or API billing)

---

## Local Development Setup

### Prerequisites

- Node.js 20+
- npm
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (for `cli` mode)
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (to expose your local server to the internet)

### 1. Clone and install

```bash
git clone https://github.com/your-org/anubix-bridge.git
cd anubix-bridge
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
BRIDGE_API_KEY=your-secret-here        # Shared secret — anubix-web uses this to authenticate
CLAUDE_MODE=cli                        # Claude Code subscription (recommended)
REPOS_BASE_PATH=C:\Users\you\repos    # Base path for your local repositories
# Optional: PORT=3456
```

**Claude:** Keep `CLAUDE_MODE=cli` and **do not** put `ANTHROPIC_API_KEY` in `.env` unless you intentionally run rare `sdk` mode (direct API billing). The normal path uses the Claude Agent SDK with your local `claude` CLI and subscription credentials.

### 3. Start the bridge

```bash
npm run dev
```

The bridge starts on `http://localhost:3456`. Verify it's working:

```bash
curl -H "x-api-key: your-secret-here" http://localhost:3456/_bridge/health
# {"status":"ok","version":"1.0.0","uptime":...}
```

### 4. Expose with Cloudflare Tunnel

Since anubix-web runs on HTTPS in production, your browser requires a secure connection (`wss://`) to the bridge. A Cloudflare Tunnel gives you a public HTTPS URL that routes to your local server.

#### First-time setup

```bash
# 1. Login to Cloudflare (opens browser)
cloudflared tunnel login

# 2. Create a tunnel
cloudflared tunnel create anubix-bridge

# 3. Note the tunnel ID from the output (e.g. 9b55b420-253b-4ad4-b3fd-533d7f494282)

# 4. Route your subdomain to the tunnel
cloudflared tunnel route dns anubix-bridge bridge.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: ~/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: bridge.yourdomain.com
    service: http://localhost:3456
  - service: http_status:404
```

#### Start the tunnel

```bash
cloudflared tunnel run anubix-bridge
```

Verify it works:

```bash
curl -H "x-api-key: your-secret-here" https://bridge.yourdomain.com/_bridge/health
# {"status":"ok","version":"1.0.0","uptime":...}
```

#### Quick tunnel (no custom domain)

If you don't have a domain, use a quick tunnel for a temporary URL:

```bash
cloudflared tunnel --url http://localhost:3456
```

This gives you a random `https://something.trycloudflare.com` URL. Good for testing, but the URL changes every time.

#### Troubleshooting

| Problem                                       | Solution                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP 530` from Cloudflare                    | `cloudflared` is not running. Start it with `cloudflared tunnel run`.                                                            |
| DNS record already exists                     | Go to Cloudflare dashboard > DNS > delete the old CNAME, then re-run `cloudflared tunnel route dns`.                             |
| `Unable to reach bridge server` in anubix-web | Check that both `npm run dev` AND `cloudflared tunnel run` are running.                                                          |
| WebSocket won't connect                       | Make sure the bridge URL in anubix-web starts with `https://` (not `http://`). The client converts it to `wss://` automatically. |

### 5. Connect from anubix-web

1. Open anubix-web and go to the **Code** page
2. Enter your bridge URL: `https://bridge.yourdomain.com`
3. Enter your API key (the `BRIDGE_API_KEY` from your `.env`)
4. You should see "Connected" and your sessions

---

## Fly.io Deployment (Production)

On Fly.io, each user gets their own machine with a public HTTPS URL (`https://app-name.fly.dev`). **No Cloudflare tunnel needed** — Fly.io handles HTTPS and WebSocket natively.

### Prerequisites

- [flyctl](https://fly.io/docs/flyctl/install/) installed and authenticated (`fly auth login`)
- A Fly.io account with a payment method

### 1. Create the app

```bash
fly apps create my-bridge-app
```

### 2. Create a persistent volume

The workspace volume persists user projects across deploys and restarts:

```bash
fly volumes create workspace_data --size 1 --region lhr --app my-bridge-app
```

Adjust `--size` (in GB) and `--region` as needed. Use `fly platform regions` to see available regions.

### 3. Set secrets

At minimum you need `BRIDGE_API_KEY`. For Claude, prefer **CLI/subscription** auth (e.g. `CLAUDE_AUTH_JSON` + `CLAUDE_MODE=cli` per your boot script) instead of storing `ANTHROPIC_API_KEY` on the machine, unless you deliberately use **sdk** (API-key) mode.

```bash
fly secrets set \
  BRIDGE_API_KEY=a-strong-random-password \
  --app my-bridge-app
```

Generate a strong `BRIDGE_API_KEY` — this is the only thing protecting the bridge:

```bash
openssl rand -base64 32
```

### 4. Deploy

```bash
fly deploy --app my-bridge-app
```

This builds the Docker image and deploys it. First deploy takes a few minutes.

### 5. Verify

```bash
curl -H "x-api-key: YOUR_BRIDGE_API_KEY" https://my-bridge-app.fly.dev/_bridge/health
# {"status":"ok","version":"1.0.0","uptime":...}
```

### 6. Connect from anubix-web

1. Open anubix-web > **Code** page
2. Bridge URL: `https://my-bridge-app.fly.dev`
3. API key: the `BRIDGE_API_KEY` you set in step 3

### Fly.io Configuration

The `fly.toml` is pre-configured:

| Setting                | Value         | Why                                                  |
| ---------------------- | ------------- | ---------------------------------------------------- |
| `internal_port`        | 8080          | Fly.io routes public HTTPS to this port              |
| `force_https`          | true          | All traffic is HTTPS                                 |
| `auto_stop_machines`   | off           | Machine stays running (bridge needs to be always-on) |
| `auto_start_machines`  | true          | Restarts if it stops                                 |
| `min_machines_running` | 1             | Always keep one machine up                           |
| `vm.size`              | shared-cpu-1x | Cheapest option, enough for one user                 |
| `vm.memory`            | 512mb         | Enough for bridge + Claude Code CLI                  |

### Workspace initialization

On first boot, `scripts/init-workspace.sh` runs before the bridge server. It supports:

| Env var         | What it does                                                    |
| --------------- | --------------------------------------------------------------- |
| `GIT_REPO_URL`  | Clones a git repo into `/workspace/project`                     |
| `TEMPLATE_URL`  | Downloads and extracts a `.tar.gz` template                     |
| `TEMPLATE_NAME` | Uses a built-in template (`nextjs`, `vite-react`, or `vanilla`) |
| _(none)_        | Starts with an empty workspace                                  |

Set these as secrets or env vars before first deploy:

```bash
fly secrets set GIT_REPO_URL=https://github.com/user/repo.git --app my-bridge-app
```

### Custom domain (optional)

If you want a custom domain instead of `app-name.fly.dev`:

```bash
fly certs create bridge.yourdomain.com --app my-bridge-app
```

Then add a CNAME record in your DNS pointing `bridge.yourdomain.com` to `my-bridge-app.fly.dev`.

### Useful commands

```bash
fly status --app my-bridge-app        # Machine status
fly logs --app my-bridge-app          # Live logs
fly ssh console --app my-bridge-app   # SSH into the machine
fly volumes list --app my-bridge-app  # Check volume
fly secrets list --app my-bridge-app  # List set secrets
```

---

## API Reference

All REST endpoints require `x-api-key` header or `?key=` query parameter.

### Health

```
GET /_bridge/health
```

### Sessions

```
GET    /api/sessions              # List all sessions
POST   /api/sessions              # Create session { repoPath, name?, mode?, repoPaths? }
GET    /api/sessions/:id          # Get session
PATCH  /api/sessions/:id          # Update session
DELETE /api/sessions/:id          # Delete session
GET    /api/sessions/:id/messages # Get message history
POST   /api/sessions/:id/pull     # Git pull for session repo(s)
```

### Preview

```
POST /api/preview/start    # Start dev server { sessionId, command?, port? }
POST /api/preview/stop     # Stop dev server
GET  /api/preview/status   # Dev server status
GET  /api/preview/logs     # Dev server logs (?tail=30)
```

### WebSocket

```
ws(s)://host/ws/:sessionId?key=API_KEY&lastSeq=N
```

**Client -> Bridge messages:**

- `{ type: 'message', content: '...' }` — Send prompt to Claude
- `{ type: 'approval', decision: 'allow' | 'deny' }` — Approve/deny tool use
- `{ type: 'question_answer', answers: {...} }` — Answer Claude's questions
- `{ type: 'abort' }` — Cancel running prompt
- `{ type: 'ping' }` — Keepalive

**Bridge -> Client messages:**

- `session_init` — Session info on connect
- `session_status` — Current status + pending prompts
- `text_delta` — Streaming text from Claude
- `tool_start` / `tool_progress` — Tool execution updates
- `approval_request` — Claude wants to use a tool
- `ask_question` — Claude has questions for the user
- `result` — Prompt completed (cost, tokens, duration)
- `error` — Error occurred
- `commands_available` — List of supported slash commands

**Chat commands (type in chat):**

- `/clear` — Reset conversation
- `/preview start [port] [command]` — Start dev server
- `/preview stop` — Stop dev server
- `/preview status` — Show dev server status
- `/preview logs [N]` — Show last N lines of logs

---

## Project Structure

```
anubix-bridge/
├── src/
│   ├── server.ts          # Express + WebSocket server setup
│   ├── agent.ts           # Claude Agent SDK integration, streaming, tool approval
│   ├── sessions.ts        # Session state persistence (data/sessions.json)
│   ├── messageLog.ts      # Message sequencing & replay (data/messages/)
│   ├── preview.ts         # Dev server spawning & HTTP/WS proxy
│   ├── commands.ts        # Bridge-level slash commands
│   ├── types.ts           # TypeScript interfaces
│   ├── ws/
│   │   └── handler.ts     # WebSocket connection handler
│   └── routes/
│       ├── sessions.ts    # REST API for sessions
│       └── preview.ts     # REST API for preview control
├── scripts/
│   └── init-workspace.sh  # Fly.io first-boot workspace setup
├── data/                  # Created at runtime
│   ├── sessions.json
│   └── messages/
├── dist/                  # Compiled JS (npm run build)
├── Dockerfile             # Multi-stage Docker image
├── fly.toml               # Fly.io deployment config
├── .env.example           # Environment template
├── package.json
└── tsconfig.json
```

---

## Current State

### Done!

- Bridge server with WebSocket + REST API
- Claude Code SDK integration with streaming
- Tool approval and question flows
- Message sequencing and reconnection replay
- Live preview proxy (HTTP + WebSocket)
- Multi-session support
- Dockerfile + Fly.io config
- Workspace initialization script (git clone, templates)
- Claude via CLI subscription by default (optional sdk mode for API-key deployments)

### In Progress

- Automated Fly.io machine provisioning per user (from anubix-web)
- Git push flow (edit on Fly.io -> push to GitHub -> Vercel auto-deploys)

### Not Yet Started

- Patterns system (one-click feature templates)
- Supabase Storage bucket auto-creation in setup wizard

