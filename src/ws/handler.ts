import type WebSocket from 'ws';

import { abortPrompt, getCommands, resolveApproval, resolveQuestion, runPrompt } from '../agent.js';
import { getSession } from '../sessions.js';
import type { WsClientPayload, WsServerPayload } from '../types.js';

function send(ws: WebSocket, payload: WsServerPayload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function handleWebSocket(ws: WebSocket, sessionId: string) {
  const session = getSession(sessionId);

  if (!session) {
    send(ws, { type: 'error', message: 'Session not found' });
    ws.close(4004, 'Session not found');
    return;
  }

  // Send session init
  send(ws, {
    type: 'session_init',
    sessionId: session.id,
  });

  // Send cached commands if available
  const commands = getCommands(sessionId);
  if (commands.length > 0) {
    send(ws, { type: 'commands_available', commands });
  }

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

      default: {
        send(ws, {
          type: 'error',
          message: `Unknown message type: ${(payload as { type: string }).type}`,
        });
      }
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket closed for session ${sessionId}`);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for session ${sessionId}:`, err.message);
  });
}
