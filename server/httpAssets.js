'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Код клиента и общие с сервером правила НЕ кэшируются надолго.
//
// Имена файлов без хеша, а протокол между клиентом и сервером обязан совпадать. Пятиминутный
// кэш означал, что после деплоя часть игроков несколько минут говорит со свежим сервером старым
// клиентом: сообщения не сходятся по схеме, и сбои выглядят случайными. Долгий immutable-кэш
// оставлен только для vendor-файлов, чьи версии меняются вместе с именем пакета.
const NO_CACHE = 'no-cache, must-revalidate';
const VENDOR_MAX_AGE = '1d';

// Хеш встроенного import map для политики безопасности.
//
// Import map обязан быть встроенным в HTML — внешние карты браузеры не поддерживают. При строгой
// политике script-src 'self' такой скрипт блокируется, и игра просто не загружается: спецификатор
// 'three' перестаёт разрешаться. Разрешать 'unsafe-inline' ради этого нельзя — это открыло бы
// исполнение любого встроенного скрипта. Поэтому считаем хеш содержимого при старте: политика
// остаётся строгой и автоматически подстраивается, если карта изменится.
function inlineScriptHashes(clientPath) {
  try {
    const html = fs.readFileSync(path.join(clientPath, 'index.html'), 'utf8');
    const hashes = [];
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      const body = match[1];
      if (!body.trim()) continue;
      hashes.push(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }
    return hashes;
  } catch {
    return [];
  }
}

// Заголовки безопасности (ТЗ 13.6). Игра целиком самодостаточна: внешних скриптов, шрифтов и
// стилей нет, поэтому политика может быть строгой без риска что-то сломать.
function contentSecurityPolicy(inlineHashes) {
  return [
    "default-src 'self'",
    ["script-src 'self'", ...inlineHashes].join(' '),
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'"
  ].join('; ');
}

// Политика безопасности и раздача статики. Регистрируется до игровых маршрутов.
function installStaticShell(app, { clientPath, sharedPath, vendorPath, addonsPath }) {
  const policy = contentSecurityPolicy(inlineScriptHashes(clientPath));

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use(
    express.static(clientPath, {
      setHeaders: (res, file) => {
        if (/\.(js|css|html|webmanifest)$/.test(file)) res.setHeader('Cache-Control', NO_CACHE);
      }
    })
  );
  // Общие с клиентом правила: один и тот же файл исполняется и на сервере, и в браузере.
  app.use(
    '/shared',
    express.static(sharedPath, {
      setHeaders: res => res.setHeader('Cache-Control', NO_CACHE)
    })
  );
  app.use('/vendor', express.static(vendorPath, { maxAge: VENDOR_MAX_AGE, immutable: true }));
  // Дополнения Three.js (постобработка). Они импортируют 'three' как голое имя, поэтому в
  // client/index.html объявлен import map — иначе браузер загрузил бы вторую копию движка.
  app.use('/vendor/addons', express.static(addonsPath, { maxAge: VENDOR_MAX_AGE, immutable: true }));

  return policy;
}

// Отдаём index.html только для навигационных запросов. Раньше сюда попадали и запросы к
// несуществующим ассетам — браузер получал HTML вместо 404 и молча ломался на разборе.
//
// Регистрируется ПОСЛЕ игровых маршрутов: этот обработчик ловит всё, что до него не разобрали.
function installSpaFallback(app, { clientPath }) {
  app.get('*', (req, res, next) => {
    if (path.extname(req.path)) return next();
    res.setHeader('Cache-Control', NO_CACHE);
    res.sendFile(path.join(clientPath, 'index.html'));
  });
}

module.exports = Object.freeze({
  NO_CACHE,
  VENDOR_MAX_AGE,
  contentSecurityPolicy,
  inlineScriptHashes,
  installSpaFallback,
  installStaticShell
});
