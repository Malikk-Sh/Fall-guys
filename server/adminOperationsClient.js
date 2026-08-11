'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');

const DEFAULT_SOCKET_PATH = '/run/wobble-ops.sock';
const MAX_RESPONSE_BYTES = 16 * 1024;

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
  'wobble.restart': Object.freeze({
    id: 'wobble.restart',
    title: 'Перезапустить сервер игры',
    description:
      'Перезапускает только процесс Wobble. Nginx, shared 443 и VPN/Xray эта операция не трогает.',
    impact: 'Все игроки на несколько секунд потеряют соединение с игрой. Используйте только при необходимости.',
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
  constructor({ socketPath = process.env.ADMIN_OPS_SOCKET || DEFAULT_SOCKET_PATH, timeoutMs = 135_000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  available() {
    try {
      return fs.statSync(this.socketPath).isSocket();
    } catch {
      return false;
    }
  }

  status() {
    return {
      available: this.available(),
      operations: publicOperations()
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
        socket.end(`${JSON.stringify({ requestId, action })}\n`);
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
          reason: error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED' ? 'helper-unavailable' : 'helper-error',
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
  DEFAULT_SOCKET_PATH,
  OPERATION_DEFINITIONS,
  publicOperations,
  validOperation
};
