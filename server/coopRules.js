// Правила кооперативного режима на сервере.
//
// Модель авторитета здесь намеренно лёгкая. Сервер не симулирует физику: в кооперативе на двух
// друзей обман никому не вредит, а полная серверная симуляция потребовала бы держать на сервере
// копию всей геометрии уровня. Вместо этого действуют два принципа.
//
// Первый: почти всё состояние выводимое. Нажата ли плита, выдвинут ли пролёт — это следствие
// позиций обоих игроков, а обе позиции у каждого клиента уже есть. Сервер в таких решениях не
// участвует вовсе, и рассинхрона не возникает, потому что оба считают одно и то же по одним данным.
//
// Второй: то, что из позиции не выводится, шлёт инициатор, а сервер проверяет правдоподобие и
// ретранслирует. Таких действий осталось два — удар катапульты и оживление напарника. Проверяется
// не «правда ли это», а «мог ли игрок это сделать»: разумное расстояние, ограниченная сила, не
// чаще разумного. Проверок роли больше нет, потому что нет и ролей.

// Максимальный модуль импульса подброса. Катапульты в главах используют силу 18–20; потолок с
// запасом отсекает попытку зашвырнуть напарника за пределы карты, не мешая честной игре.
const MAX_LAUNCH_SPEED = 32;

// На каком расстоянии можно оживить напарника.
const REVIVE_RADIUS = 4.5;

// Не чаще одного подброса раз в столько миллисекунд — от случайной серии ударов.
const LAUNCH_COOLDOWN_MS = 900;

// Сколько игрок лежит «пузырём», прежде чем подняться сам. Нужен именно потолок ожидания:
// без него пара, где один отошёл от устройства, застревала бы в главе навсегда.
const AUTO_REVIVE_MS = 12_000;

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
      if (now - (player.lastLaunchAt || 0) < LAUNCH_COOLDOWN_MS) {
        return { ok: false, reason: 'слишком часто' };
      }
      const vector = message.vector;
      if (!vector) return { ok: false, reason: 'нет вектора импульса' };
      const speed = Math.hypot(vector.x, vector.y, vector.z);
      if (speed > MAX_LAUNCH_SPEED) return { ok: false, reason: 'слишком сильный импульс' };
      // Бить можно только по катапульте рядом с собой, а подбрасывает того, кто на ней стоит.
      if (distance(player.last, partner.last) > 40) {
        return { ok: false, reason: 'напарник слишком далеко' };
      }
      player.lastLaunchAt = now;
      return {
        ok: true,
        relay: {
          action: 'launch',
          from: player.id,
          target: partner.id,
          objectId: message.objectId || null,
          vector: { x: vector.x, y: vector.y, z: vector.z }
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
      // Эти действия выводятся из позиций и по сети не нужны. Принимаем молча, чтобы старый
      // клиент не получал ошибку, но ничего не делаем.
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
  validateCoopEvent,
  markDowned,
  autoRevive,
  coopComplete
};
