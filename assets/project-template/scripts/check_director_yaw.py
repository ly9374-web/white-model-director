"""Check real arrow keys turn the observer in place, including damping and recording."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import math
from pathlib import Path
import threading
import time
from playwright.sync_api import sync_playwright


def close(a, b, tolerance=1e-8):
    assert math.dist(a, b) < tolerance, (a, b)


def vector(camera):
    return [t-p for t, p in zip(camera['target'], camera['position'])]


def yaw_angle(before, after):
    a, b = vector(before), vector(after)
    delta = math.atan2(b[0], b[2]) - math.atan2(a[0], a[2])
    return math.atan2(math.sin(delta), math.cos(delta))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--out', type=Path)
    parser.add_argument('--skip-video', action='store_true')
    args = parser.parse_args()
    project = args.project.resolve()
    out = (args.out or project/'test-results/director-yaw').resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (project/'white-model/serve.py').exists():
        spec = importlib.util.spec_from_file_location('yaw_preview_server', project/'white-model/serve.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        class Handler(module.Handler):
            def log_message(self, *_): pass
        handler, entry = Handler, '/director.html'
    else:
        class Handler(SimpleHTTPRequestHandler):
            def log_message(self, *_): pass
        handler, entry = partial(Handler, directory=str(project)), '/white-model/director.html'
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    checks, errors = [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--use-angle=metal', '--enable-gpu'])
            try:
                page = browser.new_page(viewport={'width':1440,'height':1000}, accept_downloads=True)
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.add_init_script('''
                  if(!localStorage.getItem('director-camera-settings'))
                    localStorage.setItem('director-camera-settings',JSON.stringify({move:6,lift:1,pitch:75,roll:45}));
                  let now=0,next=0,callbacks=new Map();performance.now=()=>now;
                  window.requestAnimationFrame=fn=>{callbacks.set(++next,fn);return next;};
                  window.cancelAnimationFrame=id=>callbacks.delete(id);
                  window.stepFrames=count=>{for(let i=0;i<count;i++){now+=16;
                    const pending=[...callbacks.values()];callbacks.clear();for(const fn of pending)fn(now);}};
                ''')
                page.goto(f'http://127.0.0.1:{server.server_port}{entry}')
                page.wait_for_load_state('networkidle')
                page.wait_for_function('window.__director?.ready', polling=100)
                def camera(): return page.evaluate('window.__director.cameraProbe()')
                def step(n=50): page.evaluate('(n)=>window.stepFrames(n)', n)
                def reset(view='front'):
                    page.evaluate('(view)=>document.querySelector(`[data-view="${view}"]`).click()', view)
                    page.locator('#viewport canvas').focus();step(2)
                def press(key, shift=False, count=50):
                    if shift: page.keyboard.down('ShiftLeft')
                    page.keyboard.down(key);step(count);page.keyboard.up(key)
                    if shift: page.keyboard.up('ShiftLeft')
                def speed(value):
                    page.evaluate('document.querySelector("#camera-settings-toggle").click()')
                    page.locator('#camera-number-yaw').fill(str(value));page.locator('#camera-number-yaw').press('Tab')
                    assert float(page.locator('#camera-set-yaw').input_value()) == value
                    page.evaluate('document.querySelector("#camera-settings-toggle").click()')
                def turn(key, shift=False, view='front'):
                    reset(view);before=camera();press(key,shift);after=camera()
                    close(before['position'],after['position'])
                    assert abs(math.dist(before['position'],before['target'])-math.dist(after['position'],after['target']))<1e-7
                    close([vector(before)[1]],[vector(after)[1]])
                    return yaw_angle(before,after)
                def snapshot():
                    return page.evaluate('''()=>{const d=window.__director,i=d.inspect();
                      return {time:i.time,poses:[...new Set([i.selected,'C01'].filter(Boolean))].map(id=>[id,d.pose(id)])};}''')
                assert camera()['speeds']=={'move':6,'lift':1,'yaw':90,'pitch':75,'roll':45}
                original=snapshot();checks.append('旧四项设置保留，新转头速度采用默认 90°/秒')
                speed(15);slow=turn('ArrowLeft');assert abs(slow-math.radians(12))<1e-8,slow
                speed(60);fast=turn('ArrowLeft');right=turn('ArrowRight');boost=turn('ArrowLeft',True)
                assert abs(fast-math.radians(48))<1e-8 and abs(fast/slow-4)<1e-8
                assert abs(right+fast)<1e-8 and abs(boost-fast)<1e-8
                checks.append('左右方向键原地转头；速度设置准确，Shift 不改变角速度')
                for view in ['top','side','overview']:
                    assert abs(turn('ArrowLeft',view=view)-math.radians(48))<1e-7
                reset();press('KeyI',count=10);press('KeyJ',count=10)
                before=camera();press('ArrowLeft');after=camera()
                close(before['position'],after['position']);close([before['roll']],[after['roll']]);close([vector(before)[1]],[vector(after)[1]])
                assert abs(yaw_angle(before,after)-math.radians(48))<1e-8
                stopped=camera();step();close(stopped['position'],camera()['position']);close(stopped['quaternion'],camera()['quaternion'])
                checks.append('正面、侧面、俯视、全景及带俯仰/侧倾时均原地转头；松键即停')
                page.keyboard.down('ArrowLeft');page.keyboard.down('ArrowRight');before=camera();step()
                page.keyboard.up('ArrowLeft');page.keyboard.up('ArrowRight');close(before['quaternion'],camera()['quaternion'])
                page.keyboard.down('ArrowLeft');page.locator('#note').focus();before=camera();step();page.keyboard.up('ArrowLeft')
                close(before['quaternion'],camera()['quaternion'])
                page.keyboard.press('ArrowRight');step();close(before['position'],camera()['position']);close(before['quaternion'],camera()['quaternion'])
                page.locator('#viewport canvas').focus();page.keyboard.down('ArrowLeft');page.evaluate('window.dispatchEvent(new Event("blur"))')
                before=camera();step();page.keyboard.up('ArrowLeft');close(before['quaternion'],camera()['quaternion'])
                checks.append('左右同时按下抵消；输入框及失焦清理转头状态')
                reset();press('KeyJ',count=10);box=page.locator('#viewport canvas').bounding_box()
                x,y=box['x']+box['width']*.75,box['y']+box['height']*.25
                before=camera();page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+45,y+12,steps=5);page.mouse.up()
                # Do not let damping settle: keyboard yaw must discard the pending orbit drift.
                after_mouse=camera();assert math.dist(before['position'],after_mouse['position'])>.01
                roll=after_mouse['roll'];press('ArrowLeft',count=1);after=camera()
                close(after_mouse['position'],after['position']);close([roll],[after['roll']])
                assert abs(yaw_angle(after_mouse,after)-math.radians(.96))<1e-7
                checks.append('鼠标仍绕焦点观察并保留侧倾；接着按方向键不会残留绕行位移')
                reset();press('ArrowLeft');before=camera();press('KeyW');after=camera()
                direction=vector(before);horizontal=math.hypot(direction[0],direction[2])
                delta=[after['position'][i]-before['position'][i] for i in range(3)]
                close(delta,[direction[0]/horizontal*4.8,0,direction[2]/horizontal*4.8])
                assert original==snapshot()
                checks.append('转头后的 W 沿新朝向水平移动；人物、剧情镜头、暂停时间和编辑数据未改')
                page.reload();page.wait_for_load_state('networkidle');page.wait_for_function('window.__director?.ready',polling=100)
                assert camera()['speeds']['yaw']==60
                page.evaluate('document.querySelector("#camera-settings-toggle").click()')
                slider=page.locator('#camera-set-yaw');slider.focus();slider.press('Home');slider.press('ArrowRight');slider.press('ArrowRight')
                assert page.locator('#camera-number-yaw').input_value()=='15' and camera()['speeds']['yaw']==15
                page.evaluate('document.querySelector("#camera-settings-reset").click()')
                assert camera()['speeds']=={'move':3,'lift':3,'yaw':90,'pitch':60,'roll':60}
                page.evaluate('document.querySelector("#camera-settings-toggle").click()')
                checks.append('速度持久保存、重载恢复、滑块数值同步及恢复默认正常')
                reset();start=camera();page.evaluate('window.__director.startRecording("observer")')
                assert page.evaluate('window.__director.recording()')
                before=camera();press('ArrowLeft',count=20);after=camera()
                close(before['position'],after['position']);assert abs(yaw_angle(before,after)-math.radians(28.8))<1e-8
                assert abs(page.evaluate('window.__director.inspect().time')-.32)<1e-8
                checks.append('第三人称录制原地转头，剧情仍按正常时间推进')
                if not args.skip_video:
                    with page.expect_download(timeout=60000) as event:
                        page.evaluate('''()=>{window.yawStopDone=false;
                          void window.__director.stopRecording().finally(()=>window.yawStopDone=true);}''')
                        deadline=time.monotonic()+55
                        while not page.evaluate('window.yawStopDone'):
                            assert time.monotonic()<deadline,'编码超时'
                            step(1);page.wait_for_timeout(30)
                    video=out/'原地转头-第三人称.mp4';event.value.save_as(str(video))
                    recording=page.evaluate('window.__director.lastRecording');samples=recording['samples'];assert len(samples)>2
                    for sample in samples:close(start['position'],sample['position'])
                    assert math.dist(samples[0]['quaternion'],samples[-1]['quaternion'])>.01
                    close(start['position'],camera()['position']);close(start['quaternion'],camera()['quaternion'])
                    assert page.evaluate('window.__director.inspect().time')==0
                    import av
                    with av.open(str(video)) as container:
                        stream=container.streams.video[0]
                        assert stream.codec_context.name=='h264' and not container.streams.audio
                        assert float(stream.average_rate)==30 and (stream.width,stream.height)==(1920,1080)
                        assert sum(1 for _ in container.decode(video=0))==recording['endFrame']-recording['startFrame']+1
                    checks.append('录制轨迹位置固定、朝向改变；导出静音 H.264 MP4 可解码，停止后恢复起始机位与时间')
                else:checks.append('按选项跳过实际 MP4 编码')
                assert not errors,errors
                report={'passed':True,'project':str(project),'checks':checks,'pageErrors':errors}
                (out/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
                print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
            finally:browser.close()
    finally:server.shutdown();server.server_close();worker.join(timeout=5)


if __name__=='__main__':main()
