// Раздача портального билда так, как это делает площадка.
//
// Отличие от нашего сервера принципиальное и ради него всё и затевается: площадка отдаёт игру с
// ПОДПУТИ своего домена, а не из корня. Всё, что уцелело абсолютным путём, ломается именно здесь —
// и только здесь это видно. Поэтому корень раздачи намеренно закрыт: запрос мимо подпути получает
// 404, как получил бы на чужом домене.
//
// Сборка запускается перед раздачей, чтобы тест смотрел на свежее дерево, а не на то, что случайно
// осталось от прошлого прогона. Она занимает доли секунды.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { buildPortal } from '../tools/buildPortal.mjs';

const MOUNT = '/game';
const PORT = Number(process.env.WOBBLE_PORTAL_PORT || 4174);

const TYPES = new Map(
  Object.entries({
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.woff2': 'font/woff2'
  })
);

const root = buildPortal({ platform: 'yandex' });

const server = http.createServer((request, response) => {
  const requested = decodeURIComponent((request.url || '/').split('?')[0]);

  // Проверка живости для Playwright: ему нужен адрес, отвечающий до первого теста.
  if (requested === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    return response.end('ok');
  }

  if (!requested.startsWith(`${MOUNT}/`) && requested !== MOUNT) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    return response.end('вне точки монтирования');
  }

  const relative = requested.slice(MOUNT.length) || '/';
  const target = path.join(root, relative);

  // Выход за пределы дерева — не раздаём.
  if (!path.resolve(target).startsWith(path.resolve(root))) {
    response.writeHead(403, { 'content-type': 'text/plain' });
    return response.end('за пределами билда');
  }

  const file =
    fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'index.html') : target;

  if (!fs.existsSync(file)) {
    // Именно 404, а не подстановка index.html: тест обязан видеть промах пути, а не получать
    // разметку вместо модуля и падать потом на разборе.
    response.writeHead(404, { 'content-type': 'text/plain' });
    return response.end(`нет файла: ${relative}`);
  }

  response.writeHead(200, { 'content-type': TYPES.get(path.extname(file)) || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});

server.listen(PORT, '127.0.0.1', () => {
  const here = path.relative(process.cwd(), root);
  console.log(`портальный билд (${here}) раздаётся на http://127.0.0.1:${PORT}${MOUNT}/`);
});
