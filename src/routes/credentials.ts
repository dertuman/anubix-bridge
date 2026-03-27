import fs from 'fs';
import os from 'os';
import path from 'path';
import { Router } from 'express';

import { closeAllConversations } from '../agent/index.js';

const router = Router();

const home = os.homedir();

/** Resolve the Claude config directory, respecting CLAUDE_CONFIG_DIR env var. */
function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

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

      // Write to CLAUDE_CONFIG_DIR (or ~/.claude if not set)
      const claudeDir = getClaudeConfigDir();
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, '.credentials.json'), claudeAuthJson, { mode: 0o600 });

      // Also write to legacy location for compatibility
      const configDir = path.join(home, '.config', 'claude-code');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'auth.json'), claudeAuthJson, { mode: 0o600 });

      delete process.env.ANTHROPIC_API_KEY;

      console.log(`Claude CLI credentials updated (config dir: ${claudeDir})`);
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
    hasCredentials = fs.existsSync(path.join(getClaudeConfigDir(), '.credentials.json'));
  } else {
    hasCredentials = !!process.env.ANTHROPIC_API_KEY;
  }

  res.json({ mode, hasCredentials });
});

export default router;
