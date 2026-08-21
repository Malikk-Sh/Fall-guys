// Импульсы препятствий.
//
// Геометрия удара, выталкивание и получаемая скорость — то же самое правило, что и у клиента,
// потому что это и есть тот же код. Раньше он жил только в Course.interact, и серверная симуляция
// не получала от трассы ни отскока от бампера, ни удара балкой: доказывать паритет движения было
// не на чем.
//
// Точка удара запоминается в событии: за один шаг игрока могут задеть два препятствия, и всплеск
// обязан появиться там, где удар случился, а не там, куда игрока вытолкнуло следующим.
//
// Наружу отдаются события, а не эффекты: всплеск, звук, тряска камеры и сама поза сбивания
// остаются подаче. Счётчик попаданий и сбивание помечаются в событии, потому что у клиента на них
// висят свои правила — иммунитет, цель «без попаданий» — и физика их не решает.
//
// Состояние правится на месте: клиент передаёт сюда свои же position и velocity, и выталкивание
// обязано попасть именно в них — позиция отрисовки пересчитывается интерполяцией каждый кадр, и
// записанное в неё было бы немедленно затёрто.

// Выдержка между ударами по ЛЕЖАЩЕМУ игроку.
//
// Сбитого не должно молотить одним и тем же препятствием, пока он не встал: обычные 0.28–0.34
// секунды рассчитаны на бегущего, который сам уходит из зоны, а лежащий уйти не может.
//
// Правило намеренно НЕ параметр. Оно было параметром (`limpHitCooldown`), и стороны разошлись:
// клиент передавал 1.5 при `knockdownTimer > 0`, серверная свободная траектория — всегда 0. Разница
// не сводилась к лишнему событию: толчок меняет позицию и скорость ЗДЕСЬ, а `applyKnockdown`
// вызывается уже после — и его отказ повторно сбивать ничего не откатывает. Серверная копия
// получала удары, которых у клиента не было, и уезжала молча: в паритет попаданий такой удар не
// попадал, потому что события сбивания не возникало.
//
// Теперь выдержка выводится из состояния, одного на обе стороны, и разойтись ей негде.
export const KNOCKDOWN_HIT_COOLDOWN = 1.5;

export function applyObstacleImpulses(
  state,
  { obstacles = [], now = 0, hitTimes = new Map(), playerRadius = 0, footOffset = 0, knockback = 1 } = {}
) {
  const position = state.position;
  const events = [];
  const limpHitCooldown = state.knockdownTimer > 0 ? KNOCKDOWN_HIT_COOLDOWN : 0;

  for (const o of obstacles) {
    const key = o.id,
      last = hitTimes.get(key) || 0;
    if (o.type === 'spring') {
      const dx = position.x - o.x,
        dz = position.z - o.z;
      if (
        Math.hypot(dx, dz) < o.radius * 0.82 &&
        Math.abs(position.y - footOffset - (o.y + 0.13)) < 0.38 &&
        state.velocity.y <= 1 &&
        now - last > 0.35
      ) {
        state.velocity.y = 11.4;
        state.grounded = false;
        hitTimes.set(key, now);
        events.push({ name: 'spring', impact: 0.25, at: { ...position } });
      }
      continue;
    }
    if (o.type === 'bumper') {
      const dx = position.x - o.x,
        dz = position.z - o.z,
        dist = Math.hypot(dx, dz) || 0.01,
        min = o.radius + playerRadius;
      if (dist < min && Math.abs(position.y - o.y) < 1.55 && now - last > Math.max(0.28, limpHitCooldown)) {
        const nx = dx / dist,
          nz = dz / dist;
        position.x = o.x + nx * min;
        position.z = o.z + nz * min;
        state.velocity.x = nx * 10 * knockback;
        state.velocity.z = nz * 10 * knockback;
        state.velocity.y = Math.max(6.2 * knockback, state.velocity.y);
        state.grounded = false;
        hitTimes.set(key, now);
        events.push({
          name: 'bumper',
          color: o.color,
          impact: 0.4,
          knockdown: 0.4,
          counted: true,
          at: { ...position }
        });
      }
      continue;
    }
    if (o.type === 'spinner') {
      const dx = position.x - o.x,
        dz = position.z - o.z,
        cos = Math.cos(o.angle),
        sin = Math.sin(o.angle),
        along = dx * cos - dz * sin,
        cross = dx * sin + dz * cos;
      if (
        Math.abs(along) < o.length / 2 + playerRadius &&
        Math.abs(cross) < o.width / 2 + playerRadius &&
        Math.abs(position.y - o.y) < 1.05 &&
        now - last > Math.max(0.32, limpHitCooldown)
      ) {
        const side = Math.sign(cross) || 1,
          nx = sin * side,
          nz = cos * side;
        position.x += nx * (o.width / 2 + playerRadius - Math.abs(cross) + 0.04);
        position.z += nz * (o.width / 2 + playerRadius - Math.abs(cross) + 0.04);
        const tangential = Math.min(12, Math.abs(o.speed) * Math.abs(along) * 0.72 + 5.5);
        state.velocity.x = (nx * tangential + o.speed * dz * 0.22) * knockback;
        state.velocity.z = (nz * tangential - o.speed * dx * 0.22) * knockback;
        state.velocity.y = Math.max(4.6 * knockback, state.velocity.y);
        state.grounded = false;
        hitTimes.set(key, now);
        events.push({ name: 'spinner', impact: 0.5, knockdown: 0.5, counted: true, at: { ...position } });
      }
      continue;
    }
    if (o.type === 'puncher') {
      const dx = position.x - o.x,
        dz = position.z - o.z;
      if (
        Math.abs(dx) < o.w / 2 + playerRadius &&
        Math.abs(dz) < o.d / 2 + playerRadius &&
        Math.abs(position.y - o.y) < 1.5 &&
        now - last > Math.max(0.34, limpHitCooldown)
      ) {
        const dir = Math.sign(dx) || Math.sign(Math.cos(now * o.speed + o.phase)) || 1;
        position.x += dir * (o.w / 2 + playerRadius - Math.abs(dx) + 0.05);
        state.velocity.x = dir * 10.5 * knockback;
        state.velocity.z -= 3 * knockback;
        state.velocity.y = Math.max(4.2 * knockback, state.velocity.y);
        state.grounded = false;
        hitTimes.set(key, now);
        events.push({ name: 'puncher', impact: 0.55, knockdown: 0.55, counted: true, at: { ...position } });
      }
    }
  }

  return { state, events };
}
