// Ядро звука.
//
// Ключевое решение: весь звук синтезируется процедурно через Web Audio API, файлов ассетов нет вообще.
// Причины: у проекта нет пайплайна ассетов и загрузчика, а раздача с внешних CDN заблокирована политикой
// безопасности. Синтез даёт нулевой вес загрузки, мгновенную готовность и бесплатную вариативность —
// каждый удар звучит чуть иначе, поэтому повторы не приедаются. Если позже понадобится записанный звук,
// заменяется послойно: интерфейс `play(name, options)` останется прежним.
//
// Устройство: три шины громкости (мастер → эффекты и музыка), ограничитель на выходе, чтобы плотные
// сцены не клиппировали, и простая панорама по позиции источника относительно камеры.

const STORAGE_KEY = 'wobble-audio-v1';
const DEFAULT_VOLUMES = { master: 0.8, sfx: 0.9, music: 0.5 };

// Больше одновременных голосов человек всё равно не различает, а нагрузка растёт линейно.
const MAX_VOICES = 24;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.voices = 0;
    this.volumes = { ...DEFAULT_VOLUMES, ...this.loadVolumes() };
    // Позиция и направление слушателя обновляются камерой каждый кадр (см. setListener).
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.cooldowns = new Map();
    this.muted = false;
  }

  loadVolumes() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  saveVolumes() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.volumes));
    } catch {
      // Приватный режим браузера — не повод падать.
    }
  }

  // Браузеры не дают запустить звук до первого жеста пользователя, поэтому контекст создаётся лениво,
  // а `unlock` вызывается из обработчика клика или касания.
  unlock() {
    if (this.ready) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.buildGraph();
    this.ready = true;
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  buildGraph() {
    const ctx = this.ctx;

    // Мягкий ограничитель на выходе: при плотном экшене десяток эффектов подряд иначе даёт хрип.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.master = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();

    // Фильтр на шине эффектов: при падении в пропасть его частота уводится вниз, звук глохнет.
    this.sfxFilter = ctx.createBiquadFilter();
    this.sfxFilter.type = 'lowpass';
    this.sfxFilter.frequency.value = 20000;

    this.sfxBus.connect(this.sfxFilter);
    this.sfxFilter.connect(this.master);
    this.musicBus.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.applyVolumes();
    this.noiseBuffer = this.createNoiseBuffer();
  }

  applyVolumes() {
    if (!this.ready) return;
    const scale = this.muted ? 0 : 1;
    this.master.gain.value = this.volumes.master * scale;
    this.sfxBus.gain.value = this.volumes.sfx;
    this.musicBus.gain.value = this.volumes.music;
  }

  setVolume(bus, value) {
    this.volumes[bus] = Math.max(0, Math.min(1, value));
    this.applyVolumes();
    this.saveVolumes();
  }

  setMuted(muted) {
    this.muted = !!muted;
    this.applyVolumes();
  }

  // Две секунды белого шума — сырьё для всех ударных, шагов и свистов. Генерируется один раз.
  createNoiseBuffer() {
    const ctx = this.ctx;
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // Вкладка ушла в фон — звук замолкает, чтобы игра не бубнила в соседней вкладке.
  setSuspended(suspended) {
    if (!this.ready) return;
    if (suspended && this.ctx.state === 'running') this.ctx.suspend();
    if (!suspended && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // Глушение верхов при падении: аргумент 0 — обычный звук, 1 — полностью «под водой».
  setMuffle(amount) {
    if (!this.ready) return;
    const clamped = Math.max(0, Math.min(1, amount));
    // Логарифмическая шкала: слух воспринимает частоту логарифмически, линейная звучала бы рывком.
    const target = 20000 * Math.pow(0.02, clamped);
    this.sfxFilter.frequency.setTargetAtTime(target, this.now, 0.05);
  }

  setListener(position, yaw) {
    this.listener.x = position.x;
    this.listener.y = position.y;
    this.listener.z = position.z;
    this.listener.yaw = yaw;
  }

  // Упрощённая пространственная модель вместо полноценного HRTF: считаем громкость по расстоянию и
  // панораму по боковому смещению относительно взгляда камеры. Этого достаточно, чтобы понять, с какой
  // стороны напарник, и стоит на порядок дешевле PannerNode на каждый звук.
  spatial(position, maxDistance = 45) {
    if (!position) return { gain: 1, pan: 0 };
    const dx = position.x - this.listener.x;
    const dy = position.y - this.listener.y;
    const dz = position.z - this.listener.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > maxDistance) return { gain: 0, pan: 0 };

    // Затухание вида 1/(1+d) звучит естественнее линейного и никогда не уходит в ноль скачком.
    const gain = 1 / (1 + (distance / maxDistance) * 6);

    // Поворачиваем вектор до источника в систему координат камеры, берём боковую составляющую.
    const sin = Math.sin(this.listener.yaw);
    const cos = Math.cos(this.listener.yaw);
    const right = dx * cos - dz * sin;
    const pan = Math.max(-1, Math.min(1, right / Math.max(1, distance)));
    return { gain, pan };
  }

  // Учёт голосов: узлы Web Audio освобождаются сборщиком только после остановки и отключения,
  // поэтому считаем их сами и не даём сцене разрастись.
  claimVoice() {
    if (this.voices >= MAX_VOICES) return false;
    this.voices++;
    return true;
  }

  releaseVoice() {
    this.voices = Math.max(0, this.voices - 1);
  }

  // Защита от «пулемёта»: один и тот же звук не чаще, чем раз в `seconds`.
  throttle(key, seconds) {
    const last = this.cooldowns.get(key) || 0;
    const now = this.now;
    if (now - last < seconds) return false;
    this.cooldowns.set(key, now);
    return true;
  }

  // Общая обвязка голоса: канал громкости, панорама и автоматическое освобождение по завершении.
  createVoice({ position, volume = 1, maxDistance = 45 } = {}) {
    if (!this.ready || !this.claimVoice()) return null;
    const ctx = this.ctx;
    const gain = ctx.createGain();
    const { gain: spatialGain, pan } = this.spatial(position, maxDistance);
    if (position && spatialGain <= 0.001) {
      this.releaseVoice();
      return null;
    }
    gain.gain.value = volume * (position ? spatialGain : 1);

    let output = gain;
    if (position && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner);
      output = panner;
    }
    output.connect(this.sfxBus);
    return { ctx, gain, output, release: () => this.releaseVoice() };
  }

  // Осциллятор с заданной огибающей. `freq` может быть числом или парой [от, до] для глиссандо.
  playTone({
    freq = 440,
    type = 'sine',
    duration = 0.2,
    attack = 0.005,
    volume = 0.3,
    position = null,
    detune = 0,
    maxDistance = 45
  } = {}) {
    const voice = this.createVoice({ position, volume, maxDistance });
    if (!voice) return;
    const { ctx, gain } = voice;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.detune.value = detune;

    if (Array.isArray(freq)) {
      osc.frequency.setValueAtTime(freq[0], t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq[1]), t + duration);
    } else {
      osc.frequency.setValueAtTime(freq, t);
    }

    // Экспоненциальный спад вместо линейного — так затухание слышится ровным.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain.gain.value || volume), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(gain);
    osc.start(t);
    osc.stop(t + duration + 0.02);
    osc.onended = () => {
      osc.disconnect();
      voice.output.disconnect();
      voice.release();
    };
  }

  // Отфильтрованный шум: основа ударов, шагов, приземлений и свиста ветра.
  playNoise({
    duration = 0.2,
    filter = 'bandpass',
    freq = 800,
    q = 1,
    volume = 0.3,
    attack = 0.002,
    position = null,
    sweepTo = null,
    maxDistance = 45
  } = {}) {
    const voice = this.createVoice({ position, volume, maxDistance });
    if (!voice) return;
    const { ctx, gain } = voice;
    const t = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    // Случайная точка старта в буфере, чтобы одинаковые удары не звучали идентично.
    source.loop = true;

    const biquad = ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.frequency.setValueAtTime(freq, t);
    biquad.Q.value = q;
    if (sweepTo) biquad.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t + duration);

    const peak = gain.gain.value || volume;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    source.connect(biquad);
    biquad.connect(gain);
    source.start(t, Math.random() * 1.5);
    source.stop(t + duration + 0.02);
    source.onended = () => {
      source.disconnect();
      biquad.disconnect();
      voice.output.disconnect();
      voice.release();
    };
  }
}
