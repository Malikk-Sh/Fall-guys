export const APP_STATE = Object.freeze({
  MENU: 'menu',
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  RACE: 'race',
  RESULTS: 'results'
});

// На первом этапе автомат владеет экранами и вводом. Физика и сеть остаются в Game и будут
// переноситься в отдельные сессии постепенно, без рискованной единовременной переписи.
export function createAppStates() {
  return {
    [APP_STATE.MENU]: {
      enter(game) {
        game.running = false;
        game.input.enabled = false;
        game.ui.hud(false);
        game.ui.show('menu');
      }
    },
    [APP_STATE.LOBBY]: {
      enter(game) {
        game.running = false;
        game.input.enabled = false;
        game.ui.hud(false);
        game.ui.show('lobby');
      }
    },
    [APP_STATE.COUNTDOWN]: {
      enter(game, options = {}) {
        game.running = false;
        game.input.enabled = false;
        game.ui.show();
        game.ui.hud(true, options);
      }
    },
    [APP_STATE.RACE]: {
      enter(game) {
        game.running = true;
        game.input.enabled = true;
      }
    },
    [APP_STATE.RESULTS]: {
      enter(game) {
        game.running = false;
        game.input.enabled = false;
      }
    }
  };
}
