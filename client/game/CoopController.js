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

export class CoopController {
  constructor(game) {
    this.game = game;
    this._marker = new THREE.Vector3();
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
    const partner = this.game.remotes.values().next().value;
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

  // Позиция напарника для кооп-кадрирования камеры. В гонке возвращает null: подстраивать кадр
  // под произвольного соперника не нужно, это только мешало бы целиться в прыжок.
  partnerPosition() {
    if (this.game.mode !== 'coop') return null;
    const partner = this.game.remotes.values().next().value;
    return partner ? partner.visualPosition : null;
  }
}
