// Синхронизация часов с сервером.
//
// Зачем это нужно именно здесь. Фаза всех препятствий (вертушки, поршни, движущиеся платформы)
// вычисляется из времени, прошедшего с начала забега. Сервер присылает момент старта в своём времени,
// а клиент раньше сравнивал его со своим локальным `Date.now()`. Системные часы игроков расходятся
// на секунды — и в результате два игрока видели вертушку в разных положениях. Один визуально
// уворачивался, а на экране напарника его сносило балкой. Это был самый заметный сетевой баг.
//
// Метод — упрощённый NTP. На каждый обмен ping/pong получаем четыре отметки времени и вычисляем,
// на сколько серверные часы опережают клиентские. Из окна замеров берём тот, у которого RTT минимален:
// чем меньше время в пути, тем меньше в оценке случайной сетевой задержки. Усреднять здесь нельзя —
// одиночная задержка в очереди маршрутизатора испортила бы среднее, а на минимум она не влияет.

const WINDOW = 12;

export class ClockSync {
  constructor() {
    this.samples = [];
    this.offset = 0;
    this.rtt = NaN;
    this.synced = false;
  }

  // sentAt / receivedAt — по локальным часам, serverTime — по серверным, все в миллисекундах.
  record(sentAt, serverTime, receivedAt = Date.now()) {
    if (![sentAt, serverTime, receivedAt].every(Number.isFinite)) return;
    const rtt = receivedAt - sentAt;
    if (rtt < 0) return;

    // Считаем, что пакет летел туда и обратно одинаково, поэтому в момент получения на сервере
    // было serverTime + rtt/2.
    const offset = serverTime + rtt / 2 - receivedAt;

    this.samples.push({ rtt, offset });
    if (this.samples.length > WINDOW) this.samples.shift();

    let best = this.samples[0];
    for (const sample of this.samples) if (sample.rtt < best.rtt) best = sample;
    this.offset = best.offset;
    this.rtt = best.rtt;
    this.synced = true;
  }

  // Текущее серверное время по оценке клиента.
  serverNow(clientNow = Date.now()) {
    return clientNow + this.offset;
  }

  // Половина минимального RTT — то, что показывается игроку как «пинг».
  get latency() {
    return Number.isFinite(this.rtt) ? this.rtt / 2 : NaN;
  }

  reset() {
    this.samples.length = 0;
    this.offset = 0;
    this.rtt = NaN;
    this.synced = false;
  }
}
