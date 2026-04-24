/**
 * Registers this bridge with anubix-web by POSTing its current public URL.
 * Authenticates with the install token from env (ANUBIX_INSTALL_TOKEN).
 *
 * Runs once on boot, then heartbeats so the UI can tell the laptop is online.
 */

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface RegistrationHandle {
  updateUrl: (_url: string) => void;
  stop: () => void;
}

export function startRegistration(opts: {
  webUrl: string;
  installToken: string;
  initialPublicUrl: string;
}): RegistrationHandle {
  const endpoint = opts.webUrl.replace(/\/+$/, '') + '/api/bridge-register';
  let publicUrl = opts.initialPublicUrl;
  let stopped = false;
  let firstOkLogged = false;

  const doPost = async () => {
    if (stopped) return;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-install-token': opts.installToken,
        },
        body: JSON.stringify({ publicUrl }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`[register] ${res.status} ${res.statusText} ${body}`);
        return;
      }
      if (!firstOkLogged) {
        firstOkLogged = true;
        console.log(`[register] OK — anubix-web now knows about ${publicUrl}. Heartbeating every ${HEARTBEAT_INTERVAL_MS / 1000}s.`);
      }
    } catch (err) {
      console.warn('[register] POST failed:', err instanceof Error ? err.message : err);
    }
  };

  console.log(`[register] reporting ${publicUrl} to ${endpoint}`);
  void doPost();

  const interval = setInterval(doPost, HEARTBEAT_INTERVAL_MS);

  return {
    updateUrl: (url) => {
      if (url === publicUrl) return;
      publicUrl = url;
      console.log(`[register] public URL changed to ${url}, re-registering`);
      void doPost();
    },
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}
