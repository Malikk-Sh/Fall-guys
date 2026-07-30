// Личные рекорды.
//
// Вынесено из UI отдельным модулем по одной причине: здесь есть правило, которое легко нарушить
// незаметно — забег без зачёта рекорд НЕ переписывает. Забег теряет зачёт, когда посреди него
// оборвалась связь или вышел напарник: половину трассы в таком прохождении бежали не по правилам,
// и записанное время навсегда закрыло бы честный рекорд. Правило проверяется тестами, а для этого
// его нужно уметь вызвать без браузера.

const SOLO_PREFIX = 'wobble-best';
const COOP_PREFIX = 'wobble-coop-best';

export const soloKey = (seed, difficulty) => `${SOLO_PREFIX}-${seed}-${difficulty}`;
export const coopKey = chapterId => `${COOP_PREFIX}-${chapterId}`;

// Хранилище может быть недоступно (приватный режим, отключённые куки) — это не повод падать
// на финише, поэтому все обращения обёрнуты.
function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

// Текущий рекорд в миллисекундах либо null, если его ещё нет.
export function readBest(key) {
  const store = storage();
  if (!store) return null;
  try {
    const value = Number(store.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

// Пытается записать время как рекорд.
//
// Возвращает `{ best, improved }`: `best` — рекорд после попытки (может остаться прежним),
// `improved` — переписали ли мы его сейчас. Вызывающему это нужно, чтобы решить, показывать ли
// поздравление, а не вычислять то же самое второй раз.
export function saveBest(key, time, { unranked = null } = {}) {
  const best = readBest(key);
  if (unranked || !Number.isFinite(time) || time <= 0) return { best, improved: false };
  if (best && time >= best) return { best, improved: false };
  const store = storage();
  if (!store) return { best, improved: false };
  try {
    store.setItem(key, String(Math.round(time)));
  } catch {
    return { best, improved: false };
  }
  return { best: Math.round(time), improved: true, first: !best };
}
