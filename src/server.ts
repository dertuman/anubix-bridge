import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type WebSocket from 'ws';

import { previewProxyMiddleware, handlePreviewUpgrade, shutdownPreview } from './preview.js';
import previewRouter from './routes/preview.js';
import sessionsRouter from './routes/sessions.js';
import { handleWebSocket } from './ws/handler.js';

const PORT = parseInt(process.env.PORT || '3456', 10);
delete process.env.PORT; // Prevent child processes (e.g. npm run dev) from inheriting this
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

if (!BRIDGE_API_KEY) {
  console.error('BRIDGE_API_KEY is required. Set it in your .env file.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// --- API key auth middleware ---
function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const key =
    req.headers['x-api-key'] ||
    (req.query.key as string | undefined);

  if (key !== BRIDGE_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.use('/_bridge', authMiddleware);

// --- REST routes (all under /_bridge to avoid clashing with the preview app) ---
app.get('/_bridge/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
  });
});

app.use('/_bridge/sessions', sessionsRouter);
app.use('/_bridge/preview', previewRouter);

// --- Preview proxy (catch-all — everything not matched above goes to dev server) ---
app.use(previewProxyMiddleware());

// --- HTTP + WebSocket server ---
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// --- WebSocket heartbeat (30s) — detect dead connections ---
const HEARTBEAT_INTERVAL_MS = 30_000;
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    const sock = ws as WebSocket & { isAlive?: boolean };
    if (sock.isAlive === false) {
      console.log('Heartbeat: terminating dead connection');
      sock.terminate();
      continue;
    }
    sock.isAlive = false;
    sock.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

// Handle WebSocket upgrade: /ws/* → bridge sessions, everything else → preview HMR
server.on('upgrade', (request: IncomingMessage, socket, head) => {
  const url = new URL(request.url || '', `http://localhost:${PORT}`);

  // Bridge WebSocket at /ws/:sessionId
  const pathMatch = url.pathname.match(/^\/ws\/(.+)$/);

  if (pathMatch) {
    // Auth check
    const key =
      url.searchParams.get('key') ||
      request.headers['x-api-key'];

    if (key !== BRIDGE_API_KEY) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const sessionId = pathMatch[1];
    const lastSeqParam = url.searchParams.get('lastSeq');
    const lastSeq = lastSeqParam !== null ? parseInt(lastSeqParam, 10) : undefined;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, sessionId, lastSeq);
    });
    return;
  }

  // Everything else → preview WebSocket (Next.js HMR, Vite HMR, etc.)
  handlePreviewUpgrade(request, socket, head);
});

// The 'connection' event is emitted with custom args from handleUpgrade + emit
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(wss as any).on('connection', (ws: any, _request: any, sessionId: string, lastSeq?: number) => {
  console.log(`WebSocket connected: session ${sessionId}${lastSeq !== undefined ? ` (lastSeq=${lastSeq})` : ''}`);
  handleWebSocket(ws, sessionId, lastSeq);
});

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Bridge server running on http://localhost:${PORT}`);
  console.log(`Bridge API: http://localhost:${PORT}/_bridge/`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/:sessionId?key=...`);
  console.log(`Preview: http://localhost:${PORT}/ (proxied to dev server)`);
  console.log(`Default Claude mode: ${process.env.CLAUDE_MODE || 'sdk'}`);
});

// --- Dedicated preview server (separate port for Cloudflare tunnel) ---
const PREVIEW_PORT = process.env.PREVIEW_PORT
  ? parseInt(process.env.PREVIEW_PORT, 10)
  : null;

let previewServer: ReturnType<typeof createServer> | null = null;

if (PREVIEW_PORT) {
  const previewApp = express();
  previewApp.use(cors());
  // Mount the same proxy middleware at root (no /preview prefix needed)
  previewApp.use('/', previewProxyMiddleware());

  previewServer = createServer(previewApp);

  // Handle WebSocket upgrades (HMR / hot reload from Next.js, Vite, etc.)
  previewServer.on('upgrade', (request, socket, head) => {
    handlePreviewUpgrade(request, socket, head);
  });

  previewServer.listen(PREVIEW_PORT, HOST, () => {
    console.log(`Preview server running on http://localhost:${PREVIEW_PORT}`);
  });
}

// --- Graceful shutdown ---
function gracefulShutdown() {
  console.log('\nShutting down…');
  clearInterval(heartbeatInterval);
  shutdownPreview();
  wss.close();
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5s if server.close hangs
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Prevent SDK unhandled rejections (e.g. after interrupt()) from crashing the process
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (/closed|abort|interrupt/i.test(msg)) {
    console.log(`Suppressed expected rejection: ${msg}`);
    return;
  }
  console.error('Unhandled rejection:', reason);
});
