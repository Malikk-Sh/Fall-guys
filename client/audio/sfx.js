// Библиотека звуковых эффектов.
//
// Каждый эффект — рецепт из примитивов AudioEngine (тон с огибающей и отфильтрованный шум). Небольшой
// случайный разброс высоты в каждом вызове специально: без него повторяющийся звук приземления
// начинает раздражать уже через минуту игры.
//
// Аргумент `position` включает пространственное позиционирование. Для действий своего персонажа его
// передавать не нужно — свои звуки всегда звучат по центру и на полной громкости, иначе игра ощущается
// глухой. Для напарника и удалённых игроков позиция обязательна.

// Разброс высоты тона в пределах ±`cents` центов (сотых полутона).
const vary = (value, cents = 60) => value * Math.pow(2, ((Math.random() * 2 - 1) * cents) / 1200);

export class Sfx {
  constructor(engine) {
    this.engine = engine;
    this.footPhase = 0;
  }

  jump(position = null) {
    // Восходящий скользящий тон — читается как «оттолкнулся».
    this.engine.playTone({
      freq: [vary(320), vary(680)],
      type: 'triangle',
      duration: 0.16,
      volume: 0.22,
      position
    });
    // Короткий выдох поверх тона добавляет телесности.
    this.engine.playNoise({
      duration: 0.12,
      filter: 'highpass',
      freq: 900,
      volume: 0.1,
      position
    });
  }

  // Громкость и высота зависят от скорости удара: мягкое приземление и падение с высоты должны
  // звучать по-разному, иначе теряется обратная связь о риске.
  land(strength = 0.5, position = null) {
    const power = Math.max(0.15, Math.min(1, strength));
    this.engine.playTone({
      freq: [vary(150 - power * 40), 45],
      type: 'sine',
      duration: 0.14 + power * 0.1,
      volume: 0.16 + power * 0.22,
      position
    });
    this.engine.playNoise({
      duration: 0.09 + power * 0.06,
      filter: 'lowpass',
      freq: 1400,
      sweepTo: 220,
      volume: 0.08 + power * 0.16,
      position
    });
  }

  dive(position = null) {
    // Нисходящий свист — рывок вперёд.
    this.engine.playNoise({
      duration: 0.34,
      filter: 'bandpass',
      freq: 1800,
      sweepTo: 400,
      q: 1.4,
      volume: 0.2,
      position
    });
    this.engine.playTone({
      freq: [vary(420), vary(180)],
      type: 'sawtooth',
      duration: 0.28,
      volume: 0.1,
      position
    });
  }

  // Шаги вызываются из анимации бега. Чередуем высоту через `footPhase`, чтобы походка не звучала
  // как метроном из одного сэмпла.
  footstep(position = null) {
    if (!this.engine.throttle('footstep', 0.16)) return;
    this.footPhase = 1 - this.footPhase;
    this.engine.playNoise({
      duration: 0.06,
      filter: 'bandpass',
      freq: this.footPhase ? 640 : 520,
      q: 2.2,
      volume: 0.07,
      position
    });
  }

  // Свист падения: чем дольше летишь, тем выше и тревожнее.
  fall(intensity = 0.5) {
    if (!this.engine.throttle('fall', 0.28)) return;
    this.engine.playNoise({
      duration: 0.3,
      filter: 'bandpass',
      freq: 300 + intensity * 700,
      sweepTo: 200,
      q: 3,
      volume: 0.05 + intensity * 0.08
    });
  }

  spring(position = null) {
    // Классическое «бойнг»: быстрый подъём высоты с призвуком пружины.
    this.engine.playTone({
      freq: [vary(180), vary(1150)],
      type: 'square',
      duration: 0.26,
      volume: 0.16,
      position
    });
    this.engine.playTone({
      freq: [vary(260), vary(1400)],
      type: 'triangle',
      duration: 0.22,
      volume: 0.1,
      detune: 14,
      position
    });
  }

  bumper(position = null) {
    // Резиновый удар: низкий толчок плюс упругий средний.
    this.engine.playTone({
      freq: [vary(220), vary(90)],
      type: 'sine',
      duration: 0.2,
      volume: 0.26,
      position
    });
    this.engine.playNoise({
      duration: 0.14,
      filter: 'bandpass',
      freq: 900,
      q: 1.1,
      volume: 0.16,
      position
    });
  }

  spinner(position = null) {
    // Тяжёлая балка: гулкий мах и металлический звон при попадании.
    this.engine.playNoise({
      duration: 0.26,
      filter: 'lowpass',
      freq: 1600,
      sweepTo: 300,
      volume: 0.2,
      position
    });
    this.engine.playTone({
      freq: vary(190),
      type: 'square',
      duration: 0.3,
      volume: 0.12,
      position
    });
  }

  puncher(position = null) {
    // Короткий и сухой — поршень бьёт мгновенно.
    this.engine.playNoise({
      duration: 0.1,
      filter: 'bandpass',
      freq: 1200,
      q: 0.8,
      volume: 0.24,
      attack: 0.001,
      position
    });
    this.engine.playTone({
      freq: [vary(130), 60],
      type: 'sine',
      duration: 0.16,
      volume: 0.22,
      position
    });
  }

  // Чекпоинт: восходящая терция. Всегда одинаковая — это опорный, узнаваемый сигнал прогресса.
  checkpoint() {
    const base = 660;
    this.engine.playTone({ freq: base, type: 'sine', duration: 0.22, volume: 0.16 });
    setTimeout(() => {
      this.engine.playTone({ freq: base * 1.5, type: 'sine', duration: 0.34, volume: 0.16 });
    }, 90);
  }

  // Финиш: мажорное арпеджио, разрешающееся в октаву.
  finish() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, index) => {
      setTimeout(() => {
        this.engine.playTone({ freq, type: 'triangle', duration: 0.45, volume: 0.2 });
        this.engine.playTone({ freq: freq * 2, type: 'sine', duration: 0.3, volume: 0.07 });
      }, index * 110);
    });
  }

  respawn() {
    this.engine.playTone({ freq: [880, 330], type: 'triangle', duration: 0.3, volume: 0.14 });
    this.engine.playNoise({ duration: 0.2, filter: 'highpass', freq: 1400, volume: 0.08 });
  }

  // Оживление напарника: мерцающий подъём, отчётливо позитивный.
  revive(position = null) {
    [440, 587.33, 880].forEach((freq, index) => {
      setTimeout(() => {
        this.engine.playTone({ freq, type: 'sine', duration: 0.3, volume: 0.16, position });
      }, index * 70);
    });
  }

  // Сигнал упавшего напарника: мягкий пульс, слышный по всей карте. Именно по нему игрок понимает,
  // что нужно возвращаться, даже если напарник вне кадра.
  bubble(position) {
    if (!this.engine.throttle('bubble', 1.1)) return;
    this.engine.playTone({
      freq: [520, 640],
      type: 'sine',
      duration: 0.4,
      volume: 0.2,
      position,
      maxDistance: 120
    });
  }

  uiClick() {
    this.engine.playTone({ freq: 880, type: 'square', duration: 0.05, volume: 0.09 });
  }

  // Обратный отсчёт: три коротких сигнала и один длинный на «GO».
  countdown(isGo = false) {
    if (isGo) {
      this.engine.playTone({ freq: 880, type: 'triangle', duration: 0.5, volume: 0.26 });
      this.engine.playTone({ freq: 1320, type: 'sine', duration: 0.4, volume: 0.12 });
    } else {
      this.engine.playTone({ freq: 440, type: 'triangle', duration: 0.18, volume: 0.2 });
    }
  }
}
