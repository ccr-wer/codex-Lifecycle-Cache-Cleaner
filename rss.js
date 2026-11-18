/**
 * rss.js — 用 OS 真实内存指标验证「引擎真的卸载了」。
 *
 * 绝不用 top：top 的 RSS 在有 compressor / shared pages 时既不准，
 * 对 allocator 归还也迟钝，是「假释放」的主要来源。
 *
 * 四种采样口径（白名单，不在名单一律拒绝）：
 *   FOOTPRINT : darwin  vmmap -summary 的 Physical footprint（退回 footprint -p）
 *   NVIDIA    : darwin/linux/win32  nvidia-smi --query-compute-apps（显存占用）
 *   PROC_RSS  : linux   /proc/<pid>/smaps_rollup 的 Pss（退回 status 的 VmRSS）
 *   WIN_RSS   : win32   Get-Process WorkingSet64（工作集）
 *
 * 三条硬规则：
 *  1) 平台与口径不匹配 -> 抛 E_SAMPLER_PLATFORM，不许静默降级；
 *  2) 进程已退出 -> bytes=0 且 gone=true（占用已释放），不是错误；
 *  3) 采样失败（权限/解析/命令缺失）-> ok=false，调用方必须报 unverifiable，
 *     不许当成「进程已退出」蒙混过关。
 */
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SAMPLER_KIND = Object.freeze({
  FOOTPRINT: 'footprint',
  NVIDIA: 'nvidia',
  PROC_RSS: 'proc_rss',
  WIN_RSS: 'win_rss',
});

export const SAMPLER_KINDS = Object.freeze(Object.values(SAMPLER_KIND));

/** 每种口径允许的平台；nvidia 在三大平台都可能存在。 */
const KIND_PLATFORM = Object.freeze({
  [SAMPLER_KIND.FOOTPRINT]: 'darwin',
  [SAMPLER_KIND.NVIDIA]: null,
  [SAMPLER_KIND.PROC_RSS]: 'linux',
  [SAMPLER_KIND.WIN_RSS]: 'win32',
});

function samplerError(code, message, detail = {}) {
  const e = new Error(`${code}: ${message}`);
  e.code = code;
  e.detail = detail;
  return e;
}

/** 纯函数选型：返回 null 表示这个平台没有可验证的口径 -> unverifiable。 */
export function pickSamplerKind({ platform = process.platform, hasNvidia = false } = {}) {
  if (hasNvidia) return SAMPLER_KIND.NVIDIA;
  if (platform === 'darwin') return SAMPLER_KIND.FOOTPRINT;
  if (platform === 'linux') return SAMPLER_KIND.PROC_RSS;
  if (platform === 'win32') return SAMPLER_KIND.WIN_RSS;
  return null;
}

function defaultExec(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, out: '', err: e.message, code: e.code || 'E_SPAWN' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, out: '', err: 'timeout', code: 'E_TIMEOUT' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: '', err: e.message, code: e.code || 'E_SPAWN' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err, code: code === 0 ? null : `E_EXIT_${code}` });
    });
  });
}

const defaultReadText = async (file) => {
  try {
    return { ok: true, text: await fsp.readFile(file, 'utf8') };
  } catch (e) {
    return { ok: false, text: '', code: e.code || 'E_READ' };
  }
};

function toBytes(num, unit) {
  const n = Number(String(num).replace(/,/g, ''));
  const u = String(unit || 'B').toUpperCase();
  if (u.startsWith('K')) return n * 1024;
  if (u.startsWith('M')) return n * 1024 ** 2;
  if (u.startsWith('G')) return n * 1024 ** 3;
  return n;
}

/* ------------------------------------------------------------ 解析器（可单测） */

/** /proc/<pid>/smaps_rollup 里的 Pss（共享页按比例摊分，比 VmRSS 更接近真实占用）。 */
export function parseProcPss(text) {
  const m = /^Pss:\s+(\d+)\s*kB/m.exec(String(text || ''));
  return m ? Number(m[1]) * 1024 : null;
}

/** /proc/<pid>/status 里的 VmRSS（Pss 不可用时的回退口径）。 */
export function parseProcStatus(text) {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(String(text || ''));
  return m ? Number(m[1]) * 1024 : null;
}

/** vmmap -summary 的 "Physical footprint: 1.2G"。 */
export function parseVmmapSummary(text) {
  const m = /Physical footprint:\s+([\d.]+)([KMG])/i.exec(String(text || ''));
  return m ? toBytes(m[1], m[2]) : null;
}

/** footprint -p 的 "phys_footprint: 1234567 B"。 */
export function parseFootprint(text) {
  const m = /phys_footprint:\s+([\d.]+)\s*([KMG]?B)/i.exec(String(text || ''));
  return m ? toBytes(m[1], m[2]) : null;
}

/**
 * Windows 采样输出解析。
 * 兼容三种形态：纯字节 "123456789"、带千分位 "1,234,567 K"、带逗号的 tasklist "1,234,567 K"。
 * 千分位必须先去逗号，否则 Number() 会静默截断成 1。
 */
export function parseWinRss(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = /^([\d,]+(?:\.\d+)?)\s*([KMG])?B?$/i.exec(raw.split(/\r?\n/).pop().trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return toBytes(n, m[2] || 'B');
}

/** nvidia-smi --query-compute-apps=pid,used_memory 的解析：按 pid 取显存（MiB）。 */
export function parseNvidiaSmi(text, pid) {
  const want = Number(pid);
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.split(',').map((s) => s.trim());
    if (cols.length < 2) continue;
    if (Number(cols[0]) !== want) continue;
    const mib = Number(cols[1].replace(/[^\d.]/g, ''));
    if (!Number.isFinite(mib)) return null;
    return Math.round(mib * 1024 * 1024);
  }
  return null;
}

/* ------------------------------------------------------------------ 采样器 */

export function makeSampler({
  kind,
  pid,
  platform = process.platform,
  exec = defaultExec,
  readText = defaultReadText,
} = {}) {
  if (!kind || !SAMPLER_KINDS.includes(kind)) {
    throw samplerError('E_SAMPLER_UNKNOWN', `未知采样口径: ${kind}`, { kind });
  }
  const expect = KIND_PLATFORM[kind];
  if (expect && expect !== platform) {
    throw samplerError('E_SAMPLER_PLATFORM', `${kind} 不支持平台 ${platform}`, { kind, platform });
  }
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) {
    throw samplerError('E_SAMPLER_PID', `非法 pid: ${pid}`, { pid });
  }

  const gone = { ok: true, bytes: 0, gone: true, kind };

  return async function sample() {
    if (kind === SAMPLER_KIND.PROC_RSS) {
      const pss = await readText(`/proc/${id}/smaps_rollup`);
      if (pss.ok) {
        const bytes = parseProcPss(pss.text);
        if (bytes !== null) return { ok: true, bytes, kind };
      } else if (pss.code === 'ENOENT') {
        return gone;
      }
      const status = await readText(`/proc/${id}/status`);
      if (!status.ok) {
        if (status.code === 'ENOENT') return gone;
        return { ok: false, code: status.code || 'E_SAMPLE_READ', kind };
      }
      const bytes = parseProcStatus(status.text);
      if (bytes === null) return { ok: false, code: 'E_SAMPLE_PARSE', kind };
      return { ok: true, bytes, kind };
    }

    if (kind === SAMPLER_KIND.WIN_RSS) {
      const r = await exec('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=Get-Process -Id ${id} -ErrorAction SilentlyContinue; if($p){$p.WorkingSet64}`,
      ]);
      if (!r.ok) return { ok: false, code: r.code || 'E_SAMPLE_EXEC', kind };
      const text = String(r.out || '').trim();
      if (!text) return gone;
      const bytes = parseWinRss(text);
      if (bytes === null) return { ok: false, code: 'E_SAMPLE_PARSE', kind };
      return { ok: true, bytes, kind };
    }

    if (kind === SAMPLER_KIND.FOOTPRINT) {
      const vmmap = await exec('vmmap', ['-summary', String(id)]);
      if (vmmap.ok) {
        const bytes = parseVmmapSummary(vmmap.out);
        if (bytes !== null) return { ok: true, bytes, kind };
      }
      const fp = await exec('footprint', ['-p', String(id)]);
      if (fp.ok) {
        const bytes = parseFootprint(fp.out);
        if (bytes !== null) return { ok: true, bytes, kind };
      }
      const errText = `${vmmap.err || ''} ${fp.err || ''}`;
      if (/No such process|invalid pid|not found/i.test(errText)) return gone;
      return { ok: false, code: 'E_SAMPLE_EXEC', kind };
    }

    // NVIDIA
    const r = await exec('nvidia-smi', [
      '--query-compute-apps=pid,used_memory',
      '--format=csv,noheader,nounits',
    ]);
    if (!r.ok) return { ok: false, code: r.code || 'E_SAMPLE_EXEC', kind };
    const bytes = parseNvidiaSmi(r.out, id);
    if (bytes === null) return gone; // 该 pid 不在 GPU 计算进程表里 = 显存已释放
    return { ok: true, bytes, kind };
  };
}

/** 详细采样：{ok:true,bytes} | {ok:true,bytes:0,gone:true} | {ok:false,code} */
export async function sampleMemory(pid, { platform = process.platform, kind, hasNvidia = false, exec, readText } = {}) {
  const chosen = kind || pickSamplerKind({ platform, hasNvidia });
  if (!chosen) return { ok: false, code: 'E_NO_SAMPLER' };
  let sampler;
  try {
    sampler = makeSampler({ kind: chosen, pid, platform, exec, readText });
  } catch (e) {
    return { ok: false, code: e.code || 'E_SAMPLER_PLATFORM' };
  }
  return sampler();
}

/**
 * 兼容旧调用点：只返回字节数或 null。
 * 新代码请用 sampleMemory()，才能区分「进程已退出」和「采样失败」。
 */
export async function readRssBytes(pid, opts = {}) {
  const r = await sampleMemory(pid, opts);
  if (!r.ok) return null;
  return r.gone ? 0 : r.bytes;
}

/**
 * 轮询等真实回落。Ollama 的 keep_alive:0 返回 200 ≠ 内存已释放。
 *
 * 关键区别（fail-closed）：
 *  - gone      -> 占用已释放，ok
 *  - 采样失败  -> unverifiable，绝不当成释放
 */
export async function waitForRssDrop({
  pid,
  before,
  ratio = 0.2,
  minDropBytes = 64 * 1024 * 1024,
  timeoutMs = 15000,
  pollMs = 300,
  sample,
  kind,
  platform = process.platform,
} = {}) {
  if (!before || !Number.isFinite(before)) return { ok: false, reason: 'no_baseline', after: null };
  const required = Math.max(before * ratio, Math.min(minDropBytes, before * 0.9));
  const deadline = Date.now() + timeoutMs;
  let last = before;
  let samples = 0;

  let sampler = sample;
  if (!sampler) {
    try {
      sampler = makeSampler({ kind: kind || pickSamplerKind({ platform }), pid, platform });
    } catch (e) {
      return { ok: false, reason: 'unverifiable', code: e.code, after: null, samples: 0, required };
    }
  }

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const r = await sampler();
    samples += 1;
    if (!r || r.ok !== true) {
      return { ok: false, reason: 'unverifiable', code: (r && r.code) || 'E_SAMPLE_FAILED', after: last, samples, required };
    }
    if (r.gone) {
      return { ok: true, reason: 'process_gone', after: 0, dropped: before, samples, required };
    }
    last = r.bytes;
    if (before - r.bytes >= required) {
      return { ok: true, reason: 'dropped', after: r.bytes, dropped: before - r.bytes, samples, required };
    }
  }
  return { ok: false, reason: 'timeout', after: last, dropped: Math.max(0, before - last), samples, required };
}
