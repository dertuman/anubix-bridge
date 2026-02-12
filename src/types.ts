// Session state stored by the bridge
export interface SessionState {
  id: string;
  name: string;
  repoPath: string;
  conversationId?: string;
  status: 'idle' | 'busy' | 'error';
  createdAt: number;
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

export type WsClientPayload =
  | WsClientMessage
  | WsClientApproval
  | WsClientQuestionAnswer;

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
  duration?: number;
}

export interface WsError {
  type: 'error';
  message: string;
}

export interface WsSessionInit {
  type: 'session_init';
  sessionId: string;
  model?: string;
}

export type WsServerPayload =
  | WsTextDelta
  | WsToolStart
  | WsToolEnd
  | WsApprovalRequest
  | WsAskQuestion
  | WsResult
  | WsError
  | WsSessionInit;
