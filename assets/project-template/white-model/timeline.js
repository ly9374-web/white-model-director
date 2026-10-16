// 通用时间轴：故事时钟与播放时钟相同（恒等转换）。
// 新任务若需要把某段走路拉长、或在交接处静置，在这里加入映射，
// 并同步更新 DURATION 与 director-catalog.js 的 S 分段时间。
export const DURATION = 60;      // 占位总时长（秒）；按 reference.md 规划后替换，须按帧对齐
const preciseTime = t => Math.round(t * 1e10) / 1e10;
export const storyTime = t => preciseTime(t);
export const playbackTime = t => preciseTime(t);
