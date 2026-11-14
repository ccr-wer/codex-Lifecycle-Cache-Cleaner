/**
 * rss.js — 用 OS 真实内存指标验证「引擎真的卸载了」。
 *
 * 绝不用 top：top 的 RSS 在有 compressor / shared pages 时既不准，
 * 对 allocator 归还也迟钝，是「假释放」的主要来源。
 *
 *   linux  : /proc/<pid>/status  VmRSS
 *   darwin : vmmap -summary -> Physical footprint（退回 footprint -p）
 *   win32  : (Get-Process -Id <pid>).WorkingSet64（Windows 无 footprint 工具）
 */
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, out: '', err: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: '', err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err });
    });
  });
}

function toBytes(num, unit) {
  const n = Number(num);
  const u = String(unit || 'B').toUpperCase();
  if (u.startsWith('K')) return n * 1024;
  if (u.startsWith('M')) return n * 1024 ** 2;
  if (u.startsWith('G')) return n * 1024 ** 3;
  return n;
}

export async function readRssBytes(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return null;

  if (process.platform === 'linux') {
    try {
      const status = await fsp.readFile(`/proc/${id}/status`, 'utf8');
      const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      if (m) return Number(m[1]) * 1024;
    } catch {
      return null;
    }
    return null;
  }

  if (process.platform === 'darwin') {
    const vmmap = await run('vmmap', ['-summary', String(id)]);
    const m1 = /Physical footprint:\s+([\d.]+)([KMG])/i.exec(vmmap.out || '');
    if (vmmap.ok && m1) return toBytes(m1[1], m1[2]);
    const fp = await run('footprint', ['-p', String(id)]);
    const m2 = /phys_footprint:\s+([\d.]+)\s*([KMG]?B)/i.exec(fp.out || '');
    if (fp.ok && m2) return toBytes(m2[1], m2[2]);
    return null;
  }

  if (process.platform === 'win32') {
    const r = await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p=Get-Process -Id ${id} -ErrorAction SilentlyContinue; if($p){$p.WorkingSet64}else{0}`,
    ]);
    if (!r.ok) return null;
    const n = Number(String(r.out).trim());
    if (!Number.isFinite(n)) return null;
    return n === 0 ? null : n;
  }

  return null;
}

/**
 * 轮询等真实回落。Ollama 的 keep_alive:0 返回 200 ≠ 内存已释放，
 * 必须等（这是最容易翻车的地方）。
 */
export async function waitForRssDrop({
  pid,
  before,
  ratio = 0.2,
  minDropBytes = 64 * 1024 * 1024,
  timeoutMs = 15000,
  pollMs = 300,
} = {}) {
  if (!before || !Number.isFinite(before)) return { ok: false, reason: 'no_baseline', after: null };
  const required = Math.max(before * ratio, Math.min(minDropBytes, before * 0.9));
  const deadline = Date.now() + timeoutMs;
  let last = before;
  let samples = 0;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const v = await readRssBytes(pid);
    samples += 1;
    if (v === null) {
      return { ok: true, reason: 'process_gone', after: 0, dropped: before, samples, required };
    }
    last = v;
    if (before - v >= required) {
      return { ok: true, reason: 'dropped', after: v, dropped: before - v, samples, required };
    }
  }
  return { ok: false, reason: 'timeout', after: last, dropped: Math.max(0, before - last), samples, required };
}
