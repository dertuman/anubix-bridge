import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Manages cloudflared tunnels — both "quick" (random trycloudflare.com URL)
 * and "named" (pre-configured tunnel like bridge.talkartech.co.uk).
 *
 * Cloudflared must be on PATH. We don't attempt to auto-install it — the
 * error message points the user to the install docs.
 */

export interface TunnelHandle {
  publicUrl: string;
  close: () => void;
  onUrlChange: (_cb: (_url: string) => void) => void;
}

const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const CONNECTED_REGEX = /Registered tunnel connection|registered connIndex/i;
const STARTUP_TIMEOUT_MS = 30_000;

/** Env vars that cloudflared interprets — strip them so child doesn't inherit unwanted config */
const CLOUDFLARED_ENV_VARS = ['TUNNEL_NAME', 'TUNNEL_TOKEN', 'TUNNEL_ORIGIN_CERT'];

function cleanEnvForCloudflared(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of CLOUDFLARED_ENV_VARS) delete env[key];
  return env;
}

/** QUIC can glitch behind some VPNs; set CLOUDFLARED_PROTOCOL=http2 to use HTTP/2 to Cloudflare edge instead. */
function cloudflaredProtocolArgs(): string[] {
  const p = (process.env.CLOUDFLARED_PROTOCOL || '').toLowerCase();
  if (p === 'http2') return ['--protocol', 'http2'];
  return [];
}

function handleSpawnError(err: Error) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    console.error(
      '\n[tunnel] cloudflared not found on PATH.\n' +
      '        Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
      '        Or set TUNNEL_MODE=none if you don\'t need a tunnel.\n',
    );
  } else {
    console.error('[tunnel] cloudflared spawn error:', err);
  }
}

function pipeOutput(child: ChildProcess, onChunk?: (text: string) => void) {
  const handle = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) console.log(`[cloudflared] ${line}`);
    }
    onChunk?.(text);
  };
  child.stdout?.on('data', handle);
  child.stderr?.on('data', handle);
}

/**
 * Start a named tunnel: `cloudflared tunnel --no-autoupdate --config <generated> run <tunnelName>`
 *
 * Generates a minimal config file with a catch-all ingress rule pointing to
 * localhost:port so cloudflared knows where to route traffic.
 * The public URL must be known ahead of time (configured in Cloudflare dashboard DNS).
 */
export async function startNamedTunnel(
  tunnelName: string,
  publicUrl: string,
  port: number,
): Promise<TunnelHandle> {
  console.log(`[tunnel] starting named tunnel "${tunnelName}" → ${publicUrl} (origin localhost:${port})`);

  const configDir = join(tmpdir(), 'anubix-bridge');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'cloudflared-config.yml');

  const hostname = new URL(publicUrl).hostname;
  const configContent = [
    `tunnel: ${tunnelName}`,
    `ingress:`,
    `  - hostname: ${hostname}`,
    `    service: http://localhost:${port}`,
    `  - service: http_status:404`,
  ].join('\n');

  writeFileSync(configPath, configContent, 'utf8');
  console.log(`[tunnel] wrote cloudflared config → ${configPath}`);

  const child = spawn(
    'cloudflared',
    [
      'tunnel',
      '--no-autoupdate',
      ...cloudflaredProtocolArgs(),
      '--config',
      configPath,
      'run',
      tunnelName,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnvForCloudflared() },
  ).on('error', handleSpawnError);

  let connected = false;

  pipeOutput(child, (text) => {
    if (!connected && CONNECTED_REGEX.test(text)) {
      connected = true;
    }
  });

  child.on('exit', (code, signal) => {
    console.warn(`[tunnel] cloudflared exited (code=${code}, signal=${signal})`);
  });

  return new Promise<TunnelHandle>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!connected) {
        reject(new Error(`Named tunnel "${tunnelName}" did not connect within ${STARTUP_TIMEOUT_MS / 1000}s`));
        child.kill('SIGTERM');
      }
    }, STARTUP_TIMEOUT_MS);

    const interval = setInterval(() => {
      if (connected) {
        clearTimeout(timer);
        clearInterval(interval);
        console.log(`[tunnel] named tunnel "${tunnelName}" connected`);
        resolve(buildHandle(child, publicUrl, []));
      }
    }, 200);

    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(interval);
      if (!connected) reject(new Error(`cloudflared exited before connecting (code=${code})`));
    });
  });

  function cleanup() {
    try { unlinkSync(configPath); } catch { /* already gone */ }
  }
  child.on('exit', cleanup);
}

/**
 * Start a quick tunnel: `cloudflared tunnel --no-autoupdate --url http://localhost:$port`
 * Resolves with the random trycloudflare.com URL parsed from output.
 */
export async function startQuickTunnel(port: number): Promise<TunnelHandle> {
  const child = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', ...cloudflaredProtocolArgs(), '--url', `http://localhost:${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnvForCloudflared() },
  ).on('error', handleSpawnError);

  const urlChangeCallbacks: Array<(_url: string) => void> = [];
  let currentUrl: string | null = null;

  pipeOutput(child, (text) => {
    const match = text.match(URL_REGEX);
    if (match && match[0] !== currentUrl) {
      currentUrl = match[0];
      console.log(`[tunnel] public URL: ${currentUrl}`);
      for (const cb of urlChangeCallbacks) cb(currentUrl);
    }
  });

  child.on('exit', (code, signal) => {
    console.warn(`[tunnel] cloudflared exited (code=${code}, signal=${signal})`);
  });

  return new Promise<TunnelHandle>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cloudflared did not report a public URL within ${STARTUP_TIMEOUT_MS / 1000}s`));
      child.kill('SIGTERM');
    }, STARTUP_TIMEOUT_MS);

    const check = () => {
      if (currentUrl) {
        clearTimeout(timer);
        resolve(buildHandle(child, currentUrl, urlChangeCallbacks));
      }
    };

    const interval = setInterval(() => {
      check();
      if (currentUrl) clearInterval(interval);
    }, 200);

    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(interval);
      if (!currentUrl) reject(new Error(`cloudflared exited before emitting a URL (code=${code})`));
    });
  });
}

function buildHandle(
  child: ChildProcess,
  initialUrl: string,
  urlChangeCallbacks: Array<(_url: string) => void>,
): TunnelHandle {
  return {
    publicUrl: initialUrl,
    close: () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    },
    onUrlChange: (cb) => { urlChangeCallbacks.push(cb); },
  };
}
