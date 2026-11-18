/**
 * native-memory.js — 读取 Codex 宿主的原生记忆目录，只读。
 *
 * 归属约定（已拍板）：
 *  - 写入永远走本插件的共享层（确认机制），不写宿主原生存储；
 *  - 原生层只做只读导入，失败/缺失一律视为「没有」，不阻塞注入。
 *
 * 目录来自宿主用户数据目录（本机取证：~/.codex/memories 存在；
 * feature flag `memories` 默认为 false，因此这里按「有就读」处理）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

const TEXT_EXT = /\.(md|markdown|txt)$/i;

async function walk(dir, depth, files) {
  if (depth > 2) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, depth + 1, files);
    else if (TEXT_EXT.test(e.name)) files.push(p);
  }
}

export async function readNativeMemory({ home = process.env.HOME || process.env.USERPROFILE, maxChars = 1200, maxFiles = 20 } = {}) {
  const empty = { available: false, files: 0, chars: 0, text: '' };
  if (!home) return empty;

  const dir = path.join(home, '.codex', 'memories');
  const files = [];
  await walk(dir, 0, files);
  if (!files.length) return empty;

  files.sort();
  const parts = [];
  for (const file of files.slice(0, maxFiles)) {
    let text = '';
    try {
      text = (await fsp.readFile(file, 'utf8')).trim();
    } catch {
      continue;
    }
    if (text) parts.push(`### ${path.basename(file)}\n${text}`);
  }
  if (!parts.length) return empty;

  let out = parts.join('\n\n');
  if (out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
  return { available: true, files: parts.length, chars: out.length, text: out, dir };
}
