import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { BRIDGE_COMMANDS } from '../commands.js';
import { getAllMessages } from '../messageLog.js';
import { updateSession } from '../sessions.js';
import type { ClaudeMode, WsAskQuestion } from '../types.js';
import { classifyError, getErrorMessage, shortId } from '../utils.js';
import {
  ctx,
  getCachedModels,
  sendToSession,
  setCachedModels,
  storeQuestionPayload,
  waitForQuestionAnswer,
} from './state.js';

export function buildHistoryContext(sessionId: string): string {
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

export function buildCanUseToolHandler(sessionId: string) {
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

      console.log(`[${shortId(sessionId)}] AskUserQuestion intercepted: ${questions.length} question(s)`);

      const questionPayload: WsAskQuestion = { type: 'ask_question', questions };
      storeQuestionPayload(sessionId, questionPayload);
      sendToSession(sessionId, questionPayload);

      const answers = await new Promise<Record<string, string>>((resolve, reject) => {
        const c = ctx(sessionId);
        const onAbort = () => {
          c.pendingQuestion = undefined;
          c.lastQuestionPayload = undefined;
          reject(new Error('Aborted'));
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });

        waitForQuestionAnswer(sessionId).then((ans) => {
          signal.removeEventListener('abort', onAbort);
          resolve(ans);
        });
      });

      console.log(`[${shortId(sessionId)}] AskUserQuestion answered:`, JSON.stringify(answers));
      return { behavior: 'allow' as const, updatedInput: { ...input, answers } };
    }

    return { behavior: 'allow' as const };
  };
}

export async function processConversationLoop(
  sessionId: string,
  conversation: Query,
  mode: ClaudeMode,
) {
  const tag = shortId(sessionId);
  let fullText = '';
  let sentResultOrError = false;

  try {
    for await (const message of conversation) {
      const c = ctx(sessionId);

      if (c.aborted) {
        if (message.type === 'result') {
          c.aborted = false;
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
            const subtype = classifyError(errorText);
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

          fullText = '';
          updateSession(sessionId, { status: 'idle' });

          if (!c.commands) {
            try {
              console.log(`[${tag}] Fetching supportedCommands...`);
              const cmds = await conversation.supportedCommands();
              if (cmds && Array.isArray(cmds)) {
                const mapped = cmds.map((cmd: { name?: string; description?: string; argHint?: string }) => ({
                  name: cmd.name || '',
                  description: cmd.description || '',
                  argHint: cmd.argHint,
                }));
                console.log(`[${tag}] Cached ${mapped.length} SDK commands`);
                c.commands = mapped;
                sendToSession(sessionId, { type: 'commands_available', commands: [...BRIDGE_COMMANDS, ...mapped] });
              }
            } catch (err) {
              console.error(`[${tag}] supportedCommands failed:`, err);
            }
          }

          if (!getCachedModels()) {
            try {
              console.log(`[${tag}] Fetching supportedModels...`);
              const models = await conversation.supportedModels();
              if (models && Array.isArray(models)) {
                setCachedModels(models);
                console.log(`[${tag}] Cached ${models.length} models: ${models.map(m => m.value).join(', ')}`);
              }
            } catch (err) {
              console.error(`[${tag}] supportedModels failed:`, err);
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
    const c = ctx(sessionId);
    if (c.aborted) {
      c.aborted = false;
      return;
    }

    const errMessage = getErrorMessage(err);
    console.error(`[${tag}] Conversation loop error: ${errMessage}`);

    const subtype = classifyError(errMessage);
    sentResultOrError = true;
    sendToSession(sessionId, { type: 'error', message: errMessage, subtype });
  } finally {
    console.log(`[${tag}] Conversation loop ended (sentResult=${sentResultOrError})`);

    const c = ctx(sessionId);

    if (!sentResultOrError && !c.aborted) {
      const hint = mode === 'cli'
        ? 'Claude credentials may be invalid or expired. Try re-authenticating in Profile > Integrations, then push credentials to your machine.'
        : 'Anthropic API key may be invalid. Check your API key in Profile > Integrations.';
      sendToSession(sessionId, {
        type: 'error',
        message: `Claude Code subprocess exited without responding. ${hint}`,
        subtype: 'auth_error',
      });
    }

    c.liveConversation = undefined;
    c.activeQuery = undefined;
    c.aborted = false;
    updateSession(sessionId, { status: 'idle' });
  }
}
