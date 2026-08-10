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
  }
]);

const BY_ID = new Map(ACHIEVEMENT_CATALOG.map(item => [item.id, item]));

export function achievementById(id) {
  return BY_ID.get(String(id || '')) || null;
}
