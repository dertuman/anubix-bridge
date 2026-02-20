import fs from 'fs';
import path from 'path';
import { Router } from 'express';

const router = Router();

const WORKSPACE = process.env.REPOS_BASE_PATH || '/workspace';
const PROJECT_DIR = path.join(WORKSPACE, 'project');

/**
 * POST /_bridge/env
 * Receives { vars: Record<string, string>, repoPath?: string }
 * and merges into .env.local in the target directory.
 *
 * If repoPath is provided, writes to <WORKSPACE>/<repoPath>/.env.local
 * Otherwise falls back to <WORKSPACE>/project/.env.local
 */
router.post('/', (req, res) => {
  const { vars, repoPath } = req.body as {
    vars: Record<string, string>;
    repoPath?: string;
  };

  if (!vars || typeof vars !== 'object') {
    res.status(400).json({ error: 'vars must be an object' });
    return;
  }

  // Resolve target directory
  let targetDir: string;
  if (repoPath) {
    const resolved = path.resolve(WORKSPACE, repoPath);
    // Path traversal guard: ensure resolved path stays within WORKSPACE
    if (!resolved.startsWith(WORKSPACE)) {
      res.status(400).json({ error: 'Invalid repo path' });
      return;
    }
    targetDir = resolved;
  } else {
    targetDir = PROJECT_DIR;
  }

  const envFile = path.join(targetDir, '.env.local');

  try {
    // Read existing .env.local if it exists
    const existing: Record<string, string> = {};
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        existing[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    }

    // Merge new vars (overwrite existing keys)
    Object.assign(existing, vars);

    // Write back
    const lines = Object.entries(existing).map(([k, v]) => `${k}=${v}`);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, lines.join('\n') + '\n');

    res.json({ ok: true, count: Object.keys(vars).length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to update .env.local:', msg);
    res.status(500).json({ error: msg });
  }
});

export default router;
