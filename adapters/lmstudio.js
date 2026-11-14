/**
 * adapters/lmstudio.js — LM Studio 只有 OpenAI 兼容端点，没有稳定的 HTTP 卸载接口。
 *
 * 结论：不假装成功。返回 ok:false + 明确 hint，让上层保留日志、跳过清理。
 * （这是「不虚报清理成功」的硬要求：宁可报失败，也不能说卸载了。）
 */
import { CodexAdapter } from './base.js';
import { MemoryError } from '../state.js';

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

export class LmStudioAdapter extends CodexAdapter {
  constructor(config = {}) {
    super(config);
    this.endpoint = trimSlash(config.engine?.endpoint || 'http://127.0.0.1:1234');
    this.timeoutMs = Number(config.engine?.timeoutMs || 60000);
  }

  async summarize(prompt, { maxTokens = 900, timeoutMs = this.timeoutMs } = {}) {
    const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.engine?.model || 'local-model',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new MemoryError('E_SUMMARIZE_HTTP', `chat/completions ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    return String(json?.choices?.[0]?.message?.content || '');
  }

  async cleanupLocalEngine() {
    return {
      ok: false,
      code: 'UNSUPPORTED',
      provider: 'lmstudio',
      hint: 'LM Studio 无稳定 HTTP 卸载接口：请执行 `lms unload <model>` 或退出 LM Studio 释放常驻模型。',
    };
  }
}

export default LmStudioAdapter;
