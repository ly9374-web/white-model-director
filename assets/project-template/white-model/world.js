import { VolumeCollision, validateAnimation } from './collision.js';
import * as THREE from './three.module.js';
import { DURATION, storyTime, playbackTime } from './timeline.js';

export function createWhiteWorld({ container = document.body, autoPlay = false } = {}) {

/* ============================================================
   通用白模引擎骨架（每次新任务都应替换场景与剧情）：
   这里只保留渲染器、场景、相机、材质工厂、几何工具、人形骨架工厂，
   以及一块灰地面、网格和灯光；没有人物、道具和剧情。
   update(t) 保持纯函数，可被录制脚本逐帧 seek，实现确定性 30fps 输出。
   新任务：按 reference.md 在本文件中搭建空间、人物与动作，替换空场景；
   人物/道具/手分别注册到 actors / objects / hands。
   ============================================================ */

const params = new URLSearchParams(location.search);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- 渲染基础 ----------
// preserveDrawingBuffer: 录制模式下 seek() 在 rAF 之外渲染，需保留缓冲区供截图
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xececec);

// 默认剧情镜头 C01：白模预演的成片相机。新任务按 reference 规划机位与运动。
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.08, 200);
camera.position.set(4, 2.4, 6);
camera.lookAt(0, 1, 0);

// ---------- 材质工厂（所有材质统一在这里创建） ----------
const MAT = {
  wall: new THREE.MeshStandardMaterial({ color: 0xdadada, roughness: .95 }),
  floor: new THREE.MeshStandardMaterial({ color: 0xcbcbcb, roughness: .97 }),
  prop: new THREE.MeshStandardMaterial({ color: 0xe2e2e2, roughness: .9 }),
  trim: new THREE.MeshStandardMaterial({ color: 0xc2c2c2, roughness: .9 }),
  figure: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: .85 }),   // 默认白模人物
  proxy: new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: .85 }),    // 导演台定位身体
};

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}
function ball(r, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}
function limb(r, len, mat) { // 沿 -y 方向的圆柱肢体
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * .88, len, 10), mat);
  m.position.y = -len / 2; m.castShadow = true;
  return m;
}

// ---------- 空场景：灰地面 + 网格 ----------
const ground = new THREE.Group(); ground.name = 'ground'; scene.add(ground);
ground.add(box(40, .12, 40, MAT.floor, 0, -.06, 0));
const grid = new THREE.GridHelper(40, 80, 0x9c9c9c, 0xb2b2b2);
grid.position.y = .012;
grid.material.transparent = true; grid.material.opacity = .3;
ground.add(grid);

// ---------- 人形骨架（纯几何拼装：盒 + 球 + 圆柱肢体） ----------
// 新任务按实际对象构造模型；动物、车辆等不使用这套人形骨架。
function makeFigure(mat = MAT.figure) {
  const root = new THREE.Group();
  const pelvis = new THREE.Group(); root.add(pelvis);
  pelvis.add(box(.36, .18, .24, mat));
  const torso = new THREE.Group(); pelvis.add(torso); torso.position.y = .09;
  torso.add(box(.44, .5, .27, mat, 0, .33, 0));
  const head = new THREE.Group(); torso.add(head); head.position.y = .68;
  const headBall = ball(.155, mat, 0, .13, 0); head.add(headBall);
  const arm = side => {
    const shoulder = new THREE.Group(); torso.add(shoulder); shoulder.position.set(side * .27, .56, 0);
    shoulder.add(limb(.055, .3, mat));
    const elbow = new THREE.Group(); shoulder.add(elbow); elbow.position.y = -.3;
    elbow.add(limb(.048, .28, mat));
    elbow.add(box(.07, .1, .05, mat, 0, -.33, 0));
    return { shoulder, elbow };
  };
  const leg = side => {
    const hip = new THREE.Group(); pelvis.add(hip); hip.position.set(side * .11, -.06, 0);
    hip.add(limb(.075, .42, mat));
    const knee = new THREE.Group(); hip.add(knee); knee.position.y = -.42;
    knee.add(limb(.06, .4, mat));
    const foot = box(.1, .06, .24, mat, 0, -.42, .06); knee.add(foot);
    return { hip, knee, foot };
  };
  const L = arm(-1), R = arm(1), lL = leg(-1), lR = leg(1);
  scene.add(root);
  return { root, pelvis, torso, head, headBall, sL: L.shoulder, eL: L.elbow, sR: R.shoulder, eR: R.elbow,
           hL: lL.hip, kL: lL.knee, fL: lL.foot, hR: lR.hip, kR: lR.knee, fR: lR.foot };
}

// ---------- 灯光 ----------
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b8b8, 1.05));
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(6, 9, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, far: 60 });
sun.shadow.bias = -.0004;
scene.add(sun);

// ---------- 空注册表（新任务按 reference 填充） ----------
const actors = {};              // P01… 人物或动物角色
const objects = {};             // O01… 物体、道具、车辆
const hands = {};               // H01/H02 独立前景手
const environmentGroups = [ground];

// ---------- 更新入口（纯函数） ----------
// 空场景没有剧情。新任务在这里根据绝对时间 t 驱动人物、道具、门和相机。
function updateAll(t) {
  scene.updateMatrixWorld(true);
}
function renderAt(t) { updateAll(clamp(t, 0, DURATION)); renderer.render(scene, camera); }

// ---------- 播放 / seek 接口 ----------
const snapshot = () => ({ time: playbackTime(clamp(window.__wm._t ?? 0, 0, DURATION)) });
window.__wm = { duration: DURATION, ready: false, storyTime, playbackTime,
  seek(t) { window.__wm._t = clamp(t, 0, DURATION); renderAt(t); },
  snapshot };
if (autoPlay) addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderAt(window.__wm._t ?? 0);
});
const fixedT = params.get('t');
if (fixedT !== null) {
  window.__wm._t = parseFloat(fixedT);
  renderAt(window.__wm._t);
  window.__wm.ready = true;
} else if (!autoPlay || params.get('mode') === 'seek') {
  // 录制模式：不启动自动循环，画面只由 window.__wm.seek(t) 驱动
  renderAt(0);
  window.__wm.ready = true;
} else {
  // 空格暂停/继续，R重播；统一播放时钟仍可由 seek 接管。
  let previousTime = performance.now(), playhead = 0, paused = false;
  addEventListener('keydown', event => {
    if (event.code === 'Space') { event.preventDefault(); paused = !paused; }
    if (event.code === 'KeyR') { playhead = 0; paused = false; }
  });
  (function loop() {
    const now = performance.now(), dt = (now - previousTime) / 1000; previousTime = now;
    if (!paused) playhead = Math.min(DURATION, playhead + Math.min(dt, .1));
    window.__wm._t = playhead;
    renderAt(playhead);
    if (!window.__wm.ready) window.__wm.ready = true;
    requestAnimationFrame(loop);
  })();
}

const world = { THREE, scene, camera, renderer, duration: DURATION, MAT, box, ball, limb, makeFigure,
  actors, objects, hands, environmentGroups,
  evaluate(t) { this.collisionTime = t; updateAll(clamp(t, 0, DURATION)); scene.updateMatrixWorld(true); },
  seek: window.__wm.seek, snapshot,
};
const collisionDetector = new VolumeCollision(world);
world.checkCollisions = () => collisionDetector.contacts();
world.validateCollisions = async options => {
  try { return await validateAnimation(world, options); }
  catch (error) { return { ok: false, time: world.collisionTime ?? 0, contacts: [], error: error.message }; }
};
window.__wm.checkCollisions = world.checkCollisions;
window.__wm.validateCollisions = async options => {
  const time = window.__wm._t ?? 0;
  try { return await world.validateCollisions(options); } finally { renderAt(time); }
};
return world;

}
