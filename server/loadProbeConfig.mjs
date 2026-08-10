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

export function loadStateMessage({ matchId, sequence, z, vz = -7 }) {
  return {
    type: 'state',
    matchId,
    sequence,
    state: { x: 0, y: 1.2, z, ry: vz > 0 ? Math.PI : 0, vx: 0, vz, state: 'ground' }
  };
}
