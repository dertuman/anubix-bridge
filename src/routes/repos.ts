import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Router } from 'express';

const router = Router();

const WORKSPACE = process.env.REPOS_BASE_PATH || '/workspace';

/**
 * GET /_bridge/repos
 * Lists all repo directories in the workspace.
 */
router.get('/', (_req, res) => {
  try {
    if (!fs.existsSync(WORKSPACE)) {
      res.json({ data: [], basePath: WORKSPACE });
      return;
    }

    const entries = fs.readdirSync(WORKSPACE, { withFileTypes: true });
    const repos = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(WORKSPACE, e.name),
      }));

    res.json({ data: repos, basePath: WORKSPACE });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /_bridge/repos
 * Clones a git repo into the workspace.
 * Body: { url: string, name?: string, branch?: string }
 */
router.post('/', (req, res) => {
  const { url, name, branch } = req.body as {
    url: string;
    name?: string;
    branch?: string;
  };

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  // Derive repo name from URL if not provided
  const repoName =
    name?.trim() ||
    url
      .replace(/\.git$/, '')
      .split('/')
      .pop() ||
    'repo';

  const targetDir = path.join(WORKSPACE, repoName);

  // Check if already exists
  if (fs.existsSync(targetDir)) {
    res.json({
      ok: true,
      alreadyExists: true,
      name: repoName,
      path: targetDir,
    });
    return;
  }

  try {
    fs.mkdirSync(WORKSPACE, { recursive: true });

    const branchArg = branch ? `--branch ${branch}` : '';
    const cmd = `git clone ${branchArg} ${url} ${targetDir}`;
    console.log(`Cloning repo: ${cmd}`);

    execSync(cmd, {
      stdio: 'pipe',
      timeout: 300_000, // 5 min timeout for large repos
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    // Install deps if package.json exists
    if (fs.existsSync(path.join(targetDir, 'package.json'))) {
      console.log(`Installing dependencies for ${repoName}...`);
      execSync('npm install', {
        cwd: targetDir,
        stdio: 'pipe',
        timeout: 300_000,
      });
    }

    res.json({
      ok: true,
      alreadyExists: false,
      name: repoName,
      path: targetDir,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to clone ${url}:`, msg);

    // Clean up partial clone
    try {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }

    res.status(500).json({ error: `Clone failed: ${msg}` });
  }
});

/**
 * DELETE /_bridge/repos/:name
 * Removes a repo directory from the workspace.
 */
router.delete('/:name', (req, res) => {
  const repoName = req.params.name;
  const targetDir = path.join(WORKSPACE, repoName);

  // Safety: ensure it's under workspace
  if (!targetDir.startsWith(WORKSPACE)) {
    res.status(400).json({ error: 'Invalid repo name' });
    return;
  }

  if (!fs.existsSync(targetDir)) {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }

  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
