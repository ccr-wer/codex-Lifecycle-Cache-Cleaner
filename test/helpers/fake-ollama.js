/**
 * 假 Ollama：只实现插件真正用到的两个路由。
 *   POST /api/generate  keep_alive:0 -> 卸载（可配置失败 / 不卸载）
 *   GET  /api/ps        -> 常驻模型列表
 */
import http from 'node:http';

export async function startFakeOllama({
  model = 'fake:7b',
  stubborn = false,
  failWith = null,
  onUnload = null,
  unloadLatencyMs = 0,
} = {}) {
  const state = { loaded: true, unloadCalls: 0, psCalls: 0, errors: [] };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let body = {};
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        body = {};
      }

      if (req.method === 'GET' && req.url === '/api/ps') {
        state.psCalls += 1;
        const models = state.loaded ? [{ name: model, model, size: 123456789 }] : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/generate') {
        if (body.keep_alive === 0) {
          state.unloadCalls += 1;
          if (failWith) {
            res.writeHead(failWith, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'stub failure' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ model, done: true, done_reason: 'unload' }));
          if (!stubborn && onUnload) {
            setTimeout(() => {
              Promise.resolve(onUnload()).catch((e) => state.errors.push(String(e)));
            }, unloadLatencyMs);
          }
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model, response: '{}', done: true }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    setLoaded(v) {
      state.loaded = Boolean(v);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
