import { dailyCourseSpec } from '../core/Config.js';
import { readProfile } from '../core/profile.js';
import { COSMETIC_CATALOG } from '/shared/cosmetics.js';

const DAY_MS = 86_400_000;
const STYLE_ID = 'daily-challenge-presentation-style';

const DAILY_CARD_CSS = `
.challenge-rule.daily-challenge-card {
  position: relative;
  display: grid;
  gap: 9px;
  margin: 4px 0 12px;
  padding: 12px;
  overflow: hidden;
  border: 1px solid rgba(76, 224, 223, 0.6);
  border-radius: 17px;
  color: rgba(255, 255, 255, 0.86);
  background:
    radial-gradient(circle at 100% 0, rgba(255, 221, 76, 0.2), transparent 38%),
    radial-gradient(circle at 0 100%, rgba(255, 79, 146, 0.16), transparent 42%),
    linear-gradient(145deg, rgba(70, 46, 168, 0.96), rgba(31, 20, 85, 0.96));
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.2),
    0 10px 24px rgba(20, 10, 62, 0.22);
  font-size: 0.67rem;
  font-weight: 750;
}
.challenge-rule.daily-challenge-card::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  content: '';
  background: linear-gradient(180deg, var(--cyan), var(--yellow), var(--pink));
}
.daily-challenge-head,
.daily-challenge-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.daily-challenge-head small,
.daily-challenge-panel small,
.daily-challenge-footer small {
  color: #aef9f3;
  font-size: 0.52rem;
  font-weight: 950;
  letter-spacing: 0.12em;
}
.daily-challenge-head time {
  color: var(--yellow);
  font-variant-numeric: tabular-nums;
  font-size: 0.56rem;
  font-weight: 950;
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.daily-challenge-copy {
  display: grid;
  gap: 3px;
  padding: 9px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.065);
}
.challenge-rule.daily-challenge-card .daily-challenge-copy > strong {
  color: var(--yellow);
  font-size: 0.78rem;
  letter-spacing: 0.08em;
}
.challenge-rule.daily-challenge-card .daily-challenge-copy > span {
  color: rgba(255, 255, 255, 0.72);
  line-height: 1.3;
}
.daily-challenge-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  gap: 7px;
}
.daily-challenge-panel {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 8px 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.045);
}
.daily-challenge-panel b {
  overflow: hidden;
  color: #fff;
  font-size: 0.61rem;
  line-height: 1.25;
  text-overflow: ellipsis;
}
.daily-challenge-panel em {
  color: rgba(255, 255, 255, 0.48);
  font-size: 0.52rem;
  font-style: normal;
}
.daily-progress {
  height: 5px;
  overflow: hidden;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.12);
}
.daily-progress > i {
  display: block;
  width: var(--daily-progress, 0%);
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--cyan), var(--yellow));
  transition: width 0.28s ease-out;
}
.daily-challenge-footer {
  color: rgba(255, 255, 255, 0.48);
  font-size: 0.52rem;
}
.daily-challenge-footer b {
  color: #7ce9df;
  font-size: 0.55rem;
}
.daily-challenge-card.daily-complete .daily-objective-panel {
  border-color: rgba(88, 235, 184, 0.45);
  background: rgba(88, 235, 184, 0.08);
}
.daily-challenge-card.daily-complete .daily-objective-panel b {
  color: #8ff5cb;
}
@media (max-width: 600px), (max-height: 650px) {
  .challenge-rule.daily-challenge-card {
    gap: 7px;
    padding: 10px;
  }
  .daily-challenge-grid {
    grid-template-columns: 1fr;
  }
  .daily-challenge-panel {
    padding: 7px 8px;
  }
}
@media (max-height: 600px) and (orientation: landscape) {
  body.mobile-landscape.menu-polish .challenge-rule.daily-challenge-card {
    grid-template-columns: auto minmax(0, 0.8fr) minmax(0, 1.7fr);
    align-items: center;
    gap: 5px;
    min-height: 28px;
    margin: 0;
    padding: 4px 7px;
    border-radius: 10px;
  }
  body.mobile-landscape.menu-polish .daily-challenge-head {
    display: block;
    min-width: 0;
  }
  body.mobile-landscape.menu-polish .daily-challenge-head small,
  body.mobile-landscape.menu-polish .daily-challenge-panel small,
  body.mobile-landscape.menu-polish .daily-challenge-panel em,
  body.mobile-landscape.menu-polish .daily-challenge-footer,
  body.mobile-landscape.menu-polish .daily-challenge-copy > span {
    display: none;
  }
  body.mobile-landscape.menu-polish .daily-challenge-head time {
    display: block;
    font-size: 6px;
    letter-spacing: 0;
  }
  body.mobile-landscape.menu-polish .daily-challenge-copy {
    min-width: 0;
    padding: 0;
    background: none;
  }
  body.mobile-landscape.menu-polish .challenge-rule.daily-challenge-card .daily-challenge-copy > strong {
    display: block;
    overflow: hidden;
    font-size: 7px;
    line-height: 1;
    letter-spacing: 0.03em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  body.mobile-landscape.menu-polish .daily-challenge-grid {
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
    gap: 4px;
    min-width: 0;
  }
  body.mobile-landscape.menu-polish .daily-challenge-panel {
    gap: 2px;
    min-width: 0;
    padding: 2px 4px;
    border-radius: 7px;
  }
  body.mobile-landscape.menu-polish .daily-challenge-panel b {
    overflow: hidden;
    font-size: 6px;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  body.mobile-landscape.menu-polish .daily-progress {
    height: 3px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .daily-progress > i {
    transition: none;
  }
}
body.reduced-motion .daily-progress > i,
body.mobile-reduced-motion .daily-progress > i {
  transition: none;
}
`;

const safeCount = value => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);

export function dailyResetRemaining(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const time = date.getTime();
  if (!Number.isFinite(time)) return 0;
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(0, Math.min(DAY_MS, next - time));
}

export function formatDailyCountdown(remaining) {
  const totalSeconds = Math.max(0, Math.ceil(safeCount(remaining) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
}

export function nextDailyReward(catalog = COSMETIC_CATALOG, profile = null) {
  const bestStreak = safeCount(profile?.daily?.bestStreak);
  const streak = safeCount(profile?.daily?.streak);
  const rewards = (Array.isArray(catalog) ? catalog : [])
    .filter(item => item?.unlock?.type === 'daily' && safeCount(item.unlock.streak) > 0)
    .sort((a, b) => safeCount(a.unlock.streak) - safeCount(b.unlock.streak));
  const item = rewards.find(candidate => safeCount(candidate.unlock.streak) > bestStreak) || null;
  if (!item) return { complete: true, item: null, current: bestStreak, target: bestStreak };
  const target = safeCount(item.unlock.streak);
  return {
    complete: false,
    item,
    current: Math.min(streak, target),
    target,
    bestStreak
  };
}

export function dailyObjectiveState(spec, profile = null) {
  const objective = spec?.objectives?.[0] || null;
  if (!objective) return null;
  const saved = profile?.dailyObjective;
  const attempted = saved?.dayKey === spec.dayKey && saved?.id === objective.id;
  const complete = attempted && saved?.complete === true;
  return {
    id: objective.id,
    label: objective.label || objective.id,
    current: complete ? 1 : 0,
    target: 1,
    attempted,
    complete
  };
}

export function dailyPresentationModel({
  difficulty = 'normal',
  now = new Date(),
  profile = null,
  catalog = COSMETIC_CATALOG
} = {}) {
  const spec = dailyCourseSpec(difficulty, now);
  return {
    dayKey: spec.dayKey,
    modifier: spec.modifier,
    objective: dailyObjectiveState(spec, profile),
    reward: nextDailyReward(catalog, profile),
    runComplete: profile?.daily?.lastDay === spec.dayKey,
    countdown: formatDailyCountdown(dailyResetRemaining(now))
  };
}

function ensureStyles(document_) {
  if (!document_ || document_.getElementById(STYLE_ID)) return;
  const style = document_.createElement('style');
  style.id = STYLE_ID;
  style.textContent = DAILY_CARD_CSS;
  document_.head.append(style);
}

function percentage(current, target) {
  if (!Number.isFinite(target) || target <= 0) return 100;
  return Math.max(0, Math.min(100, (safeCount(current) / target) * 100));
}

export class DailyChallengePresentation {
  constructor({
    root,
    runType,
    difficulty,
    profileStreak,
    getProfile = () => readProfile(),
    now = () => new Date(),
    onDayChange = null
  } = {}) {
    this.root = root || null;
    this.runType = runType || null;
    this.difficulty = difficulty || null;
    this.profileStreak = profileStreak || null;
    this.getProfile = getProfile;
    this.now = now;
    this.onDayChange = onDayChange;
    this.dayKey = null;
    this.timer = null;
    this.observer = null;
    this.boundRender = () => this.render();
  }

  bind() {
    if (!this.root) return;
    this.buildMarkup();
    this.runType?.addEventListener('change', this.boundRender);
    this.difficulty?.addEventListener('change', this.boundRender);
    if (this.profileStreak && typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(this.boundRender);
      this.observer.observe(this.profileStreak, { childList: true, characterData: true, subtree: true });
    }
    this.render();
    this.timer = setInterval(() => {
      if (this.root?.ownerDocument?.visibilityState === 'hidden') return;
      this.render();
    }, 1000);
  }

  buildMarkup() {
    const document_ = this.root.ownerDocument;
    ensureStyles(document_);
    if (this.root.classList.contains('daily-challenge-card')) return;

    const title = this.root.querySelector('strong');
    const detail = this.root.querySelector('span');
    if (!title || !detail) return;

    const head = document_.createElement('div');
    head.className = 'daily-challenge-head';
    const kicker = document_.createElement('small');
    kicker.textContent = 'ИСПЫТАНИЕ ДНЯ';
    this.countdownElement = document_.createElement('time');
    head.append(kicker, this.countdownElement);

    const copy = document_.createElement('div');
    copy.className = 'daily-challenge-copy';
    copy.append(title, detail);
    this.titleElement = title;
    this.detailElement = detail;

    const grid = document_.createElement('div');
    grid.className = 'daily-challenge-grid';
    const objective = this.panel(document_, 'ЦЕЛЬ', 'daily-objective-panel');
    const reward = this.panel(document_, 'НАГРАДА СЕРИИ', 'daily-reward-panel');
    this.objectiveName = objective.name;
    this.objectiveState = objective.state;
    this.objectiveProgress = objective.progress;
    this.rewardName = reward.name;
    this.rewardState = reward.state;
    this.rewardProgress = reward.progress;
    grid.append(objective.root, reward.root);

    const footer = document_.createElement('div');
    footer.className = 'daily-challenge-footer';
    const runLabel = document_.createElement('small');
    runLabel.textContent = 'СТАТУС ДНЯ';
    this.runState = document_.createElement('b');
    footer.append(runLabel, this.runState);

    this.root.replaceChildren(head, copy, grid, footer);
    this.root.classList.add('daily-challenge-card');
  }

  panel(document_, label, extraClass) {
    const root = document_.createElement('div');
    root.className = `daily-challenge-panel ${extraClass}`;
    const small = document_.createElement('small');
    small.textContent = label;
    const name = document_.createElement('b');
    const state = document_.createElement('em');
    const progress = document_.createElement('div');
    progress.className = 'daily-progress';
    const fill = document_.createElement('i');
    progress.append(fill);
    root.append(small, name, state, progress);
    return { root, name, state, progress: fill };
  }

  render() {
    if (!this.root?.classList.contains('daily-challenge-card')) return;
    const daily = this.runType?.value !== 'random';
    this.root.classList.toggle('hidden', !daily);
    if (!daily) return;

    const now = this.now();
    const model = dailyPresentationModel({
      difficulty: this.difficulty?.value || 'normal',
      now,
      profile: this.getProfile?.() || null
    });
    if (this.dayKey && this.dayKey !== model.dayKey) this.onDayChange?.(model.dayKey);
    this.dayKey = model.dayKey;

    this.countdownElement.textContent = `СМЕНА ЧЕРЕЗ ${model.countdown}`;
    this.countdownElement.dateTime = model.dayKey;
    this.titleElement.textContent = model.modifier?.label || 'ИСПЫТАНИЕ ДНЯ';
    this.detailElement.textContent = model.modifier?.description || '';

    if (model.objective) {
      this.objectiveName.textContent = model.objective.label;
      this.objectiveState.textContent = model.objective.complete
        ? 'ВЫПОЛНЕНО · 1 / 1'
        : model.objective.attempted
          ? 'ПОКА НЕ ВЫПОЛНЕНО · 0 / 1'
          : 'ПРОВЕРИТСЯ НА ФИНИШЕ · 0 / 1';
      this.objectiveProgress.style.setProperty(
        '--daily-progress',
        `${percentage(model.objective.current, model.objective.target)}%`
      );
    }

    if (model.reward.complete) {
      this.rewardName.textContent = 'ВСЕ DAILY-НАГРАДЫ ПОЛУЧЕНЫ';
      this.rewardState.textContent = `ЛУЧШАЯ СЕРИЯ · ${model.reward.current}`;
      this.rewardProgress.style.setProperty('--daily-progress', '100%');
    } else {
      this.rewardName.textContent = model.reward.item?.name || 'СЛЕДУЮЩАЯ НАГРАДА';
      this.rewardState.textContent = `СЕРИЯ ${model.reward.current} / ${model.reward.target}`;
      this.rewardProgress.style.setProperty(
        '--daily-progress',
        `${percentage(model.reward.current, model.reward.target)}%`
      );
    }

    this.runState.textContent = model.runComplete ? 'ЗАБЕГ ДНЯ ЗАВЕРШЁН ✓' : 'ЕЩЁ НЕ ЗАВЕРШЁН';
    this.root.classList.toggle('daily-complete', Boolean(model.objective?.complete));
  }

  dispose() {
    this.runType?.removeEventListener('change', this.boundRender);
    this.difficulty?.removeEventListener('change', this.boundRender);
    this.observer?.disconnect();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
