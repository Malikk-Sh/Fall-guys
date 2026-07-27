const test=require('node:test');
const assert=require('node:assert/strict');
const WebSocket=require('ws');
const {server}=require('./index');

class TestClient{
  constructor(url){this.messages=[];this.waiters=[];this.ws=new WebSocket(url);this.ws.on('message',raw=>{const message=JSON.parse(raw);this.messages.push(message);for(const waiter of [...this.waiters])if(waiter.match(message)){this.waiters.splice(this.waiters.indexOf(waiter),1);waiter.resolve(message)}})}
  wait(type,predicate=()=>true,timeout=2500){const existing=this.messages.find(message=>message.type===type&&predicate(message));if(existing)return Promise.resolve(existing);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${type}`)),timeout);this.waiters.push({match:message=>{if(message.type!==type||!predicate(message))return false;clearTimeout(timer);return true},resolve})})}
  send(type,data={}){this.ws.send(JSON.stringify({type,...data}))}
  close(){return new Promise(resolve=>{if(this.ws.readyState===WebSocket.CLOSED)return resolve();const timer=setTimeout(()=>{this.ws.terminate();resolve()},500);this.ws.once('close',()=>{clearTimeout(timer);resolve()});this.ws.close()})}
}

test('two players share lobby configuration and deterministic start spec',async t=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`ws://127.0.0.1:${server.address().port}/ws`,host=new TestClient(url),guest=new TestClient(url);t.after(async()=>{await Promise.all([host.close(),guest.close()]);await new Promise(resolve=>server.close(resolve))});await Promise.all([host.wait('hello'),guest.wait('hello')]);
  host.send('create',{name:'Host',difficulty:'easy'});const created=await host.wait('lobby',message=>message.players.length===1);assert.equal(created.difficulty,'easy');guest.send('join',{name:'Guest',code:created.code});await Promise.all([host.wait('lobby',message=>message.players.length===2),guest.wait('lobby',message=>message.players.length===2)]);
  host.send('configure',{difficulty:'chaos'});const configured=await host.wait('lobby',message=>message.difficulty==='chaos');assert.equal(configured.players.every(player=>!player.ready),true);host.send('ready',{ready:true});guest.send('ready',{ready:true});await host.wait('lobby',message=>message.players.length===2&&message.players.every(player=>player.ready));host.send('start');const [hostStart,guestStart]=await Promise.all([host.wait('start'),guest.wait('start')]);assert.deepEqual(hostStart.spec,guestStart.spec);assert.equal(hostStart.spec.segmentCount,7);assert.ok(hostStart.at>Date.now());
});
