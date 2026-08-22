import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE } = require('../shared/protocol.js');
const { createCourseSpec } = require('../shared/courseSpec.js');
const {
  WORLD_SUPPORT,
  createShadowCourseWorld,
  shadowCourseWorldFor,
  shadowWorldSupport,
  shadowWorldSupported
} = require('./shadowCourseWorld');
const { supportIndexAt, supportTop } = require('../shared/courseCollision.js');
const { PLAYER_FOOT } = require('../shared/playerDimensions.js');
const { resolveGroundContact } = require('../shared/playerSimulation.js');

const spec = createCourseSpec(20260821, 'chaos');

test('мир трассы строится на сервере и содержит пол', () => {
  const world = createShadowCourseWorld(spec);
  assert.ok(world.colliders.length > 0);
  assert.ok(world.obstacles.length > 0);

  const start = world.colliders[0];
  const y = supportTop(start) + PLAYER_FOOT;
  const index = supportIndexAt(world.colliders, { x: start.x, y, z: start.z }, y, 0, PLAYER_FOOT);
  assert.ok(index >= 0, 'на стартовой площадке обязан быть пол');
});

test('серверный игрок встаёт на пол, а не проваливается сквозь него', () => {
  const world = createShadowCourseWorld(spec);
  const start = world.colliders[0];
  const top = supportTop(start);

  // Падение с небольшой высоты ровно над стартовой площадкой.
  const falling = {
    position: { x: start.x, y: top + PLAYER_FOOT + 0.3, z: start.z },
    velocity: { x: 0, y: -4, z: 0 },
    grounded: false
  };
  const settled = resolveGroundContact(falling, {
    colliders: world.colliders,
    previousY: top + PLAYER_FOOT + 0.5,
    footOffset: PLAYER_FOOT,
    wasGrounded: false
  });

  assert.equal(settled.state.grounded, true, 'сервер обязан сам находить опору');
  assert.equal(settled.state.position.y, top + PLAYER_FOOT);
  assert.equal(settled.state.velocity.y, 0);
  assert.ok(
    settled.events.some(event => event.name === 'land'),
    'приземление обязано быть замечено как событие'
  );
});

test('подвижные опоры считаются от времени матча, а не от числа шагов', () => {
  const world = createShadowCourseWorld(spec);
  if (!world.dynamic.length) return;
  const platform = world.dynamic[0];
  const axis = platform.motion.axis;

  world.advance(3);
  const afterJump = platform[axis];

  const stepped = createShadowCourseWorld(spec);
  for (let step = 0; step <= 90; step++) stepped.advance(step / 30);
  assert.equal(stepped.dynamic[0][axis], afterJump, 'пропуск тика не должен сдвигать трассу');
});

test('сдвиг подвижной опоры за шаг переносит стоящего игрока', () => {
  const world = createShadowCourseWorld(spec);
  if (!world.dynamic.length) return;
  const platform = world.dynamic[0];
  const axis = platform.motion.axis;

  world.advance(1);
  const before = platform[axis];
  world.advance(1 + 1 / 30);
  assert.equal(platform.delta[axis], platform[axis] - before);
});

test('препятствия тоже живут по времени матча, а не стоят в записанном положении', () => {
  const world = createShadowCourseWorld(spec);
  const spinner = world.obstacles.find(o => o.type === 'spinner');
  const puncher = world.obstacles.find(o => o.type === 'puncher');

  // Геометрия удара вертушки берётся из `angle`, а поршня — из `x`. Застывшие на записанных
  // значениях, они считали бы импульсы не там, где они происходят у клиента.
  if (spinner) {
    world.advance(4);
    assert.equal(spinner.angle, 4 * spinner.speed + spinner.phase);
    world.advance(9);
    assert.equal(spinner.angle, 9 * spinner.speed + spinner.phase);
  }
  if (puncher) {
    world.advance(4);
    assert.equal(puncher.x, puncher.originX + Math.sin(4 * puncher.speed + puncher.phase) * puncher.range);
    assert.notEqual(puncher.x, puncher.originX, 'поршень обязан сойти с центра');
  }

  assert.ok(spinner || puncher, 'на этой трассе обязано быть хотя бы одно подвижное препятствие');
});

test('кооперативу мир не строится: его главы рукотворные', () => {
  assert.equal(shadowCourseWorldFor({ mode: GAME_MODE.COOP, spec }), null);
  assert.equal(shadowCourseWorldFor({ mode: GAME_MODE.RACE }), null);
  assert.ok(shadowCourseWorldFor({ mode: GAME_MODE.RACE, spec }));
});

test('нечитаемая спецификация не роняет матч и не выдумывает пол', () => {
  let world;
  assert.doesNotThrow(() => {
    world = shadowCourseWorldFor({ mode: GAME_MODE.RACE, spec: { segmentCount: 'нет' } });
  });
  // Сегментов из такой спеки не выходит, и это безопасно: там, где пола нет, серверная симуляция
  // окажется не на опоре, разойдётся с клиентом и доказательства паритета останутся ложными.
  // Провайдер паритета fail-closed, поэтому вырожденный мир никого никуда не переключит.
  if (!world) return;
  const segmentZ = -20;
  const probe = { x: 0, y: 1, z: segmentZ };
  assert.equal(supportIndexAt(world.colliders, probe, 1.5, 0, PLAYER_FOOT), -1);
});

test('неизвестный режим — не неприменимость, а отказ', () => {
  // Состояний три, и двух не хватает принципиально: «поддержан», «не поддержан по устройству» и
  // «неизвестен». При делении надвое последние два неразличимы, и неизвестный режим молча
  // переставал бы блокировать ворота — хотя геометрия ему могла быть положена.
  assert.equal(shadowWorldSupport({ mode: GAME_MODE.RACE }), WORLD_SUPPORT.SUPPORTED);
  assert.equal(shadowWorldSupport({ mode: GAME_MODE.COOP }), WORLD_SUPPORT.UNSUPPORTED);

  // Всё остальное обязано попадать в «неизвестно», а не в «неприменимо».
  for (const room of [{ mode: 'режим-которого-нет' }, {}, null, undefined, { mode: null }]) {
    assert.equal(
      shadowWorldSupport(room),
      WORLD_SUPPORT.UNKNOWN,
      `неизвестный режим не должен считаться неприменимым: ${JSON.stringify(room)}`
    );
  }

  // Мир при этом строится только поддержанному режиму.
  assert.equal(shadowWorldSupported({ mode: GAME_MODE.RACE }), true);
  assert.equal(shadowWorldSupported({ mode: GAME_MODE.COOP }), false);
  assert.equal(shadowWorldSupported({ mode: 'режим-которого-нет' }), false);
});
