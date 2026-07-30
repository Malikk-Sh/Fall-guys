// Действия ролей в кооперативе.
//
// Вынесено из Game отдельным модулем по одной причине: иначе это невозможно проверить.
// Раньше логика жила прямо в игровом цикле, вперемешку с камерой, звуком и сетью, и единственным
// способом её испытать было открыть браузер и понажимать кнопки руками. Тесты при этом дёргали
// `course.aimedEmitter` и `player.startSlam` напрямую — то есть проверяли детали, а не то, что
// игрок вообще может выполнить действие. Разница оказалась не теоретической: и луч, и катапульта
// «работали» в таких проверках, не работая в игре.
//
// Теперь это чистая функция от (игрок, трасса, ввод, направление взгляда). Ей всё равно, кто её
// вызывает — настоящая игра или бот в тесте, — и потому бот проверяет ровно тот код, который
// выполняется у игрока.

import { COOP_ROLE } from '/shared/protocol.js';

// Обработчики событий, которые действие может породить. Игра подставляет сюда звук, сеть и тряску
// камеры, тест — счётчики. Значения по умолчанию позволяют не передавать ничего.
const NOOP = () => {};

export function updateRoleActions(
  player,
  course,
  input,
  yaw,
  { role, forward, onBeamChange = NOOP, onBeamHold = NOOP, onSlam = NOOP, onCatapult = NOOP } = {}
) {
  if (!player || player.downed) return;

  if (role === COOP_ROLE.SPARK) {
    // Луч держится, пока держат кнопку. Наводка ищется по направлению взгляда камеры.
    const holding = input.isHeld('dive');
    const direction = forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const aimed = holding ? course.aimedEmitter(player.position, direction) : null;
    if (aimed && aimed === player.beamTarget) onBeamHold();
    if (aimed !== player.beamTarget) {
      player.beamTarget = aimed;
      onBeamChange(aimed);
    }
    return;
  }

  if (role === COOP_ROLE.ANCHOR) {
    // Удар сверху доступен только в воздухе: так он остаётся осознанным действием,
    // а не второй кнопкой прыжка.
    if (input.consume('dive') && player.startSlam()) onSlam();
    // Приземление рядом с катапультой подбрасывает того, кто стоит на плече.
    if (player.grounded && player.wasSlamming) {
      const hit = course.slamTarget(player.position);
      if (hit) onCatapult(hit);
    }
    player.wasSlamming = player.slamming;
  }
}
