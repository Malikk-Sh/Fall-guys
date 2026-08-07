import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts, generateCode, normalizeCode, safeName } = require('./accounts');

const fresh = (options = {}) => new Accounts({ db: openDatabase(':memory:'), ...options });

test('новый аккаунт получает имя и код восстановления', () => {
  const accounts = fresh();
  const created = accounts.create('Малик');
  assert.equal(created.name, 'Малик');
  assert.match(created.id, /^[0-9a-f-]{36}$/, 'идентификатор — UUID');
  assert.match(created.secret, /^WOBBLE(-[A-Z0-9]{4}){4}$/, 'код читаемыми группами');
  assert.equal(accounts.count(), 1);
});

// Код диктуют и переписывают с экрана телефона. Отказывать из-за строчной буквы или лишнего пробела
// — значит превращать вход в лотерею.
test('код принимается в любом виде, в каком его перепишет человек', () => {
  const accounts = fresh();
  const { id, secret } = accounts.create('Хозяин кода');

  const variants = [
    secret,
    secret.toLowerCase(),
    secret.replace(/-/g, ''),
    secret.replace(/-/g, ' '),
    `  ${secret}  `,
    secret.slice('WOBBLE-'.length) // без приставки
  ];
  for (const variant of variants) {
    const entered = accounts.login(variant);
    assert.ok(entered, `код должен подойти в виде «${variant}»`);
    assert.equal(entered.id, id);
  }
});

test('чужой и испорченный код не пускают', () => {
  const accounts = fresh();
  accounts.create('Первый');
  for (const bad of [generateCode(), '', null, 42, 'WOBBLE-AAAA', 'WOBBLE-AAAA-BBBB-CCCC-DDDD-EEEE']) {
    assert.equal(accounts.login(bad), null, `не должно пускать: ${String(bad)}`);
  }
});

// Код хранится только хешем: если базу однажды прочитают, войти по её содержимому будет нельзя.
test('в базе нет самого кода, только хеш', () => {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const { secret } = accounts.create('Кто-то');
  const row = db.prepare('SELECT * FROM accounts').get();
  const stored = Object.values(row).join('|');
  const body = secret.replace(/[^A-Z0-9]/g, '');
  assert.ok(!stored.includes(secret), 'код целиком не хранится');
  assert.ok(!stored.includes(body), 'и без разделителей тоже');
  assert.match(row.secret_hash, /^[0-9a-f]{64}$/);
});

test('имя чистится по тем же правилам, что и в комнате', () => {
  const accounts = fresh();
  assert.equal(accounts.create('<b>Малик</b>').name, 'bМаликb');
  assert.equal(accounts.create('   ').name, 'Wobbler');
  assert.equal(accounts.create('x'.repeat(40)).name.length, 16);
  assert.equal(safeName(''), 'Wobbler');
});

test('переименование меняет имя, но не личность', () => {
  const accounts = fresh();
  const { id, secret } = accounts.create('Старое');
  assert.equal(accounts.rename(id, 'Новое'), 'Новое');
  const entered = accounts.login(secret);
  assert.equal(entered.id, id, 'по коду попадаем в тот же аккаунт');
  assert.equal(entered.name, 'Новое');
});

test('личный рекорд хранится по режиму и трассе, и только лучший', () => {
  const accounts = fresh();
  const { id } = accounts.create('Бегун');
  const put = (mode, courseKey, timeMs) =>
    accounts.saveRecord({ accountId: id, mode, courseKey, timeMs, achievedAt: timeMs });

  assert.deepEqual(put('solo', '7:normal', 30_000), { best: 30_000, improved: true, first: true });
  assert.deepEqual(put('solo', '7:normal', 24_000), { best: 24_000, improved: true, first: false });
  // Худшее время рекорд не переписывает: игрок ждёт от рекорда лучшего результата, а не последнего.
  assert.deepEqual(put('solo', '7:normal', 27_000), { best: 24_000, improved: false });

  // Режимы и трассы не смешиваются.
  put('coop', 'ch2', 50_000);
  put('race', '7:normal', 22_000);
  put('solo', '8:chaos', 40_000);
  const records = accounts.records(id);
  assert.equal(records.length, 4);
  assert.equal(records.find(r => r.mode === 'coop').time, 50_000);
  assert.equal(records.find(r => r.mode === 'race').time, 22_000);
});

test('рекорд не принимается без аккаунта, с чужим режимом или дурным временем', () => {
  const accounts = fresh();
  const { id } = accounts.create('Бегун');
  const bad = [
    [{ accountId: 'нет-такого', mode: 'solo', courseKey: '1:easy', timeMs: 1000 }, 'unknown-account'],
    [{ accountId: id, mode: 'выдумка', courseKey: '1:easy', timeMs: 1000 }, 'unknown-mode'],
    [{ accountId: id, mode: 'solo', courseKey: '1:easy', timeMs: 0 }, 'bad-time'],
    [{ accountId: id, mode: 'solo', courseKey: '1:easy', timeMs: -5 }, 'bad-time'],
    [{ accountId: id, mode: 'solo', courseKey: '1:easy', timeMs: NaN }, 'bad-time']
  ];
  for (const [input, reason] of bad) {
    const result = accounts.saveRecord(input);
    assert.equal(result.improved, false);
    assert.equal(result.reason, reason);
  }
  assert.equal(accounts.records(id).length, 0);
});

// Сид трассы случайный, то есть разных трасс бесконечно много. Без потолка один игрок наращивал бы
// свою часть базы неограниченно.
test('число рекордов на аккаунт ограничено', () => {
  const accounts = fresh({ maxRecordsPerAccount: 3 });
  const { id } = accounts.create('Упорный');
  for (let i = 0; i < 6; i++) {
    accounts.saveRecord({
      accountId: id,
      mode: 'solo',
      courseKey: `${i}:normal`,
      timeMs: 1000,
      achievedAt: i
    });
  }
  const records = accounts.records(id);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map(r => r.courseKey),
    ['5:normal', '4:normal', '3:normal'],
    'остаются самые свежие'
  );
});

test('аккаунты и рекорды переживают перезапуск процесса', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wobble-accounts-'));
  const file = join(dir, 'game.db');
  try {
    const before = new Accounts({ db: openDatabase(file) });
    const { id, secret } = before.create('Постоянный');
    before.saveRecord({ accountId: id, mode: 'solo', courseKey: '7:normal', timeMs: 19_000 });
    before.db.close();

    const after = new Accounts({ db: openDatabase(file) });
    const entered = after.login(secret);
    assert.ok(entered, 'код продолжает работать после перезапуска');
    assert.equal(entered.id, id);
    assert.equal(entered.name, 'Постоянный');
    assert.equal(after.records(id)[0].time, 19_000);
    after.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('коды не повторяются и разбираются обратно', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = generateCode();
    assert.equal(seen.has(code), false, 'коды не должны повторяться');
    seen.add(code);
    assert.equal(normalizeCode(code).length, 16);
    // В алфавите нет знаков, которые путают при переписывании.
    assert.equal(/[01OIL8B]/.test(normalizeCode(code)), false, `в коде ${code} есть спорный знак`);
  }
});
