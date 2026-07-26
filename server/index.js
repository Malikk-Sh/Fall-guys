const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'index.html')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();
const safeName = value => String(value || 'Wobbler').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 16) || 'Wobbler';
const code = () => { let c; do c = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(c)); return c; };
const send = (ws, data) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data));
const broadcast = (room, data) => room.players.forEach(p => send(p.ws, data));
const lobby = room => broadcast(room, { type:'lobby', code:room.code, host:room.host, started:room.started, players:[...room.players.values()].map(({id,name,ready,finished,time})=>({id,name,ready,finished,time})) });
function leave(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room); if (!room) return;
  room.players.delete(ws.id);
  if (!room.players.size) rooms.delete(room.code);
  else { if (room.host === ws.id) room.host = room.players.keys().next().value; lobby(room); }
}
wss.on('connection', ws => {
  ws.id = Math.random().toString(36).slice(2,10);
  send(ws,{type:'hello',id:ws.id});
  ws.on('message', raw => { let m; try { m=JSON.parse(raw); } catch { return; }
    if (m.type==='create') { leave(ws); const c=code(), room={code:c,host:ws.id,started:false,players:new Map()}; rooms.set(c,room); ws.room=c; room.players.set(ws.id,{id:ws.id,name:safeName(m.name),ready:false,ws}); lobby(room); }
    if (m.type==='join') { leave(ws); const room=rooms.get(String(m.code||'').toUpperCase()); if(!room) return send(ws,{type:'error',message:'Room not found.'}); if(room.started||room.players.size>=16) return send(ws,{type:'error',message:'Room is busy or full.'}); ws.room=room.code; room.players.set(ws.id,{id:ws.id,name:safeName(m.name),ready:false,ws}); lobby(room); }
    const room=rooms.get(ws.room), p=room?.players.get(ws.id); if(!room||!p) return;
    if(m.type==='ready'){p.ready=!!m.ready;lobby(room);}
    if(m.type==='start'&&room.host===ws.id&&[...room.players.values()].every(x=>x.ready)){room.started=true; room.startedAt=Date.now()+1500; broadcast(room,{type:'start',at:room.startedAt});}
    if(m.type==='state'&&room.started){ const n=m.state||{}; if([n.x,n.y,n.z,n.ry].every(Number.isFinite)){const now=Date.now(), elapsed=Math.max(.05,(now-(p.lastAt||now-100))/1000),dist=p.last?Math.hypot(n.x-p.last.x,n.y-p.last.y,n.z-p.last.z):0;if(dist<Math.max(5,elapsed*18)){p.last={x:n.x,y:n.y,z:n.z};p.lastAt=now;const marks=[8,-16,-42,-69];while((p.checkpoint||0)<4&&n.z<marks[p.checkpoint||0])p.checkpoint=(p.checkpoint||0)+1;broadcast(room,{type:'state',id:ws.id,state:{x:n.x,y:n.y,z:n.z,ry:n.ry,checkpoint:p.checkpoint||0}})}} }
    if(m.type==='finish'&&!p.finished&&p.checkpoint===4&&p.last?.z<-85){p.finished=true;p.time=Math.max(0,Date.now()-room.startedAt); const board=[...room.players.values()].filter(x=>x.finished).sort((a,b)=>a.time-b.time).map(x=>({id:x.id,name:x.name,time:x.time})); broadcast(room,{type:'finish',id:ws.id,board});}
    if(m.type==='rematch'&&room.host===ws.id){room.started=false;room.players.forEach(x=>{x.finished=false;x.time=null;x.ready=false;x.checkpoint=0;x.last=null});lobby(room);}
  });
  ws.on('close',()=>leave(ws));
});
const port=process.env.PORT||3000;
if(require.main===module) server.listen(port,()=>console.log(`Wobble Rush 3D on http://localhost:${port}`));
module.exports={server,safeName};
