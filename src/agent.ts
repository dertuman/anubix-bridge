import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type WebSocket from 'ws';

import { BRIDGE_COMMANDS } from './commands.js';
import { appendMessage, getAllMessages } from './messageLog.js';
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
 * Build a conversation history summary from the message log for a session.
 * Used as a fallback when the SDK session cannot be resumed (e.g. after server
 * restart and the conversationId is stale).
 *
 * Returns a compact text block of prior user messages and assistant responses
 * that can be prepended to the prompt so Claude has context.
 */
function buildHistoryContext(sessionId: string): string {
  const messages = getAllMessages(sessionId);
  if (messages.length === 0) return '';

  const parts: string[] = [];
  let currentAssistantText = '';

  for (const { payload } of messages) {
    if (payload.type === 'user_message') {
      // Flush any accumulated assistant text
      if (currentAssistantText) {
        parts.push(`[assistant]: ${currentAssistantText.trim()}`);
        currentAssistantText = '';
      }
      if (payload.content) {
        parts.push(`[user]: ${payload.content}`);
      }
    } else if (payload.type === 'text_delta') {
      if (payload.text) {
        currentAssistantText += payload.text;
      }
    } else if (payload.type === 'result') {
      // Flush any accumulated assistant text before the result marker
      if (currentAssistantText) {
        parts.push(`[assistant]: ${currentAssistantText.trim()}`);
        currentAssistantText = '';
      }
    }
  }

  // Flush trailing assistant text
  if (currentAssistantText) {
    parts.push(`[assistant]: ${currentAssistantText.trim()}`);
  }

  if (parts.length === 0) return '';

  // Truncate to avoid exceeding context limits — keep last ~50 exchanges
  const truncated = parts.slice(-100);
  return (
    `<conversation-history>\n` +
    `The following is the prior conversation history for this session. ` +
    `Use it as context to understand what the user is referring to.\n\n` +
    `${truncated.join('\n\n')}\n` +
    `</conversation-history>\n\n`
  );
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
  let resultSent = false;

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

        // Intercept AskUserQuestion tool calls and relay to WebSocket clients.
        // AskUserQuestion is NOT in allowedTools, so it triggers this callback.
        // We send the questions to the connected app, wait for the user's answer,
        // then return 'allow' with the answers injected into updatedInput.
        canUseTool: async (toolName, input, { signal }) => {
          if (toolName === 'AskUserQuestion') {
            const questions = (input.questions as Array<{
              question: string;
              options: Array<{ label: string; description?: string }>;
              multiSelect?: boolean;
            }>) || [];

            console.log(`[${sessionId.slice(0, 8)}] AskUserQuestion intercepted: ${questions.length} question(s)`);

            // Build the payload and store for reconnect recovery
            const questionPayload: WsAskQuestion = { type: 'ask_question', questions };
            storeQuestionPayload(sessionId, questionPayload);

            // Send to the connected WebSocket client
            sendToSession(sessionId, questionPayload);

            // Wait for the user's answer, racing against abort signal
            const answers = await new Promise<Record<string, string>>((resolve, reject) => {
              // Listen for abort
              const onAbort = () => {
                // Clean up pending question state
                pendingQuestions.delete(sessionId);
                lastQuestionPayloads.delete(sessionId);
                reject(new Error('Aborted'));
              };
              if (signal.aborted) { onAbort(); return; }
              signal.addEventListener('abort', onAbort, { once: true });

              // Wait for the user answer via resolveQuestion()
              waitForQuestionAnswer(sessionId).then((ans) => {
                signal.removeEventListener('abort', onAbort);
                resolve(ans);
              });
            });

            console.log(`[${sessionId.slice(0, 8)}] AskUserQuestion answered:`, JSON.stringify(answers));

            // Return allow with answers injected so the SDK feeds them to Claude
            return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
          }

          // All other tools: auto-allow (they're already in allowedTools,
          // but canUseTool may still fire for edge cases)
          return { behavior: 'allow' as const };
        },
      },
    };

    // Resume conversation if we have a previous session ID from the SDK
    if (session.conversationId) {
      queryOptions.options!.resume = session.conversationId;
    }

    // Helper: execute the query and stream results back to the client
    const executeQuery = async (opts: Parameters<typeof query>[0]) => {
      const conversation = query(opts);
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
              resultSent = true;
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
              resultSent = true;
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
              resultSent = true;
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
    };

    // Attempt to run the query — if resume fails, retry with history context
    try {
      await executeQuery(queryOptions);
    } catch (resumeErr) {
      // If this was a resume attempt and it failed, retry without resume
      // but prepend conversation history so Claude has context
      if (
        queryOptions.options?.resume &&
        !abortedSessions.has(sessionId)
      ) {
        const tag = sessionId.slice(0, 8);
        console.log(
          `[${tag}] Resume failed (${resumeErr instanceof Error ? resumeErr.message : 'unknown'}), retrying with history context...`,
        );

        // Clear stale conversationId
        updateSession(sessionId, { conversationId: undefined });

        // Build history context from message log and prepend to prompt
        const historyContext = buildHistoryContext(sessionId);
        const retryPrompt = historyContext + effectivePrompt;

        // Rebuild query options without resume, with history-enriched prompt
        const retryOptions: Parameters<typeof query>[0] = {
          ...queryOptions,
          prompt: retryPrompt,
          options: { ...queryOptions.options, resume: undefined },
        };
        delete retryOptions.options!.resume;

        fullText = '';
        await executeQuery(retryOptions);
      } else {
        throw resumeErr;
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
    resultSent = true;
  } finally {
    abortedSessions.delete(sessionId);
    activeQueries.delete(sessionId);
    updateSession(sessionId, { status: 'idle' });

    // Safety net: if the SDK stream ended without emitting a result or error
    // frame, the client would stay in isBusy=true forever. Send a fallback
    // result so the client always transitions back to idle.
    if (!resultSent) {
      console.log(`[${sessionId.slice(0, 8)}] No result frame was sent — sending fallback result`);
      sendToSession(sessionId, {
        type: 'result',
        result: fullText || '',
        sessionId,
      });
    }
  }
}
