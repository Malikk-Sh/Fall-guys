// Привязки главного меню и лобби к игре.
//
// Здесь только проводка: какая кнопка что вызывает. Логики нет ни одной — всё, что делает нажатие,
// живёт в самой игре, и это разделение намеренное. Раньше эти полторы сотни строк лежали внутри
// класса Game посреди рендер-цикла, сетевых обработчиков и физики; найти в нём «что делает кнопка
// „готов“» можно было только поиском по файлу.

import { COOP_CHAPTERS } from '/shared/coopChapters.js';
import { COOP_PING_LABELS } from '../game/CoopController.js';
import { GAME_MODE } from '/shared/protocol.js';
import { courseSpec, dailyCourseSpec, randomSeed } from '../core/Config.js';
import { shareInvite } from '../core/invite.js';

export function bindMenu(game) {
  game.ui.onAccountAction = (action, value) => game.account.handleAction(action, value);
  game.ui.onRecentPartnerInvite = async partner => {
    await game.accountReady;
    const chapter = COOP_CHAPTERS.find(item => item.id === partner?.lastChapterId) || COOP_CHAPTERS[0];
    $('#coopChapter').value = chapter.id;
    $('#coopChapter').dispatchEvent(new Event('change'));
    game.ui.selectMode('coop');
    game.ui.toggleProfileScreen?.(false);
    game.pendingReplayShare = { partnerName: partner?.name || 'напарника' };
    const net = game.ensureNetwork();
    net.createRoom({
      name: game.ui.coopName(),
      playerId: game.ui.playerId(),
      mode: GAME_MODE.COOP,
      difficulty: chapter.id
    });
  };
  const $ = s => document.querySelector(s);
  const click = (selector, handler) =>
    $(selector).addEventListener('click', event => {
      game.sfx.uiClick();
      handler(event);
    });

  click('#play', () => game.startSingle(false));
  click('#again', () => game.startRace('single', game.lastSpec));
  click('#newCourse', () => game.startSingle(true));
  click('#create', async () => {
    await game.accountReady;
    const net = game.ensureNetwork();
    net.createRoom({
      name: game.ui.playerName(),
      playerId: game.ui.playerId(),
      difficulty: $('#difficulty').value
    });
  });
  click('#join', async () => {
    await game.accountReady;
    const net = game.ensureNetwork();
    net.joinRoom({
      name: game.ui.playerName(),
      playerId: game.ui.playerId(),
      code: $('#code').value.trim().toUpperCase()
    });
  });
  click('#ready', () => {
    game.ready = !game.ready;
    game.net?.send('ready', { ready: game.ready });
    $('#ready').textContent = game.ready ? 'ОТМЕНИТЬ ГОТОВНОСТЬ' : 'Я ГОТОВ';
  });
  click('#start', () => game.net?.send('start'));
  // Зовём троих: этого хватает, чтобы гонка ощущалась гонкой, и остаётся место живым игрокам,
  // если хост позвал друзей. Уровни сервер раздаёт вперемешку.
  click('#addBots', () => game.net?.send('addBots', { count: 3 }));
  $('#lobbyDifficulty').addEventListener('change', e =>
    game.net?.send('configure', { difficulty: e.target.value })
  );
  // Голоса на экране результатов. Кнопки НЕ гасим: выбор можно менять, пока комната не решила.
  // Раньше нажатая кнопка гасла навсегда, и разошедшиеся голоса запирали обоих без выхода.
  // Экран переключит авторитетное состояние комнаты, а не локальная догадка.
  click('#rematch', () => {
    if (!game.net?.matchId) return;
    game.net.send('rematch', { matchId: game.net.matchId });
  });
  click('#nextChapter', () => {
    if (!game.net?.matchId) return;
    game.net.send('nextChapter', { matchId: game.net.matchId });
  });
  click('#returnLobby', () => {
    if (!game.net?.matchId) return;
    game.net.send('returnLobby', { matchId: game.net.matchId });
  });

  const pingMenu = $('#coopPingMenu');
  const pingButton = $('#coopPingButton');
  const pingCommands = Object.keys(COOP_PING_LABELS);
  const sendPing = command => {
    if (!game.coopControl.sendPing(command)) return;
    pingMenu.classList.add('hidden');
  };
  pingMenu.querySelectorAll('[data-ping]').forEach(button =>
    button.addEventListener('click', event => {
      event.preventDefault();
      sendPing(button.dataset.ping);
    })
  );
  let pingOrigin = null;
  pingButton.addEventListener('pointerdown', event => {
    event.preventDefault();
    pingOrigin = { x: event.clientX, y: event.clientY };
    pingButton.setPointerCapture?.(event.pointerId);
    pingMenu.classList.remove('hidden');
  });
  pingButton.addEventListener('pointerup', event => {
    if (!pingOrigin) return;
    const dx = event.clientX - pingOrigin.x;
    const dy = event.clientY - pingOrigin.y;
    pingOrigin = null;
    // Удержание со свайпом выбирает кнопку, над которой отпущен палец; короткий тап оставляет
    // радиальное меню открытым. elementFromPoint работает и когда pointer capture держит кнопку.
    if (Math.hypot(dx, dy) < 22) return;
    const selected = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-ping]');
    if (selected?.dataset.ping) sendPing(selected.dataset.ping);
  });
  addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.code === 'KeyT' && game.mode === 'coop') {
      event.preventDefault();
      pingMenu.classList.toggle('hidden');
      return;
    }
    if (!pingMenu.classList.contains('hidden') && /^Digit[1-6]$/.test(event.code)) {
      event.preventDefault();
      sendPing(pingCommands[Number(event.code.at(-1)) - 1]);
    }
  });
  game.shareRoomInvite = async ({ code, mode, automatic = false, partnerName = '' } = {}) => {
    const roomMode = mode === GAME_MODE.COOP ? GAME_MODE.COOP : GAME_MODE.RACE;
    const link = game.ui.inviteLink(code || $('#roomCode').textContent.trim(), roomMode);
    const title = roomMode === GAME_MODE.COOP ? 'Wobble Rush — кооп' : 'Wobble Rush — гонка';
    const result = await shareInvite({ title, url: link });
    if (result.shared) {
      game.ui.toast(
        automatic && partnerName
          ? 'Приглашение для ' + partnerName + ' открыто.'
          : 'Ссылка-приглашение готова!'
      );
    } else if (result.copied) {
      game.ui.toast(automatic ? 'Комната готова — ссылка скопирована.' : 'Ссылка-приглашение скопирована!');
    } else if (!result.cancelled) {
      game.ui.toast(automatic ? 'Комната готова — нажмите «ССЫЛКА», чтобы отправить приглашение.' : link);
    }
    return result;
  };
  $('#copyInvite').addEventListener('click', () => {
    const mode = game.room?.mode === GAME_MODE.COOP ? GAME_MODE.COOP : GAME_MODE.RACE;
    game.shareRoomInvite({ code: $('#roomCode').textContent.trim(), mode });
  });
  $('#copyCode').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#roomCode').textContent);
      game.ui.toast('Код комнаты скопирован!');
    } catch {
      game.ui.toast('Выделите код и скопируйте вручную.');
    }
  });
  document.querySelectorAll('.back').forEach(button =>
    button.addEventListener('click', () => {
      game.sfx.uiClick();
      game.goHome();
    })
  );

  game.bindLeaveMatch();

  const refreshPreview = () => {
    const settings = game.ui.singleSettings();
    game.previewSpec =
      settings.type === 'daily'
        ? dailyCourseSpec(settings.difficulty)
        : courseSpec(game.menuRandomSeed, settings.difficulty);
    game.ui.preview(game.previewSpec);
    if (!game.running && game.mode === 'preview') game.buildPreview(game.previewSpec);
  };
  $('#runType').addEventListener('change', e => {
    if (e.target.value === 'random') game.menuRandomSeed = randomSeed();
    refreshPreview();
  });
  $('#difficulty').addEventListener('change', refreshPreview);

  click('#quality', () => {
    const next = game.quality.cycle();
    game.ui.setQuality(next);
    game.applyRendererQuality();
    game.ui.toast(`Качество графики: ${next.toUpperCase()}.`);
    if (game.mode === 'preview') game.buildPreview(game.previewSpec);
  });

  // Режим камеры переключается внутри контроллера (клавиша C или кнопка на экране), а показать
  // это должен интерфейс. Событие вместо прямого вызова — чтобы контроллер камеры не знал про UI.
  addEventListener('camera-mode-change', event => {
    const free = event.detail === 'free';
    game.ui.toast(
      free ? 'КАМЕРА: СВОБОДНАЯ — смотрит, куда повернули.' : 'КАМЕРА: СЛЕЖЕНИЕ — сама встаёт за спину.'
    );
    $('#cameraMode').classList.toggle('camera-free', free);
  });
  $('#cameraMode').classList.toggle('camera-free', game.cameraController.mode === 'free');

  // Гонка: подбор соперников. Кнопка та же по смыслу, что и в кооперативе, но собирает не пару,
  // а группу — поэтому и текст ожидания другой: важно не «ищем», а сколько уже собралось.
  click('#raceFind', async () => {
    await game.accountReady;
    const button = $('#raceFind');
    const net = game.ensureNetwork();
    if (button.dataset.searching === 'true') {
      net.cancelMatchmaking();
      button.dataset.searching = 'false';
      button.querySelector('span').textContent = 'НАЙТИ ГОНКУ';
      game.ui.status('Поиск отменён. Можно создать приватную комнату.');
      return;
    }
    button.dataset.searching = 'true';
    button.querySelector('span').textContent = 'ОТМЕНИТЬ ПОИСК';
    game.ui.status('Ищем соперников…');
    net.findRace({
      name: game.ui.playerName(),
      playerId: game.ui.playerId(),
      difficulty: $('#raceDifficulty').value
    });
  });

  // Кооператив: выбор главы и вход в комнату.
  game.ui.fillChapters(COOP_CHAPTERS, chapter => {
    game.coopChapterId = chapter.id;
  });
  click('#coopFind', async () => {
    await game.accountReady;
    const button = $('#coopFind');
    const net = game.ensureNetwork();
    if (button.dataset.searching === 'true') {
      net.cancelMatchmaking();
      button.dataset.searching = 'false';
      button.querySelector('span').textContent = 'НАЙТИ НАПАРНИКА';
      game.ui.status('Поиск отменён. Можно создать приватную комнату.');
      return;
    }
    button.dataset.searching = 'true';
    button.querySelector('span').textContent = 'ОТМЕНИТЬ ПОИСК';
    game.ui.status('Ищем напарника для выбранной главы…');
    net.findCoop({
      name: game.ui.coopName(),
      playerId: game.ui.playerId(),
      chapterId: $('#coopAnyChapter').checked ? '' : game.ui.coopChapter()
    });
  });
  click('#coopCreate', async () => {
    await game.accountReady;
    const net = game.ensureNetwork();
    net.createRoom({
      name: game.ui.coopName(),
      playerId: game.ui.playerId(),
      mode: GAME_MODE.COOP,
      difficulty: game.ui.coopChapter()
    });
  });
  click('#coopJoin', async () => {
    await game.accountReady;
    const net = game.ensureNetwork();
    net.joinRoom({
      name: game.ui.coopName(),
      playerId: game.ui.playerId(),
      code: $('#coopCode').value.trim().toUpperCase()
    });
  });

  game.ui.bindAudioControls({
    volumes: game.audio.volumes,
    onChange: (bus, value) => {
      game.audio.unlock();
      game.audio.setVolume(bus, value);
    }
  });
}
