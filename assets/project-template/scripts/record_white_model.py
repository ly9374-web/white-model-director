#!/usr/bin/env python3
"""Record deterministic seek frames to silent H.264 MP4, with keyframes and metadata."""
import argparse
from fractions import Fraction
import io
import json
import math
from pathlib import Path
import sys
import threading

from launch_preview import ROOT, create_server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', default='白模预演')
    parser.add_argument('--frames', type=int, help='仅用于抽样验证；文件标记为 partial')
    parser.add_argument('--preview', action='store_true', help='仅导出各 S 片段关键帧')
    parser.add_argument('--allow-template', action='store_true', help='仅用于验证尚未改编的种子')
    args = parser.parse_args()
    if Path(args.name).name != args.name or not args.name.strip():
        parser.error('--name 必须是文件名，不包含目录')
    if args.frames is not None and args.frames <= 0:
        parser.error('--frames 必须大于零')
    cfg = json.loads((ROOT / 'project.json').read_text())
    if cfg.get('template') and not args.allow_template:
        parser.error('当前仍是种子工程；完成剧情改编和验证后将 project.json 的 template 改为 false。')
    try:
        import av
        from PIL import Image
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise SystemExit('录制依赖缺失。请在项目 .venv 中安装 playwright、av、Pillow，并执行 python -m playwright install chromium。') from exc
    fps, width, height = cfg['fps'], cfg['width'], cfg['height']
    if not all(isinstance(n, int) and n > 0 for n in (fps, width, height)) or width % 2 or height % 2:
        parser.error('fps、width、height 应为正整数，宽高须为偶数')
    out = ROOT / 'deliverables'
    out.mkdir(exist_ok=True)
    frames_dir = out / '关键帧'
    frames_dir.mkdir(exist_ok=True)
    server = create_server()
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    errors = []
    try:
        with sync_playwright() as p:
            flags = ['--use-angle=metal', '--enable-gpu'] if sys.platform == 'darwin' else []
            browser = p.chromium.launch(headless=True, args=flags)
            page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/white-model/index.html?mode=seek')
            page.wait_for_function('window.__wm?.ready === true')
            duration = page.evaluate('window.__wm.duration')
            scenes = page.evaluate('async () => (await import("./director-catalog.js")).SCENES')
            if errors or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
                raise RuntimeError(f'场景未就绪或时长无效：{errors}')
            for scene in scenes:
                if scene['end'] - scene['start'] > 20 + 1e-7:
                    raise RuntimeError(f'{scene["id"]} 超过 20 秒')
            total = round(duration * fps)
            if not math.isclose(total / fps, duration, abs_tol=1e-6):
                raise RuntimeError('总时长未按帧对齐，请先修正时间轴')
            count = min(args.frames, total) if args.frames else total
            partial = count < total
            name = args.name + ('-partial' if partial else '')
            video_path = out / f'{name}.mp4'
            if not args.preview and video_path.exists():
                raise FileExistsError(f'输出已存在，请用 --name 指定新版本：{video_path}')
            times = sorted({0.0, duration, *(round((s['start'] + s['end']) / 2 * fps) / fps for s in scenes)})
            if partial:
                times = [t for t in times if t < count / fps]
            for t in times:
                page.evaluate('(t) => window.__wm.seek(t)', t)
                page.screenshot(path=str(frames_dir / f'{name}-{round(t * fps):06d}.png'))
            if not args.preview:
                collision_report = page.evaluate('async fps=>await window.__wm.validateCollisions({fps})', fps)
                (out / f'{name}-碰撞检查.json').write_text(json.dumps(collision_report, ensure_ascii=False, indent=2))
                if not collision_report['ok']:
                    browser.close()
                    raise RuntimeError(f"体积碰撞检查未通过，禁止生成视频：{collision_report.get('time')} 秒；查看碰撞检查报告并修正模型或动作。")
                temporary = out / f'{name}.recording.mp4'
                with av.open(str(temporary), 'w', options={'movflags': '+faststart'}) as output:
                    stream = output.add_stream('libx264', rate=fps)
                    stream.width, stream.height, stream.pix_fmt = width, height, 'yuv420p'
                    stream.options = {'crf': '19', 'preset': 'fast'}
                    for i in range(count):
                        page.evaluate('(t) => window.__wm.seek(t)', i / fps)
                        frame = av.VideoFrame.from_image(Image.open(io.BytesIO(page.screenshot())).convert('RGB'))
                        frame.pts, frame.time_base = i, Fraction(1, fps)
                        for packet in stream.encode(frame):
                            output.mux(packet)
                        if i % (fps * 5) == 0:
                            print(f'录制 {i + 1}/{count} 帧', flush=True)
                    for packet in stream.encode():
                        output.mux(packet)
                if errors:
                    raise RuntimeError(f'浏览器错误：{errors}')
                with av.open(str(temporary)) as check:
                    decoded = sum(1 for _ in check.decode(video=0))
                    if decoded != count or check.streams.audio:
                        raise RuntimeError(f'编码验证失败：{decoded}/{count} 帧')
                temporary.rename(video_path)
            browser.close()
        if errors:
            raise RuntimeError(f'浏览器错误：{errors}')
        metadata = {'project': cfg['id'], 'title': cfg['title'], 'template': cfg.get('template', False),
                    'fps': fps, 'resolution': [width, height], 'plannedDuration': duration,
                    'frames': 0 if args.preview else count, 'encodedDuration': 0 if args.preview else count / fps,
                    'partial': partial, 'previewOnly': args.preview, 'audio': 'none', 'errors': errors}
        (out / f'{name}-录制信息.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
        print(f'已输出：{frames_dir if args.preview else video_path}')
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


if __name__ == '__main__':
    main()
