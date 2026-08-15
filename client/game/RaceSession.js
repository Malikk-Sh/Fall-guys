// Данные одного забега, не зависящие от Three.js, DOM и транспорта. Game по-прежнему собирает
// сцену и принимает сетевые сообщения, но время, финиш и статус зачёта больше не разбросаны по
// набору независимых полей центрального класса.
export class RaceSession {
  constructor() {
    this.reset();
  }

  reset() {
    this.mode = null;
    this.spec = null;
    this.startedAt = 0;
    this.finalTime = 0;
    this.unranked = null;
    this.finished = false;
    // Обычно elapsed после финиша заморожен: это время результата. В досмотре сетевой гонки мир
    // обязан продолжать жить, поэтому отдельным явным действием часы можно отпустить, не меняя
    // finished и finalTime.
    this.worldClockContinues = false;
  }

  start({ mode, spec, startedAt }) {
    if (!mode || !spec || !Number.isFinite(startedAt))
      throw new TypeError('RaceSession: нужны mode, spec и startedAt');
    this.mode = mode;
    this.spec = spec;
    this.startedAt = startedAt;
    this.finalTime = 0;
    this.unranked = null;
    this.finished = false;
    this.worldClockContinues = false;
    return this;
  }

  elapsed(now) {
    if (this.finished && !this.worldClockContinues) return this.finalTime;
    if (!Number.isFinite(now) || !this.mode) return 0;
    return Math.max(0, now - this.startedAt);
  }

  finish(now) {
    if (this.finished) return this.finalTime;
    this.finalTime = this.elapsed(now);
    this.finished = true;
    this.worldClockContinues = false;
    return this.finalTime;
  }

  confirmFinish(time) {
    if (Number.isFinite(time) && time >= 0) this.finalTime = time;
    this.finished = true;
    return this.finalTime;
  }

  // В гонке свой результат уже зафиксирован, но остальные ещё бегут. finalTime остаётся личным
  // временем финиша, а elapsed снова следует общим серверным часам — от него зависят фазы
  // препятствий и таймер мира во время досмотра.
  continueWorldClock() {
    if (!this.finished) return false;
    this.worldClockContinues = true;
    return true;
  }

  reopenFinish() {
    this.finished = false;
    this.finalTime = 0;
    this.worldClockContinues = false;
  }

  markUnranked(reason) {
    if (this.unranked) return false;
    this.unranked = reason || 'unknown';
    return true;
  }

  // В одиночной игре время должно остановиться вместе со вкладкой: препятствия и физика тоже
  // не обновлялись. Сетевой забег использует серверные часы и этот метод не вызывает.
  shiftStart(deltaMs) {
    if (Number.isFinite(deltaMs) && deltaMs > 0 && !this.finished) this.startedAt += deltaMs;
  }

  // После потери сетевой гонки продолжаем локально, сохраняя уже прошедшее время.
  switchClock(now, localNow) {
    const elapsed = this.elapsed(now);
    this.startedAt = localNow - elapsed;
    this.mode = 'single';
    return elapsed;
  }
}
