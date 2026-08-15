// Правила кооперативного режима на сервере.
//
// Модель авторитета здесь намеренно лёгкая. Сервер не симулирует физику игроков: в кооперативе на
// двух друзей полная серверная симуляция была бы дорогой и мало что добавила. Но ценные
// интерактивные объекты — ядро и сигнальный терминал — имеют собственное состояние, которое из
// позиции игроков вывести нельзя. Поэтому именно ими сервер владеет полностью.

const { chapterLayout } = require('../shared/coopChapters.js');
const { validateCollapseEvent } = require('./coopCollapseSync');
const {
  CORE_FLOOR_Y,
  SIGNATURE_INTERACT_RADIUS,
  signalRoles,
  signatureLayout
} = require('../shared/signatureCoop.js');

// Максимальный модуль импульса подброса. Катапульты в главах используют силу 18–20; потолок с
// запасом отсекает попытку зашвырнуть напарника за пределы карты, не мешая честной игре.
const MAX_LAUNCH_SPEED = 32;

// На каком расстоянии можно оживить напарника.
const REVIVE_RADIUS = 4.5;

// Не чаще одного подброса раз в столько миллисекунд — от случайной серии ударов.
const LAUNCH_COOLDOWN_MS = 900;

// Геометрия обеих площадок совпадает с CoopCourse. Серверу не нужна вся Three.js-сцена:
// координаты катапульты полностью выводятся из data-driven spec главы.
const CATAPULT_SLAM_RADIUS = 3.2;
const CATAPULT_SEAT_RADIUS = Math.sqrt(4.4);
const CATAPULT_VECTOR_TOLERANCE = 0.75;

// Сколько игрок лежит «пузырём», прежде чем подняться сам. Нужен именно потолок ожидания:
// без него пара, где один отошёл от устройства, застревала бы в главе навсегда.
const AUTO_REVIVE_MS = 12_000;

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function findCatapult(spec, objectId) {
  if (!objectId || !spec?.chapterId) return null;
  for (const piece of chapterLayout(spec.chapterId).pieces) {
    const prop = piece.props?.find(item => item.type === 'catapult' && item.id === objectId);
    if (prop) {
      return {
        id: prop.id,
        x: prop.x,
        slamZ: piece.z + 3,
        launchZ: piece.z - 3,
        power: prop.power,
        forward: prop.forward
      };
    }
  }
  return null;
}

function nearPad(position, catapult, z, radius, maxY = 3.5) {
  if (!position || position.y > maxY) return false;
  return Math.hypot(position.x - catapult.x, position.z - z) < radius;
}

function freshCore(layout, now) {
  if (!layout?.core) return null;
  return {
    id: layout.core.id,
    position: { ...layout.core.spawn },
    velocity: { x: 0, y: 0, z: 0 },
    carrier: null,
    insertedInto: null,
    at: now
  };
}

function ensureSignatureState(room, now = Date.now()) {
  const layout = signatureLayout(room.spec?.chapterId || room.chapterId);
  if (!layout.core && !layout.signal) return { layout, state: null };

  if (!room.signatureState || room.signatureState.matchId !== room.matchId) {
    room.signatureState = {
      matchId: room.matchId,
      core: freshCore(layout, now),
      signal: layout.signal
        ? {
            id: layout.signal.id,
            progress: 0,
            solved: false
          }
        : null
    };
  }
  return { layout, state: room.signatureState };
}

function advanceCore(room, core, layout, now = Date.now()) {
  if (!core || !layout?.core) return core;
  if (core.insertedInto) {
    core.position = { ...layout.core.socket };
    core.velocity = { x: 0, y: 0, z: 0 };
    core.at = now;
    return core;
  }

  if (core.carrier) {
    const carrier = room.players.get(core.carrier);
    if (carrier?.last) {
      core.position = {
        x: carrier.last.x,
        y: carrier.last.y + 1.65,
        z: carrier.last.z
      };
      core.velocity = { x: 0, y: 0, z: 0 };
      core.at = now;
      return core;
    }
    core.carrier = null;
  }

  const dt = Math.max(0, Math.min(3, (now - (core.at || now)) / 1000));
  if (dt <= 0) return core;
  const vy = core.velocity?.y || 0;
  core.position = {
    x: core.position.x + (core.velocity?.x || 0) * dt,
    y: Math.max(CORE_FLOOR_Y, core.position.y + vy * dt - 9 * dt * dt),
    z: core.position.z + (core.velocity?.z || 0) * dt
  };
  core.velocity = {
    x: core.position.y <= CORE_FLOOR_Y ? 0 : core.velocity?.x || 0,
    y: core.position.y <= CORE_FLOOR_Y ? 0 : vy - 18 * dt,
    z: core.position.y <= CORE_FLOOR_Y ? 0 : core.velocity?.z || 0
  };
  core.at = now;
  return core;
}

function signatureSnapshot(room, now = Date.now()) {
  const { layout, state } = ensureSignatureState(room, now);
  if (!state) return null;
  advanceCore(room, state.core, layout, now);
  const roles = layout.signal ? signalRoles([...room.players.keys()]) : null;
  return {
    core: state.core
      ? {
          id: state.core.id,
          position: { ...state.core.position },
          velocity: { ...state.core.velocity },
          carrier: state.core.carrier,
          insertedInto: state.core.insertedInto,
          at: state.core.at
        }
      : null,
    signal: state.signal
      ? {
          id: state.signal.id,
          progress: state.signal.progress,
          solved: state.signal.solved,
          roles
        }
      : null
  };
}

function signatureRelay(room, now = Date.now()) {
  return { action: 'signatureState', signature: signatureSnapshot(room, now) };
}

function resetCore(state, layout, now) {
  state.core = freshCore(layout, now);
}

function validateSignatureEvent(room, player, message, now = Date.now()) {
  const { layout, state } = ensureSignatureState(room, now);
  if (!state) return { ok: false, reason: 'в этой главе нет signature-механики' };
  const command = message.objectId || '';

  if (command === 'sig:sync') return { ok: true, relay: signatureRelay(room, now) };

  if (command === 'core:reset') {
    if (!layout.core || !state.core || state.core.carrier || state.core.insertedInto) {
      return { ok: false, reason: 'ядро сейчас нельзя вернуть' };
    }
    resetCore(state, layout, now);
    return { ok: true, relay: signatureRelay(room, now) };
  }

  if (command.startsWith('core:')) {
    if (!layout.core || !state.core) return { ok: false, reason: 'в главе нет ядра' };
    advanceCore(room, state.core, layout, now);

    if (command === 'core:pickup') {
      if (state.core.carrier || state.core.insertedInto) return { ok: false, reason: 'ядро занято' };
      if (distance(player.last, state.core.position) > layout.core.pickupRadius) {
        return { ok: false, reason: 'слишком далеко от ядра' };
      }
      state.core.carrier = player.id;
      state.core.velocity = { x: 0, y: 0, z: 0 };
      state.core.at = now;
      return { ok: true, relay: signatureRelay(room, now) };
    }

    if (command === 'core:throw') {
      if (state.core.carrier !== player.id || !message.vector) {
        return { ok: false, reason: 'игрок не несёт ядро' };
      }
      const direction = message.vector;
      const length = Math.hypot(direction.x || 0, direction.y || 0, direction.z || 0) || 1;
      state.core.carrier = null;
      state.core.position = { x: player.last.x, y: player.last.y + 1.2, z: player.last.z };
      state.core.velocity = {
        x: ((direction.x || 0) / length) * layout.core.throwSpeed,
        y: Math.max(0.32, (direction.y || 0) / length) * layout.core.throwSpeed,
        z: ((direction.z || 0) / length) * layout.core.throwSpeed
      };
      state.core.at = now;
      return { ok: true, relay: signatureRelay(room, now) };
    }

    if (command === 'core:insert') {
      if (state.core.carrier !== player.id) return { ok: false, reason: 'игрок не несёт ядро' };
      if (distance(player.last, layout.core.socket) > layout.core.insertRadius) {
        return { ok: false, reason: 'слишком далеко от приёмника' };
      }
      state.core.carrier = null;
      state.core.insertedInto = layout.core.socket.id;
      state.core.position = { ...layout.core.socket };
      state.core.velocity = { x: 0, y: 0, z: 0 };
      state.core.at = now;
      return { ok: true, relay: signatureRelay(room, now) };
    }

    return { ok: false, reason: 'неизвестное действие с ядром' };
  }

  if (command.startsWith('signal:press:')) {
    if (!layout.signal || !state.signal) return { ok: false, reason: 'в главе нет терминала' };
    const roles = signalRoles([...room.players.keys()]);
    if (player.id !== roles.operator) return { ok: false, reason: 'кнопки доступны оператору' };
    if (distance(player.last, layout.signal.operator) > SIGNATURE_INTERACT_RADIUS + 1) {
      return { ok: false, reason: 'слишком далеко от терминала' };
    }
    const index = Number.parseInt(command.slice('signal:press:'.length), 10);
    if (!Number.isSafeInteger(index) || index < 0 || index >= layout.signal.symbols.length) {
      return { ok: false, reason: 'неизвестная кнопка терминала' };
    }
    if (state.signal.solved) return { ok: true, relay: signatureRelay(room, now) };
    const expected = layout.signal.sequence[state.signal.progress];
    if (layout.signal.symbols[index] !== expected) state.signal.progress = 0;
    else state.signal.progress++;
    if (state.signal.progress >= layout.signal.sequence.length) state.signal.solved = true;
    return { ok: true, relay: signatureRelay(room, now) };
  }

  return { ok: false, reason: 'неизвестное signature-действие' };
}

// Проверка кооперативного события. Возвращает { ok, reason } либо { ok: true, relay } —
// объект, который надо разослать в комнату.
function validateCoopEvent(room, player, message, now = Date.now()) {
  const partner = [...room.players.values()].find(item => item.id !== player.id);

  switch (message.action) {
    case 'launch': {
      // Подброс применяется к НАПАРНИКУ, а не к себе, и бить может кто угодно — ролей нет.
      // Импульс считает инициатор, поэтому здесь ограничивается его модуль: это единственное
      // место, где один игрок может изменить состояние другого.
      if (!partner) return { ok: false, reason: 'напарника нет в комнате' };
      const catapult = findCatapult(room.spec, message.objectId);
      if (!catapult) return { ok: false, reason: 'неизвестная катапульта' };
      if (!nearPad(player.last, catapult, catapult.slamZ, CATAPULT_SLAM_RADIUS, 5)) {
        return { ok: false, reason: 'инициатор не у катапульты' };
      }
      if (!nearPad(partner.last, catapult, catapult.launchZ, CATAPULT_SEAT_RADIUS)) {
        return { ok: false, reason: 'напарник не на катапульте' };
      }
      if (now - (player.lastLaunchAt || 0) < LAUNCH_COOLDOWN_MS) {
        return { ok: false, reason: 'слишком часто' };
      }
      const vector = message.vector;
      if (!vector) return { ok: false, reason: 'нет вектора импульса' };
      const speed = Math.hypot(vector.x, vector.y, vector.z);
      if (speed > MAX_LAUNCH_SPEED) return { ok: false, reason: 'слишком сильный импульс' };
      const expected = { x: 0, y: catapult.power, z: -catapult.power * catapult.forward };
      if (distance(vector, expected) > CATAPULT_VECTOR_TOLERANCE) {
        return { ok: false, reason: 'неверный импульс катапульты' };
      }
      player.lastLaunchAt = now;
      return {
        ok: true,
        relay: {
          action: 'launch',
          from: player.id,
          target: partner.id,
          objectId: message.objectId || null,
          // Рассылаем значение из авторитетной спецификации, а не почти совпавшее клиентское.
          vector: expected
        }
      };
    }

    case 'revive': {
      // Оживление: подойти к упавшему напарнику. Проверяем расстояние — иначе поднимать можно было
      // бы с другого конца главы, и падение перестало бы что-либо значить.
      if (!partner) return { ok: false, reason: 'напарника нет в комнате' };
      if (!partner.downed) return { ok: false, reason: 'напарник не падал' };
      if (distance(player.last, partner.last) > REVIVE_RADIUS) {
        return { ok: false, reason: 'слишком далеко для оживления' };
      }
      partner.downed = false;
      partner.downedAt = 0;
      return { ok: true, relay: { action: 'revive', from: player.id, target: partner.id } };
    }

    case 'plate':
      // Осыпание — уже не локальная анимация: сервер выдаёт всем один момент начала. Канал plate
      // оставляем совместимым с протоколом и различаем объект по префиксу.
      if ((message.objectId || '').startsWith('collapse:')) {
        return validateCollapseEvent(room, player, message, now);
      }
      // Старые сообщения о плитах были no-op: их состояние выводится из позиций. Используем этот
      // уже совместимый объектный канал для новых signature-команд. Обычный legacy plate по-прежнему
      // принимается молча, поэтому старые клиенты не получают ошибок.
      if (/^(sig|core|signal):/.test(message.objectId || '')) {
        return validateSignatureEvent(room, player, message, now);
      }
      return { ok: true, relay: null };

    default:
      return { ok: false, reason: 'неизвестное действие' };
  }
}

// Игрок упал. В кооперативе это не откат обоих к чекпоинту, а ожидание напарника: цена ошибки
// общая, но она не отменяет уже пройденный участок.
function markDowned(player, now = Date.now()) {
  if (player.downed) return false;
  player.downed = true;
  player.downedAt = now;
  return true;
}

// Кого пора поднять самому. Возвращает список идентификаторов.
function autoRevive(room, now = Date.now()) {
  const revived = [];
  for (const player of room.players.values()) {
    if (!player.downed) continue;
    // Если напарник отключился, ждать некого — поднимаем сразу, иначе глава превращается в тупик.
    const partner = [...room.players.values()].find(item => item.id !== player.id);
    const alone = !partner || partner.disconnectedAt;
    if (alone || now - player.downedAt > AUTO_REVIVE_MS) {
      player.downed = false;
      player.downedAt = 0;
      revived.push(player.id);
    }
  }
  return revived;
}

// В кооперативе глава засчитывается только когда дошли оба. Одиночный финиш не завершает матч.
function coopComplete(room) {
  const active = [...room.players.values()].filter(player => !player.disconnectedAt);
  return active.length > 0 && active.every(player => player.finished);
}

module.exports = {
  MAX_LAUNCH_SPEED,
  REVIVE_RADIUS,
  AUTO_REVIVE_MS,
  LAUNCH_COOLDOWN_MS,
  findCatapult,
  ensureSignatureState,
  signatureSnapshot,
  validateSignatureEvent,
  validateCoopEvent,
  markDowned,
  autoRevive,
  coopComplete
};
