// Размер персонажа — одна система для визуала и всех физических приближений.
// Менять одно без другого нельзя: маленькая модель с прежним хитбоксом получает невидимые удары,
// а уменьшенный hitbox при большой модели визуально проходит сквозь препятствия.
export const PLAYER_VISUAL_SCALE = 0.8;
export const PLAYER_FOOT = 0.48 * PLAYER_VISUAL_SCALE;
export const PLAYER_BODY_RADIUS = 0.48 * PLAYER_VISUAL_SCALE;
export const PLAYER_OBSTACLE_RADIUS = 0.42 * PLAYER_VISUAL_SCALE;
export const PLAYER_CROWD_RADIUS = 0.72 * PLAYER_VISUAL_SCALE;
