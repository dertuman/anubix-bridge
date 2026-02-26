import { query, type SDKUserMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import type WebSocket from 'ws';

import { BRIDGE_COMMANDS } from './commands.js';
import { appendMessage, getAllMessages } from './messageLog.js';
import { getSession, updateSession } from './sessions.js';
import type { ClaudeMode, SessionState, WsApprovalRequest, WsAskQuestion, WsServerPayload } from './types.js';

// ── Async message queue ─────────────────────────────────────
// Allows pushing SDKUserMessage objects that the SDK reads one at a time.
// This keeps a single Claude Code subprocess alive across multiple messages.
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage) {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  close() {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

// ── Per-session state maps ──────────────────────────────────

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

// Active query instances per session (for abort/interrupt)
const activeQueries = new Map<string, Query>();

// Sessions that were aborted
const abortedSessions = new Set<string>();

// Cached slash commands per session
const sessionCommands = new Map<
  string,
  Array<{ name: string; description: string; argHint?: string }>
>();

// Active WebSocket per session — allows reconnects to pick up a running prompt
const sessionSockets = new Map<string, WebSocket>();

// ── Persistent conversations ────────────────────────────────
// One subprocess per session, kept alive across messages.
interface LiveConversation {
  conversation: Query;
  queue: MessageQueue;
  mode: ClaudeMode;
}
const liveConversations = new Map<string, LiveConversation>();

// ── Socket management ───────────────────────────────────────

export function registerSocket(sessionId: string, ws: WebSocket) {
  const existing = sessionSockets.get(sessionId);
  if (existing && existing !== ws) {
    console.log(`[${sessionId.slice(0, 8)}] Replacing socket reference (old socket left to close naturally)`);
  }
  sessionSockets.set(sessionId, ws);
}

export function unregisterSocket(sessionId: string, ws: WebSocket) {
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

// ── Approval / Question helpers ─────────────────────────────

export function hasPendingApproval(sessionId: string): boolean {
  return pendingApprovals.has(sessionId);
}

export function hasPendingQuestion(sessionId: string): boolean {
  return pendingQuestions.has(sessionId);
}

export function getLastApprovalPayload(sessionId: string): WsApprovalRequest | undefined {
  return lastApprovalPayloads.get(sessionId);
}

export function getLastQuestionPayload(sessionId: string): WsAskQuestion | undefined {
  return lastQuestionPayloads.get(sessionId);
}

export function storeApprovalPayload(sessionId: string, payload: WsApprovalRequest) {
  lastApprovalPayloads.set(sessionId, payload);
}

export function storeQuestionPayload(sessionId: string, payload: WsAskQuestion) {
  lastQuestionPayloads.set(sessionId, payload);
}

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

export function waitForApproval(
  sessionId: string,
): Promise<{ allow: boolean; message?: string }> {
  return new Promise((resolve) => {
    pendingApprovals.set(sessionId, { resolve });
  });
}

export function waitForQuestionAnswer(
  sessionId: string,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    pendingQuestions.set(sessionId, { resolve });
  });
}

// ── Claude mode helpers ─────────────────────────────────────

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

// ── Command caching ─────────────────────────────────────────

export function getCommands(
  sessionId: string,
): Array<{ name: string; description: string; argHint?: string }> {
  return sessionCommands.get(sessionId) || [];
}

export async function fetchCommands(
  sessionId: string,
): Promise<Array<{ name: string; description: string; argHint?: string }>> {
  const cached = sessionCommands.get(sessionId);
  if (cached) return cached;
  return [];
}

// ── Abort / Close ───────────────────────────────────────────

/**
 * Abort (interrupt) the current turn without killing the conversation.
 * The subprocess stays alive for the next message.
 */
export function abortPrompt(sessionId: string, _ws?: WebSocket) {
  const activeQuery = activeQueries.get(sessionId);
  if (activeQuery) {
    abortedSessions.add(sessionId);
    activeQuery.interrupt();

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
 * Close and destroy a persistent conversation (e.g. on /clear or session delete).
 */
export function closeConversation(sessionId: string) {
  const live = liveConversations.get(sessionId);
  if (live) {
    live.queue.close();
    live.conversation.close();
    liveConversations.delete(sessionId);
    activeQueries.delete(sessionId);
  }
}

/**
 * Close ALL persistent conversations (e.g. after credential update).
 * Returns the number of conversations closed.
 */
export function closeAllConversations(): number {
  let count = 0;
  for (const [sessionId, live] of liveConversations) {
    live.queue.close();
    live.conversation.close();
    activeQueries.delete(sessionId);
    count++;
  }
  liveConversations.clear();
  return count;
}

// ── History context (fallback for stale resume) ─────────────

function buildHistoryContext(sessionId: string): string {
  const messages = getAllMessages(sessionId);
  if (messages.length === 0) return '';

  const parts: string[] = [];
  let currentAssistantText = '';

  for (const { payload } of messages) {
    if (payload.type === 'user_message') {
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
      if (currentAssistantText) {
        parts.push(`[assistant]: ${currentAssistantText.trim()}`);
        currentAssistantText = '';
      }
    }
  }

  if (currentAssistantText) {
    parts.push(`[assistant]: ${currentAssistantText.trim()}`);
  }

  if (parts.length === 0) return '';

  const truncated = parts.slice(-100);
  return (
    `<conversation-history>\n` +
    `The following is the prior conversation history for this session. ` +
    `Use it as context to understand what the user is referring to.\n\n` +
    `${truncated.join('\n\n')}\n` +
    `</conversation-history>\n\n`
  );
}

// ── canUseTool handler builder ──────────────────────────────

function buildCanUseToolHandler(sessionId: string) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    { signal }: { signal: AbortSignal },
  ) => {
    if (toolName === 'AskUserQuestion') {
      const questions = (input.questions as Array<{
        question: string;
        options: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
      }>) || [];

      console.log(`[${sessionId.slice(0, 8)}] AskUserQuestion intercepted: ${questions.length} question(s)`);

      const questionPayload: WsAskQuestion = { type: 'ask_question', questions };
      storeQuestionPayload(sessionId, questionPayload);
      sendToSession(sessionId, questionPayload);

      const answers = await new Promise<Record<string, string>>((resolve, reject) => {
        const onAbort = () => {
          pendingQuestions.delete(sessionId);
          lastQuestionPayloads.delete(sessionId);
          reject(new Error('Aborted'));
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });

        waitForQuestionAnswer(sessionId).then((ans) => {
          signal.removeEventListener('abort', onAbort);
          resolve(ans);
        });
      });

      console.log(`[${sessionId.slice(0, 8)}] AskUserQuestion answered:`, JSON.stringify(answers));
      return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
    }

    return { behavior: 'allow' as const };
  };
}

// ── Background conversation processing loop ─────────────────

/**
 * Runs for the lifetime of a persistent conversation, processing all
 * messages (across multiple user prompts) from a single subprocess.
 */
async function processConversationLoop(
  sessionId: string,
  conversation: Query,
  mode: ClaudeMode,
) {
  const tag = sessionId.slice(0, 8);
  let fullText = '';
  let sentResultOrError = false;

  try {
    for await (const message of conversation) {
      // Skip events after abort — wait for the next user message
      if (abortedSessions.has(sessionId)) {
        if (message.type === 'result') {
          abortedSessions.delete(sessionId);
        }
        continue;
      }

      switch (message.type) {
        case 'system': {
          if ('session_id' in message) {
            updateSession(sessionId, { conversationId: message.session_id });
          }
          sendToSession(sessionId, {
            type: 'session_init',
            sessionId,
            model: 'model' in message ? (message.model as string) : undefined,
          });
          break;
        }

        case 'stream_event': {
          // Token-level streaming (includePartialMessages: true)
          const streamMsg = message as { event: {
            type: string;
            delta?: { type: string; text?: string };
            content_block?: { type: string; name?: string; id?: string };
            index?: number;
          } };
          const event = streamMsg.event;

          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text;
            if (text) {
              fullText += text;
              sendToSession(sessionId, { type: 'text_delta', text });
            }
          }
          break;
        }

        case 'assistant': {
          // Full assistant message — only extract tool_use blocks.
          // Text is streamed via stream_event above.
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

          sentResultOrError = true;

          if (resultMsg.subtype === 'success' && resultMsg.result) {
            sendToSession(sessionId, {
              type: 'result',
              result: resultMsg.result,
              sessionId,
              cost: resultMsg.total_cost_usd,
              free: mode === 'cli' || undefined,
              duration: resultMsg.duration_ms ? resultMsg.duration_ms / 1000 : undefined,
              inputTokens: resultMsg.usage?.input_tokens,
              outputTokens: resultMsg.usage?.output_tokens,
              cacheReads: resultMsg.usage?.cache_read_input_tokens,
              cacheWrites: resultMsg.usage?.cache_creation_input_tokens,
            });
          } else if (resultMsg.errors?.length) {
            const errorText = resultMsg.errors.join('\n');
            let subtype: string | undefined;
            if (/rate.?limit/i.test(errorText)) subtype = 'rate_limit';
            else if (/billing/i.test(errorText)) subtype = 'billing_error';
            else if (/auth/i.test(errorText)) subtype = 'auth_error';
            else if (/overloaded/i.test(errorText)) subtype = 'overloaded';

            sendToSession(sessionId, { type: 'error', message: errorText, subtype });
          } else {
            sendToSession(sessionId, {
              type: 'result',
              result: resultMsg.result || fullText || '',
              sessionId,
              cost: resultMsg.total_cost_usd,
              free: mode === 'cli' || undefined,
              duration: resultMsg.duration_ms ? resultMsg.duration_ms / 1000 : undefined,
              inputTokens: resultMsg.usage?.input_tokens,
              outputTokens: resultMsg.usage?.output_tokens,
              cacheReads: resultMsg.usage?.cache_read_input_tokens,
              cacheWrites: resultMsg.usage?.cache_creation_input_tokens,
            });
          }

          // Reset for next message
          fullText = '';
          updateSession(sessionId, { status: 'idle' });

          // Cache commands after first result
          if (!sessionCommands.has(sessionId)) {
            try {
              console.log(`[${tag}] Fetching supportedCommands...`);
              const cmds = await conversation.supportedCommands();
              if (cmds && Array.isArray(cmds)) {
                const mapped = cmds.map((c: { name?: string; description?: string; argHint?: string }) => ({
                  name: c.name || '',
                  description: c.description || '',
                  argHint: c.argHint,
                }));
                console.log(`[${tag}] Cached ${mapped.length} SDK commands`);
                sessionCommands.set(sessionId, mapped);
                sendToSession(sessionId, { type: 'commands_available', commands: [...BRIDGE_COMMANDS, ...mapped] });
              }
            } catch (err) {
              console.error(`[${tag}] supportedCommands failed:`, err);
            }
          }
          break;
        }

        default: {
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
    if (abortedSessions.has(sessionId)) {
      abortedSessions.delete(sessionId);
      return;
    }

    const errMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[${tag}] Conversation loop error: ${errMessage}`);

    let subtype: string | undefined;
    if (/rate.?limit/i.test(errMessage)) subtype = 'rate_limit';
    else if (/billing/i.test(errMessage)) subtype = 'billing_error';
    else if (/auth/i.test(errMessage)) subtype = 'auth_error';
    else if (/overloaded/i.test(errMessage)) subtype = 'overloaded';

    sentResultOrError = true;
    sendToSession(sessionId, { type: 'error', message: errMessage, subtype });
  } finally {
    console.log(`[${tag}] Conversation loop ended (sentResult=${sentResultOrError})`);

    // Safety net: if the subprocess exited without producing any result or error
    // (e.g., auth failure causing silent exit or interactive login hang), notify the client
    if (!sentResultOrError && !abortedSessions.has(sessionId)) {
      const hint = mode === 'cli'
        ? 'Claude credentials may be invalid or expired. Try re-authenticating in Profile > Integrations, then push credentials to your machine.'
        : 'Anthropic API key may be invalid. Check your API key in Profile > Integrations.';
      sendToSession(sessionId, {
        type: 'error',
        message: `Claude Code subprocess exited without responding. ${hint}`,
        subtype: 'auth_error',
      });
    }

    liveConversations.delete(sessionId);
    activeQueries.delete(sessionId);
    abortedSessions.delete(sessionId);
    updateSession(sessionId, { status: 'idle' });
  }
}

// ── Main entry point ────────────────────────────────────────

/**
 * Run a prompt against a Claude Code session and stream results via WebSocket.
 *
 * Uses persistent conversations: the first message creates a subprocess that
 * stays alive. Subsequent messages reuse the same subprocess (near-instant).
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

  // ── Build workspace context prefix ──────────────────────
  let workspacePrefix = '';
  if (session.repoPaths && session.repoPaths.length >= 2) {
    const folderList = session.repoPaths.map((p) => `- ${p}`).join('\n');
    workspacePrefix =
      `[Workspace Context] This session spans multiple project folders:\n` +
      `${folderList}\n` +
      `Working directory: ${session.repoPath} (common parent)\n\n`;
  }
  const effectivePrompt = workspacePrefix ? workspacePrefix + prompt : prompt;

  // ── Build SDKUserMessage ────────────────────────────────
  const buildUserMessage = (): SDKUserMessage => {
    if (images && images.length > 0) {
      return {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            ...images.map((img) => ({
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
        session_id: session.conversationId || '',
      };
    }
    return {
      type: 'user' as const,
      message: { role: 'user' as const, content: effectivePrompt },
      parent_tool_use_id: null,
      session_id: session.conversationId || '',
    };
  };

  // ── Reuse existing conversation if alive ────────────────
  const live = liveConversations.get(sessionId);
  if (live) {
    console.log(`[${sessionId.slice(0, 8)}] Reusing live conversation (instant)`);
    live.queue.push(buildUserMessage());
    return;
  }

  // ── Create new persistent conversation ──────────────────
  const mode = resolveMode(session);
  const env = buildEnvForMode(mode);
  console.log(`[${sessionId.slice(0, 8)}] Creating new conversation (mode=${mode})`);

  const msgQueue = new MessageQueue();

  // For first message: if we have a conversationId and history,
  // prepend history context to the first message so Claude has context
  // even without resume (which requires the session file on disk).
  let firstPrompt = effectivePrompt;
  if (session.conversationId) {
    const historyContext = buildHistoryContext(sessionId);
    if (historyContext) {
      firstPrompt = historyContext + effectivePrompt;
    }
  }

  // Push first message into queue
  const firstMessage: SDKUserMessage = images && images.length > 0
    ? {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            ...images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: img.base64,
              },
            })),
            { type: 'text' as const, text: firstPrompt },
          ],
        },
        parent_tool_use_id: null,
        session_id: session.conversationId || '',
      }
    : {
        type: 'user' as const,
        message: { role: 'user' as const, content: firstPrompt },
        parent_tool_use_id: null,
        session_id: session.conversationId || '',
      };
  msgQueue.push(firstMessage);

  // Build query options
  const queryOptions: Parameters<typeof query>[0] = {
    prompt: msgQueue,
    options: {
      cwd: session.repoPath,
      allowedTools: [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
      ],
      env,
      includePartialMessages: true,
      canUseTool: buildCanUseToolHandler(sessionId),
      ...(session.model ? { model: session.model } : {}),
    },
  };

  // Resume from previous session if available
  if (session.conversationId) {
    queryOptions.options!.resume = session.conversationId;
  }

  // Create the conversation (spawns subprocess)
  const conversation = query(queryOptions);

  liveConversations.set(sessionId, { conversation, queue: msgQueue, mode });
  activeQueries.set(sessionId, conversation);

  // Start background processing loop (runs for lifetime of conversation)
  processConversationLoop(sessionId, conversation, mode).catch((err) => {
    console.error(`[${sessionId.slice(0, 8)}] processConversationLoop uncaught:`, err);
  });
}
