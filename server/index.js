const express=require('express');
const http=require('http');
const path=require('path');
const crypto=require('crypto');
const {WebSocketServer,WebSocket}=require('ws');
const {PLAYER_COLORS,safeName,safeDifficulty,randomSeed,createCourseSpec,spawnFor,validateState,canFinish,leaderboard}=require('./gameRules');

const app=express();
const clientPath=path.join(__dirname,'..','client');
app.disable('x-powered-by');
app.use(express.static(clientPath,{setHeaders:(res,file)=>{if(/\.(js|css)$/.test(file))res.setHeader('Cache-Control','public, max-age=300');res.setHeader('X-Content-Type-Options','nosniff')}}));
app.use('/vendor',express.static(path.join(__dirname,'..','node_modules','three','build'),{maxAge:'1d',immutable:true}));
const rooms=new Map();
app.get('/health',(_req,res)=>res.json({ok:true,service:'wobble-rush-3d',rooms:rooms.size,version:'2.0.0'}));
app.get('*',(_req,res)=>res.sendFile(path.join(clientPath,'index.html')));

const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws',maxPayload:4096,perMessageDeflate:false});
const MAX_PLAYERS=16,MAX_ROOMS=500,ROOM_TTL=45*60*1000;
const send=(ws,data)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data))};
const broadcast=(room,data)=>{for(const player of room.players.values())send(player.ws,data)};
const roomCode=()=>{let value;do value=crypto.randomBytes(3).toString('base64url').replace(/[^A-Z0-9]/gi,'').slice(0,4).toUpperCase().padEnd(4,'X');while(rooms.has(value));return value};
const publicPlayer=({id,name,ready,finished,time,rematch,color})=>({id,name,ready:!!ready,finished:!!finished,time:time??null,rematch:!!rematch,color});
const lobbyPayload=room=>({type:'lobby',code:room.code,host:room.host,started:room.started,seed:room.spec.seed,difficulty:room.spec.difficulty,players:[...room.players.values()].map(publicPlayer)});
const emitLobby=room=>broadcast(room,lobbyPayload(room));
function resetLobby(room,{newSeed=false}={}){room.started=false;room.startedAt=null;room.updatedAt=Date.now();if(newSeed)room.spec=createCourseSpec(randomSeed(),room.spec.difficulty);for(const player of room.players.values())Object.assign(player,{ready:false,finished:false,time:null,rematch:false,checkpoint:0,last:null,lastAt:0,returned:false});emitLobby(room)}
function leave(ws){if(!ws.room)return;const room=rooms.get(ws.room);ws.room=null;if(!room)return;room.players.delete(ws.id);room.updatedAt=Date.now();if(!room.players.size)rooms.delete(room.code);else{if(room.host===ws.id)room.host=room.players.keys().next().value;emitLobby(room)}}
function addPlayer(room,ws,name){ws.room=room.code;const color=PLAYER_COLORS[room.players.size%PLAYER_COLORS.length];room.players.set(ws.id,{id:ws.id,name:safeName(name),color,ready:false,finished:false,time:null,rematch:false,checkpoint:0,last:null,lastAt:0,ws});room.updatedAt=Date.now();emitLobby(room)}

wss.on('connection',ws=>{
  ws.id=crypto.randomBytes(8).toString('hex');ws.isAlive=true;send(ws,{type:'hello',id:ws.id,serverTime:Date.now()});ws.on('pong',()=>{ws.isAlive=true});
  ws.on('message',raw=>{let message;try{message=JSON.parse(raw.toString())}catch{return send(ws,{type:'error',message:'Malformed multiplayer message.'})}if(!message||typeof message.type!=='string')return;
    if(message.type==='ping')return send(ws,{type:'pong',at:message.at,serverTime:Date.now()});
    if(message.type==='leave')return leave(ws);
    if(message.type==='create'){leave(ws);if(rooms.size>=MAX_ROOMS)return send(ws,{type:'error',message:'The party service is full. Try again soon.'});const code=roomCode(),spec=createCourseSpec(randomSeed(),safeDifficulty(message.difficulty)),room={code,host:ws.id,started:false,startedAt:null,spec,players:new Map(),createdAt:Date.now(),updatedAt:Date.now()};rooms.set(code,room);return addPlayer(room,ws,message.name)}
    if(message.type==='join'){leave(ws);const room=rooms.get(String(message.code||'').trim().toUpperCase());if(!room)return send(ws,{type:'error',message:'Room not found. Check the four-letter code.'});if(room.started)return send(ws,{type:'error',message:'That race has already started.'});if(room.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'That party is full (16 players).'});return addPlayer(room,ws,message.name)}
    const room=rooms.get(ws.room),player=room?.players.get(ws.id);if(!room||!player)return send(ws,{type:'error',message:'Create or join a room first.'});room.updatedAt=Date.now();
    if(message.type==='ready'&&!room.started){player.ready=!!message.ready;return emitLobby(room)}
    if(message.type==='configure'&&!room.started&&room.host===ws.id){room.spec=createCourseSpec(randomSeed(),safeDifficulty(message.difficulty));for(const item of room.players.values())item.ready=false;return emitLobby(room)}
    if(message.type==='start'){if(room.host!==ws.id)return send(ws,{type:'error',message:'Only the host can start the race.'});if(room.started)return;if(!room.players.size||![...room.players.values()].every(item=>item.ready))return send(ws,{type:'error',message:'Every runner must be ready.'});room.started=true;room.startedAt=Date.now()+2800;for(const item of room.players.values())Object.assign(item,{finished:false,time:null,checkpoint:0,last:{...room.spec.start,ry:0,vx:0,vz:0,state:'ground',checkpoint:0},lastAt:room.startedAt,rematch:false,returned:false});return broadcast(room,{type:'start',at:room.startedAt,spec:room.spec})}
    if(message.type==='state'&&room.started&&Date.now()>=room.startedAt-300){const now=Date.now();if(now-(player.receivedAt||0)<32)return;player.receivedAt=now;const result=validateState(player,message.state,room.spec,now);if(!result.ok){if(result.reason==='speed')send(ws,{type:'correction',position:result.position,reason:'movement'});return}player.last={...result.state,id:player.id};player.lastAt=now;player.checkpoint=result.checkpoint;return}
    if(message.type==='respawn'&&room.started){const now=Date.now();if(now-(player.lastRespawn||0)<450)return;player.lastRespawn=now;const position=spawnFor(room.spec,player.checkpoint);player.last={...position,ry:0,vx:0,vz:0,state:'air',checkpoint:player.checkpoint,id:player.id};player.lastAt=now;return send(ws,{type:'correction',position,reason:'respawn'})}
    if(message.type==='finish'&&room.started){if(!canFinish(player,room.spec))return send(ws,{type:'correction',position:player.last||spawnFor(room.spec,player.checkpoint),reason:'finish-validation'});player.finished=true;player.time=Math.max(0,Date.now()-room.startedAt);const board=leaderboard(room);return broadcast(room,{type:'finish',id:player.id,time:player.time,board})}
    if(message.type==='rematch'&&room.started){player.rematch=true;if(room.host===player.id||[...room.players.values()].every(item=>item.rematch))return resetLobby(room);return emitLobby(room)}
    if(message.type==='returnLobby'&&room.started){player.returned=true;if(room.host===player.id||[...room.players.values()].every(item=>item.finished||item.returned))return resetLobby(room);return send(ws,lobbyPayload(room))}
  });
  ws.on('close',()=>leave(ws));ws.on('error',()=>leave(ws));
});

const snapshotTimer=setInterval(()=>{for(const room of rooms.values()){if(!room.started)continue;const players=[...room.players.values()].filter(player=>player.last).map(player=>({...player.last,id:player.id,checkpoint:player.checkpoint,finished:player.finished}));broadcast(room,{type:'snapshot',serverTime:Date.now(),players,finished:leaderboard(room)})}},66);snapshotTimer.unref();
const heartbeatTimer=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue}ws.isAlive=false;ws.ping()}const now=Date.now();for(const [code,room] of rooms)if(now-room.updatedAt>ROOM_TTL)rooms.delete(code)},30000);heartbeatTimer.unref();

const port=process.env.PORT||3000;
if(require.main===module)server.listen(port,()=>console.log(`Wobble Rush 3D v2 on http://localhost:${port}`));
module.exports={app,server,rooms,leave,resetLobby};
