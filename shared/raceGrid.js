// Стартовая решётка соревновательной гонки.
//
// До этого все участники получали одну и ту же точку `spec.start`. На первом кадре персонажи
// оказывались внутри друг друга, подписи накладывались, а физика начинала забег с взаимного
// выталкивания. Решётка намеренно компактная: сервер до первого state-пакета всё ещё помнит
// центральную стартовую точку, поэтому максимальное смещение остаётся внутри обычного бюджета
// первого шага античита и не вызывает коррекцию.

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
  // Ряды центрируются вокруг прежней стартовой линии: решётка не даёт всей группе скрытую фору
  // или штраф относительно старой геометрии трассы.
  const z = start.z + (row - (rows - 1) / 2) * RACE_GRID_Z_SPACING;
  return { x, y: start.y, z };
}
