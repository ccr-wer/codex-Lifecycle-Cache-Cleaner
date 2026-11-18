/**
 * adapters/llamacpp.js — llama.cpp server 的 slot 管理。
 *
 * llama-server 没有「卸载模型」接口（模型就是进程本身），能做的只有：
 *   1) 清掉空闲 slot 的 KV（POST /slots/<id>?action=erase）
 *   2) 如果没有 slot API，提示用户用 --clear-idle 启动
 *
 * 进程级内存回收只能靠重启 server，插件不做（也不该做）kill。
 */
import { CodexAdapter } from './base.js';
import { MemoryError } from '../state.js';
import { sampleMemory, waitForRssDrop, sleep } from '../rss.js';

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

export class LlamaCppAdapter extends CodexAdapter {
  constructor(config = {}) {
    super(config);
    this.endpoint = trimSlash(config.engine?.endpoint || 'http://127.0.0.1:8080');
    this.timeoutMs = Number(config.engine?.timeoutMs || 60000);
  }

  url(p) {
    return `${this.endpoint}${p}`;
  }

  async listSlots() {
    const res = await fetch(this.url('/slots'), { signal: AbortSignal.timeout(10000) });
    if (res.status === 404 || res.status === 501) {
      throw new MemoryError('E_NO_SLOT_API', 'server 未启用 slots API');
    }
    if (!res.ok) throw new MemoryError('E_SLOT_HTTP', `/slots ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : json?.slots || [];
  }

  async eraseSlot(id) {
    const res = await fetch(this.url(`/slots/${id}?action=erase`), {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok && res.status !== 404) throw new MemoryError('E_SLOT_ERASE', `slot ${id} ${res.status}`);
    return res.ok;
  }

  async summarize(prompt, { maxTokens = 900, timeoutMs = this.timeoutMs } = {}) {
    const res = await fetch(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.engine?.model || 'local',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new MemoryError('E_SUMMARIZE_HTTP', `/v1/chat/completions ${res.status}: ${text.slice(0, 200)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new MemoryError('E_SUMMARIZE_HTTP', 'chat/completions 返回非 JSON');
    }
    return String(json?.choices?.[0]?.message?.content || '');
  }

  async cleanupLocalEngine({ pid, verifyRss = true, waitMs: waitMsOpt, pollMs: pollMsOpt, rssDropRatio, rssMinDropBytes } = {}) {
    const t0 = Date.now();
    const samplerOpts = {
      platform: this.config.platform,
      kind: this.config.samplerKind,
      hasNvidia: this.config.hasNvidia,
    };
    const baseline = pid ? await sampleMemory(pid, samplerOpts) : { ok: false, code: 'E_NO_PID' };
    const rssBefore = baseline.ok && !baseline.gone ? baseline.bytes : null;

    let slots;
    try {
      slots = await this.listSlots();
    } catch (e) {
      if (e.code === 'E_NO_SLOT_API') {
        return {
          ok: false,
          code: 'NO_SLOT_API',
          provider: 'llamacpp',
          hint: '请以 --clear-idle 启动 llama-server，或用 --parallel 1 限制常驻 slot；插件不做进程 kill。',
          rssBefore,
        };
      }
      throw e;
    }

    let erased = 0;
    for (const s of slots) {
      if (s.is_processing) continue;
      try {
        if (await this.eraseSlot(s.id)) erased += 1;
      } catch {
        /* 单个 slot 失败不致命 */
      }
    }

    const waitMs = Number(waitMsOpt ?? this.config.cleanup?.waitMs ?? 15000);
    const pollMs = Number(pollMsOpt ?? this.config.cleanup?.pollMs ?? 300);
    const deadline = Date.now() + waitMs;
    let dirty = true;
    let last = slots;

    while (Date.now() < deadline) {
      try {
        last = await this.listSlots();
        dirty = last.some((s) => s.is_processing || Number(s.n_past || 0) > 0);
      } catch {
        dirty = true;
      }
      if (!dirty) break;
      await sleep(pollMs);
    }

    if (dirty) {
      return {
        ok: false,
        code: 'SLOT_BUSY',
        provider: 'llamacpp',
        erased,
        hint: '仍有 slot 在处理请求，无法清空 KV；等空闲后重试。',
        waitedMs: Date.now() - t0,
        rssBefore,
      };
    }

    let rss = null;
    if (verifyRss) {
      if (!rssBefore) {
        return {
          ok: false,
          code: 'RSS_UNVERIFIABLE',
          provider: 'llamacpp',
          erased,
          waitedMs: Date.now() - t0,
          rssBefore: null,
          sampleCode: baseline.code || 'E_NO_PID',
          hint: '拿不到内存基线：填 engine.pid，或显式 verifyRss:false 接受无内存证据',
        };
      }
      rss = await waitForRssDrop({
        pid,
        before: rssBefore,
        ratio: Number(rssDropRatio ?? this.config.cleanup?.rssDropRatio ?? 0.2),
        minDropBytes: Number(rssMinDropBytes ?? this.config.cleanup?.rssMinDropBytes ?? 64 * 1024 * 1024),
        timeoutMs: waitMs,
        pollMs,
        platform: this.config.platform,
      });
      if (!rss.ok) {
        return {
          ok: false,
          code: rss.reason === 'unverifiable' ? 'RSS_UNVERIFIABLE' : 'RSS_NOT_DROPPED',
          provider: 'llamacpp',
          erased,
          rssBefore,
          rssAfter: rss.after,
          dropped: rss.dropped,
          sampleCode: rss.code,
        };
      }
    }

    return {
      ok: true,
      code: 'SLOTS_CLEARED',
      provider: 'llamacpp',
      erased,
      waitedMs: Date.now() - t0,
      rssBefore,
      rssAfter: rss?.after ?? null,
      dropped: rss?.dropped ?? null,
    };
  }
}

export default LlamaCppAdapter;
