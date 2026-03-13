import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import httpProxy from 'http-proxy';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type WebSocket from 'ws';

import { shutdownPreview } from './preview.js';
import credentialsRouter from './routes/credentials.js';
import envRouter from './routes/env.js';
import execRouter from './routes/exec.js';
import logsRouter, { installLogCapture } from './routes/logs.js';
import previewRouter from './routes/preview.js';
import reposRouter from './routes/repos.js';
import sessionsRouter from './routes/sessions.js';

// Install log capture as early as possible so all logs are buffered
installLogCapture();
import { listSessions } from './sessions.js';
import { handleWebSocket, isAlive, setAlive } from './ws/handler.js';

const PORT = parseInt(process.env.PORT || '3456', 10);
delete process.env.PORT; // Prevent child processes (e.g. npm run dev) from inheriting this
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const DEV_SERVER_PORT = parseInt(process.env.PREVIEW_FALLBACK_PORT || '3000', 10);

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
app.use('/_bridge/env', envRouter);
app.use('/_bridge/credentials', credentialsRouter);
app.use('/_bridge/exec', execRouter);
app.use('/_bridge/logs', logsRouter);
app.use('/_bridge/repos', reposRouter);

app.get('/_bridge/activity', (_req, res) => {
  const sessions = listSessions();
  const lastActiveAt = Math.max(...sessions.map(s => s.lastActiveAt || 0), 0);
  const idleSeconds = lastActiveAt > 0 ? Math.floor((Date.now() - lastActiveAt) / 1000) : -1;
  res.json({ lastActiveAt, idleSeconds, sessions: sessions.length });
});

// --- Reverse proxy: forward everything else to the dev server on port 3000 ---
// This lets the user's app (Next.js, Vite, etc.) be accessible at the same URL
// as the bridge, without the broken /preview/ subpath approach. Since all bridge
// routes use /_bridge/ prefix, there's no conflict with the user's app routes.
const devProxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

devProxy.on('error', (_err, _req, res) => {
  if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
    (res as import('http').ServerResponse).writeHead(502, { 'Content-Type': 'text/plain' });
    (res as import('http').ServerResponse).end('Dev server not running yet — waiting for port ' + DEV_SERVER_PORT);
  }
});

// Catch-all: proxy all non-bridge requests to the dev server
app.use((req, res) => {
  devProxy.web(req, res, { target: `http://127.0.0.1:${DEV_SERVER_PORT}` });
});

// --- HTTP + WebSocket server ---
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// --- WebSocket heartbeat (30s) -- detect dead connections ---
const HEARTBEAT_INTERVAL_MS = 30_000;
const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (!isAlive(ws as WebSocket)) {
      console.log('Heartbeat: terminating dead connection');
      ws.terminate();
      continue;
    }
    setAlive(ws as WebSocket, false);
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

// Handle WebSocket upgrade -- bridge sessions go to WSS, everything else proxied to dev server
server.on('upgrade', (request: IncomingMessage, socket, head) => {
  const url = new URL(request.url || '', `http://localhost:${PORT}`);
  const pathMatch = url.pathname.match(/^\/ws\/(.+)$/);

  if (!pathMatch) {
    // Not a bridge WebSocket -- proxy to dev server (HMR, hot reload, etc.)
    devProxy.ws(request, socket, head, { target: `http://127.0.0.1:${DEV_SERVER_PORT}` });
    return;
  }

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
    handleWebSocket(ws as WebSocket, sessionId, lastSeq);
  });
});

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Bridge server running on http://localhost:${PORT}`);
  console.log(`Bridge API: http://localhost:${PORT}/_bridge/`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws/:sessionId?key=...`);
  console.log(`Dev server preview: proxied from port ${DEV_SERVER_PORT}`);
  console.log(`Claude mode: ${process.env.CLAUDE_MODE || 'sdk'}`);
});

// --- Graceful shutdown ---
function gracefulShutdown() {
  console.log('\nShutting down…');
  clearInterval(heartbeatInterval);
  shutdownPreview();
  devProxy.close();
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
