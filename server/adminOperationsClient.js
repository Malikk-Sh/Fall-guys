'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');

const DEFAULT_SOCKET_PATH = '/run/wobble-ops.sock';
const DEFAULT_JOURNAL_PATH = '/var/lib/wobble-ops/operations.json';
const MAINTENANCE_FLAG = '/run/wobble-ops/maintenance';
const MAX_RESPONSE_BYTES = 16 * 1024;
const OPERATION_STATES = new Set(['queued', 'running', 'drain', 'verifying', 'succeeded', 'failed']);
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed']);

const OPERATION_DEFINITIONS = Object.freeze({
  'backup.create': Object.freeze({
    id: 'backup.create',
    title: 'Создать резервную копию',
    description:
      'Создаёт новую проверенную копию базы данных игроков. Игра продолжает работать во время операции.',
    impact: 'Игроков не отключает. Может кратко увеличить нагрузку на диск.',
    tone: 'safe'
  }),
  'backup.verify': Object.freeze({
    id: 'backup.verify',
    title: 'Проверить последнюю копию',
    description:
      'Повторно проверяет целостность последней локальной резервной копии и совместимость её схемы.',
    impact: 'Ничего не изменяет в базе игроков и не отключает игру.',
    tone: 'safe'
  }),
  'smoke.run': Object.freeze({
    id: 'smoke.run',
    title: 'Проверить работу Wobble',
    description:
      'Запускает штатную smoke-проверку: HTTP health, главную страницу, WebSocket и свежесть backup.',
    impact: 'Ничего не перезапускает. Создаёт только короткое тестовое WebSocket-подключение.',
    tone: 'safe'
  }),
  'maintenance.enable': Object.freeze({
    id: 'maintenance.enable',
    title: 'Включить режим обслуживания',
    description:
      'Закрывает вход новым WebSocket-подключениям, пока уже подключённые игроки продолжают текущие сессии.',
    impact:
      'Новые онлайн-подключения временно недоступны. Сайт, админ-панель, health и уже открытые WebSocket не обрываются.',
    tone: 'safe'
  }),
  'maintenance.disable': Object.freeze({
    id: 'maintenance.disable',
    title: 'Выключить режим обслуживания',
    description: 'Снова разрешает новые WebSocket-подключения после завершения обслуживания.',
    impact: 'Возвращает обычный онлайн-доступ. Уже работающие подключения не перезапускаются.',
    tone: 'safe'
  }),
  'nginx.reload': Object.freeze({
    id: 'nginx.reload',
    title: 'Безопасно перечитать Nginx',
    description:
      'Сначала проверяет всю конфигурацию командой nginx -t и только после успешной проверки выполняет reload.',
    impact:
      'Не перезапускает Wobble, не меняет конфигурацию и не трогает Xray/VPN. Активные соединения Nginx сохраняются.',
    tone: 'safe'
  }),
  'wobble.start': Object.freeze({
    id: 'wobble.start',
    title: 'Запустить / восстановить сервер игры',
    description:
      'Сбрасывает failed/start-limit состояние systemd и запускает wobble.service, если игровой процесс полностью остановлен.',
    impact:
      'Не перезапускает Nginx, Control Plane или VPN/Xray. Если maintenance включён, новые подключения останутся закрыты до его отдельного отключения.',
    tone: 'safe'
  }),
  'wobble.restart': Object.freeze({
    id: 'wobble.restart',
    title: 'Плавно перезапустить сервер игры',
    description:
      'Включает maintenance, просит Wobble дождаться завершения активных матчей и затем перезапускает только игровой процесс.',
    impact:
      'Новые онлайн-подключения временно закрываются. Активным матчам даётся до 3 минут на завершение; после этого Wobble перезапускается принудительно по таймауту. Nginx, shared 443 и VPN/Xray не перезапускаются.',
    tone: 'danger'
  })
});

function publicOperations() {
  return Object.values(OPERATION_DEFINITIONS).map(item => ({ ...item }));
}

function validOperation(value) {
  const id = String(value || '').trim();
  return Object.hasOwn(OPERATION_DEFINITIONS, id) ? id : null;
}

class AdminOperationsClient {
  constructor({
    socketPath = process.env.ADMIN_OPS_SOCKET || DEFAULT_SOCKET_PATH,
    maintenanceFlag = MAINTENANCE_FLAG,
    journalPath = process.env.ADMIN_OPS_JOURNAL || DEFAULT_JOURNAL_PATH,
    timeoutMs = 135_000
  } = {}) {
    this.socketPath = socketPath;
    this.maintenanceFlag = maintenanceFlag;
    this.journalPath = journalPath;
    this.timeoutMs = timeoutMs;
  }

  available() {
    try {
      return fs.statSync(this.socketPath).isSocket();
    } catch {
      return false;
    }
  }

  maintenanceEnabled() {
    try {
      return fs.statSync(this.maintenanceFlag).isFile();
    } catch {
      return false;
    }
  }

  history(limit = 20) {
    const boundedLimit = Math.max(1, Math.min(40, Number.parseInt(limit, 10) || 20));
    try {
      const parsed = JSON.parse(fs.readFileSync(this.journalPath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.operations)) return [];
      return parsed.operations
        .filter(item => {
          const id = String(item?.id || '');
          return (
            /^[0-9a-f-]{36}$/i.test(id) &&
            Object.hasOwn(OPERATION_DEFINITIONS, String(item?.action || '')) &&
            OPERATION_STATES.has(String(item?.state || '')) &&
            Number.isSafeInteger(Number(item?.createdAt))
          );
        })
        .slice(-boundedLimit)
        .reverse()
        .map(item => ({
          id: String(item.id),
          action: String(item.action),
          state: String(item.state),
          createdAt: Number(item.createdAt),
          updatedAt: Number.isSafeInteger(Number(item.updatedAt))
            ? Number(item.updatedAt)
            : Number(item.createdAt),
          completedAt: Number.isSafeInteger(Number(item.completedAt)) ? Number(item.completedAt) : null,
          durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Number(item.durationMs)) : null,
          reason: /^[a-z0-9-]{1,80}$/.test(String(item.reason || '')) ? String(item.reason) : null,
          transitions: Array.isArray(item.transitions)
            ? item.transitions
                .filter(
                  step =>
                    OPERATION_STATES.has(String(step?.state || '')) && Number.isSafeInteger(Number(step?.at))
                )
                .slice(-12)
                .map(step => ({ state: String(step.state), at: Number(step.at) }))
            : []
        }));
    } catch {
      return [];
    }
  }

  status() {
    const maintenance = this.maintenanceEnabled();
    const history = this.history();
    const activeOperation = history.find(item => !TERMINAL_OPERATION_STATES.has(item.state)) || null;
    return {
      available: this.available(),
      maintenance,
      busy: Boolean(activeOperation),
      activeOperation,
      history,
      operations: publicOperations().filter(item =>
        maintenance ? item.id !== 'maintenance.enable' : item.id !== 'maintenance.disable'
      )
    };
  }

  run(operation) {
    const action = validOperation(operation);
    if (!action) return Promise.resolve({ ok: false, reason: 'unknown-operation' });
    const requestId = crypto.randomUUID();

    return new Promise(resolve => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      let buffer = '';

      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };

      const timer = setTimeout(
        () => finish({ ok: false, reason: 'helper-timeout', requestId, operation: action }),
        this.timeoutMs
      );
      timer.unref?.();

      socket.setEncoding('utf8');
      socket.once('connect', () => {
        // Do not half-close here. The helper may spend tens of seconds waiting for a systemd
        // oneshot and must still be able to return its result over this same connection.
        socket.write(`${JSON.stringify({ requestId, action })}\n`);
      });
      socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
          finish({ ok: false, reason: 'helper-response-too-large', requestId, operation: action });
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          if (response?.requestId !== requestId || response?.action !== action) {
            finish({ ok: false, reason: 'helper-response-mismatch', requestId, operation: action });
            return;
          }
          finish(response);
        } catch {
          finish({ ok: false, reason: 'helper-invalid-response', requestId, operation: action });
        }
      });
      socket.once('error', error => {
        finish({
          ok: false,
          reason:
            error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED'
              ? 'helper-unavailable'
              : 'helper-error',
          requestId,
          operation: action
        });
      });
      socket.once('end', () => {
        if (!settled && !buffer.includes('\n')) {
          finish({ ok: false, reason: 'helper-closed', requestId, operation: action });
        }
      });
    });
  }
}

module.exports = {
  AdminOperationsClient,
  DEFAULT_JOURNAL_PATH,
  DEFAULT_SOCKET_PATH,
  MAINTENANCE_FLAG,
  OPERATION_DEFINITIONS,
  publicOperations,
  validOperation
};
