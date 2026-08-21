// Отскок от стены.
//
// Только явно помеченные стены участвуют в приёме: обычная декорация и борта трассы никогда не
// меняют движение, поэтому приём остаётся читаемым и не удивляет новичка.
//
// Живёт в общем коде по той же причине, что опора и импульсы: серверная симуляция обязана считать
// отскок тем же правилом, иначе игрок, оттолкнувшийся от стены, разойдётся с сервером на ровном
// месте. Стена описана числами, меш в проверку не входит.

// Скорость, с которой игрока отбрасывает от стены по нормали.
export const WALL_BOUNCE_SPEED = 8.8;

// Насколько скорость вдоль стены сохраняется после отскока: приём не гасит темп, а разворачивает.
const WALL_TANGENT_RETENTION = 0.72;

// Нормаль стены, пересечённой за текущий физический шаг, либо null.
export function wallBounceNormalAt(walls, position, previous, velocity, playerRadius = 0) {
  if (!Array.isArray(walls)) return null;
  for (const wall of walls) {
    if (Math.abs(position.y - wall.y) > wall.h / 2 + 0.45) continue;
    const withinX = Math.abs(position.x - wall.x) <= wall.w / 2 + playerRadius;
    const withinZ = Math.abs(position.z - wall.z) <= wall.d / 2 + playerRadius;
    if (!withinX || !withinZ) continue;

    if (wall.w < wall.d) {
      const side = Math.sign(previous.x - wall.x) || -Math.sign(velocity.x) || 1;
      if (velocity.x * side < -1.5) return { x: side, z: 0 };
    } else {
      const side = Math.sign(previous.z - wall.z) || -Math.sign(velocity.z) || 1;
      if (velocity.z * side < -1.5) return { x: 0, z: side };
    }
  }
  return null;
}

// Сам отскок: игрок возвращается к позиции до шага по оси стены и получает скорость по нормали.
//
// Состояние правится на месте — как и у импульсов препятствий, выталкивание обязано попасть в ту
// самую позицию физики. Наружу отдаётся нормаль: подача по ней разворачивает персонажа, но на
// игровое состояние не влияет.
export function applyWallBounce(state, normal, previous, { jumpSpeed = 0 } = {}) {
  if (!normal) return { state, bounced: false };
  if (normal.x) state.position.x = previous.x;
  if (normal.z) state.position.z = previous.z;

  const tangentX = normal.z;
  const tangentZ = -normal.x;
  const along = state.velocity.x * tangentX + state.velocity.z * tangentZ;
  state.velocity.x = normal.x * WALL_BOUNCE_SPEED + tangentX * along * WALL_TANGENT_RETENTION;
  state.velocity.z = normal.z * WALL_BOUNCE_SPEED + tangentZ * along * WALL_TANGENT_RETENTION;
  state.velocity.y = Math.max(state.velocity.y, jumpSpeed * 0.82);
  state.jumpBuffer = 0;
  state.diveTimer = 0;
  state.rollTimer = 0;
  state.recoveryWindow = 0;
  return { state, bounced: true, normal };
}
