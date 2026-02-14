import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type WebSocket from 'ws';

import { BRIDGE_COMMANDS } from './commands.js';
import { appendMessage } from './messageLog.js';
import { getSession, updateSession } from './sessions.js';
import type { ClaudeMode, SessionState, WsApprovalRequest, WsAskQuestion, WsServerPayload } from './types.js';

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

// Last approval/question payloads per session — for re-sending on reconnect
const lastApprovalPayloads = new Map<string, WsApprovalRequest>();
const lastQuestionPayloads = new Map<string, WsAskQuestion>();

// Active query instances per session (for abort support)
const activeQueries = new Map<string, ReturnType<typeof query>>();

// Sessions that were aborted — so the catch block in runPrompt can suppress the expected error
const abortedSessions = new Set<string>();

// Cached slash commands per session
const sessionCommands = new Map<
  string,
  Array<{ name: string; description: string; argHint?: string }>
>();

// Active WebSocket per session — allows reconnects to pick up a running prompt
const sessionSockets = new Map<string, WebSocket>();

export function registerSocket(sessionId: string, ws: WebSocket) {
  const existing = sessionSockets.get(sessionId);
  if (existing && existing !== ws) {
    // Don't explicitly close — the old socket will be cleaned up by heartbeat
    // or by the frontend closing it. Sending close(4001) here would cause a
    // reconnection loop if the frontend doesn't yet handle that code.
    console.log(`[${sessionId.slice(0, 8)}] Replacing socket reference (old socket left to close naturally)`);
  }
  sessionSockets.set(sessionId, ws);
}

export function unregisterSocket(sessionId: string, ws: WebSocket) {
  // Only remove if it's still the same socket (avoid race with a new connection)
  if (sessionSockets.get(sessionId) === ws) {
    sessionSockets.delete(sessionId);
  }
}

function sendToSession(sessionId: string, payload: WsServerPayload) {
  const seq = appendMessage(sessionId, payload);
  const short = sessionId.slice(0, 8);
  const ws = sessionSockets.get(sessionId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ ...payload, seq }));
    console.log(`[${short}] seq=${seq} type=${payload.type} → sent`);
  } else {
    console.log(`[${short}] seq=${seq} type=${payload.type} → buffered (no socket)`);
  }
}

function send(ws: WebSocket, payload: WsServerPayload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Check if a session has a pending tool approval.
 */
export function hasPendingApproval(sessionId: string): boolean {
  return pendingApprovals.has(sessionId);
}

/**
 * Check if a session has a pending question.
 */
export function hasPendingQuestion(sessionId: string): boolean {
  return pendingQuestions.has(sessionId);
}

/**
 * Get the stored approval payload for re-sending on reconnect.
 */
export function getLastApprovalPayload(sessionId: string): WsApprovalRequest | undefined {
  return lastApprovalPayloads.get(sessionId);
}

/**
 * Get the stored question payload for re-sending on reconnect.
 */
export function getLastQuestionPayload(sessionId: string): WsAskQuestion | undefined {
  return lastQuestionPayloads.get(sessionId);
}

/**
 * Store an approval payload for re-sending on reconnect.
 */
export function storeApprovalPayload(sessionId: string, payload: WsApprovalRequest) {
  lastApprovalPayloads.set(sessionId, payload);
}

/**
 * Store a question payload for re-sending on reconnect.
 */
export function storeQuestionPayload(sessionId: string, payload: WsAskQuestion) {
  lastQuestionPayloads.set(sessionId, payload);
}

// --- Claude mode helpers ---

function resolveMode(session: SessionState): ClaudeMode {
  return session.mode || (process.env.CLAUDE_MODE as ClaudeMode) || 'sdk';
}

function buildEnvForMode(mode: ClaudeMode): Record<string, string | undefined> {
  if (mode === 'cli') {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    return env;
  }
  return { ...process.env };
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
    lastApprovalPayloads.delete(sessionId);
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
    lastQuestionPayloads.delete(sessionId);
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
 * Abort a running prompt for a session
 */
export function abortPrompt(sessionId: string, _ws?: WebSocket) {
  const activeQuery = activeQueries.get(sessionId);
  if (activeQuery) {
    abortedSessions.add(sessionId);
    activeQuery.interrupt();
    activeQueries.delete(sessionId);

    sendToSession(sessionId, {
      type: 'result',
      result: 'Cancelled by user',
      sessionId,
      cancelled: true,
    });
    updateSession(sessionId, { status: 'idle' });
  }
}

/**
 * Get cached slash commands for a session.
 */
export function getCommands(
  sessionId: string,
): Array<{ name: string; description: string; argHint?: string }> {
  return sessionCommands.get(sessionId) || [];
}

/**
 * Fetch and cache slash commands for a session.
 * Returns the commands, or empty array if unavailable.
 */
export async function fetchCommands(
  sessionId: string,
): Promise<Array<{ name: string; description: string; argHint?: string }>> {
  // If we already have commands cached, return them
  const cached = sessionCommands.get(sessionId);
  if (cached) return cached;

  // Commands are fetched after the first query completes — see runPrompt
  return [];
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
  _ws: WebSocket,
  images?: Array<{ base64: string; mimeType: string }>,
) {
  const session = getSession(sessionId);
  if (!session) {
    sendToSession(sessionId, { type: 'error', message: 'Session not found' });
    return;
  }

  updateSession(sessionId, { status: 'busy' });

  let fullText = '';

  try {
    // Build workspace context prefix for multi-folder sessions
    let workspacePrefix = '';
    if (session.repoPaths && session.repoPaths.length >= 2) {
      const folderList = session.repoPaths.map((p) => `- ${p}`).join('\n');
      workspacePrefix =
        `[Workspace Context] This session spans multiple project folders:\n` +
        `${folderList}\n` +
        `Working directory: ${session.repoPath} (common parent)\n\n`;
    }

    const effectivePrompt = workspacePrefix ? workspacePrefix + prompt : prompt;

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
              { type: 'text' as const, text: effectivePrompt },
            ],
          },
          parent_tool_use_id: null,
          session_id: currentSession.conversationId || '',
        };
      }
      resolvedPrompt = multimodalPrompt();
    } else {
      resolvedPrompt = effectivePrompt;
    }

    // Resolve Claude mode (sdk or cli) and build env
    const mode = resolveMode(session);
    const env = buildEnvForMode(mode);
    console.log(`[${sessionId}] mode=${mode}, ANTHROPIC_API_KEY in env: ${'ANTHROPIC_API_KEY' in env}`);

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
        env,
      },
    };

    // Resume conversation if we have a previous session ID from the SDK
    if (session.conversationId) {
      queryOptions.options!.resume = session.conversationId;
    }

    const conversation = query(queryOptions);

    // Store active query for abort support
    activeQueries.set(sessionId, conversation);

    for await (const message of conversation) {
      switch (message.type) {
        case 'system': {
          // system.init — capture session_id for resume, relay model info
          if ('session_id' in message) {
            updateSession(sessionId, {
              conversationId: message.session_id,
            });
          }
          sendToSession(sessionId, {
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
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                fullText += block.text;
                sendToSession(sessionId, { type: 'text_delta', text: block.text });
              }
              if (block.type === 'tool_use' && block.name) {
                sendToSession(sessionId, {
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
          // Final result — relay cost, duration, result text, token usage
          const resultMsg = message as {
            subtype?: string;
            result?: string;
            total_cost_usd?: number;
            duration_ms?: number;
            session_id?: string;
            errors?: string[];
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };

          if (
            resultMsg.subtype === 'success' &&
            resultMsg.result
          ) {
            sendToSession(sessionId, {
              type: 'result',
              result: resultMsg.result,
              sessionId,
              cost: resultMsg.total_cost_usd,
              free: mode === 'cli' || undefined,
              duration: resultMsg.duration_ms
                ? resultMsg.duration_ms / 1000
                : undefined,
              inputTokens: resultMsg.usage?.input_tokens,
              outputTokens: resultMsg.usage?.output_tokens,
              cacheReads: resultMsg.usage?.cache_read_input_tokens,
              cacheWrites: resultMsg.usage?.cache_creation_input_tokens,
            });
          } else if (resultMsg.errors?.length) {
            // Detect error subtypes
            const errorText = resultMsg.errors.join('\n');
            let subtype: string | undefined;
            if (/rate.?limit/i.test(errorText)) subtype = 'rate_limit';
            else if (/billing/i.test(errorText)) subtype = 'billing_error';
            else if (/auth/i.test(errorText)) subtype = 'auth_error';
            else if (/overloaded/i.test(errorText)) subtype = 'overloaded';

            sendToSession(sessionId, {
              type: 'error',
              message: errorText,
              subtype,
            });
          } else {
            sendToSession(sessionId, {
              type: 'result',
              result: resultMsg.result || '',
              sessionId,
              cost: resultMsg.total_cost_usd,
              free: mode === 'cli' || undefined,
              duration: resultMsg.duration_ms
                ? resultMsg.duration_ms / 1000
                : undefined,
              inputTokens: resultMsg.usage?.input_tokens,
              outputTokens: resultMsg.usage?.output_tokens,
              cacheReads: resultMsg.usage?.cache_read_input_tokens,
              cacheWrites: resultMsg.usage?.cache_creation_input_tokens,
            });
          }

          // After first successful result, try to cache commands
          if (!sessionCommands.has(sessionId)) {
            try {
              console.log(`[${sessionId.slice(0, 8)}] Fetching supportedCommands...`);
              const cmds = await conversation.supportedCommands();
              console.log(`[${sessionId.slice(0, 8)}] supportedCommands returned:`, JSON.stringify(cmds)?.slice(0, 200));
              if (cmds && Array.isArray(cmds)) {
                const mapped = cmds.map((c: { name?: string; description?: string; argHint?: string }) => ({
                  name: c.name || '',
                  description: c.description || '',
                  argHint: c.argHint,
                }));
                console.log(`[${sessionId.slice(0, 8)}] Cached ${mapped.length} SDK commands`);
                sessionCommands.set(sessionId, mapped);
                sendToSession(sessionId, { type: 'commands_available', commands: [...BRIDGE_COMMANDS, ...mapped] });
              }
            } catch (err) {
              console.error(`[${sessionId.slice(0, 8)}] supportedCommands failed:`, err);
            }
          }
          break;
        }

        default: {
          // Handle tool progress / status messages if possible
          const anyMsg = message as Record<string, unknown>;
          if (anyMsg.type === 'tool_progress' && anyMsg.tool_name) {
            sendToSession(sessionId, {
              type: 'tool_progress',
              toolName: anyMsg.tool_name as string,
              elapsed: (anyMsg.elapsed_ms as number) || 0,
            });
          }
          break;
        }
      }
    }
  } catch (err) {
    // If session was aborted, suppress the expected "Query closed" error
    if (abortedSessions.has(sessionId)) {
      return;
    }

    const errMessage =
      err instanceof Error ? err.message : 'Unknown error';

    // Detect error subtypes from exceptions
    let subtype: string | undefined;
    if (/rate.?limit/i.test(errMessage)) subtype = 'rate_limit';
    else if (/billing/i.test(errMessage)) subtype = 'billing_error';
    else if (/auth/i.test(errMessage)) subtype = 'auth_error';
    else if (/overloaded/i.test(errMessage)) subtype = 'overloaded';

    sendToSession(sessionId, { type: 'error', message: errMessage, subtype });
  } finally {
    abortedSessions.delete(sessionId);
    activeQueries.delete(sessionId);
    updateSession(sessionId, { status: 'idle' });
  }
}
