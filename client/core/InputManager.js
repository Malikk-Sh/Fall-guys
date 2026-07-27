export class InputManager{
  constructor(canvas,root=document){
    this.canvas=canvas;this.root=root;this.keys=new Set();this.moveX=0;this.moveForward=0;this.jumpQueued=false;this.diveQueued=false;this.recenterQueued=false;this.cameraX=0;this.cameraY=0;this.touchCapable=matchMedia('(pointer:coarse)').matches||navigator.maxTouchPoints>0;this.activeMethod=this.touchCapable?'touch':'keyboard';this.enabled=false;
    this.onKeyDown=e=>{if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)&&this.enabled)e.preventDefault();this.keys.add(e.code);if(!e.repeat&&e.code==='Space')this.jumpQueued=true;if(!e.repeat&&(e.code==='ShiftLeft'||e.code==='ShiftRight'))this.diveQueued=true;if(e.code==='KeyR')this.recenterQueued=true;this.setMethod('keyboard')};
    this.onKeyUp=e=>this.keys.delete(e.code);addEventListener('keydown',this.onKeyDown,{passive:false});addEventListener('keyup',this.onKeyUp);
    this.setupPointers();
  }
  setMethod(method){if(this.activeMethod===method)return;this.activeMethod=method;document.body.dataset.input=method;dispatchEvent(new CustomEvent('inputmethodchange',{detail:method}))}
  setupPointers(){
    const stick=this.root.querySelector('#stick'),nub=stick.querySelector('i'),jump=this.root.querySelector('#jump'),dive=this.root.querySelector('#dive'),recenter=this.root.querySelector('#recenter');let stickId=null,lookId=null,lastX=0,lastY=0;
    const moveStick=e=>{if(e.pointerId!==stickId)return;const r=stick.getBoundingClientRect(),dx=e.clientX-(r.left+r.width/2),dy=e.clientY-(r.top+r.height/2),radius=r.width*.34,length=Math.hypot(dx,dy)||1,scale=Math.min(1,radius/length);this.moveX=dx*scale/radius;this.moveForward=-dy*scale/radius;nub.style.transform=`translate(${dx*scale}px,${dy*scale}px)`};
    const endStick=e=>{if(e.pointerId!==stickId)return;stickId=null;this.moveX=this.moveForward=0;nub.style.transform='';stick.classList.remove('active')};
    stick.addEventListener('pointerdown',e=>{if(!this.enabled)return;e.preventDefault();this.setMethod('touch');stickId=e.pointerId;stick.setPointerCapture?.(e.pointerId);stick.classList.add('active');moveStick(e)});
    stick.addEventListener('pointermove',moveStick);stick.addEventListener('pointerup',endStick);stick.addEventListener('pointercancel',endStick);
    const action=(element,key)=>{element.addEventListener('pointerdown',e=>{if(!this.enabled)return;e.preventDefault();this.setMethod(e.pointerType==='touch'?'touch':'keyboard');this[key]=true;element.classList.add('pressed')});const release=()=>element.classList.remove('pressed');element.addEventListener('pointerup',release);element.addEventListener('pointercancel',release)};
    action(jump,'jumpQueued');action(dive,'diveQueued');action(recenter,'recenterQueued');
    this.canvas.addEventListener('contextmenu',e=>e.preventDefault());
    this.canvas.addEventListener('pointerdown',e=>{if(!this.enabled)return;if(e.pointerType==='touch'&&e.clientX<innerWidth*.34)return;if(e.pointerType==='mouse'&&e.button!==0&&e.button!==2)return;lookId=e.pointerId;lastX=e.clientX;lastY=e.clientY;this.canvas.setPointerCapture?.(e.pointerId);this.setMethod(e.pointerType==='touch'?'touch':'keyboard');document.querySelector('#lookHint')?.classList.add('hidden')});
    this.canvas.addEventListener('pointermove',e=>{if(e.pointerId!==lookId)return;this.cameraX+=e.clientX-lastX;this.cameraY+=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY});
    const endLook=e=>{if(e.pointerId===lookId)lookId=null};this.canvas.addEventListener('pointerup',endLook);this.canvas.addEventListener('pointercancel',endLook);
  }
  update(){if(this.activeMethod!=='touch'){this.moveX=(this.keys.has('KeyD')||this.keys.has('ArrowRight')?1:0)-(this.keys.has('KeyA')||this.keys.has('ArrowLeft')?1:0);this.moveForward=(this.keys.has('KeyW')||this.keys.has('ArrowUp')?1:0)-(this.keys.has('KeyS')||this.keys.has('ArrowDown')?1:0)}if(this.keys.has('KeyQ'))this.cameraX-=2.6;if(this.keys.has('KeyE'))this.cameraX+=2.6}
  movement(){const length=Math.hypot(this.moveX,this.moveForward);return{x:length>1?this.moveX/length:this.moveX,forward:length>1?this.moveForward/length:this.moveForward,magnitude:Math.min(1,length)}}
  consume(action){const key=`${action}Queued`,value=!!this[key];this[key]=false;return value}
  consumeCamera(){const result={x:this.cameraX,y:this.cameraY};this.cameraX=this.cameraY=0;return result}
  reset(){this.moveX=this.moveForward=this.cameraX=this.cameraY=0;this.jumpQueued=this.diveQueued=this.recenterQueued=false;this.keys.clear()}
}
