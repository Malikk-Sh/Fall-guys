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

// Все локальные рекорды одним списком — для переноса в аккаунт при первом входе.
//
// Рекорды лежат отдельными ключами localStorage, по одному на трассу, поэтому собрать их можно
// только перебором хранилища. Формат ключа разбирается здесь же: соло — сид и сложность, кооп —
// идентификатор главы, и оба приводятся к тому виду courseKey, который ждёт сервер.
export function listLocalRecords() {
  const store = storage();
  if (!store) return [];
  const found = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (typeof key !== 'string') continue;
    const time = readBest(key);
    if (!time) continue;
    if (key.startsWith(`${COOP_PREFIX}-`)) {
      const chapterId = key.slice(COOP_PREFIX.length + 1);
      if (chapterId) found.push({ mode: 'coop', courseKey: chapterId, time });
      continue;
    }
    if (!key.startsWith(`${SOLO_PREFIX}-`)) continue;
    // Соло-ключ: <префикс>-<сид>-<сложность>. Сложность — последний кусок, сид — всё между ними;
    // разбирать с конца надёжнее, чем делить по дефису: сид тоже может его содержать.
    const rest = key.slice(SOLO_PREFIX.length + 1);
    const cut = rest.lastIndexOf('-');
    if (cut <= 0) continue;
    const seed = rest.slice(0, cut);
    const difficulty = rest.slice(cut + 1);
    if (seed && difficulty) found.push({ mode: 'solo', courseKey: `${seed}:${difficulty}`, time });
  }
  return found;
}
