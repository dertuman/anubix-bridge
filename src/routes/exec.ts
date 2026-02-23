import { spawn } from 'child_process';
import { Router } from 'express';

const router = Router();

/**
 * POST /_bridge/exec
 *
 * Executes a shell command on the machine and returns stdout + stderr.
 * Used for debugging — lets the user inspect the machine state from the web UI.
 *
 * Body: { command: string, timeout?: number }
 * Response: { stdout: string, stderr: string, exitCode: number | null }
 */
router.post('/', (req, res) => {
  const { command, timeout = 30000 } = req.body as {
    command?: string;
    timeout?: number;
  };

  if (!command || typeof command !== 'string') {
    res.status(400).json({ error: 'command is required' });
    return;
  }

  const maxTimeout = Math.min(timeout, 60000); // cap at 60s

  const child = spawn('bash', ['-c', command], {
    timeout: maxTimeout,
    env: { ...process.env, TERM: 'dumb' },
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
    // Cap output to prevent memory issues
    if (stdout.length > 100_000) {
      child.kill();
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
    if (stderr.length > 100_000) {
      child.kill();
    }
  });

  child.on('close', (exitCode) => {
    res.json({
      stdout: stdout.slice(0, 100_000),
      stderr: stderr.slice(0, 100_000),
      exitCode,
    });
  });

  child.on('error', (err) => {
    res.status(500).json({
      error: err.message,
      stdout: stdout.slice(0, 100_000),
      stderr: stderr.slice(0, 100_000),
    });
  });
});

export default router;
