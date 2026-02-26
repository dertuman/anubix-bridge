import fs from 'fs';
import os from 'os';
import path from 'path';
import { Router } from 'express';

import { closeAllConversations } from '../agent/index.js';

const router = Router();

const home = os.homedir();

router.post('/', (req, res) => {
  const { claudeMode, claudeAuthJson, anthropicApiKey } = req.body as {
    claudeMode?: 'cli' | 'sdk';
    claudeAuthJson?: string;
    anthropicApiKey?: string;
  };

  if (!claudeMode || (claudeMode !== 'cli' && claudeMode !== 'sdk')) {
    res.status(400).json({ error: 'claudeMode must be "cli" or "sdk"' });
    return;
  }

  try {
    process.env.CLAUDE_MODE = claudeMode;

    if (claudeMode === 'cli') {
      if (!claudeAuthJson) {
        res.status(400).json({ error: 'claudeAuthJson is required for CLI mode' });
        return;
      }

      const claudeDir = path.join(home, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, '.credentials.json'), claudeAuthJson, { mode: 0o600 });

      const configDir = path.join(home, '.config', 'claude-code');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'auth.json'), claudeAuthJson, { mode: 0o600 });

      delete process.env.ANTHROPIC_API_KEY;

      console.log('Claude CLI credentials updated on disk');
    } else {
      if (!anthropicApiKey) {
        res.status(400).json({ error: 'anthropicApiKey is required for SDK mode' });
        return;
      }

      process.env.ANTHROPIC_API_KEY = anthropicApiKey;
      console.log('Anthropic API key updated in process.env');
    }

    const closed = closeAllConversations();
    if (closed > 0) {
      console.log(`Closed ${closed} live conversation(s) for credential refresh`);
    }

    res.json({ ok: true, mode: claudeMode, conversationsClosed: closed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to update credentials:', msg);
    res.status(500).json({ error: msg });
  }
});

router.get('/status', (_req, res) => {
  const mode = (process.env.CLAUDE_MODE as 'cli' | 'sdk') || 'sdk';
  let hasCredentials = false;

  if (mode === 'cli') {
    hasCredentials = fs.existsSync(path.join(home, '.claude', '.credentials.json'));
  } else {
    hasCredentials = !!process.env.ANTHROPIC_API_KEY;
  }

  res.json({ mode, hasCredentials });
});

export default router;
