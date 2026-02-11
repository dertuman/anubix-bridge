import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';

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

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, sessionId);
  });
});

// The 'connection' event is emitted with custom args from handleUpgrade + emit
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(wss as any).on('connection', (ws: any, _request: any, sessionId: string) => {
  console.log(`WebSocket connected: session ${sessionId}`);
  handleWebSocket(ws, sessionId);
});

server.listen(PORT, () => {
  console.log(`Bridge server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/:sessionId?key=...`);
});
