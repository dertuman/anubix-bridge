import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

import type { SessionState } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', 'data');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
const FLUSH_DEBOUNCE_MS = 500;

// Hot cache
const sessions = new Map<string, SessionState>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;

// --- Disk I/O ---

function loadFromDisk() {
  try {
    if (existsSync(SESSIONS_FILE)) {
      const raw = readFileSync(SESSIONS_FILE, 'utf-8');
      const arr: SessionState[] = JSON.parse(raw);
      for (const s of arr) {
        // conversationId is ephemeral — strip it on load
        delete s.conversationId;
        // Can't be busy after restart
        if (s.status === 'busy') s.status = 'idle';
        sessions.set(s.id, s);
      }
      console.log(`Loaded ${sessions.size} session(s) from disk`);
    }
  } catch (err) {
    console.error('Failed to load sessions from disk:', err);
  }
}

function flushToDisk() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
      }
      const arr = Array.from(sessions.values()).map((s) => {
        // Exclude conversationId from persistence
        const { conversationId: _, ...rest } = s;
        return rest;
      });
      writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to persist sessions:', err);
    }
  }, FLUSH_DEBOUNCE_MS);
}

// Load on module init
loadFromDisk();

// --- Public API ---

export function createSession(repoPath: string, name?: string): SessionState {
  const id = uuidv4();
  const session: SessionState = {
    id,
    name: name || repoPath.split(/[\\/]/).pop() || 'Untitled',
    repoPath,
    status: 'idle',
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  flushToDisk();
  return session;
}

export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

export function updateSession(
  id: string,
  updates: Partial<SessionState>,
): SessionState | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  const updated = { ...session, ...updates };
  sessions.set(id, updated);
  flushToDisk();
  return updated;
}

export function deleteSession(id: string): boolean {
  const deleted = sessions.delete(id);
  if (deleted) flushToDisk();
  return deleted;
}
