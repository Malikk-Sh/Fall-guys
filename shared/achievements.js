export const DEFAULT_PROFILE_TITLE = 'ИСКАТЕЛЬ НЕБЕС';
export const CAMPAIGN_PROFILE_TITLE = 'ПОКОРИТЕЛЬ НЕБЕС';
export const CAMPAIGN_BADGE_GLYPH = '✦';

export const ACHIEVEMENT_CATALOG = Object.freeze([
  {
    id: 'coop-first-clear',
    name: 'Первый шаг',
    detail: 'Пройдите любую кооперативную главу.',
    glyph: '●'
  },
  {
    id: 'coop-flawless',
    name: 'Чистое прохождение',
    detail: 'Пройдите главу без единого падения.',
    glyph: '◇'
  },
  {
    id: 'coop-ch10-clear',
    name: 'Сквозь обвал',
    detail: 'Доберитесь до конца десятой главы.',
    glyph: '▲'
  },
  {
    id: 'coop-flawless-5',
    name: 'Безупречная пятёрка',
    detail: 'Завершите пять глав без падений.',
    glyph: '◆'
  },
  {
    id: 'coop-helper-25',
    name: 'Надёжное плечо',
    detail: 'Спасите напарников двадцать пять раз.',
    glyph: '♥'
  },
  {
    id: 'coop-campaign-complete',
    name: 'Вся дорога',
    detail: 'Пройдите все десять глав приключения.',
    glyph: CAMPAIGN_BADGE_GLYPH
  },

  // Гонка. До этого весь список был кооперативным: игрок, который приходил играть в онлайн-гонку —
  // тот самый режим, что заявлен главным, — не мог получить ни одной награды за то, чем занимался.
  //
  // Все четыре считаются из того, что сервер знает сам: факт финиша и место в протоколе. Награды за
  // «чистый забег» здесь нет намеренно — падения в гонке сервер не считает, и достижение пришлось
  // бы вешать на данные, которых нет.
  {
    id: 'race-first-finish',
    name: 'Первый финиш',
    detail: 'Дойдите до ленты в онлайн-гонке.',
    glyph: '▸'
  },
  {
    id: 'race-podium',
    name: 'На пьедестале',
    detail: 'Войдите в тройку в гонке, где было не меньше трёх финишировавших.',
    glyph: '▲'
  },
  {
    id: 'race-win',
    name: 'Первый среди равных',
    detail: 'Выиграйте онлайн-гонку у живого соперника.',
    glyph: '★'
  },
  {
    id: 'race-veteran-25',
    name: 'Завсегдатай',
    detail: 'Финишируйте в двадцати пяти онлайн-гонках.',
    glyph: '◈'
  }
]);

const BY_ID = new Map(ACHIEVEMENT_CATALOG.map(item => [item.id, item]));

export function achievementById(id) {
  return BY_ID.get(String(id || '')) || null;
}
