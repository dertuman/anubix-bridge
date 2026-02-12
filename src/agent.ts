import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type WebSocket from 'ws';

import { getSession, updateSession } from './sessions.js';
import type { WsServerPayload } from './types.js';

// Pending approval state per session
const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: { allow: boolean; message?: string }) => void;
  }
>();

// Pending question answers per session
const pendingQuestions = new Map<
  string,
  {
    resolve: (answers: Record<string, string>) => void;
  }
>();

function send(ws: WebSocket, payload: WsServerPayload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Resolve a pending tool approval for a session
 */
export function resolveApproval(
  sessionId: string,
  decision: { allow: boolean; message?: string },
) {
  const pending = pendingApprovals.get(sessionId);
  if (pending) {
    pending.resolve(decision);
    pendingApprovals.delete(sessionId);
  }
}

/**
 * Resolve a pending question for a session
 */
export function resolveQuestion(
  sessionId: string,
  answers: Record<string, string>,
) {
  const pending = pendingQuestions.get(sessionId);
  if (pending) {
    pending.resolve(answers);
    pendingQuestions.delete(sessionId);
  }
}

/**
 * Wait for tool approval from the client
 */
export function waitForApproval(
  sessionId: string,
): Promise<{ allow: boolean; message?: string }> {
  return new Promise((resolve) => {
    pendingApprovals.set(sessionId, { resolve });
  });
}

/**
 * Wait for question answers from the client
 */
export function waitForQuestionAnswer(
  sessionId: string,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    pendingQuestions.set(sessionId, { resolve });
  });
}

/**
 * Run a prompt against a Claude Code session and stream results via WebSocket.
 *
 * Uses @anthropic-ai/claude-agent-sdk query() which returns an AsyncGenerator
 * of SDKMessage events (system, assistant, result, stream_event, user).
 */
export async function runPrompt(
  sessionId: string,
  prompt: string,
  ws: WebSocket,
  images?: Array<{ base64: string; mimeType: string }>,
) {
  const session = getSession(sessionId);
  if (!session) {
    send(ws, { type: 'error', message: 'Session not found' });
    return;
  }

  updateSession(sessionId, { status: 'busy' });

  let fullText = '';

  try {
    // Build prompt — multimodal content blocks when images are provided
    let resolvedPrompt: Parameters<typeof query>[0]['prompt'];
    if (images && images.length > 0) {
      // SDK expects AsyncIterable<SDKUserMessage> for multimodal content
      // Capture session for closure to avoid undefined warning
      const currentSession = session;
      async function* multimodalPrompt(): AsyncIterable<SDKUserMessage> {
        yield {
          type: 'user' as const,
          message: {
            role: 'user' as const,
            content: [
              ...images!.map((img) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: img.base64,
                },
              })),
              { type: 'text' as const, text: prompt },
            ],
          },
          parent_tool_use_id: null,
          session_id: currentSession.conversationId || '',
        };
      }
      resolvedPrompt = multimodalPrompt();
    } else {
      resolvedPrompt = prompt;
    }

    // Build query options per SDK API
    const queryOptions: Parameters<typeof query>[0] = {
      prompt: resolvedPrompt,
      options: {
        cwd: session.repoPath,
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
        ],
      },
    };

    // Resume conversation if we have a previous session ID from the SDK
    if (session.conversationId) {
      queryOptions.options!.resume = session.conversationId;
    }

    const conversation = query(queryOptions);

    for await (const message of conversation) {
      switch (message.type) {
        case 'system': {
          // system.init — capture session_id for resume, relay model info
          if ('session_id' in message) {
            updateSession(sessionId, {
              conversationId: message.session_id,
            });
          }
          send(ws, {
            type: 'session_init',
            sessionId,
            model:
              'model' in message
                ? (message.model as string)
                : undefined,
          });
          break;
        }

        case 'assistant': {
          // Full assistant message — extract text content blocks
          const msg = message.message as {
            content?: Array<{
              type: string;
              text?: string;
              name?: string;
              input?: Record<string, unknown>;
              id?: string;
            }>;
          };
          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                fullText += block.text;
                send(ws, { type: 'text_delta', text: block.text });
              }
              if (block.type === 'tool_use' && block.name) {
                send(ws, {
                  type: 'tool_start',
                  toolName: block.name,
                  toolInput: (block.input as Record<string, unknown>) || {},
                });
              }
            }
          }
          break;
        }

        case 'result': {
          // Final result — relay cost, duration, result text
          const resultMsg = message as {
            subtype?: string;
            result?: string;
            total_cost_usd?: number;
            duration_ms?: number;
            session_id?: string;
            errors?: string[];
          };

          if (
            resultMsg.subtype === 'success' &&
            resultMsg.result
          ) {
            send(ws, {
              type: 'result',
              result: resultMsg.result,
              sessionId,
              cost: resultMsg.total_cost_usd,
              duration: resultMsg.duration_ms
                ? resultMsg.duration_ms / 1000
                : undefined,
            });
          } else if (resultMsg.errors?.length) {
            send(ws, {
              type: 'error',
              message: resultMsg.errors.join('\n'),
            });
          } else {
            send(ws, {
              type: 'result',
              result: resultMsg.result || '',
              sessionId,
              cost: resultMsg.total_cost_usd,
              duration: resultMsg.duration_ms
                ? resultMsg.duration_ms / 1000
                : undefined,
            });
          }
          break;
        }

        default:
          // stream_event, user replay, compact_boundary — ignore for now
          break;
      }
    }
  } catch (err) {
    const errMessage =
      err instanceof Error ? err.message : 'Unknown error';
    send(ws, { type: 'error', message: errMessage });
  } finally {
    updateSession(sessionId, { status: 'idle' });
  }
}
