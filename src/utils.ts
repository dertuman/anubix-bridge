export function classifyError(message: string): string | undefined {
  if (/rate.?limit/i.test(message)) return 'rate_limit';
  if (/billing/i.test(message)) return 'billing_error';
  if (/auth/i.test(message)) return 'auth_error';
  if (/overloaded/i.test(message)) return 'overloaded';
  return undefined;
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
