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

// A real server intentionally limits concurrent sockets and room operations per source IP. A
// localhost load generator would otherwise hit that abuse protection before it reached the process
// capacity we actually want to measure. Linux treats the whole 127/8 range as loopback, so local
// CI can give each simulated room its own source address without weakening production limits.
// External targets are never spoofed/sharded here: they keep the machine's real source address.
export function loopbackSourceAddress(wsUrl, roomIndex) {
  const url = new URL(wsUrl);
  if (url.hostname !== '127.0.0.1') return null;
  const index = Number.isSafeInteger(roomIndex) && roomIndex >= 0 ? roomIndex : 0;
  return `127.0.0.${2 + (index % 253)}`;
}

export function loadStateMessage({ matchId, sequence, z, vz = -7 }) {
  return {
    type: 'state',
    matchId,
    sequence,
    state: { x: 0, y: 1.2, z, ry: vz > 0 ? Math.PI : 0, vx: 0, vz, state: 'ground' }
  };
}
