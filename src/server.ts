import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';

import { startProxyServer, shutdownPreview } from './preview.js';
import previewRouter from './routes/preview.js';
import sessionsRouter from './routes/sessions.js';
import { handleWebSocket } from './ws/handler.js';

const PORT = parseInt(process.env.PORT || '3456', 10);
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

app.use('/api', authMiddleware);

// --- REST routes ---
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
  });
});

app.use('/api/sessions', sessionsRouter);
app.use('/api/preview', previewRouter);

// --- HTTP + WebSocket server ---
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade with auth + session routing
server.on('upgrade', (request: IncomingMessage, socket, head) => {
  const url = new URL(request.url || '', `http://localhost:${PORT}`);
  const pathMatch = url.pathname.match(/^\/ws\/(.+)$/);

  if (!pathMatch) {
    socket.destroy();
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
    wss.emit('connection', ws, request, sessionId, lastSeq);
  });
});

// The 'connection' event is emitted with custom args from handleUpgrade + emit
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(wss as any).on('connection', (ws: any, _request: any, sessionId: string, lastSeq?: number) => {
  console.log(`WebSocket connected: session ${sessionId}${lastSeq !== undefined ? ` (lastSeq=${lastSeq})` : ''}`);
  handleWebSocket(ws, sessionId, lastSeq);
});

server.listen(PORT, async () => {
  console.log(`Bridge server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/:sessionId?key=...`);
  console.log(`Default Claude mode: ${process.env.CLAUDE_MODE || 'sdk'}`);
  await startProxyServer();
});

// --- Graceful shutdown ---
function gracefulShutdown() {
  console.log('\nShutting down…');
  shutdownPreview();
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
