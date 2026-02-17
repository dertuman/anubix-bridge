import { execFile } from 'child_process';
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { getAllMessages, getMessagesAfter } from '../messageLog.js';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  updateSession,
} from '../sessions.js';

const execFileAsync = promisify(execFile);

const router = Router();

const REPOS_BASE_PATH = process.env.REPOS_BASE_PATH || '';

/** Resolve a repo path — if it's not absolute, try joining with REPOS_BASE_PATH */
function resolveRepoPath(input: string): string {
  if (path.isAbsolute(input)) return input;
  if (REPOS_BASE_PATH) return path.join(REPOS_BASE_PATH, input);
  return input;
}

// List all sessions
router.get('/', (_req, res) => {
  const sessions = listSessions();
  res.json({ data: sessions });
});

// List available repos from REPOS_BASE_PATH
router.get('/repos', (_req, res) => {
  if (!REPOS_BASE_PATH || !fs.existsSync(REPOS_BASE_PATH)) {
    res.json({ data: [], basePath: REPOS_BASE_PATH || null });
    return;
  }
  try {
    const entries = fs.readdirSync(REPOS_BASE_PATH, { withFileTypes: true });
    const repos = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(REPOS_BASE_PATH, e.name) }));
    res.json({ data: repos, basePath: REPOS_BASE_PATH });
  } catch {
    res.json({ data: [], basePath: REPOS_BASE_PATH });
  }
});

// Create a new session
router.post('/', (req, res) => {
  const { repoPath: rawPath, repoPaths: rawRepoPaths, name, mode } = req.body as {
    repoPath?: string;
    repoPaths?: string[];
    name?: string;
    mode?: string;
  };

  // Validate mode if provided
  if (mode && mode !== 'sdk' && mode !== 'cli') {
    res.status(400).json({ error: 'mode must be "sdk" or "cli"' });
    return;
  }

  // Multi-folder workspace: repoPaths takes priority
  if (rawRepoPaths && Array.isArray(rawRepoPaths) && rawRepoPaths.length >= 2) {
    const resolved = rawRepoPaths.map((p) => resolveRepoPath(p));
    const missing = resolved.filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
      res.status(400).json({ error: `Paths do not exist: ${missing.join(', ')}` });
      return;
    }
    const session = createSession(resolved[0], name, mode as 'sdk' | 'cli' | undefined, resolved);
    res.status(201).json({ data: session });
    return;
  }

  // Single-folder session (backward compatible)
  if (!rawPath) {
    res.status(400).json({ error: 'repoPath is required' });
    return;
  }

  const repoPath = resolveRepoPath(rawPath);

  // Validate the path exists
  if (!fs.existsSync(repoPath)) {
    res.status(400).json({ error: `Path does not exist: ${repoPath}` });
    return;
  }

  const session = createSession(repoPath, name, mode as 'sdk' | 'cli' | undefined);
  res.status(201).json({ data: session });
});

// Get a single session
router.get('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ data: session });
});

// Git pull for a session's repo(s)
router.post('/:id/pull', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const paths = session.repoPaths && session.repoPaths.length >= 2
    ? session.repoPaths
    : [session.repoPath];

  const results: Array<{ path: string; output?: string; error?: string }> = [];

  for (const repoPath of paths) {
    try {
      const { stdout, stderr } = await execFileAsync('git', ['pull'], { cwd: repoPath });
      results.push({ path: repoPath, output: (stdout + stderr).trim() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      results.push({ path: repoPath, error: msg });
    }
  }

  res.json({ data: results });
});

// Get messages for a session
// GET /api/sessions/:id/messages           → all messages
// GET /api/sessions/:id/messages?after=SEQ  → messages after given seq (exclusive)
router.get('/:id/messages', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const afterParam = req.query.after as string | undefined;
  const messages = afterParam !== undefined
    ? getMessagesAfter(req.params.id, parseInt(afterParam, 10))
    : getAllMessages(req.params.id);

  res.json({
    data: messages,
    sessionId: req.params.id,
    count: messages.length,
  });
});

// Update a session (name, repoPaths)
router.patch('/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const { name, repoPaths } = req.body as {
    name?: string;
    repoPaths?: string[];
  };

  const updates: Record<string, unknown> = {};

  if (name !== undefined) {
    updates.name = name;
  }

  if (repoPaths !== undefined && Array.isArray(repoPaths) && repoPaths.length > 0) {
    const resolved = repoPaths.map((p) => resolveRepoPath(p));
    if (resolved.length >= 2) {
      updates.repoPaths = resolved;
      updates.repoPath = resolved[0];
    } else {
      updates.repoPath = resolved[0];
      updates.repoPaths = undefined;
    }
  }

  const updated = updateSession(req.params.id, updates);
  res.json({ data: updated });
});

// Delete a session
router.delete('/:id', (req, res) => {
  const deleted = deleteSession(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ message: 'Session deleted' });
});

export default router;
