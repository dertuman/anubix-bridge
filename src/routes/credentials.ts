import fs from 'fs';
import { Router } from 'express';

import { closeAllConversations } from '../agent.js';

const router = Router();

/**
 * POST /_bridge/credentials
 *
 * Updates Claude Code credentials at runtime — properly handling both
 * CLI mode (writes to credential files on disk) and SDK mode (sets
 * ANTHROPIC_API_KEY in process.env).
 *
 * After updating, all live conversations are closed so the next message
 * spawns a fresh subprocess with the new credentials.
 *
 * Body: {
 *   claudeMode: 'cli' | 'sdk';
 *   claudeAuthJson?: string;     // for cli mode — written to ~/.claude/.credentials.json
 *   anthropicApiKey?: string;    // for sdk mode — set in process.env
 * }
 */
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
    // Update process.env so future conversations pick up the new mode
    process.env.CLAUDE_MODE = claudeMode;

    if (claudeMode === 'cli') {
      if (!claudeAuthJson) {
        res.status(400).json({ error: 'claudeAuthJson is required for CLI mode' });
        return;
      }

      // Write credentials to both locations (modern + legacy)
      // This matches what init-workspace.sh does at boot time
      fs.mkdirSync('/root/.claude', { recursive: true });
      fs.writeFileSync('/root/.claude/.credentials.json', claudeAuthJson, { mode: 0o600 });

      fs.mkdirSync('/root/.config/claude-code', { recursive: true });
      fs.writeFileSync('/root/.config/claude-code/auth.json', claudeAuthJson, { mode: 0o600 });

      // Remove API key so CLI mode uses credential files instead
      delete process.env.ANTHROPIC_API_KEY;

      console.log('✅ Claude CLI credentials updated on disk');
    } else {
      // SDK mode — set API key in process.env
      if (!anthropicApiKey) {
        res.status(400).json({ error: 'anthropicApiKey is required for SDK mode' });
        return;
      }

      process.env.ANTHROPIC_API_KEY = anthropicApiKey;
      console.log('✅ Anthropic API key updated in process.env');
    }

    // Close all live conversations so next message uses new credentials
    const closed = closeAllConversations();
    if (closed > 0) {
      console.log(`♻️ Closed ${closed} live conversation(s) for credential refresh`);
    }

    res.json({ ok: true, mode: claudeMode, conversationsClosed: closed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to update credentials:', msg);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /_bridge/credentials/status
 *
 * Returns the current Claude mode and whether credentials are present.
 */
router.get('/status', (_req, res) => {
  const mode = (process.env.CLAUDE_MODE as 'cli' | 'sdk') || 'sdk';
  let hasCredentials = false;

  if (mode === 'cli') {
    hasCredentials = fs.existsSync('/root/.claude/.credentials.json');
  } else {
    hasCredentials = !!process.env.ANTHROPIC_API_KEY;
  }

  res.json({ mode, hasCredentials });
});

export default router;
