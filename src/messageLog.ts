import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { WsServerPayload } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MESSAGES_DIR = join(__dirname, '..', 'data', 'messages');
const FLUSH_DEBOUNCE_MS = 500;

export interface SequencedMessage {
  seq: number;
  payload: WsServerPayload;
}

interface SessionLog {
  nextSeq: number;
  messages: SequencedMessage[];
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const logs = new Map<string, SessionLog>();

// --- Disk I/O ---

function filePath(sessionId: string): string {
  return join(MESSAGES_DIR, `${sessionId}.json`);
}

function ensureDir() {
  if (!existsSync(MESSAGES_DIR)) {
    mkdirSync(MESSAGES_DIR, { recursive: true });
  }
}

function flushToDisk(sessionId: string) {
  const log = logs.get(sessionId);
  if (!log) return;

  if (log.flushTimer) clearTimeout(log.flushTimer);
  log.flushTimer = setTimeout(() => {
    log.flushTimer = null;
    try {
      ensureDir();
      const data = { nextSeq: log.nextSeq, messages: log.messages };
      writeFileSync(filePath(sessionId), JSON.stringify(data), 'utf-8');
    } catch (err) {
      console.error(`Failed to persist message log for ${sessionId}:`, err);
    }
  }, FLUSH_DEBOUNCE_MS);
}

function loadFromDisk() {
  try {
    if (!existsSync(MESSAGES_DIR)) return;
    const files = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const sessionId = file.replace('.json', '');
      try {
        const raw = readFileSync(join(MESSAGES_DIR, file), 'utf-8');
        const data = JSON.parse(raw) as { nextSeq: number; messages: SequencedMessage[] };
        logs.set(sessionId, {
          nextSeq: data.nextSeq,
          messages: data.messages,
          flushTimer: null,
        });
      } catch (err) {
        console.error(`Failed to load message log ${file}:`, err);
      }
    }
    if (files.length > 0) {
      console.log(`Loaded message logs for ${files.length} session(s)`);
    }
  } catch (err) {
    console.error('Failed to scan message log directory:', err);
  }
}

// Load on module init
loadFromDisk();

// --- Public API ---

function getOrCreateLog(sessionId: string): SessionLog {
  let log = logs.get(sessionId);
  if (!log) {
    log = { nextSeq: 0, messages: [], flushTimer: null };
    logs.set(sessionId, log);
  }
  return log;
}

/**
 * Append a message to the session's log and return its sequence number.
 */
export function appendMessage(sessionId: string, payload: WsServerPayload): number {
  const log = getOrCreateLog(sessionId);
  const seq = log.nextSeq++;
  log.messages.push({ seq, payload });
  flushToDisk(sessionId);
  return seq;
}

/**
 * Get all messages for a session.
 */
export function getAllMessages(sessionId: string): SequencedMessage[] {
  const log = logs.get(sessionId);
  if (!log) return [];
  return log.messages;
}

/**
 * Get all messages after the given sequence number (exclusive).
 */
export function getMessagesAfter(sessionId: string, seq: number): SequencedMessage[] {
  const log = logs.get(sessionId);
  if (!log) return [];
  return log.messages.filter((m) => m.seq > seq);
}

/**
 * Clear the message log for a session (memory + disk).
 */
export function clearSessionLog(sessionId: string): void {
  const log = logs.get(sessionId);
  if (log?.flushTimer) clearTimeout(log.flushTimer);
  logs.delete(sessionId);

  try {
    const fp = filePath(sessionId);
    if (existsSync(fp)) {
      unlinkSync(fp);
    }
  } catch (err) {
    console.error(`Failed to delete message log for ${sessionId}:`, err);
  }
}
