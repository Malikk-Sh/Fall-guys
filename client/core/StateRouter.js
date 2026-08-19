// Небольшой конечный автомат жизненного цикла приложения. Игровой режим (single/multi/coop)
// отвечает на вопрос «во что играем», а состояние — «на каком экране и этапе мы сейчас».
// Разделение не даёт флагам menu/lobby/results/running независимо расходиться друг с другом.
export class StateRouter {
  constructor(context, states = {}) {
    this.context = context;
    this.states = new Map(Object.entries(states));
    this.name = null;
    this.current = null;
    this.listeners = new Set();
  }

  add(name, state) {
    if (!name || !state) throw new TypeError('StateRouter: нужны имя и состояние');
    this.states.set(name, state);
    return this;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('StateRouter: listener должен быть функцией');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyTransition(name, previous, payload) {
    for (const listener of this.listeners) {
      try {
        listener({ name, previous, payload });
      } catch (error) {
        console.error('StateRouter transition listener failed', error);
      }
    }
  }

  transition(name, payload) {
    const next = this.states.get(name);
    if (!next) throw new Error(`StateRouter: неизвестное состояние «${name}»`);
    if (next === this.current) {
      next.handleMessage?.call(next, payload, this.context);
      return false;
    }

    this.current?.exit?.call(this.current, this.context, name);
    const previous = this.name;
    this.name = name;
    this.current = next;
    next.enter?.call(next, this.context, payload, previous);
    this.notifyTransition(name, previous, payload);
    return true;
  }

  handleMessage(message) {
    return this.current?.handleMessage?.call(this.current, message, this.context);
  }

  update(dt) {
    return this.current?.update?.call(this.current, dt, this.context);
  }

  render(alpha) {
    return this.current?.render?.call(this.current, alpha, this.context);
  }

  dispose() {
    this.current?.exit?.call(this.current, this.context, null);
    this.current = null;
    this.name = null;
    this.listeners.clear();
  }
}