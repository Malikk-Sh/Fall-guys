// Адаптивная музыка.
//
// Музыка не проигрывается как один готовый трек, а собирается из слоёв в реальном времени: бас,
// ударные, аккорды и мелодия. Слои подключаются по мере роста «напряжения» — в начале трассы играет
// только бас с лёгкими ударными, к финишу звучит всё. Это даёт ощущение нарастания без единого байта
// аудиофайлов и без склеек.
//
// Планировщик стандартный для Web Audio: таймер срабатывает часто и грубо, но ноты назначаются на
// точное время `ctx.currentTime + смещение`. Планировать ноты прямо в setInterval нельзя — таймеры
// браузера плавают на десятки миллисекунд, и ритм бы «гулял».

const BPM = 124;
const STEPS_PER_BAR = 16;
const BARS = 4;
const STEP_SECONDS = 60 / BPM / 4; // Шаг — одна шестнадцатая.
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

export const MUSIC_MODE = Object.freeze({
  MENU: 'menu',
  RACE: 'race'
});

const normalizeMode = mode => (mode === MUSIC_MODE.MENU ? MUSIC_MODE.MENU : MUSIC_MODE.RACE);

const MENU_LAYER_TARGETS = Object.freeze({ bass: 0.16, drums: 0.04, chords: 0.22, lead: 0.08 });
const RACE_LAYER_TARGETS = Object.freeze([
  Object.freeze({ bass: 0.5, drums: 0.12, chords: 0, lead: 0 }),
  Object.freeze({ bass: 0.5, drums: 0.42, chords: 0, lead: 0 }),
  Object.freeze({ bass: 0.5, drums: 0.42, chords: 0.3, lead: 0 }),
  Object.freeze({ bass: 0.5, drums: 0.42, chords: 0.3, lead: 0.26 })
]);

// Режим меняет не общую громкость пользователя, а баланс уже существующих музыкальных слоёв.
// В меню нет гоночного нарастания: тема остаётся спокойной при любом последнем race intensity.
export function musicLayerTargets(mode, intensity = 0) {
  if (normalizeMode(mode) === MUSIC_MODE.MENU) return MENU_LAYER_TARGETS;
  const value = Math.max(0, Math.min(1, Number(intensity) || 0));
  if (value > 0.62) return RACE_LAYER_TARGETS[3];
  if (value > 0.35) return RACE_LAYER_TARGETS[2];
  if (value > 0.12) return RACE_LAYER_TARGETS[1];
  return RACE_LAYER_TARGETS[0];
}

// Прогрессия C — G — Am — F: светлая и «спортивная», хорошо ложится на аркадный раннер.
// Числа — частоты корней в герцах.
const PROGRESSION = [
  { root: 130.81, third: 164.81, fifth: 196.0 }, // C
  { root: 98.0, third: 123.47, fifth: 146.83 }, // G
  { root: 110.0, third: 130.81, fifth: 164.81 }, // Am
  { root: 87.31, third: 110.0, fifth: 130.81 } // F
];

// Пентатоника от C — любая нота из неё звучит уместно на любом аккорде прогрессии,
// поэтому мелодию можно генерировать случайно и она не сфальшивит.
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

export class Music {
  constructor(engine) {
    this.engine = engine;
    this.playing = false;
    this.step = 0;
    this.nextNoteTime = 0;
    this.timer = null;
    this.intensity = 0;
    this.layers = null;
    this.mode = MUSIC_MODE.RACE;
  }

  buildLayers() {
    if (this.layers || !this.engine.ready) return;
    const ctx = this.engine.ctx;
    const make = () => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.engine.musicBus);
      return gain;
    };
    this.layers = { bass: make(), drums: make(), chords: make(), lead: make() };
  }

  start(mode = MUSIC_MODE.RACE) {
    const nextMode = normalizeMode(mode);
    if (this.playing) {
      this.setMode(nextMode);
      return;
    }
    this.mode = nextMode;
    if (!this.engine.ready) return;
    this.buildLayers();
    this.playing = true;
    this.step = 0;
    this.nextNoteTime = this.engine.ctx.currentTime + 0.06;
    this.timer = setInterval(() => this.scheduler(), LOOKAHEAD_MS);
    this.setIntensity(this.intensity);
  }

  setMode(mode) {
    const next = normalizeMode(mode);
    if (this.mode === next) return false;
    this.mode = next;
    if (this.playing && this.engine.ready) {
      // Уже запланированные на ближайшие 120 мс ноты безопасно затихнут сами. Новый рисунок
      // начинается с первой доли, не создавая второй setInterval и не накладывая два loop-а.
      this.step = 0;
      this.nextNoteTime = this.engine.ctx.currentTime + 0.06;
      this.setIntensity(this.intensity);
    }
    return true;
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.layers) return;
    const t = this.engine.ctx.currentTime;
    for (const layer of Object.values(this.layers)) {
      layer.gain.cancelScheduledValues(t);
      layer.gain.setTargetAtTime(0, t, 0.2);
    }
  }

  // `value` от 0 (спокойно) до 1 (кульминация). Слои включаются порогами, а не линейно — так переход
  // слышится как «вступил барабанщик», а не как медленное выкручивание громкости.
  setIntensity(value) {
    this.intensity = Math.max(0, Math.min(1, value));
    if (!this.layers || !this.engine.ready) return;
    const t = this.engine.ctx.currentTime;
    const ramp = (node, target) => node.gain.setTargetAtTime(target, t, 0.6);
    const targets = musicLayerTargets(this.mode, this.intensity);
    ramp(this.layers.bass, targets.bass);
    ramp(this.layers.drums, targets.drums);
    ramp(this.layers.chords, targets.chords);
    ramp(this.layers.lead, targets.lead);
  }

  scheduler() {
    if (!this.playing) return;
    const ctx = this.engine.ctx;
    while (this.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
      this.scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += STEP_SECONDS;
      this.step = (this.step + 1) % (STEPS_PER_BAR * BARS);
    }
  }

  scheduleStep(step, time) {
    if (this.mode === MUSIC_MODE.MENU) {
      this.scheduleMenuStep(step, time);
      return;
    }
    this.scheduleRaceStep(step, time);
  }

  scheduleMenuStep(step, time) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const beat = step % STEPS_PER_BAR;
    const chord = PROGRESSION[bar % PROGRESSION.length];

    // Меню оставляет тот же светлый гармонический язык, но в нём нет гоночной бочки и плотного
    // ритма. Редкие мягкие аккорды и фиксированные «конфетные» ноты не утомляют при долгом выборе.
    if (beat === 0) {
      for (const freq of [chord.root * 2, chord.third * 2, chord.fifth * 2]) {
        this.note(this.layers.chords, freq, time, 1.35, 'sine', 0.12);
      }
      this.note(this.layers.bass, chord.root, time, 0.42, 'triangle', 0.22);
    }
    if (beat === 2 || beat === 10) {
      const offset = beat === 10 ? 2 : 0;
      const freq = PENTATONIC[(bar * 2 + offset) % PENTATONIC.length];
      this.note(this.layers.lead, freq, time, 0.24, 'sine', 0.13);
    }
    if (beat === 0 || beat === 8) this.hat(time, 0.035);
  }

  scheduleRaceStep(step, time) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const beat = step % STEPS_PER_BAR;
    const chord = PROGRESSION[bar % PROGRESSION.length];

    // Бас: корень на сильные доли, квинта на «и» третьей доли — простая, но живая линия.
    if (beat === 0 || beat === 6) this.note(this.layers.bass, chord.root, time, 0.34, 'sawtooth', 0.5);
    if (beat === 10) this.note(this.layers.bass, chord.fifth / 2, time, 0.26, 'sawtooth', 0.42);

    // Ударные: бочка на 1 и 3, малый на 2 и 4, хэты по восьмым.
    if (beat === 0 || beat === 8) this.kick(time);
    if (beat === 4 || beat === 12) this.snare(time);
    if (beat % 2 === 0) this.hat(time, beat % 4 === 0 ? 0.16 : 0.09);

    // Аккорды: выдержанное трезвучие на первой доле такта.
    if (beat === 0) {
      for (const freq of [chord.root * 2, chord.third * 2, chord.fifth * 2]) {
        this.note(this.layers.chords, freq, time, 0.9, 'triangle', 0.16);
      }
    }

    // Мелодия: редкие ноты пентатоники по нечётным шестнадцатым. Разреженность важнее нот —
    // плотная мелодия быстро утомляет на многократном перепрохождении.
    if (this.intensity > 0.62 && beat % 4 === 2 && Math.random() < 0.55) {
      const freq = PENTATONIC[Math.floor(Math.random() * PENTATONIC.length)];
      this.note(this.layers.lead, freq, time, 0.22, 'square', 0.2);
    }
  }

  note(destination, freq, time, duration, type, volume) {
    const ctx = this.engine.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(volume, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(time);
    osc.stop(time + duration + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  kick(time) {
    const ctx = this.engine.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    // Быстрый спад высоты со 150 до 45 Гц — так синтезируется бочка.
    osc.frequency.setValueAtTime(150, time);
    osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    gain.gain.setValueAtTime(0.6, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
    osc.connect(gain);
    gain.connect(this.layers.drums);
    osc.start(time);
    osc.stop(time + 0.2);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  snare(time) {
    this.noiseHit(time, 0.16, 'highpass', 1200, 0.34);
  }

  hat(time, volume) {
    this.noiseHit(time, 0.05, 'highpass', 7000, volume);
  }

  noiseHit(time, duration, filterType, freq, volume) {
    const ctx = this.engine.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.engine.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.layers.drums);
    source.start(time, Math.random() * 1.5);
    source.stop(time + duration + 0.02);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }
}
