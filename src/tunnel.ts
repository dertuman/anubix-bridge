import { spawn, type ChildProcess } from 'child_process';

/**
 * Spawn `cloudflared tunnel --url http://localhost:$port` and resolve with the
 * public trycloudflare.com URL parsed from stderr. Keeps the process alive;
 * call .close() on shutdown.
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
const STARTUP_TIMEOUT_MS = 30_000;

export async function startQuickTunnel(port: number): Promise<TunnelHandle> {
  const child = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ).on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(
        '\n[tunnel] cloudflared not found on PATH.\n' +
        '        Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
        '        Or set TUNNEL_MODE=none if you\'re providing your own PUBLIC_URL.\n',
      );
    } else {
      console.error('[tunnel] cloudflared spawn error:', err);
    }
  });

  const urlChangeCallbacks: Array<(_url: string) => void> = [];
  let currentUrl: string | null = null;

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    // Stream cloudflared's own output so edge-connection failures, firewall
    // blocks, and other issues are visible. Each line prefixed so it's easy
    // to spot in the bridge log.
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) console.log(`[cloudflared] ${line}`);
    }
    const match = text.match(URL_REGEX);
    if (match && match[0] !== currentUrl) {
      currentUrl = match[0];
      console.log(`[tunnel] public URL: ${currentUrl}`);
      for (const cb of urlChangeCallbacks) cb(currentUrl);
    }
  };

  child.stdout?.on('data', handleChunk);
  child.stderr?.on('data', handleChunk);

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
