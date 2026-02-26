import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';

import { getErrorMessage } from '../utils.js';

const router = Router();

const WORKSPACE = process.env.REPOS_BASE_PATH || '/workspace';
const PROJECT_DIR = path.join(WORKSPACE, 'project');

router.post('/', async (req, res) => {
  const { vars, repoPath } = req.body as {
    vars: Record<string, string>;
    repoPath?: string;
  };

  if (!vars || typeof vars !== 'object') {
    res.status(400).json({ error: 'vars must be an object' });
    return;
  }

  let targetDir: string;
  if (repoPath) {
    const resolved = path.resolve(WORKSPACE, repoPath);
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
    const existing: Record<string, string> = {};
    try {
      const content = await fs.readFile(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        existing[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
    } catch {
      // File doesn't exist yet, start fresh
    }

    Object.assign(existing, vars);

    const lines = Object.entries(existing).map(([k, v]) => `${k}=${v}`);
    await fs.mkdir(path.dirname(envFile), { recursive: true });
    await fs.writeFile(envFile, lines.join('\n') + '\n');

    res.json({ ok: true, count: Object.keys(vars).length });
  } catch (err) {
    console.error('Failed to update .env.local:', getErrorMessage(err));
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

export default router;
