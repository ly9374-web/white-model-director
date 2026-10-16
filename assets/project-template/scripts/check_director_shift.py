"""Exercise real keyboard events with deterministic animation frames in an isolated browser."""
from pathlib import Path
import json
import math
import sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8913/director.html'
checks, errors = [], []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-angle=metal', '--enable-gpu'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('''
      let now=0,next=0,callbacks=new Map();
      performance.now=()=>now;
      window.requestAnimationFrame=fn=>{callbacks.set(++next,fn);return next;};
      window.cancelAnimationFrame=id=>callbacks.delete(id);
      window.stepFrames=count=>{for(let i=0;i<count;i++){
        now+=16;const pending=[...callbacks.values()];callbacks.clear();
        for(const fn of pending)fn(now);
      }};
    ''')
    page.goto(URL)
    page.wait_for_load_state('networkidle')
    page.wait_for_function('window.__director?.ready')
    assert page.locator('#viewport canvas').count() > 0

    def step(count=50):
        page.evaluate('(n)=>window.stepFrames(n)', count)

    def camera():
        return page.evaluate('window.__director.cameraProbe()')

    def reset():
        page.evaluate('document.querySelector("[data-view=front]").click()')
        page.locator('#viewport canvas').focus()
        step(2)

    def move(key, shift=None):
        before = camera()['position']
        if shift:
            page.keyboard.down(shift)
        page.keyboard.down(key)
        step()
        page.keyboard.up(key)
        if shift:
            page.keyboard.up(shift)
        return math.dist(before, camera()['position'])

    reset()
    def snapshot():
        return page.evaluate('''()=>{const d=window.__director,i=d.inspect();
          const ids=[...new Set([i.selected,'C01'].filter(Boolean))];
          return {time:i.time,poses:ids.map(id=>[id,d.pose(id)])};}''')
    original = snapshot()
    normal = move('w')
    reset()
    boosted = move('w', 'ShiftLeft')
    assert abs(boosted / normal - 3) < 1e-6, (normal, boosted)
    reset()
    assert abs(move('ArrowUp', 'ShiftRight') / move('ArrowUp') - 3) < 1e-6
    assert snapshot() == original
    checks.append('左右 Shift 均支持；WASD 和升降距离为 3 倍；剧情镜头、选中对象和暂停时间未变')

    reset()
    page.keyboard.down('w')
    page.keyboard.down('ShiftLeft')
    before = camera()['position']; step(); held = math.dist(before, camera()['position'])
    page.keyboard.up('ShiftLeft')
    before = camera()['position']; step(); released = math.dist(before, camera()['position'])
    page.keyboard.up('w')
    assert abs(held / released - 3) < 1e-6
    before = camera()['position']; step(); assert camera()['position'] == before
    page.keyboard.down('ShiftLeft'); step(); assert camera()['position'] == before
    page.keyboard.up('ShiftLeft')
    checks.append('松开 Shift 立即恢复；松开移动键停止；单按 Shift 不移动')

    reset()
    page.keyboard.down('w'); page.keyboard.down('ShiftLeft')
    page.locator('#note').focus()
    before = camera()['position']; step(); assert camera()['position'] == before
    page.keyboard.up('w'); page.keyboard.up('ShiftLeft')
    page.keyboard.press('ShiftLeft+w'); step(); assert camera()['position'] == before
    page.locator('#viewport canvas').focus()
    assert abs(move('w') / normal - 1) < 1e-6
    page.keyboard.down('w'); page.keyboard.down('ShiftLeft')
    page.evaluate('window.dispatchEvent(new Event("blur"))')
    before = camera()['position']; step(); assert camera()['position'] == before
    page.keyboard.up('w'); page.keyboard.up('ShiftLeft')
    checks.append('输入框与失焦清理移动状态，无持续加速')

    counts = {}
    for view in ['front', 'side', 'top', 'overview']:
        page.evaluate('(v)=>document.querySelector(`[data-view="${v}"]`).click()', view)
        step(2)
        counts[view] = page.evaluate('window.__director.viewProbe().cutawayCount')
    # 全景不避挡；聚焦视角若有遮挡物才避挡，空场景没有遮挡物即为 0。
    assert counts['overview'] == 0, counts
    checks.append({'全景取消避挡': counts})

    reset()
    page.evaluate('window.__director.startRecording("observer")')
    assert page.evaluate('window.__director.recording()')
    initial_time = page.evaluate('window.__director.inspect().time')
    recorded_normal = move('w')
    recorded_boost = move('w', 'ShiftLeft')
    assert abs(recorded_boost / recorded_normal - 3) < 1e-6
    elapsed = page.evaluate('window.__director.inspect().time') - initial_time
    assert abs(elapsed - 1.6) < 1e-6, elapsed
    checks.append('第三人称录制时手动镜头加速，剧情仍按正常时间推进')
    browser.close()

assert not errors, errors
OUT = ROOT / 'test-results/director-shift.json'
OUT.parent.mkdir(exist_ok=True)
OUT.write_text(json.dumps({'checks': checks, 'pageErrors': errors}, ensure_ascii=False, indent=2))
print(OUT.read_text())
