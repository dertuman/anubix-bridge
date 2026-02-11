import { Router } from 'express';
import fs from 'fs';

import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
} from '../sessions.js';

const router = Router();

// List all sessions
router.get('/', (_req, res) => {
  const sessions = listSessions();
  res.json({ data: sessions });
});

// Create a new session
router.post('/', (req, res) => {
  const { repoPath, name } = req.body as {
    repoPath?: string;
    name?: string;
  };

  if (!repoPath) {
    res.status(400).json({ error: 'repoPath is required' });
    return;
  }

  // Validate the path exists
  if (!fs.existsSync(repoPath)) {
    res.status(400).json({ error: `Path does not exist: ${repoPath}` });
    return;
  }

  const session = createSession(repoPath, name);
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
