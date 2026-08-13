'use strict';

const fs = require('fs');
const os = require('os');
const { backupHealthStatus } = require('./backupStatus');
const { readSystemdUnit, tcpProbe, tlsProbe, publicTarget, diskStatus } = require('./adminInfrastructure');

const CONTROL_UNITS = Object.freeze([
  ['wobble', 'Wobble Rush', 'wobble.service'],
  ['control', 'Wobble Control', 'wobble-control.service'],
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

class ControlPlaneInfrastructure {
  constructor({
    gameClient,
    env = process.env,
    systemdUnit = readSystemdUnit,
    probeTcp = tcpProbe,
    probeTls = tlsProbe,
    statfs = fs.statfsSync,
    system = os
  } = {}) {
    if (!gameClient || typeof gameClient.status !== 'function') {
      throw new Error('ControlPlaneInfrastructure requires gameClient.status()');
    }
    this.gameClient = gameClient;
    this.env = env;
    this.systemdUnit = systemdUnit;
    this.probeTcp = probeTcp;
    this.probeTls = probeTls;
    this.statfs = statfs;
    this.system = system;
  }

  async snapshot({ now = Date.now() } = {}) {
    const target = publicTarget(this.env);
    const gamePort = safePositiveInt(this.env.PORT, 3000);
    const controlPort = safePositiveInt(this.env.CONTROL_PORT, 3001);
    const databaseFile = this.env.LEADERBOARD_DB || '/var/lib/wobble/leaderboard.db';

    const [unitEntries, http80, publicHttpsTcp, gameTcp, controlTcp, https, gameHealth] = await Promise.all([
      Promise.all(
        CONTROL_UNITS.map(async ([id, label, unit]) => [
          id,
          { id, label, unit, ...(await this.systemdUnit(unit)) }
        ])
      ),
      this.probeTcp({ host: '127.0.0.1', port: 80 }),
      this.probeTcp({ host: '127.0.0.1', port: target.port || 443 }),
      this.probeTcp({ host: '127.0.0.1', port: gamePort }),
      this.probeTcp({ host: '127.0.0.1', port: controlPort }),
      this.probeTls({ host: '127.0.0.1', port: target.port || 443, servername: target.hostname, now }),
      this.gameClient.status().catch(() => null)
    ]);

    const totalMemory = Number(this.system.totalmem());
    const freeMemory = Number(this.system.freemem());
    const usedMemory = Math.max(0, totalMemory - freeMemory);
    const loadAverage = this.system.loadavg().map(value => Math.round(Number(value) * 100) / 100);
    let backup = null;
    try {
      backup = backupHealthStatus({ databaseFile, now });
    } catch {
      backup = null;
    }

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
        nodeLocal: { ...gameTcp, port: gamePort, host: '127.0.0.1' },
        controlLocal: { ...controlTcp, port: controlPort, host: '127.0.0.1' }
      },
      https,
      backup,
      game: {
        reachable: Boolean(gameHealth?.reachable),
        ok: Boolean(gameHealth?.ready),
        ready: Boolean(gameHealth?.ready),
        version: gameHealth?.version || null,
        commit: gameHealth?.commit || null,
        release: gameHealth?.release || null,
        uptimeSeconds: Number(gameHealth?.uptime || 0),
        load: gameHealth?.load || null,
        capacity: gameHealth?.capacity || null
      },
      control: {
        ok: true,
        uptimeSeconds: Math.max(0, Math.round(process.uptime())),
        port: controlPort
      }
    };
  }
}

module.exports = { ControlPlaneInfrastructure, CONTROL_UNITS, safePositiveInt };
