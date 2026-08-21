// Размеры персонажа переехали в общий код: по ним серверная симуляция считает, на какой высоте
// игрок стоит на опоре, а значит они не могут жить только в клиенте. Здесь остаётся реэкспорт,
// чтобы клиентские модули не меняли свои импорты.
export {
  PLAYER_VISUAL_SCALE,
  PLAYER_FOOT,
  PLAYER_BODY_RADIUS,
  PLAYER_OBSTACLE_RADIUS,
  PLAYER_CROWD_RADIUS
} from '/shared/playerDimensions.js';
