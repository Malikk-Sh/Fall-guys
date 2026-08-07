import { CoopCourse } from './CoopCourse.js';

// Физика игры идёт фиксированным шагом 60 Гц — тем же, который использует Player.step.
const FIXED_DT = 1 / 60;
const INSTALLED = Symbol('conveyorMotionInstalled');

// Лента — движущаяся опора, а не импульс.
//
// Первая реализация добавляла force * dt к velocity.z в конце Player.step. На следующем шаге
// управление тянуло скорость обратно к желаемой с коэффициентом 18, поэтому от силы 3–4 м/с
// оставалось около четверти метра в секунду: полосы ехали, а персонаж почти не сдвигался.
//
// Вентиляторы уже решают тот же класс задачи правильно — смещают позицию напрямую. Здесь делаем
// то же для конвейеров и на время исходного interact скрываем список лент, чтобы старая прибавка
// к скорости не применилась второй раз. Остальные препятствия продолжают обрабатываться обычным
// кодом CoopCourse.interact.
export function installConveyorMotion(CourseClass = CoopCourse) {
  const prototype = CourseClass?.prototype;
  if (!prototype || prototype[INSTALLED]) return;

  const originalInteract = prototype.interact;
  if (typeof originalInteract !== 'function') {
    throw new TypeError('Conveyor motion requires CourseClass.prototype.interact');
  }

  Object.defineProperty(prototype, INSTALLED, { value: true });
  prototype.interact = function interactWithConveyorMotion(player, elapsed, effects, sfx) {
    const conveyors = this.conveyors;
    const position = player?.position;

    if (!player?.grounded || !position || !Array.isArray(conveyors) || conveyors.length === 0) {
      return originalInteract.call(this, player, elapsed, effects, sfx);
    }

    let displacement = 0;
    for (const zone of conveyors) {
      if (position.z > zone.zMax || position.z < zone.zMin) continue;
      displacement += zone.force * FIXED_DT;
    }

    if (displacement === 0) return originalInteract.call(this, player, elapsed, effects, sfx);

    // Сначала переносим игрока лентой, чтобы остальные препятствия в этом же шаге видели уже
    // фактическую позицию. Затем вызываем исходную обработку без старого velocity-импульса.
    position.z += displacement;
    this.conveyors = [];
    try {
      return originalInteract.call(this, player, elapsed, effects, sfx);
    } finally {
      this.conveyors = conveyors;
    }
  };
}

installConveyorMotion();
