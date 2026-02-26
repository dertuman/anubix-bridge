/**
 * Fallback model used when the user hasn't picked one yet.
 * Once supportedModels() is cached from the SDK, the /model menu is fully dynamic.
 */
export const DEFAULT_MODEL = 'claude-opus-4-6';

/** Bridge-level slash commands (not from the Claude SDK). */
export const BRIDGE_COMMANDS = [
  { name: 'clear', description: 'Clear conversation and start fresh' },
  { name: 'model', description: 'Switch Claude model', argHint: '[number or name]' },
  { name: 'preview start', description: 'Start dev server preview', argHint: '[port] [command]' },
  { name: 'preview stop', description: 'Stop dev server preview' },
  { name: 'preview status', description: 'Show preview status' },
  { name: 'preview logs', description: 'Show dev server logs', argHint: '[tail]' },
];
