// Палитра игры.
//
// Живёт в shared/, потому что расстановка сегментов трассы переехала сюда же и красит опоры этими
// же именами. Сервер цвета не использует и использовать не должен: они только для отрисовки.
export const COLORS = {
  purple: 0x6546d8,
  purpleDark: 0x34206f,
  pink: 0xff4f91,
  yellow: 0xffd94b,
  cyan: 0x48dcda,
  mint: 0x58ebb8,
  orange: 0xff914d,
  blue: 0x55a7ff,
  white: 0xf7fbff,
  ink: 0x261653
};

// Семантический слой поверх базовой палитры. Gameplay не должен принимать решения по этим цветам:
// токены нужны только presentation-коду, чтобы одинаковые роли выглядели одинаково во всей игре.
// Когда арт-направление меняется, роль можно перекрасить здесь, а не искать случайные hex по сцене.
export const VISUAL_TOKENS = Object.freeze({
  surfacePrimary: COLORS.cyan,
  surfaceSecondary: COLORS.purple,
  danger: COLORS.pink,
  bounce: COLORS.yellow,
  checkpoint: COLORS.mint,
  finish: COLORS.pink,
  finishAccent: COLORS.yellow,
  rail: COLORS.white,
  cloud: COLORS.white,
  uiPanel: COLORS.purpleDark,
  uiAccent: COLORS.yellow
});

// Палитра сегментов трассы: цвет выбирается по индексу сегмента и seed, поэтому порядок значим.
export const COURSE_PALETTE = [
  COLORS.purple,
  COLORS.orange,
  COLORS.cyan,
  COLORS.pink,
  COLORS.blue,
  COLORS.mint,
  COLORS.yellow
];
