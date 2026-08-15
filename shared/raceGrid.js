// Стартовая решётка соревновательной гонки.
//
// До этого все участники получали одну и ту же точку `spec.start`. На первом кадре персонажи
// оказывались внутри друг друга, подписи накладывались, а физика начинала забег с взаимного
// выталкивания. Теперь одну и ту же функцию используют клиент, серверная позиция checkpoint 0 и
// внутренняя физика ботов, поэтому расстановка остаётся авторитетной и после раннего падения.
//
// Ряды неизбежно немного различаются по Z: шестнадцать капсул физически не помещаются в одну
// линию. Identity к ряду не привязана — server/raceSlots.js заново перемешивает slot'ы по случайному
// matchId каждого забега, поэтому joinOrder/хост не получают постоянной продольной форы.

export const RACE_GRID_COLUMNS = 4;
export const RACE_GRID_X_SPACING = 1.75;
export const RACE_GRID_Z_SPACING = 1.3;

export function raceSpawnFor(spec, slot = 0, total = 1) {
  const start = spec?.start || { x: 0, y: 1.2, z: 7 };
  const count = Math.max(1, Math.min(16, Math.floor(Number(total) || 1)));
  const index = Math.max(0, Math.min(count - 1, Math.floor(Number(slot) || 0)));
  if (count === 1) return { ...start };

  const columns = Math.min(RACE_GRID_COLUMNS, count);
  const rows = Math.ceil(count / columns);
  const row = Math.floor(index / columns);
  const firstInRow = row * columns;
  const rowSize = Math.min(columns, count - firstInRow);
  const column = index - firstInRow;

  // Каждый неполный ряд центрируется отдельно. Поэтому, например, пятый игрок не оказывается
  // на левом краю решётки один — он стоит по центру второго ряда.
  const x = start.x + (column - (rowSize - 1) / 2) * RACE_GRID_X_SPACING;
  // Ряды центрируются вокруг прежней стартовой линии: средняя дистанция группы остаётся прежней.
  // Какая identity попадёт в конкретный ряд, решает сервер заново на каждый matchId.
  const z = start.z + (row - (rows - 1) / 2) * RACE_GRID_Z_SPACING;
  return { x, y: start.y, z };
}
