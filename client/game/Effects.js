import * as THREE from '/vendor/three.module.js';

export class Effects{
  constructor(scene,quality='high'){
    this.scene=scene;this.quality=quality;this.items=[];this.pool=[];this.max=quality==='low'?34:72;this.geometry=new THREE.IcosahedronGeometry(.085,0);this.materials=new Map();
  }
  material(color){if(!this.materials.has(color))this.materials.set(color,new THREE.MeshBasicMaterial({color,transparent:true}));return this.materials.get(color)}
  burst(position,color=0xffffff,count=10,power=1){const total=Math.min(count,this.max-this.items.length);for(let i=0;i<total;i++){const mesh=this.pool.pop()||new THREE.Mesh(this.geometry,this.material(color));mesh.material=this.material(color);mesh.material.opacity=1;mesh.visible=true;mesh.position.copy(position);mesh.scale.setScalar(.7+Math.random()*.7);mesh.userData.velocity=new THREE.Vector3((Math.random()-.5)*4.8,1.2+Math.random()*3.7,(Math.random()-.5)*4.8).multiplyScalar(power);mesh.userData.life=.48+Math.random()*.32;mesh.userData.maxLife=mesh.userData.life;this.scene.add(mesh);this.items.push(mesh)}}
  trail(position,color=0xffd94b){if(this.items.length>=this.max)return;this.burst(position,color,1,.35)}
  update(dt){for(let i=this.items.length-1;i>=0;i--){const mesh=this.items[i];mesh.userData.life-=dt;if(mesh.userData.life<=0){mesh.visible=false;this.scene.remove(mesh);this.items.splice(i,1);this.pool.push(mesh);continue}mesh.position.addScaledVector(mesh.userData.velocity,dt);mesh.userData.velocity.y-=8*dt;const t=mesh.userData.life/mesh.userData.maxLife;mesh.scale.multiplyScalar(.96);mesh.material.opacity=Math.max(.05,t)}}
  clear(){for(const mesh of this.items)this.scene.remove(mesh);this.pool.push(...this.items);this.items.length=0}
}
