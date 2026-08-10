// Наблюдатель за сервером во время внешнего load test.
//
// Запускается НА САМОМ VPS, пока один или несколько loadProbe работают с других машин:
//   WOBBLE_SERVER_PID=$(systemctl show -p MainPID --value wobble) npm run load:observe -- 1800
//
// PID передаётся явно: observer не угадывает production-процесс по строке команды и поэтому не
// зависит от того, запускается Node как `node`, `/usr/bin/node` или через другой service wrapper.

import { readFile } from 'node:fs/promises';
import { loadTargets } from './loadProbeConfig.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const { httpUrl, serverPid } = loadTargets();
const seconds = Math.max(1, Number(process.argv[2] || 30));
const pid = serverPid;

if (!pid || !/^[1-9]\d*$/.test(pid)) {
  throw new Error(
    'Передайте PID сервера: WOBBLE_SERVER_PID=$(systemctl show -p MainPID --value wobble) npm run load:observe'
  );
}

const first = await pidStat(pid);
let previous = first;
let previousAt = process.hrtime.bigint();
let peakRssMb = first.rssMb;
let peakCpuPercent = 0;
let peakEventLoopP95Ms = 0;

console.log(`наблюдаю PID ${pid} ${seconds} с · health ${httpUrl}/health`);

for (let second = 1; second <= seconds; second++) {
  await sleep(1000);
  const nowAt = process.hrtime.bigint();
  const stat = await pidStat(pid);
  const wall = Number(nowAt - previousAt) / 1e9;
  const cpuPercent = wall > 0 ? ((stat.cpuSeconds - previous.cpuSeconds) / wall) * 100 : 0;
  const health = await fetch(`${httpUrl}/health`).then(response => {
    if (!response.ok) throw new Error(`health HTTP ${response.status}`);
    return response.json();
  });

  peakRssMb = Math.max(peakRssMb, stat.rssMb);
  peakCpuPercent = Math.max(peakCpuPercent, cpuPercent);
  peakEventLoopP95Ms = Math.max(peakEventLoopP95Ms, Number(health.load?.eventLoopP95Ms || 0));

  if (second === 1 || second === seconds || second % 10 === 0) {
    console.log(
      `${second}s players=${health.players} rooms=${health.rooms} queue=${health.matchmaking?.waiting || 0} ` +
        `rss=${stat.rssMb.toFixed(1)}MB cpu=${cpuPercent.toFixed(1)}% loopP95=${health.load?.eventLoopP95Ms || 0}ms`
    );
  }

  previous = stat;
  previousAt = nowAt;
}

console.log('\n--- ПИКИ НА СЕРВЕРЕ ---');
console.log(`RSS:             ${peakRssMb.toFixed(1)} МБ`);
console.log(`CPU одного ядра: ${peakCpuPercent.toFixed(1)} %`);
console.log(`event-loop p95:  ${peakEventLoopP95Ms.toFixed(1)} мс`);

async function pidStat(targetPid) {
  const [rawStat, rawStatus] = await Promise.all([
    readFile(`/proc/${targetPid}/stat`, 'utf8'),
    readFile(`/proc/${targetPid}/status`, 'utf8')
  ]);
  const fields = rawStat.trim().split(' ');
  const utime = Number(fields[13]);
  const stime = Number(fields[14]);
  const rssKb = Number(rawStatus.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
  return { cpuSeconds: (utime + stime) / 100, rssMb: rssKb / 1024 };
}
