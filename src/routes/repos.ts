import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { Router } from 'express';

import { getErrorMessage } from '../utils.js';

const router = Router();

const WORKSPACE = process.env.REPOS_BASE_PATH || '/workspace';

router.get('/', async (_req, res) => {
  try {
    try {
      await fs.access(WORKSPACE);
    } catch {
      res.json({ data: [], basePath: WORKSPACE });
      return;
    }

    const entries = await fs.readdir(WORKSPACE, { withFileTypes: true });
    const repos = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(WORKSPACE, e.name),
      }));

    res.json({ data: repos, basePath: WORKSPACE });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

router.post('/', async (req, res) => {
  const { url, name, branch } = req.body as {
    url: string;
    name?: string;
    branch?: string;
  };

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'url is required' });
    return;
  }

  const repoName =
    name?.trim() ||
    url
      .replace(/\.git$/, '')
      .split('/')
      .pop() ||
    'repo';

  const targetDir = path.join(WORKSPACE, repoName);

  try {
    await fs.access(targetDir);
    res.json({
      ok: true,
      alreadyExists: true,
      name: repoName,
      path: targetDir,
    });
    return;
  } catch {
    // Directory doesn't exist, proceed with clone
  }

  try {
    await fs.mkdir(WORKSPACE, { recursive: true });

    const branchArg = branch ? `--branch ${branch}` : '';
    const cmd = `git clone ${branchArg} ${url} ${targetDir}`;
    console.log(`Cloning repo: ${cmd}`);

    execSync(cmd, {
      stdio: 'pipe',
      timeout: 300_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    try {
      await fs.access(path.join(targetDir, 'package.json'));
      console.log(`Installing dependencies for ${repoName}...`);
      execSync('npm install', {
        cwd: targetDir,
        stdio: 'pipe',
        timeout: 300_000,
      });
    } catch {
      // No package.json, skip install
    }

    res.json({
      ok: true,
      alreadyExists: false,
      name: repoName,
      path: targetDir,
    });
  } catch (err) {
    console.error(`Failed to clone ${url}:`, getErrorMessage(err));

    try {
      await fs.rm(targetDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }

    res.status(500).json({ error: `Clone failed: ${getErrorMessage(err)}` });
  }
});

router.delete('/:name', async (req, res) => {
  const repoName = req.params.name;
  const targetDir = path.join(WORKSPACE, repoName);

  if (!targetDir.startsWith(WORKSPACE)) {
    res.status(400).json({ error: 'Invalid repo name' });
    return;
  }

  try {
    await fs.access(targetDir);
  } catch {
    res.status(404).json({ error: 'Repo not found' });
    return;
  }

  try {
    await fs.rm(targetDir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: getErrorMessage(err) });
  }
});

export default router;
