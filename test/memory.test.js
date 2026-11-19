/**
 * 记忆层测试（M1–M9）：消重、冲突、损坏拒写、墓碑、预算、提案闭环、并发、迁移。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { parseMemory, renderMemory, memoryHash } from '../memory-store.js';
import { renderAnchors } from '../worklog.js';
import { tempRoot, makePaths, StubAdapter } from './helpers/fixtures.js';

function mk(prefix = 'codex-mem-') {
  const root = tempRoot(prefix);
  const paths = makePaths(root);
  const adapter = new StubAdapter({ root, config: { paths, home: root } });
  return { root, paths, adapter };
}

test('M1 同文本写两次 -> 去重，条目数不变', async () => {
  const { adapter } = mk('codex-m1-');
  const r1 = await adapter.writeSharedMemory('project', '包管理器用 pnpm', { confirmed: true });
  assert.equal(r1.added, 1);
  const r2 = await adapter.writeSharedMemory('project', '包管理器用 pnpm', { confirmed: true });
  assert.equal(r2.duplicated, 1);
  assert.equal(r2.added, 0);
  assert.equal(r2.entries, 1);
});

test('M2 同键不同值 -> 两条并存且都标 conflict', async () => {
  const { adapter } = mk('codex-m2-');
  await adapter.writeSharedMemory('project', 'port=11434', { confirmed: true });
  const r = await adapter.writeSharedMemory('project', 'port=11435', { confirmed: true });
  assert.equal(r.conflicts, 1);
  assert.equal(r.entries, 2);
  const doc = parseMemory(await adapter.readSharedMemory('project'), { scope: 'project' });
  assert.equal(doc.entries.length, 2);
  assert.ok(doc.entries.every((e) => e.status.startsWith('conflict')), JSON.stringify(doc.entries));
});

test('M3 结构损坏 -> 拒写、原文件不变、有隔离副本', async () => {
  const { adapter, paths } = mk('codex-m3-');
  const file = adapter.sharedFile('project');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const bad = '<!--memory {oops} -->\n- 坏行没有 id\n';
  await fsp.writeFile(file, bad, 'utf8');

  await assert.rejects(
    () => adapter.writeSharedMemory('project', '新内容', { confirmed: true }),
    (e) => e.code === 'E_MEMORY_PARSE',
  );
  assert.equal(await fsp.readFile(file, 'utf8'), bad, '坏文件不能被覆盖');
  const q = await fsp.readdir(path.join(paths.stateDir, 'memory-quarantine')).catch(() => []);
  assert.equal(q.length, 1);
});

test('M4 superseded 条目不进入注入', () => {
  const shared = {
    project: renderMemory(
      [
        { id: 'M1', status: 'active', text: '包管理器用 pnpm' },
        { id: 'M2', status: 'superseded by M3', text: '旧结论：用 yarn 更稳' },
      ],
      { scope: 'project', revision: 2 },
    ),
  };
  const out = renderAnchors({
    doc: { items: [], negations: [], meta: {} },
    shared,
    sessionId: 's',
    limits: { maxChars: 4000, memoryChars: 1200 },
  });
  assert.match(out, /包管理器用 pnpm/);
  assert.ok(!out.includes('用 yarn 更稳'), '被取代的记忆不该注入');
});

test('M5 记忆段有独立预算，超了截断但不整段消失', () => {
  const entries = [];
  for (let i = 1; i <= 80; i += 1) {
    entries.push({ id: `M${i}`, status: 'active', text: `偏好${i}: ${'x'.repeat(50)}` });
  }
  const out = renderAnchors({
    doc: { items: [], negations: [], meta: {} },
    shared: { project: renderMemory(entries, { scope: 'project' }) },
    sessionId: 's',
    limits: { maxChars: 4000, memoryChars: 1200 },
  });
  assert.ok(out.length <= 4000, `len=${out.length}`);
  assert.match(out, /共享记忆 · 项目习惯/);
  assert.match(out, /memory truncated/);
});

test('M6 提案队列有生产者也有消费者', async () => {
  const { adapter } = mk('codex-m6-');
  const p = await adapter.proposeSharedMemory('project', '偏好: 中文回复', { reason: 'M6' });
  assert.ok(p.id);
  assert.equal(p.needsConfirmation, true);

  const dup = await adapter.proposeSharedMemory('project', '偏好: 中文回复', {});
  assert.equal(dup.duplicated, true, '同内容不重复入队');

  assert.equal((await adapter.listPendingMemory()).length, 1);
  const acc = await adapter.acceptPendingMemory(p.id);
  assert.equal(acc.added, 1);
  assert.equal((await adapter.listPendingMemory()).length, 0);
  assert.match(await adapter.readSharedMemory('project'), /中文回复/);
});

test('M7 并发写同一 scope -> 锁串行化，两条都留下', async () => {
  const { adapter } = mk('codex-m7-');
  await Promise.all([
    adapter.writeSharedMemory('project', '事实 A：构建用 esbuild', { confirmed: true }),
    adapter.writeSharedMemory('project', '事实 B：测试用 node:test', { confirmed: true }),
  ]);
  const doc = parseMemory(await adapter.readSharedMemory('project'), { scope: 'project' });
  const texts = doc.entries.map((e) => e.text).join('\n');
  assert.match(texts, /esbuild/);
  assert.match(texts, /node:test/);
});

test('M8 旧格式迁移 -> 原文保留为 M1，新条目追加', async () => {
  const { adapter } = mk('codex-m8-');
  const file = adapter.sharedFile('project');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '旧偏好：中文回复\n', 'utf8');

  const r = await adapter.writeSharedMemory('project', 'port=11434', { confirmed: true });
  assert.ok(r.entries >= 2);
  const doc = parseMemory(await adapter.readSharedMemory('project'), { scope: 'project' });
  assert.ok(doc.entries.some((e) => e.text.includes('旧偏好')), '旧内容不能丢');
});

test('M9 长条目挤压时，记忆仍然注入（优先级修复）', () => {
  const items = [];
  for (let i = 1; i <= 25; i += 1) {
    items.push({ id: `L${i}`, status: 'todo', text: `任务 ${i}：${'y'.repeat(200)}` });
  }
  const out = renderAnchors({
    doc: { items, negations: [], meta: {} },
    shared: { project: renderMemory([{ id: 'M1', status: 'active', text: '关键偏好：中文' }], { scope: 'project' }) },
    sessionId: 's',
    limits: { maxChars: 4000, memoryChars: 1200, openItems: 25 },
  });
  assert.ok(out.length <= 4000);
  assert.match(out, /关键偏好：中文/);
});

test('M10 冲突裁决：保留一条，另一条标 superseded', async () => {
  const { adapter } = mk('codex-m10-');
  await adapter.writeSharedMemory('project', 'port=11434', { confirmed: true });
  await adapter.writeSharedMemory('project', 'port=11435', { confirmed: true });
  const doc = parseMemory(await adapter.readSharedMemory('project'), { scope: 'project' });
  const ids = doc.entries.map((e) => e.id);
  const r = await adapter.resolveConflict('project', ids[0], ids[1]);
  assert.equal(r.kept, ids[0]);
  const after = parseMemory(await adapter.readSharedMemory('project'), { scope: 'project' });
  const kept = after.entries.find((e) => e.id === ids[0]);
  const dropped = after.entries.find((e) => e.id === ids[1]);
  assert.equal(kept.status, 'active');
  assert.match(dropped.status, /^superseded by/);
});
