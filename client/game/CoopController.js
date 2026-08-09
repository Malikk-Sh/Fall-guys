// Кооперативная часть игры: состояние пары, действия ролей, signature-механики, оживление и
// указатель на напарника.

import * as THREE from 'three';
import { COLORS } from '../core/Config.js';
import { updateRoleActions as updateRoleActionsFor } from './CoopActions.js';
import { CoopSession } from './CoopSession.js';
import { SIGNATURE_INTERACT_RADIUS, signatureLayout } from '/shared/signatureCoop.js';

export const COOP_PING_LABELS = Object.freeze({
  here: 'СЮДА',
  wait: 'ЖДИ',
  go: 'ИДИ',
  help: 'ПОМОГИ',
  ready: 'ГОТОВ',
  thanks: '👍'
});

const signatureDistance = (position, target) =>
  position && target
    ? Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z)
    : Infinity;

export class CoopController {
  constructor(game) {
    this.game = game;
    this._marker = new THREE.Vector3();
    this.ping = null;
    this.tetherLine = null;
    this.signatureCourse = null;
    this.signature = null;
    this.signatureState = null;
    this.signatureSyncedFor = null;
    this.signatureVisuals = null;
    this.signatureHud = null;

    if (globalThis.addEventListener) {
      addEventListener('keydown', event => {
        const input = globalThis.HTMLInputElement && event.target instanceof globalThis.HTMLInputElement;
        const select = globalThis.HTMLSelectElement && event.target instanceof globalThis.HTMLSelectElement;
        if (input || select || !/^Digit[1-4]$/.test(event.code)) return;
        if (!this.signalControlsVisible()) return;
        event.preventDefault();
        this.pressSignal(Number(event.code.at(-1)) - 1);
      });
    }
  }

  // Кооператив в одиночку: напарник ушёл насовсем.
  refreshSolo() {
    if (this.game.mode !== 'coop' || typeof this.game.course?.setSolo !== 'function') return;
    const solo = CoopSession.soloFromRoster(this.game.room?.players, this.game.net?.id);
    if (solo === null || !this.game.course.setSolo(solo)) return;
    if (this.game.course.solo) {
      this.game.ui.toast(
        'Напарник вышел. Кооперативные преграды открыты — главу можно закончить одному.',
        'info',
        5200
      );
    }
  }

  // Состояние игроков, доступное кооперативной логике.
  actors() {
    const actors = [];
    if (this.game.player && this.game.net) {
      actors.push({
        id: this.game.net.id,
        position: this.game.player.position,
        velocity: this.game.player.velocity,
        grounded: this.game.player.grounded,
        downed: this.game.player.downed
      });
    }
    for (const [id, remote] of this.game.remotes) {
      actors.push({
        id,
        position: remote.position,
        velocity: remote.velocity,
        grounded: false,
        downed: remote.downed
      });
    }
    return actors;
  }

  ensureSignature() {
    if (this.game.mode !== 'coop' || !this.game.course?.spec?.chapterId) return false;
    if (this.signatureCourse === this.game.course)
      return Boolean(this.signature?.core || this.signature?.signal);

    this.signatureCourse = this.game.course;
    this.signature = signatureLayout(this.game.course.spec.chapterId);
    this.signatureSyncedFor = null;
    this.signatureState = {
      core: this.signature.core
        ? {
            id: this.signature.core.id,
            position: { ...this.signature.core.spawn },
            velocity: { x: 0, y: 0, z: 0 },
            carrier: null,
            insertedInto: null,
            at: this.game.raceNow()
          }
        : null,
      signal: this.signature.signal
        ? { id: this.signature.signal.id, progress: 0, solved: false, roles: null }
        : null
    };
    this.signatureVisuals = null;

    if (!this.signature.core && !this.signature.signal) {
      this.hideSignatureHud();
      return false;
    }

    this.buildSignatureVisuals();
    this.disableLegacyGateControls();
    return true;
  }

  disableLegacyGateControls() {
    const gateId = this.signature?.core?.gateId || this.signature?.signal?.gateId;
    const span = gateId ? this.game.course?.spans?.get(gateId) : null;
    for (const id of span?.requires || []) {
      const plate = this.game.course.plates?.get(id);
      if (plate?.mesh) plate.mesh.visible = false;
      if (plate?.ring) plate.ring.visible = false;
    }
    // Первая подсказка ch9 рассказывала про старые плиты. Настоящий terminal HUD сам объясняет
    // guide/operator, поэтому старый урок скрываем, а финальный урок про sync gate оставляем.
    if (this.signature?.signal) this.game.course.learned?.add('vertical');
  }

  buildSignatureVisuals() {
    const group = new THREE.Group();
    group.name = 'signature-coop';
    this.game.course.group.add(group);
    const visuals = {
      group,
      core: null,
      socket: null,
      guide: null,
      operator: null,
      buttons: []
    };

    if (this.signature.core) {
      const coreMaterial = new THREE.MeshStandardMaterial({
        color: COLORS.yellow,
        emissive: COLORS.yellow,
        emissiveIntensity: 1.5,
        roughness: 0.18,
        metalness: 0.1
      });
      visuals.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.68, 1), coreMaterial);
      visuals.core.castShadow = this.game.course.quality !== 'low';
      group.add(visuals.core);

      const socketMaterial = new THREE.MeshStandardMaterial({
        color: COLORS.mint,
        emissive: COLORS.mint,
        emissiveIntensity: 0.85,
        roughness: 0.3
      });
      visuals.socket = new THREE.Group();
      visuals.socket.position.set(
        this.signature.core.socket.x,
        this.signature.core.socket.y - 0.55,
        this.signature.core.socket.z
      );
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.35, 0.35, 20), socketMaterial);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.13, 8, 24), socketMaterial);
      ring.position.y = 0.3;
      ring.rotation.x = Math.PI / 2;
      visuals.socket.add(base, ring);
      group.add(visuals.socket);
    }

    if (this.signature.signal) {
      const panelMaterial = new THREE.MeshStandardMaterial({
        color: COLORS.purpleDark,
        emissive: COLORS.blue,
        emissiveIntensity: 0.5,
        roughness: 0.32
      });
      const makeTerminal = point => {
        const terminal = new THREE.Group();
        terminal.position.set(point.x, point.y, point.z);
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.8, 2.1, 0.65), panelMaterial.clone());
        body.position.y = 0.65;
        terminal.add(body);
        group.add(terminal);
        return terminal;
      };
      visuals.guide = makeTerminal(this.signature.signal.guide);
      visuals.operator = makeTerminal(this.signature.signal.operator);
      const buttonColors = [COLORS.cyan, COLORS.orange, COLORS.pink, COLORS.mint];
      for (let index = 0; index < this.signature.signal.symbols.length; index++) {
        const pad = new THREE.Mesh(
          new THREE.BoxGeometry(0.72, 0.18, 0.72),
          new THREE.MeshStandardMaterial({
            color: buttonColors[index % buttonColors.length],
            emissive: buttonColors[index % buttonColors.length],
            emissiveIntensity: 1
          })
        );
        pad.position.set(index % 2 ? 0.55 : -0.55, 0.72, index > 1 ? 0.37 : -0.37);
        visuals.operator.add(pad);
        visuals.buttons.push(pad);
      }
    }

    this.signatureVisuals = visuals;
  }

  syncSignature() {
    if (!this.ensureSignature() || !this.game.net?.matchId) return;
    if (this.signatureSyncedFor === this.game.net.matchId) return;
    this.signatureSyncedFor = this.game.net.matchId;
    this.game.net.sendCoopEvent('plate', { objectId: 'sig:sync' });
  }

  sendSignature(objectId, data = {}) {
    if (!this.game.net?.matchId) return false;
    return this.game.net.sendCoopEvent('plate', { objectId, ...data });
  }

  localCorePosition() {
    const core = this.signatureState?.core;
    const layout = this.signature?.core;
    if (!core || !layout) return null;
    if (core.insertedInto) return { ...layout.socket };
    if (core.carrier) {
      const actor =
        core.carrier === this.game.net?.id ? this.game.player : this.game.remotes.get(core.carrier);
      const position = actor?.visualPosition || actor?.position;
      return position ? { x: position.x, y: position.y + 1.65, z: position.z } : core.position;
    }

    const now = this.game.raceNow();
    const dt = Math.max(0, Math.min(3, (now - (core.at || now)) / 1000));
    const floor = 1.05;
    return {
      x: core.position.x + (core.velocity?.x || 0) * dt,
      y: Math.max(floor, core.position.y + (core.velocity?.y || 0) * dt - 9 * dt * dt),
      z: core.position.z + (core.velocity?.z || 0) * dt
    };
  }

  coreAction() {
    if (!this.signature?.core || !this.signatureState?.core || !this.game.player) return null;
    const core = this.signatureState.core;
    const player = this.game.player.position;
    if (core.insertedInto) return null;
    if (core.carrier === this.game.net?.id) {
      return signatureDistance(player, this.signature.core.socket) <= this.signature.core.insertRadius + 0.4
        ? 'insert'
        : 'throw';
    }
    if (core.carrier) return null;
    return signatureDistance(player, this.localCorePosition()) <= this.signature.core.pickupRadius + 0.45
      ? 'pickup'
      : null;
  }

  handleCoreAction() {
    const action = this.coreAction();
    if (!action || !this.game.input.consume('dive')) return false;
    if (action === 'pickup') this.sendSignature('core:pickup');
    else if (action === 'insert') this.sendSignature('core:insert');
    else {
      const yaw = this.game.cameraController.yaw;
      this.sendSignature('core:throw', {
        vector: { x: -Math.sin(yaw), y: 0.42, z: -Math.cos(yaw) }
      });
    }
    return true;
  }

  applySignatureGate() {
    if (!this.ensureSignature()) return;
    const gateId = this.signature.core?.gateId || this.signature.signal?.gateId;
    const span = gateId ? this.game.course.spans?.get(gateId) : null;
    if (!span) return;
    const solved = this.signature.core
      ? Boolean(this.signatureState?.core?.insertedInto)
      : Boolean(this.signatureState?.signal?.solved);
    this.game.course.setSpanActive(span, solved || this.game.course.solo, this.game.sfx);
  }

  // Кооперативные действия. Удар сверху повешен на ту же кнопку, что и рывок. Рядом с ядром эта
  // кнопка становится контекстным действием: взять / бросить / вставить. В остальных местах
  // прежняя катапульта и slam работают без изменений.
  updateRoleActions() {
    if (this.game.mode !== 'coop' || !this.game.player) return;
    this.syncSignature();
    this.applySignatureGate();
    const usedByCore = this.handleCoreAction();
    updateRoleActionsFor(
      this.game.player,
      this.game.course,
      usedByCore ? { consume: () => false } : this.game.input,
      this.game.cameraController.yaw,
      {
        onSlam: () => {
          this.game.sfx.slam();
          this.game.cameraController.addShake(0.3);
        },
        onCatapult: id => this.triggerCatapult(id)
      }
    );
  }

  triggerCatapult(catapultId) {
    const { actor, catapult } = this.game.course.launchCandidate(catapultId, this.actors());
    this.game.course.triggerCatapultVisual(catapultId);
    this.game.cameraController.addShake(0.6);
    this.game.sfx.catapult(this.game.player.visualPosition);
    this.game.effects.burst(this.game.player.position, COLORS.yellow, 20, 1.3);
    if (!actor || actor.id === this.game.net.id) return;
    this.game.net?.sendCoopEvent('launch', {
      objectId: catapultId,
      vector: { x: 0, y: catapult.power, z: -catapult.power * catapult.forward }
    });
  }

  receiveCoopEvent(message) {
    if (!this.game.course || this.game.mode !== 'coop') return;
    if (message.action === 'signatureState') {
      this.ensureSignature();
      if (message.signature) this.signatureState = message.signature;
      this.applySignatureGate();
      return;
    }
    const effect = this.game.coop.applyEvent(message);
    if (effect?.type === 'launch-self') {
      this.game.player?.applyLaunch(effect.vector);
      this.game.sfx.catapult();
      this.game.cameraController.addShake(0.5);
      return;
    }
    if (effect?.type === 'down-self') {
      this.game.player?.goDown(this.game.player.position);
      return;
    }
    if (effect?.type === 'revive-self') {
      this.game.player?.revive();
      this.game.sfx.revive();
    } else if (effect?.type === 'revive-partner') {
      this.game.sfx.revive(this.game.remotes.values().next().value?.visualPosition);
    }
  }

  ensureSignatureHud() {
    if (this.signatureHud || !globalThis.document) return this.signatureHud;
    const root = document.createElement('div');
    root.id = 'signatureHud';
    root.className = 'glass hidden';
    root.style.cssText =
      'position:fixed;top:max(82px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:25;max-width:min(88vw,440px);padding:10px 14px;text-align:center;pointer-events:auto';
    const text = document.createElement('div');
    text.style.cssText = 'font-weight:800;line-height:1.35';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin-top:8px';
    root.append(text, actions);
    (document.querySelector('#hud') || document.body).append(root);
    this.signatureHud = { root, text, actions };
    return this.signatureHud;
  }

  hideSignatureHud() {
    this.signatureHud?.root.classList.add('hidden');
  }

  signalControlsVisible() {
    return Boolean(
      this.signatureHud &&
      !this.signatureHud.root.classList.contains('hidden') &&
      this.signatureHud.actions.dataset.signal === 'true'
    );
  }

  pressSignal(index) {
    if (!this.signalControlsVisible()) return;
    this.sendSignature(`signal:press:${index}`);
  }

  setSignalButtons(symbols) {
    const hud = this.ensureSignatureHud();
    hud.actions.replaceChildren();
    hud.actions.dataset.signal = 'true';
    symbols.forEach((symbol, index) => {
      const button = document.createElement('button');
      button.className = 'button button-secondary';
      button.style.cssText = 'min-width:52px;padding:8px 12px';
      button.textContent = `${index + 1} · ${symbol}`;
      button.addEventListener('click', () => this.pressSignal(index));
      hud.actions.append(button);
    });
  }

  updateSignatureHud() {
    if (!this.ensureSignature() || !globalThis.document || !this.game.player) return this.hideSignatureHud();
    const hud = this.ensureSignatureHud();
    const coreAction = this.coreAction();
    if (this.signature.core && coreAction) {
      const labels = {
        pickup: 'ЯДРО РЯДОМ · РЫВОК = ВЗЯТЬ',
        throw: 'НЕСЁТЕ ЯДРО · РЫВОК = БРОСИТЬ',
        insert: 'ПРИЁМНИК РЯДОМ · РЫВОК = ВСТАВИТЬ'
      };
      hud.text.textContent = labels[coreAction];
      hud.actions.replaceChildren();
      hud.actions.dataset.signal = 'false';
      hud.root.classList.remove('hidden');
      return;
    }

    if (
      this.signature.core &&
      !this.signatureState?.core?.carrier &&
      !this.signatureState?.core?.insertedInto
    ) {
      const core = this.localCorePosition();
      const lost = core && signatureDistance(core, this.signature.core.spawn) > 7;
      if (lost) {
        hud.text.textContent = 'ЯДРО ПОТЕРЯНО? Его можно вернуть к началу эстафеты.';
        hud.actions.replaceChildren();
        hud.actions.dataset.signal = 'false';
        const reset = document.createElement('button');
        reset.className = 'button button-secondary';
        reset.textContent = 'ВЕРНУТЬ ЯДРО';
        reset.addEventListener('click', () => this.sendSignature('core:reset'));
        hud.actions.append(reset);
        hud.root.classList.remove('hidden');
        return;
      }
    }

    if (this.signature.signal && this.signatureState?.signal) {
      if (this.signatureState.signal.solved) return this.hideSignatureHud();
      const roles = this.signatureState.signal.roles;
      const myId = this.game.net?.id;
      if (myId === roles?.guide) {
        if (
          signatureDistance(this.game.player.position, this.signature.signal.guide) >
          SIGNATURE_INTERACT_RADIUS + 1
        )
          return this.hideSignatureHud();
        const progress = this.signatureState.signal.progress || 0;
        hud.text.textContent = `ПОДСКАЗЧИК · ПОСЛЕДОВАТЕЛЬНОСТЬ: ${this.signature.signal.sequence.join('  ')} · ${progress}/${this.signature.signal.sequence.length}`;
        hud.actions.replaceChildren();
        hud.actions.dataset.signal = 'false';
        hud.root.classList.remove('hidden');
        return;
      }
      if (myId === roles?.operator) {
        if (
          signatureDistance(this.game.player.position, this.signature.signal.operator) >
          SIGNATURE_INTERACT_RADIUS + 1
        )
          return this.hideSignatureHud();
        hud.text.textContent = `ОПЕРАТОР · ВВЕДИТЕ СИМВОЛЫ НАПАРНИКА · ${this.signatureState.signal.progress}/${this.signature.signal.sequence.length}`;
        if (!this.signalControlsVisible()) this.setSignalButtons(this.signature.signal.symbols);
        hud.root.classList.remove('hidden');
        return;
      }
    }

    this.hideSignatureHud();
  }

  updateSignatureVisuals() {
    if (!this.ensureSignature() || !this.signatureVisuals) {
      this.hideSignatureHud();
      return;
    }
    if (this.signatureVisuals.core) {
      const position = this.localCorePosition();
      if (position) this.signatureVisuals.core.position.set(position.x, position.y, position.z);
      this.signatureVisuals.core.visible = !this.signatureState?.core?.insertedInto;
      this.signatureVisuals.core.rotation.y += 0.025;
      this.signatureVisuals.core.rotation.x += 0.012;
      if (this.signatureVisuals.socket) {
        const powered = Boolean(this.signatureState?.core?.insertedInto);
        this.signatureVisuals.socket.scale.setScalar(powered ? 1.18 : 1);
      }
    }
    if (this.signatureVisuals.guide && this.signatureState?.signal) {
      const solved = this.signatureState.signal.solved;
      this.signatureVisuals.guide.scale.setScalar(solved ? 1.12 : 1);
      this.signatureVisuals.operator.scale.setScalar(solved ? 1.12 : 1);
      this.signatureVisuals.buttons.forEach((button, index) => {
        button.position.y = 0.72 + Math.sin(performance.now() * 0.004 + index) * 0.04;
      });
    }
    this.updateSignatureHud();
  }

  sendPing(command) {
    if (this.game.mode !== 'coop' || !COOP_PING_LABELS[command] || !this.game.net?.matchId) return false;
    return this.game.net.send('coopPing', { matchId: this.game.net.matchId, command });
  }

  receivePing(message) {
    if (message.matchId !== this.game.net?.matchId || !COOP_PING_LABELS[message.command]) return;
    this.ping = { id: message.id, command: message.command, until: performance.now() + 1800 };
    const actor = message.id === this.game.net.id ? this.game.player : this.game.remotes.get(message.id);
    this.game.sfx.ping(actor?.visualPosition);
    this.game.settings.vibrate(0.3);
  }

  updatePingMarker() {
    if (!this.ping || performance.now() >= this.ping.until) {
      this.ping = null;
      this.game.ui.updateCoopPing(null);
      return;
    }
    const actor = this.ping.id === this.game.net?.id ? this.game.player : this.game.remotes.get(this.ping.id);
    if (!actor) return this.game.ui.updateCoopPing(null);
    const projected = this._marker
      .copy(actor.visualPosition)
      .setY(actor.visualPosition.y + 2.5)
      .project(this.game.camera);
    const visible = projected.z < 1;
    this.game.ui.updateCoopPing(
      COOP_PING_LABELS[this.ping.command],
      visible
        ? {
            x: (projected.x * 0.5 + 0.5) * innerWidth,
            y: (-projected.y * 0.5 + 0.5) * innerHeight
          }
        : null
    );
  }

  // Оживление напарника прикосновением.
  tryRevivePartner() {
    if (this.game.mode !== 'coop') return;
    const partner = this.game.remotes.values().next().value;
    if (!partner) return;
    if (
      !this.game.coop.canRevive({
        localDowned: this.game.player?.downed,
        distance: this.game.player.position.distanceTo(partner.position)
      })
    )
      return;
    this.game.net?.sendCoopEvent('revive');
  }

  updatePartnerMarker() {
    this.updateSignatureVisuals();
    this.updatePingMarker();
    const partner = this.game.remotes.values().next().value;
    this.updateTetherVisual(partner);
    if (!partner || !this.game.player) {
      this.game.ui.updatePartnerMarker({ screen: null });
      return;
    }
    const world = this._marker.copy(partner.visualPosition).setY(partner.visualPosition.y + 1.6);
    const projected = world.project(this.game.camera);
    const behind = projected.z > 1;
    const x = ((behind ? -projected.x : projected.x) * 0.5 + 0.5) * innerWidth;
    const y = ((behind ? -projected.y : -projected.y) * 0.5 + 0.5) * innerHeight;
    const onScreen =
      !behind && projected.x > -0.92 && projected.x < 0.92 && projected.y > -0.92 && projected.y < 0.92;
    this.game.ui.updatePartnerMarker({
      screen: { x, y },
      visible: onScreen,
      distance: this.game.player.visualPosition.distanceTo(partner.visualPosition),
      down: this.game.coop.partnerDown,
      away: this.game.coop.partnerAway
    });
  }

  updateTetherVisual(partner) {
    const enabled = Boolean(this.game.course?.spec?.mechanics?.tether && partner && this.game.player);
    if (!enabled) {
      if (this.tetherLine) this.tetherLine.visible = false;
      return;
    }
    if (!this.tetherLine) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      this.tetherLine = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: COLORS.yellow, transparent: true, opacity: 0.9 })
      );
      this.tetherLine.frustumCulled = false;
      this.game.scene.add(this.tetherLine);
    }
    const points = this.tetherLine.geometry.attributes.position.array;
    const local = this.game.player.visualPosition;
    const remote = partner.visualPosition;
    points.set([local.x, local.y + 0.7, local.z, remote.x, remote.y + 0.7, remote.z]);
    this.tetherLine.geometry.attributes.position.needsUpdate = true;
    this.tetherLine.visible = true;
  }

  partnerPosition() {
    if (this.game.mode !== 'coop') return null;
    const partner = this.game.remotes.values().next().value;
    return partner ? partner.visualPosition : null;
  }
}
