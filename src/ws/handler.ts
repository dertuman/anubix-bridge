import type WebSocket from 'ws';

import { abortPrompt, getCommands, getLastApprovalPayload, getLastQuestionPayload, hasPendingApproval, hasPendingQuestion, registerSocket, resolveApproval, resolveQuestion, runPrompt, unregisterSocket } from '../agent.js';
import { BRIDGE_COMMANDS } from '../commands.js';
import { appendMessage, clearSessionLog, getMessagesAfter } from '../messageLog.js';
import { startDevServer, stopDevServer, getStatus, getLogs } from '../preview.js';
import { getSession, updateSession } from '../sessions.js';
import type { WsClientPayload, WsServerPayload } from '../types.js';

function send(ws: WebSocket, payload: WsServerPayload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function handleWebSocket(ws: WebSocket, sessionId: string, lastSeq?: number) {
  const session = getSession(sessionId);

  if (!session) {
    send(ws, { type: 'error', message: 'Session not found' });
    ws.close(4004, 'Session not found');
    return;
  }

  // Register this socket so runPrompt always uses the latest connection
  registerSocket(sessionId, ws);

  // Mark socket alive for heartbeat detection
  (ws as any).isAlive = true;
  ws.on('pong', () => { (ws as any).isAlive = true; });

  // 1. Send session init (direct, not buffered)
  send(ws, {
    type: 'session_init',
    sessionId: session.id,
  });

  // 2. Send session status with pending flags (direct)
  const pendingApproval = hasPendingApproval(sessionId);
  const pendingQuestion = hasPendingQuestion(sessionId);
  send(ws, {
    type: 'session_status',
    sessionId: session.id,
    status: session.status,
    hasPendingApproval: pendingApproval,
    hasPendingQuestion: pendingQuestion,
  });

  // 2b. Re-send stored approval/question payloads so the frontend can show them
  if (pendingApproval) {
    const approvalPayload = getLastApprovalPayload(sessionId);
    if (approvalPayload) {
      send(ws, approvalPayload);
    }
  }
  if (pendingQuestion) {
    const questionPayload = getLastQuestionPayload(sessionId);
    if (questionPayload) {
      send(ws, questionPayload);
    }
  }

  // 3. Replay missed messages if lastSeq provided
  if (lastSeq !== undefined && lastSeq >= 0) {
    const missed = getMessagesAfter(sessionId, lastSeq);
    if (missed.length > 0) {
      const fromSeq = missed[0].seq;
      const toSeq = missed[missed.length - 1].seq;
      send(ws, { type: 'replay_start', fromSeq, toSeq });
      for (const msg of missed) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ ...msg.payload, seq: msg.seq }));
        }
      }
      send(ws, { type: 'replay_end' });
    }
  }

  // 4. Send commands — merge Claude SDK commands with bridge-level commands
  const commands = [...BRIDGE_COMMANDS, ...getCommands(sessionId)];
  send(ws, { type: 'commands_available', commands });

  ws.on('message', async (raw) => {
    let payload: WsClientPayload;

    try {
      payload = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (payload.type) {
      case 'message': {
        if (!payload.content?.trim()) {
          send(ws, { type: 'error', message: 'Empty message' });
          return;
        }

        // Log the user message into the message log so both apps see it
        const userPayload: WsServerPayload = {
          type: 'user_message',
          content: payload.content.trim(),
          images: payload.images,
          timestamp: Date.now(),
        };
        const userSeq = appendMessage(sessionId, userPayload);

        // Update lastActiveAt on the session
        updateSession(sessionId, { lastActiveAt: Date.now() });

        // Broadcast user message seq back so the sending client can track it
        send(ws, { ...userPayload, seq: userSeq } as any);

        // Intercept /clear command
        if (payload.content.trim() === '/clear') {
          clearSessionLog(sessionId);
          updateSession(sessionId, { conversationId: undefined, status: 'idle' });
          send(ws, { type: 'session_cleared', sessionId });
          console.log(`Session ${sessionId} cleared`);
          return;
        }

        // Intercept /preview commands at the bridge level
        const previewResult = handlePreviewCommand(payload.content.trim(), sessionId);
        if (previewResult) {
          send(ws, {
            type: 'result',
            result: previewResult,
            sessionId,
          });
          return;
        }

        // Check if session is already busy
        const current = getSession(sessionId);
        if (current?.status === 'busy') {
          send(ws, {
            type: 'error',
            message: 'Session is busy processing a previous request',
          });
          return;
        }

        // Run the prompt (streams responses back via WebSocket)
        await runPrompt(sessionId, payload.content, ws, payload.images);
        break;
      }

      case 'approval': {
        resolveApproval(sessionId, {
          allow: payload.decision === 'allow',
          message: payload.message,
        });
        break;
      }

      case 'question_answer': {
        resolveQuestion(sessionId, payload.answers);
        break;
      }

      case 'abort': {
        abortPrompt(sessionId, ws);
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong', timestamp: Date.now() });
        break;
      }

      default: {
        send(ws, {
          type: 'error',
          message: `Unknown message type: ${(payload as { type: string }).type}`,
        });
      }
    }
  });

  ws.on('close', () => {
    unregisterSocket(sessionId, ws);
    console.log(`WebSocket closed for session ${sessionId}`);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for session ${sessionId}:`, err.message);
  });
}

/**
 * Intercepts /preview commands and returns a response string,
 * or null if the message is not a preview command.
 *
 * Usage:
 *   /preview start [port] [command]
 *   /preview stop
 *   /preview status
 *   /preview logs [tail]
 */
function handlePreviewCommand(content: string, sessionId: string): string | null {
  if (!content.startsWith('/preview')) return null;

  const parts = content.split(/\s+/);
  const sub = parts[1] || 'status';

  try {
    switch (sub) {
      case 'start': {
        const port = parts[2] ? parseInt(parts[2], 10) : undefined;
        const command = parts.slice(3).join(' ') || undefined;
        const status = startDevServer({ sessionId, port, command });
        return `Preview started\nCommand: ${status.command}\nPort: ${status.port}\nStatus: ${status.status}`;
      }

      case 'stop': {
        stopDevServer();
        return 'Preview stopped.';
      }

      case 'status': {
        const s = getStatus();
        if (!s.active) return 'No preview active.';
        return `Preview: ${s.status}\nCommand: ${s.command}\nPort: ${s.port}\nPID: ${s.pid}`;
      }

      case 'logs': {
        const tail = parts[2] ? parseInt(parts[2], 10) : 30;
        const lines = getLogs(tail);
        if (lines.length === 0) return 'No logs yet.';
        return lines.join('\n');
      }

      default:
        return 'Usage: /preview start [port] [command] | /preview stop | /preview status | /preview logs [n]';
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return `Preview error: ${message}`;
  }
}
