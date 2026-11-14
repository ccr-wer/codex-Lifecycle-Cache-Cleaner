/**
 * 假引擎进程：分配 256MB 常驻内存模拟权重/KV，收到 unload 才释放。
 * 只用来证明「测量链路 + 卸载语义」能观测到真实 RSS 回落。
 */
const HOLD_MB = 256;
const CHUNK = 4 * 1024 * 1024;

const hold = [];
for (let i = 0; i < HOLD_MB / 4; i += 1) {
  const buf = Buffer.alloc(CHUNK, 1);
  for (let p = 0; p < buf.length; p += 4096) buf[p] = 2; // 触碰每一页，确保计入 RSS
  hold.push(buf);
}

process.send?.({ ready: true, pid: process.pid, bytes: hold.length * CHUNK });

process.on('message', (msg) => {
  if (msg !== 'unload') return;
  // 模拟引擎卸载：释放常驻块，等 GC 把页还给 OS
  hold.length = 0;
  global.gc?.();
  setTimeout(() => {
    global.gc?.();
    process.send?.({ freed: true, rss: process.memoryUsage().rss });
  }, 200);
});

// 保持存活
setInterval(() => {}, 1000);
