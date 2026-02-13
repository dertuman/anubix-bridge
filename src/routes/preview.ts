import { Router } from 'express';

import {
  startDevServer,
  stopDevServer,
  getStatus,
  getLogs,
} from '../preview.js';
import type { PreviewStartRequest } from '../types.js';

const router = Router();

router.post('/start', (req, res) => {
  const { sessionId, command, port } = req.body as PreviewStartRequest;

  if (!sessionId) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }

  try {
    const status = startDevServer({ sessionId, command, port });
    res.json({ data: status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

router.post('/stop', (_req, res) => {
  stopDevServer();
  res.json({ data: getStatus() });
});

router.get('/status', (_req, res) => {
  res.json({ data: getStatus() });
});

router.get('/logs', (req, res) => {
  const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined;
  res.json({ data: getLogs(tail) });
});

export default router;
