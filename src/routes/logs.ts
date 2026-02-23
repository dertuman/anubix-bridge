import { Router } from 'express';

const router = Router();

// ── In-memory ring buffer for recent logs ──────────────────────
const MAX_LOG_LINES = 500;
const logBuffer: string[] = [];

/**
 * Capture console.log/warn/error output into a ring buffer.
 * Call this once at startup.
 */
export function installLogCapture() {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  const addLine = (level: string, args: unknown[]) => {
    const ts = new Date().toISOString();
    const text = args.map((a) =>
      typeof a === 'string' ? a : JSON.stringify(a),
    ).join(' ');
    const line = `${ts} [${level}] ${text}`;
    logBuffer.push(line);
    if (logBuffer.length > MAX_LOG_LINES) {
      logBuffer.shift();
    }
  };

  console.log = (...args: unknown[]) => {
    origLog.apply(console, args);
    addLine('LOG', args);
  };

  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args);
    addLine('WARN', args);
  };

  console.error = (...args: unknown[]) => {
    origError.apply(console, args);
    addLine('ERROR', args);
  };
}

/**
 * GET /_bridge/logs
 *
 * Returns the most recent server log lines.
 * Query params:
 *   ?last=N  — return only the last N lines (default 200)
 *   ?filter=TEXT — only return lines containing TEXT
 */
router.get('/', (req, res) => {
  const last = Math.min(parseInt(req.query.last as string) || 200, MAX_LOG_LINES);
  const filter = (req.query.filter as string) || '';

  let lines = logBuffer.slice(-last);
  if (filter) {
    const lower = filter.toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(lower));
  }

  res.json({ lines, total: logBuffer.length });
});

export default router;
