// Выбор качества графики.
//
// Здесь только решение — «низкое» или «высокое», — и ничего из последствий. Плотность пикселей,
// тени, постобработка и лимит частиц применяются в игре: она владеет этими объектами, а решение от
// них не зависит и потому проверяется без сцены, браузера и видеокарты.
//
// Три источника, и порядок между ними важен:
//
//   1. выбор игрока — сильнее всего. Если человек поставил «высокое» и играет в двадцать кадров,
//      это его решение, и менять его за него нельзя;
//   2. измерение времени кадра — то, что видит игрок на самом деле;
//   3. догадка по железу — только для первых секунд, пока измерять ещё нечего.

const LEVELS = ['auto', 'low', 'high'];

// Насколько недавним считается возврат к высокому качеству. Понижение сразу после возврата
// означает, что возврат был ошибкой, и Perf должен об этом узнать: следующая попытка будет позже.
const RAISE_REGRET_MS = 60_000;

export class Quality {
  // `device` вынесен параметром, чтобы правило проверялось на любых характеристиках, а не только
  // на тех, что у машины, где запущен тест.
  constructor({ device = defaultDevice } = {}) {
    this.choice = 'auto';
    this.measured = guess(device());
    this.raisedAt = 0;
    this.device = device;
  }

  // Что применять прямо сейчас.
  effective() {
    return this.choice === 'auto' ? this.measured || guess(this.device()) : this.choice;
  }

  // Следующий вариант по кругу: auto → low → high → auto. Возврат в «auto» начинает подбор заново —
  // прошлые измерения относились к другой картинке.
  cycle() {
    this.choice = LEVELS[(LEVELS.indexOf(this.choice) + 1) % LEVELS.length];
    if (this.choice === 'auto') this.measured = guess(this.device());
    return this.choice;
  }

  // Подстройка по бюджету кадра. Возвращает новый уровень, если он изменился, иначе null —
  // сообщать игроку не о чем.
  //
  // Работает только в режиме «auto» и только во время забега: в меню кадры рисует предпросмотр,
  // и мерить по нему нагрузку трассы бессмысленно.
  adapt(now, { running, perf }) {
    if (this.choice !== 'auto' || !running) return null;
    const verdict = perf.verdict(now);
    if (!verdict) return null;

    if (verdict < 0) {
      if (this.measured === 'low') return null;
      if (this.raisedAt && now - this.raisedAt < RAISE_REGRET_MS) perf.raiseFailed();
      this.measured = 'low';
      perf.reset();
      return 'low';
    }

    if (this.measured === 'high') return null;
    this.measured = 'high';
    this.raisedAt = now;
    perf.reset();
    return 'high';
  }

  // Как показать состояние игроку: «авто (low)» и выбранное руками «low» — разные вещи, и
  // отличать их надо, иначе непонятно, кто принял решение.
  label() {
    return this.choice === 'auto' ? `авто (${this.measured})` : this.choice;
  }
}

// Начальное приближение по характеристикам устройства. Нужно только чтобы первые секунды не
// оказались заведомо провальными: дальше решение принимает измерение кадров.
//
// Догадка груба намеренно и ошибается в обе стороны — слабый телефон с восемью ядрами получал
// высокое качество и играл в двадцать кадров. Поэтому она и не окончательна.
function guess({ memory, cores, coarsePointer, pixelRatio }) {
  const constrained = (memory && memory <= 4) || (cores && cores <= 4) || (coarsePointer && pixelRatio > 2.5);
  return constrained ? 'low' : 'high';
}

function defaultDevice() {
  return {
    memory: navigator.deviceMemory,
    cores: navigator.hardwareConcurrency,
    coarsePointer: matchMedia('(pointer:coarse)').matches,
    pixelRatio: devicePixelRatio
  };
}
