import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactSignatureText,
  contextActionPresentation,
  keyCodeLabel,
  semanticContextAction
} from '../client/ui/ContextActionControl.js';
import { partnerPingCommand, pingIdentity, pingPresentation } from '../client/game/CoopPingPresentation.js';

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

test('signature presentation сокращает только известные длинные роли без новых gameplay rules', () => {
  assert.equal(
    compactSignatureText('ПОДСКАЗЧИК · ПОСЛЕДОВАТЕЛЬНОСТЬ: ◇  ○  △ · 1/3'),
    'ПОДСКАЗКА · ◇  ○  △ · 1/3'
  );
  assert.equal(
    compactSignatureText('ОПЕРАТОР · ВВЕДИТЕ СИМВОЛЫ НАПАРНИКА · 2/4'),
    'ПОВТОРИ · 2/4'
  );
  assert.equal(
    compactSignatureText('ЯДРО ПОТЕРЯНО? Его можно вернуть к началу эстафеты.'),
    'ЯДРО ПОТЕРЯНО? Его можно вернуть к началу эстафеты.'
  );
});

test('world ping presentation covers all six existing co-op commands', () => {
  assert.equal(pingPresentation('here')?.anchor, 'ground');
  assert.equal(pingPresentation('here')?.beam, true);
  assert.equal(pingPresentation('wait')?.label, 'ЖДИ');
  assert.equal(pingPresentation('go')?.glyph, '➤');
  assert.equal(pingPresentation('help')?.urgent, true);
  assert.equal(pingPresentation('ready')?.label, 'ГОТОВ');
  assert.equal(pingPresentation('thanks')?.glyph, '♥');
  assert.equal(pingPresentation('unknown'), null);
});

test('ping identity is match-scoped and rejects expired or malformed presentation state', () => {
  const ping = { id: 'partner', command: 'help', until: 5000 };
  assert.equal(pingIdentity('match-a', ping, 4000), 'match-a:partner:help:5000');
  assert.equal(pingIdentity('match-a', ping, 5000), null);
  assert.equal(pingIdentity(null, ping, 4000), null);
  assert.equal(pingIdentity('match-a', { ...ping, command: 'unknown' }, 4000), null);
});

test('partner ping priority never treats the local player or expired ping as partner urgency', () => {
  const ping = { id: 'partner', command: 'help', until: 5000 };
  assert.equal(partnerPingCommand('self', ping, 4000), 'help');
  assert.equal(partnerPingCommand('partner', ping, 4000), null);
  assert.equal(partnerPingCommand('self', ping, 5000), null);
});
