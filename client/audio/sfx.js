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

// Копия координат для звуков с задержкой. Вызывающая сторона обычно передаёт переиспользуемый
// вектор, и читать его позже, чем в момент вызова, нельзя.
const snapshot = position => (position ? { x: position.x, y: position.y, z: position.z } : null);

export class Sfx {
  constructor(engine) {
    this.engine = engine;
    this.footPhase = 0;
  }

  ping(position = null) {
    this.engine.playTone({
      freq: [vary(620, 25), vary(880, 25)],
      type: 'sine',
      duration: 0.18,
      volume: 0.2,
      position
    });
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

  // Предупреждение перед смертельным ударом: два коротких высоких сигнала.
  //
  // Смертельная опасность обязана телеграфировать себя тремя фазами — предупреждение, окно удара,
  // короткое восстановление. Мигающая метка на полу работает, только если на неё смотрят; звук
  // работает и когда игрок смотрит на напарника, а это в коопе половина времени.
  warn(position = null) {
    for (const delay of [0, 150])
      setTimeout(() => {
        this.engine.playTone({
          freq: 1180,
          type: 'square',
          duration: 0.07,
          volume: 0.11,
          position: snapshot(position)
        });
      }, delay);
  }

  // Удар пресса. Звучит всегда, а не только при попадании: промах на волосок должен ощущаться
  // как промах на волосок, иначе игрок не понимает, насколько близко было.
  crush(position = null) {
    this.engine.playTone({
      freq: [vary(110, 30), 38],
      type: 'sine',
      duration: 0.3,
      volume: 0.3,
      position
    });
    this.engine.playNoise({
      duration: 0.16,
      filter: 'lowpass',
      freq: 900,
      sweepTo: 120,
      volume: 0.24,
      attack: 0.001,
      position
    });
  }

  // Плитка начала осыпаться: сухой треск, ещё не падение. Это последняя секунда, чтобы уйти.
  crack(position = null) {
    this.engine.playNoise({
      duration: 0.22,
      filter: 'bandpass',
      freq: vary(2600, 200),
      q: 1.6,
      volume: 0.15,
      attack: 0.002,
      position
    });
  }

  // Плитка ушла вниз: уходящий вниз шорох.
  collapse(position = null) {
    this.engine.playNoise({
      duration: 0.42,
      filter: 'lowpass',
      freq: 1500,
      sweepTo: 180,
      volume: 0.18,
      position
    });
    this.engine.playTone({
      freq: [vary(240), 70],
      type: 'triangle',
      duration: 0.38,
      volume: 0.12,
      position
    });
  }

  // Ветер. Отфильтрованный шум, чья громкость и яркость растут вместе с порывом.
  //
  // Нужен по той же причине, что и звук пресса: в кооперативе половину времени смотришь на
  // напарника, а не под ноги. Услышать нарастающий порыв — значит успеть присесть к центру
  // дорожки до того, как потащит. Вызывается дросселированно, иначе это пулемёт из шумов.
  wind(intensity = 0.5, position = null) {
    const power = Math.max(0, Math.min(1, intensity));
    this.engine.playNoise({
      duration: 0.5,
      filter: 'bandpass',
      freq: 380 + power * 900,
      q: 0.7,
      sweepTo: 260 + power * 500,
      volume: 0.04 + power * 0.16,
      attack: 0.14,
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

  // --- Кооперативные действия ---------------------------------------------------------------
  //
  // Раньше кооп пользовался чужими звуками: луч звучал как чекпоинт, катапульта как пружина.
  // Своё звучание здесь не украшение — по звуку игрок понимает, сработало ли действие, не отводя
  // взгляда от напарника.

  // Удар сверху: тяжёлый, низкий, с ощутимым весом. Ровно противоположность лёгкому рывку ИСКРЫ.
  slam(position = null) {
    this.engine.playTone({ freq: [90, 38], type: 'sine', duration: 0.3, volume: 0.34, position });
    this.engine.playNoise({
      duration: 0.22,
      filter: 'lowpass',
      freq: 900,
      sweepTo: 120,
      volume: 0.24,
      attack: 0.001,
      position
    });
  }

  // Катапульта: скрип рычага и мощный выброс.
  catapult(position = null) {
    this.engine.playNoise({
      duration: 0.16,
      filter: 'bandpass',
      freq: 1600,
      q: 3,
      volume: 0.14,
      position
    });
    this.engine.playTone({ freq: [140, 900], type: 'square', duration: 0.32, volume: 0.24, position });
    this.engine.playTone({ freq: [200, 1200], type: 'triangle', duration: 0.28, volume: 0.14, position });
  }

  // Плита нажата и отпущена — разные звуки: игрок должен слышать, что напарник сошёл,
  // даже когда смотрит в другую сторону.
  platePress(position = null) {
    this.engine.playTone({ freq: [300, 220], type: 'square', duration: 0.1, volume: 0.16, position });
    this.engine.playNoise({ duration: 0.07, filter: 'lowpass', freq: 700, volume: 0.1, position });
  }

  plateRelease(position = null) {
    this.engine.playTone({ freq: [220, 300], type: 'square', duration: 0.08, volume: 0.1, position });
  }

  // Пролёт выдвинулся или убрался — самый важный звук режима: он сообщает, что совместное
  // действие сработало.
  //
  // Ноты играют с задержкой, поэтому позицию нужно скопировать сейчас: вызывающий передаёт
  // общий временный вектор, и к моменту срабатывания таймера в нём будут уже чужие координаты.
  spanExtend(position = null) {
    this.arpeggio([520, 660, 880], 55, position, { duration: 0.22, volume: 0.15 });
  }

  spanRetract(position = null) {
    this.arpeggio([880, 660, 520], 45, position, { duration: 0.16, volume: 0.11 });
  }

  arpeggio(notes, stepMs, position, options) {
    const at = snapshot(position);
    notes.forEach((freq, index) => {
      setTimeout(() => {
        this.engine.playTone({ freq, type: 'triangle', position: at, ...options });
      }, index * stepMs);
    });
  }

  uiClick() {
    this.engine.playTone({ freq: 880, type: 'square', duration: 0.05, volume: 0.09 });
  }

  // Звуки шкафа. Всё тем же процедурным способом, что и остальное: заводить ради косметики пачку
  // внешних аудиофайлов значило бы утяжелить первую загрузку ради шести коротких сигналов.

  // Перелистывание карточек — самое частое действие в шкафу, поэтому и звук самый тихий.
  uiTick() {
    this.engine.playTone({ freq: vary(1180, 40), type: 'sine', duration: 0.035, volume: 0.05 });
  }

  // Подтверждение: короткая восходящая пара. «Надето» должно звучать законченно.
  uiConfirm() {
    this.engine.playTone({ freq: 720, type: 'triangle', duration: 0.09, volume: 0.12 });
    this.engine.playTone({ freq: 1080, type: 'sine', duration: 0.14, volume: 0.08 });
  }

  /**
   * Новый предмет. Длина и высота фанфары зависят от редкости: обычная награда не должна звучать
   * как мифическая, иначе через десять открытий перестанет звучать вообще.
   */
  unlock(rarity = 'rare') {
    const ladders = {
      common: [660, 880],
      rare: [660, 880, 1100],
      epic: [587, 784, 988, 1175],
      legendary: [523, 659, 784, 1046, 1318],
      mythic: [392, 523, 659, 784, 1046, 1318],
      prestige: [440, 554, 659, 880, 1108]
    };
    const ladder = ladders[rarity] || ladders.rare;
    this.arpeggio(ladder, rarity === 'mythic' ? 92 : 74, null, {
      duration: 0.26,
      volume: rarity === 'mythic' ? 0.16 : 0.12
    });
    // Мифический получает вдобавок низкий гул: он и должен ощущаться событием.
    if (rarity === 'mythic') {
      this.engine.playTone({ freq: 98, type: 'sine', duration: 0.9, volume: 0.14 });
    }
  }

  // Эмоция — жест, а не событие: короткий мягкий отклик, чтобы нажатие не было беззвучным.
  emote() {
    this.engine.playTone({ freq: vary(940, 90), type: 'triangle', duration: 0.11, volume: 0.09 });
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
