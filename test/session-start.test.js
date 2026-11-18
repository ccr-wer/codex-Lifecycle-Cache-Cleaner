/**
 * SessionStart 注入通道（A 方案）+ 原生记忆只读导入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CodexCleaner } from '../codex-cleaner.js';
import { toWireOutput } from '../hooks/hook-runner.js';
import { readNativeMemory } from '../native-memory.js';
import { tempRoot, makePaths, writeTranscript, SAMPLE_TURNS, StubAdapter } from './helpers/fixtures.js';

test('SessionStart 只输出 additionalContext，不输出 systemMessage', async () => {
  const root = tempRoot('codex-ss-');
  const paths = makePaths(root);
  const transcript = writeTranscript(path.join(root, 'rollout.jsonl'), SAMPLE_TURNS);

  const memDir = path.join(root, '.codex', 'memories');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'prefs.md'), '用户偏好：中文回复，先给结论', 'utf8');

  const adapter = new StubAdapter({ root, config: { paths, home: root } });
  const cleaner = new CodexCleaner({ adapter, paths, config: { engine: { owned: true } } });

  const out = await cleaner.onSessionStart({
    session_id: 'ss',
    transcript_path: transcript,
    cwd: root,
    source: 'startup',
  });

  assert.equal(out.status, 'ok');
  assert.equal(typeof out.additionalContext, 'string');
  assert.ok(out.additionalContext.length > 0);
  assert.equal(out.systemMessage, undefined, 'A 方案下 SessionStart 不再输出 systemMessage');
  assert.match(out.additionalContext, /宿主原生记忆/);
  assert.match(out.additionalContext, /中文回复/);

  const wire = toWireOutput('session-start', out);
  assert.equal(wire.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(wire.hookSpecificOutput.additionalContext, out.additionalContext);
  assert.equal(wire.systemMessage, undefined);
});

test('非 SessionStart 事件仍用 systemMessage 传给用户', () => {
  const wire = toWireOutput('session-end', { status: 'busy', systemMessage: '处理中' });
  assert.equal(wire.systemMessage, '处理中');
  assert.equal(wire.hookSpecificOutput, undefined);
});

test('native memory：只读、截断、缺失不报错', async () => {
  const root = tempRoot('codex-native-');
  const missing = await readNativeMemory({ home: path.join(root, 'nope') });
  assert.equal(missing.available, false);
  assert.equal(missing.text, '');

  const dir = path.join(root, '.codex', 'memories');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), 'AAAA'.repeat(50), 'utf8');

  const r = await readNativeMemory({ home: root, maxChars: 40 });
  assert.equal(r.available, true);
  assert.ok(r.text.length <= 40, `len=${r.text.length}`);
});
