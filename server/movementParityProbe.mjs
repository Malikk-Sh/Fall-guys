// Замер паритета движения на ботах.
//
// Зачем он есть. Пороги `DEFAULT_MOVEMENT_PARITY_POLICY` выведены рассуждением, а не измерением, и
// подключать по ним провайдера нельзя: это то же самое, что выставить parity-флаг руками. Живой
// трафик — правильный источник таких чисел, но он требует выпуска релиза и деплоя ради
// калибровочных цифр, а до тех пор пороги остаются ничем не проверены.
//
// Бот здесь — не замена живому игроку, а способ получить ИЗМЕРЕННЫЕ числа раньше. Он гоняет ту же
// физику (`Player.step`) по той же трассе (`Course`), а его ввод уходит в shadow-runtime тем же
// путём и на той же частоте, что и у живого клиента: 60 Гц у физики, 30 Гц у сети.
//
// Честная оговорка, которую нельзя терять при чтении результатов: выборка бота УЖЕ человеческой.
// Бот держится середины опоры, редко бьётся о стены и почти не пользуется приёмами. Поэтому его
// числа годятся, чтобы поймать грубое расхождение и прикинуть порядок величин, но не чтобы
// объявить паритет доказанным. Ворота движения этот замер не открывает и открывать не может.
//
// Запуск: npm run parity:probe

import * as THREE from 'three';
import { createRequire } from 'node:module';
import { BotField, BOT_SKILL_IDS, FIXED_DT, RaceBot } from './raceBot.mjs';
import { Course } from '../client/game/Course.js';
import { createCourseSpec } from '../shared/courseSpec.js';

const require = createRequire(import.meta.url);
const { ShadowInputRuntime } = require('./shadowInputRuntime');
const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { DEFAULT_MOVEMENT_PARITY_POLICY, evaluateMovementParity } = require('./shadowMovementParityEvidence');

// Один сетевой отсчёт ввода на два кадра физики: 60 Гц против 30 Гц, как у живого клиента.
const FRAMES_PER_INPUT = 2;

// А состояние игрока уходит реже — раз в 66 мс (`NetworkManager.sendState`), то есть каждый
// четвёртый кадр. Разница принципиальна для замера: снимок, по которому сверяется опора, всегда
// старше текущего тика, и делать вид, что он приходит каждый тик, значило бы мерить условия,
// которых в игре не бывает.
const FRAMES_PER_STATE = 4;
const LIMIT_STEPS = 60 * 200;

const SEEDS = [4101, 4102, 4103, 20260821, 777, 31337];
const DIFFICULTIES = ['easy', 'normal', 'chaos'];

// Ввод бота уходит в сеть теми же полями, что собирает ClientInputShadowSender.capture().
//
// Прыжок и рывок — одноразовые: `Player.step` съедает их на 60 Гц, а сетевой отсчёт идёт на 30.
// Поэтому они защёлкиваются ровно так же, как у живого отправителя, — иначе нажатие между двумя
// сетевыми тиками просто исчезало бы, и серверная траектория не прыгала бы там, где прыгнул бот.
function latchingInput(input) {
  const latched = { jump: false, dive: false };
  const consume = input.consume.bind(input);
  input.consume = action => {
    const fired = consume(action);
    if (fired && action === 'jump') latched.jump = true;
    if (fired && action === 'dive') latched.dive = true;
    return fired;
  };
  return latched;
}

function runRace(runtime, { seed, difficulty, skill, index }) {
  const spec = createCourseSpec(seed, difficulty);
  const course = new Course(new THREE.Scene(), spec, { quality: 'low' });
  const bot = new RaceBot(course, { skill, seed, index });
  const field = new BotField(course, [bot]);
  const latched = latchingInput(bot.input);

  const matchId = `probe-${seed}-${difficulty}-${skill}`;
  const startedAt = 1_760_000_000_000;
  // Игрок в том же виде, в каком его знает сервер. `bot: false` не описка: для runtime это живой
  // клиент, и помеченного ботом игрока он бы пропустил.
  // `lastSequence` — номер клиентского пакета. Состояния, которые сервер пишет сам (возрождение),
  // его не двигают, и измерение отличает одно от другого именно по нему.
  const player = {
    bot: false,
    checkpoint: 0,
    finished: false,
    last: bot.snapshot(),
    lastAt: startedAt,
    lastSequence: 0
  };
  const room = {
    mode: GAME_MODE.RACE,
    state: ROOM_STATE.PLAYING,
    matchId,
    spec,
    startedAt,
    players: new Map([['p1', player]])
  };
  const rooms = new Map([[matchId, room]]);

  let sequence = 0;
  let frames = 0;
  let respawns = 0;
  let previousY = bot.player.position.y;

  while (!bot.finished && frames < LIMIT_STEPS) {
    field.step();
    frames += 1;

    // Возвращение на чекпоинт — разрыв в траектории клиента, которого серверная симуляция не
    // видела: она не падала. Считаем их отдельно, чтобы отличить накопленный дрейф от скачка.
    if (Math.abs(bot.player.position.y - previousY) > 4) respawns += 1;
    previousY = bot.player.position.y;

    // Состояние уходит реже ввода, как и у живого клиента.
    if (frames % FRAMES_PER_STATE === 0) {
      player.last = bot.snapshot();
      player.lastAt = startedAt + field.elapsed * 1000;
      player.lastSequence += 1;
      player.checkpoint = bot.player.checkpoint;
      player.finished = bot.player.finished;
    }

    if (frames % FRAMES_PER_INPUT !== 0) continue;

    const movement = bot.input.movement();

    runtime.accept({
      player,
      room,
      message: {
        matchId,
        sequence,
        clientTick: sequence,
        moveX: movement.x,
        moveZ: movement.forward,
        cameraYaw: 0,
        jumpPressed: latched.jump,
        jumpHeld: bot.input.isHeld('jump'),
        divePressed: latched.dive
      }
    });
    sequence += 1;
    latched.jump = false;
    latched.dive = false;

    runtime.tick(rooms, startedAt + field.elapsed * 1000);
  }

  const result = {
    seed,
    difficulty,
    skill,
    finished: bot.finished,
    seconds: frames * FIXED_DT,
    respawns
  };
  field.dispose();
  return result;
}

function pct(value) {
  return `${(value * 100).toFixed(3)}%`;
}

function main() {
  const runtime = new ShadowInputRuntime();
  const runs = [];
  let index = 0;

  for (const seed of SEEDS) {
    for (const difficulty of DIFFICULTIES) {
      const skill = BOT_SKILL_IDS[index % BOT_SKILL_IDS.length];
      runs.push(runRace(runtime, { seed, difficulty, skill, index }));
      index += 1;
    }
  }

  const metrics = runtime.metrics().shadowGroundContact;
  const evaluation = evaluateMovementParity(metrics);
  const policy = DEFAULT_MOVEMENT_PARITY_POLICY;
  const respawns = runs.reduce((sum, run) => sum + run.respawns, 0);
  const unfinished = runs.filter(run => !run.finished);

  const lines = [
    '',
    `Забегов: ${runs.length}, из них не дошли: ${unfinished.length}`,
    `Возвратов на чекпоинт за все забеги: ${respawns}`,
    '',
    'Измерение shadowGroundContact',
    '─'.repeat(72),
    `выборок               ${metrics.samples}   (порог ≥ ${policy.minSamples})`,
    `мир не построен       ${metrics.worldMissing}   (порог ${policy.maxWorldMissingSamples})`,
    'Модель мира (опора в точке клиента) — от неё зависит паритет столкновений',
    `  выборок             ${metrics.groundModel.samples}   (порог ≥ ${policy.minSamples})`,
    `  согласие            ${pct(metrics.groundModel.agreementRate)}   (порог ≥ ${pct(policy.minGroundAgreementRate)})`,
    `  сервер дал пол      ${metrics.groundModel.serverGroundedOnly}   (порог ${policy.maxShadowGroundedOnlySamples})`,
    `  сервер потерял пол  ${metrics.groundModel.clientGroundedOnly}`,
    `  подвижных пропущено ${metrics.groundModel.dynamicSkipped}   (фазу к моменту снимка не восстановить)`,
    `  после постановки    ${metrics.groundModel.placedSkipped}   (шага физики ещё не было)`,
    '',
    'Опора у свободной траектории (справочно: сюда входит дрейф)',
    `  согласие            ${pct(metrics.agreementRate)}`,
    `  сервер дал пол      ${metrics.shadowGroundedOnly}`,
    `  сервер потерял пол  ${metrics.clientGroundedOnly}`,
    `опора не наблюдаема   ${metrics.groundStateUnknown}   (dive/slam/knockdown — вне статистики)`,
    `высота стояния  сред. ${metrics.heightError.mean.toFixed(4)}   (порог ≤ ${policy.maxGroundHeightErrorMean})`,
    `                 p95  ${metrics.heightError.p95.toFixed(4)}`,
    `                 макс ${metrics.heightError.max.toFixed(4)}   (порог ≤ ${policy.maxGroundHeightErrorMax})`,
    `траектория      сред. ${metrics.freeTrajectoryError.mean.toFixed(4)}   (справочно)`,
    `                 p50  ${metrics.freeTrajectoryError.p50.toFixed(4)}   (справочно, по окну)`,
    `                 p95  ${metrics.freeTrajectoryError.p95.toFixed(4)}   (справочно, по окну)`,
    `                 макс ${metrics.freeTrajectoryError.max.toFixed(4)}   (справочно)`,
    `  выше 0.3            ${pct(metrics.freeTrajectoryError.overSoftRate)}   (порог ≤ ${pct(policy.maxOverSoftRate)})`,
    `  выше 1.5            ${pct(metrics.freeTrajectoryError.overHardRate)}   (порог ≤ ${pct(policy.maxOverHardRate)})`,
    `  записей отрыва      ${metrics.freeTrajectoryError.count}`,
    `импульсов             ${metrics.impulses}   (порог ≥ ${policy.minImpulseSamples})`,
    '',
    'Паритет попаданий',
    `  ударов у сервера    ${metrics.hitParity.serverHits}`,
    `  сбиваний у клиента  ${metrics.hitParity.clientHits}`,
    `  совпало             ${metrics.hitParity.matched}`,
    `  сервер выдумал      ${metrics.hitParity.serverOnly}   (порог ${policy.maxServerOnlyHits})`,
    `  сервер прозевал     ${metrics.hitParity.clientOnly}`,
    `  доля совпадений     ${pct(metrics.hitParity.matchRate)}   (порог ≥ ${pct(policy.minHitMatchRate)})`,
    `  решено событий      ${metrics.hitParity.matched + metrics.hitParity.serverOnly + metrics.hitParity.clientOnly}   (порог ≥ ${policy.minHitSamples})`,
    '',
    `отскоков от стен      ${metrics.wallBounces}`,
    `сбросов якоря         ${metrics.reanchors}`,
    `возвратов клиента     ${metrics.clientTeleports}`,
    '─'.repeat(72),
    `столкновения: ${evaluation.collisionParityVerified ? 'подтверждены' : 'НЕ подтверждены'}`,
    `импульсы:     ${evaluation.obstacleParityVerified ? 'подтверждены' : 'НЕ подтверждены'}`,
    `причины отказа: ${evaluation.reasons.length ? evaluation.reasons.join(', ') : '—'}`,
    '',
    'Замер сделан на ботах. Он уже живой игры и воротами движения не является.',
    ''
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  return { metrics, evaluation, runs };
}

main();
