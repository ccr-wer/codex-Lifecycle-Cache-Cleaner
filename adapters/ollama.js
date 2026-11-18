/**
 * adapters/ollama.js — Ollama 引擎清理 + 本地总结。
 *
 * 清理语义只有一个：让模型从内存里卸载。
 *   POST /api/generate {model, keep_alive: 0}   -> 触发卸载
 *   GET  /api/ps                              -> 确认已不在常驻列表
 *   RSS 轮询                                   -> 确认内存真的掉了
 *
 * 「200 了就查内存」是最容易翻车的地方：卸载是异步的，必须轮询。
 */
import { CodexAdapter } from './base.js';
import { MemoryError } from '../state.js';
import { readRssBytes, waitForRssDrop, sleep } from '../rss.js';

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
const baseName = (m) => String(m || '').split(':')[0].toLowerCase();

export const sameModel = (a, b) => {
  if (!a || !b) return false;
  const A = String(a).toLowerCase();
  const B = String(b).toLowerCase();
  return A === B || baseName(A) === baseName(B);
};

export class OllamaAdapter extends CodexAdapter {
  constructor(config = {}) {
    super(config);
    this.endpoint = trimSlash(config.engine?.endpoint || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
    this.model = config.engine?.model || process.env.CODEX_MODEL || null;
    this.timeoutMs = Number(config.engine?.timeoutMs || 60000);
  }

  url(p, endpoint = this.endpoint) {
    return `${trimSlash(endpoint)}${p}`;
  }

  async #post(p, body, timeoutMs = this.timeoutMs, endpoint = this.endpoint) {
    const res = await fetch(this.url(p, endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 响应按错误处理 */
    }
    return { res, text, json };
  }

  async listLoaded(endpoint = this.endpoint) {
    const res = await fetch(this.url('/api/ps', endpoint), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new MemoryError('E_PS_HTTP', `/api/ps ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.models) ? json.models : [];
  }

  /** 探测：只回答「加载了什么」，归属由 gate 判定，不在这里做同名启发。 */
  async probeEngine({ endpoint, model } = {}) {
    const ep = trimSlash(endpoint || this.endpoint);
    const target = model || this.model;
    if (!target) return { ok: false, code: 'E_NO_MODEL' };
    try {
      const models = await this.listLoaded(ep);
      const names = models.map((m) => m.name || m.model);
      return {
        ok: true,
        loaded: names.some((n) => sameModel(n, target)),
        models: names,
        endpoint: ep,
        model: target,
      };
    } catch (e) {
      return { ok: false, code: e.code || 'E_PROBE_FAILED', error: e.message };
    }
  }

  async summarize(prompt, { maxTokens = 900, timeoutMs = this.timeoutMs } = {}) {
    if (!this.model) throw new MemoryError('E_NO_MODEL', '未配置 engine.model');
    const body = {
      model: this.model,
      prompt,
      stream: false,
      format: 'json',
      keep_alive: this.config.engine?.keepAlive ?? '5m',
      options: { temperature: 0, num_predict: maxTokens },
    };
    let out = await this.#post('/api/generate', body, timeoutMs);
    if (out.res.status === 400 && /format/i.test(out.text)) {
      // 老版本 Ollama 不认 format=json
      const { format, ...rest } = body;
      out = await this.#post('/api/generate', rest, timeoutMs);
    }
    if (!out.res.ok) {
      throw new MemoryError('E_SUMMARIZE_HTTP', `/api/generate ${out.res.status}: ${out.text.slice(0, 200)}`);
    }
    const data = out.json || {};
    if (data.error) throw new MemoryError('E_SUMMARIZE_HTTP', String(data.error));
    return String(data.response || '');
  }

  /**
   * @returns {{ok:boolean, code:string, provider:'ollama', rssBefore:number|null, rssAfter:number|null, dropped:number|null}}
   */
  async cleanupLocalEngine({ model, endpoint, pid, verifyRss = true, waitMs: waitMsOpt, pollMs: pollMsOpt, rssDropRatio, rssMinDropBytes } = {}) {
    const target = model || this.model;
    if (!target) throw new MemoryError('E_NO_MODEL', 'cleanup 需要 engine.model');
    const ep = trimSlash(endpoint || this.endpoint);
    const t0 = Date.now();
    const rssBefore = pid ? await readRssBytes(pid) : null;

    const out = await this.#post(
      '/api/generate',
      { model: target, keep_alive: 0, prompt: '', stream: false },
      Number(this.config.engine?.unloadTimeoutMs || 30000),
      ep,
    );

    if (!out.res.ok) {
      if (out.res.status === 404) {
        return {
          ok: true,
          code: 'MODEL_NOT_LOADED',
          provider: 'ollama',
          unloaded: false,
          waitedMs: Date.now() - t0,
          rssBefore,
          rssAfter: rssBefore,
          dropped: 0,
        };
      }
      throw new MemoryError(
        'E_CLEANUP_HTTP',
        `keep_alive:0 ${out.res.status}: ${out.text.slice(0, 200)}`,
      );
    }

    const waitMs = Number(waitMsOpt ?? this.config.cleanup?.waitMs ?? 15000);
    const pollMs = Number(pollMsOpt ?? this.config.cleanup?.pollMs ?? 300);
    const deadline = Date.now() + waitMs;
    let loaded = true;
    let psError = null;

    while (Date.now() < deadline) {
      try {
        const models = await this.listLoaded(ep);
        loaded = models.some((m) => sameModel(m.name || m.model, target));
        psError = null;
      } catch (e) {
        psError = e.message;
      }
      if (!loaded) break;
      await sleep(pollMs);
    }

    if (loaded) {
      return {
        ok: false,
        code: 'STILL_LOADED',
        provider: 'ollama',
        waitedMs: Date.now() - t0,
        rssBefore,
        psError,
      };
    }

    let rss = null;
    if (pid && verifyRss && rssBefore) {
      rss = await waitForRssDrop({
        pid,
        before: rssBefore,
        ratio: Number(rssDropRatio ?? this.config.cleanup?.rssDropRatio ?? 0.2),
        minDropBytes: Number(rssMinDropBytes ?? this.config.cleanup?.rssMinDropBytes ?? 64 * 1024 * 1024),
        timeoutMs: waitMs,
        pollMs,
      });
      if (!rss.ok) {
        return {
          ok: false,
          code: 'RSS_NOT_DROPPED',
          provider: 'ollama',
          waitedMs: Date.now() - t0,
          rssBefore,
          rssAfter: rss.after,
          dropped: rss.dropped,
        };
      }
    }

    return {
      ok: true,
      code: 'UNLOADED',
      provider: 'ollama',
      unloaded: true,
      waitedMs: Date.now() - t0,
      rssBefore,
      rssAfter: rss?.after ?? null,
      dropped: rss?.dropped ?? null,
    };
  }
}

export default OllamaAdapter;
