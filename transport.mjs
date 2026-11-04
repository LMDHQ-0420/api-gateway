import http from 'node:http';
import https from 'node:https';

export function createUpstreamAgents({ proxyUrl = '', keepAliveMs = 60_000 } = {}) {
  if (!Number.isSafeInteger(keepAliveMs) || keepAliveMs <= 0) throw new Error('连接复用时间必须是正整数');
  if (proxyUrl) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!((major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major > 24)) {
      throw new Error('显式代理需要 Node.js 22.21+ 或 24.5+');
    }
    const proxy = new URL(proxyUrl);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password ||
        proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('UPSTREAM_PROXY_URL 必须是无认证信息的 HTTP(S) 代理地址');
  }
  // Use an explicit per-gateway proxy configuration, without changing global agents
  // or the proxy/network settings used by other projects on this machine.
  const proxyEnv = proxyUrl ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } : {};
  const options = { keepAlive: true, timeout: keepAliveMs, maxFreeSockets: 64,
    maxSockets: Infinity, scheduling: 'lifo', proxyEnv };
  return { http: new http.Agent(options), https: new https.Agent({ ...options, maxCachedSessions: 256 }) };
}
