// Conservative compound volumes: transformed mesh bounds, not an object's center or one box around a hollow model.
// SAT supports rotation, non-uniform scaling and parent shear. Touching surfaces are allowed; penetration is not.
export const COLLISION_EPSILON = 1e-5;
// Skeleton joints connected by construction. Adjacent limb segments always overlap at the
// joint seam, so a parent/child pair must never be counted as 穿模.
const RIG_PARENTS = {torso:'pelvis',head:'torso',sL:'torso',sR:'torso',eL:'sL',eR:'sR',hL:'pelvis',hR:'pelvis',kL:'hL',kR:'hR',fL:'kL',fR:'kR'};
export class VolumeCollision {
  constructor(world, {actors=world.actors, components=()=>({}),visibility=null}={}) {
    this.world=world;this.T=world.THREE;this.actors=actors;this.components=components;this.boundsVersions=new WeakMap();this.visibility=visibility;
  }
  volumes({cache=null}={}) {
    const T=this.T, owners=new Map(),result=[];
    for(const [id,f]of Object.entries(this.actors)){
      owners.set(f.root,{id,label:id,rig:true});if(f.headBall)f.headBall.userData.collisionVisible=true;
      for(const key of ['pelvis','torso','head','sL','eL','sR','eR','hL','kL','fL','hR','kR','fR'])if(f[key])f[key].userData.collisionPart=key;
    }
    for(const [id,node]of Object.entries(this.world.objects))owners.set(node,{id,label:id});
    for(const [id,h]of Object.entries(this.world.hands||{}))owners.set(h.root,{id,label:id});
    for(const [id,c]of Object.entries(this.components()))if(c.node)owners.set(c.node,{id,label:id,rig:c.kind==='actor'});
    (this.world.environmentGroups||[]).forEach((node,i)=>owners.set(node,{id:'building-shell',label:'建筑结构'}));
    this.world.scene.updateMatrixWorld(true);
    const walk=(node,owner,visible,part=null)=>{
      visible=visible&&(node.userData.collisionVisible|| (this.visibility?this.visibility(node):node.visible));if(!visible||node.userData.collisionIgnore||(node.userData.editorProxy&&!owners.has(node)))return;
      if(owners.has(node)){owner=owners.get(node);part=null;}if(node.userData.collisionPart)part=node.userData.collisionPart;
      // Classroom furniture is a collection of separate desks and chairs, not one solid room volume.
      if(node.name==='desk'||node.name==='chair')owner={id:`furniture-${node.uuid}`,label:`课桌椅 ${node.parent?.name||''}`};
      if(node.isMesh&&node.geometry){
        if(node.isInstancedMesh)throw new Error('实例模型需要逐实例碰撞体，不能用一个基础网格通过检查。');
        const materials=Array.isArray(node.material)?node.material:[node.material];
        if(materials.some(m=>m?.isShaderMaterial))throw new Error('自定义顶点着色模型需要覆盖变形范围的碰撞体，当前检查不能认证。');
        const deformed=node.isSkinnedMesh||node.geometry.morphAttributes?.position?.length;
        const version=node.geometry.getAttribute('position')?.version,matrix=node.matrixWorld.elements;
        const cached=!deformed&&cache?.get(node);
        if(cached&&cached.geometry===node.geometry&&cached.version===version&&cached.owner===owner.id&&cached.label===owner.label&&cached.rig===owner.rig&&cached.part===part&&matrix.every((v,i)=>v===cached.matrix[i])){
          result.push(cached.volume);
          for(const child of node.children)walk(child,owner,visible,part);
          return;
        }
        let bounds;
        if(deformed){
          if(typeof node.getVertexPosition!=='function')throw new Error('无法读取模型变形后的顶点，碰撞检查中止。');
          node.skeleton?.update();bounds=new T.Box3();const position=node.geometry.getAttribute('position');
          for(let i=0;i<position.count;i++)bounds.expandByPoint(node.getVertexPosition(i,new T.Vector3()));
        }else{
          if(!node.geometry.boundingBox||this.boundsVersions.get(node.geometry)!==version){node.geometry.computeBoundingBox();this.boundsVersions.set(node.geometry,version);}
          bounds=node.geometry.boundingBox;
        }
        if(!bounds||bounds.isEmpty())throw new Error('模型缺少有效体积，不能完成碰撞检查。');
        const center=bounds.getCenter(new T.Vector3()).applyMatrix4(node.matrixWorld);
        const half=bounds.getSize(new T.Vector3()).multiplyScalar(.5);const m=node.matrixWorld.elements;
        // Paper and other thin surfaces retain a small physical thickness.
        half.x=Math.max(half.x,.001);half.y=Math.max(half.y,.001);half.z=Math.max(half.z,.001);
        const axes=[new T.Vector3(m[0],m[1],m[2]).multiplyScalar(half.x),new T.Vector3(m[4],m[5],m[6]).multiplyScalar(half.y),new T.Vector3(m[8],m[9],m[10]).multiplyScalar(half.z)];
        const extent=new T.Vector3();for(const axis of axes){extent.x+=Math.abs(axis.x);extent.y+=Math.abs(axis.y);extent.z+=Math.abs(axis.z);}
        if(![...center.toArray(),...axes.flatMap(a=>a.toArray())].every(Number.isFinite)||axes.some(a=>a.length()<1e-10))throw new Error('模型变换无效，碰撞检查中止。');
        const faces=[axes[1].clone().cross(axes[2]),axes[2].clone().cross(axes[0]),axes[0].clone().cross(axes[1])];
        const volume={id:node.uuid,owner:owner.id,label:owner.label,rig:owner.rig,part,node,center,axes,faces,min:center.clone().sub(extent),max:center.clone().add(extent)};
        result.push(volume);
        if(cache&&!deformed)cache.set(node,{geometry:node.geometry,version,owner:owner.id,label:owner.label,rig:owner.rig,part,matrix:matrix.slice(),volume});
      }
      for(const child of node.children)walk(child,owner,visible,part);
    };
    for(const child of this.world.scene.children){
      // A director-only placement body replaces the original body, never duplicates it in collision checks.
      if(child===this.world.actors?.P01?.root&&this.actors.P01?.root!==child)continue;
      if(child.isLight||child.isLine||child.isLineSegments||child.isSprite||child.isCamera||child.userData.collisionIgnore)continue;
      // Editor helpers are neither physical models nor obstacles.
      if(child.type==='TransformControlsRoot'||child.type==='BoxHelper'||child.type==='CameraHelper')continue;
      walk(child,{id:`scene-${child.uuid}`,label:child.name||'场景模型'},true);
    }
    if(this.world.camera){
      const radius=this.world.collisionCameraRadius??.08,center=this.world.camera.getWorldPosition(new T.Vector3());
      if(!Number.isFinite(radius)||radius<=0)throw new Error('剧情镜头碰撞半径必须大于零。');
      const axes=[new T.Vector3(radius,0,0),new T.Vector3(0,radius,0),new T.Vector3(0,0,radius)],extent=new T.Vector3(radius,radius,radius);
      result.push({id:'story-camera',owner:'C01',label:'剧情镜头',center,axes,faces:axes,min:center.clone().sub(extent),max:center.clone().add(extent)});
    }
    return result;
  }
  penetration(a,b) {
    const e=COLLISION_EPSILON;
    if(a.max.x<=b.min.x+e||b.max.x<=a.min.x+e||a.max.y<=b.min.y+e||b.max.y<=a.min.y+e||a.max.z<=b.min.z+e||b.max.z<=a.min.z+e)return 0;
    const delta=b.center.clone().sub(a.center),axes=[...a.faces,...b.faces];
    for(const x of a.axes)for(const y of b.axes)axes.push(x.clone().cross(y));
    let depth=Infinity;
    for(const rawAxis of axes){const length=rawAxis.length();if(length<1e-12)continue;const axis=rawAxis.clone().multiplyScalar(1/length);
      const radius=v=>v.axes.reduce((sum,edge)=>sum+Math.abs(edge.dot(axis)),0);
      const overlap=radius(a)+radius(b)-Math.abs(delta.dot(axis));if(overlap<=e)return 0;depth=Math.min(depth,overlap);
    }
    return Number.isFinite(depth)?depth:0;
  }
  contacts({focus=null,limit=1000,cache=null}={}) {
    const volumes=this.volumes({cache}),contacts=[];
    const focused=focus?volumes.flatMap((v,i)=>focus.has(v.owner)?[i]:[]):null;
    // Preserve pair order while avoiding pairs that cannot involve an edited object.
    for(let i=0;i<volumes.length;i++){
      const candidates=focus&&!focus.has(volumes[i].owner)?focused:null;
      for(let k=candidates?0:i+1;k<(candidates?candidates.length:volumes.length);k++){
      const j=candidates?candidates[k]:k;if(j<=i)continue;
      const a=volumes[i],b=volumes[j];
      if(a.owner===b.owner){
        if(!a.rig||!a.part||!b.part||a.part===b.part)continue;

      }
      if((a.owner==='C01'&&b.owner==='P01')||(b.owner==='C01'&&a.owner==='P01'))continue; // An eye mounted on P01 is a virtual viewpoint, not a second physical object.
      if(focus&&!focus.has(a.owner)&&!focus.has(b.owner))continue;
      const depth=this.penetration(a,b);if(!depth)continue;
      if(a.owner===b.owner&&(RIG_PARENTS[a.part]===b.part||RIG_PARENTS[b.part]===a.part))continue; // Connected joint seam, not 穿模.
      const key=[a.id,b.id].sort().join(':');contacts.push({key,a:a.owner,b:b.owner,labelA:a.label,labelB:b.label,depth});
      if(contacts.length>=limit)return contacts;
      }
    }
    return contacts;
  }
  message(contact){return `体积碰撞：${contact.labelA} 与 ${contact.labelB} 重叠 ${(contact.depth*1000).toFixed(1)} mm；已阻止穿模。`;}
  // Existing penetration may be reduced to repair a legacy scene, but never increased or introduced.
  sweep({apply,distance,focus}) {
    // The cache lasts only for this synchronous sweep. Moving meshes invalidate it by matrix;
    // unchanged obstacles retain their exact volumes, and deformed meshes are always rebuilt.
    const cache=new WeakMap();
    apply(0);const volumes=this.volumes({cache}),minThickness=Math.min(.02,...volumes.flatMap(v=>v.axes.map(a=>a.length()*2)));
    const baseline=new Map(this.contacts({focus,cache}).map(c=>[c.key,c.depth]));
    const steps=Math.max(1,Math.ceil(distance/Math.max(.0001,minThickness/2)));
    if(steps>10000)return {fraction:0,blocked:true,message:'单次移动过长，无法安全检查；请分段移动。'};
    let safe=0,hit=null;
    const invalid=()=>this.contacts({focus,cache}).find(c=>c.depth>(baseline.get(c.key)||0)+COLLISION_EPSILON);
    for(let i=1;i<=steps;i++){
      const fraction=i/steps;apply(fraction);hit=invalid();if(hit){
        let lo=safe,hi=fraction;for(let k=0;k<8;k++){const mid=(lo+hi)/2;apply(mid);if(invalid())hi=mid;else lo=mid;}
        apply(lo);return {fraction:lo,blocked:true,message:this.message(hit)};
      }safe=fraction;
    }
    return {fraction:1,blocked:false,message:''};
  }
}

// Validate the original animation before encoding. This never silently "repairs" or hides a collision.
export async function validateAnimation(world,{fps=30,start=0,end=world.duration}={}){
  const detector=new VolumeCollision(world);let samples=0,previous=null;
  const sample=t=>{
    world.evaluate(t);samples++;
    const contacts=detector.contacts({limit:30});
    if(contacts.length)return {ok:false,time:t,frame:Math.round(t*fps),contacts,samples};
    return null;
  };
  const first=sample(start);if(first)return first;
  previous=detector.volumes();
  const frames=Math.ceil((end-start)*fps);
  for(let frame=1;frame<=frames;frame++){
    const t=Math.min(end,start+frame/fps),from=start+(frame-1)/fps;
    world.evaluate(t);const next=detector.volumes(),old=new Map(previous.map(v=>[v.id,v]));let travel=0;
    for(const v of next){const a=old.get(v.id);if(!a)continue;
      let movement=v.center.distanceTo(a.center);for(let i=0;i<3;i++)movement+=v.axes[i].distanceTo(a.axes[i]);travel=Math.max(travel,movement);
    }
    const thickness=Math.min(.02,...next.flatMap(v=>v.axes.map(a=>a.length()*2)));
    const steps=Math.max(4,Math.ceil(travel/Math.max(.0001,thickness/2)));
    if(steps>10000)return {ok:false,time:from,frame:frame-1,contacts:[],samples,error:'运动跨度超出安全检查上限，请拆分动作。'};
    for(let step=1;step<=steps;step++){const failed=sample(from+(t-from)*step/steps);if(failed)return failed;}
    previous=next;if(frame%15===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  return {ok:true,start,end,fps,samples,contacts:[]};
}
