"""Check actual mesh visibility during live recording and MP4 frame rendering."""
from pathlib import Path
import json
import av
import sys
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'test-results/director-recording-cutaway'
OUT.mkdir(parents=True, exist_ok=True)
checks, errors = [], []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--use-angle=metal', '--enable-gpu'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    page.on('pageerror', lambda error: errors.append(str(error)))

    def instrument(route):
        response = route.fetch()
        source = response.text()
        # Inspect visibility at renderer.render, before draw's finally restores meshes.
        hook = '''
window.__visibilityFrames=[];
for(const [kind,renderer] of [['main',world.renderer],['output',recorderRenderer]]){
 const original=renderer.render.bind(renderer);
 renderer.render=(scene,camera)=>{
  window.__visibilityFrames.push({kind,recording,encoding,mode:recordingMode,
   hidden:viewBlockers.filter(n=>!n.visible).map(n=>n.uuid),
   wallsHidden:model.walls.every(n=>!n.visible),ceilingsHidden:model.ceilings.every(n=>!n.visible)});
  return original(scene,camera);
 };
}
'''
        source = source.replace("notify('先选场景和时间，再拖动对象；目标状态不会自动改写原动画。',true)", hook + "notify('先选场景和时间，再拖动对象；目标状态不会自动改写原动画。',true)")
        route.fulfill(response=response, body=source)

    page.route('**/director.js', instrument)
    page.goto(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:8913/director.html')
    page.wait_for_load_state('networkidle')
    page.wait_for_function('window.__director?.ready')
    page.locator('#ceilings').uncheck()
    page.locator('#walls').uncheck()
    page.click('[data-view="side"]')
    page.wait_for_timeout(80)
    # 有遮挡物的场景，聚焦视角应临时隐藏遮挡；空场景没有遮挡物，隐藏数为 0。
    occluders = page.evaluate('window.__visibilityFrames.at(-1).hidden.length')
    initial_view = page.evaluate('window.__director.state().observer')

    for hide_building in [False, True]:
        if hide_building:
            page.locator('#walls').check()
            page.locator('#ceilings').check()
        page.evaluate('window.__visibilityFrames=[]')
        page.click('#record-observer')
        page.wait_for_timeout(150)
        live = page.evaluate('window.__visibilityFrames.filter(f=>f.recording&&f.kind==="main")')
        assert live
        if hide_building:
            assert all(f['wallsHidden'] and f['ceilingsHidden'] for f in live)
        else:
            assert all(not f['hidden'] for f in live), live
        with page.expect_download(timeout=60000) as event:
            page.click('#record-observer')
        path = OUT / ('手动隐藏建筑.mp4' if hide_building else '完整场景无自动避挡.mp4')
        event.value.save_as(str(path))
        page.wait_for_function('!window.__director.recordingProbe().encoding')
        encoded = page.evaluate('window.__visibilityFrames.filter(f=>f.encoding&&f.kind==="output")')
        assert len(encoded) >= 2
        if hide_building:
            assert all(f['wallsHidden'] and f['ceilingsHidden'] for f in encoded)
        else:
            assert all(not f['hidden'] for f in encoded), encoded
            assert page.evaluate('window.__director.state().observer') == initial_view
            if occluders:
                assert page.evaluate('window.__visibilityFrames.at(-1).hidden.length') > 0
        with av.open(str(path)) as container:
            assert not container.streams.audio
            frames = list(container.decode(video=0))
            assert len(frames) == len(encoded)
            assert frames[0].width == 1920 and frames[0].height == 1080
            frames[0].to_image().save(path.with_suffix('.png'))
        checks.append({'manualHideBuilding': hide_building, 'liveFrames': len(live), 'mp4Frames': len(encoded)})
    assert not errors, errors
    browser.close()

report = {'checks': checks, 'editingCutawayRestored': True, 'pageErrors': errors}
(OUT / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))
