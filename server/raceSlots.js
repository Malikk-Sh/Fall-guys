'use strict';

const crypto = require('node:crypto');

// Стартовые ряды имеют небольшую разницу по Z — иначе 16 капсул физически не поместятся рядом.
// Поэтому привязывать номер клетки к joinOrder несправедливо: хост и пришедшие первыми получали бы
// один и тот же ряд в каждом реванше. Матч уже имеет случайный matchId; используем его как соль для
// детерминированной перестановки участников. Сервер рассылает готовые slot'ы клиентам, так что
// никакой второй случайности на клиентах нет.
function raceSlotOrder(players, entropy) {
  const salt = String(entropy || 'race');
  return [...players]
    .sort((a, b) => a.joinOrder - b.joinOrder)
    .map(player => ({
      player,
      key: crypto.createHash('sha256').update(`${salt}:${player.id}`).digest('hex')
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.player.joinOrder - b.player.joinOrder)
    .map(entry => entry.player);
}

function assignRaceSlots(room, entropy) {
  const ordered = raceSlotOrder(room?.players?.values?.() || [], entropy);
  ordered.forEach((player, index) => {
    player.slot = index;
  });
  return ordered;
}

module.exports = { raceSlotOrder, assignRaceSlots };
