// Мягкое локальное разрешение столкновений. Сервер по-прежнему принимает только движение
// владельца персонажа: чужой снапшот используется как подвижное препятствие, но никогда не
// переписывается. Поэтому небольшая ошибка предсказания превращается в плавное расхождение, а не
// в сетевой «пинг-понг» двух жёстких тел.
export const PLAYER_RADIUS = 0.72;
const MAX_PUSH_SPEED = 2.8;
const IMPULSE_TRANSFER = 0.16;
const MAX_TOTAL_PUSH = 0.055;

function overlapDirection(localId, otherId) {
  if (!localId || !otherId || localId === otherId) return { x: 1, z: 0 };
  const pair = localId < otherId ? `${localId}|${otherId}` : `${otherId}|${localId}`;
  let hash = 0;
  for (let index = 0; index < pair.length; index++) hash = (hash * 31 + pair.charCodeAt(index)) >>> 0;
  const angle = (hash / 0xffffffff) * Math.PI * 2;
  const sign = localId < otherId ? -1 : 1;
  return { x: Math.cos(angle) * sign, z: Math.sin(angle) * sign };
}

export function resolvePlayerCrowd(local, others, dt, localId = '') {
  if (!local || local.finished || local.downed || !Number.isFinite(dt) || dt <= 0) return 0;
  let contacts = 0;
  let totalX = 0;
  let totalZ = 0;

  for (const entry of others) {
    const [otherId, other] = Array.isArray(entry) ? entry : ['', entry];
    if (!other || other.finished || other.downed) continue;
    if (Math.abs(local.position.y - other.position.y) > 1.45) continue;
    let dx = local.position.x - other.position.x;
    let dz = local.position.z - other.position.z;
    const distanceSq = dx * dx + dz * dz;
    const diameter = PLAYER_RADIUS * 2;
    if (distanceSq >= diameter * diameter) continue;

    // При полном совпадении выбираем стабильное направление. Случайное направление заставило бы
    // клиентов разойтись в разные стороны на каждом кадре и выглядело бы как дрожание.
    const distance = Math.sqrt(distanceSq);
    if (distance < 0.001) {
      const direction = overlapDirection(localId, otherId);
      dx = direction.x;
      dz = direction.z;
    } else {
      dx /= distance;
      dz /= distance;
    }
    const overlap = diameter - distance;
    const push = Math.min(overlap * 8, MAX_PUSH_SPEED) * dt;
    totalX += dx * push;
    totalZ += dz * push;

    // Часть импульса толпы передаётся владельцу, но ограничена: столкновение чувствуется после
    // контакта и не позволяет удалённому снапшоту катапультировать игрока с трассы.
    // У удалённого Player физический velocity намеренно не симулируется; актуальная скорость
    // лежит в интерполированном target. Fallback нужен чистым unit-тестам и локальным ботам.
    const ovx = other.target?.vx ?? other.velocity?.x ?? 0;
    const ovz = other.target?.vz ?? other.velocity?.z ?? 0;
    const along = (ovx - local.velocity.x) * dx + (ovz - local.velocity.z) * dz;
    if (along > 0) {
      local.velocity.x += dx * along * IMPULSE_TRANSFER;
      local.velocity.z += dz * along * IMPULSE_TRANSFER;
    }
    contacts++;
  }
  // Несколько соперников не должны суммарно вытолкнуть игрока дальше, чем один безопасный
  // физический шаг. Направление толпы сохраняется, величина ограничивается.
  const total = Math.hypot(totalX, totalZ);
  if (total > MAX_TOTAL_PUSH) {
    totalX *= MAX_TOTAL_PUSH / total;
    totalZ *= MAX_TOTAL_PUSH / total;
  }
  local.position.x += totalX;
  local.position.z += totalZ;
  return contacts;
}
