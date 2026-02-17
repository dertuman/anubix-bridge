import { spawn, type ChildProcess, execSync } from 'child_process';
import type http from 'http';
import net from 'net';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import httpProxy from 'http-proxy';
import type express from 'express';

import { getSession } from './sessions.js';
import type { PreviewState, PreviewStatusResponse } from './types.js';

const FALLBACK_PORT = parseInt(process.env.PREVIEW_FALLBACK_PORT || '3000', 10);
const MAX_LOG_LINES = 200;
const READY_TIMEOUT_MS = 3000;
const READY_PATTERNS = [/localhost/i, /ready/i, /compiled/i, /listening/i, /started/i];

/** Check if something is listening on a given port */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

let state: PreviewState | null = null;
let proc: ChildProcess | null = null;
let logs: string[] = [];

// The shared proxy instance — created once, used by both HTTP and WS handlers
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

proxy.on('error', (_err, _req, res) => {
  if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
    (res as http.ServerResponse).writeHead(502, { 'Content-Type': 'text/plain' });
    (res as http.ServerResponse).end('502 Bad Gateway — dev server not ready');
  }
});

function pushLog(line: string) {
  logs.push(line);
  if (logs.length > MAX_LOG_LINES) {
    logs = logs.slice(logs.length - MAX_LOG_LINES);
  }
}

// --- Preview proxy middleware (mounted on /preview in Express) ---

/**
 * Express middleware that proxies all requests under /preview/ to the dev server.
 * Strips the /preview prefix before forwarding.
 */
export function previewProxyMiddleware(): express.RequestHandler {
  return async (req, res) => {
    const targetPort = state?.port || FALLBACK_PORT;

    // If a managed dev server is running, use its port
    if (state && state.status === 'running') {
      proxy.web(req, res, { target: `http://127.0.0.1:${targetPort}` });
      return;
    }
    if (state && state.status === 'starting') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('502 Dev server starting…');
      return;
    }
    // No managed dev server — check if something is already listening on the fallback port
    if (await isPortListening(targetPort)) {
      proxy.web(req, res, { target: `http://127.0.0.1:${targetPort}` });
      return;
    }
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('503 No preview active — nothing listening on port ' + targetPort);
  };
}

/**
 * Handle WebSocket upgrades for the /preview/ path.
 * Called from the main server's 'upgrade' event handler.
 */
export function handlePreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const targetPort = state?.port || FALLBACK_PORT;

  if (state && state.status === 'running') {
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${targetPort}` });
    return;
  }
  // If dev server isn't running, check fallback port
  isPortListening(targetPort).then((listening) => {
    if (listening) {
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${targetPort}` });
    } else {
      socket.destroy();
    }
  });
}

// --- Dev server management ---

export function startDevServer(opts: {
  sessionId: string;
  command?: string;
  port?: number;
}): PreviewStatusResponse {
  const session = getSession(opts.sessionId);
  if (!session) {
    throw new Error(`Session not found: ${opts.sessionId}`);
  }

  // Stop any existing preview first
  if (proc) {
    stopDevServer();
  }

  const port = opts.port || 3000;
  const command = opts.command || 'npm run dev';

  logs = [];
  state = {
    sessionId: opts.sessionId,
    command,
    port,
    status: 'starting',
    startedAt: Date.now(),
  };

  const env = {
    ...process.env,
    PORT: String(port),
    BROWSER: 'none',
  };

  const isWindows = process.platform === 'win32';
  proc = spawn(command, {
    cwd: session.repoPath,
    shell: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(isWindows ? {} : { detached: true }),
  });

  state.pid = proc.pid;

  let readyFired = false;
  const markRunning = () => {
    if (!readyFired && state && state.status === 'starting') {
      readyFired = true;
      state.status = 'running';
      console.log(`Preview dev server ready (port ${port})`);
    }
  };

  const handleOutput = (data: Buffer) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed) pushLog(trimmed);
    }
    if (!readyFired && READY_PATTERNS.some((re) => re.test(text))) {
      markRunning();
    }
  };

  proc.stdout?.on('data', handleOutput);
  proc.stderr?.on('data', handleOutput);

  // Fallback: mark running after timeout even if no pattern matched
  setTimeout(markRunning, READY_TIMEOUT_MS);

  proc.on('error', (err) => {
    pushLog(`[error] ${err.message}`);
    if (state) {
      state.status = 'error';
      state.error = err.message;
    }
    proc = null;
  });

  proc.on('exit', (code) => {
    pushLog(`[exit] Process exited with code ${code}`);
    if (state && state.status !== 'stopped') {
      state.status = 'stopped';
    }
    proc = null;
  });

  return getStatus();
}

export function stopDevServer(): void {
  if (proc && proc.pid) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
      } else {
        process.kill(-proc.pid!, 'SIGTERM');
      }
    } catch {
      // Process may already be dead
    }
    proc = null;
  }

  if (state) {
    state.status = 'stopped';
  }
}

export function getStatus(): PreviewStatusResponse {
  if (!state) {
    return { active: false };
  }
  return {
    active: state.status === 'starting' || state.status === 'running',
    sessionId: state.sessionId,
    command: state.command,
    port: state.port,
    status: state.status,
    pid: state.pid,
    error: state.error,
    startedAt: state.startedAt,
  };
}

export function getLogs(tail?: number): string[] {
  if (!tail || tail >= logs.length) return [...logs];
  return logs.slice(-tail);
}

export function shutdownPreview(): void {
  stopDevServer();
  proxy.close();
}
