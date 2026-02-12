# Claude Code Bridge

An Express + WebSocket server that acts as a bridge to control Claude Code remotely. Wraps the `@anthropic-ai/claude-agent-sdk` to allow mobile apps and remote clients to interact with Claude Code through a REST API and WebSocket connections.

**Developed by [TALKARTECH LTD](https://talkartech.com)**

## Prerequisites

- **Node.js 18+**
- **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

```env
ANTHROPIC_API_KEY=sk-ant-your-real-key-here
BRIDGE_API_KEY=your-shared-secret
PORT=3456
```

| Variable            | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (used server-side to call Claude)             |
| `BRIDGE_API_KEY`    | A shared secret your client app uses to authenticate with the bridge |
| `PORT`              | Server port (defaults to `3456`)                                     |

> **Important:** `BRIDGE_API_KEY` is NOT your Anthropic key. It's a password you choose that your client app sends to authenticate with the bridge server.

### 3. Start the server

**Development** (auto-reloads on changes):

```bash
npm run dev
```

**Production:**

```bash
npm run build
npm start
```

You should see:

```
Bridge server running on http://localhost:3456
WebSocket endpoint: ws://localhost:3456/ws/:sessionId?key=...
```

### 4. Verify it works

```bash
curl http://localhost:3456/api/health -H "x-api-key: your-shared-secret"
```

Expected: `{"status":"ok","version":"1.0.0","uptime":...}`

## API Reference

All HTTP endpoints require authentication via the `x-api-key` header or `?key=` query parameter.

### REST Endpoints

| Method   | Endpoint            | Description         |
| -------- | ------------------- | ------------------- |
| `GET`    | `/api/health`       | Health check        |
| `GET`    | `/api/sessions`     | List all sessions   |
| `POST`   | `/api/sessions`     | Create a session    |
| `GET`    | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Delete a session    |

#### Create Session

```bash
curl -X POST http://localhost:3456/api/sessions \
  -H "x-api-key: your-shared-secret" \
  -H "Content-Type: application/json" \
  -d '{"repoPath": "C:/path/to/your/project", "name": "my-session"}'
```

Response:

```json
{
  "data": {
    "id": "uuid-here",
    "name": "my-session",
    "repoPath": "C:/path/to/your/project",
    "status": "idle",
    "createdAt": 1770900000000
  }
}
```

### WebSocket

Connect to `ws://localhost:3456/ws/:sessionId?key=your-shared-secret`

#### Client -> Server Messages

| Type              | Payload                                             | Description                   |
| ----------------- | --------------------------------------------------- | ----------------------------- |
| `message`         | `{ type: "message", content: "your prompt" }`       | Send a prompt to Claude       |
| `approval`        | `{ type: "approval", decision: "allow" \| "deny" }` | Approve/deny a tool execution |
| `question_answer` | `{ type: "question_answer", answers: {...} }`       | Answer a question from Claude |

#### Server -> Client Messages

| Type               | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `session_init`     | Connection established, includes session ID and model         |
| `text_delta`       | Streaming text chunk from Claude                              |
| `tool_start`       | Claude is executing a tool (includes `toolName`, `toolInput`) |
| `tool_end`         | Tool execution completed                                      |
| `approval_request` | Claude needs permission to run a tool                         |
| `ask_question`     | Claude is asking a question                                   |
| `result`           | Final result with cost and duration                           |
| `error`            | Error message                                                 |

#### WebSocket Test (Node.js)

```javascript
const WebSocket = require("ws");
const ws = new WebSocket(
  "ws://localhost:3456/ws/SESSION_ID?key=your-shared-secret",
);

ws.on("open", () => {
  console.log("Connected");
  ws.send(JSON.stringify({ type: "message", content: "Say hello" }));
});

ws.on("message", (data) => {
  console.log("Response:", JSON.parse(data.toString()));
});
```

## Exposing to the Internet (Cloudflare Tunnel)

To access the bridge from a mobile app or remote client, you need to expose it via a tunnel.

### Option A: Quick Tunnel (testing, random URL)

No account needed. URL changes on every restart.

```bash
cloudflared tunnel --url http://localhost:3456
```

On Windows, if `cloudflared` isn't in PATH:

```powershell
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3456
```

This gives you a temporary URL like `https://random-words.trycloudflare.com`.

### Option B: Named Tunnel (production, stable URL)

Requires a domain on Cloudflare (a `.xyz` domain costs ~$2).

1. **Install cloudflared:** [Download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

   ```bash
   winget install cloudflare.cloudflared
   ```

2. **Create a tunnel** in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/):
   - Go to Networks > Tunnels > Create a tunnel
   - Name it and install the connector (run the provided command in an admin terminal)

3. **Add a public hostname route** in the tunnel config:
   | Field | Value |
   |---|---|
   | Subdomain | `bridge` (or your choice) |
   | Domain | Your Cloudflare domain |
   | Type | `HTTP` |
   | URL | `localhost:3456` |

4. Your stable URL is now `https://bridge.talkartech.co.uk`

> **Note:** The domain must use Cloudflare's nameservers. Partial/CNAME setup requires a Business plan. If your domain uses another DNS provider (e.g., Vercel), the easiest option is to buy a cheap domain directly on Cloudflare.

### Connecting Your Client App

Once the tunnel is running:

- **REST:** `https://bridge.talkartech.co.uk/api/sessions`
- **WebSocket:** `wss://bridge.talkartech.co.uk/ws/:sessionId?key=your-shared-secret`

All HTTP requests need the `x-api-key: your-shared-secret` header. WebSocket connections pass the key as a query parameter.

#### Example Connection

For example, if your bridge is hosted at `bridge.talkartech.co.uk`:

**Test the health endpoint:**

```bash
curl https://bridge.talkartech.co.uk/api/health -H "x-api-key: your-shared-secret"
```

**Create a session:**

```bash
curl -X POST https://bridge.talkartech.co.uk/api/sessions \
  -H "x-api-key: your-shared-secret" \
  -H "Content-Type: application/json" \
  -d '{"repoPath": "C:/Users/alex9/Documents/GitHub/my-project", "name": "mobile-session"}'
```

**Connect via WebSocket (Node.js example):**

```javascript
const WebSocket = require("ws");
const ws = new WebSocket(
  "wss://bridge.talkartech.co.uk/ws/SESSION_ID?key=your-shared-secret",
);

ws.on("open", () => {
  console.log("Connected to bridge.talkartech.co.uk");
  ws.send(
    JSON.stringify({
      type: "message",
      content: "What files are in this repo?",
    }),
  );
});

ws.on("message", (data) => {
  console.log("Response:", JSON.parse(data.toString()));
});
```

## Project Structure

```
src/
  server.ts          # Express + WebSocket server entry point
  agent.ts           # Claude agent interaction (prompt execution, streaming)
  sessions.ts        # Session state management (in-memory store)
  types.ts           # TypeScript type definitions
  routes/
    sessions.ts      # REST API route handlers
  ws/
    handler.ts       # WebSocket message routing
```

## Architecture

```
Client App (mobile/web)
    |
    |-- REST API (HTTPS) --> Create/list/delete sessions
    |-- WebSocket (WSS)  --> Real-time prompt/response streaming
    |
Cloudflare Tunnel (HTTPS/WSS termination)
    |
Bridge Server (Express + WS on localhost:3456)
    |
Claude Agent SDK --> Anthropic API
```

- **Multi-session support** - Multiple concurrent Claude Code sessions
- **Real-time streaming** - WebSocket for immediate message/response relay
- **API key authentication** - Shared secret on all endpoints
- **Session resumption** - Stores conversation IDs for multi-turn conversations
- **Tool integration** - Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch

## License & Credits

This project is developed and maintained by **TALKARTECH LTD**.

For questions or support, visit [talkartech.com](https://talkartech.com).

---

© TALKARTECH LTD. All rights reserved.
