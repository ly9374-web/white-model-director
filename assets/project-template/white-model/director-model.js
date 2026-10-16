import { PROJECT } from './project-runtime.js';
import { VolumeCollision } from './collision.js';
import { ACTORS, PROPS, PARTS, FPS, SCHEMA, sceneAt } from './director-catalog.js';
const copy = v => structuredClone(v);
const empty = () => ({transforms:{},free:{},bindings:{},note:''});
export class DirectorModel {
  constructor(world, {liveCollision=true}={}) {
    this.world=world; this.T=world.THREE; this.registry=new Map(); this.drafts=new Map();
    this.liveCollision=liveCollision;
    this.time=0; this.frame=0; this.edits=empty(); this.undoStack=[]; this.redoStack=[]; this.reference={}; this.bindings={};
    this.overrides={}; this.staticCache=new Map(); this.components={}; this.deletedObjects=new Set();
    // 观察用定位身体：仅当存在主角身体 P01 时创建，无人/动物/车辆故事不凭空强套人形骨架。
    const originalP01=world.actors.P01;
    this.proxy=originalP01?world.makeFigure(originalP01.headBall.material):null;
    // Observer representation is separate from the original first-person actor.
    const actors=this.proxy?{...world.actors,P01:this.proxy}:{...world.actors}; this.actors=actors;
    if(this.proxy)this.proxy.root.userData.editorProxy=true;
    const add=(id,node,label,kind,actorId=null)=>{
      const item={id,node,label,kind,actorId};node.userData.directorId=id;this.registry.set(id,item);return item;
    };
    for(const [id,f] of Object.entries(actors)) {
      add(id,f.root,`${id} · ${ACTORS[id]||'角色'}`,'actor',id);
      for(const [key,label] of Object.entries(PARTS)) add(`${id}/${key}`,f[key],label,'joint',id);
      add(`${id}/leftPalm`,f.eL.children[1],'左手掌','joint',id);
      add(`${id}/rightPalm`,f.eR.children[1],'右手掌','joint',id);
      for(const side of ['left','right']) {
        const node=new this.T.Object3D(); f.root.add(node);
        const item=add(`${id}/${side}Hand`,node,side==='left'?'左手目标（拖动摆姿势）':'右手目标（拖动摆姿势）','ik',id);
        item.side=side;
      }
    }
    for(const [id,node] of Object.entries(world.objects))add(id,node,`${id} · ${PROPS[id]||'物体'}`,'prop');
    for(const [id,h] of Object.entries(world.hands))add(id,h.root,`${id} · ${id==='H01'?'独立前景左手':'独立前景右手'}`,'hand');
    world.scene.add(world.camera);add('C01',world.camera,'C01 · 剧情镜头（独立编辑）','camera');
    this.structural=new Map([...this.registry].map(([id,e])=>[id,this.local(e.node)]));
    this.collisions=new VolumeCollision(world,{actors:this.actors,visibility:node=>this.reference[node.userData.directorId]?.visible??node.visible,components:()=>Object.fromEntries(Object.entries(this.components||{}).map(([id,c])=>[id,{...c,node:this.registry.get(id)?.node}]))});
    this.collisionMessage='';this.collisionPose=null;
    this.ceilings=[];this.walls=[];
    const wallMaterial=world.objects.O01?.children?.[0]?.material;
    for(const group of world.environmentGroups)group.traverse(node=>{
      const p=node.geometry?.parameters;if(!p)return;
      const box=new this.T.Box3().setFromObject(node),size=box.getSize(new this.T.Vector3());
      if(box.min.y>2.65 && size.y<.3 && (size.x>2||size.z>2))this.ceilings.push(node);
      if((size.y>1.5&&(size.x<.3||size.z<.3)) || (wallMaterial&&node.material===wallMaterial)) {
        if(size.y>1.5)this.walls.push(node);
      }
      // Windows also obstruct an observer view; they are restored for the story camera.
      if(node.material?.emissiveIntensity===.5)this.walls.push(node);
    });
    this.evaluate(0,false);
  }
  local(node){return {position:node.position.toArray(),quaternion:node.quaternion.toArray(),scale:node.scale.toArray(),visible:node.visible};}
  setLocal(node,s){node.position.fromArray(s.position);node.quaternion.fromArray(s.quaternion).normalize();node.scale.fromArray(s.scale);node.visible=s.visible;}
  worldMatrix(node){node.updateWorldMatrix(true,false);return node.matrixWorld.clone();}
  setWorld(node,matrix){node.parent?.updateWorldMatrix(true,false);const local=node.parent?node.parent.matrixWorld.clone().invert().multiply(matrix):matrix;local.decompose(node.position,node.quaternion,node.scale);node.updateMatrixWorld(true);}
  pose(node){const local=this.local(node);const w=this.worldMatrix(node);const p=new this.T.Vector3(),q=new this.T.Quaternion(),s=new this.T.Vector3();w.decompose(p,q,s);
    return {...local,parentId:this.parentId(node),world:{position:p.toArray(),quaternion:q.toArray(),scale:s.toArray()},worldMatrix:w.toArray()};}
  parentId(node){let p=node.parent;while(p){if(p.userData.directorId)return p.userData.directorId;p=p.parent;}return 'WORLD';}
  capture(){this.world.scene.updateMatrixWorld(true);return Object.fromEntries([...this.registry].map(([id,e])=>[id,this.pose(e.node)]));}
  restoreStructure(){for(const [id,s]of this.structural)this.setLocal(this.registry.get(id).node,s);}
  updateProxy(t){
    // 定位身体镜像 P01 的真实姿态。若故事中主角在某一阶段只剩镜头与前景手，
    // 需在此按该阶段的表达方式重建身体。
    const f=this.proxy,original=this.world.actors.P01;
    if(!f||!original)return;
    this.setLocal(f.root,this.local(original.root));
    for(const key of Object.keys(PARTS))this.setLocal(f[key],this.local(original[key]));
    f.root.visible=true;f.headBall.visible=true;
  }
  refreshIK(){this.world.scene.updateMatrixWorld(true);for(const [id,f]of Object.entries(this.actors))for(const [side,elbow]of [['left',f.eL],['right',f.eR]]){
    const point=elbow.localToWorld(new this.T.Vector3(0,-.33,0));this.registry.get(`${id}/${side}Hand`).node.position.copy(f.root.worldToLocal(point));
  }}
  baselineBindings(){
    // 新任务在此声明原动画的手持/绑定时间区间；无绑定则返回空对象。
    return {};
  }
  binding(id,owner){if(!owner)return {owner:null};const object=this.registry.get(id)?.node,parent=this.registry.get(owner)?.node;
    if(!object||!parent)throw new Error('绑定对象不存在');
    for(let node=parent;node;node=node.parent)if(node===object)throw new Error('不能绑定到自身或自身的子对象。');
    const seen=new Set([id]);let next=owner;while(next){if(seen.has(next))throw new Error('不允许循环绑定。');seen.add(next);next=this.bindings[next]?.owner;}
    return {owner,offset:this.worldMatrix(parent).invert().multiply(this.worldMatrix(object)).toArray()};}
  // 原动画里全程不移动（且未被绑定）的道具，才允许自动固定；绑定或随人物移动的（如手持物）不算。
  isStatic(id){
    if(this.staticCache.has(id))return this.staticCache.get(id);
    const e=this.registry.get(id);let value=false;
    if(e&&(e.kind==='prop'||this.components[id])){
      const step=FPS,end=Math.round(this.world.duration*FPS);let baseline=null;value=true;
      for(let f=0;f<=end;f+=step){
        this.restoreStructure();this.world.evaluate(f/FPS);this.world.scene.updateMatrixWorld(true);
        const m=this.worldMatrix(e.node).elements;
        if(!baseline){baseline=Array.from(m);continue;}
        if(m.some((v,i)=>Math.abs(v-baseline[i])>1e-4)){value=false;break;}
      }
    }
    this.evaluate(this.time);this.staticCache.set(id,value);return value;
  }
  // 副本本身不受原动画驱动，属于“原本不走位”的对象，移动后同样自动固定到片尾。
  persistable(id){const e=this.registry.get(id);return !!e&&(e.kind==='prop'||!!this.components[id])&&!this.bindings[id]?.owner&&this.isStatic(id);}
  // 自动固定：把当前帧的位置记为该对象的持久位置，从这一帧起保持到片尾。
  autoFix(id){
    const e=this.registry.get(id);if(!e||!this.persistable(id))return false;
    const local=copy(this.local(e.node)),list=this.overrides[id]||[];
    if(list.some(o=>o.startFrame===this.frame&&JSON.stringify(o.local)===JSON.stringify(local)))return false;
    this.overrides[id]=list.filter(o=>o.startFrame!==this.frame).concat({startFrame:this.frame,local}).sort((a,b)=>a.startFrame-b.startFrame);
    return true;
  }
  activeOverride(id){const list=this.overrides[id];if(!list)return null;let active=null;for(const o of list)if(o.startFrame<=this.frame)active=o;return active;}
  clearOverride(id){this.remember();delete this.overrides[id];this.evaluate();}
  applyOverrides(){
    for(const [id]of Object.entries(this.overrides)){
      if(this.edits.transforms[id])continue; // 当前帧若显式改过，以该帧修改为准
      const e=this.registry.get(id),o=this.activeOverride(id);if(e&&o)this.setLocal(e.node,o.local);
    }
  }
  evaluate(t=this.time,apply=true){
    this.time=Math.max(0,Math.min(this.world.duration,t));this.frame=Math.round(this.time*FPS);
    for(const e of this.registry.values())e.reachExceeded=false;
    this.restoreStructure();this.world.evaluate(this.time);this.updateProxy(this.time);this.refreshIK();
    this.reference=this.capture();this.baseBindings=this.baselineBindings();
    this.bindings={...copy(this.baseBindings),...(apply?copy(this.edits.bindings):{})};
    if(apply){
      for(const [id,s]of Object.entries(this.edits.transforms)){const e=this.registry.get(id);if(e)this.setLocal(e.node,s);}
      this.world.scene.updateMatrixWorld(true);
      for(const [id,m]of Object.entries(this.edits.free)){const e=this.registry.get(id);if(e)this.setWorld(e.node,new this.T.Matrix4().fromArray(m));}
      for(const [id]of Object.entries(this.edits.transforms)){const e=this.registry.get(id);if(e?.kind==='ik'&&!this.edits.free[id])this.solveHand(e);}
      this.world.scene.updateMatrixWorld(true);
      // Detached parts stay in world space even when their parent is changed by IK.
      for(const [id,m]of Object.entries(this.edits.free))this.setWorld(this.registry.get(id).node,new this.T.Matrix4().fromArray(m));
      const applied=new Set();
      const applyBinding=id=>{if(applied.has(id))return;const b=this.bindings[id];if(!b?.owner)return;
        applyBinding(b.owner);const parent=this.registry.get(b.owner)?.node;
        if(parent)this.setWorld(this.registry.get(id).node,this.worldMatrix(parent).multiply(new this.T.Matrix4().fromArray(b.offset)));applied.add(id);};
      for(const id of Object.keys(this.bindings))applyBinding(id);
    }
    this.applyOverrides();this.applyDeletions();
    this.world.scene.updateMatrixWorld(true);this.collisionPose=this.capture();return this;
  }
  solveHand(e){
    const T=this.T,f=this.actors[e.actorId],shoulder=e.side==='left'?f.sL:f.sR,elbow=e.side==='left'?f.eL:f.eR;
    this.world.scene.updateMatrixWorld(true);
    const target=e.node.getWorldPosition(new T.Vector3()),v=f.torso.worldToLocal(target).sub(shoulder.position);
    const distance=v.length(),length=Math.max(.031,Math.min(.629,distance)),l1=.3,l2=.33,axis=v.normalize();
    let bend=new T.Vector3(0,0,1).addScaledVector(axis,-axis.z);if(bend.lengthSq()<.001)bend=new T.Vector3(1,0,0).addScaledVector(axis,-axis.x);bend.normalize();
    const along=(l1*l1-l2*l2+length*length)/(2*length);
    const joint=axis.clone().multiplyScalar(along).addScaledVector(bend,Math.sqrt(Math.max(0,l1*l1-along*along)));
    shoulder.quaternion.setFromUnitVectors(new T.Vector3(0,-1,0),joint.clone().normalize());
    const lower=axis.multiplyScalar(length).sub(joint).applyQuaternion(shoulder.quaternion.clone().invert());
    elbow.quaternion.setFromUnitVectors(new T.Vector3(0,-1,0),lower.normalize());e.reachExceeded=distance>.6301;
  }
  // Keep nodes and source records intact so deletion can be undone and chained copies can be imported.
  isDeleted(id){const entry=this.registry.get(id);if(!entry)return false;
    for(let node=entry.node;node;node=node.parent)if(this.deletedObjects.has(node.userData.directorId))return true;
    return this.deletedObjects.has(id);
  }
  applyDeletions(visible=(node,value)=>{node.visible=value;}){
    for(const id of this.deletedObjects){const e=this.registry.get(id);if(e)visible(e.node,false);
      if(id==='P01'&&this.world.actors.P01)visible(this.world.actors.P01.root,false);}
  }
  deleteObject(id){const e=this.registry.get(id);
    if(!e||this.isDeleted(id)||id==='C01'||e.kind==='ik')return false;
    this.remember();this.deletedObjects.add(id);this.evaluate();return true;
  }
  activeComponents(){return Object.fromEntries(Object.entries(this.components).filter(([id])=>!this.isDeleted(id)));}
  snapshot(){return {edits:copy(this.edits),overrides:copy(this.overrides),deletedObjects:[...this.deletedObjects]};}
  remember(){this.undoStack.push(this.snapshot());if(this.undoStack.length>80)this.undoStack.shift();this.redoStack=[];}
  protectNode(id){
    this.collisionMessage='';
    const entry=this.registry.get(id),before=this.collisionPose;if(!entry||!before||!before[id])return;
    if(!this.liveCollision){
      const state=this.local(entry.node);entry.node.updateWorldMatrix(true,false);
      if(![...state.position,...state.quaternion,...state.scale,...entry.node.matrixWorld.elements].every(Number.isFinite)||state.scale.some(v=>v<=0)){
        this.setLocal(entry.node,before[id]);this.collisionMessage='变换无效：模型尺寸必须大于零，坐标必须为有限数值。';
      }
      return;
    }
    const target=this.capture(),changed=[],focus=new Set();
    if(Object.values(target).some(s=>![...s.position,...s.quaternion,...s.scale].every(Number.isFinite)||s.scale.some(v=>v<=0))){
      for(const [key,pose]of Object.entries(before)){const e=this.registry.get(key);if(e)this.setLocal(e.node,pose);}
      this.collisionMessage='变换无效：模型尺寸必须大于零，坐标必须为有限数值。';return;
    }
    for(const [key,state]of Object.entries(target)){
      const old=before[key],e=this.registry.get(key);if(!old||!e)continue;
      if(JSON.stringify(old.worldMatrix)!==JSON.stringify(state.worldMatrix)||old.visible!==state.visible)focus.add(e.actorId||key);
      if(JSON.stringify([old.position,old.quaternion,old.scale,old.visible])!==JSON.stringify([state.position,state.quaternion,state.scale,state.visible]))changed.push(key);
    }
    if(!changed.length)return;
    focus.add(entry.actorId||id);
    let expanded=true;while(expanded){expanded=false;for(const [key,b]of Object.entries(this.bindings)){
      if(b?.owner&&focus.has(b.owner.split('/')[0])&&!focus.has(key)){focus.add(key);expanded=true;}
    }}
    const T=this.T,bounds=new T.Box3().setFromObject(entry.actorId?this.actors[entry.actorId].root:entry.node);
    for(const key of focus){const node=this.registry.get(key)?.node;if(node)bounds.union(new T.Box3().setFromObject(node));}
    const radius=bounds.isEmpty()?.5:bounds.getSize(new T.Vector3()).length()+bounds.getCenter(new T.Vector3()).distanceTo(entry.node.getWorldPosition(new T.Vector3()));
    let distance=0;
    for(const key of changed){const a=before[key],b=target[key];
      distance=Math.max(distance,new T.Vector3(...a.world.position).distanceTo(new T.Vector3(...b.world.position))
        +new T.Quaternion(...a.world.quaternion).angleTo(new T.Quaternion(...b.world.quaternion))*radius
        +new T.Vector3(...a.scale).distanceTo(new T.Vector3(...b.scale))*radius);
    }
    const binding=this.bindings[id],movingBinding=entry.kind==='prop'&&binding?.owner?{
      from:new T.Matrix4().fromArray(binding.offset),to:new T.Matrix4().fromArray(this.binding(id,binding.owner).offset)
    }:null;
    const apply=fraction=>{
      for(const [key,state]of Object.entries(before)){const e=this.registry.get(key);if(e)this.setLocal(e.node,state);}
      for(const key of changed){const a=before[key],b=target[key],node=this.registry.get(key).node;
        node.position.fromArray(a.position).lerp(new T.Vector3(...b.position),fraction);
        node.quaternion.fromArray(a.quaternion).slerp(new T.Quaternion(...b.quaternion),fraction);
        node.scale.fromArray(a.scale).lerp(new T.Vector3(...b.scale),fraction);node.visible=fraction>0?b.visible:a.visible;
      }
      this.world.scene.updateMatrixWorld(true);if(entry.kind==='ik')this.solveHand(entry);
      const applied=new Set(),bind=key=>{if(applied.has(key))return;applied.add(key);const b=this.bindings[key];if(!b?.owner)return;
        bind(b.owner);const e=this.registry.get(key),owner=this.registry.get(b.owner);if(e&&owner){let offset=new T.Matrix4().fromArray(b.offset);
          if(key===id&&movingBinding){const p=new T.Vector3(),q=new T.Quaternion(),s=new T.Vector3(),p2=new T.Vector3(),q2=new T.Quaternion(),s2=new T.Vector3();
            movingBinding.from.decompose(p,q,s);movingBinding.to.decompose(p2,q2,s2);offset.compose(p.lerp(p2,fraction),q.slerp(q2,fraction),s.lerp(s2,fraction));}
          this.setWorld(e.node,this.worldMatrix(owner.node).multiply(offset));}};
      for(const key of Object.keys(this.bindings))bind(key);
      this.world.scene.updateMatrixWorld(true);
    };
    try{const result=this.collisions.sweep({apply,distance,focus});
      if(result.fraction===0)apply(0);this.collisionMessage=result.message;
    }catch(error){apply(0);this.collisionMessage=`无法完成体积碰撞检查，已取消修改：${error.message}`;}
  }
  collisionContacts(){return this.collisions.contacts();}
  assertCollisionFree(){const hit=this.collisionContacts()[0];if(hit)throw new Error(this.collisions.message(hit));}
  assertTargetCollisionFree(){
    if(!this.liveCollision)return;
    const current=this.capture(),contacts=this.collisionContacts();let baseline;
    try{for(const [id,pose]of Object.entries(this.reference)){const e=this.registry.get(id);if(e)this.setLocal(e.node,pose);}
      baseline=new Map(this.collisionContacts().map(c=>[c.key,c.depth]));
    }finally{for(const [id,pose]of Object.entries(current)){const e=this.registry.get(id);if(e)this.setLocal(e.node,pose);}this.world.scene.updateMatrixWorld(true);}
    const hit=contacts.find(c=>c.depth>(baseline.get(c.key)||0)+1e-5);if(hit)throw new Error(this.collisions.message(hit));
  }
  saveNode(id,mode='whole'){
    this.protectNode(id);
    const e=this.registry.get(id);if(!e)return;
    if(mode==='free'&&e.kind==='joint'){this.edits.free[id]=this.worldMatrix(e.node).toArray();delete this.edits.transforms[id];}
    else if(e.kind==='prop'&&this.bindings[id]?.owner){this.edits.bindings[id]=this.binding(id,this.bindings[id].owner);delete this.edits.transforms[id];}
    else{this.edits.transforms[id]=this.local(e.node);delete this.edits.free[id];}
  }
  edit(id,values,{space='world',mode='whole',remember=true}={}){
    const e=this.registry.get(id);if(!e)throw new Error('对象不存在');
    const invalid=Object.entries({position:3,quaternion:4,scale:3}).some(([key,length])=>values[key]!==undefined&&(!Array.isArray(values[key])||values[key].length!==length||!values[key].every(Number.isFinite)))
      ||values.scale?.some(v=>v<=0)||values.quaternion?.every(v=>v===0);
    if(invalid){this.collisionMessage='变换无效：模型尺寸必须大于零，坐标和旋转必须为有效数值。';return this.pose(e.node);}
    if(remember)this.remember();
    if(space==='world'){
      const state=this.pose(e.node).world,p=new this.T.Vector3(...(values.position||state.position)),q=new this.T.Quaternion(...(values.quaternion||state.quaternion)),s=new this.T.Vector3(...(values.scale||state.scale));
      this.setWorld(e.node,new this.T.Matrix4().compose(p,q.normalize(),s));
    }else{const state={...this.local(e.node),...values};this.setLocal(e.node,state);}
    if(values.visible!==undefined)e.node.visible=values.visible;
    this.saveNode(id,mode);this.evaluate();return this.pose(e.node);
  }
  setBinding(id,owner){this.remember();this.edits.bindings[id]=this.binding(id,owner);
    if(!owner)this.edits.transforms[id]=this.local(this.registry.get(id).node);
    else{delete this.edits.transforms[id];delete this.overrides[id];}this.evaluate();}
  restore(id){this.remember();const prefix=id+'/';for(const key of Object.keys(this.edits.transforms))if(key===id||key.startsWith(prefix))delete this.edits.transforms[key];
    for(const key of Object.keys(this.edits.free))if(key===id||key.startsWith(prefix))delete this.edits.free[key];
    if(id.startsWith('O')){delete this.edits.bindings[id];}
    delete this.overrides[id];
    this.evaluate();}
  reconnect(id){this.remember();const e=this.registry.get(id),s=this.local(e.node);s.position=this.reference[id].position;delete this.edits.free[id];this.edits.transforms[id]=s;this.evaluate();}
  undo(){if(!this.undoStack.length)return;this.redoStack.push(this.snapshot());const s=this.undoStack.pop(),restored=[...this.deletedObjects].find(id=>!(s.deletedObjects||[]).includes(id));this.edits=s.edits;this.overrides=s.overrides;this.deletedObjects=new Set(s.deletedObjects||[]);this.evaluate();return restored;}
  redo(){if(!this.redoStack.length)return;this.undoStack.push(this.snapshot());const s=this.redoStack.pop();this.edits=s.edits;this.overrides=s.overrides;this.deletedObjects=new Set(s.deletedObjects||[]);this.evaluate();}
  dirty(){return Object.keys(this.edits.transforms).length+Object.keys(this.edits.free).length+Object.keys(this.edits.bindings).length+Object.keys(this.overrides).length+this.deletedObjects.size>0;}
  seek(t,{restoreDraft=true}={}){this.collisionMessage='';this.time=Math.round(Math.max(0,Math.min(this.world.duration,t))*FPS)/FPS;this.frame=Math.round(this.time*FPS);
    this.edits=restoreDraft&&this.drafts.has(this.frame)?copy(this.drafts.get(this.frame).edits):empty();this.undoStack=[];this.redoStack=[];this.evaluate();}
  // —— 复制组件：副本形象与来源一致，但不带原动画，位置固定（移动时走自动固定逻辑）——
  register(id,node,label,kind,actorId=null){const item={id,node,label,kind,actorId};node.userData.directorId=id;this.registry.set(id,item);return item;}
  componentId(sourceId){
    const prefix=(sourceId.match(/^[A-Za-z]+/)||['X'])[0];let max=0;
    for(const id of this.registry.keys()){const m=id.match(/^([A-Za-z]+)(\d+)$/);if(m&&m[1]===prefix)max=Math.max(max,Number(m[2]));}
    return `${prefix}${String(max+1).padStart(2,'0')}`;
  }
  // 粘贴：在源对象旁边沿世界 X 轴错开 .3m 生成副本；导入时用记录里的矩阵精确还原。
  cloneComponent(sourceId,{id,matrix,note,at}={}){
    const e=this.registry.get(sourceId);if(!e)return null;
    const T=this.T,newId=id||this.componentId(sourceId),name=(e.label.split(' · ')[1]||e.id),node=e.node.clone(true);
    node.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}delete n.userData.directorId;});
    if(this.liveCollision)this.collisions.volumes();const kind=e.kind,label=`${newId} · ${name}（副本）`;
    this.world.scene.updateMatrixWorld(true);
    const m=matrix?new T.Matrix4().fromArray(matrix):this.worldMatrix(e.node).clone();
    if(!matrix)m.elements[12]+=0.3;
    this.world.scene.add(node);this.setWorld(node,m);
    this.register(newId,node,label,kind,null);this.structural.set(newId,this.local(node));
    this.components[newId]={id:newId,sourceId,kind,label,note:note||'',matrix:m.toArray(),at:Number.isInteger(at)?at:this.frame};
    // Strict workflows search for free space; the director's free editing preserves the requested placement.
    if(this.liveCollision){
    const desired=this.worldMatrix(node),center=node.getWorldPosition(new T.Vector3()),size=new T.Box3().setFromObject(node).getSize(new T.Vector3());
    const focus=new Set([newId]),free=()=>!this.collisions.contacts({focus,limit:1}).length;
    let placed=free();
    if(!placed&&!matrix){const spacing=Math.max(.35,size.x,size.z)+.12;
      for(let ring=1;ring<=6&&!placed;ring++)for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
        const candidate=desired.clone();candidate.elements[12]=center.x+dx*ring*spacing;candidate.elements[14]=center.z+dz*ring*spacing;this.setWorld(node,candidate);
        if(free()){placed=true;break;}
      }
    }
    if(!placed){node.removeFromParent();this.registry.delete(newId);this.structural.delete(newId);delete this.components[newId];this.collisionMessage='体积碰撞：副本位置没有足够空间；已取消粘贴。';return null;}
    }
    this.components[newId].matrix=this.worldMatrix(node).toArray();this.structural.set(newId,this.local(node));
    this.evaluate();return newId;
  }
  componentNote(id,note){if(this.components[id])this.components[id].note=String(note??'').slice(0,2000);}
  // 删除副本：连同节点、登记、结构快照以及各时间点里的编辑/固定一起清理，不留残留。
  removeComponent(id){
    if(!this.components[id])return false;const e=this.registry.get(id);
    if(e)e.node.parent?.remove(e.node);
    this.registry.delete(id);this.structural.delete(id);delete this.components[id];
    for(const key of ['transforms','free','bindings'])delete this.edits[key][id];delete this.overrides[id];
    for(const d of this.drafts.values()){for(const key of ['transforms','free','bindings'])if(d.edits[key])delete d.edits[key][id];if(d.overrides)delete d.overrides[id];}
    this.staticCache.clear();this.evaluate();return true;
  }
  warnings(selected){const result=this.collisionMessage?[this.collisionMessage]:[];const e=this.registry.get(selected);if(!e)return result;
    if(this.edits.free[selected])result.push('该部位已独立放置，可离开身体；整体移动时它保持世界位置。');
    if(this.overrides[selected])result.push('该道具原本不走位，已固定位置并保持到片尾；再次移动它会更新固定位置。');
    if(e.kind==='ik'&&e.reachExceeded)result.push('目标超过手臂长度：当前手臂只能尽量靠近，请移动身体或缩短距离。');
    if(e.kind==='actor'){
      const p=e.node.getWorldPosition(new this.T.Vector3());if(Math.abs(p.y)>.025)result.push('人物根节点离开地面，请确认是否需要悬空。');
      if(this.liveCollision){
        for(const node of this.walls){const b=new this.T.Box3().setFromObject(node);if(p.x>b.min.x-.18&&p.x<b.max.x+.18&&p.z>b.min.z-.18&&p.z<b.max.z+.18&&p.y+1.65>b.min.y&&p.y<b.max.y) {result.push('人物可能与墙体重叠；这里仅提示，不会自动生成避障路径。');break;}}
        for(const [id,entry] of this.registry){if(entry.kind!=='prop')continue;const b=new this.T.Box3().setFromObject(entry.node);if(p.x>b.min.x-.18&&p.x<b.max.x+.18&&p.z>b.min.z-.18&&p.z<b.max.z+.18){result.push(`人物可能与 ${id} 道具重叠。`);break;}}
      }
    }return result;
  }
  state(view){return {deletedObjects:[...this.deletedObjects],frame:this.frame,timeSeconds:this.time,sceneId:sceneAt(this.time).id,note:this.edits.note,
    reference:{objects:copy(this.reference),bindings:copy(this.baseBindings)},target:{objects:this.capture(),bindings:copy(this.bindings)},edits:copy(this.edits),observer:view};}
  validatePackage(data,hash,compatibleHashes=[]){
    if(data?.format!=='white-model-director'||data.schemaVersion!==SCHEMA)throw new Error('不是支持的白膜状态包格式。');
    if(data.project?.id!==PROJECT.id||data.fps!==FPS||data.durationSeconds!==this.world.duration)throw new Error('工程身份、帧率或时长不匹配。');
    if(data.project?.sourceHash!==hash&&!compatibleHashes.includes(data.project?.sourceHash))throw new Error('工程版本不同：请使用导出时的工程，或先把文件交给我迁移。');
    if(!Array.isArray(data.states)||!data.states.length||data.states.length>500)throw new Error('状态列表为空或数量异常。');
    const frames=new Set();
    // 复制组件的编号可能引用原对象或另一个副本（链式），先解析出全部已知编号与类型，再做逐帧校验。
    const ids=new Set(this.registry.keys()),kinds=new Map([...this.registry].map(([id,e])=>[id,e.kind]));
    if(data.components!==undefined){
      if(typeof data.components!=='object'||data.components===null||Array.isArray(data.components))throw new Error('复制组件数据无效。');
      const pending=Object.entries(data.components);let progress=true;
      while(pending.length&&progress){progress=false;
        for(let i=0;i<pending.length;i++){const [id,c]=pending[i];
          if(!/^[A-Za-z]+\d+$/.test(id)||ids.has(id))throw new Error(`复制组件编号 ${id} 无效或重复。`);
          if(!c||typeof c!=='object')throw new Error(`复制组件 ${id} 字段无效。`);
          if(typeof c.sourceId!=='string')throw new Error(`复制组件 ${id} 的来源无效。`);
          if(c.note!==undefined&&typeof c.note!=='string')throw new Error(`复制组件 ${id} 的备注无效。`);
          if(c.matrix!==undefined&&(!Array.isArray(c.matrix)||c.matrix.length!==16||!c.matrix.every(Number.isFinite)))throw new Error(`复制组件 ${id} 的变换无效。`);
          if(!ids.has(c.sourceId))continue;
          ids.add(id);kinds.set(id,['prop','actor','hand','camera'].includes(c.kind)?c.kind:'prop');pending.splice(i,1);i--;progress=true;}
      }
      if(pending.length)throw new Error(`复制组件 ${pending[0][0]} 的来源无效或存在循环。`);
    }
    if(data.deletedObjects!==undefined&&(!Array.isArray(data.deletedObjects)||data.deletedObjects.some(id=>typeof id!=='string'||!ids.has(id)||id==='C01'||kinds.get(id)==='ik')||new Set(data.deletedObjects).size!==data.deletedObjects.length))throw new Error('删除对象列表无效。');
    const transform=s=>Array.isArray(s?.position)&&s.position.length===3&&Array.isArray(s.quaternion)&&s.quaternion.length===4&&Array.isArray(s.scale)&&s.scale.length===3&&[...s.position,...s.quaternion,...s.scale].every(Number.isFinite)&&s.scale.every(v=>v>0)&&s.quaternion.some(v=>v!==0)&&typeof s.visible==='boolean';
    for(const state of data.states){
      if(!Number.isInteger(state.frame)||state.frame<0||state.frame>this.world.duration*FPS||frames.has(state.frame))throw new Error('时间点无效或重复。');frames.add(state.frame);
      const edits=state.edits;if(!edits||typeof edits.note!=='string'||edits.note.length>50000)throw new Error('修改说明无效。');
      for(const key of ['transforms','free','bindings'])if(!edits[key]||typeof edits[key]!=='object'||Array.isArray(edits[key]))throw new Error('编辑状态字段不完整。');
      for(const [id,s]of Object.entries(edits.transforms||{}))if(!ids.has(id)||!transform(s))throw new Error(`对象 ${id} 的变换无效。`);
      for(const [id,m]of Object.entries(edits.free||{}))if(kinds.get(id)!=='joint'||!Array.isArray(m)||m.length!==16||!m.every(Number.isFinite)||Math.abs(new this.T.Matrix4().fromArray(m).determinant())<1e-10)throw new Error('拆分部位状态无效。');
      for(const [id,b]of Object.entries(edits.bindings||{})){
        if(kinds.get(id)!=='prop'||(b.owner!==null&&!ids.has(b.owner)))throw new Error('绑定关系无效。');
        if(b.owner!==null&&(!Array.isArray(b.offset)||b.offset.length!==16||!b.offset.every(Number.isFinite)))throw new Error('绑定偏移无效。');
        if(b.owner===id||b.owner?.startsWith(id+'/'))throw new Error('不允许循环绑定。');
        if(b.owner){const holder=this.registry.get(id)?.node,owner=this.registry.get(b.owner)?.node;if(holder&&owner)for(let node=owner;node;node=node.parent)if(node===holder)throw new Error('不允许绑定到自身的子对象。');}
      }
      const graph=edits.bindings||{};for(const id of Object.keys(graph)){const seen=new Set([id]);let owner=graph[id]?.owner;while(owner){if(seen.has(owner))throw new Error('不允许循环绑定。');seen.add(owner);owner=graph[owner]?.owner;}}
    }
    const overrides=data.overrides;
    if(overrides!==undefined){
      if(typeof overrides!=='object'||overrides===null||Array.isArray(overrides))throw new Error('固定位置数据无效。');
      for(const [id,list]of Object.entries(overrides)){
        if(kinds.get(id)!=='prop'||!Array.isArray(list)||!list.length)throw new Error(`固定位置对象 ${id} 无效。`);
        for(const o of list)if(!Number.isInteger(o.startFrame)||o.startFrame<0||o.startFrame>this.world.duration*FPS||!transform(o.local))throw new Error('固定位置的帧或变换无效。');
      }
    }
    return data;
  }
  importPackage(data,hash,compatibleHashes=[]){
    const old={registry:new Map(this.registry),structural:new Map(this.structural),components:copy(this.components||{}),drafts:copy(this.drafts),overrides:copy(this.overrides),edits:copy(this.edits),time:this.time,deletedObjects:[...this.deletedObjects],undo:copy(this.undoStack),redo:copy(this.redoStack)};
    this.importWarnings=[];
    try{const first=this.importPackageUnchecked(data,hash,compatibleHashes);
      // A migrated package stores positions authored in an older scene. Its saved poses stay
      // importable; overlaps that the older scene used to contain are reported as reminders, not rejection.
      const migrated=!!data.project?.migratedFrom;
      for(const draft of this.drafts.values()){this.edits=copy(draft.edits);this.evaluate(draft.frame/FPS);
        try{this.assertTargetCollisionFree();}catch(error){if(!migrated)throw error;this.importWarnings.push(error.message);}}
      this.seek(first.frame/FPS);return first;
    }catch(error){
      for(const [id,e]of this.registry)if(old.registry.get(id)?.node!==e.node&&!id.includes('/'))e.node.removeFromParent();
      this.registry=old.registry;this.structural=old.structural;this.components=old.components;
      for(const id of Object.keys(old.components)){const e=this.registry.get(id);if(e)this.world.scene.add(e.node);}
      this.drafts=old.drafts;this.overrides=old.overrides;this.edits=old.edits;this.deletedObjects=new Set(old.deletedObjects);this.undoStack=old.undo;this.redoStack=old.redo;this.evaluate(old.time);throw error;
    }
  }
  importPackageUnchecked(data,hash,compatibleHashes=[]){
    // 先清掉上一包遗留的副本，避免编号冲突；校验失败则原样还原。
    const backup=Object.entries(this.components).map(([id,c])=>({id,sourceId:c.sourceId,matrix:c.matrix,note:c.note,at:c.at}));
    for(const id of Object.keys(this.components))this.removeComponent(id);
    try{this.validatePackage(data,hash,compatibleHashes);}
    catch(error){for(const b of backup)this.cloneComponent(b.sourceId,{id:b.id,matrix:b.matrix,note:b.note,at:b.at});throw error;}
    this.deletedObjects=new Set();this.evaluate();
    if(data.components){const pending=Object.entries(data.components);let progress=true;
      while(pending.length&&progress){progress=false;
        for(let i=0;i<pending.length;i++){const [id,c]=pending[i];
          if(!this.registry.has(c.sourceId))continue;
          if(!this.cloneComponent(c.sourceId,{id,matrix:c.matrix,note:c.note,at:c.at}))throw new Error(`体积碰撞：副本 ${id} 无法恢复到穿模位置。`);pending.splice(i,1);i--;progress=true;}}}
    const drafts=new Map();for(const state of data.states)drafts.set(state.frame,{frame:state.frame,time:state.frame/FPS,sceneId:state.sceneId,edits:copy(state.edits),observer:copy(state.observer)});
    this.deletedObjects=new Set(data.deletedObjects||[]);this.drafts=drafts;this.overrides=data.overrides?copy(data.overrides):{};this.staticCache.clear();this.seek(data.states[0].frame/FPS);return data.states[0];}
}
