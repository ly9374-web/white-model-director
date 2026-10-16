import { PROJECT } from './project-runtime.js';
import { DURATION } from './timeline.js';
// S 分段时间：新任务按 reference.md 填写，单段不超过 20 秒，完整覆盖 0–DURATION。
export const SCENES = [{ id: 'S01', name: '待规划场景', start: 0, end: DURATION }];
export const ACTORS = {};   // P01… 人物/动物名称，例如 {P01:'主角身体'}
export const PROPS = {};    // O01… 物体/道具名称，例如 {O01:'海报'}
export const PARTS = {pelvis:'骨盆',torso:'躯干',head:'头部',sL:'左肩',eL:'左肘',sR:'右肩',eR:'右肘',hL:'左髋',kL:'左膝',fL:'左脚',hR:'右髋',kR:'右膝',fR:'右脚'};
export const sceneAt = t => SCENES.find(s=>t>=s.start && t<s.end) || SCENES.at(-1);
export const FPS = PROJECT.fps;
export const SCHEMA = 1;
