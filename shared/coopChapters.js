// Кооперативные главы, описанные данными.
//
// Почему данными, а не процедурной генерацией. Гоночные трассы генерируются из сида, и это
// правильно: там ценность в разнообразии, а любая случайная расстановка препятствий проходима.
// С кооперативными задачами так нельзя. Головоломка «ИСКРА держит луч, пока ГРУЗ бежит по мосту»
// работает, только если мост нужной длины, излучатель виден с площадки ИСКРЫ, а обрыв достаточно
// широк, чтобы его нельзя было перепрыгнуть одному. Случайная расстановка либо сделает задачу
// нерешаемой, либо позволит пройти её в одиночку — и то и другое убивает смысл кооператива.
//
// Модуль общий с сервером: сервер по нему выводит чекпоинты и проверяет финиш, не строя геометрию.
//
// ---
//
// Формат: глава — это последовательность отрезков вдоль оси Z, а не список координат.
//
// Так сделано намеренно. При ручной расстановке координат легко получить отрезок, наложенный на
// соседний, или пропасть, которой на деле нет, потому что её перекрывает пол. Ошибка при этом
// молчаливая: уровень строится, выглядит правдоподобно, но головоломка проходится в обход. Когда
// геометрия набирается отрезками подряд, такие ошибки невозможны по построению.
//
// Ключевой приём: в игре нет боковых столкновений — сквозь стену игрок просто пройдёт. Поэтому
// преграда здесь не стена, а ОТСУТСТВИЕ ПОЛА. «Ворота» — это выдвижной пролёт над пропастью:
// закрыты — провала не перейти, открыты — пролёт появился. Такую преграду нельзя обойти сбоку и
// нельзя проскочить рывком, и работает она на той физике, что уже есть.
//
// Правило проектирования: в каждой главе есть участок, который физически невозможно пройти одному.
// Не «вдвоём быстрее», а «одному никак».

import { COOP_ROLE } from './protocol.js';

// Ширина дорожки. Общая для всех глав: габариты должны считываться с первого взгляда.
export const LANE_WIDTH = 12;

// Пропасть шире этого прыжком не берётся. Значение с запасом: обычный прыжок покрывает около
// шести единиц, рывок в прыжке — примерно девять. Всё, что должно требовать напарника, делаем
// не короче двенадцати.
export const UNJUMPABLE_GAP = 12;

// --- Конструкторы отрезков -------------------------------------------------------------------

// Обычный пол. props — предметы на нём (плиты, катапульты, площадки, ветер).
const floor = (length, props = []) => ({ kind: 'floor', length, props });

// Пропасть. Перейти можно только по пролёту, который над ней появится.
const gap = length => ({ kind: 'gap', length });

// Выдвижной пролёт над пропастью, управляемый плитами. Пока нажаты все плиты из requires —
// пол есть; отпустил — исчез.
const gateSpan = (id, length, requires) => ({ kind: 'gateSpan', id, length, requires });

// Световой мост: существует, пока ИСКРА держит луч на связанном излучателе.
//
// `latch` — плита на дальней стороне, которая фиксирует мост насовсем. Без неё головоломка не
// решается вовсе: ИСКРА держит луч, стоя на площадке, ГРУЗ переходит — а сама ИСКРА перейти уже
// не может, потому что мост исчезнет в тот же миг, как она сойдёт с площадки и потеряет наводку.
// Поэтому связка всегда трёхтактная: ИСКРА держит → ГРУЗ переходит → ГРУЗ давит фиксатор → ИСКРА
// переходит по закреплённому мосту.
const beamSpan = (id, length, emitter, latch) => ({ kind: 'beamSpan', id, length, emitter, latch });

// Ворота синхронности: пролёт появляется, только если оба пересекли черту почти одновременно.
const syncSpan = (id, length, windowMs = 800) => ({ kind: 'syncSpan', id, length, windowMs });

// Качающаяся платформа над пропастью — цель для подброса.
const movingSpan = (length, { range = 4, speed = 0.7 } = {}) => ({
  kind: 'movingSpan',
  length,
  range,
  speed
});

const checkpoint = () => ({ kind: 'checkpoint' });

// --- Предметы на полу ------------------------------------------------------------------------

// Плита. role: 'any' — сработает под любым, 'anchor' — только под тяжёлым ГРУЗОМ.
const plate = (id, x, role = 'any') => ({ type: 'plate', id, x, role });

// Катапульта: ГРУЗ бьёт ударом сверху, стоящего на длинном плече подбрасывает.
const catapult = (id, x, power = 18) => ({ type: 'catapult', id, x, power });

// Возвышенная площадка сбоку: с неё ИСКРА наводит луч, но на сам мост с неё не попасть.
const perch = (id, x, height = 2.6) => ({ type: 'perch', id, x, height });

// Излучатель на площадке. Пока луч держат, связанный мост существует.
const emitter = (id, x, height = 3.8) => ({ type: 'emitter', id, x, height });

// Ветер: сдувает лёгкую ИСКРУ, тяжёлый ГРУЗ проходит спокойно.
const wind = force => ({ type: 'wind', force });

// --- Главы -------------------------------------------------------------------------------------

const CHAPTERS = [
  {
    id: 'ch1',
    title: 'ПЕРВЫЕ ШАГИ',
    subtitle: 'Двое сильнее одного',
    hint: 'Встаньте на плиты вдвоём — пролёт выдвинется, пока держите обе.',
    // Обучающая глава. Одна механика, поданная дважды: сначала обе плиты одинаковые, потом одна
    // становится тяжёлой — и роли перестают быть взаимозаменяемыми.
    segments: [
      floor(22),
      floor(20, [plate('p1', -4.2), plate('p2', 4.2)]),
      gateSpan('g1', UNJUMPABLE_GAP + 2, ['p1', 'p2']),
      floor(12),
      checkpoint(),

      floor(20, [plate('p3', -4.2, COOP_ROLE.ANCHOR), plate('p4', 4.2)]),
      gateSpan('g2', UNJUMPABLE_GAP + 4, ['p3', 'p4']),
      floor(14),
      checkpoint(),

      floor(16),
      gap(5),
      floor(18),
      checkpoint(),
      floor(18)
    ]
  },

  {
    id: 'ch2',
    title: 'КАЧЕЛИ',
    subtitle: 'Подбрось напарника',
    hint: 'ГРУЗ бьёт по качелям ударом сверху — ИСКРУ подбрасывает через пропасть.',
    segments: [
      floor(22),
      floor(16),
      checkpoint(),

      // Пропасть шире любого прыжка: перелететь можно только с подброса.
      //
      // Пролёт здесь убран, и это принципиально: ИСКРУ подбрасывает НАД ним, а ГРУЗ остаётся на
      // этой стороне. Пока ИСКРА не встанет на плиту напротив, ГРУЗУ пути нет — то есть подброс
      // нельзя «сэкономить» и пройти вдвоём обычным ходом.
      floor(14, [catapult('c1', 0)]),
      gateSpan('g1', UNJUMPABLE_GAP + 4, ['p1']),
      floor(14, [plate('p1', 0)]),
      checkpoint(),

      floor(18, [catapult('c2', -3.5, 20)]),
      // Вторая катапульта сложнее: приземляться нужно на качающуюся площадку.
      gap(6),
      movingSpan(7, { range: 4.5, speed: 0.75 }),
      gap(6),
      floor(16),
      checkpoint(),
      floor(18)
    ]
  },

  {
    id: 'ch3',
    title: 'СВЕТ И ТЯЖЕСТЬ',
    subtitle: 'Держи луч',
    hint: 'ИСКРА наводит луч на излучатель и держит — пока держит, мост существует.',
    segments: [
      floor(22),
      floor(16),
      checkpoint(),

      // Площадка ИСКРЫ сбоку и выше: с неё виден излучатель, но на мост с неё не сойти.
      floor(14, [perch('perch1', -9), emitter('e1', -9)]),
      beamSpan('b1', UNJUMPABLE_GAP + 6, 'e1', 'p1'),
      // ГРУЗ перешёл и давит тяжёлый фиксатор — мост закрепляется, и ИСКРА идёт следом.
      floor(14, [plate('p1', 0, COOP_ROLE.ANCHOR)]),
      checkpoint(),

      floor(18, [perch('perch2', 9), emitter('e2', 9)]),
      beamSpan('b2', UNJUMPABLE_GAP + 10, 'e2', 'p2'),
      floor(16, [plate('p2', 0, COOP_ROLE.ANCHOR)]),
      checkpoint(),
      floor(18)
    ]
  },

  {
    id: 'ch4',
    title: 'ВЕТРЕНЫЙ ПРОЛЁТ',
    subtitle: 'Прикрой лёгкого',
    hint: 'Ветер сдувает ИСКРУ, а ГРУЗ стоит твёрдо. Держите плиты и не давайте себя снести.',
    segments: [
      floor(22),
      floor(18),
      checkpoint(),

      // Ветер плюс парные плиты: ИСКРЕ надо удержаться на плите, пока её сносит вбок.
      floor(20, [wind(7), plate('p1', -4.2), plate('p2', 4.2, COOP_ROLE.ANCHOR)]),
      gateSpan('g1', UNJUMPABLE_GAP + 2, ['p1', 'p2']),
      floor(14),
      checkpoint(),

      // Ветер над лучом: ИСКРА держит наводку, стоя под порывами.
      floor(16, [perch('perch1', -9), emitter('e1', -9), wind(6)]),
      beamSpan('b1', UNJUMPABLE_GAP + 6, 'e1', 'p3'),
      floor(14, [plate('p3', 0, COOP_ROLE.ANCHOR)]),
      checkpoint(),

      floor(16, [catapult('c1', 0, 19)]),
      gap(UNJUMPABLE_GAP + 2),
      floor(16),
      checkpoint(),
      floor(18)
    ]
  },

  {
    id: 'ch5',
    title: 'ВМЕСТЕ ДО КОНЦА',
    subtitle: 'Всё разом',
    hint: 'Финал. На последних воротах пересеките черту одновременно — по очереди не выйдет.',
    segments: [
      floor(22),
      floor(18),
      checkpoint(),

      floor(18, [plate('p1', -4.2, COOP_ROLE.ANCHOR), plate('p2', 4.2)]),
      gateSpan('g1', UNJUMPABLE_GAP, ['p1', 'p2']),
      floor(14, [catapult('c1', 0, 19)]),
      gap(UNJUMPABLE_GAP + 2),
      floor(14),
      checkpoint(),

      floor(16, [perch('perch1', 9), emitter('e1', 9), wind(6.5)]),
      beamSpan('b1', UNJUMPABLE_GAP + 8, 'e1', 'p3'),
      floor(14, [plate('p3', 0, COOP_ROLE.ANCHOR), plate('p4', 4.2)]),
      gateSpan('g2', UNJUMPABLE_GAP, ['p3', 'p4']),
      floor(14),
      checkpoint(),

      // Финальные ворота: их не обмануть, проходя по очереди.
      floor(18),
      syncSpan('s1', UNJUMPABLE_GAP + 2),
      floor(16),
      checkpoint(),
      floor(18)
    ]
  }
];

// --- Разбор глав в геометрию --------------------------------------------------------------------

// Первый отрезок начинается здесь; дальше уровень уходит в минус по Z, как и гоночные трассы.
const START_Z = 14;

// Раскладывает отрезки главы в абсолютные координаты. Результат используется и клиентом для
// постройки геометрии, и сервером для проверки чекпоинтов и финиша — обе стороны видят одно и то же.
export function layoutChapter(chapter) {
  const pieces = [];
  const checkpoints = [];
  let z = START_Z;

  for (const segment of chapter.segments) {
    if (segment.kind === 'checkpoint') {
      // Арка ставится на текущей границе между отрезками и не занимает длины.
      checkpoints.push(z);
      continue;
    }
    const length = segment.length;
    const center = z - length / 2;
    if (segment.kind !== 'gap') {
      pieces.push({ ...segment, z: center, width: LANE_WIDTH });
    }
    z -= length;
  }

  return { pieces, checkpoints, endZ: z };
}

const LAID_OUT = new Map();
function layoutOf(chapter) {
  let cached = LAID_OUT.get(chapter.id);
  if (!cached) {
    cached = layoutChapter(chapter);
    LAID_OUT.set(chapter.id, cached);
  }
  return cached;
}

export const COOP_CHAPTERS = CHAPTERS.map(chapter => {
  const layout = layoutOf(chapter);
  return {
    ...chapter,
    checkpoints: layout.checkpoints,
    segmentCount: layout.checkpoints.length,
    // Финишная черта — за концом последнего отрезка.
    finishZ: layout.endZ + 6
  };
});

export const COOP_CHAPTER_IDS = COOP_CHAPTERS.map(chapter => chapter.id);

export function getChapter(id) {
  return COOP_CHAPTERS.find(chapter => chapter.id === id) || COOP_CHAPTERS[0];
}

export function chapterLayout(id) {
  return layoutOf(getChapter(id));
}

// Спека в том же виде, что и у гоночной трассы: сервер работает с ними одинаково и не знает,
// проверяет он процедурную трассу или рукотворную главу.
export function coopSpec(chapterId) {
  const chapter = getChapter(chapterId);
  return {
    seed: 0,
    chapterId: chapter.id,
    difficulty: 'coop',
    title: chapter.title,
    subtitle: chapter.subtitle,
    hint: chapter.hint,
    segmentCount: chapter.segmentCount,
    checkpoints: [...chapter.checkpoints],
    finishZ: chapter.finishZ,
    start: { x: 0, y: 1.2, z: START_Z - 4 },
    // Роли стартуют рядом, но не в одной точке — иначе на старте они выталкивают друг друга.
    starts: {
      [COOP_ROLE.SPARK]: { x: -2.2, y: 1.2, z: START_Z - 4 },
      [COOP_ROLE.ANCHOR]: { x: 2.2, y: 1.2, z: START_Z - 4 }
    }
  };
}

// Точка возрождения: сразу за пройденной аркой, чтобы игрок не пересекал её повторно.
export function coopSpawnFor(spec, checkpoint = 0, role = COOP_ROLE.SPARK) {
  if (checkpoint <= 0) return { ...(spec.starts?.[role] || spec.start) };
  const index = Math.min(checkpoint - 1, spec.checkpoints.length - 1);
  return { x: role === COOP_ROLE.SPARK ? -2.2 : 2.2, y: 1.35, z: spec.checkpoints[index] - 3.1 };
}
