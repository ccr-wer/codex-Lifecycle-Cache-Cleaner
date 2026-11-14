/**
 * adapters/index.js — provider 注册表。
 * 未配置 provider 时返回纯文件 adapter（不清理引擎，也不可能虚报）。
 */
import { CodexAdapter } from './base.js';
import { OllamaAdapter } from './ollama.js';
import { LlamaCppAdapter } from './llamacpp.js';
import { LmStudioAdapter } from './lmstudio.js';

export function createAdapter(config = {}) {
  const provider = String(config.engine?.provider || 'none').toLowerCase();
  if (provider === 'ollama') return new OllamaAdapter(config);
  if (provider === 'llamacpp' || provider === 'llama.cpp' || provider === 'llama-server') {
    return new LlamaCppAdapter(config);
  }
  if (provider === 'lmstudio' || provider === 'lm-studio') return new LmStudioAdapter(config);
  return new CodexAdapter(config);
}

export { CodexAdapter, OllamaAdapter, LlamaCppAdapter, LmStudioAdapter };
