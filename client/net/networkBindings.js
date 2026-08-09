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
import { APP_STATE } from '../core/AppStates.js';

export function bindNetwork(game) {
  game.net.on('matchmakingWaiting', message => {
    game.ui.status(
      message.cancelled
        ? 'Поиск отменён. Можно создать приватную комнату.'
        : `Ищем напарника… ${Math.max(1, Math.round((message.waitedMs || 0) / 1000))} с`
    );
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

    if (message.state === ROOM_STATE.RESULTS)
      return game.ui.updateResultRoom(message, game.net.id, game.net.serverNow());
    // Забег идёт (или идёт отсчёт) — экран принадлежит игре, а не лобби.
    if (message.state !== ROOM_STATE.LOBBY) return;

    const findButton = document.querySelector('#coopFind');
    if (findButton) {
      findButton.dataset.searching = 'false';
      findButton.querySelector('span').textContent = 'НАЙТИ НАПАРНИКА';
    }

    game.state.transition(APP_STATE.LOBBY, message);
    document.querySelector('#ready').textContent = game.ready ? 'ОТМЕНИТЬ ГОТОВНОСТЬ' : 'Я ГОТОВ';
    game.ui.resetResultButtons();
    game.ui.lobby(message, game.net.id);
  });

  // Сервер не принял финиш: по его данным черта ещё не пересечена. Разрешаем повтор и ставим
  // игрока туда, где сервер его видит, — иначе он навсегда останется в «Подтверждаем результат…».
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
    game.ui.error('Комната больше не существует. Возвращаемся в меню.');
    game.goHome();
  });

  // `start` приходит и в начале забега, и при возвращении в уже идущий. Различает их поле
  // `resumed`: если оно есть, забег продолжается с того места, где сервер видел игрока.
  game.net.on('start', async message => {
    await game.startRace(
      message.mode === GAME_MODE.COOP ? 'coop' : 'multi',
      message.spec,
      message.at,
      message.slots
    );
    if (message.resumed) game.restoreRun(message.resumed);
  });
  game.net.on('presence', message => {
    if (message.id === game.net.id) return;
    game.coop.setPartnerAway(message.away);
    if (game.mode === 'coop') {
      game.ui.toast(message.away ? 'Напарник свернул игру — подождите.' : 'Напарник вернулся в игру.');
    }
  });
  game.net.on('coopEvent', message => game.coopControl.receiveCoopEvent(message));
  game.net.on('finish', message => game.receiveFinish(message));
  game.net.on('results', message => game.receiveResults(message));

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
    game.showLinkState('failed');
    game.fallbackToSolo();
  });
  game.net.on('resumed', () => game.showLinkState('online'));
}
