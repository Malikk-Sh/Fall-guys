export function httpBaseFromWebSocket(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.origin;
}

export function loadTargets(env = process.env) {
  const wsUrl = env.WOBBLE_WS_URL || env.WOBBLE_URL || 'ws://127.0.0.1:3000/ws';
  const httpUrl = env.WOBBLE_HTTP_URL || httpBaseFromWebSocket(wsUrl);
  return {
    wsUrl,
    httpUrl: String(httpUrl).replace(/\/$/, ''),
    serverPid: String(env.WOBBLE_SERVER_PID || '').trim() || null
  };
}
