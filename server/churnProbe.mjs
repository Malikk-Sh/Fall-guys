// Deterministic reconnect/churn generator for Nightly Reliability 2.0.
//
// Uses the real production WebSocket protocol: create/join/start, network-style terminate(),
// session resume, presence broadcasts, state traffic, and explicit leave for deterministic cleanup.
// The probe records facts; churnGate.mjs owns pass/fail policy and performance budgets.

import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { loadStateMessage, loadTargets, loopbackSourceAddress } from './loadProbeConfig.mjs';

const { wsUrl, httpUrl } = loadTargets();
const RESULT_PATH = String(process.env.WOBBLE_CHURN_PROBE_RESULT_PATH || '').trim() || null;
const BASE_ROOMS = positiveInteger(process.env.WOBBLE_CHURN_ROOMS || 12, 'WOBBLE_CHURN_ROOMS');
const RAPID_CYCLES = positiveInteger(
  process.env.WOBBLE_CHURN_RAPID_CYCLES || 3,
  'WOBBLE_CHURN_RAPID_CYCLES'
);
const STORM_CLIENTS = positiveInteger(
  process.env.WOBBLE_CHURN_STORM_CLIENTS || 24,
  'WOBBLE_CHURN_STORM_CLIENTS'
);
const ROOM_ITERATIONS = positiveInteger(
  process.env.WOBBLE_CHURN_ROOM_ITERATIONS || 100,
  'WOBBLE_CHURN_ROOM_ITERATIONS'
);
const CHURN_BATCH = Math.min(10, ROOM_ITERATIONS);
const WAIT_MS = 8000;

if (STORM_CLIENTS < 20 || STORM_CLIENTS > 40) {
  throw new Error(`WOBBLE_CHURN_STORM_CLIENTS must stay in the Nightly 2.0 range 20..40, got ${STORM_CLIENTS}`);
}
if (STORM_CLIENTS > BASE_ROOMS * 2) {
  throw new Error(
    `WOBBLE_CHURN_STORM_CLIENTS ${STORM_CLIENTS} exceeds the ${BASE_ROOMS * 2} base clients`
  );
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return number;
}

class Client {
  constructor(sourceAddress = null, label = 'client') {
    this.label = label;
    this.sourceAddress = sourceAddress;
    this.waiters = [];
    this.sequence = 0;
    this.matchId = null;
    this.token = null;
    this.id = null;
    this.lastError = null;

    this.hello = this.wait('hello');
    this.ws = sourceAddress ? new WebSocket(wsUrl, { localAddress: sourceAddress }) : new WebSocket(wsUrl);
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'hello') {
        this.id = message.id;
        this.token = message.token;
      }
      if (message.type === 'resumed') {
        this.id = message.id;
        this.token = message.token;
      }
      if (message.type === 'start') {
        this.matchId = message.matchId;
        this.sequence = Number(message.resumed?.nextSequence ?? 0);
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.type !== message.type || !waiter.ok(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
    this.ws.on('error', error => {
      this.lastError = error instanceof Error ? error.message : String(error);
    });
  }

  wait(type, ok = () => true, ms = WAIT_MS) {
    return new Promise((resolve, reject) => {
      const waiter = { type, ok, resolve: null };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${this.label}: timeout ${type}`));
      }, ms);
      waiter.resolve = value => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
    });
  }

  send(type, data = {}) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
      return true;
    }
    return false;
  }

  sendState(z, vz = -7) {
    if (!this.matchId || this.ws.readyState !== WebSocket.OPEN) return false;
    const sequence = this.sequence++;
    this.ws.send(JSON.stringify(loadStateMessage({ matchId: this.matchId, sequence, z, vz })));
    return true;
  }

  leave() {
    this.send('leave');
  }

  terminate() {
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

async function health() {
  const response = await fetch(`${httpUrl}/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return response.json();
}

async function readiness() {
  const response = await fetch(`${httpUrl}/health/ready`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // HTTP status still carries useful diagnostics.
  }
  return { ok: response.ok && body?.ok === true, status: response.status };
}

function compactHealth(value) {
  return {
    rooms: value.rooms,
    players: value.players,
    sessions: value.sessions,
    capacity: value.capacity,
    load: value.load,
    metrics: value.metrics
  };
}

function metricDelta(before, after, name) {
  return Number(after.metrics?.[name] || 0) - Number(before.metrics?.[name] || 0);
}

function counts(value) {
  return { rooms: Number(value.rooms), players: Number(value.players), sessions: Number(value.sessions) };
}

function sameCounts(actual, expected) {
  return ['rooms', 'players', 'sessions'].every(name => actual[name] === expected[name]);
}

async function waitForCounts(expected, ms = 3000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() <= deadline) {
    last = await health();
    if (sameCounts(counts(last), expected)) return last;
    await sleep(25);
  }
  throw new Error(
    `cleanup counts ${JSON.stringify(counts(last || {}))} did not return to ${JSON.stringify(expected)}`
  );
}

async function createStartedRoom(index, prefix = 'base') {
  const sourceAddress = loopbackSourceAddress(wsUrl, index);
  const host = new Client(sourceAddress, `${prefix}-${index}-host`);
  const guest = new Client(sourceAddress, `${prefix}-${index}-guest`);
  await Promise.all([host.hello, guest.hello]);

  const createdWait = host.wait('lobby', message => message.players.length === 1);
  host.send('create', { name: `H${index}`, mode: 'coop' });
  const created = await createdWait;

  const joinedWait = host.wait('lobby', message => message.players.length === 2);
  guest.send('join', { name: `G${index}`, code: created.code });
  await joinedWait;

  const readyWait = host.wait('lobby', message => message.players.every(player => player.ready));
  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  await readyWait;

  const hostStart = host.wait('start');
  const guestStart = guest.wait('start');
  host.send('start');
  await Promise.all([hostStart, guestStart]);
  return { sourceAddress, host, guest };
}

async function resumeClient(oldClient, sourceAddress, label, { terminateOld = true, staggerMs = 0 } = {}) {
  const identity = oldClient.id;
  const token = oldClient.token;
  const matchId = oldClient.matchId;
  if (!identity || !token || !matchId) throw new Error(`${oldClient.label}: missing resumable state`);

  if (terminateOld) oldClient.terminate();
  if (staggerMs > 0) await sleep(staggerMs);

  const next = new Client(sourceAddress, label);
  await next.hello;
  const resumedWait = next.wait('resumed');
  const startWait = next.wait('start', message => message.matchId === matchId);
  next.send('resume', { token });
  const [resumed] = await Promise.all([resumedWait, startWait]);
  if (resumed.id !== identity) {
    next.close();
    throw new Error(`${label}: identity changed ${identity} -> ${resumed.id}`);
  }
  return next;
}

function allClients(pairs) {
  return pairs.flatMap(pair => [pair.host, pair.guest]);
}

async function stateTraffic(pairs, ms = 600) {
  let z = -8;
  let direction = -1;
  const timer = setInterval(() => {
    z += direction * 0.35;
    const vz = direction * 7;
    for (const client of allClients(pairs)) client.sendState(z, vz);
    if (z < -18) direction = 1;
    else if (z > -8) direction = -1;
  }, 66);
  await sleep(ms);
  clearInterval(timer);
}

async function explicitCleanup(pairs) {
  for (const client of allClients(pairs)) client.leave();
  await sleep(25);
  for (const client of allClients(pairs)) client.close();
}

const initial = await health();
const baseline = counts(initial);
const sourceSharded = loopbackSourceAddress(wsUrl, 0) !== null;
const result = {
  config: {
    baseRooms: BASE_ROOMS,
    baseClients: BASE_ROOMS * 2,
    rapidCycles: RAPID_CYCLES,
    stormClients: STORM_CLIENTS,
    roomIterations: ROOM_ITERATIONS,
    churnBatch: CHURN_BATCH
  },
  targets: { wsUrl, httpUrl, sourceSharded },
  baseline,
  scenarios: {
    rapid: { cycles: RAPID_CYCLES, attempts: 0, succeeded: 0 },
    staleSocket: { cases: 0, passed: 0 },
    storm: { clients: STORM_CLIENTS, attempts: 0, succeeded: 0 },
    roomChurn: { iterations: ROOM_ITERATIONS, reclaimed: 0 }
  },
  observations: [],
  identityMismatches: 0,
  duplicatePlayerObservations: 0,
  roomCountMismatches: 0,
  failures: []
};

let basePairs = [];
let peakRooms = baseline.rooms;
let peakPlayers = baseline.players;
let peakSessions = baseline.sessions;
let peakEventLoopP95Ms = Number(initial.load?.eventLoopP95Ms || 0);
let peakRssMb = Number(initial.load?.rssMb || 0);

function observe(label, value) {
  const snapshot = compactHealth(value);
  result.observations.push({ label, ...snapshot });
  peakRooms = Math.max(peakRooms, Number(value.rooms || 0));
  peakPlayers = Math.max(peakPlayers, Number(value.players || 0));
  peakSessions = Math.max(peakSessions, Number(value.sessions || 0));
  peakEventLoopP95Ms = Math.max(peakEventLoopP95Ms, Number(value.load?.eventLoopP95Ms || 0));
  peakRssMb = Math.max(peakRssMb, Number(value.load?.rssMb || 0));
}

function requireBaseCounts(label, value) {
  const expected = {
    rooms: baseline.rooms + BASE_ROOMS,
    players: baseline.players + BASE_ROOMS * 2,
    sessions: baseline.sessions + BASE_ROOMS * 2
  };
  const actual = counts(value);
  if (!sameCounts(actual, expected)) {
    result.roomCountMismatches += 1;
    if (actual.players > expected.players) result.duplicatePlayerObservations += 1;
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log(`target ws:   ${wsUrl}`);
console.log(`target http: ${httpUrl}`);
if (sourceSharded) console.log('source IPs: loopback-sharded per room');
console.log(
  `churn plan: ${BASE_ROOMS} rooms / ${BASE_ROOMS * 2} clients, ${RAPID_CYCLES} rapid cycles, ` +
    `${STORM_CLIENTS}-client storm, ${ROOM_ITERATIONS} room iterations`
);

try {
  basePairs = await Promise.all(
    Array.from({ length: BASE_ROOMS }, (_, index) => createStartedRoom(index, 'base'))
  );
  await sleep(3200);
  let current = await health();
  observe('base-active', current);
  requireBaseCounts('base-active', current);

  console.log('\n=== Scenario 1: rapid disconnect/resume ===');
  for (let cycle = 0; cycle < RAPID_CYCLES; cycle++) {
    const selected = basePairs.map(pair => pair.host);
    for (const client of selected) client.terminate();
    await sleep(40);
    const replacements = await Promise.all(
      selected.map((client, index) => {
        result.scenarios.rapid.attempts += 1;
        return resumeClient(client, basePairs[index].sourceAddress, `rapid-${cycle}-${index}`, {
          terminateOld: false,
          staggerMs: index * 3
        }).then(next => {
          result.scenarios.rapid.succeeded += 1;
          return next;
        });
      })
    );
    replacements.forEach((next, index) => {
      basePairs[index].host = next;
    });
    await stateTraffic(basePairs, 500);
    current = await health();
    observe(`rapid-cycle-${cycle + 1}`, current);
    requireBaseCounts(`rapid-cycle-${cycle + 1}`, current);
  }

  console.log('\n=== Scenario 2: stale old socket closes after resume ===');
  const staleCases = Math.min(4, BASE_ROOMS);
  for (let index = 0; index < staleCases; index++) {
    const pair = basePairs[index];
    const old = pair.host;
    result.scenarios.staleSocket.cases += 1;
    const next = await resumeClient(old, pair.sourceAddress, `stale-${index}`, { terminateOld: false });
    pair.host = next;
    old.terminate();
    await sleep(60);

    const lobbyWait = pair.guest.wait('lobby', message => message.players.length === 2);
    next.send('presence', { away: false });
    const lobby = await lobbyWait;
    const resumedPlayer = lobby.players.find(player => player.id === next.id);
    if (!resumedPlayer?.online) {
      throw new Error(`stale-${index}: old socket close marked resumed player offline`);
    }
    result.scenarios.staleSocket.passed += 1;
  }
  await stateTraffic(basePairs, 500);
  current = await health();
  observe('stale-old-socket', current);
  requireBaseCounts('stale-old-socket', current);

  console.log('\n=== Scenario 3: reconnect storm ===');
  const stormEntries = allClients(basePairs)
    .slice(0, STORM_CLIENTS)
    .map(client => ({
      client,
      pair: basePairs.find(pair => pair.host === client || pair.guest === client),
      role: basePairs.find(pair => pair.host === client)?.host === client ? 'host' : 'guest'
    }));
  for (const entry of stormEntries) entry.client.terminate();
  await sleep(40);
  const stormReplacements = await Promise.all(
    stormEntries.map((entry, index) => {
      result.scenarios.storm.attempts += 1;
      return resumeClient(entry.client, entry.pair.sourceAddress, `storm-${index}`, {
        terminateOld: false,
        staggerMs: index * 5
      }).then(next => {
        result.scenarios.storm.succeeded += 1;
        return { ...entry, next };
      });
    })
  );
  for (const entry of stormReplacements) entry.pair[entry.role] = entry.next;
  await stateTraffic(basePairs, 700);
  current = await health();
  observe('reconnect-storm', current);
  requireBaseCounts('reconnect-storm', current);
  result.scenarios.storm.readiness = await readiness();

  console.log('\n=== Scenario 4: room churn ===');
  await explicitCleanup(basePairs);
  basePairs = [];
  current = await waitForCounts(baseline);
  observe('base-cleanup', current);

  for (let start = 0; start < ROOM_ITERATIONS; start += CHURN_BATCH) {
    const count = Math.min(CHURN_BATCH, ROOM_ITERATIONS - start);
    const batch = await Promise.all(
      Array.from({ length: count }, (_, offset) =>
        createStartedRoom(BASE_ROOMS + start + offset, `churn-${start + offset}`)
      )
    );
    current = await health();
    observe(`room-churn-batch-${Math.floor(start / CHURN_BATCH) + 1}-peak`, current);
    await explicitCleanup(batch);
    current = await waitForCounts(baseline);
    result.scenarios.roomChurn.reclaimed += count;
  }

  const final = await health();
  observe('final', final);
  result.final = compactHealth(final);
  result.readiness = await readiness();
  result.deltas = Object.fromEntries(
    [
      'invalidMessages',
      'socketSendFailures',
      'handlerErrors',
      'capacityRejected',
      'resumeSucceeded',
      'resumeFailed',
      'snapshotsSkippedForLoad',
      'verificationFailed',
      'latePacketsDropped'
    ].map(name => [name, metricDelta(initial, final, name)])
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  result.failures.push(message);
  console.error(`CHURN PROBE FAIL: ${message}`);
} finally {
  if (basePairs.length) {
    await explicitCleanup(basePairs).catch(() => {});
    basePairs = [];
  }
  try {
    const final = await waitForCounts(baseline);
    result.final = compactHealth(final);
    result.readiness = await readiness();
    result.deltas = Object.fromEntries(
      [
        'invalidMessages',
        'socketSendFailures',
        'handlerErrors',
        'capacityRejected',
        'resumeSucceeded',
        'resumeFailed',
        'snapshotsSkippedForLoad',
        'verificationFailed',
        'latePacketsDropped'
      ].map(name => [name, metricDelta(initial, final, name)])
    );
  } catch (cleanupError) {
    result.failures.push(
      `final cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
    );
  }

  result.peaks = { peakRooms, peakPlayers, peakSessions, peakEventLoopP95Ms, peakRssMb };
  result.resumeAttempts = result.scenarios.rapid.attempts + result.scenarios.storm.attempts + result.scenarios.staleSocket.cases;
  result.resumeSucceededObserved =
    result.scenarios.rapid.succeeded + result.scenarios.storm.succeeded + result.scenarios.staleSocket.passed;
  result.resumeSuccessRate = result.resumeAttempts
    ? result.resumeSucceededObserved / result.resumeAttempts
    : 0;

  if (RESULT_PATH) await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log('\n--- RECONNECT / CHURN PROBE ---');
  console.log(`resume attempts:       ${result.resumeAttempts}`);
  console.log(`resume succeeded:      ${result.resumeSucceededObserved}`);
  console.log(`resume success rate:   ${(result.resumeSuccessRate * 100).toFixed(1)}%`);
  console.log(`stale socket cases:    ${result.scenarios.staleSocket.passed}/${result.scenarios.staleSocket.cases}`);
  console.log(`storm clients:         ${result.scenarios.storm.succeeded}/${result.scenarios.storm.clients}`);
  console.log(`rooms reclaimed:       ${result.scenarios.roomChurn.reclaimed}/${ROOM_ITERATIONS}`);
  console.log(`peak sessions:         ${result.peaks.peakSessions}`);
  console.log(`event-loop p95 max:    ${result.peaks.peakEventLoopP95Ms} ms`);
  console.log(`RSS max:               ${result.peaks.peakRssMb} MB`);
  console.log(`ready after cleanup:   ${result.readiness?.ok ? 'yes' : 'no'}`);
  if (result.failures.length) {
    for (const failure of result.failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
  }
}
