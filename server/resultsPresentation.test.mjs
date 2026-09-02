import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VICTORY_CELEBRATIONS,
  isResultsSkipKey,
  raceUnrankedReason,
  primaryResultAction,
  racePodiumEntries,
  racePodiumSkin,
  resultsRevealPlan,
  validResultsRevealPlan,
  victoryCelebrationKind,
  victoryCelebrationPose
} from '../client/game/ResultsPresentation.js';

test('results reveal keeps a bounded finish window before the card enters', () => {
  const plan = resultsRevealPlan(false);
  assert.equal(validResultsRevealPlan(plan), true);
  assert.ok(plan.card >= 600);
  assert.ok(plan.complete <= 1500);
  assert.ok(plan.card < plan.time);
  assert.ok(plan.time < plan.stats);
  assert.ok(plan.stats < plan.highlights);
  assert.ok(plan.highlights < plan.actions);
  assert.equal(plan.actions, plan.complete);
});

test('reduced motion reveals results almost immediately without changing stage order', () => {
  const normal = resultsRevealPlan(false);
  const reduced = resultsRevealPlan(true);
  assert.equal(validResultsRevealPlan(reduced), true);
  assert.equal(reduced.card, 0);
  assert.ok(reduced.complete <= 120);
  assert.ok(reduced.complete < normal.card);
  assert.equal(reduced.actions, reduced.complete);
});

test('victory celebration выбирается из четырёх базовых жестов и привязывается к finish cosmetic', () => {
  assert.deepEqual([...VICTORY_CELEBRATIONS], ['wave', 'jump', 'spin', 'tiny-dance']);
  assert.equal(victoryCelebrationKind(null, 0), 'wave');
  assert.equal(victoryCelebrationKind(null, 0.25), 'jump');
  assert.equal(victoryCelebrationKind(null, 0.5), 'spin');
  assert.equal(victoryCelebrationKind(null, 0.999), 'tiny-dance');

  const cosmetic = victoryCelebrationKind('space-portal-finish', 0);
  assert.ok(VICTORY_CELEBRATIONS.includes(cosmetic));
  assert.equal(
    victoryCelebrationKind('space-portal-finish', 0.999),
    cosmetic,
    'finish cosmetic задаёт стабильный стиль независимо от random fallback'
  );
});

test('victory celebration pose bounded и меняет только presentation channels', () => {
  const keys = [
    'leftArmX',
    'leftArmZ',
    'rightArmX',
    'rightArmZ',
    'leftLegX',
    'rightLegX',
    'visualY',
    'visualYaw',
    'visualTiltZ',
    'headY',
    'faceY'
  ];

  for (const kind of VICTORY_CELEBRATIONS) {
    const start = victoryCelebrationPose(kind, 0, {});
    const middle = victoryCelebrationPose(kind, 0.5, {});
    const end = victoryCelebrationPose(kind, 1, {});
    assert.deepEqual(Object.keys(middle).sort(), [...keys].sort(), `${kind}: только известные visual channels`);
    assert.ok(Object.values(middle).every(Number.isFinite), `${kind}: все offsets конечны`);
    assert.ok(keys.some(key => Math.abs(middle[key]) > 0.04), `${kind}: жест читается в середине`);
    assert.ok(Math.abs(middle.visualY) <= 0.24, `${kind}: visual jump остаётся маленьким`);
    assert.ok(Math.abs(middle.visualYaw) <= Math.PI * 2, `${kind}: поворот bounded`);
    assert.ok(keys.every(key => start[key] === 0), `${kind}: старт из исходной позы`);
    if (kind === 'spin') assert.ok(Math.abs(end.visualYaw - Math.PI * 2) < 1e-9);
    else assert.ok(keys.every(key => Math.abs(end[key]) < 1e-9), `${kind}: конец возвращается к базе`);
  }
});

test('one primary result action is chosen from current mode and visible actions', () => {
  const visible = {
    again: true,
    newCourse: true,
    nextChapter: true,
    rematch: true,
    returnLobby: true
  };
  assert.equal(primaryResultAction('single', visible), 'again');
  assert.equal(primaryResultAction('coop', visible), 'nextChapter');
  assert.equal(primaryResultAction('multi', visible), 'rematch');
  assert.equal(primaryResultAction('multi', { returnLobby: true }), 'returnLobby');
  assert.equal(primaryResultAction('single', {}), null);
});

test('race podium preserves authoritative board order and enriches only by matching roster id', () => {
  const board = [
    { id: 'p2', name: 'Second seed', time: 44000, color: 0x111111 },
    { id: 'p1', name: 'First seed', time: 41000, color: 0x222222 },
    { id: 'bot', name: 'BOT-7', time: 47000, bot: true, color: 0x333333 },
    { id: 'p4', name: 'Fourth', time: 39000, color: 0x444444 }
  ];
  const roster = [
    { id: 'p1', name: 'Roster P1', color: 0xabcdef, loadout: { body: 'sky-hero' } },
    { id: 'p2', name: 'Roster P2', loadout: { visor: 'clear-visor' } },
    { id: 'bot', name: 'Roster Bot', bot: true, loadout: { antenna: 'rescue-antenna' } }
  ];

  const podium = racePodiumEntries(board, roster, 'p1');
  assert.deepEqual(
    podium.map(entry => [entry.place, entry.id, entry.name, entry.time]),
    [
      [1, 'p2', 'Second seed', 44000],
      [2, 'p1', 'First seed', 41000],
      [3, 'bot', 'BOT-7', 47000]
    ]
  );
  assert.equal(podium[0].loadout.visor, 'clear-visor');
  assert.equal(podium[1].color, 0xabcdef);
  assert.equal(podium[1].self, true);
  assert.equal(podium[2].bot, true);
});

test('race podium falls back safely when roster profile is missing', () => {
  const [entry] = racePodiumEntries([{ id: 'gone', name: 'Gone', time: 50000, color: 0x123456 }], []);
  assert.equal(entry.place, 1);
  assert.equal(entry.name, 'Gone');
  assert.equal(entry.color, 0x123456);
  assert.equal(entry.loadout, null);
  assert.equal(entry.bot, false);
});

test('race podium skin resolves canonical public loadout instead of trusting visual payloads', () => {
  const skin = racePodiumSkin(
    {
      body: 'sky-hero',
      visor: 'clear-visor',
      antenna: 'rescue-antenna'
    },
    0x010203
  );
  assert.equal(skin.bodyId, 'sky-hero');
  assert.equal(skin.visorId, 'clear-visor');
  assert.equal(skin.antennaId, 'rescue-antenna');
  assert.equal(skin.body, 0x7857ff);
  assert.equal(skin.visor, 0xffd7fb);
  assert.equal(skin.antenna, 0x68f4d2);
});

test('results presentation skips only on explicit confirm keys', () => {
  assert.equal(isResultsSkipKey('Enter'), true);
  assert.equal(isResultsSkipKey('NumpadEnter'), true);
  assert.equal(isResultsSkipKey('Space'), true);
  assert.equal(isResultsSkipKey('Escape'), false);
  assert.equal(isResultsSkipKey('KeyW'), false);
});

test('invalid reveal plans fail closed', () => {
  assert.equal(validResultsRevealPlan(null), false);
  assert.equal(
    validResultsRevealPlan({ card: 10, time: 20, stats: 5, highlights: 30, actions: 40, complete: 40 }),
    false
  );
  assert.equal(
    validResultsRevealPlan({
      card: 0,
      time: 10,
      stats: 20,
      highlights: 30,
      actions: 40,
      complete: Number.NaN
    }),
    false
  );
});

// Плашка «без зачёта» обязана называть СВОЮ причину.
//
// Гонка — личное соревнование, и сервер записывает строку в таблицу каждому проверенному игроку
// отдельно. Общая комнатная причина означала бы, что человеку, чей рекорд записан, сообщают
// обратное: «время никуда не записалось». Раньше так и было — проверка соседа снимала зачёт со
// всех, и плашка не врала лишь потому, что не врал и сервер.
test('причина «без зачёта» в гонке берётся своя, а не комнатная', () => {
  // Проверенный игрок рядом с непроверенным плашки не видит: его строка записана.
  assert.equal(raceUnrankedReason(null, { verified: true }), null);
  // Непроверенный видит, и причина названа одним понятным словом, а не именем сигнала.
  assert.equal(raceUnrankedReason(null, { verified: false }), 'verification');

  // Комнатная причина старше личной: если забег и так не в зачёте из-за обрыва, назвать надо
  // именно обрыв. Иначе игрок пойдёт разбираться не с тем.
  assert.equal(raceUnrankedReason('disconnect', { verified: false }), 'disconnect');
  assert.equal(raceUnrankedReason('left', { verified: true }), 'left');

  // Своей строки может не быть вовсе — например, у вернувшегося по resume до записи финиша.
  // Отсутствие строки не повод объявлять забег незачётным.
  assert.equal(raceUnrankedReason(null, null), null);
  assert.equal(raceUnrankedReason(null, undefined), null);
});
