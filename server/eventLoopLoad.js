'use strict';

const { monitorEventLoopDelay } = require('node:perf_hooks');

// Задержка event loop измеряется КОРОТКИМИ ОКНАМИ, а не за всё время работы процесса.
//
// Гистограмма monitorEventLoopDelay копит выборки с момента enable() и никогда не забывает. Значит,
// её перцентиль — это перцентиль по всему аптайму, и чем дольше сервер работает, тем меньше он
// реагирует: чтобы сдвинуть 95-й перцентиль, перегрузка должна занять двадцатую часть всего времени
// жизни процесса.
//
// Замерено: если гистограмму не сбрасывать, пять секунд устойчивой блокировки поднимают p95 до
// 160 мс на свежем процессе — и не двигают его вообще уже после тридцати секунд аптайма. То есть
// защита от перегрузки (отказ от новых комнат, снапшоты на 10 Гц) переставала срабатывать примерно
// через полминуты после запуска и дальше не срабатывала никогда.
//
// Поэтому: раз в окно снимаем перцентиль, сохраняем его и сбрасываем гистограмму. Решение
// принимается по последнему завершённому окну — оно и «устойчивая задержка», и восстановление
// замечает за одно окно.
const EVENT_LOOP_WINDOW_MS = 5000;

function createEventLoopLoad({
  thresholdMs,
  windowMs = EVENT_LOOP_WINDOW_MS,
  monitor = monitorEventLoopDelay({ resolution: 20 })
} = {}) {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new TypeError('event loop load requires a positive overload threshold');
  }
  monitor.enable();

  let windowP95Ms = 0;

  // Возвращает задержку последнего завершённого окна и начинает новое.
  function rotate() {
    const p95 = monitor.percentile(95) / 1e6;
    windowP95Ms = Number.isFinite(p95) ? p95 : 0;
    monitor.reset();
    return windowP95Ms;
  }

  const timer = setInterval(rotate, windowMs);
  timer.unref?.();

  function status({ lagMs = windowP95Ms, memory = process.memoryUsage() } = {}) {
    const normalizedLag = Number.isFinite(lagMs) ? Math.round(lagMs * 10) / 10 : 0;
    return {
      eventLoopP95Ms: normalizedLag,
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024),
      overloaded: normalizedLag >= thresholdMs
    };
  }

  function stop() {
    clearInterval(timer);
    monitor.disable();
  }

  return Object.freeze({
    rotate,
    status,
    stop,
    windowMs,
    thresholdMs,
    get lagMs() {
      return windowP95Ms;
    }
  });
}

module.exports = Object.freeze({ EVENT_LOOP_WINDOW_MS, createEventLoopLoad });
