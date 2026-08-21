// Варианты сегментов трассы.
//
// Раньше вариантов было три, и различались они зеркалом по X и знаком скорости вращения. На бумаге
// это «три варианта», в игре — один и тот же сегмент: те же препятствия в тех же местах, только
// крутятся в другую сторону. Пройдя трассу дважды, игрок знал наизусть всё.
//
// Здесь варианты различаются РАССТАНОВКОЙ: сколько препятствий, где они стоят, какой оставляют
// проход и какого поведения требуют. Один и тот же тип может просить пробежать по прямой между
// ударами, прижаться к краю, дождаться окна или наоборот не прыгать.
//
// Правила, которые нельзя нарушать при добавлении варианта:
//
//   1. Опора не выходит за SEGMENT_WIDTH этого типа. Сервер по этому же числу определяет, где на
//      трассе есть пол: платформа шире объявленной ширины означала бы, что честный игрок, стоящий
//      на её краю, выглядит стоящим в пустоте.
//   2. Верх любой опоры не выше 1.7. Игрок стоит на 0.48 выше опоры, а серверная полоса высоты
//      стояния кончается на 2.4.
//   3. Вариант обязан проходиться. Это проверяется не глазами, а ботом: server/coursePlan.test.mjs
//      прогоняет каждый тип в каждом варианте односегментной трассой.

import { COLORS } from './palette.js';

// Высота, на которой балка не достаёт стоящего игрока, но достаёт прыгающего.
//
// Столкновение с вертушкой считается по |y игрока − y балки| < 1.05. Стоящий игрок находится на
// 0.98, вершина прыжка — 2.66. Балка на 2.4 пропускает бегущего и бьёт того, кто прыгнул.
const OVERHEAD_Y = 2.4;

// Пол сегмента. Почти всем вариантам нужен именно он — сплошная плита во всю длину.
function slab(course, ctx, { z = ctx.z, w = ctx.width, d = 18, y = 0 } = {}) {
  return course.box({ x: 0, y, z, w, h: 1, d, color: ctx.color, bevel: true });
}

function rails(course, ctx, x, length = 16, z = ctx.z) {
  course.addRail(-x, z, length);
  course.addRail(x, z, length);
}

// Подвижная платформа. Ход по X ограничен так, чтобы дальняя точка укладывалась в коридор типа.
function slider(course, ctx, { x = 0, y = 0.15, z, w = 3.8, d = 3, axis = 'x', range, speed, phase }) {
  const platform = course.box({
    x,
    y,
    z,
    w,
    h: 0.55,
    d,
    color: ctx.palette[(ctx.index + Math.round(z) + 2) % ctx.palette.length],
    bevel: true
  });
  platform.motion = { axis, origin: axis === 'x' ? x : z, range, speed, phase };
  course.dynamic.push(platform);
  return platform;
}

function puncher(course, ctx, { x, z, range, speed, phase }) {
  const w = 3.15;
  const h = 2.35;
  const d = 1.4;
  const mesh = course.box({
    x,
    y: 1,
    z,
    w,
    h,
    d,
    color: COLORS.pink,
    collider: false
  }).mesh;
  mesh.scale.z = 0.86;
  course.registerObstacle({
    type: 'puncher',
    mesh,
    x,
    y: 1,
    z,
    originX: x,
    range,
    speed,
    phase,
    w,
    d,
    radius: Math.hypot(w, d) / 2
  });
}

// --- ПЛОЩАДЬ ВРАЩЕНИЯ -------------------------------------------------------------------------
//
// Балки на ступицах. Тип про то, чтобы поймать момент и пробежать.

const sweepers = [
  // Встречное вращение: две балки крутятся навстречу друг другу. Окно открывается дважды за оборот.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    for (const [offset, direction] of [
      [4, 1],
      [-4, -1]
    ])
      course.addSpinner(
        0,
        0.95,
        ctx.z + offset,
        10.4,
        0.42,
        ctx.speed * 1.5 * direction,
        ctx.index * 0.8 + offset
      );
  },

  // Волна: три балки в одну сторону со сдвигом фазы. Проход есть всегда, но он едет вместе с
  // волной — надо не ждать окна, а бежать вместе с ним.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    for (let j = 0; j < 3; j++)
      course.addSpinner(0, 0.95, ctx.z + 5.5 - j * 5.5, 9.6, 0.4, ctx.speed * 1.25, j * 2.09);
  },

  // Два круга по сторонам: ступицы разнесены, балки короче. Середина свободна ровно тогда, когда
  // обе балки смотрят наружу, — узкое общее окно вместо двух отдельных.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    for (const side of [-1, 1])
      course.addSpinner(
        side * 3,
        0.95,
        ctx.z + side * 3.5,
        7.2,
        0.4,
        ctx.speed * 1.35 * side,
        side > 0 ? 0 : 1.6
      );
  },

  // Пригнись: одна балка на уровне бега, вторая — над головой. Верхняя не трогает бегущего и бьёт
  // того, кто прыгнул. Единственный вариант, где прыжок вредит.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    course.addSpinner(0, 0.95, ctx.z + 5, 10.4, 0.42, ctx.speed * 1.3, 0);
    course.addSpinner(0, OVERHEAD_Y, ctx.z - 4, 11, 0.5, ctx.speed * 0.9, 1.2);
  },

  // Одна длинная и медленная. Балка выметает всю площадь, зато времени на перебежку много: тип
  // про терпение, а не про реакцию.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    course.addSpinner(0, 0.95, ctx.z, 13, 0.5, ctx.speed * 0.62, ctx.index * 0.5);
  }
];

// --- НЕБЕСНЫЕ СТУПЕНИ -------------------------------------------------------------------------
//
// Две площадки и что-то подвижное между ними. Тип про прыжки по движущемуся.

function moverPads(course, ctx) {
  slab(course, ctx, { z: ctx.z + 7, d: 4 });
  slab(course, ctx, { z: ctx.z - 7, d: 4 });
}

const movers = [
  // Маятник: три платформы качаются поперёк, каждая своим темпом.
  (course, ctx) => {
    moverPads(course, ctx);
    for (let j = 0; j < 3; j++)
      slider(course, ctx, {
        z: ctx.z + 3.5 - j * 3.5,
        range: 3.8,
        speed: ctx.speed * (0.82 + j * 0.13),
        phase: j * 2.15
      });
  },

  // Лесенка: платформы поднимаются. Прыгать приходится не только вперёд, но и вверх, а сверху
  // виднее следующая.
  (course, ctx) => {
    moverPads(course, ctx);
    for (let j = 0; j < 3; j++)
      slider(course, ctx, {
        y: 0.15 + j * 0.5,
        z: ctx.z + 3.5 - j * 3.5,
        range: 2.6,
        speed: ctx.speed * 0.9,
        phase: j * 1.6
      });
  },

  // Встречные: средняя платформа идёт против крайних. Прыгать надо в момент, когда соседние
  // сходятся, — окно короткое и повторяется реже.
  (course, ctx) => {
    moverPads(course, ctx);
    for (let j = 0; j < 3; j++)
      slider(course, ctx, {
        z: ctx.z + 3.5 - j * 3.5,
        range: 3.4,
        speed: ctx.speed * 0.95 * (j === 1 ? -1 : 1),
        phase: 0
      });
  },

  // Челнок: две широкие платформы ходят вдоль трассы. Прыгать некуда — надо заехать.
  (course, ctx) => {
    moverPads(course, ctx);
    for (const [j, z] of [
      [0, ctx.z + 2.5],
      [1, ctx.z - 2.5]
    ])
      slider(course, ctx, {
        z,
        w: 5,
        d: 3.4,
        axis: 'z',
        range: 2.4,
        speed: ctx.speed * (0.75 + j * 0.2),
        phase: j * 3.14
      });
  },

  // Остров: неподвижная площадка посередине и две подвижные по краям. Единственный вариант, где
  // можно остановиться и подумать, — передышка в середине трассы.
  (course, ctx) => {
    moverPads(course, ctx);
    course.box({
      x: 0,
      y: 0.15,
      z: ctx.z,
      w: 4.4,
      h: 0.55,
      d: 3.4,
      color: ctx.palette[(ctx.index + 4) % ctx.palette.length],
      bevel: true
    });
    for (const [j, z] of [
      [0, ctx.z + 3.6],
      [1, ctx.z - 3.6]
    ])
      slider(course, ctx, {
        z,
        range: 3.6,
        speed: ctx.speed * (0.85 + j * 0.2),
        phase: j * 2.4
      });
  }
];

// --- БУЛЬВАР БАМПЕРОВ -------------------------------------------------------------------------
//
// Неподвижные отбойники. Тип про выбор траектории: они не двигаются, но раскиданы так, что
// прямой дороги нет.

const bumpers = [
  // Зигзаг: классика, объезд слева-справа-слева.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    const points = [
      [-3, 5],
      [2.7, 1],
      [-2.6, -3],
      [2.4, -6]
    ];
    points.forEach(([x, oz], j) =>
      course.addBumper(
        x * ctx.mirror,
        1.25,
        ctx.z + oz,
        0.86,
        ctx.palette[(ctx.index + j + 3) % ctx.palette.length]
      )
    );
  },

  // Коридор: два ряда по краям, середина свободна. Быстро, но ошибка в стороне стоит отброса
  // прямо в соседний бампер.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    for (const side of [-1, 1])
      for (let j = 0; j < 3; j++)
        course.addBumper(
          side * 4.2,
          1.25,
          ctx.z + 5 - j * 5,
          0.8,
          ctx.palette[(ctx.index + j + 3) % ctx.palette.length]
        );
  },

  // Пробка: плотная группа посередине и чистые полосы по краям. Первый вариант с настоящим
  // выбором маршрута — напролом или в обход.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    const points = [
      [0, 5],
      [-2.35, 1.7],
      [2.35, -1.7],
      [0, -5]
    ];
    points.forEach(([x, oz], j) =>
      course.addBumper(x, 1.25, ctx.z + oz, 0.9, ctx.palette[(ctx.index + j + 3) % ctx.palette.length])
    );
  },

  // Ворота: две линии поперёк, в каждой один проход, и проходы разнесены. Дорога получается
  // диагональной, и её видно заранее.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    const line = (oz, gapX) => {
      for (const x of [-4, -1.4, 1.4, 4]) {
        if (Math.abs(x - gapX) < 0.1) continue;
        course.addBumper(
          x,
          1.25,
          ctx.z + oz,
          0.78,
          ctx.palette[(ctx.index + Math.round(x) + 5) % ctx.palette.length]
        );
      }
    };
    line(4.5, -1.4 * ctx.mirror);
    line(-4.5, 1.4 * ctx.mirror);
  },

  // Большой и малые: один широкий отбойник в середине и три мелких вокруг. Крупный виден издалека
  // и сам подсказывает объезд, мелкие ловят на выходе из него.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    course.addBumper(0, 1.25, ctx.z + 1, 1.7, ctx.palette[(ctx.index + 3) % ctx.palette.length]);
    for (const [x, oz] of [
      [-3.6, -3.5],
      [3.6, -3.5],
      [0, -6.5]
    ])
      course.addBumper(
        x * ctx.mirror,
        1.25,
        ctx.z + oz,
        0.72,
        ctx.palette[(ctx.index + 6) % ctx.palette.length]
      );
  }
];

// --- УЗКИЙ ПОВОРОТ ----------------------------------------------------------------------------
//
// Плита шириной 3.4 над пропастью. Тип про то, что сбивающий удар здесь означает падение.

function bridgeDecor(course, ctx) {
  for (const side of [-1, 1])
    for (let j = -1; j <= 1; j++)
      course.box({
        x: side * 3.4,
        y: -0.25,
        z: ctx.z + j * 5.2,
        w: 2.3,
        h: 0.45,
        d: 2.3,
        color: COLORS.cyan,
        collider: false
      }).mesh.rotation.y = j * 0.4;
}

const bridge = [
  // Одна вертушка посередине.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 1.55);
    bridgeDecor(course, ctx);
    course.addSpinner(0, 1, ctx.z, 7, 0.38, ctx.speed * 1.08 * ctx.mirror, ctx.index * 0.55);
  },

  // Две короткие: бьют чаще, но каждая уже, и между ними есть где перевести дух.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 1.55);
    bridgeDecor(course, ctx);
    for (const [j, oz] of [
      [0, 5],
      [1, -5]
    ])
      course.addSpinner(0, 1, ctx.z + oz, 5, 0.34, ctx.speed * 1.3 * (j ? -1 : 1), j * 1.9);
  },

  // Разрыв: мост разорван посередине, через пропасть надо прыгать. Вертушка при этом медленная —
  // двух испытаний сразу в одном месте не бывает.
  //
  // Перила ставятся по половинам: сплошные висели бы над пропастью и обещали пол там, где его нет.
  (course, ctx) => {
    slab(course, ctx, { z: ctx.z + 5.5, d: 7 });
    slab(course, ctx, { z: ctx.z - 5.5, d: 7 });
    rails(course, ctx, 1.55, 6, ctx.z + 5.5);
    rails(course, ctx, 1.55, 6, ctx.z - 5.5);
    bridgeDecor(course, ctx);
    course.addSpinner(0, 1, ctx.z + 6.5, 6, 0.34, ctx.speed * 0.8, 0);
  },

  // Не прыгать: балка идёт над головой. На узкой плите это особенно неприятно — привычка
  // подпрыгивать перед препятствием здесь наказывается падением.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 1.55);
    bridgeDecor(course, ctx);
    course.addSpinner(0, OVERHEAD_Y, ctx.z + 2, 8, 0.5, ctx.speed * 0.95, 0);
    course.addSpinner(0, 1, ctx.z - 5, 5, 0.34, ctx.speed * 1.15, 2.2);
  },

  // Паром: середина моста ездит вдоль. Пропасть проходится либо прыжком, либо ожиданием.
  (course, ctx) => {
    slab(course, ctx, { z: ctx.z + 6, d: 6 });
    slab(course, ctx, { z: ctx.z - 6, d: 6 });
    rails(course, ctx, 1.55, 5, ctx.z + 6);
    rails(course, ctx, 1.55, 5, ctx.z - 6);
    bridgeDecor(course, ctx);
    slider(course, ctx, {
      z: ctx.z,
      w: 3.2,
      d: 3.2,
      axis: 'z',
      range: 2.2,
      speed: ctx.speed * 0.7,
      phase: 0
    });
  }
];

// --- ПАРАД МОЛОТОВ ----------------------------------------------------------------------------
//
// Поршни, ходящие поперёк. Тип про ритм: они предсказуемы, и вопрос только в том, попал ли игрок
// в такт.

const punchers = [
  // Попеременно с двух сторон.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.1);
    for (let j = 0; j < 3; j++)
      puncher(course, ctx, {
        x: (j % 2 ? 3.7 : -3.7) * ctx.mirror,
        z: ctx.z + 5 - j * 5,
        range: 5.8,
        speed: ctx.speed * (1.4 + j * 0.14),
        phase: j * 2.2
      });
  },

  // Все с одной стороны, с равномерным сдвигом фазы: получается бегущая волна, и через неё можно
  // пройти на одной скорости, не останавливаясь.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.1);
    for (let j = 0; j < 3; j++)
      puncher(course, ctx, {
        x: -4 * ctx.mirror,
        z: ctx.z + 5.5 - j * 5.5,
        range: 6.4,
        speed: ctx.speed * 1.3,
        phase: j * 2.09
      });
  },

  // Встречные: два поршня сходятся в середине. Проходить надо между тактами, а не сбоку.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.1);
    for (const side of [-1, 1])
      puncher(course, ctx, {
        x: side * 4.2,
        z: ctx.z + 3.5,
        range: 4.6,
        speed: ctx.speed * 1.2,
        phase: side > 0 ? 3.14 : 0
      });
    puncher(course, ctx, { x: 0, z: ctx.z - 4.5, range: 4.4, speed: ctx.speed * 1.45, phase: 1.1 });
  },

  // Один длинный ход: поршень медленно выметает почти всю ширину. Обогнать нельзя, можно только
  // пропустить.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.1);
    puncher(course, ctx, { x: 0, z: ctx.z, range: 7.4, speed: ctx.speed * 0.72, phase: 0 });
  },

  // Частокол: четыре коротких быстрых поршня в шахматном порядке. Место, где выгоднее идти
  // медленно и по одному такту.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.1);
    for (let j = 0; j < 4; j++)
      puncher(course, ctx, {
        x: (j % 2 ? 3.2 : -3.2) * ctx.mirror,
        z: ctx.z + 6 - j * 4,
        range: 3.4,
        speed: ctx.speed * 1.75,
        phase: j * 1.57
      });
  }
];

// --- САД ПРЫЖКОВ ------------------------------------------------------------------------------
//
// Пружины. Тип единственный, где препятствие помогает: оно подбрасывает, а не бьёт.

const bounce = [
  // Россыпь: пружины разбросаны, попадать на них необязательно.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    // Светящиеся тренировочные стенки: jump у самой поверхности превращает рывок в управляемый
    // отскок. Они стоят вне прямой линии, поэтому новичку не мешают просто пробежать сегмент.
    for (const side of [-1, 1])
      course.box({
        x: side * 5.25,
        y: 2.1,
        z: ctx.z + 1,
        w: 0.34,
        h: 3.2,
        d: 7,
        color: COLORS.cyan,
        emissive: COLORS.cyan,
        emissiveIntensity: 0.55,
        collider: false,
        wallBounce: true
      });
    for (const [x, oz] of [
      [-3, 5],
      [2.5, 2],
      [0, -2],
      [-2.7, -5.5]
    ])
      course.addSpring(x * ctx.mirror, 0.68, ctx.z + oz, 1.15);
  },

  // Цепочка по осевой: четыре пружины подряд. Попал в первую — летишь по всем, промахнулся —
  // бежишь ногами и теряешь время.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    for (let j = 0; j < 4; j++) course.addSpring(0, 0.68, ctx.z + 6 - j * 4, 1.2);
  },

  // По краям: середина пустая. Приходится решать — ровный бег посередине или быстрый полёт по
  // краю, где легко улететь мимо трассы.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 5.6);
    for (const side of [-1, 1])
      for (const oz of [4, -1, -6]) course.addSpring(side * 4, 0.68, ctx.z + oz, 1.1);
  },

  // Острова: пол разорван, между кусками — маленькие площадки. Перепрыгнуть можно и своими
  // силами, но пружина перед каждым разрывом даёт запас высоты и превращает опасный прыжок в
  // спокойный.
  //
  // Настоящей «верхней дороги» здесь быть не может: верх любой опоры ограничен 1.7, иначе стоящий
  // на ней игрок выходит за серверную полосу высоты стояния. Поэтому альтернатива строится не
  // вверх, а вширь — по островам вместо сплошного пола.
  (course, ctx) => {
    slab(course, ctx, { z: ctx.z + 6.5, d: 5 });
    for (const [j, oz] of [
      [0, -0.5],
      [1, -6]
    ])
      course.box({
        x: 0,
        y: 0.15,
        z: ctx.z + oz,
        w: 5,
        h: 0.55,
        d: 3,
        color: ctx.palette[(ctx.index + j + 5) % ctx.palette.length],
        bevel: true
      });
    course.addSpring(0, 0.68, ctx.z + 5, 1.2);
    course.addSpring(0, 0.28, ctx.z - 0.5, 1.1);
  },

  // Пропасть: разрыв в полу перед пружиной. Перепрыгнуть можно и обычным прыжком, но с пружины —
  // с запасом и без риска.
  (course, ctx) => {
    slab(course, ctx, { z: ctx.z + 5, d: 8 });
    slab(course, ctx, { z: ctx.z - 6, d: 6 });
    course.addSpring(0, 0.68, ctx.z + 3.5, 1.25);
    course.addSpring(-2.4 * ctx.mirror, 0.68, ctx.z - 6, 1.1);
  }
];

// --- ДОРОГА ВЕТРОВ ----------------------------------------------------------------------------
//
// Узкая полоса и вертушки по сторонам. Тип про то, что сбивают не в стену, а с трассы.

const crosswind = [
  // Шахматка: вертушки по очереди с двух сторон.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 4.1);
    for (const [j, oz] of [
      [0, 4.8],
      [1, -0.2],
      [2, -5]
    ])
      course.addSpinner(
        (j % 2 ? 2.2 : -2.2) * ctx.mirror,
        1.1,
        ctx.z + oz,
        7.2,
        0.34,
        ctx.speed * (1.55 + j * 0.14) * (j % 2 ? -1 : 1),
        j
      );
  },

  // Стенка: две длинные балки во всю ширину в противофазе. Пройти можно только между ними —
  // ошибиться с моментом негде.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 4.1);
    for (const [j, oz] of [
      [0, 4],
      [1, -4]
    ])
      course.addSpinner(0, 1.1, ctx.z + oz, 9.4, 0.4, ctx.speed * 0.95 * (j ? -1 : 1), j * 3.14);
  },

  // Все с одной стороны: противоположный край остаётся чистым. Самый быстрый проход этого типа —
  // если хватит духа бежать вплотную к обрыву.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 4.1);
    for (let j = 0; j < 3; j++)
      course.addSpinner(2.6 * ctx.mirror, 1.1, ctx.z + 5 - j * 5, 6.4, 0.34, ctx.speed * 1.5, j * 1.4);
  },

  // Частокол: четыре коротких и быстрых. Бить будет часто, зато каждая балка узкая.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 4.1);
    for (let j = 0; j < 4; j++)
      course.addSpinner(
        (j % 2 ? 2.8 : -2.8) * ctx.mirror,
        1.1,
        ctx.z + 6 - j * 4,
        4.8,
        0.3,
        ctx.speed * 1.9 * (j % 2 ? -1 : 1),
        j * 1.2
      );
  },

  // Верх и низ: одна балка над головой, другая на уровне бега. Прыжок здесь спасает от одной и
  // подставляет под другую.
  (course, ctx) => {
    slab(course, ctx);
    rails(course, ctx, 4.1);
    course.addSpinner(0, OVERHEAD_Y, ctx.z + 4.5, 9, 0.5, ctx.speed * 0.9, 0);
    course.addSpinner(-2.4 * ctx.mirror, 1.1, ctx.z - 3, 6.6, 0.34, ctx.speed * 1.45, 1.7);
  }
];

export const SEGMENT_BUILDERS = Object.freeze({
  sweepers,
  movers,
  bumpers,
  bridge,
  punchers,
  bounce,
  crosswind
});

// Сколько вариантов у типа. Число берётся из самой таблицы: добавить вариант — значит дописать
// функцию, и больше ничего.
export function variantCount(type) {
  return SEGMENT_BUILDERS[type]?.length || 1;
}

// Построить сегмент. Номер варианта берётся по модулю: спека может прийти от сервера, который
// знает о вариантах больше или меньше нашего, и это не повод рисовать пустой сегмент.
export function buildSegment(course, type, variant, ctx) {
  const builders = SEGMENT_BUILDERS[type];
  if (!builders) return false;
  builders[((variant % builders.length) + builders.length) % builders.length](course, ctx);
  return true;
}
