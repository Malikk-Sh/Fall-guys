// Привязки сетевых событий к игре.
//
// NetworkManager занимается сокетом: переподключением, часами, буфером снапшотов, разбором
// сообщений. Что именно делать с разобранным сообщением — вопрос игры, и вот это «что делать»
// собрано здесь одним списком.
//
// Раньше список жил внутри Game между построением сцены и рендер-циклом. Соседство было
// обманчивым: обработчик «сервер не принял финиш» стоял в двух экранах от кода, который этот финиш
// отправляет, а искать его приходилось среди частиц и теней.

import * as THREE from 'three';
import { GAME_MODE, ROOM_STATE } from '/shared/protocol.js';
import { raceSpawnFor } from '/shared/raceGrid.js';
import { APP_STATE } from '../core/AppStates.js';
import { applyCollapseEvent } from '../game/CoopWorldSync.js';

const RACE_SPAWN_STORAGE_KEY = 'wobble-race-spawn-v1';

function validRaceSpawn(spawn) {
  return !!spawn && Number.isFinite(spawn.x) && Number.isFinite(spawn.y) && Number.isFinite(spawn.z);
}

function storedRaceSpawn(matchId) {
  if (!matchId) return null;
  try {
    const raw = globalThis.localStorage?.getItem(RACE_SPAWN_STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved?.matchId !== matchId || !validRaceSpawn(saved.spawn)) return null;
    return saved.spawn;
  } catch {
    return null;
  }
}

function rememberRaceSpawn(matchId, spawn) {
  if (!matchId || !validRaceSpawn(spawn)) return;
  try {
    globalThis.localStorage?.setItem(RACE_SPAWN_STORAGE_KEY, JSON.stringify({ matchId, spawn }));
  } catch {
    // Хранилище может быть недоступно в приватном режиме. Тогда resume использует обычный
    // серверный slot-map; сетевой авторитет от этого не меняется.
  }
}

function syncCoopCampaignResult(message) {
  if (message.mode !== GAME_MODE.COOP || message.hasNextChapter !== false) return;

  // Финальная глава не должна предлагать «следующую»: главы 11 нет, а сервер в этом случае
  // повторил бы ch10. Флаг приходит и в MATCH_RESULTS, и в последующих ROOM_STATE, поэтому
  // применяем состояние после обоих типов сообщений — голос другого игрока не вернёт кнопку.
  document.querySelector('#nextChapter')?.classList.add('hidden');

  const eyebrow = document.querySelector('#finishEyebrow');
  if (eyebrow) eyebrow.textContent = 'КАМПАНИЯ ЗАВЕРШЕНА';
  const title = document.querySelector('#finishTitle');
  if (title) title.textContent = 'КАМПАНИЯ ПРОЙДЕНА!';
}

export function bindNetwork(game) {
  game.net.on('matchmakingWaiting', message => {
    if (message.cancelled) {
      for (const id of ['#coopFind', '#raceFind']) {
        const button = document.querySelector(id);
        if (!button || button.dataset.searching !== 'true') continue;
        button.dataset.searching = 'false';
        button.querySelector('span').textContent = id === '#raceFind' ? 'НАЙТИ ГОНКУ' : 'НАЙТИ НАПАРНИКА';
      }
    }
    if (message.cancelled) {
      // Отмена могла обогнать собственный запрос: сервер успевает принять игрока в комнату и
      // прислать лобби, и только потом обрабатывает отмену. Клиент к этому моменту уже показывает
      // лобби комнаты, из которой его только что вывели, — и писать статус в скрытое меню значит
      // оставить человека сидеть в чужой комнате, пока он сам не закроет экран.
      if (game.state.name === APP_STATE.LOBBY) {
        game.room = null;
        game.goHome();
      }
      return game.ui.status(
        message.reason === 'away'
          ? 'Поиск остановлен: игра была свёрнута.'
          : 'Поиск отменён. Можно создать приватную комнату.'
      );
    }
    // Гонка сообщает состав, кооператив — время ожидания. Разница не косметическая: пара либо
    // нашлась, либо нет, и игроку остаётся только ждать, а в гонке он видит, как комната
    // наполняется, и понимает, чего именно ждёт.
    if (message.players) {
      const waiting =
        message.players < (message.minPlayers || 2)
          ? 'ждём ещё одного'
          : message.startsAt
            ? `старт через ${Math.max(1, Math.round((message.startsAt - Date.now()) / 1000))} с`
            : 'скоро старт';
      return game.ui.status(`В гонке ${message.players} · ${waiting}`);
    }
    game.ui.status(`Ищем напарника… ${Math.max(1, Math.round((message.waitedMs || 0) / 1000))} с`);
  });
  // Состояние комнаты приходит одним и тем же типом сообщения в любом состоянии — и в лобби,
  // и на экране результатов. Раньше обработчик этого не различал и на каждое обновление открывал
  // лобби. Из-за этого первый же чужой голос за реванш закрывал карточку результатов: сервер
  // просто разослал новый состав комнаты, а клиент понял это как «матч окончен, все в лобби».
  game.net.on('lobby', message => {
    game.room = message;
    // Список игроков — авторитетный источник: событие присутствия могло прийти до того, как
    // напарник вообще появился в комнате, или потеряться при переподключении.
    game.coop.setPartnerAway(message.players.some(p => p.id !== game.net.id && p.away));
    game.coopControl.refreshSolo();
    game.ready = message.players.find(p => p.id === game.net.id)?.ready || false;

    if (message.state === ROOM_STATE.RESULTS) {
      game.ui.updateResultRoom(message, game.net.id, game.net.serverNow());
      syncCoopCampaignResult(message);
      return;
    }
    // Забег идёт (или идёт отсчёт) — экран принадлежит игре, а не лобби.
    if (message.state !== ROOM_STATE.LOBBY) return;

    // Подбор завершился комнатой — обе кнопки поиска возвращаются в исходное состояние. Гонка
    // попадает сюда так же, как кооператив: её очередь и есть настоящее лобби.
    for (const [id, label] of [
      ['#coopFind', 'НАЙТИ НАПАРНИКА'],
      ['#raceFind', 'НАЙТИ ГОНКУ']
    ]) {
      const findButton = document.querySelector(id);
      if (!findButton) continue;
      findButton.dataset.searching = 'false';
      findButton.querySelector('span').textContent = label;
    }

    game.state.transition(APP_STATE.LOBBY, message);
    document.querySelector('#ready').textContent = game.ready ? 'ОТМЕНИТЬ ГОТОВНОСТЬ' : 'Я ГОТОВ';
    game.ui.resetResultButtons();
    game.ui.lobby(message, game.net.id);
    if (game.pendingReplayShare && message.mode === GAME_MODE.COOP && message.code) {
      const pending = game.pendingReplayShare;
      game.pendingReplayShare = null;
      queueMicrotask(() =>
        game.shareRoomInvite?.({
          code: message.code,
          mode: GAME_MODE.COOP,
          automatic: true,
          partnerName: pending.partnerName
        })
      );
    }
  });

  // Сервер не принял финиш: по его данным черта ещё не пересечена. Разрешаем повтор и ставим
  // игрока туда, где сервер его видит, — иначе он навсегда останется в «Подтверждаем результат…».
  game.net.on('error', () => {
    // Pending replay intent exists only while CREATE_ROOM is awaiting an authoritative
    // lobby. Any server error means that request did not produce the room we intended.
    game.pendingReplayShare = null;
  });

  game.net.on('finishRejected', message => {
    game.net.allowFinishRetry();
    game.session.reopenFinish();
    game.player.finished = false;
    game.running = true;
    game.input.enabled = true;
    if (message.position) {
      game.player.respawn(
        new THREE.Vector3(message.position.x, message.position.y, message.position.z),
        false
      );
    }
    game.ui.toast('Финиш не засчитан — добегите до ленты ещё раз.');
  });

  // Клиент старее сервера. Всплывающая подсказка тут не годится: она исчезнет через пять секунд,
  // а игра останется нерабочей. Нужен постоянный оверлей с единственным действием.
  game.net.on('versionMismatch', () => {
    game.running = false;
    game.input.enabled = false;
    game.ui.linkOverlay('failed', {
      title: 'Версия игры устарела',
      detail: 'Сервер обновился. Обновите страницу, чтобы продолжить играть по сети.',
      action: { label: 'ОБНОВИТЬ СТРАНИЦУ', onClick: () => location.reload() }
    });
  });

  // Вернуться в комнату не удалось: её уже нет или истёк срок. Это не «сеть лежит», а «идти
  // некуда», и вести себя надо иначе — увести в меню, а не крутить переподключение.
  game.net.on('sessionExpired', () => {
    game.pendingReplayShare = null;
    game.ui.error('Комната больше не существует. Возвращаемся в меню.');
    game.goHome();
  });

  // `start` приходит и в начале забега, и при возвращении в уже идущий. Различает их поле
  // `resumed`: если оно есть, забег продолжается с того места, где сервер видел игрока.
  game.net.on('start', async message => {
    // Всё, что описывает ИТОГ конкретного matchId, обязано умереть на границе следующего. Раньше
    // таблица финишировавших переживала реванш и могла заставить досмотр считать соперников уже
    // дошедшими ещё до первого финиша нового забега.
    game.latestBoard = [];
    game.finishedPlace = null;
    game.finishedTime = null;
    game.resultsPending = false;

    // Сервер раздаёт стабильные номера слотов на старте матча. Во время уже идущего забега состав
    // комнаты может измениться и сервер переиндексирует оставшиеся slot'ы, поэтому resume не вправе
    // пересчитывать checkpoint-0 по новой уменьшенной карте. Сохраняем исходную серверную клетку
    // вместе с matchId и предпочитаем её при возврате; одна запись переживает перезагрузку вкладки
    // и перезаписывается на следующем настоящем старте.
    const slots = message.slots || {};
    const slot = slots[game.net.id];
    const participantCount = Object.keys(slots).length;
    const mappedGridStart =
      message.mode === GAME_MODE.RACE && Number.isFinite(slot) && participantCount > 1
        ? raceSpawnFor(message.spec, slot, participantCount)
        : null;
    const gridStart =
      message.mode === GAME_MODE.RACE && message.resumed
        ? storedRaceSpawn(message.matchId) || mappedGridStart
        : mappedGridStart;
    if (message.mode === GAME_MODE.RACE && !message.resumed && gridStart) {
      rememberRaceSpawn(message.matchId, gridStart);
    }
    const spec = gridStart ? { ...message.spec, start: gridStart } : message.spec;

    await game.startRace(message.mode === GAME_MODE.COOP ? 'coop' : 'multi', spec, message.at, message.slots);
    if (message.resumed) game.restoreRun(message.resumed);
  });
  game.net.on('presence', message => {
    if (message.id === game.net.id) return;
    game.coop.setPartnerAway(message.away);
    if (game.mode === 'coop') {
      game.ui.toast(message.away ? 'Напарник свернул игру — подождите.' : 'Напарник вернулся в игру.');
    }
  });
  game.net.on('coopEvent', message => {
    // Событийные препятствия получают один серверный момент начала. Периодические механизмы и без
    // этого детерминированы общими часами; здесь закрываются именно локальные раньше события.
    if (message.action === 'collapse') {
      applyCollapseEvent(game.course, message, game.raceNow());
      return;
    }
    // Катапульта раньше анимировалась только у ударившего. Сервер уже ретранслирует objectId,
    // поэтому принимающей стороне достаточно запустить тот же визуальный recoil.
    if (message.action === 'launch' && message.objectId) {
      game.course?.triggerCatapultVisual?.(message.objectId);
    }
    game.coopControl.receiveCoopEvent(message);
  });
  game.net.on('coopPing', message => game.coopControl.receivePing(message));
  game.net.on('finish', message => {
    game.receiveFinish(message);
    // Личное время уже зафиксировано в finalTime, но гонка ещё идёт. Отпускаем elapsed обратно к
    // серверным часам, чтобы фазы препятствий не замерли вместе с нашим секундомером.
    if (message.id === game.net.id && game.mode === 'multi' && message.racing > 0) {
      game.session.continueWorldClock();
    }
  });
  game.net.on('results', message => {
    game.receiveResults(message);
    syncCoopCampaignResult(message);
    // Зачтённая гонка могла выдать награду. Сервер записал её в аккаунт уже после того, как клиент
    // получил свой прогресс при входе, и в итогах матча её нет — они общие для всей комнаты.
    // Перечитываем, чтобы награда была видна и надеваема сразу, а не после перезагрузки.
    if (message.mode === GAME_MODE.RACE && message.trusted) {
      game.account?.refreshRewards?.().catch(() => {});
    }
  });

  // Сервер снял зачёт: кто-то оборвался или вышел. Говорим об этом сразу, а не на финише —
  // игрок вправе знать, что бежит уже не за рекорд, до того как добежит.
  game.net.on('unranked', message => {
    if (message.matchId && game.net.matchId && message.matchId !== game.net.matchId) return;
    game.markUnranked(message.reason || 'disconnect');
  });

  game.net.on('correction', message => {
    if (game.player && message.position) {
      game.player.checkpoint = Math.max(game.player.checkpoint, message.position.checkpoint || 0);
      game.player.respawn(
        new THREE.Vector3(message.position.x, message.position.y, message.position.z),
        false
      );
      if (message.reason === 'movement') game.ui.toast('Сервер поправил рассинхрон движения.');
    }
  });

  // Обрыв связи больше не означает конец сетевой игры: NetworkManager сам пробует переподключиться
  // и отдаёт 'disconnect' только когда все попытки исчерпаны.
  game.net.on('linkState', ({ state }) => game.showLinkState(state));
  game.net.on('connectionLost', () => game.showLinkState('reconnecting'));
  game.net.on('disconnect', () => {
    game.pendingReplayShare = null;
    game.showLinkState('failed');
    game.fallbackToSolo();
  });
  game.net.on('resumed', () => game.showLinkState('online'));
}
