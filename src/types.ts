export type ClaudeMode = 'sdk' | 'cli';

// Session state stored by the bridge
export interface SessionState {
  id: string;
  name: string;
  repoPath: string;
  repoPaths?: string[];
  conversationId?: string;
  status: 'idle' | 'busy' | 'error';
  mode?: ClaudeMode;
  model?: string;
  createdAt: number;
  lastActiveAt: number;
}

// --- WebSocket: Client → Server ---

export interface WsClientMessage {
  type: 'message';
  content: string;
  images?: Array<{ base64: string; mimeType: string }>;
}

export interface WsClientApproval {
  type: 'approval';
  decision: 'allow' | 'deny';
  message?: string;
}

export interface WsClientQuestionAnswer {
  type: 'question_answer';
  answers: Record<string, string>;
}

export interface WsClientAbort {
  type: 'abort';
}

export interface WsClientPing {
  type: 'ping';
}

export type WsClientPayload =
  | WsClientMessage
  | WsClientApproval
  | WsClientQuestionAnswer
  | WsClientAbort
  | WsClientPing;

// --- WebSocket: Server → Client ---

export interface WsTextDelta {
  type: 'text_delta';
  text: string;
}

export interface WsToolStart {
  type: 'tool_start';
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface WsToolEnd {
  type: 'tool_end';
  toolName: string;
}

export interface WsToolProgress {
  type: 'tool_progress';
  toolName: string;
  elapsed: number;
}

export interface WsApprovalRequest {
  type: 'approval_request';
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface WsAskQuestion {
  type: 'ask_question';
  questions: Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
  }>;
}

export interface WsResult {
  type: 'result';
  result: string;
  sessionId: string;
  cost?: number;
  free?: boolean;
  duration?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReads?: number;
  cacheWrites?: number;
  cancelled?: boolean;
}

export interface WsError {
  type: 'error';
  message: string;
  subtype?: string;
}

export interface WsSessionInit {
  type: 'session_init';
  sessionId: string;
  model?: string;
}

export interface WsCommandsAvailable {
  type: 'commands_available';
  commands: Array<{ name: string; description: string; argHint?: string }>;
}

export interface WsReplayStart {
  type: 'replay_start';
  fromSeq: number;
  toSeq: number;
}

export interface WsReplayEnd {
  type: 'replay_end';
}

export interface WsSessionStatus {
  type: 'session_status';
  sessionId: string;
  status: SessionState['status'];
  hasPendingApproval: boolean;
  hasPendingQuestion: boolean;
}

export interface WsSessionCleared {
  type: 'session_cleared';
  sessionId: string;
}

export interface WsPong {
  type: 'pong';
  timestamp: number;
}

export interface WsUserMessage {
  type: 'user_message';
  content: string;
  images?: Array<{ base64: string; mimeType: string }>;
  timestamp: number;
}

export type WsServerPayload =
  | WsTextDelta
  | WsToolStart
  | WsToolEnd
  | WsToolProgress
  | WsApprovalRequest
  | WsAskQuestion
  | WsResult
  | WsError
  | WsSessionInit
  | WsCommandsAvailable
  | WsReplayStart
  | WsReplayEnd
  | WsSessionStatus
  | WsSessionCleared
  | WsPong
  | WsUserMessage;

// --- Preview ---

export interface PreviewState {
  sessionId: string;
  command: string;
  port: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  pid?: number;
  error?: string;
  startedAt: number;
}

export interface PreviewStartRequest {
  sessionId: string;
  command?: string;
  port?: number;
}

export interface PreviewStatusResponse {
  active: boolean;
  sessionId?: string;
  command?: string;
  port?: number;
  status?: PreviewState['status'];
  pid?: number;
  error?: string;
  startedAt?: number;
}
