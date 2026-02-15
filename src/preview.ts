import { spawn, type ChildProcess, execSync } from 'child_process';
import http from 'http';
import net from 'net';
import httpProxy from 'http-proxy';

import { getSession } from './sessions.js';
import type { PreviewState, PreviewStatusResponse } from './types.js';

const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT || '3457', 10);
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
let proxyServer: http.Server | null = null;

function pushLog(line: string) {
  logs.push(line);
  if (logs.length > MAX_LOG_LINES) {
    logs = logs.slice(logs.length - MAX_LOG_LINES);
  }
}

// --- Proxy server ---

export function startProxyServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });

    proxy.on('error', (_err, _req, res) => {
      if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
        (res as http.ServerResponse).writeHead(502, { 'Content-Type': 'text/plain' });
        (res as http.ServerResponse).end('502 Bad Gateway — dev server not ready');
      }
    });

    proxyServer = http.createServer(async (req, res) => {
      // If a managed dev server is running, use its port
      if (state && state.status === 'running') {
        proxy.web(req, res, { target: `http://127.0.0.1:${state.port}` });
        return;
      }
      if (state && state.status === 'starting') {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('502 Dev server starting…');
        return;
      }
      // No managed dev server — check if something is already listening on the fallback port
      const fallbackPort = state?.port || FALLBACK_PORT;
      if (await isPortListening(fallbackPort)) {
        proxy.web(req, res, { target: `http://127.0.0.1:${fallbackPort}` });
        return;
      }
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('503 No preview active — nothing listening on port ' + fallbackPort);
    });

    proxyServer.on('upgrade', (req, socket, head) => {
      if (!state || state.status !== 'running') {
        socket.destroy();
        return;
      }
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${state.port}` });
    });

    proxyServer.listen(PREVIEW_PORT, () => {
      console.log(`Preview proxy listening on http://localhost:${PREVIEW_PORT}`);
      resolve();
    });

    proxyServer.on('error', reject);
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
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
}
