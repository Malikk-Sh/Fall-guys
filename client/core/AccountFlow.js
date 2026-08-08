// Личность игрока и его рекорды.
//
// Аккаунт заводится сам при первом заходе, вход на своём устройстве происходит молча, а рекорды
// каждого режима хранятся при аккаунте, а не при браузере. Всё это не имеет отношения ни к
// физике, ни к сети забега — и лежало в Game только потому, что там лежало всё.
//
// Карта серверных рекордов живёт здесь же: она принадлежит аккаунту и меняется вместе с ним. Пока
// она была полем игры, о ней приходилось помнить при каждом переключении аккаунта.

import {
  ensureAccount,
  listAccounts,
  currentAccount as accountForRecords,
  createAccount,
  loginAccount,
  renameAccount,
  rememberAccount,
  switchAccount,
  submitRecord
} from './account.js';

export class AccountFlow {
  constructor(game) {
    this.game = game;
    this.records = new Map();
  }

  // Автовход в последний аккаунт. При первом заходе аккаунт заводится сам: игрок не должен
  // регистрироваться, чтобы просто побегать.
  async signIn() {
    const { account, records, online } = await ensureAccount({});
    this.apply(account, { online, records });
    if (!online)
      this.game.ui.accountStatus('Сервер не ответил — рекорды сохранятся только на этом устройстве.');
  }

  // `records` не передают, когда менялось только имя: рекорды при этом те же, и пересобирать их
  // из уже разобранной карты было бы лишним кругом.
  apply(account, { online = true, records = null } = {}) {
    if (records) {
      this.records = new Map(records.map(record => [`${record.mode}:${record.courseKey}`, record.time]));
    }
    this.game.ui.setAccount(account, { online });
    this.game.ui.setAccountList(listAccounts());
    // Меню показывает рекорд текущей трассы, а он у каждого аккаунта свой.
    if (this.game.previewSpec)
      this.game.ui.preview(this.game.previewSpec, this.recordFor('solo', this.game.previewSpec));
  }

  recordFor(mode, spec) {
    if (!spec) return null;
    const key = mode === 'coop' ? spec.chapterId || spec.id : `${spec.seed}:${spec.difficulty}`;
    return this.records?.get(`${mode}:${key}`) ?? null;
  }

  // Личный рекорд уходит на сервер после любого режима.
  //
  // Соло и кооп сервер проверить не может — он просто верит присланному времени, поэтому эти
  // результаты остаются личными и в общую таблицу не попадают. Общий топ по-прежнему только у
  // гонки, где каждое положение игрока проверено.
  async save(mode, spec, time) {
    const account = accountForRecords();
    if (!account || !Number.isFinite(time) || time <= 0) return;
    const courseKey = mode === 'coop' ? spec.chapterId || spec.id : `${spec.seed}:${spec.difficulty}`;
    try {
      const saved = await submitRecord({ secret: account.secret, mode, courseKey, timeMs: Math.round(time) });
      if (saved?.best) this.records?.set(`${mode}:${courseKey}`, saved.best);
    } catch {
      // Рекорд не уехал — забег от этого не перестаёт быть пройденным, а локальная запись уже есть.
    }
  }

  async handleAction(action, value) {
    const ui = this.game.ui;
    try {
      if (action === 'switch') {
        switchAccount(value);
        ui.accountStatus('Переключаюсь…');
        return this.signIn();
      }
      if (action === 'create') {
        const created = await createAccount('Wobbler');
        if (!created) return ui.accountStatus('Не вышло создать аккаунт — сервер не ответил.');
        rememberAccount(created);
        this.apply(created, { records: created.records });
        return ui.accountStatus('Новый аккаунт готов. Загляните в «МОЙ КОД», чтобы не потерять его.');
      }
      if (action === 'login') {
        const entered = await loginAccount(value);
        if (!entered || entered.unknown) return ui.accountStatus('Такой код не подошёл. Проверьте символы.');
        // Код сохраняем ровно тот, что ввёл игрок: сервер его обратно не присылает.
        rememberAccount({ ...entered, secret: value });
        this.apply({ ...entered, secret: value }, { records: entered.records });
        return ui.accountStatus(`Вошли как ${entered.name}.`);
      }
      if (action === 'rename') {
        const account = accountForRecords();
        if (!account) return ui.accountStatus('Сначала нужен аккаунт.');
        const renamed = await renameAccount(account.secret, value);
        if (!renamed) return ui.accountStatus('Переименовать не вышло — сервер не ответил.');
        rememberAccount({ ...renamed, secret: account.secret });
        this.apply({ ...renamed, secret: account.secret });
        return ui.accountStatus('Имя изменено.');
      }
    } catch {
      ui.accountStatus('Не получилось — попробуйте ещё раз.');
    }
    return undefined;
  }
}
