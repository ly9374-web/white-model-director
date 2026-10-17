import { PROJECT } from './project-runtime.js';
const ASPECT=PROJECT.width/PROJECT.height;
import { createWhiteWorld } from './world.js';
import { DirectorModel } from './director-model.js';
import { SCENES, PARTS, FPS, SCHEMA, sceneAt } from './director-catalog.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { TransformControls } from './vendor/TransformControls.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from './vendor/fflate.js';
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';
const $=id=>document.getElementById(id);
const world=createWhiteWorld({container:$('viewport')}),T=world.THREE;
const model=new DirectorModel(world,{liveCollision:false});
document.title=PROJECT.title+' · 导演工作台';
document.querySelector('.sub').textContent=PROJECT.title+' · 目标状态编辑';
world.renderer.domElement.tabIndex=0;
world.renderer.domElement.addEventListener('pointerdown',()=>world.renderer.domElement.focus({preventScroll:true}),{capture:true});
// 时间轴上限与时长标签按本工程实际时长设定，改编后新时长会自动对齐。
$('timeline').max=String(Math.round(world.duration*FPS));
$('seconds').max=String(world.duration);
$('duration-label').textContent=`${world.duration} 秒`;
const observer=new T.PerspectiveCamera(48,1,.08,200);
const orbit=new OrbitControls(observer,world.renderer.domElement);
orbit.enableDamping=true;
// 观察机位由场景内容推导：登记对象（人物/道具/手部/镜头）的包围盒决定取景中心与距离，空骨架回落到原点上方。
function frameScene(){
 const box=new T.Box3();
 for(const e of model.registry.values()){if(e.kind==='ik')continue;box.expandByObject(e.node);}
 const center=box.isEmpty()?new T.Vector3(0,1,0):box.getCenter(new T.Vector3());
 const radius=box.isEmpty()?1:Math.max(.4,box.getSize(new T.Vector3()).length()/2);
 orbit.target.copy(center);
 observer.position.copy(center).add(new T.Vector3(1,1.6,1).normalize().multiplyScalar(Math.max(4,radius*2.6)));
 orbit.update();
}
frameScene();
const controls=new TransformControls(observer,world.renderer.domElement);controls.setSize(.85);
const gizmo=controls.getHelper();gizmo.userData.collisionIgnore=true;world.scene.add(gizmo);
const previewRenderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
previewRenderer.setPixelRatio(Math.min(devicePixelRatio,1.5));previewRenderer.shadowMap.enabled=true;previewRenderer.shadowMap.type=T.PCFSoftShadowMap;
$('preview-canvas').appendChild(previewRenderer.domElement);
// 录制用渲染器：固定 PROJECT.width×PROJECT.height 出片规格，仅由 CSS 缩放到大视图里显示。
const recorderRenderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
recorderRenderer.shadowMap.enabled=true;recorderRenderer.shadowMap.type=T.PCFSoftShadowMap;
recorderRenderer.setSize(PROJECT.width,PROJECT.height,false);
$('record-canvas').appendChild(recorderRenderer.domElement);
const selectionBox=new T.BoxHelper(undefined,0x497ce1);world.scene.add(selectionBox);
const displayCamera=new T.PerspectiveCamera(world.camera.fov,ASPECT,.08,2.5);
const cameraHelper=new T.CameraHelper(displayCamera);world.scene.add(cameraHelper);
const labelGroup=new T.Group();world.scene.add(labelGroup);
const ghostGroup=new T.Group();ghostGroup.userData.collisionIgnore=true;world.scene.add(ghostGroup);
// 观察视角下给选中对象加深色轮廓：白模主角是纯白，在浅灰场景里明度几乎相同、看不清形体；加轮廓后清晰可辨，第一人称预览与导出不受影响。
const outlineGroup=new T.Group();world.scene.add(outlineGroup);
const outlineMaterial=new T.LineBasicMaterial({color:0x1f1f1f,transparent:true,opacity:.6});
const edgeCache=new Map();const outlineItems=[];let outlineId=null;
let selected=null,mode='whole',tool='translate',playing=false,busy=false,previous=performance.now(),needsEvaluate=false,statusTimer,ghostId=null;
let recording=false,encoding=false,recordStartFrame=0,recordStartTime=0;
let width=1,height=1,dragY=0,downPoint=null;
let focusViewId=null,cutawayCache={key:null,objects:[]};
const flightKeys=new Set(),flightCodes=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyI','KeyJ','KeyK','KeyL']);
let flightBoost=false;const OBSERVER_MOVE_BOOST=3;
const isShift=code=>code==='ShiftLeft'||code==='ShiftRight';
let cameraRoll=0,recordingMode='story',recordRestore=null,recordSamples=[],recordSampleIndex=0;
const recordedCamera=new T.PerspectiveCamera();
const CAMERA_DEFAULTS={move:3,lift:3,yaw:90,pitch:60,roll:60};
let cameraSpeeds={...CAMERA_DEFAULTS};
const CAMERA_STORE_KEY='director-camera-settings';
const cameraSettings=[
 {key:'move',label:'WASD 水平',min:.1,max:20,step:.1,unit:'米/秒'},
 {key:'lift',label:'↑↓ 升降',min:.1,max:20,step:.1,unit:'米/秒'},
 {key:'yaw',label:'←/→ 左右转头',min:5,max:180,step:5,unit:'°/秒'},
 {key:'pitch',label:'I/K 俯仰',min:5,max:180,step:5,unit:'°/秒'},
 {key:'roll',label:'J/L 侧倾',min:5,max:180,step:5,unit:'°/秒'}
];
try{const data=JSON.parse(localStorage.getItem(CAMERA_STORE_KEY)||'{}');for(const setting of cameraSettings){const v=data[setting.key];if(Number.isFinite(v))cameraSpeeds[setting.key]=Math.max(setting.min,Math.min(setting.max,v));}}catch{}
function saveCameraSettings(){try{localStorage.setItem(CAMERA_STORE_KEY,JSON.stringify(cameraSpeeds));}catch{}}
function syncCameraSettings(){for(const setting of cameraSettings){const v=cameraSpeeds[setting.key];$('camera-set-'+setting.key).value=String(v);$('camera-number-'+setting.key).value=String(v);}}
function buildCameraSettings(){const panel=$('camera-settings-panel');
 panel.append(Object.assign(document.createElement('div'),{className:'camera-panel-title',textContent:'镜头控制设置'}));
 for(const setting of cameraSettings){
  const row=document.createElement('div');row.className='camera-setting';
  const name=document.createElement('label');name.textContent=setting.label;name.htmlFor='camera-set-'+setting.key;
  const range=document.createElement('input');range.type='range';range.id='camera-set-'+setting.key;
  const number=document.createElement('input');number.type='number';number.id='camera-number-'+setting.key;number.setAttribute('aria-label',setting.label+'速度');
  for(const input of [range,number]){input.min=String(setting.min);input.max=String(setting.max);input.step=String(setting.step);}
  const update=input=>{const v=input.valueAsNumber;if(!Number.isFinite(v)){syncCameraSettings();return;}cameraSpeeds[setting.key]=Math.max(setting.min,Math.min(setting.max,v));saveCameraSettings();syncCameraSettings();};
  range.addEventListener('input',()=>update(range));number.addEventListener('change',()=>update(number));
  const value=document.createElement('div');value.className='camera-setting-value';value.append(number,Object.assign(document.createElement('span'),{textContent:setting.unit}));
  row.append(name,range,value);panel.append(row);
 }
 const reset=document.createElement('button');reset.id='camera-settings-reset';reset.textContent='恢复默认';reset.addEventListener('click',()=>{cameraSpeeds={...CAMERA_DEFAULTS};saveCameraSettings();syncCameraSettings();});panel.append(reset);syncCameraSettings();
}
function setCameraPanel(open){$('camera-settings-panel').hidden=!open;$('camera-settings-toggle').setAttribute('aria-expanded',String(open));}
buildCameraSettings();
// OrbitControls computes the upright orientation; apply roll afterward so mouse orbit does not erase it.
function updateObserver(){orbit.update();observer.rotateZ(cameraRoll);observer.updateMatrixWorld();}
const viewBlockers=[];
for(const group of world.environmentGroups)group.traverse(node=>{if(node.isMesh)viewBlockers.push(node);});
for(const node of Object.values(world.objects))viewBlockers.push(node);
function clearOrbitMotion(){const damping=orbit.enableDamping;orbit.enableDamping=false;orbit.update();orbit.enableDamping=damping;}
function cutawayObjects(camera){
 const e=model.registry.get(focusViewId);if(!e)return [];
 const bounds=new T.Box3().setFromObject(e.node);if(bounds.isEmpty())return [];
 const key=JSON.stringify([focusViewId,camera.position.toArray(),bounds.min.toArray(),bounds.max.toArray(),model.time,model.edits,model.overrides,$('ceilings').checked,$('walls').checked]);
 if(cutawayCache.key===key)return cutawayCache.objects;
 const center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3()),blocked=new Set();
 for(const offset of [-.48,-.36,-.24,-.12,0,.12,.24,.36,.48]){
   const target=center.clone().add(new T.Vector3(0,size.y*offset,0)),direction=target.clone().sub(camera.position),distance=direction.length();
   if(distance<.001)continue;const ray=new T.Raycaster(camera.position,direction.normalize(),.01,distance-.02);
   for(const hit of ray.intersectObjects(viewBlockers,true))if(hit.object.visible)blocked.add(hit.object);
 }
 cutawayCache={key,objects:[...blocked]};return cutawayCache.objects;
}
const sprites={};
for(const id of Object.keys(model.actors)){
  const canvas=document.createElement('canvas');canvas.width=224;canvas.height=64;
  const c=canvas.getContext('2d');c.fillStyle='#ffffffed';c.beginPath();c.roundRect(2,2,220,60,12);c.fill();
  c.fillStyle='#294265';c.font='600 23px sans-serif';c.textAlign='center';c.textBaseline='middle';c.fillText(model.registry.get(id).label,112,32);
  const material=new T.SpriteMaterial({map:new T.CanvasTexture(canvas),depthTest:false,transparent:true});
  const sprite=new T.Sprite(material);sprite.scale.set(1.75,.5,1);sprite.renderOrder=50;sprite.userData.directorId=id;
  labelGroup.add(sprite);sprites[id]=sprite;
}
const sourceHash=Promise.all(['collision.js','world.js','director-model.js','director-catalog.js','timeline.js','project-runtime.js','../project.json'].map(p=>fetch(p).then(r=>{if(!r.ok)throw new Error('无法读取工程版本');return r.text();})))
 .then(async sources=>{const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sources.join('\n')));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');});
function preparePackage(data){return data;}
function notify(message,long=false){$('status').textContent=message;$('status').classList.add('show');clearTimeout(statusTimer);statusTimer=setTimeout(()=>$('status').classList.remove('show'),long?6500:3500);}
// 旧版本工程导出的包按旧场景保存了位置：导入后报告仍与原动画重叠的处数，提示可手动微调。
function importWarning(){const count=model.importWarnings.length;return count?` 其中 ${count} 处位置按旧场景保存，仍与原动画重叠，已原样保留，可在工作台里手动微调。`:'';}
function viewState(){return {position:observer.position.toArray(),target:orbit.target.toArray(),roll:cameraRoll,hideCeilings:$('ceilings').checked,hideWalls:$('walls').checked,focusId:focusViewId};}
function restoreView(v){if(!v)return;clearOrbitMotion();cameraRoll=Number.isFinite(v.roll)?v.roll:0;if(Array.isArray(v.position)&&v.position.length===3&&v.position.every(Number.isFinite))observer.position.fromArray(v.position);
 if(Array.isArray(v.target)&&v.target.length===3&&v.target.every(Number.isFinite))orbit.target.fromArray(v.target);
 if(typeof v.hideCeilings==='boolean')$('ceilings').checked=v.hideCeilings;if(typeof v.hideWalls==='boolean')$('walls').checked=v.hideWalls;focusViewId=model.registry.has(v.focusId)?v.focusId:null;updateObserver();}
function draw(renderer,camera,{firstPerson=false,clean=false,autoCutaway=!(recordingMode==='observer'&&(recording||encoding))}={}){
  const saved=new Map();const visible=(node,v)=>{if(!saved.has(node))saved.set(node,node.visible);node.visible=v;};
  // Observer-only building visibility and protagonist placement body.
  if(world.actors.P01)visible(world.actors.P01.root,false);
  if(!firstPerson){for(const n of model.ceilings)if($('ceilings').checked)visible(n,false);for(const n of model.walls)if($('walls').checked)visible(n,false);}
  // Automatic cutaway is an editing aid; observer recording keeps solid scenery throughout.
  if(!firstPerson&&autoCutaway&&focusViewId)for(const n of cutawayObjects(camera))visible(n,false);
  if(firstPerson&&model.proxy){
    visible(model.proxy.root,true);
    const distance=model.proxy.headBall.getWorldPosition(new T.Vector3()).distanceTo(world.camera.position);
    visible(model.proxy.headBall,distance>.4);
  }
  visible(gizmo,!firstPerson&&!clean&&!playing);
  visible(selectionBox,!firstPerson&&!clean&&!!selected);
  visible(cameraHelper,!firstPerson&&!clean&&(!focusViewId||focusViewId==='C01'));
  visible(labelGroup,!firstPerson&&!clean&&$('labels').checked);
  visible(ghostGroup,!firstPerson&&!clean&&$('ghost').checked&&!playing);
  visible(outlineGroup,!firstPerson&&!clean&&!!selected);
  try{model.applyDeletions(visible);renderer.render(world.scene,camera);}finally{for(const [n,v]of saved)n.visible=v;}
}
function resize(){const rect=$('viewport').getBoundingClientRect();width=Math.max(1,rect.width);height=Math.max(1,rect.height);
  world.renderer.setSize(width,height);world.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));observer.aspect=width/height;observer.updateProjectionMatrix();
  const p=$('preview-canvas').getBoundingClientRect();previewRenderer.setSize(Math.max(1,p.width),Math.max(1,p.height));
}
new ResizeObserver(resize).observe($('viewport'));new ResizeObserver(resize).observe($('preview-canvas'));resize();
function updateHelpers(){
  const e=model.registry.get(selected);selectionBox.visible=!!e&&e.kind!=='ik'&&e.kind!=='camera';if(selectionBox.visible)selectionBox.setFromObject(e.node);
  if(e){e.node.updateWorldMatrix(true,true);
    if(outlineId!==selected){while(outlineGroup.children.length)outlineGroup.remove(outlineGroup.children[0]);outlineItems.length=0;
      e.node.traverse(n=>{if(!n.isMesh||!n.geometry)return;let edges=edgeCache.get(n.geometry.uuid);
        if(!edges){edges=new T.EdgesGeometry(n.geometry,30);edgeCache.set(n.geometry.uuid,edges);}
        const line=new T.LineSegments(edges,outlineMaterial);line.matrixAutoUpdate=false;line.frustumCulled=false;outlineGroup.add(line);outlineItems.push([n,line]);});
      outlineId=selected;}
    for(const [mesh,line]of outlineItems){line.matrix.copy(mesh.matrixWorld);line.matrixWorldNeedsUpdate=true;}
  }else if(outlineId!==null){while(outlineGroup.children.length)outlineGroup.remove(outlineGroup.children[0]);outlineItems.length=0;outlineId=null;}
  displayCamera.position.copy(world.camera.position);displayCamera.quaternion.copy(world.camera.quaternion);displayCamera.updateMatrixWorld(true);
  cameraHelper.update();for(const [id,s]of Object.entries(sprites)){const root=model.actors[id].root;s.visible=root.visible;s.position.copy(root.getWorldPosition(new T.Vector3())).add(new T.Vector3(0,2.25,0));
    const labelHeight=observer.position.distanceTo(s.position)*2*Math.tan(T.MathUtils.degToRad(observer.fov/2))*27/Math.max(1,height);s.scale.set(labelHeight*3.5,labelHeight,1);}
  if($('ghost').checked&&!playing&&e){
    if(ghostId!==selected){for(const child of [...ghostGroup.children]){child.traverse(n=>{if(n.material?.userData?.ghost)n.material.dispose();});ghostGroup.remove(child);}
      const clone=e.node.clone(true);clone.traverse(n=>{if(n.isMesh){n.material=new T.MeshBasicMaterial({color:0x588df4,transparent:true,opacity:.22,depthWrite:false});n.material.userData.ghost=true;n.castShadow=false;n.receiveShadow=false;}});
      ghostGroup.add(clone);ghostId=selected;
    }
    const clone=ghostGroup.children[0];clone.traverse(n=>{const state=model.reference[n.userData.directorId];if(state)model.setLocal(n,state);});
    model.setWorld(clone,new T.Matrix4().fromArray(model.reference[selected].worldMatrix));
  }
}
function render(){updateObserver();updateHelpers();draw(world.renderer,observer,{clean:recording&&recordingMode==='observer'});
  const aspect=world.camera.aspect;world.camera.aspect=ASPECT;world.camera.updateProjectionMatrix();draw(previewRenderer,world.camera,{firstPerson:true});world.camera.aspect=aspect;world.camera.updateProjectionMatrix();}
function pause(){if(playing){playing=false;model.seek(model.time);$('note').value=model.edits.note;notify('已暂停，可编辑这个时间点。');}sync();}
function seek(t){playing=false;model.seek(t);$('note').value=model.edits.note;sync();render();}
function savedOverrides(frame=model.frame){return Object.fromEntries(Object.entries(model.overrides).map(([id,list])=>[id,list.filter(o=>o.startFrame<=frame)]).filter(([,list])=>list.length));}
function restoreSavedMetadata(data){for(const state of data.states){const d=model.drafts.get(state.frame);d.observer=structuredClone(state.observer);d.overrides=structuredClone(state.overrides||Object.fromEntries(Object.entries(data.overrides||{}).map(([id,list])=>[id,list.filter(o=>o.startFrame<=state.frame)]).filter(([,list])=>list.length)));}}
function saveBookmark(){pause();model.edits.note=$('note').value;model.drafts.set(model.frame,{frame:model.frame,time:model.frame/FPS,sceneId:sceneAt(model.time).id,edits:structuredClone(model.edits),overrides:structuredClone(savedOverrides()),observer:viewState()});sync();notify(`已保存 ${sceneAt(model.time).id} · ${model.time.toFixed(2)} 秒的目标状态。`);}
function removeBookmark(frame){
 const draft=model.drafts.get(frame);if(!draft)return;
 model.drafts.delete(frame);
 // 若删的是当前帧，连同该帧引入的固定段一起回退，场景回到未修改状态。
 if(model.frame===frame){
  for(const [id,list]of Object.entries(model.overrides)){const kept=list.filter(o=>o.startFrame!==frame);if(kept.length)model.overrides[id]=kept;else delete model.overrides[id];}
  model.edits={transforms:{},free:{},bindings:{},note:''};$('note').value='';
  model.undoStack=[];model.redoStack=[];
 }
 model.evaluate();sync();render();
 notify(`已移除 ${draft.sceneId} · ${draft.time.toFixed(2)} 秒的目标状态。`);
}
function syncBookmarks(){
 const root=$('bookmarks'),drafts=[...model.drafts.values()].sort((a,b)=>a.frame-b.frame);
 // Keep buttons attached across the periodic UI refresh, including between pointerdown and pointerup.
 const rows=new Map([...root.children].map(row=>[Number(row.dataset.frame),row]));
 for(const [frame,row]of rows)if(!model.drafts.has(frame)){row.remove();rows.delete(frame);}
 drafts.forEach((draft,index)=>{
  let row=rows.get(draft.frame);
  if(!row){
   const frame=draft.frame;row=document.createElement('div');row.className='bookmark';row.dataset.frame=frame;
   const pick=document.createElement('button');pick.type='button';pick.addEventListener('click',()=>{
    const current=model.drafts.get(frame);if(!current)return;
    seek(current.time);restoreView(current.observer);render();
   });
   const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.className='delete';remove.title='移除该目标时间点';
   remove.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();removeBookmark(frame);});
   row.append(pick,remove);
  }
  const label=`${draft.sceneId} · ${draft.time.toFixed(2)}s`;
  if(row.firstElementChild.textContent!==label)row.firstElementChild.textContent=label;
  row.lastElementChild.setAttribute('aria-label',`移除 ${label} 的目标时间点`);
  if(root.children[index]!==row)root.insertBefore(row,root.children[index]||null);
 });
}
function selectedEntry(){return model.isDeleted(selected)?undefined:model.registry.get(selected);}
function defaultPart(id){const head=id+'/head';return !model.isDeleted(head)?head:[...model.registry.values()].find(e=>e.actorId===id&&e.kind==='joint'&&!model.isDeleted(e.id))?.id||id;}
function refreshParts(rootId){const part=$('part');part.replaceChildren();for(const e of model.registry.values())if(e.actorId===rootId&&e.id!==rootId&&!model.isDeleted(e.id)){const o=document.createElement('option');o.value=e.id;o.textContent=e.label;part.append(o);}if(selected.startsWith(rootId+'/'))part.value=selected;}
function select(id){if(!model.registry.has(id)||model.isDeleted(id))return;pause();selected=id;
 focusViewId=null;
 const e=selectedEntry();$('object').value=e.actorId||id;refreshParts(e.actorId);if(e.actorId&&mode!=='whole'&&e.kind==='actor'){selected=defaultPart(e.actorId);$('part').value=selected;}
 attach();sync();render();}
// 没有任何显式选择时，默认落到第一个可编辑对象（新生成场景按 reference.md 规划出的对象顺序决定）。
function selectDefault(){const e=mainEntries.find(x=>x.kind!=='camera')||mainEntries[0];if(e)select(e.id);}
function attach(){const e=selectedEntry();if(!e){controls.detach();return;}
 if(mode==='joint'&&e.kind==='joint')tool='rotate';if(e.kind==='ik')tool='translate';
 controls.attach(e.node);controls.setMode(tool);controls.setSpace($('space').value);
 controls.showX=true;controls.showZ=true;controls.showY=!(tool==='translate'&&e.kind==='actor'&&$('ground').checked);
 document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));
}
function setMode(next){pause();mode=next;const e=selectedEntry();
 if(e&&e.actorId){selected=next==='whole'?e.actorId:(e.kind==='actor'?defaultPart(e.actorId):selected);}
 document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));const cur=selectedEntry();if(cur)refreshParts(cur.actorId);attach();sync();render();}
function sync(){syncBookmarks();syncComponents();const e=selectedEntry();if(!e)return;const scene=sceneAt(model.time);
 $('play').textContent=playing?'暂停并编辑':'播放原动画';$('timeline').value=model.frame;$('seconds').value=model.time.toFixed(3);$('scene').value=scene.id;
 $('time-label').textContent=`${scene.id} · 第 ${model.frame} 帧 / ${Math.round(world.duration*FPS)}`;
 const saved=model.drafts.get(model.frame),unchanged=saved&&JSON.stringify(saved.edits)===JSON.stringify(model.edits)&&JSON.stringify(saved.overrides||{})===JSON.stringify(savedOverrides());
 $('draft-label').textContent=playing?'播放原动画':unchanged?'已保存目标':model.dirty()||model.edits.note.trim()?'目标已修改 · 未保存':'原状态';$('draft-label').classList.toggle('edited',!playing&&(model.dirty()||!!saved));
 $('part-field').hidden=mode==='whole'||!e.actorId;$('part').disabled=playing;$('visible').checked=e.node.visible;
 $('note').disabled=playing;
 $('binding-section').hidden=e.kind!=='prop';$('binding').value=model.bindings[selected]?.owner||'';
 $('reconnect').hidden=!model.edits.free[selected];
 // 取消固定：静态道具被拖动后会自动固定到片尾。选中可固定的道具时始终显示此按钮，未固定则置灰，避免找不到解除入口。
 const canCancel=!!model.overrides[selected],canFix=e.kind==='prop'||!!model.components[selected];
 $('unfix').hidden=!(canCancel||canFix);$('unfix').disabled=!canCancel;$('unfix').title=canCancel?'取消该道具的固定，恢复到原动画位置':'该道具尚未固定；在某帧拖动它就会自动固定并保持到片尾';
 $('undo').disabled=!model.undoStack.length||playing;$('redo').disabled=!model.redoStack.length||playing;
 $('mode-hint').textContent=mode==='whole'?'整体移动人物；主角身体、前景手部、剧情镜头彼此独立。':mode==='joint'?'转动关节保持连接；选择手部目标可拖动摆姿势。':'高级模式：部位可独立平移并离开身体，支持回到关节连接。';
 $('warnings').textContent=model.warnings(selected).join(' ');}
let mainEntries=[];
function refreshObjects(){mainEntries=[...model.registry.values()].filter(e=>!e.id.includes('/')&&!model.isDeleted(e.id));
 $('object-count').textContent=`${mainEntries.length} 个对象`;
 const sel=$('object');sel.replaceChildren();
 for(const e of mainEntries){const option=document.createElement('option');option.value=e.id;option.textContent=e.label;sel.append(option);}
 const cur=selectedEntry();sel.value=cur?(cur.actorId||cur.id):'';}
refreshObjects();
// —— 复制/粘贴组件：副本形象与来源一致，但不复制原动效，编号沿用同类前缀顺延 ——
let clipboard=null;
function copyComponent(){const e=selectedEntry();if(!e||e.id.includes('/')){notify('请选择一个可复制的对象（人物、道具、手部或镜头）。');return;}
 clipboard=e.id;syncComponents();notify(`已复制 ${e.label}；按 Cmd/Ctrl+V 会在它旁边错开约 0.3 米生成副本。`);}
function pasteComponent(){if(!clipboard||!model.registry.has(clipboard)||model.isDeleted(clipboard)){notify('剪贴板为空，请先选中一个对象并按 Cmd/Ctrl+C。');return;}
 pause();const source=model.registry.get(clipboard).label;const id=model.cloneComponent(clipboard);
 if(!id){notify(model.collisionMessage||'来源对象已不存在。',true);return;}
 refreshObjects();select(id);render();sync();
 notify(`已粘贴为 ${id}（复制自 ${source}），位置在来源旁边错开约 0.3 米；形象一致、不带动效。`);}
function refreshSelection(restored){
 refreshObjects();if(restored&&!model.isDeleted(restored))select(restored);
 else if(!selectedEntry())selectDefault();else{refreshParts(selectedEntry().actorId);attach();}
 $('note').value=model.edits.note;sync();render();
}
function applyHistory(action){pause();const restored=action();refreshSelection(restored);}
function removeComponent(id){
 if(recording||encoding||busy||controls.dragging)return false;
 if(id==='C01'){notify('C01 是必需的剧情镜头，不能删除。');return false;}
 const e=model.registry.get(id);if(!e||e.kind==='ik'){notify('请选择要删除的人物、部件或物体。');return false;}
 pause();if(!model.deleteObject(id))return false;
 if(clipboard===id)clipboard=null;refreshSelection();notify(`已删除 ${id}；按 Cmd/Ctrl+Z 可撤销。`);return true;
}
function syncComponents(){const root=$('components'),list=Object.values(model.activeComponents());
 $('components-section').hidden=!list.length;
 const rows=new Map([...root.children].map(row=>[row.dataset.id,row]));
 for(const [id,row]of rows)if(!model.components[id]||model.isDeleted(id)){row.remove();rows.delete(id);}
 for(const [index,c]of list.entries()){
  let row=rows.get(c.id);
  if(!row){row=document.createElement('div');row.className='component-row';row.dataset.id=c.id;
   const pick=document.createElement('button');pick.title='选中副本';pick.addEventListener('click',()=>select(c.id));
   const note=document.createElement('input');note.type='text';note.placeholder='备注（可选）';note.setAttribute('aria-label',c.id+'备注');note.addEventListener('input',()=>model.componentNote(c.id,note.value));
   const del=document.createElement('button');del.textContent='×';del.className='delete';del.title='删除副本';del.addEventListener('click',()=>removeComponent(c.id));row.append(pick,note,del);
  }
  row.firstElementChild.textContent=c.label;const note=row.children[1];if(note!==document.activeElement)note.value=c.note||'';
  if(root.children[index]!==row)root.insertBefore(row,root.children[index]||null);
 }
}
for(const s of SCENES){const o=document.createElement('option');o.value=s.id;o.textContent=`${s.id} · ${s.name}`;$('scene').append(o);}
const unbound=document.createElement('option');unbound.value='';unbound.textContent='解除绑定 · 独立放置';$('binding').append(unbound);
for(const e of model.registry.values())if(['actor','hand'].includes(e.kind)||e.id.endsWith('Palm')){const o=document.createElement('option');o.value=e.id;o.textContent=e.actorId&&e.id.includes('/')?`${e.actorId} · ${e.label}`:e.label;$('binding').append(o);}
$('object').addEventListener('change',()=>select($('object').value));$('part').addEventListener('change',()=>select($('part').value));
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
document.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>{pause();tool=b.dataset.tool;attach();}));
$('space').addEventListener('change',attach);$('ground').addEventListener('change',()=>{attach();sync();});
$('visible').addEventListener('change',()=>{const value=$('visible').checked;pause();model.edit(selected,{visible:value},{space:'local',mode});sync();render();});
$('binding').addEventListener('change',()=>{const value=$('binding').value;pause();model.setBinding(selected,value||null);sync();render();});
function clampJoint(node,id){if(mode!=='joint')return;
 if(/\/e[LR]$/.test(id)){node.rotation.x=Math.max(-2.70,Math.min(.10,node.rotation.x));node.rotation.y=0;node.rotation.z=0;}
 if(/\/k[LR]$/.test(id)){node.rotation.x=Math.max(0,Math.min(2.65,node.rotation.x));node.rotation.y=0;node.rotation.z=0;}}
controls.addEventListener('dragging-changed',e=>{orbit.enabled=!e.value;if(e.value){pause();model.remember();dragY=selectedEntry().node.position.y;}else{if(model.collisionMessage)notify(model.collisionMessage,true);else if(model.autoFix(selected))notify('该道具原本不走位，已固定位置并保持到片尾。');sync();}});
controls.addEventListener('objectChange',()=>{const e=selectedEntry();if(e.kind==='actor'&&$('ground').checked&&tool==='translate')e.node.position.y=dragY;clampJoint(e.node,selected);model.saveNode(selected,mode);if(model.collisionMessage)notify(model.collisionMessage,true);needsEvaluate=true;});
const raycaster=new T.Raycaster();
world.renderer.domElement.addEventListener('pointerdown',event=>{downPoint={x:event.clientX,y:event.clientY,button:event.button};});
world.renderer.domElement.addEventListener('pointerup',event=>{
 if(recording||encoding||!downPoint||downPoint.button!==0||Math.hypot(event.clientX-downPoint.x,event.clientY-downPoint.y)>4||controls.axis)return;
 const rect=world.renderer.domElement.getBoundingClientRect();raycaster.setFromCamera(new T.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),observer);
 const roots=mainEntries.filter(e=>e.kind!=='camera'&&e.node.visible).map(e=>e.node);
 const hits=raycaster.intersectObjects(roots,true);for(const hit of hits){let n=hit.object;let entry=null;while(n){if(n.userData.directorId){entry=model.registry.get(n.userData.directorId);break;}n=n.parent;}
 if(entry&&!model.isDeleted(entry.id)){select(mode==='whole'&&entry.actorId?entry.actorId:entry.id);break;}}
 downPoint=null;
});
function focus(kind='focus'){
 cameraRoll=0;flightKeys.clear();flightBoost=false;
 const e=selectedEntry();
 if(!e){frameScene();render();return;}
 e.node.updateWorldMatrix(true,true);
 const bounds=new T.Box3().setFromObject(e.node),center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3());
 if(bounds.isEmpty()||![...center.toArray(),...size.toArray()].every(Number.isFinite)){center.copy(e.node.getWorldPosition(new T.Vector3()));size.set(1,1,1);}
 if(!center.toArray().every(Number.isFinite)){notify('对象位置无效，请恢复对象后再聚焦。',true);return;}
 clearOrbitMotion();
 const radius=Math.max(.4,size.length()/2),distance=Math.max(2.4,radius/Math.sin(T.MathUtils.degToRad(observer.fov/2))*1.45/Math.min(1,observer.aspect));
 const actor=e.actorId?model.actors[e.actorId].root:null;
 const forward=actor?new T.Vector3(0,0,1).applyQuaternion(actor.getWorldQuaternion(new T.Quaternion())):new T.Vector3(0,0,1);
 const right=actor?new T.Vector3(1,0,0).applyQuaternion(actor.getWorldQuaternion(new T.Quaternion())):new T.Vector3(1,0,0);
 forward.y=right.y=0;forward.normalize();right.normalize();focusViewId=kind==='overview'?null:selected;
 if(kind==='overview'){const box=new T.Box3();for(const it of model.registry.values()){if(it.kind==='ik')continue;box.expandByObject(it.node);}
  const c=box.isEmpty()?new T.Vector3(0,1,0):box.getCenter(new T.Vector3()),r=box.isEmpty()?1:Math.max(.4,box.getSize(new T.Vector3()).length()/2);
  center.copy(c);observer.position.copy(c).add(new T.Vector3(1,1.6,1).normalize().multiplyScalar(Math.max(6,r*3)));}
 else if(kind==='top')observer.position.copy(center).add(new T.Vector3(0,distance,.001));
 else if(kind==='front')observer.position.copy(center).addScaledVector(forward,distance).add(new T.Vector3(0,distance*.08,0));
 else if(kind==='side')observer.position.copy(center).addScaledVector(right,distance).add(new T.Vector3(0,distance*.08,0));
 else observer.position.copy(center).addScaledVector(forward,distance*.72).addScaledVector(right,distance*.5).add(new T.Vector3(0,distance*.5,0));
 orbit.target.copy(center);orbit.update();render();
}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>focus(b.dataset.view)));
$('focus').addEventListener('click',()=>focus());
$('camera-settings-toggle').addEventListener('click',()=>setCameraPanel($('camera-settings-panel').hidden));
for(const id of ['ceilings','walls','ghost','labels'])$(id).addEventListener('change',render);
$('play').addEventListener('click',()=>{
 // 录制/生成期间，「暂停」键即「停止」的快捷键。
 if(recording){stopRecording();return;}if(encoding)return;
 if(playing){pause();return;}if(model.time>=world.duration)seek(0);model.edits={transforms:{},free:{},bindings:{},note:''};playing=true;previous=performance.now();sync();notify('播放原动画；只有已点击保存的目标时间点会保留。');
});
$('timeline').addEventListener('input',()=>seek(Number($('timeline').value)/FPS));
$('seconds').addEventListener('change',()=>{const n=Number($('seconds').value);if(Number.isFinite(n))seek(n);});
$('prev').addEventListener('click',()=>seek(model.time-5));$('next').addEventListener('click',()=>seek(model.time+5));
$('scene').addEventListener('change',()=>{const s=SCENES.find(s=>s.id===$('scene').value);if(!s)return;seek(s.start);if(mainEntries.length){selectDefault();focus();}else focus('overview');});
$('note').addEventListener('input',()=>{if(playing)pause();model.edits.note=$('note').value;});$('bookmark').addEventListener('click',saveBookmark);
if($('copyComponent'))$('copyComponent').addEventListener('click',copyComponent);if($('pasteComponent'))$('pasteComponent').addEventListener('click',pasteComponent);
for(const [id,action]of [['undo',()=>model.undo()],['redo',()=>model.redo()],['restore',()=>model.restore(selected)],['reconnect',()=>model.reconnect(selected)],['unfix',()=>model.clearOverride(selected)]])$(id).addEventListener('click',()=>{applyHistory(action);});
window.addEventListener('keydown',event=>{
 // Observer recording accepts only movement keys; object editing stays locked.
 if(encoding){event.preventDefault();return;}
 if(recording){
  if(event.code==='Escape'||event.code==='Space'){event.preventDefault();stopRecording();return;}
  if(recordingMode==='observer'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){if(isShift(event.code))flightBoost=event.shiftKey;else if(flightCodes.has(event.code)){event.preventDefault();flightBoost=event.shiftKey;flightKeys.add(event.code);}}
  return;
 }
 if(event.code==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
  const tag=document.activeElement?.tagName;
  if(!['INPUT','SELECT','BUTTON'].includes(tag)&&(tag!=='TEXTAREA'||document.activeElement===$('note'))){event.preventDefault();saveBookmark();return;}
 }
 if(busy)return;
 if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable)return;
 if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&(event.code==='Delete'||event.code==='Backspace')){event.preventDefault();if(!event.repeat)removeComponent(selected);return;}
 if((event.ctrlKey||event.metaKey)&&event.code==='KeyC'){event.preventDefault();copyComponent();return;}
 if((event.ctrlKey||event.metaKey)&&event.code==='KeyV'){event.preventDefault();pasteComponent();return;}
 if(!event.ctrlKey&&!event.metaKey&&!event.altKey){
  if(isShift(event.code)){flightBoost=event.shiftKey;return;}
  if(flightCodes.has(event.code)){event.preventDefault();flightBoost=event.shiftKey;flightKeys.add(event.code);return;}
 }
 if(event.code==='Space'){event.preventDefault();$('play').click();}
 if((event.ctrlKey||event.metaKey)&&event.code==='KeyZ'){event.preventDefault();pause();applyHistory(()=>event.shiftKey?model.redo():model.undo());}
 if(event.code==='KeyF')focus();
});
window.addEventListener('keyup',event=>{flightKeys.delete(event.code);flightBoost=event.shiftKey;});
window.addEventListener('blur',()=>{flightKeys.clear();flightBoost=false;});
document.addEventListener('focusin',event=>{if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)){flightKeys.clear();flightBoost=false;}});
function fly(dt){
 if(!flightKeys.size||controls.dragging||busy)return;
 const forward=observer.getWorldDirection(new T.Vector3()),horizontal=forward.clone();horizontal.y=0;
 if(horizontal.lengthSq()<1e-6){horizontal.set(0,1,0).applyQuaternion(observer.quaternion);horizontal.y=0;}
 horizontal.normalize();const right=new T.Vector3().crossVectors(horizontal,new T.Vector3(0,1,0)).normalize();
 const key=code=>flightKeys.has(code)?1:0;
 const moveBoost=flightBoost?OBSERVER_MOVE_BOOST:1;
 const delta=horizontal.clone().multiplyScalar(key('KeyW')-key('KeyS')).addScaledVector(right,key('KeyD')-key('KeyA'));
 if(delta.lengthSq())delta.normalize().multiplyScalar(dt*cameraSpeeds.move*moveBoost);
 delta.y=(key('ArrowUp')-key('ArrowDown'))*dt*cameraSpeeds.lift*moveBoost;
 observer.position.add(delta);orbit.target.add(delta);
 const pitch=(key('KeyI')-key('KeyK'))*dt*T.MathUtils.degToRad(cameraSpeeds.pitch);
 if(pitch){
  clearOrbitMotion();const distance=Math.max(.01,observer.position.distanceTo(orbit.target));
  const angle=T.MathUtils.clamp(Math.asin(T.MathUtils.clamp(forward.y,-1,1))+pitch,-Math.PI/2+.01,Math.PI/2-.01);
  const direction=horizontal.clone().multiplyScalar(Math.cos(angle));direction.y=Math.sin(angle);
  orbit.target.copy(observer.position).addScaledVector(direction,distance);
 }
 // J/L follow the requested camera tilt direction; screen rotation is inverse to camera roll.
 cameraRoll+=(key('KeyJ')-key('KeyL'))*dt*T.MathUtils.degToRad(cameraSpeeds.roll);
 cameraRoll=T.MathUtils.euclideanModulo(cameraRoll+Math.PI,Math.PI*2)-Math.PI;
 const yaw=(key('ArrowLeft')-key('ArrowRight'))*dt*T.MathUtils.degToRad(cameraSpeeds.yaw);
 // Turn the view about the camera's own position; mouse orbit keeps its separate pivot behavior.
 if(yaw){
  const position=observer.position.clone(),direction=orbit.target.clone().sub(position);
  clearOrbitMotion();observer.position.copy(position);
  direction.applyAxisAngle(new T.Vector3(0,1,0),yaw);
  orbit.target.copy(position).add(direction);
 }
}
function dataBytes(uri){const raw=atob(uri.split(',')[1]);return Uint8Array.from(raw,c=>c.charCodeAt(0));}
// 复制记录：写清每个副本“复制了什么、粘贴在哪里、编号是什么、备注是什么”。
function componentRecord(){
 const list=Object.values(model.components);
 if(!list.length)return '# 复制组件记录\n\n本次没有复制任何组件。\n';
 const rows=list.map(c=>{
  const source=model.registry.get(c.sourceId),name=(source?source.label:c.sourceId)+(model.isDeleted(c.id)?'（此副本已删除，仅保留来源记录）':'');
  const pos=`(${c.matrix[12].toFixed(3)}, ${c.matrix[13].toFixed(3)}, ${c.matrix[14].toFixed(3)})`;
  return `- ${c.id}｜复制自 ${c.sourceId}（${name}）｜粘贴位置（世界坐标）${pos}｜复制时第 ${Number.isInteger(c.at)?c.at:'-'} 帧｜备注：${c.note||'（无）'}`;});
 return `# 复制组件记录\n\n本次共 ${list.length} 个副本。副本与来源形象一致，但不带原动效；编号沿用同类前缀顺延。若移动过副本，其位置会像静态道具一样自动固定到片尾（记在 states.json 的 overrides 里）。\n\n${rows.join('\n')}\n`;}
async function exportBundle(){
 pause();if(!model.drafts.size)throw new Error('还没有保存时间点。请先点击“保存这个时间点”，再下载修改包。');
 const current={time:model.time,edits:structuredClone(model.edits),overrides:structuredClone(model.overrides),undo:structuredClone(model.undoStack),redo:structuredClone(model.redoStack),view:viewState(),selected};
 const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.setSize(1280,720);
 const states=[],files={},includedOverrides={};
 try{
  for(const d of [...model.drafts.values()].sort((a,b)=>a.frame-b.frame)){
   model.time=d.frame/FPS;model.edits=structuredClone(d.edits);model.overrides=structuredClone(d.overrides||{});model.evaluate();restoreView(d.observer||current.view);
   for(const [id,list]of Object.entries(model.overrides)){const merged=new Map((includedOverrides[id]||[]).map(o=>[o.startFrame,o]));for(const o of list)merged.set(o.startFrame,o);includedOverrides[id]=[...merged.values()].sort((a,b)=>a.startFrame-b.startFrame);}
   const path=`states/${sceneAt(model.time).id}-frame-${String(d.frame).padStart(4,'0')}`;
   const aspect=observer.aspect;observer.aspect=ASPECT;observer.updateProjectionMatrix();draw(renderer,observer,{clean:true});files[`${path}/上帝视角.png`]=dataBytes(renderer.domElement.toDataURL('image/png'));observer.aspect=aspect;observer.updateProjectionMatrix();
   const ca=world.camera.aspect;world.camera.aspect=ASPECT;world.camera.updateProjectionMatrix();draw(renderer,world.camera,{firstPerson:true,clean:true});files[`${path}/第一人称.png`]=dataBytes(renderer.domElement.toDataURL('image/png'));world.camera.aspect=ca;world.camera.updateProjectionMatrix();
   const state=model.state(viewState());state.overrides=structuredClone(model.overrides);state.screenshots={observer:`${path}/上帝视角.png`,firstPerson:`${path}/第一人称.png`};states.push(state);
   const fixed=Object.keys(model.overrides).filter(id=>model.activeOverride(id));
   files[`${path}/走位说明.md`]=strToU8(`# ${state.sceneId} · ${state.timeSeconds.toFixed(3)} 秒\n\n${state.note||'（尚未填写走位说明）'}\n${fixed.length?`\n已固定位置（保持到片尾）：${fixed.join('、')}\n`:''}`);
   await new Promise(resolve=>requestAnimationFrame(resolve));
  }
  const data={format:'white-model-director',schemaVersion:SCHEMA,project:{id:PROJECT.id,sourceHash:await sourceHash},fps:FPS,durationSeconds:world.duration,
   coordinates:{units:'meters',up:'Y',transforms:'parent-local position/quaternion/scale; world values are reference',rotation:'quaternion [x,y,z,w]'},
   behavior:'target states only; no automatic animation interpolation',decisions:{collisionChecks:'generation-only',freeDirectorEditing:true,observerWithFirstPerson:true,editingModes:['whole','joint','free'],attachmentToggle:true,protagonistCameraAndHands:'independent',multipleStates:true},components:structuredClone(model.components),deletedObjects:[...model.deletedObjects],states,overrides:includedOverrides};
  files['复制记录.md']=strToU8(componentRecord());
  const json=strToU8(JSON.stringify(data,null,2));
  if(states.length>500||json.length>128*1024*1024)throw new Error('目标时间点过多，请移除部分书签后再分批下载。');
  files['states.json']=json;
  files['交给我的说明.md']=strToU8('# 白膜目标状态修改包\n\n## 固定修改指令\n\n当我将这个文件给你之后规划一下怎么修改，规划完成后我需要你问我一轮，是否有什么我的指令模糊或者互相冲突让我澄清一下，澄清后再改\n\n## 修改包使用说明\n\n把整个 ZIP 上传到聊天，或放进项目文件夹并提供路径。\n\n告诉我：需要修改哪些 S / P / O 编号，人物从哪里开始、如何绕行、何时到达、最后朝向哪里，以及需要保留哪些部分。每个时间点的提示词也已写在对应目录中。\n\n这些是自由编辑的目标状态，不是已经重写的连续动画。导演台不检查碰撞；将目标改写为 Three.js 原始剧情动画时，需要在生成验收阶段检查完整动画。states.json 中包含工程版本、原状态、目标状态、关节、绑定、镜头和坐标。需要同一版本工程恢复；不包含三维模型和依赖。\n\n原本不走位、也不随人物移动的道具被移动后，会自动固定位置：states.json 的 overrides 记录每个道具的起始帧与变换，从该帧起保持到片尾，不会再闪回原位。绑定或随人物移动的道具（如手持物）不固定。\n\n剧情镜头 C01 与前景手部彼此独立，人物身体与其定位身体也各自独立。\n\n如果复制/粘贴过组件：states.json 的顶层 components 记录每个副本的来源、编号、世界矩阵与备注，副本不带原动效；复制记录.md 逐条说明“复制了什么、粘贴在哪里、编号是什么、备注是什么”。导入时会按这些记录还原副本。\n');
  const bytes=zipSync(files,{level:6});if(bytes.length>128*1024*1024)throw new Error('修改包过大，请分批保存目标时间点。');return {bytes,data};
 }finally{renderer.dispose();model.time=current.time;model.edits=current.edits;model.overrides=current.overrides;model.undoStack=current.undo;model.redoStack=current.redo;model.evaluate();restoreView(current.view);selected=current.selected;attach();sync();render();}
}
$('export').addEventListener('click',async()=>{
 if(busy)return;busy=true;document.body.classList.add('exporting');$('export').disabled=true;notify('正在保存各时间点的两种视角与状态…',true);
 try{const result=await exportBundle();const url=URL.createObjectURL(new Blob([result.bytes],{type:'application/zip'}));const a=document.createElement('a');a.href=url;a.download=`白膜修改包-${result.data.states.length}个时间点.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);notify('修改包已下载。把 ZIP 和补充要求交给我即可。',true);}catch(e){notify(`下载失败：${e.message}`,true);}finally{busy=false;document.body.classList.remove('exporting');$('export').disabled=false;}
});
$('import').addEventListener('click',()=>$('file').click());
$('file').addEventListener('change',async()=>{
 const f=$('file').files[0];if(!f)return;pause();
 try{const bytes=new Uint8Array(await f.arrayBuffer());if(bytes.length>128*1024*1024)throw new Error('文件超过 128 MB。');
  let text;if(f.name.toLowerCase().endsWith('.zip')){const zip=unzipSync(bytes,{filter:entry=>entry.name==='states.json'&&entry.originalSize<=128*1024*1024});if(!zip['states.json'])throw new Error('修改包缺少 states.json。');text=strFromU8(zip['states.json']);}else text=strFromU8(bytes);
  const hash=await sourceHash,data=preparePackage(JSON.parse(text),hash),first=model.importPackage(data,hash);restoreSavedMetadata(data);refreshObjects();
  $('note').value=model.edits.note;restoreView(first.observer);sync();render();notify(`已恢复 ${data.states.length} 个目标时间点。${importWarning()}`,true);
 }catch(e){notify(`未导入：${e.message}`,true);}finally{$('file').value='';}
});

$('check-collisions').addEventListener('click',async()=>{
 if(busy)return;pause();busy=true;$('check-collisions').disabled=true;
 notify('正在检查原动画中所有模型的体积碰撞…',true);
 const time=model.time;
 try{const report=await world.validateCollisions({fps:FPS});window.__director.lastCollisionReport=report;
  if(report.ok)notify('原动画体积碰撞检查通过，可以录制。',true);
  else{const first=report.contacts[0];notify(`${report.time.toFixed(3)} 秒发现模型重叠：${first?`${first.labelA} / ${first.labelB}`:report.error}。需修正后再生成视频。`,true);}
 }catch(e){notify(`碰撞检查失败：${e.message}`,true);}finally{model.evaluate(time);render();busy=false;$('check-collisions').disabled=false;}
});

// Both recording modes replay the scene by frame; observer mode also replays the captured camera path.
function setPreviewTitle(main,sub){$('preview-main').textContent=main;$('preview-sub').textContent=sub;}
function setRecProgress(ratio,text){const bar=$('rec-bar-fill');if(bar)bar.style.width=`${Math.round(Math.max(0,Math.min(1,ratio))*100)}%`;const label=$('rec-progress-text');if(label)label.textContent=text;}
function captureObserver(){return {time:model.time,position:observer.position.toArray(),quaternion:observer.quaternion.toArray(),fov:observer.fov,aspect:observer.aspect,near:observer.near,far:observer.far};}
function replayObserver(time){
 while(recordSampleIndex<recordSamples.length-2&&recordSamples[recordSampleIndex+1].time<=time)recordSampleIndex++;
 const a=recordSamples[recordSampleIndex],b=recordSamples[Math.min(recordSampleIndex+1,recordSamples.length-1)];
 const amount=b.time>a.time?T.MathUtils.clamp((time-a.time)/(b.time-a.time),0,1):0;
 recordedCamera.position.fromArray(a.position).lerp(new T.Vector3(...b.position),amount);
 recordedCamera.quaternion.fromArray(a.quaternion).slerp(new T.Quaternion(...b.quaternion),amount);
 for(const key of ['fov','aspect','near','far'])recordedCamera[key]=T.MathUtils.lerp(a[key],b[key],amount);
 recordedCamera.updateProjectionMatrix();recordedCamera.updateMatrixWorld();return recordedCamera;
}
function drawRecorder(camera=world.camera){
 const third=recordingMode==='observer',aspect=camera.aspect;
 if(!third){camera.aspect=ASPECT;camera.updateProjectionMatrix();}
 const w=third?Math.min(PROJECT.width,Math.round(PROJECT.height*camera.aspect)):PROJECT.width;
 const h=third?Math.min(PROJECT.height,Math.round(PROJECT.width/camera.aspect)):PROJECT.height;
 // Clear the whole output, then render into a fitted viewport to preserve the complete composition.
 recorderRenderer.setScissorTest(false);recorderRenderer.setViewport(0,0,PROJECT.width,PROJECT.height);recorderRenderer.setClearColor(0x000000,1);recorderRenderer.clear();
 const x=Math.floor((PROJECT.width-w)/2),y=Math.floor((PROJECT.height-h)/2);
 recorderRenderer.setViewport(x,y,w,h);recorderRenderer.setScissor(x,y,w,h);recorderRenderer.setScissorTest(true);
 try{draw(recorderRenderer,camera,{firstPerson:!third,clean:true,autoCutaway:false});}
 finally{recorderRenderer.setScissorTest(false);recorderRenderer.setViewport(0,0,PROJECT.width,PROJECT.height);if(!third){camera.aspect=aspect;camera.updateProjectionMatrix();}}
}
function startRecording(nextMode='story'){
 if(recording||encoding||busy)return;
 if(playing)pause();
 if(model.time>=world.duration-1e-3)seek(0);
 clearOrbitMotion();updateObserver();
 recordingMode=nextMode==='observer'?'observer':'story';
 recordStartFrame=model.frame;recordStartTime=model.time;
 recordRestore={view:viewState(),edits:structuredClone(model.edits),orbitEnabled:orbit.enabled,controlsEnabled:controls.enabled};
 recordSamples=[];recordSampleIndex=0;
 if(recordingMode==='observer')recordSamples.push(captureObserver());
 recording=true;flightKeys.clear();flightBoost=false;downPoint=null;setCameraPanel(false);
 controls.enabled=false;orbit.enabled=recordingMode==='observer';
 document.activeElement?.blur();world.renderer.domElement.focus({preventScroll:true});
 document.body.classList.add('recording');document.body.classList.toggle('recording-observer',recordingMode==='observer');
 const active=recordingMode==='observer'?'record-observer':'record',other=recordingMode==='observer'?'record':'record-observer';
 $(active).textContent='停止';$(active).classList.add('rec-active');$(other).disabled=true;
 $('play').textContent='停止';$('play').classList.add('rec-active');
 $('record-screen').hidden=false;$('rec-progress').hidden=false;
 $('rec-instruction').textContent=recordingMode==='observer'?'可运镜 · 空格或「停止」结束录像':'视角已锁定 · 空格或「停止」结束录像';
 setPreviewTitle(recordingMode==='observer'?'第一人称预览':'自由视角','录制中');
 setRecProgress(0,'录制中 · 0.0 秒');$('rec-elapsed').textContent='0.0 秒';
 if(recordingMode==='observer')render();else{drawRecorder();draw(previewRenderer,observer);}
 notify(recordingMode==='observer'?'第三人称录制中：可用键盘和鼠标运镜，空格或「停止」导出 MP4。':'录制中：视角已锁定，空格或「停止」导出 MP4。',true);
}
function recordTick(dt){
 if(!recording)return;
 const t=Math.min(world.duration,model.time+dt);
 model.time=t;model.frame=Math.round(t*FPS);model.evaluate(t,true);
 if(recordingMode==='observer'){fly(dt);render();recordSamples.push(captureObserver());}
 else{drawRecorder();draw(previewRenderer,observer);}
 const elapsed=Math.max(0,model.time-recordStartTime);
 $('rec-elapsed').textContent=`${elapsed.toFixed(1)} 秒`;
 setRecProgress(elapsed/Math.max(.001,world.duration-recordStartTime),`录制中 · ${elapsed.toFixed(1)} 秒`);
 if(model.time>=world.duration-1e-4)stopRecording();
}
async function stopRecording(){
 if(!recording)return;
 recording=false;encoding=true;flightKeys.clear();flightBoost=false;orbit.enabled=false;setCameraPanel(false);
 const endFrame=model.frame,endTime=model.time;
 window.__director.lastRecording={mode:recordingMode,startFrame:recordStartFrame,endFrame,samples:structuredClone(recordSamples),view:structuredClone(recordRestore.view)};
 for(const id of ['record','record-observer'])$(id).disabled=true;
 const active=recordingMode==='observer'?'record-observer':'record';$(active).textContent='生成中…';
 $('record-screen').hidden=false;document.body.classList.remove('recording-observer');
 setPreviewTitle('正在生成 MP4','逐帧重渲染');notify('正在逐帧重渲染并编码 MP4，请稍候…',true);
 try{
  const blob=await encodeClip(recordStartFrame,endFrame);
  if(blob){
   const url=URL.createObjectURL(blob),a=document.createElement('a');
   a.href=url;a.download=`${recordingMode==='observer'?'白模第三人称录制':'白模录制'}-${recordStartTime.toFixed(1)}s-${endTime.toFixed(1)}s.mp4`;a.click();
   setTimeout(()=>URL.revokeObjectURL(url),60000);notify(`已导出 ${a.download}（${(blob.size/1048576).toFixed(1)} MB）。`,true);
  }else notify('录制不足一帧，未生成文件。',true);
 }catch(e){notify(`录制导出失败：${e.message}`,true);}
 finally{
  encoding=false;recordSamples=[];
  recorderRenderer.setSize(PROJECT.width,PROJECT.height,false);
  $('record-screen').hidden=true;$('rec-progress').hidden=true;setRecProgress(0,'');
  for(const [id,label]of [['record','录制'],['record-observer','第三人称录制']]){$(id).disabled=false;$(id).textContent=label;$(id).classList.remove('rec-active');}
  $('play').classList.remove('rec-active');document.body.classList.remove('recording','recording-observer');
  setPreviewTitle('第一人称预览','剧情镜头 C01');
  model.time=recordStartTime;model.frame=recordStartFrame;model.edits=recordRestore.edits;model.evaluate(recordStartTime,true);
  restoreView(recordRestore.view);controls.enabled=recordRestore.controlsEnabled;orbit.enabled=recordRestore.orbitEnabled;
  attach();sync();render();
 }
}
async function pickAvcCodec(){
 if(typeof VideoEncoder==='undefined')return null;
 for(const codec of ['avc1.640028','avc1.4d0028','avc1.42002a','avc1.42e02a']){
  try{const result=await VideoEncoder.isConfigSupported({codec,width:PROJECT.width,height:PROJECT.height,framerate:FPS});if(result.supported)return codec;}catch{}
 }
 return null;
}
async function encodeClip(startFrame,endFrame){
 const total=endFrame-startFrame+1;
 if(total<2)return null;
 const codec=await pickAvcCodec();
 if(!codec)throw new Error('当前浏览器不支持 WebCodecs H.264 编码，请用最新版 Chrome 或 Safari 打开工作台。');
 const muxer=new Muxer({target:new ArrayBufferTarget(),fastStart:'in-memory',video:{codec:'avc',width:PROJECT.width,height:PROJECT.height,frameRate:FPS}});
 let encodeError=null;
 const encoder=new VideoEncoder({output:(chunk,meta)=>muxer.addVideoChunk(chunk,meta),error:e=>{encodeError=e;}});
 encoder.configure({codec,width:PROJECT.width,height:PROJECT.height,bitrate:12_000_000,framerate:FPS});
 recorderRenderer.setSize(PROJECT.width,PROJECT.height,false);
 recordSampleIndex=0;
 try{
  for(let i=0;i<total;i++){
   if(encodeError)throw encodeError;
   const frameIndex=startFrame+i;
   model.time=frameIndex/FPS;model.frame=frameIndex;model.evaluate(frameIndex/FPS,true);
   const camera=recordingMode==='observer'?replayObserver(frameIndex/FPS):world.camera;
   drawRecorder(camera);
   const videoFrame=new VideoFrame(recorderRenderer.domElement,{timestamp:Math.round(i*1000000/FPS),duration:Math.round(1000000/FPS)});
   encoder.encode(videoFrame,{keyFrame:i%FPS===0});
   videoFrame.close();
   draw(previewRenderer,observer);
   setRecProgress((i+1)/total,`正在生成 · ${i+1}/${total} 帧`);
   if(encoder.encodeQueueSize>8)await new Promise(resolve=>setTimeout(resolve));
   else if(i%3===0)await new Promise(resolve=>requestAnimationFrame(resolve));
  }
  await encoder.flush();
 }finally{
  try{encoder.close();}catch{}
 }
 if(encodeError)throw encodeError;
 muxer.finalize();
 return new Blob([muxer.target.buffer],{type:'video/mp4'});
}
$('record').addEventListener('click',()=>{if(recording)stopRecording();else startRecording('story');});
$('record-observer').addEventListener('click',()=>{if(recording)stopRecording();else startRecording('observer');});

window.__director={ready:true,seek,select,setMode,edit:(id,values,options)=>{pause();model.edit(id,values,options);if(model.collisionMessage)notify(model.collisionMessage,true);sync();render();},
 bind:(id,owner)=>{pause();model.setBinding(id,owner);sync();render();},collisions:()=>model.collisionContacts(),pose:id=>model.pose(model.registry.get(id).node),state:()=>model.state(viewState()),
 bookmark:saveBookmark,undo:()=>applyHistory(()=>model.undo()),redo:()=>applyHistory(()=>model.redo()),exportBundle,
 recording:()=>recording,startRecording,stopRecording,
 cameraProbe:()=>({...captureObserver(),roll:cameraRoll,target:orbit.target.toArray(),speeds:{...cameraSpeeds}}),
 recordingProbe:()=>({recording,encoding,mode:recordingMode,sampleCount:recordSamples.length}),
 copyComponent,pasteComponent,componentNote:(id,note)=>{model.componentNote(id,note);sync();},removeComponent,cloneComponent:(id,options)=>{const n=model.cloneComponent(id,options);refreshObjects();render();sync();return n;},
 importPackage:async data=>{const hash=await sourceHash;data=preparePackage(data,hash);const s=model.importPackage(data,hash);restoreSavedMetadata(data);refreshObjects();$('note').value=model.edits.note;restoreView(s.observer);sync();render();},
 inspect:()=>({time:model.time,frame:model.frame,selected,mode,tool,playing,bookmarks:[...model.drafts.keys()],overrides:Object.keys(model.overrides),components:{...model.activeComponents()},deletedObjects:[...model.deletedObjects],warnings:model.warnings(selected)}),sourceHash:()=>sourceHash,
 viewProbe:()=>{const e=selectedEntry();if(!e)return {view:viewState(),bounds:null,projected:[],cutawayCount:cutawayObjects(observer).length};const bounds=new T.Box3().setFromObject(e.node),points=[];for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])points.push(new T.Vector3(x,y,z).project(observer).toArray());return {view:viewState(),bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},projected:points,cutawayCount:cutawayObjects(observer).length};},
 projectPoint:position=>{const p=new T.Vector3(...position).project(observer),r=world.renderer.domElement.getBoundingClientRect();return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};}};
// bootstrap：新场景若已登记可编辑对象则默认选中第一个，否则只取全局全景等待规划。
if(mainEntries.length){selectDefault();focus();}else{frameScene();render();}
notify('先选场景和时间，再拖动对象；目标状态不会自动改写原动画。',true);
let lastUI=0;
(function loop(now){const dt=Math.min(.1,(now-previous)/1000);previous=now;
 if(recording||encoding){if(recording)recordTick(dt);requestAnimationFrame(loop);return;}
 if(!busy){if(playing){model.time=Math.min(world.duration,model.time+dt*Number($('speed').value));model.evaluate(model.time,false);if(model.time>=world.duration)pause();}
 else if(needsEvaluate){model.evaluate();needsEvaluate=false;}
 fly(dt);render();if(now-lastUI>120){sync();lastUI=now;}}
 requestAnimationFrame(loop);
})(performance.now());
