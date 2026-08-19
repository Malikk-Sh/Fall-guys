import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextActionPresentation,
  keyCodeLabel,
  semanticContextAction
} from '../client/ui/ContextActionControl.js';

test('context action presentation maps only known gameplay semantics', () => {
  assert.deepEqual(contextActionPresentation('pickup'), {
    label: 'ВЗЯТЬ',
    icon: '◇',
    tone: 'pickup'
  });
  assert.deepEqual(contextActionPresentation('throw'), {
    label: 'БРОСИТЬ',
    icon: '↗',
    tone: 'throw'
  });
  assert.deepEqual(contextActionPresentation('insert'), {
    label: 'ВСТАВИТЬ',
    icon: '◆',
    tone: 'insert'
  });
  assert.deepEqual(contextActionPresentation('unknown'), {
    label: 'РЫВОК',
    icon: '➤',
    tone: 'dive'
  });
});

test('semantic context action delegates to CoopController instead of recreating gameplay rules', () => {
  let calls = 0;
  const game = {
    running: true,
    mode: 'coop',
    spectating: false,
    player: { downed: false },
    coopControl: {
      coreAction() {
        calls++;
        return 'pickup';
      }
    }
  };

  assert.equal(semanticContextAction(game), 'pickup');
  assert.equal(calls, 1);
  game.coopControl.coreAction = () => 'not-a-real-action';
  assert.equal(semanticContextAction(game), null);
});

test('semantic context action stays inactive outside controllable co-op gameplay', () => {
  const game = {
    running: true,
    mode: 'coop',
    spectating: false,
    player: { downed: false },
    coopControl: { coreAction: () => 'insert' }
  };

  game.running = false;
  assert.equal(semanticContextAction(game), null);
  game.running = true;
  game.mode = 'single';
  assert.equal(semanticContextAction(game), null);
  game.mode = 'coop';
  game.spectating = true;
  assert.equal(semanticContextAction(game), null);
  game.spectating = false;
  game.player.downed = true;
  assert.equal(semanticContextAction(game), null);
});

test('keyboard hint uses the actual configured key code in compact form', () => {
  assert.equal(keyCodeLabel('ShiftLeft'), 'SHIFT');
  assert.equal(keyCodeLabel('ShiftRight'), 'SHIFT');
  assert.equal(keyCodeLabel('KeyF'), 'F');
  assert.equal(keyCodeLabel('Digit4'), '4');
  assert.equal(keyCodeLabel('ArrowLeft'), '←');
  assert.equal(keyCodeLabel(''), 'SHIFT');
});
