import { chapterLayout, getChapter } from './coopChapters.js';

export const CORE_FLOOR_Y = 1.05;
export const CORE_INSERT_RADIUS = 2.2;
export const SIGNATURE_INTERACT_RADIUS = 2.8;

export function deterministicSignalSequence(id, symbols, length = Math.max(3, symbols.length)) {
  let hash = 2166136261;
  for (const char of String(id || 'signal')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const result = [];
  for (let index = 0; index < Math.max(1, length); index++) {
    hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0;
    result.push(symbols[hash % symbols.length]);
  }
  return result;
}

export function signalRoles(actorIds = []) {
  const [guide = null, operator = null] = [...actorIds].filter(Boolean).sort();
  return { guide, operator };
}

function firstSplit(chapterId) {
  return chapterLayout(chapterId).pieces.find(piece => piece.kind === 'splitSpan') || null;
}

function laneY(split, side) {
  return side === 'left' ? split.leftY || 0 : split.rightY || 0;
}

export function signatureLayout(chapterId) {
  const chapter = getChapter(chapterId);
  const split = firstSplit(chapter.id);
  const mechanics = chapter.mechanics || {};
  const result = { chapterId: chapter.id, core: null, signal: null };
  if (!split) return result;

  if (mechanics.energyCore) {
    const gateId = chapter.id === 'ch7' ? 'relay2' : chapter.id === 'ch10' ? 'finalRelay' : null;
    if (gateId) {
      result.core = {
        id: `${chapter.id}-core`,
        gateId,
        pickupRadius: mechanics.energyCore.pickupRadius || 2.2,
        throwSpeed: mechanics.energyCore.throwSpeed || 11,
        insertRadius: CORE_INSERT_RADIUS,
        spawn: {
          x: -3.7,
          y: laneY(split, 'left') + CORE_FLOOR_Y,
          z: split.z + split.length / 2 - 4.2
        },
        socket: {
          id: `${chapter.id}-socket`,
          x: 3.7,
          y: laneY(split, 'right') + CORE_FLOOR_Y,
          z: split.z - split.length / 2 + 4.2
        }
      };
    }
  }

  if (mechanics.asymmetricSignals) {
    const symbols = [...mechanics.asymmetricSignals.symbols];
    const id = `${chapter.id}-console`;
    result.signal = {
      id,
      gateId: chapter.id === 'ch9' ? 'verticalGate' : null,
      symbols,
      sequence: deterministicSignalSequence(
        id,
        symbols,
        mechanics.asymmetricSignals.sequenceLength || symbols.length
      ),
      guide: {
        x: -3.7,
        y: laneY(split, 'left') + 1.15,
        z: split.z + 4.5
      },
      operator: {
        x: 3.7,
        y: laneY(split, 'right') + 1.15,
        z: split.z - 4.5
      }
    };
  }

  return result;
}
