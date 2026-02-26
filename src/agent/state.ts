import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type WebSocket from 'ws';

import type { ClaudeMode, WsApprovalRequest, WsAskQuestion, WsServerPayload } from '../types.js';
import { appendMessage } from '../messageLog.js';
import { shortId } from '../utils.js';
import { MessageQueue } from './queue.js';

export interface LiveConversation {
  conversation: Query;
  queue: MessageQueue;
  mode: ClaudeMode;
}

export interface SessionContext {
  pendingApproval?: { resolve: (decision: { allow: boolean; message?: string }) => void };
  pendingQuestion?: { resolve: (answers: Record<string, string>) => void };
  lastApprovalPayload?: WsApprovalRequest;
  lastQuestionPayload?: WsAskQuestion;
  activeQuery?: Query;
  aborted?: boolean;
  commands?: Array<{ name: string; description: string; argHint?: string }>;
  socket?: WebSocket;
  liveConversation?: LiveConversation;
}

const sessions = new Map<string, SessionContext>();

export function ctx(sessionId: string): SessionContext {
  let c = sessions.get(sessionId);
  if (!c) {
    c = {};
    sessions.set(sessionId, c);
  }
  return c;
}

let cachedModels: Array<{ value: string; displayName: string; description: string }> | null = null;

export function getCachedModels() { return cachedModels; }

export function setCachedModels(models: Array<{ value: string; displayName: string; description: string }>) {
  cachedModels = models;
}

export function registerSocket(sessionId: string, ws: WebSocket) {
  const c = ctx(sessionId);
  if (c.socket && c.socket !== ws) {
    console.log(`[${shortId(sessionId)}] Replacing socket reference (old socket left to close naturally)`);
  }
  c.socket = ws;
}

export function unregisterSocket(sessionId: string, ws: WebSocket) {
  const c = ctx(sessionId);
  if (c.socket === ws) {
    c.socket = undefined;
  }
}

export function sendToSession(sessionId: string, payload: WsServerPayload) {
  const seq = appendMessage(sessionId, payload);
  const tag = shortId(sessionId);
  const c = sessions.get(sessionId);
  const ws = c?.socket;
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ ...payload, seq }));
    console.log(`[${tag}] seq=${seq} type=${payload.type} -> sent`);
  } else {
    console.log(`[${tag}] seq=${seq} type=${payload.type} -> buffered (no socket)`);
  }
}

export function send(ws: WebSocket, payload: WsServerPayload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function hasPendingApproval(sessionId: string): boolean {
  return !!sessions.get(sessionId)?.pendingApproval;
}

export function hasPendingQuestion(sessionId: string): boolean {
  return !!sessions.get(sessionId)?.pendingQuestion;
}

export function getLastApprovalPayload(sessionId: string): WsApprovalRequest | undefined {
  return sessions.get(sessionId)?.lastApprovalPayload;
}

export function getLastQuestionPayload(sessionId: string): WsAskQuestion | undefined {
  return sessions.get(sessionId)?.lastQuestionPayload;
}

export function storeApprovalPayload(sessionId: string, payload: WsApprovalRequest) {
  ctx(sessionId).lastApprovalPayload = payload;
}

export function storeQuestionPayload(sessionId: string, payload: WsAskQuestion) {
  ctx(sessionId).lastQuestionPayload = payload;
}

export function resolveApproval(
  sessionId: string,
  decision: { allow: boolean; message?: string },
) {
  const c = sessions.get(sessionId);
  if (c?.pendingApproval) {
    c.pendingApproval.resolve(decision);
    c.pendingApproval = undefined;
    c.lastApprovalPayload = undefined;
  }
}

export function resolveQuestion(
  sessionId: string,
  answers: Record<string, string>,
) {
  const c = sessions.get(sessionId);
  if (c?.pendingQuestion) {
    c.pendingQuestion.resolve(answers);
    c.pendingQuestion = undefined;
    c.lastQuestionPayload = undefined;
  }
}

export function waitForApproval(
  sessionId: string,
): Promise<{ allow: boolean; message?: string }> {
  return new Promise((resolve) => {
    ctx(sessionId).pendingApproval = { resolve };
  });
}

export function waitForQuestionAnswer(
  sessionId: string,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    ctx(sessionId).pendingQuestion = { resolve };
  });
}

export function getCommands(
  sessionId: string,
): Array<{ name: string; description: string; argHint?: string }> {
  return sessions.get(sessionId)?.commands || [];
}

export async function fetchCommands(
  sessionId: string,
): Promise<Array<{ name: string; description: string; argHint?: string }>> {
  const cached = sessions.get(sessionId)?.commands;
  if (cached) return cached;
  return [];
}

export function getAllContexts(): Map<string, SessionContext> {
  return sessions;
}
