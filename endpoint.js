/**
 * endpoint.js — 引擎 endpoint 的身份归一。
 *
 * 为什么需要：`engine-gate` 用 endpoint 字符串做归属登记与匹配。
 * 同一个引擎可能被写成 `http://localhost:11434`、`http://127.0.0.1:11434/`、
 * `HTTP://LOCALHOST:11434`，不归一会导致「自己登记的引擎被判 foreign」。
 *
 * 只做无副作用的字符串归一（不做 DNS 解析、不联网）：
 *  - scheme / host 小写
 *  - localhost -> 127.0.0.1（回环别名）
 *  - 去掉协议默认端口
 *  - 去掉末尾斜杠
 */
const DEFAULT_PORT = Object.freeze({ http: '80', https: '443', ws: '80', wss: '443' });

export function canonicalEndpoint(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return s.replace(/\/+$/, '');
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  let host = u.hostname.toLowerCase();
  if (host === 'localhost') host = '127.0.0.1';
  const port = u.port && u.port !== DEFAULT_PORT[scheme] ? `:${u.port}` : '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${scheme}://${host}${port}${path}`;
}
