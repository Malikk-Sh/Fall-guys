// Поиск опоры под ногами — общая, независимая от Three.js часть коллизий уровня.
//
// Клиент строит геометрию мешами, но сама проверка опоры всегда была чистой арифметикой над
// коробками и цилиндрами: положение, размеры, верх опоры. Здесь она отделена от рендера, чтобы
// серверная симуляция могла спрашивать про пол по той же формуле и по тем же числам, а не заводить
// вторую версию коллизий, которая со временем разъедется с клиентской.
//
// Модуль ничего не строит и ничего не знает про сегменты трассы: он отвечает только на вопрос
// «на какую опору из этого списка игрок встаёт на текущем шаге». Порождение самого списка опор для
// сервера — следующий шаг миграции; сейчас список приходит от клиентского CourseBuilder.

// Запас по краю опоры.
//
// Раньше здесь стоял отступ ВНУТРЬ (−0.12), и это была едва ли не самая дорогая ошибка проекта.
// Отрезки трассы кладутся вплотную друг к другу, а опора у каждого считалась на 0.12 у́же с каждой
// стороны — значит на каждом стыке зияла щель шириной 0.24, где пола не было ни у одного из
// соседей. Игрок, бегущий по ровному полу, время от времени проваливался посреди него.
//
// Знак теперь противоположный: край опоры чуть шире геометрии. Стыки заведомо перекрываются, а
// прыжок с самого края становится прощающим. На ширину пропастей это не влияет: они на два порядка
// больше запаса.
export const SUPPORT_EDGE_TOLERANCE = 0.12;

// Насколько выше опоры может оказаться ступня, чтобы шаг всё ещё считался приземлением.
export const SUPPORT_MAX_FOOT_RISE = 0.45;

// Выше этой скорости вверх опора не подхватывается: иначе игрок, выпрыгивающий из-под платформы,
// «приземлялся» бы на неё снизу.
export const SUPPORT_MAX_UPWARD_SPEED = 2.2;

export const SUPPORT_COLLIDER_TYPE = Object.freeze({
  BOX: 'box',
  CYLINDER: 'cylinder'
});

function within(collider, x, z) {
  if (collider.type === SUPPORT_COLLIDER_TYPE.CYLINDER) {
    return Math.hypot(x - collider.x, z - collider.z) < collider.r + SUPPORT_EDGE_TOLERANCE;
  }
  return (
    Math.abs(x - collider.x) < collider.w / 2 + SUPPORT_EDGE_TOLERANCE &&
    Math.abs(z - collider.z) < collider.d / 2 + SUPPORT_EDGE_TOLERANCE
  );
}

// Индекс опоры, на которую игрок встаёт этим шагом, либо -1.
//
// Это свип-тест, а не проверка пересечения: сравниваются положения ступни до и после шага. Иначе на
// скорости игрок за один шаг проскакивал бы тонкую платформу насквозь, ни разу не оказавшись внутри
// неё. Возвращается индекс, а не объект, чтобы вызов на каждом физическом шаге ничего не выделял.
export function supportIndexAt(colliders, position, previousY, velocityY, footOffset) {
  if (!Array.isArray(colliders) || colliders.length === 0) return -1;
  if (!(velocityY <= SUPPORT_MAX_UPWARD_SPEED)) return -1;

  const x = position.x;
  const foot = position.y - footOffset;
  const previousFoot = previousY - footOffset;
  const z = position.z;

  let bestIndex = -1;
  let bestTop = 0;
  for (let index = 0; index < colliders.length; index++) {
    const collider = colliders[index];
    if (!collider || collider.disabled) continue;
    if (!within(collider, x, z)) continue;

    const top = collider.y + collider.h / 2;
    if (foot > top + SUPPORT_MAX_FOOT_RISE) continue;
    // Ступня на прошлом шаге должна была быть не ниже верха опоры с точностью до собственной
    // высоты подъёма: так шаг сквозь тонкую платформу всё равно ловится, а проход насквозь снизу
    // не превращается в приземление.
    if (previousFoot < top - footOffset) continue;
    if (bestIndex >= 0 && top <= bestTop) continue;

    bestIndex = index;
    bestTop = top;
  }
  return bestIndex;
}

// Верх опоры по её индексу. Отдельная функция, чтобы вызывающая сторона не повторяла арифметику.
export function supportTop(collider) {
  return collider.y + collider.h / 2;
}
