const STYLESHEET_ID = 'resultsUxStylesheet';
const PRESENTATION_CLASS = 'results-presentation-enabled';
const READY_CLASS = 'results-ready';
const PHASE_CLASSES = Object.freeze([
  'results-show-time',
  'results-show-stats',
  'results-show-highlights',
  'results-show-actions'
]);

export function resultsRevealPlan(reducedMotion = false) {
  return reducedMotion
    ? { time: 0, stats: 24, highlights: 48, actions: 72, complete: 96 }
    : { time: 180, stats: 340, highlights: 540, actions: 760, complete: 920 };
}

export function isResultsSkipKey(code) {
  return code === 'Enter' || code === 'Space' || code === 'NumpadEnter';
}

export function validResultsRevealPlan(plan) {
  if (!plan) return false;
  const values = [plan.time, plan.stats, plan.highlights, plan.actions, plan.complete];
  return (
    values.every(Number.isFinite) &&
    values.every((value, index) => index === 0 || value >= values[index - 1])
  );
}

function installStylesheet(root) {
  if (!root?.head || root.getElementById(STYLESHEET_ID)) return;
  const link = root.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = '/results-ux.css';
  root.head.append(link);
}

export class ResultsPresentation {
  constructor({
    windowRef = globalThis,
    root = globalThis.document,
    getGame = () => globalThis.__WOBBLE_GAME__
  } = {}) {
    this.window = windowRef;
    this.root = root;
    this.getGame = getGame;
    this.finish = null;
    this.observer = null;
    this.timers = [];
    this.visible = false;
    this.presenting = false;
    this.onClick = event => this.handleClick(event);
    this.onKeyDown = event => this.handleKeyDown(event);
  }

  init() {
    if (!this.root?.body) return this;
    installStylesheet(this.root);
    this.root.body.classList.add(PRESENTATION_CLASS);
    this.finish = this.root.getElementById('finish');
    if (!this.finish) return this;

    this.finish.addEventListener('click', this.onClick, true);
    this.window?.addEventListener?.('keydown', this.onKeyDown, true);
    const Observer = this.window?.MutationObserver || globalThis.MutationObserver;
    if (Observer) {
      this.observer = new Observer(() => this.sync());
      this.observer.observe(this.finish, { attributes: true, attributeFilter: ['class'] });
    }
    this.sync();
    return this;
  }

  destroy() {
    this.cancelTimers();
    this.observer?.disconnect?.();
    this.observer = null;
    this.finish?.removeEventListener?.('click', this.onClick, true);
    this.window?.removeEventListener?.('keydown', this.onKeyDown, true);
    this.finish?.classList.remove(READY_CLASS, ...PHASE_CLASSES);
    this.finish?.removeAttribute?.('data-results-state');
    this.root?.body?.classList.remove(PRESENTATION_CLASS);
    this.presenting = false;
    this.visible = false;
  }

  sync() {
    if (!this.finish) return;
    const visible = !this.finish.classList.contains('hidden');
    if (visible && !this.visible) this.start();
    else if (!visible && this.visible) this.reset();
    this.visible = visible;
  }

  start() {
    this.cancelTimers();
    this.presenting = true;
    this.finish.classList.remove(READY_CLASS, ...PHASE_CLASSES);
    this.finish.dataset.resultsState = 'presenting';

    const plan = resultsRevealPlan(Boolean(this.getGame?.()?.settings?.reducedMotion));
    this.schedule('results-show-time', plan.time);
    this.schedule('results-show-stats', plan.stats);
    this.schedule('results-show-highlights', plan.highlights);
    this.schedule('results-show-actions', plan.actions);
    this.timers.push(this.window.setTimeout(() => this.complete(false), plan.complete));
  }

  schedule(className, delay) {
    this.timers.push(
      this.window.setTimeout(() => {
        if (!this.presenting || !this.visible) return;
        this.finish.classList.add(className);
      }, delay)
    );
  }

  handleClick(event) {
    if (!this.presenting || !this.visible) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    this.complete(true);
  }

  handleKeyDown(event) {
    if (!this.presenting || !this.visible || !isResultsSkipKey(event.code)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    this.complete(true);
  }

  complete(skipped = false) {
    if (!this.finish || !this.presenting) return false;
    this.cancelTimers();
    this.presenting = false;
    this.finish.classList.add(READY_CLASS, ...PHASE_CLASSES);
    this.finish.dataset.resultsState = skipped ? 'skipped' : 'ready';
    return true;
  }

  reset() {
    this.cancelTimers();
    this.presenting = false;
    this.finish?.classList.remove(READY_CLASS, ...PHASE_CLASSES);
    this.finish?.removeAttribute?.('data-results-state');
  }

  cancelTimers() {
    for (const timer of this.timers) this.window?.clearTimeout?.(timer);
    this.timers.length = 0;
  }
}

export function installResultsPresentation(options = {}) {
  const presentation = new ResultsPresentation(options);
  presentation.init();
  return presentation;
}
