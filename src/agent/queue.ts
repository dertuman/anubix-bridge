import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class MessageQueue implements AsyncIterable<SDKUserMessage> {
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
