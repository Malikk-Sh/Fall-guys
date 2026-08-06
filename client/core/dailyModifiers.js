// Пул правил для испытания дня.
//
// Раньше правило было ровно одно: препятствия на 18% быстрее, цель — пройти без падений. Сид менялся
// каждый день, поэтому трасса выглядела новой, но играть её приходилось одинаково. Через несколько
// дней это становится заметно: меняется декорация, а не задача.
//
// Здесь два независимых набора — модификатор (как ведёт себя мир) и цель (что от игрока требуется).
// Их сочетание и составляет правило дня.

// Модификаторы. Каждый меняет одну понятную вещь, а не «сложность вообще»: игрок должен уметь
// назвать, что сегодня иначе, не заглядывая в описание второй раз.
//
// Поля читают Course (мир) и Player (управление); всё, чего в модификаторе нет, остаётся обычным.
export const DAILY_MODIFIERS = Object.freeze([
  Object.freeze({
    id: 'rush-hour',
    label: 'ЧАС ПИК',
    description: 'Препятствия движутся на 18% быстрее.',
    obstacleSpeed: 1.18
  }),
  Object.freeze({
    id: 'heavy-hand',
    label: 'ТЯЖЁЛАЯ РУКА',
    description: 'Бамперы и вертушки отбрасывают вдвое сильнее.',
    knockback: 2
  }),
  Object.freeze({
    id: 'no-wings',
    label: 'БЕЗ КРЫЛЬЕВ',
    description: 'Планирование отключено — падать придётся честно.',
    glide: false
  }),
  Object.freeze({
    id: 'turbo-dash',
    label: 'ТУРБО-РЫВОК',
    description: 'Рывок сильнее и восстанавливается вдвое быстрее.',
    dash: 1.4,
    dashCooldown: 0.5
  }),
  Object.freeze({
    id: 'moon-walk',
    label: 'ЛУННАЯ ПОХОДКА',
    description: 'Гравитация слабее, прыжок выше — и всё дольше висит в воздухе.',
    gravity: 0.72,
    jump: 1.12
  }),
  Object.freeze({
    id: 'black-ice',
    label: 'ГОЛОЛЁД',
    description: 'Разгон и торможение на земле вдвое медленнее.',
    groundGrip: 0.4
  }),
  Object.freeze({
    id: 'reverse',
    label: 'ОБРАТНЫЙ ХОД',
    description: 'Все вращения и качания идут в другую сторону.',
    obstacleDirection: -1
  }),
  Object.freeze({
    id: 'storm',
    label: 'ШТОРМ',
    description: 'Препятствия на 30% быстрее и отбрасывают в полтора раза сильнее.',
    obstacleSpeed: 1.3,
    knockback: 1.5
  })
]);

// Цели. Проверяются по итогам забега, поэтому каждой нужен только счётчик, который клиент и так
// ведёт: возвращения, время, рывки, попадания.
export const DAILY_OBJECTIVES = Object.freeze([
  Object.freeze({ id: 'no-falls', label: 'БЕЗ ПАДЕНИЙ', goal: 'пройти без единого падения' }),
  Object.freeze({
    id: 'few-falls',
    label: 'НЕ БОЛЬШЕ 2 ПАДЕНИЙ',
    goal: 'уложиться в два падения',
    limit: 2
  }),
  Object.freeze({
    id: 'under-time',
    label: 'УЛОЖИТЬСЯ ВО ВРЕМЯ',
    goal: 'уложиться в целевое время',
    // Доля от эталонного времени трассы. 1.05 — чуть свободнее золотой медали: цель должна быть
    // выполнимой в обычном забеге, а не только в идеальном.
    parRatio: 1.05
  }),
  Object.freeze({ id: 'no-dash', label: 'БЕЗ РЫВКА', goal: 'дойти, ни разу не рванув' }),
  Object.freeze({ id: 'no-hits', label: 'БЕЗ ПОПАДАНИЙ', goal: 'не поймать ни одного удара' })
]);

// Номер дня от фиксированной точки отсчёта. Именно он, а не сид: сид — случайное число, и брать
// от него остаток значило бы, что правило дня иногда повторяется два дня подряд, а иногда не
// выпадает месяцами.
export function dayNumber(dayKey) {
  const parsed = Date.parse(`${dayKey}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return 0;
  return Math.floor(parsed / 86_400_000);
}

// Выбор по дню с шагом, взаимно простым с длиной набора.
//
// Это даёт два свойства, которых не даёт остаток от случайного числа: каждое правило выпадает ровно
// раз за полный круг, и два дня подряд правило не повторяется. Игрок видит смену, а не случайность,
// которая иногда выглядит как её отсутствие.
function pick(list, stride, day) {
  const index = (((day * stride) % list.length) + list.length) % list.length;
  return list[index];
}

// Шаги подобраны взаимно простыми с длиной наборов: 3 и 8, 2 и 5. Длины разные (8 и 5), поэтому
// сочетание «модификатор + цель» повторяется только раз в сорок дней.
const MODIFIER_STRIDE = 3;
const OBJECTIVE_STRIDE = 2;

export function modifierForDay(dayKey) {
  return pick(DAILY_MODIFIERS, MODIFIER_STRIDE, dayNumber(dayKey));
}

export function objectiveForDay(dayKey) {
  return pick(DAILY_OBJECTIVES, OBJECTIVE_STRIDE, dayNumber(dayKey));
}

// Превращает описание цели в то, что можно проверить: подставляет целевое время там, где оно
// зависит от трассы. `par` приходит снаружи, чтобы этот модуль не знал про таблицу сложностей.
export function materializeObjective(objective, par) {
  if (objective.id !== 'under-time') return { id: objective.id, label: objective.label };
  return {
    id: objective.id,
    label: objective.label,
    targetMs: Math.round(par * objective.parRatio)
  };
}

// Проверка целей по итогам забега.
//
// Раньше здесь был единственный случай `no-falls`, а все остальные идентификаторы молча считались
// невыполненными. Теперь незнакомая цель — это ошибка сборки спеки, а не тихий провал: результат
// «не выполнено» неотличим от «не проверено», и отладить такое можно только чтением кода.
export function checkObjective(objective, { respawns = 0, time = 0, dashes = 0, hits = 0 } = {}) {
  switch (objective.id) {
    case 'no-falls':
      return respawns === 0;
    case 'few-falls':
      return respawns <= (objective.limit ?? 2);
    case 'under-time':
      return Number.isFinite(objective.targetMs) && time > 0 && time <= objective.targetMs;
    case 'no-dash':
      return dashes === 0;
    case 'no-hits':
      return hits === 0;
    default:
      return false;
  }
}
