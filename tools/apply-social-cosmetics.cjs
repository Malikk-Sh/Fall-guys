'use strict';

const fs = require('fs');

function replaceOnce(path, before, after, label) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(after)) return false;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
  return true;
}

// server/index.js — только публичный профиль игрока и момент входа в комнату. Inventory не
// читается в snapshot loop: loadout фиксируется при входе, поэтому 15 Гц не превращаются в DB I/O.
replaceOnce(
  'server/index.js',
  "const { networkIdentity } = require('./networkIdentity');\n",
  "const { networkIdentity } = require('./networkIdentity');\nconst { socialCosmetics } = require('./socialCosmetics');\n",
  'server social import'
);
replaceOnce(
  'server/index.js',
  "  disconnectedAt,\n  slot,\n  away\n}) => ({",
  "  disconnectedAt,\n  slot,\n  away,\n  loadout\n}) => ({",
  'public player loadout input'
);
replaceOnce(
  'server/index.js',
  "  choice: resultChoice || null,\n  color,\n  slot: slot ?? 0,",
  "  choice: resultChoice || null,\n  color,\n  // Публичный профиль всегда проходит повторную нормализацию перед отправкой. Даже если объект\n  // игрока случайно испортит внутренний код, неизвестный ID не пересечёт сетевую границу.\n  loadout: socialCosmetics.sanitize(loadout),\n  slot: slot ?? 0,",
  'public player loadout output'
);
replaceOnce(
  'server/index.js',
  "    accountId: authenticated?.id || null,\n    color,",
  "    accountId: authenticated?.id || null,\n    // Никакой loadout не принимается из CREATE/JOIN/FIND. Он разрешается по уже привязанному\n    // ws.accountId через server inventory и дальше становится частью публичного room profile.\n    loadout: socialCosmetics.forAccount(authenticated?.id),\n    color,",
  'authoritative room loadout'
);

// client/main.js — удалённые Character получают тот же canonical cosmetic object, что локальный.
replaceOnce(
  'client/main.js',
  "import { AccountFlow } from './core/AccountFlow.js';\n",
  "import { AccountFlow } from './core/AccountFlow.js';\nimport { cosmeticLoadoutFromIds } from './core/cosmetics.js';\n",
  'remote cosmetic import'
);
const remoteBefore = `    for (const id of active) {
      if (id === this.net.id || this.remotes.has(id)) continue;
      const info = this.room?.players.find(p => p.id === id);
      this.remotes.set(
        id,
        new Player(this.scene, this.course, this.effects, {
          remote: true,
          color:
            this.mode === 'coop'
              ? this.coop.slotFor(id) === 1
                ? COLORS.orange
                : COLORS.cyan
              : info?.color || COLORS.cyan,
          accent: COLORS.yellow,
          name: info?.name || 'Wobbler'
        })
      );
    }`;
const remoteAfter = `    for (const id of active) {
      if (id === this.net.id) continue;
      const info = this.room?.players.find(p => p.id === id);
      const cosmeticKey = JSON.stringify(info?.loadout || null);
      const current = this.remotes.get(id);
      // На resume MATCH_START может прийти раньше ROOM_STATE. Если модель успела создаться без
      // public profile, пересобираем её один раз, когда authoritative loadout доедет следом.
      if (current && current.socialCosmeticKey !== cosmeticKey) {
        current.dispose();
        this.remotes.delete(id);
      }
      if (this.remotes.has(id)) continue;
      const remote = new Player(this.scene, this.course, this.effects, {
        remote: true,
        color:
          this.mode === 'coop'
            ? this.coop.slotFor(id) === 1
              ? COLORS.orange
              : COLORS.cyan
            : info?.color || COLORS.cyan,
        accent: COLORS.yellow,
        cosmetics: cosmeticLoadoutFromIds(info?.loadout),
        name: info?.name || 'Wobbler'
      });
      remote.socialCosmeticKey = cosmeticKey;
      this.remotes.set(id, remote);
    }`;
replaceOnce('client/main.js', remoteBefore, remoteAfter, 'remote player cosmetics');

// UI.js — lobby preview derives colors/names from canonical IDs, never from arbitrary network colors.
replaceOnce(
  'client/ui/UI.js',
  "  COSMETICS,\n  cosmeticLoadout,\n",
  "  COSMETICS,\n  cosmeticLoadout,\n  cosmeticLoadoutFromIds,\n",
  'lobby cosmetic helper import'
);
replaceOnce(
  'client/ui/UI.js',
  "const $ = selector => document.querySelector(selector);\nconst $$ = selector => [...document.querySelectorAll(selector)];\n",
  "const $ = selector => document.querySelector(selector);\nconst $$ = selector => [...document.querySelectorAll(selector)];\nconst cssColor = (value, fallback = 0xff4f91) =>\n  `#${Number(Number.isFinite(value) ? value : fallback)\n    .toString(16)\n    .padStart(6, '0')\n    .slice(-6)}`;\n",
  'lobby color helper'
);
const lobbyBefore = `      const avatar = document.createElement('i');
      avatar.className = 'player-avatar';
      avatar.style.background = \`#\${Number(player.color || 0xff4f91)
        .toString(16)
        .padStart(6, '0')}\`;
      const name = document.createElement('span');
      name.textContent = \`\${player.id === data.host ? '♛ ' : ''}\${player.name}\${player.id === selfId ? ' (вы)' : ''}\`;
      const state = document.createElement('b');
      state.className = player.ready ? 'ready' : '';
      state.textContent = player.ready ? 'ГОТОВ' : 'ОЖИДАНИЕ';
      row.append(avatar, name, state);`;
const lobbyAfter = `      const loadout = cosmeticLoadoutFromIds(player.loadout);
      row.dataset.playerId = player.id;
      for (const slot of ['body', 'visor', 'antenna', 'trail', 'finish']) {
        row.dataset[\`cosmetic\${slot[0].toUpperCase()}\${slot.slice(1)}\`] = loadout[slot]?.id || 'none';
      }

      const avatar = document.createElement('i');
      avatar.className = 'player-avatar';
      const bodyColor = loadout.body?.colors?.body ?? player.color ?? 0xff4f91;
      const accentColor = loadout.body?.colors?.accent ?? 0xffde59;
      avatar.style.setProperty('--body-color', cssColor(bodyColor));
      avatar.style.setProperty('--visor-color', cssColor(loadout.visor?.color, 0xdffcff));
      avatar.style.setProperty('--antenna-color', cssColor(loadout.antenna?.color, accentColor));

      const copy = document.createElement('div');
      copy.className = 'player-copy';
      const name = document.createElement('span');
      name.textContent = \`\${player.id === data.host ? '♛ ' : ''}\${player.name}\${player.id === selfId ? ' (вы)' : ''}\`;
      const cosmetics = document.createElement('small');
      cosmetics.className = 'player-cosmetics';
      cosmetics.textContent = [
        loadout.body?.id !== 'classic' ? loadout.body?.name : null,
        loadout.visor?.name,
        loadout.antenna?.name
      ]
        .filter(Boolean)
        .join(' · ') || 'КЛАССИКА';
      copy.append(name, cosmetics);

      const state = document.createElement('b');
      state.className = player.ready ? 'ready' : '';
      state.textContent = player.ready ? 'ГОТОВ' : 'ОЖИДАНИЕ';
      row.append(avatar, copy, state);`;
replaceOnce('client/ui/UI.js', lobbyBefore, lobbyAfter, 'lobby social preview');

// styles.css — только дополнительное визуальное представление внутри уже существующей строки.
const socialCss = `

/* Social cosmetics: миниатюра в комнате повторяет canonical body/visor/antenna персонажа. */
.player-avatar {
  position: relative;
  display: block;
  background: var(--body-color, #ff4f91) !important;
}
.player-avatar::before {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  top: 8px;
  height: 7px;
  border: 1px solid #fff9;
  border-radius: 50%;
  background: var(--visor-color, #dffcff);
  box-shadow: 0 1px 3px #24175055;
}
.player-avatar::after {
  content: '';
  position: absolute;
  width: 7px;
  height: 7px;
  left: 50%;
  top: -6px;
  transform: translateX(-50%);
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--antenna-color, #ffde59);
}
.player-copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.player-copy > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-cosmetics {
  overflow: hidden;
  color: #83eee5;
  font-size: 8px;
  font-weight: 850;
  letter-spacing: 0.035em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;
let css = fs.readFileSync('client/styles.css', 'utf8');
if (!css.includes('/* Social cosmetics: миниатюра')) {
  fs.writeFileSync('client/styles.css', `${css.trimEnd()}${socialCss}`);
}

console.log('social cosmetics patches applied');
