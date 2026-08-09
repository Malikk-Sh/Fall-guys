import { deterministicSignalSequence } from '/shared/signatureCoop.js';

const CORE_PICKUP_RADIUS = 2.2;
const CORE_THROW_SPEED = 11;
const CORE_SOCKET_RADIUS = 1.8;
const TETHER_MAX_CORRECTION = 0.18;

const distance = (a, b) =>
  Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0), (a?.z || 0) - (b?.z || 0));

export class EnergyCore {
  constructor(position, sockets = []) {
    this.position = { ...position };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.sockets = sockets.map(socket => ({ ...socket, powered: false }));
    this.carrier = null;
    this.insertedInto = null;
  }

  pickup(actor) {
    if (
      !actor?.id ||
      this.carrier ||
      this.insertedInto ||
      distance(actor.position, this.position) > CORE_PICKUP_RADIUS
    )
      return false;
    this.carrier = actor.id;
    this.velocity = { x: 0, y: 0, z: 0 };
    return true;
  }

  throw(actor, direction) {
    if (!actor?.id || this.carrier !== actor.id || !direction) return false;
    const length = Math.hypot(direction.x || 0, direction.y || 0, direction.z || 0) || 1;
    this.carrier = null;
    this.position = { x: actor.position.x, y: actor.position.y + 1.2, z: actor.position.z };
    this.velocity = {
      x: ((direction.x || 0) / length) * CORE_THROW_SPEED,
      y: Math.max(0.32, (direction.y || 0) / length) * CORE_THROW_SPEED,
      z: ((direction.z || 0) / length) * CORE_THROW_SPEED
    };
    return true;
  }

  update(actors, dt) {
    if (this.insertedInto) return this.state();
    const carrier = actors.find(actor => actor.id === this.carrier);
    if (carrier) {
      this.position = { x: carrier.position.x, y: carrier.position.y + 1.65, z: carrier.position.z };
    } else if (this.carrier) {
      this.carrier = null;
    } else {
      this.velocity.y -= 18 * dt;
      this.position.x += this.velocity.x * dt;
      this.position.y = Math.max(0.9, this.position.y + this.velocity.y * dt);
      this.position.z += this.velocity.z * dt;
      if (this.position.y === 0.9) this.velocity.y = 0;
      const socket = this.sockets.find(
        item => !item.powered && distance(item, this.position) <= CORE_SOCKET_RADIUS
      );
      if (socket) {
        socket.powered = true;
        this.insertedInto = socket.id;
        this.position = { x: socket.x, y: socket.y, z: socket.z };
      }
    }
    return this.state();
  }

  state() {
    return {
      position: { ...this.position },
      carrier: this.carrier,
      insertedInto: this.insertedInto,
      poweredSockets: this.sockets.filter(socket => socket.powered).map(socket => socket.id)
    };
  }
}

export function resolveTether(local, partner, dt, { maxLength = 11, catchDepth = 2.8 } = {}) {
  if (!local?.position || !partner?.position || !Number.isFinite(dt) || dt <= 0)
    return { taut: false, distance: 0 };
  const dx = partner.position.x - local.position.x;
  const dy = partner.position.y - local.position.y;
  const dz = partner.position.z - local.position.z;
  const length = Math.hypot(dx, dy, dz);
  if (length <= maxLength || length < 0.001) return { taut: false, distance: length };
  const correction = Math.min(length - maxLength, TETHER_MAX_CORRECTION * Math.min(1, dt * 60));
  local.position.x += (dx / length) * correction;
  local.position.y += (dy / length) * correction;
  local.position.z += (dz / length) * correction;
  if (local.velocity) {
    const fallingBelowPartner = local.position.y < partner.position.y - catchDepth && local.velocity.y < 0;
    if (fallingBelowPartner) local.velocity.y *= 0.35;
  }
  return { taut: true, distance: length, correction };
}

export class AsymmetricSignalPuzzle {
  constructor(id, symbols = ['●', '▲', '◆', '■']) {
    this.id = String(id || 'signal');
    this.symbols = [...symbols];
    this.sequence = deterministicSignalSequence(this.id, this.symbols);
    this.progress = 0;
  }

  roles(actorIds) {
    const [guide, operator] = [...actorIds].sort();
    return { guide, operator };
  }

  view(actorId, actorIds) {
    const roles = this.roles(actorIds);
    return actorId === roles.guide
      ? { role: 'guide', sequence: [...this.sequence], controls: [] }
      : { role: 'operator', sequence: [], controls: [...this.symbols] };
  }

  press(actorId, symbol, actorIds) {
    if (actorId !== this.roles(actorIds).operator || !this.symbols.includes(symbol)) return false;
    if (symbol !== this.sequence[this.progress]) {
      this.progress = 0;
      return false;
    }
    this.progress++;
    return this.progress === this.sequence.length;
  }
}
