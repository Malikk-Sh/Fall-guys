export const CENTER_TOLERANCE = 0.16;
export const STEER_PULSE_MS = 140;
export const DRIVER_CONTROL_PERIOD_MS = 220;
export const CENTERING_SPEED = 1.4;
export const STEER_LOOKAHEAD_SECONDS = 0.35;

export function steeringAxis({ x = 0, vx = 0 }) {
  const projectedX = x + vx * STEER_LOOKAHEAD_SECONDS;
  if (projectedX > CENTER_TOLERANCE && vx > -CENTERING_SPEED) return -1;
  if (projectedX < -CENTER_TOLERANCE && vx < CENTERING_SPEED) return 1;
  return 0;
}

export function steeringKey(status) {
  const axis = steeringAxis(status);
  return axis < 0 ? 'KeyA' : axis > 0 ? 'KeyD' : null;
}
