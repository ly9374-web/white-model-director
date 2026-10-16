import assert from 'node:assert/strict';
import * as T from '../white-model/three.module.js';
import {VolumeCollision,validateAnimation} from '../white-model/collision.js';
const material=new T.MeshBasicMaterial();
const box=(w,h,d,x=0,y=0,z=0)=>{const node=new T.Mesh(new T.BoxGeometry(w,h,d),material);node.position.set(x,y,z);return node;};
const world=(objects,environment=[])=>{const scene=new T.Scene();for(const node of new Set([...Object.values(objects),...environment]))scene.add(node);return {THREE:T,scene,actors:{},objects,hands:{},environmentGroups:environment,duration:1,evaluate(){scene.updateMatrixWorld(true);}};};
const checks=[];
{
 const a=box(.08,1,3),b=box(.08,1,3,.4,0,-.4);a.rotation.y=b.rotation.y=Math.PI/4;
 const detector=new VolumeCollision(world({A:a,B:b}));
 const volumes=detector.volumes();assert(volumes[0].max.x>volumes[1].min.x);assert.equal(detector.contacts().length,0);
 b.position.set(.01,0,-.01);assert(detector.contacts().length>0);
 checks.push('rotated boxes use SAT rather than AABB overlap');
}
{
 const container=new T.Group();container.add(box(.1,2,2,-1),box(.1,2,2,1),box(2,.1,2,0,-1),box(2,2,.1,0,0,-1));
 const item=box(.2,.2,.2);const detector=new VolumeCollision(world({container,item}));assert.equal(detector.contacts().length,0);
 item.position.x=.99;assert(detector.contacts().length>0);checks.push('compound volumes preserve hollow interiors');
}
{
 const floor=box(4,.1,4,0,-.05),item=box(1,1,1,0,.5);const detector=new VolumeCollision(world({item},[floor]));
 assert.equal(detector.contacts().length,0);item.position.y=.49;assert(detector.contacts().length>0);checks.push('surface contact allowed, floor penetration rejected');
}
{
 const body=new T.Group(),torso=box(1,1,1),left=new T.Group(),right=new T.Group();left.position.x=-1;right.position.x=1;left.add(box(.5,.5,.5));right.add(box(.5,.5,.5));body.add(torso,left,right);
 const w=world({});w.scene.add(body);w.actors={P01:{root:body,torso,eL:left,eR:right}};const detector=new VolumeCollision(w);
 assert.equal(detector.contacts().length,0);right.position.x=0;assert(detector.contacts().some(c=>c.a==='P01'&&c.b==='P01'));checks.push('non-adjacent body parts cannot pass through the torso');
}
{
 const mover=box(.05,.05,.05,-1),wall=box(.004,2,2);const detector=new VolumeCollision(world({mover,wall}));
 const result=detector.sweep({apply:t=>{mover.position.x=-1+2*t;},distance:2,focus:new Set(['mover'])});
 assert(result.blocked&&result.fraction>.4&&result.fraction<.5);assert.equal(detector.contacts().length,0);checks.push('swept translation stops before a thin wall even if the destination is clear');
 const w=world({mover,wall});w.evaluate=t=>{mover.position.x=-1+2*t;};const audit=await validateAnimation(w,{fps:1});
 assert.equal(audit.ok,false);assert(audit.time>.4&&audit.time<.6);checks.push('animation gate detects collisions between recording frames');
}
{
 const a=box(.1,.1,.1,-1),b=box(.1,.1,.1,1);const w=world({a,b});w.evaluate=t=>{a.position.z=t;};
 const report=await validateAnimation(w,{fps:3});assert(report.ok&&report.samples>=13);checks.push('collision-free animation passes the encoding gate');
}
{
 const mover=box(.2,.2,.2),wall=box(.2,2,2,.1);const detector=new VolumeCollision(world({mover,wall}));
 const start=detector.contacts()[0].depth;
 const repair=detector.sweep({apply:t=>{mover.position.x=-t;},distance:1,focus:new Set(['mover'])});assert(!repair.blocked);assert.equal(detector.contacts().length,0);
 const worsen=detector.sweep({apply:t=>{mover.position.x=.08*t;},distance:.08,focus:new Set(['mover'])});assert(worsen.blocked);assert(detector.contacts()[0].depth<=start+1e-5);checks.push('legacy overlap can be repaired but cannot grow');
}
console.log(JSON.stringify({checks,errors:[]}));
