const crypto=require('crypto');

const DIFFICULTIES={easy:{segments:5},normal:{segments:6},chaos:{segments:7}};
const PLAYER_COLORS=[0xff4f91,0x48dcda,0xffd94b,0x55a7ff,0x58ebb8,0xff914d,0x9b6cff,0xf46b5f,0x43c5ff,0xc7ef50,0xff73c8,0x7d82ff,0x54dba2,0xffbd59,0x9867dc,0x58c9d8];

function safeName(value){return String(value||'Wobbler').normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu,'').replace(/\s+/g,' ').trim().slice(0,16)||'Wobbler'}
function safeDifficulty(value){return Object.hasOwn(DIFFICULTIES,value)?value:'normal'}
function randomSeed(){return crypto.randomBytes(4).readUInt32LE(0)}
function createCourseSpec(seed=randomSeed(),difficulty='normal'){const key=safeDifficulty(difficulty),segmentCount=DIFFICULTIES[key].segments;return{seed:seed>>>0,difficulty:key,segmentCount,checkpoints:Array.from({length:segmentCount},(_,i)=>-18*(i+1)),finishZ:-18*segmentCount-13,start:{x:0,y:1.2,z:7}}}
function spawnFor(spec,checkpoint=0){if(checkpoint<=0)return{...spec.start};const index=Math.min(checkpoint-1,spec.checkpoints.length-1);return{x:0,y:1.15,z:spec.checkpoints[index]+3.1}}
function normalizeState(value){const n=value||{};if(![n.x,n.y,n.z,n.ry,n.vx,n.vz].every(Number.isFinite))return null;return{x:+n.x,y:+n.y,z:+n.z,ry:+n.ry,vx:+n.vx,vz:+n.vz,state:['ground','air','dive'].includes(n.state)?n.state:'air'}}
function validateState(player,value,spec,now=Date.now()){
  const state=normalizeState(value);if(!state)return{ok:false,reason:'invalid'};if(Math.abs(state.x)>24||state.y>35||state.y<-16||state.z>18||state.z<spec.finishZ-18)return{ok:false,reason:'bounds'};
  const previous=player.last||spawnFor(spec,player.checkpoint||0),dt=Math.max(.04,Math.min(1.5,(now-(player.lastAt||now-100))/1000)),distance=Math.hypot(state.x-previous.x,state.y-previous.y,state.z-previous.z),maxDistance=3.2+dt*18;if(distance>maxDistance)return{ok:false,reason:'speed',position:previous};
  let checkpoint=player.checkpoint||0;while(checkpoint<spec.checkpoints.length&&state.z<spec.checkpoints[checkpoint]&&state.y>-3&&Math.abs(state.x)<11)checkpoint++;
  return{ok:true,state:{...state,checkpoint},checkpoint};
}
function canFinish(player,spec){return !player.finished&&player.checkpoint===spec.segmentCount&&player.last&&player.last.z<spec.finishZ+1&&player.last.y>-4}
function leaderboard(room){return[...room.players.values()].filter(player=>player.finished).sort((a,b)=>a.time-b.time).map(({id,name,time,color})=>({id,name,time,color}))}

module.exports={DIFFICULTIES,PLAYER_COLORS,safeName,safeDifficulty,randomSeed,createCourseSpec,spawnFor,normalizeState,validateState,canFinish,leaderboard};
