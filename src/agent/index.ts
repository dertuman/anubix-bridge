import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { DEFAULT_MODEL } from '../commands.js';
import { getSession, updateSession } from '../sessions.js';
import type { ClaudeMode, SessionState } from '../types.js';
import { shortId } from '../utils.js';
import { buildCanUseToolHandler, buildHistoryContext, processConversationLoop } from './conversation.js';
import { MessageQueue } from './queue.js';
import { ctx, getAllContexts, pickLatestModel, sendToSession } from './state.js';

export { MessageQueue } from './queue.js';
export {
  type SessionContext,
  type LiveConversation,
  ctx,
  getCachedModels,
  pickLatestModel,
  registerSocket,
  unregisterSocket,
  sendToSession,
  send,
  hasPendingApproval,
  hasPendingQuestion,
  getLastApprovalPayload,
  getLastQuestionPayload,
  storeApprovalPayload,
  storeQuestionPayload,
  resolveApproval,
  resolveQuestion,
  waitForApproval,
  waitForQuestionAnswer,
  getCommands,
  fetchCommands,
} from './state.js';

export function resolveMode(session: SessionState): ClaudeMode {
  return session.mode || (process.env.CLAUDE_MODE as ClaudeMode) || 'sdk';
}

export function buildEnvForMode(mode: ClaudeMode): Record<string, string | undefined> {
  if (mode === 'cli') {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    return env;
  }
  return { ...process.env };
}

export function abortPrompt(sessionId: string) {
  const c = ctx(sessionId);
  if (c.activeQuery) {
    c.aborted = true;
    c.activeQuery.interrupt();

    sendToSession(sessionId, {
      type: 'result',
      result: 'Cancelled by user',
      sessionId,
      cancelled: true,
    });
    updateSession(sessionId, { status: 'idle' });
  }
}

export function closeConversation(sessionId: string) {
  const c = ctx(sessionId);
  if (c.liveConversation) {
    c.liveConversation.queue.close();
    c.liveConversation.conversation.close();
    c.liveConversation = undefined;
    c.activeQuery = undefined;
  }
}

export async function switchModel(sessionId: string, model: string | undefined) {
  const c = ctx(sessionId);
  if (c.liveConversation) {
    try {
      await c.liveConversation.conversation.setModel(model);
      console.log(`[${shortId(sessionId)}] Switched model to: ${model || 'default'}`);
    } catch (err) {
      console.error(`[${shortId(sessionId)}] Failed to switch model:`, err);
      throw err;
    }
  }
}

export function closeAllConversations(): number {
  let count = 0;
  for (const [, c] of getAllContexts()) {
    if (c.liveConversation) {
      c.liveConversation.queue.close();
      c.liveConversation.conversation.close();
      c.liveConversation = undefined;
      c.activeQuery = undefined;
      count++;
    }
  }
  return count;
}

export async function runPrompt(
  sessionId: string,
  prompt: string,
  images?: Array<{ base64: string; mimeType: string }>,
) {
  const session = getSession(sessionId);
  if (!session) {
    sendToSession(sessionId, { type: 'error', message: 'Session not found' });
    return;
  }

  updateSession(sessionId, { status: 'busy' });

  let workspacePrefix = '';
  if (session.repoPaths && session.repoPaths.length >= 2) {
    const folderList = session.repoPaths.map((p) => `- ${p}`).join('\n');
    workspacePrefix =
      `[Workspace Context] This session spans multiple project folders:\n` +
      `${folderList}\n` +
      `Working directory: ${session.repoPath} (common parent)\n\n`;
  }
  const effectivePrompt = workspacePrefix ? workspacePrefix + prompt : prompt;

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

  const c = ctx(sessionId);
  if (c.liveConversation) {
    console.log(`[${shortId(sessionId)}] Reusing live conversation (instant)`);
    c.liveConversation.queue.push(buildUserMessage());
    return;
  }

  const mode = resolveMode(session);
  const env = buildEnvForMode(mode);
  console.log(`[${shortId(sessionId)}] Creating new conversation (mode=${mode})`);

  const msgQueue = new MessageQueue();

  let firstPrompt = effectivePrompt;
  if (session.conversationId) {
    const historyContext = buildHistoryContext(sessionId);
    if (historyContext) {
      firstPrompt = historyContext + effectivePrompt;
    }
  }

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
      model: session.model || pickLatestModel() || DEFAULT_MODEL,
    },
  };

  if (session.conversationId) {
    queryOptions.options!.resume = session.conversationId;
  }

  const conversation = query(queryOptions);

  c.liveConversation = { conversation, queue: msgQueue, mode };
  c.activeQuery = conversation;

  processConversationLoop(sessionId, conversation, mode).catch((err) => {
    console.error(`[${shortId(sessionId)}] processConversationLoop uncaught:`, err);
    updateSession(sessionId, { status: 'idle' });
    const sc = ctx(sessionId);
    sc.liveConversation = undefined;
    sc.activeQuery = undefined;
    sc.aborted = false;
  });
}
