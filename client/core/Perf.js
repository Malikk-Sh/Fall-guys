// Бюджет кадра и адаптивное качество.
//
// Игра ориентирована на телефоны, а разброс их производительности огромен: от устройств, которые
// тянут полное качество со свечением и тенями, до тех, где просадка начинается на пустой сцене.
// Определить это заранее нельзя — `detectQuality` угадывает по числу ядер и памяти, но угадывает
// грубо: слабый телефон с восемью ядрами получал высокое качество и играл в двадцать кадров.
//
// Поэтому качество определяется не однократной догадкой, а измерением: модуль копит времена кадров
// и говорит, укладывается ли игра в бюджет. Решение принимается по медиане, а не по среднему —
// одна долгая пауза сборщика мусора не должна выглядеть как систематическая просадка.
//
// Два правила против «дрожания» качества (когда снижение возвращает частоту кадров, повышение
// снова её роняет, и так по кругу):
//
//   1. Асимметричные окна. Понижаем быстро — игрок уже страдает. Повышаем медленно и только при
//      заметном запасе, а не на границе бюджета.
//   2. Затухающие попытки. Каждое возвращение к высокому качеству, закончившееся новым понижением,
//      уменьшает число оставшихся попыток. Исчерпав их, остаёмся на низком навсегда: устройство
//      уже дважды доказало, что не тянет, и третья проверка — это просто ещё одна просадка.

// Целевое время кадра. 60 Гц — то, на что рассчитана физика; выше нам не нужно, ниже уже заметно.
export const FRAME_BUDGET_MS = 1000 / 60;

// Порог, за которым кадр считается просевшим. Ровно бюджет брать нельзя: около него любая игра
// колеблется, и качество снижалось бы на здоровом устройстве.
const DEGRADED_MS = 1000 / 48;

// Порог возврата. Между ним и порогом просадки лежит зона покоя, в которой ничего не меняется.
const COMFORTABLE_MS = 1000 / 58;

// Сколько кадров держим для оценки. Около четырёх секунд при 60 Гц.
const WINDOW = 240;

// Сколько времени подряд надо не укладываться в бюджет, прежде чем снизить качество.
const DROP_AFTER_MS = 2500;

// И сколько подряд укладываться с запасом, прежде чем попробовать вернуть.
const RAISE_AFTER_MS = 15_000;

// Сколько раз пробуем вернуть высокое качество, прежде чем признать устройство слабым.
const RAISE_ATTEMPTS = 2;

export class Perf {
  constructor({ enabled = false } = {}) {
    this.frames = new Float32Array(WINDOW);
    this.count = 0;
    this.index = 0;
    this.sorted = new Float32Array(WINDOW);

    this.degradedSince = 0;
    this.comfortableSince = 0;
    this.raiseAttempts = RAISE_ATTEMPTS;

    this.overlay = null;
    this.lastPaint = 0;
    if (enabled) this.showOverlay();
  }

  // Кадр отрисован. `ms` — сколько он занял целиком, от начала цикла до конца отрисовки.
  sample(ms) {
    this.frames[this.index] = ms;
    this.index = (this.index + 1) % WINDOW;
    this.count = Math.min(WINDOW, this.count + 1);
  }

  // Медиана окна. Считается по копии: сортировать сам буфер нельзя, он кольцевой.
  get median() {
    if (!this.count) return 0;
    const view = this.sorted.subarray(0, this.count);
    view.set(this.frames.subarray(0, this.count));
    view.sort();
    return view[this.count >> 1];
  }

  get fps() {
    const median = this.median;
    return median > 0 ? Math.round(1000 / median) : 0;
  }

  // Хватает ли данных для решения. На первых кадрах после загрузки они заведомо плохие:
  // компилируются шейдеры, строится трасса. Судить по ним нельзя.
  get ready() {
    return this.count >= WINDOW >> 1;
  }

  // Нужно ли менять качество. Возвращает -1 (снизить), +1 (вернуть) или 0.
  //
  // Метод не знает ни о каком «качестве» — он знает только про время кадра. Что именно менять,
  // решает вызывающий: так эту логику можно проверить в тестах без браузера и рендерера.
  verdict(now) {
    if (!this.ready) return 0;
    const median = this.median;

    if (median > DEGRADED_MS) {
      this.comfortableSince = 0;
      if (!this.degradedSince) this.degradedSince = now;
      if (now - this.degradedSince >= DROP_AFTER_MS) {
        this.degradedSince = 0;
        return -1;
      }
      return 0;
    }

    if (median < COMFORTABLE_MS) {
      this.degradedSince = 0;
      if (!this.comfortableSince) this.comfortableSince = now;
      if (now - this.comfortableSince >= RAISE_AFTER_MS && this.raiseAttempts > 0) {
        this.comfortableSince = 0;
        return 1;
      }
      return 0;
    }

    // Зона покоя между порогами: ни одна из сторон не набирает время.
    this.degradedSince = 0;
    this.comfortableSince = 0;
    return 0;
  }

  // Попытка возврата не удалась — устройство снова просело. Следующая попытка будет последней.
  raiseFailed() {
    this.raiseAttempts = Math.max(0, this.raiseAttempts - 1);
  }

  // Показания сбрасываются при смене сцены: времена кадров меню ничего не говорят о трассе.
  reset() {
    this.count = 0;
    this.index = 0;
    this.degradedSince = 0;
    this.comfortableSince = 0;
  }

  showOverlay() {
    if (this.overlay) return;
    const node = document.createElement('div');
    node.className = 'perf-overlay';
    document.body.appendChild(node);
    this.overlay = node;
  }

  hideOverlay() {
    this.overlay?.remove();
    this.overlay = null;
  }

  toggleOverlay() {
    if (this.overlay) this.hideOverlay();
    else this.showOverlay();
  }

  // Обновление счётчиков. Реже, чем раз в кадр: перерисовка текста сама по себе стоит времени,
  // а измерительный прибор не должен влиять на измеряемое.
  paint(now, renderer, extra = {}) {
    if (!this.overlay || now - this.lastPaint < 250) return;
    this.lastPaint = now;
    const median = this.median;
    const info = renderer?.info;
    const rows = [
      `${this.fps} FPS · ${median.toFixed(1)} мс`,
      `бюджет ${FRAME_BUDGET_MS.toFixed(1)} мс${median > DEGRADED_MS ? ' · ПРЕВЫШЕН' : ''}`,
      info ? `вызовов ${info.render.calls} · треуг. ${(info.render.triangles / 1000).toFixed(1)}к` : '',
      info ? `геометрий ${info.memory.geometries} · текстур ${info.memory.textures}` : ''
    ];
    for (const [key, value] of Object.entries(extra)) rows.push(`${key} ${value}`);
    this.overlay.textContent = rows.filter(Boolean).join('\n');
    this.overlay.dataset.over = median > DEGRADED_MS ? '1' : '0';
  }
}
