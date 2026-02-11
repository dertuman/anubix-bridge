import { v4 as uuidv4 } from 'uuid';

import type { SessionState } from './types.js';

const sessions = new Map<string, SessionState>();

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
  return updated;
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}
