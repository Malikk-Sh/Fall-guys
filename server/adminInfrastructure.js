'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SYSTEMCTL = '/usr/bin/systemctl';
const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_UNITS = Object.freeze([
  ['wobble', 'Wobble Rush', 'wobble.service'],
  ['nginx', 'Nginx', 'nginx.service'],
  ['backupTimer', 'Автоматические backup', 'wobble-backup.timer'],
  ['backupWatchTimer', 'Контроль свежести backup', 'wobble-backup-watch.timer'],
  ['operationsSocket', 'Безопасные операции панели', 'wobble-ops.socket'],
  ['certbotTimer', 'Автообновление HTTPS-сертификата', 'certbot.timer']
]);

function safePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function parseSystemdShow(stdout) {
  const values = {};
  for (const line of String(stdout || '').split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values[line.slice(0, index)] = line.slice(index + 1);
  }
  const activeState = values.ActiveState || 'unknown';
  const subState = values.SubState || 'unknown';
  const unitFileState = values.UnitFileState || 'unknown';
  return {
    found: activeState !== 'unknown' || subState !== 'unknown' || unitFileState !== 'unknown',
    active: activeState === 'active',
    activeState,
    subState,
    unitFileState
  };
}

async function readSystemdUnit(unit) {
  try {
    const { stdout } = await execFileAsync(
      SYSTEMCTL,
      ['show', unit, '--property=ActiveState', '--property=SubState', '--property=UnitFileState'],
      { timeout: 2000, maxBuffer: 16 * 1024, windowsHide: true }
    );
    return parseSystemdShow(stdout);
  } catch {
    return {
      found: false,
      active: false,
      activeState: 'unknown',
      subState: 'unknown',
      unitFileState: 'unknown'
    };
  }
}

function tcpProbe({ host = '127.0.0.1', port, timeoutMs = 1200 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = reachable => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ reachable, latencyMs: reachable ? Math.max(0, Date.now() - started) : null });
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function tlsProbe({ host = '127.0.0.1', port = 443, servername, timeoutMs = 2500, now = Date.now() } = {}) {
  return new Promise(resolve => {
    if (!servername) {
      resolve({ reachable: false, trusted: false, reason: 'public-domain-unavailable' });
      return;
    }
    const started = Date.now();
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: false
    });
    let done = false;
    const finish = payload => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(payload);
    };
    socket.setTimeout(timeoutMs, () => finish({ reachable: false, trusted: false, reason: 'timeout' }));
    socket.once('error', () => finish({ reachable: false, trusted: false, reason: 'tls-error' }));
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      const validFromMs = Date.parse(peer?.valid_from || '');
      const validToMs = Date.parse(peer?.valid_to || '');
      const daysRemaining = Number.isFinite(validToMs) ? Math.floor((validToMs - now) / DAY_MS) : null;
      finish({
        reachable: true,
        trusted: Boolean(socket.authorized),
        authorizationError: socket.authorized
          ? null
          : String(socket.authorizationError || 'untrusted').slice(0, 120),
        latencyMs: Math.max(0, Date.now() - started),
        validFrom: Number.isFinite(validFromMs) ? new Date(validFromMs).toISOString() : null,
        validTo: Number.isFinite(validToMs) ? new Date(validToMs).toISOString() : null,
        daysRemaining,
        expired: Number.isFinite(validToMs) ? validToMs <= now : null
      });
    });
  });
}

function publicTarget(env) {
  for (const raw of String(env.ALLOWED_ORIGINS || '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname) continue;
      return { origin: url.origin, hostname: url.hostname, port: safePositiveInt(url.port, 443) };
    } catch {
      // Ignore an invalid origin; normal server startup/origin validation owns that configuration.
    }
  }
  return { origin: null, hostname: null, port: 443 };
}

function diskStatus(databaseFile, statfs = fs.statfsSync) {
  try {
    const target =
      databaseFile && databaseFile !== ':memory:' ? path.dirname(path.resolve(databaseFile)) : '/';
    const info = statfs(target);
    const blockSize = Number(info.bsize || info.frsize || 0);
    const totalBytes = blockSize * Number(info.blocks || 0);
    const availableBytes = blockSize * Number(info.bavail || 0);
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    return {
      available: totalBytes > 0,
      target,
      totalBytes,
      availableBytes,
      usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null
    };
  } catch {
    return {
      available: false,
      target: null,
      totalBytes: null,
      availableBytes: null,
      usedBytes: null,
      usedPercent: null
    };
  }
}

class AdminInfrastructure {
  constructor({
    health,
    env = process.env,
    systemdUnit = readSystemdUnit,
    probeTcp = tcpProbe,
    probeTls = tlsProbe,
    statfs = fs.statfsSync,
    system = os
  } = {}) {
    if (typeof health !== 'function') throw new Error('AdminInfrastructure requires health()');
    this.health = health;
    this.env = env;
    this.systemdUnit = systemdUnit;
    this.probeTcp = probeTcp;
    this.probeTls = probeTls;
    this.statfs = statfs;
    this.system = system;
  }

  async snapshot({ now = Date.now() } = {}) {
    const gameHealth = this.health();
    const target = publicTarget(this.env);
    const nodePort = safePositiveInt(this.env.PORT, 3000);
    const databaseFile = this.env.LEADERBOARD_DB || '/var/lib/wobble/leaderboard.db';

    const [unitEntries, http80, publicHttpsTcp, nodeTcp, https] = await Promise.all([
      Promise.all(
        FIXED_UNITS.map(async ([id, label, unit]) => [
          id,
          { id, label, unit, ...(await this.systemdUnit(unit)) }
        ])
      ),
      this.probeTcp({ host: '127.0.0.1', port: 80 }),
      this.probeTcp({ host: '127.0.0.1', port: target.port || 443 }),
      this.probeTcp({ host: '127.0.0.1', port: nodePort }),
      this.probeTls({ host: '127.0.0.1', port: target.port || 443, servername: target.hostname, now })
    ]);

    const totalMemory = Number(this.system.totalmem());
    const freeMemory = Number(this.system.freemem());
    const usedMemory = Math.max(0, totalMemory - freeMemory);
    const loadAverage = this.system.loadavg().map(value => Math.round(Number(value) * 100) / 100);

    return {
      generatedAt: new Date(now).toISOString(),
      publicTarget: target,
      services: Object.fromEntries(unitEntries),
      resources: {
        hostUptimeSeconds: Math.max(0, Math.round(Number(this.system.uptime()))),
        memory: {
          totalBytes: totalMemory,
          freeBytes: freeMemory,
          usedBytes: usedMemory,
          usedPercent: totalMemory > 0 ? Math.round((usedMemory / totalMemory) * 1000) / 10 : null
        },
        disk: diskStatus(databaseFile, this.statfs),
        loadAverage
      },
      network: {
        http80,
        https443: publicHttpsTcp,
        nodeLocal: { ...nodeTcp, port: nodePort, host: '127.0.0.1' }
      },
      https,
      backup: gameHealth?.backup || null,
      game: {
        ok: Boolean(gameHealth?.ok),
        version: gameHealth?.version || null,
        commit: gameHealth?.commit || null,
        release: gameHealth?.release || null,
        uptimeSeconds: Number(gameHealth?.uptime || 0),
        load: gameHealth?.load || null,
        capacity: gameHealth?.capacity || null
      }
    };
  }
}

module.exports = {
  AdminInfrastructure,
  FIXED_UNITS,
  parseSystemdShow,
  publicTarget,
  diskStatus,
  readSystemdUnit,
  tcpProbe,
  tlsProbe
};
