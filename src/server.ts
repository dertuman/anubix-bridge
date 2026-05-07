import 'dotenv/config';

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import httpProxy from 'http-proxy';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type WebSocket from 'ws';

import { shutdownPreview } from './preview.js';
import { startRegistration, type RegistrationHandle } from './register.js';
import credentialsRouter from './routes/credentials.js';
import envRouter from './routes/env.js';
import execRouter from './routes/exec.js';
import logsRouter, { installLogCapture } from './routes/logs.js';
import previewRouter from './routes/preview.js';
import reposRouter from './routes/repos.js';
import sessionsRouter from './routes/sessions.js';
import { startNamedTunnel, startQuickTunnel, type TunnelHandle } from './tunnel.js';

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

// Log the key prefix so it's easy to spot when .env has a stale duplicate
// entry (dotenv uses the FIRST occurrence — the most common reason the web
// reports "connected" but all session requests 401).
const keyPreview = `${BRIDGE_API_KEY.slice(0, 4)}…${BRIDGE_API_KEY.slice(-4)}`;
console.log(`[bridge] using BRIDGE_API_KEY ${keyPreview} (${BRIDGE_API_KEY.length} chars)`);

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

/** What actually runs Claude when you use anubix-web: SDK from this repo + (in cli mode) your global `claude` binary on PATH. */
function logClaudeToolingVersions() {
  try {
    const pkgPath = join(SERVER_DIR, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
    const sdk = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? '(missing)';
    console.log(`[bridge] @anthropic-ai/claude-agent-sdk in package.json: ${sdk}`);
  } catch {
    console.warn('[bridge] could not read package.json for SDK dependency line');
  }

  const mode = (process.env.CLAUDE_MODE || 'sdk').toLowerCase();
  if (mode !== 'cli') {
    console.log(
      '[bridge] CLAUDE_MODE=sdk — using ANTHROPIC_API_KEY from the environment. ' +
        'For normal use prefer CLAUDE_MODE=cli and omit ANTHROPIC_API_KEY from .env.',
    );
    return;
  }

  try {
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const out = execSync('claude --version', {
      encoding: 'utf8',
      shell,
      timeout: 15_000,
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' | ');
    console.log(`[bridge] Claude Code CLI (same as anubix-web will use on this machine): ${out || '(no output)'}`);
  } catch {
    console.warn(
      '[bridge] `claude --version` failed. Install Claude Code CLI and ensure it is on PATH for the user that runs npm run dev.',
    );
  }
}

logClaudeToolingVersions();

/** Resolved tunnel behaviour (for health + startup logs). No secrets. */
function effectiveTunnelPlan(): 'off' | 'named' | 'quick' | 'manual' {
  const rawToken = process.env.ANUBIX_INSTALL_TOKEN;
  const mode = (process.env.TUNNEL_MODE || (rawToken ? 'auto' : 'none')).toLowerCase();
  if (mode === 'none') return 'off';
  if (mode === 'manual') return 'manual';
  if (mode !== 'auto') return 'off';
  return process.env.TUNNEL_NAME ? 'named' : 'quick';
}

const app = express();
// Explicit CORS config — preflight (OPTIONS) must allow x-api-key or the
// browser rejects the real request with "Failed to fetch" and the web UI
// reports "Unable to reach bridge server".
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-install-token'],
  credentials: false,
}));
app.use(express.json());

// --- API key auth middleware ---
function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  // Never auth-gate preflights — cors() already answered them.
  if (req.method === 'OPTIONS') return next();

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
  const webUrl = process.env.ANUBIX_WEB_URL || 'https://anubix.ai';
  const tunnelMode = (
    process.env.TUNNEL_MODE || (process.env.ANUBIX_INSTALL_TOKEN ? 'auto' : 'none')
  ).toLowerCase();
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    settings: {
      tunnelMode,
      tunnelPlan: effectiveTunnelPlan(),
      tunnelName: process.env.TUNNEL_NAME || null,
      publicUrl: process.env.PUBLIC_URL || null,
      anubixWebUrl: webUrl,
      port: PORT,
      previewFallbackPort: DEV_SERVER_PORT,
      claudeMode: process.env.CLAUDE_MODE || 'sdk',
      reposBasePathConfigured: Boolean(process.env.REPOS_BASE_PATH),
      installTokenConfigured: Boolean(process.env.ANUBIX_INSTALL_TOKEN),
      cloudflaredProtocol:
        (process.env.CLOUDFLARED_PROTOCOL || '').toLowerCase() === 'http2' ? 'http2' : 'quic',
    },
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
let tunnel: TunnelHandle | null = null;
let registration: RegistrationHandle | null = null;

function logStartupConfigSummary() {
  const plan = effectiveTunnelPlan();
  const webUrl = process.env.ANUBIX_WEB_URL || 'https://anubix.ai';
  const mode = (process.env.TUNNEL_MODE || (process.env.ANUBIX_INSTALL_TOKEN ? 'auto' : 'none')).toLowerCase();
  console.log(
    '[bridge] effective settings (compare with your .env):\n' +
      `      TUNNEL_MODE=${mode}  tunnel plan: ${plan}\n` +
      `      TUNNEL_NAME=${process.env.TUNNEL_NAME || '(unset)'}\n` +
      `      PUBLIC_URL=${process.env.PUBLIC_URL || '(unset)'}\n` +
      `      ANUBIX_WEB_URL=${webUrl}\n` +
      `      PORT=${PORT}  dev preview fallback port: ${DEV_SERVER_PORT}\n` +
      `      CLAUDE_MODE=${process.env.CLAUDE_MODE || 'sdk'}\n` +
      `      REPOS_BASE_PATH=${process.env.REPOS_BASE_PATH ? 'set' : 'unset'}\n` +
      `      ANUBIX_INSTALL_TOKEN=${process.env.ANUBIX_INSTALL_TOKEN ? 'set' : 'unset'}\n` +
      `      cloudflared edge protocol: ${
        (process.env.CLOUDFLARED_PROTOCOL || '').toLowerCase() === 'http2' ? 'http2' : 'quic (default)'
      }`,
  );
}

server.listen(PORT, HOST, () => {
  console.log(`Bridge server running on http://localhost:${PORT}`);
  console.log(`Bridge API: http://localhost:${PORT}/_bridge/`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws/:sessionId?key=...`);
  console.log(`Dev server preview: proxied from port ${DEV_SERVER_PORT}`);
  console.log(`Claude mode: ${process.env.CLAUDE_MODE || 'sdk'}`);
  logStartupConfigSummary();

  void initTunnelAndRegister();
});

async function initTunnelAndRegister() {
  const installToken = process.env.ANUBIX_INSTALL_TOKEN;
  // Default to the hosted anubix.ai. Users running a different anubix-web
  // can override. Fly.io/production deployments don't ship an install token
  // so this whole branch is skipped anyway.
  const webUrl = process.env.ANUBIX_WEB_URL || 'https://anubix.ai';
  const tunnelMode = (process.env.TUNNEL_MODE || (installToken ? 'auto' : 'none')).toLowerCase();

  if (tunnelMode === 'none') return;

  if (!installToken) {
    console.warn(
      `[tunnel] TUNNEL_MODE=${tunnelMode} requires ANUBIX_INSTALL_TOKEN. Skipping self-registration.`,
    );
    return;
  }

  let publicUrl: string | null = null;
  const tunnelName = process.env.TUNNEL_NAME;

  if (tunnelMode === 'auto') {
    try {
      if (tunnelName) {
        publicUrl = process.env.PUBLIC_URL || null;
        if (!publicUrl) {
          console.warn('[tunnel] TUNNEL_NAME requires PUBLIC_URL so the bridge knows its own address. Skipping.');
          return;
        }
        tunnel = await startNamedTunnel(tunnelName, publicUrl, PORT);
      } else {
        tunnel = await startQuickTunnel(PORT);
      }
      publicUrl = tunnel.publicUrl;
    } catch (err) {
      console.error('[tunnel] failed to start cloudflared:', err instanceof Error ? err.message : err);
      return;
    }
  } else if (tunnelMode === 'manual') {
    publicUrl = process.env.PUBLIC_URL || null;
    if (!publicUrl) {
      console.warn('[tunnel] TUNNEL_MODE=manual requires PUBLIC_URL. Skipping self-registration.');
      return;
    }
  } else {
    console.warn(`[tunnel] unknown TUNNEL_MODE=${tunnelMode}. Expected auto|manual|none.`);
    return;
  }

  registration = startRegistration({
    webUrl,
    installToken,
    initialPublicUrl: publicUrl,
  });

  tunnel?.onUrlChange((url) => registration?.updateUrl(url));
}

// --- Graceful shutdown ---
function gracefulShutdown() {
  console.log('\nShutting down…');
  clearInterval(heartbeatInterval);
  registration?.stop();
  tunnel?.close();
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
