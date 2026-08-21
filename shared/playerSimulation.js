// Pure fixed-step player motion shared by the browser and authoritative server.
//
// This is deliberately the first, collision-free migration slice. Course surfaces, obstacle
// impulses, checkpoints and finish remain in their existing world layers for now. Keeping the
// motion kernel on plain data lets both sides execute the same acceleration, jump, dive, timers
// and gravity without importing Three.js or browser APIs.

import { supportIndexAt, supportTop } from './courseCollision.js';

// Выше этой скорости вверх опора не подхватывается вовсе. Отдельно от общего порога свип-теста:
// тот отсекает пролёт снизу, этот — момент отрыва, когда игрок уже пошёл вверх.
export const GROUND_CONTACT_MAX_UPWARD_SPEED = 1.5;

export const PLAYER_SIMULATION_CONSTANTS = Object.freeze({
  GRAVITY: 22.5,
  JUMP_SPEED: 8.7,
  DIVE_SPEED: 10.8,
  RUN_SPEED: 7.7,
  ACCEL_GROUND: 18,
  ACCEL_AIR: 7.2,
  ROLL_TIME: 0.42,
  ROLL_SPEED: 10.2,
  LANDING_RETENTION_TIME: 0.34,
  KNOCKDOWN_IMMUNITY_TIME: 0.7,
  GETUP_TIME: 0.24,
  JUMP_BUFFER: 0.14,
  COYOTE_TIME: 0.11,
  GLIDE_GRAVITY: 0.55
});

const {
  ROLL_TIME,
  GRAVITY,
  JUMP_SPEED,
  DIVE_SPEED,
  RUN_SPEED,
  ACCEL_GROUND,
  ACCEL_AIR,
  ROLL_SPEED,
  LANDING_RETENTION_TIME,
  KNOCKDOWN_IMMUNITY_TIME,
  GETUP_TIME,
  JUMP_BUFFER,
  COYOTE_TIME,
  GLIDE_GRAVITY
} = PLAYER_SIMULATION_CONSTANTS;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value) {
  return Math.max(0, finite(value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function playerTuning(modifier = null) {
  return {
    gravity: positive(modifier?.gravity, 1),
    jump: positive(modifier?.jump, 1),
    dash: positive(modifier?.dash, 1),
    dashCooldown: positive(modifier?.dashCooldown, 1),
    groundGrip: positive(modifier?.groundGrip, 1),
    glide: modifier?.glide !== false
  };
}

export function createPlayerSimulationState(overrides = {}) {
  const position = overrides.position || {};
  const velocity = overrides.velocity || {};
  return {
    position: {
      x: finite(position.x),
      y: finite(position.y),
      z: finite(position.z)
    },
    velocity: {
      x: finite(velocity.x),
      y: finite(velocity.y),
      z: finite(velocity.z)
    },
    grounded: overrides.grounded === true,
    coyoteTime: nonNegative(overrides.coyoteTime),
    jumpBuffer: nonNegative(overrides.jumpBuffer),
    diveTimer: nonNegative(overrides.diveTimer),
    diveCooldown: nonNegative(overrides.diveCooldown),
    rollTimer: nonNegative(overrides.rollTimer),
    landingRetention: nonNegative(overrides.landingRetention),
    recoveryWindow: nonNegative(overrides.recoveryWindow),
    knockdownTimer: nonNegative(overrides.knockdownTimer),
    knockdownImmunity: nonNegative(overrides.knockdownImmunity),
    getupTimer: nonNegative(overrides.getupTimer),
    slamming: overrides.slamming === true,
    gliding: overrides.gliding === true,
    finished: overrides.finished === true,
    dashes: Math.max(0, Math.trunc(finite(overrides.dashes)))
  };
}

export function normalizePlayerInput(input = {}) {
  let moveX = clamp(finite(input.moveX), -1, 1);
  let moveZ = clamp(finite(input.moveZ), -1, 1);
  const magnitude = Math.hypot(moveX, moveZ);
  if (magnitude > 1) {
    moveX /= magnitude;
    moveZ /= magnitude;
  }
  return {
    moveX,
    moveZ,
    moveMagnitude: Math.min(1, magnitude),
    cameraYaw: finite(input.cameraYaw),
    jumpPressed: input.jumpPressed === true,
    jumpHeld: input.jumpHeld === true,
    divePressed: input.divePressed === true
  };
}

export function dampScalar(current, target, smoothing, dt) {
  return current + (target - current) * (1 - Math.exp(-smoothing * dt));
}

// Куда игрок хочет двигаться с учётом поворота камеры.
//
// Формула одна на клиент и сервер именно как код, а не как описание. Раньше клиент считал то же
// самое своими средствами: поворот, затем нормализация через Vector3.normalize, то есть через
// sqrt(x²+z²). Здесь длина берётся Math.hypot, и на части углов эти два способа дают разный
// последний разряд — направление расходилось на ~2e-16 на каждом шаге. Величина ничтожная, но она
// накапливается при переигрывании неподтверждённого ввода, и «одинаковое правило у клиента и
// сервера» переставало быть правдой ровно там, где на него собираются опереться.
export function movementIntent(rawInput) {
  return normalizedDirection(cameraRelativeIntent(normalizePlayerInput(rawInput)));
}

function cameraRelativeIntent(input) {
  const sin = Math.sin(input.cameraYaw);
  const cos = Math.cos(input.cameraYaw);
  return {
    x: cos * input.moveX - sin * input.moveZ,
    z: -sin * input.moveX - cos * input.moveZ
  };
}

function normalizedDirection(direction) {
  const length = Math.hypot(direction.x, direction.z);
  if (length <= 1) return direction;
  return { x: direction.x / length, z: direction.z / length };
}

function cloneState(state) {
  return {
    ...state,
    position: { ...state.position },
    velocity: { ...state.velocity }
  };
}

// Постановка на опору после шага движения.
//
// Раньше это существовало только в клиенте и читалось из мешей, поэтому серверный игрок падал
// сквозь трассу и авторитет движения не мог быть выдан честно. Здесь тот же расчёт работает над
// плоским списком опор — тем самым, что клиент строит из своей геометрии, а сервер получает
// безголовой сборкой.
//
// Возвращается новое состояние и события приземления: подача (звук, тряска, частицы) остаётся
// снаружи, потому что физика от неё не зависит и зависеть не должна.
export function resolveGroundContact(
  state,
  { colliders = [], previousY = state.position.y, footOffset = 0, intent = null, wasGrounded = null } = {}
) {
  const next = cloneState(createPlayerSimulationState(state));
  const events = [];
  const grounded = wasGrounded === null ? state.grounded === true : wasGrounded === true;
  const landingVelocity = next.velocity.y;

  next.grounded = false;
  const index = supportIndexAt(colliders, next.position, previousY, landingVelocity, footOffset);
  // Второй, более строгий порог: опора не подхватывается тем, кто ещё заметно летит вверх.
  if (index < 0 || landingVelocity > GROUND_CONTACT_MAX_UPWARD_SPEED) return { state: next, events };

  const support = colliders[index];
  next.position.y = supportTop(support) + footOffset;
  // Перенос движущейся платформой: её сдвиг за шаг добавляется к позиции игрока, иначе он
  // соскальзывал бы с неё, стоя на месте.
  const carry = support.delta;
  if (carry) {
    next.position.x += finite(carry.x);
    next.position.y += finite(carry.y);
    next.position.z += finite(carry.z);
  }
  next.velocity.y = 0;
  next.grounded = true;
  next.slamming = false;

  const landingSpeed = Math.hypot(next.velocity.x, next.velocity.z);
  if (!grounded && next.diveTimer > 0 && landingSpeed > RUN_SPEED + 0.45) {
    next.rollTimer = ROLL_TIME;
    next.recoveryWindow = 0.18;
    next.landingRetention = LANDING_RETENTION_TIME;
    next.diveTimer = 0;
    events.push({ name: 'roll' });
  } else if (
    !grounded &&
    landingVelocity > -7.5 &&
    landingVelocity < -2.8 &&
    landingSpeed > RUN_SPEED * 0.82 &&
    alignedWithMotion(intent, next.velocity)
  ) {
    // Мягкое приземление по направлению движения не дарит скорость из воздуха — оно лишь
    // ненадолго не даёт уже набранному импульсу исчезнуть.
    next.landingRetention = LANDING_RETENTION_TIME;
  }
  if (!grounded && landingVelocity < -3.2) events.push({ name: 'land', landingVelocity });

  return { state: next, events, supportIndex: index };
}

function alignedWithMotion(intent, velocity) {
  if (!intent) return false;
  const length = Math.hypot(velocity.x, velocity.z);
  if (length === 0) return false;
  return (intent.x * velocity.x + intent.z * velocity.z) / length > 0.82;
}

// Advances the collision-free motion slice by exactly one fixed step.
//
// `moveZ` means camera-forward input, matching InputManager's existing `forward` value. The world
// layer remains responsible for wall bounce, surfaces, moving platforms, obstacle impulses,
// checkpoint/finish checks and presentation events. Returned event names let that layer preserve
// existing SFX/VFX without putting presentation inside deterministic simulation.
export function stepPlayerMotion(previousState, rawInput, context = {}, dt) {
  if (!Number.isFinite(dt) || dt <= 0) throw new TypeError('dt must be a positive finite number');

  const state = cloneState(createPlayerSimulationState(previousState));
  const input = normalizePlayerInput(rawInput);
  const tuning = context.tuning || playerTuning(context.modifier);
  const knockdownControl = clamp(finite(context.knockdownControl), 0, 1);
  const characterYaw = finite(context.characterYaw);
  const events = [];

  if (state.finished) return { state, events, intentX: 0 };

  const knockedDown = state.knockdownTimer > 0;
  state.knockdownImmunity = Math.max(0, state.knockdownImmunity - dt);
  if (knockedDown) {
    state.knockdownTimer = Math.max(0, state.knockdownTimer - dt);
    if (state.knockdownTimer === 0) {
      state.getupTimer = GETUP_TIME;
      state.knockdownImmunity = KNOCKDOWN_IMMUNITY_TIME;
    }
  } else {
    state.getupTimer = Math.max(0, state.getupTimer - dt);
  }

  const moveScale = knockedDown ? knockdownControl : 1;
  const scaledInput = {
    ...input,
    moveX: input.moveX * moveScale,
    moveZ: input.moveZ * moveScale,
    moveMagnitude: input.moveMagnitude * moveScale
  };
  const desired = normalizedDirection(cameraRelativeIntent(scaledInput));

  if (knockedDown && knockdownControl < 0.8) {
    state.jumpBuffer = 0;
  } else if (input.jumpPressed) {
    state.jumpBuffer = JUMP_BUFFER;
  } else {
    state.jumpBuffer = Math.max(0, state.jumpBuffer - dt);
  }

  state.coyoteTime = state.grounded ? COYOTE_TIME : Math.max(0, state.coyoteTime - dt);
  state.diveCooldown = Math.max(0, state.diveCooldown - dt);
  state.diveTimer = Math.max(0, state.diveTimer - dt);
  state.rollTimer = Math.max(0, state.rollTimer - dt);
  state.landingRetention = Math.max(0, state.landingRetention - dt);
  state.recoveryWindow = Math.max(0, state.recoveryWindow - dt);

  if (state.jumpBuffer > 0 && state.coyoteTime > 0 && state.diveTimer <= 0) {
    state.velocity.y = JUMP_SPEED * tuning.jump;
    state.grounded = false;
    state.coyoteTime = 0;
    state.jumpBuffer = 0;
    if (state.recoveryWindow > 0) {
      state.recoveryWindow = 0;
      state.landingRetention = LANDING_RETENTION_TIME;
    }
    state.rollTimer = 0;
    events.push('jump');
  }

  if ((!knockedDown || knockdownControl >= 0.8) && input.divePressed && state.diveCooldown <= 0) {
    const desiredLengthSq = desired.x * desired.x + desired.z * desired.z;
    const direction =
      desiredLengthSq > 0.02
        ? desired
        : {
            x: -Math.sin(characterYaw),
            z: -Math.cos(characterYaw)
          };
    const diveSpeed = DIVE_SPEED * tuning.dash;
    state.velocity.x = direction.x * diveSpeed;
    state.velocity.z = direction.z * diveSpeed;
    state.velocity.y = Math.max(state.velocity.y, 3.25);
    state.diveTimer = 0.58;
    state.rollTimer = 0;
    state.recoveryWindow = 0;
    state.diveCooldown = 0.9 * tuning.dashCooldown;
    state.grounded = false;
    state.dashes += 1;
    events.push('dive');
  }

  const retainedSpeed = Math.min(ROLL_SPEED, Math.hypot(state.velocity.x, state.velocity.z));
  const maxSpeed =
    state.diveTimer > 0
      ? DIVE_SPEED * tuning.dash
      : state.rollTimer > 0
        ? ROLL_SPEED
        : state.landingRetention > 0
          ? Math.max(RUN_SPEED, retainedSpeed)
          : RUN_SPEED;
  const accel = state.grounded ? ACCEL_GROUND * tuning.groundGrip : ACCEL_AIR;
  const control = knockedDown
    ? knockdownControl
    : state.diveTimer > 0
      ? 0.28
      : state.rollTimer > 0
        ? 0.48
        : 1;

  state.velocity.x = dampScalar(state.velocity.x, desired.x * maxSpeed, accel * control, dt);
  state.velocity.z = dampScalar(state.velocity.z, desired.z * maxSpeed, accel * control, dt);
  if (scaledInput.moveMagnitude < 0.05 && state.grounded) {
    const stop = (knockedDown ? 3.2 : 12) * tuning.groundGrip;
    state.velocity.x = dampScalar(state.velocity.x, 0, stop, dt);
    state.velocity.z = dampScalar(state.velocity.z, 0, stop, dt);
  }

  state.gliding = !knockedDown && tuning.glide && !state.grounded && state.velocity.y < 0 && input.jumpHeld;
  const gravityScale = state.slamming ? 1.8 : state.gliding ? GLIDE_GRAVITY : 1;
  state.velocity.y -= GRAVITY * tuning.gravity * gravityScale * dt;
  state.position.x += state.velocity.x * dt;
  state.position.y += state.velocity.y * dt;
  state.position.z += state.velocity.z * dt;

  return { state, events, intentX: desired.x };
}
