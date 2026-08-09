// Кооперативная часть игры: состояние пары, действия ролей, катапульта, оживление, указатель на
// напарника.
//
// Всё это жило в Game вперемешку с гонкой. Разница между режимами не в паре флагов, а в том, что в
// кооперативе есть второй игрок, чьё положение меняет мир: плиты нажимаются обоими, мост держится
// одним, катапульта подбрасывает другого. Держать эту логику рядом с рендер-циклом означало, что
// любой вопрос про кооп начинался с чтения всего файла.
//
// Контроллер обращается к игре, а не хранит её части: игрок, трасса и сеть пересоздаются на каждом
// матче, и захваченная при постройке ссылка через один забег указывала бы в никуда.

import * as THREE from 'three';
import { COLORS } from '../core/Config.js';
import { updateRoleActions as updateRoleActionsFor } from './CoopActions.js';
import { CoopSession } from './CoopSession.js';

export const COOP_PING_LABELS = Object.freeze({
  here: 'СЮДА',
  wait: 'ЖДИ',
  go: 'ИДИ',
  help: 'ПОМОГИ',
  ready: 'ГОТОВ',
  thanks: '👍'
});

export class CoopController {
  constructor(game) {
    this.game = game;
    this._marker = new THREE.Vector3();
    this.ping = null;
    this.tetherLine = null;
  }

  // Кооператив в одиночку: напарник ушёл насовсем.
  //
  // Считается по составу комнаты, а не по буферу снапшотов: буфер пустеет и от секундной паузы в
  // сети, а состав знает, кто в комнате остался. Оборвавшийся игрок держит своё место 30 секунд и
  // всё это время в составе есть — значит короткий обрыв связи главу не упрощает, а вот выход
  // напарника открывает преграды сразу.
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

  // Состояние кооп-объектов выводится из положений обоих игроков, и оба у нас есть: своё — прямо
  // из игрока, чужое — из буфера снапшотов. Обмениваться этим состоянием по сети не нужно, клиенты
  // приходят к нему сами.
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

  // Кооперативные действия. Удар сверху повешен на ту же кнопку, что и рывок: на телефоне нельзя
  // множить кнопки, а на земле и в воздухе смысл нажатия и так разный.
  updateRoleActions() {
    if (this.game.mode !== 'coop' || !this.game.player) return;
    updateRoleActionsFor(
      this.game.player,
      this.game.course,
      this.game.input,
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
    // Импульс считает инициатор, применяет — цель. Сервер ограничивает модуль и ретранслирует:
    // это единственное место, где один игрок меняет состояние другого.
    this.game.net?.sendCoopEvent('launch', {
      objectId: catapultId,
      vector: { x: 0, y: catapult.power, z: -catapult.power * catapult.forward }
    });
  }
  receiveCoopEvent(message) {
    if (!this.game.course || this.game.mode !== 'coop') return;
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
        ? { x: (projected.x * 0.5 + 0.5) * innerWidth, y: (-projected.y * 0.5 + 0.5) * innerHeight }
        : null
    );
  }

  // Оживление напарника прикосновением. Проверка простая: подошёл достаточно близко.
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

  // Экранное положение напарника для указателя. Пока он в кадре, указатель скрыт: лишняя
  // стрелка поверх видимого персонажа только загромождает экран.
  updatePartnerMarker() {
    this.updatePingMarker();
    const partner = this.game.remotes.values().next().value;
    this.updateTetherVisual(partner);
    if (!partner || !this.game.player) {
      this.game.ui.updatePartnerMarker({ screen: null });
      return;
    }
    const world = this._marker.copy(partner.visualPosition).setY(partner.visualPosition.y + 1.6);
    const projected = world.project(this.game.camera);
    // z > 1 означает, что точка позади камеры — проекция там зеркалится, и стрелку надо развернуть.
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

  // Позиция напарника для кооп-кадрирования камеры. В гонке возвращает null: подстраивать кадр
  // под произвольного соперника не нужно, это только мешало бы целиться в прыжок.
  partnerPosition() {
    if (this.game.mode !== 'coop') return null;
    const partner = this.game.remotes.values().next().value;
    return partner ? partner.visualPosition : null;
  }
}
