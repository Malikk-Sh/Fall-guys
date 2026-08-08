// Состояние кооперативной пары без DOM, Three.js и сетевого транспорта. Геометрические эффекты
// по-прежнему применяет Game, а здесь остаётся авторитетная для клиента модель ролей и напарника.
export class CoopSession {
  constructor() {
    this.reset();
  }

  reset() {
    this.active = false;
    this.selfId = null;
    this.slots = {};
    this.mySlot = 0;
    this.partnerDown = false;
    this.partnerAway = false;
    this.revives = 0;
  }

  start({ selfId = null, slots = {}, partnerAway = false } = {}) {
    this.active = true;
    this.selfId = selfId;
    this.slots = { ...slots };
    this.mySlot = this.slotFor(selfId);
    this.partnerDown = false;
    this.partnerAway = Boolean(partnerAway);
    this.revives = 0;
    return this;
  }

  slotFor(id) {
    return Number.isInteger(this.slots?.[id]) ? this.slots[id] : 0;
  }

  setPartnerAway(value) {
    this.partnerAway = Boolean(value);
  }

  // Остался ли игрок в главе один. Решение вынесено сюда из Game, чтобы его можно было проверить
  // без сцены и сети: правило короткое, но ошибиться в нём легко, а ценой будет либо запертый
  // игрок, либо открытые преграды в нормальной игре.
  //
  // Три случая, и различать их обязательно:
  //   • состава ещё нет — «неизвестно»: при возвращении в идущий матч старт приходит раньше
  //     состава, и принять это за «никого нет» значит объявлять об ушедшем напарнике на каждом
  //     переподключении;
  //   • напарник в составе есть — не один, даже если связь у него сейчас оборвана: слот держится
  //     30 секунд, и короткий обрыв не должен упрощать главу;
  //   • напарника в составе нет — один.
  static soloFromRoster(roster, selfId) {
    if (!Array.isArray(roster)) return null;
    return roster.filter(player => player?.id !== selfId).length === 0;
  }

  // Возвращаем описание визуального эффекта, не выполняя его здесь. Благодаря этому reducer
  // тестируется без настоящих Player/AudioEngine/CameraController.
  applyEvent(message) {
    if (!this.active || !message?.action) return null;
    const self = message.target === this.selfId;
    if (message.action === 'launch' && self) return { type: 'launch-self', vector: message.vector };
    if (message.action === 'downed') {
      if (!self) this.partnerDown = true;
      return { type: self ? 'down-self' : 'down-partner' };
    }
    if (message.action === 'revive') {
      if (!self) {
        this.partnerDown = false;
        this.revives++;
      }
      return { type: self ? 'revive-self' : 'revive-partner' };
    }
    return null;
  }

  canRevive({ localDowned = false, distance = Infinity } = {}) {
    return this.active && this.partnerDown && !localDowned && Number.isFinite(distance) && distance <= 3.5;
  }
}
