import type WebSocket from 'ws';

import { abortPrompt, closeConversation, getCachedModels, getCommands, getLastApprovalPayload, getLastQuestionPayload, hasPendingApproval, hasPendingQuestion, registerSocket, resolveApproval, resolveQuestion, runPrompt, switchModel, unregisterSocket } from '../agent.js';
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
          closeConversation(sessionId); // Kill persistent subprocess
          clearSessionLog(sessionId);
          updateSession(sessionId, { conversationId: undefined, status: 'idle' });
          send(ws, { type: 'session_cleared', sessionId });
          console.log(`Session ${sessionId} cleared`);
          return;
        }

        // Intercept /model command
        const modelResult = handleModelCommand(payload.content.trim(), sessionId);
        if (modelResult) {
          send(ws, {
            type: 'result',
            result: modelResult,
            sessionId,
          });
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

      case 'switch_model': {
        try {
          updateSession(sessionId, { model: payload.model });
          await switchModel(sessionId, payload.model);

          const models = getCachedModels();
          const info = models?.find(m => m.value === payload.model);
          send(ws, {
            type: 'result',
            result: `Model switched to: ${info?.displayName || payload.model || 'default'}`,
            sessionId,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Failed to switch model';
          send(ws, { type: 'error', message: errorMsg });
        }
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
 * Intercepts /model commands and returns a response string,
 * or null if the message is not a model command.
 *
 * Models are fetched dynamically from the SDK — no hardcoded list.
 */
function handleModelCommand(content: string, sessionId: string): string | null {
  if (content !== '/model' && !content.startsWith('/model ')) return null;

  const models = getCachedModels();
  if (!models) {
    return 'Models not loaded yet. Send a message first, then try /model again.';
  }

  const modelArg = content.slice('/model'.length).trim().toLowerCase() || undefined;

  // No argument → show menu
  if (!modelArg) {
    const session = getSession(sessionId);
    const currentModel = session?.model;

    let list = 'Available Models:\n\n';
    models.forEach((m, i) => {
      const marker = m.value === currentModel ? '→' : ' ';
      list += `${marker} ${i + 1}. ${m.displayName} — ${m.description}\n`;
    });
    list += `\nUsage: /model [number] or /model [name]`;
    return list;
  }

  // Match by: 1-based index, substring of displayName/value, or exact value
  const match = models.find((_, i) => modelArg === String(i + 1))
             || models.find(m => m.displayName.toLowerCase().includes(modelArg))
             || models.find(m => m.value.toLowerCase().includes(modelArg));

  if (!match) {
    return 'Unknown model. Use /model to see available options.';
  }

  updateSession(sessionId, { model: match.value });
  switchModel(sessionId, match.value).catch((err) => {
    console.error(`Failed to switch live model:`, err);
  });

  return `Model switched to: ${match.displayName}`;
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
  if (content !== '/preview' && !content.startsWith('/preview ')) return null;

  const args = content.slice('/preview'.length).trim();
  const parts = args ? args.split(/\s+/) : [];
  const sub = parts[0] || 'status';

  try {
    switch (sub) {
      case 'start': {
        const port = parts[1] ? parseInt(parts[1], 10) : undefined;
        const command = parts.slice(2).join(' ') || undefined;
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
        const tail = parts[1] ? parseInt(parts[1], 10) : 30;
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
