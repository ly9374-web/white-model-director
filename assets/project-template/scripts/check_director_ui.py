#!/usr/bin/env python3
"""Check the generated director UI, package round trips and recording gate."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json, math, threading
from playwright.sync_api import sync_playwright

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_): pass

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project',type=Path,nargs='?',default=Path(__file__).resolve().parents[1])
    args=parser.parse_args()
    project=args.project.resolve()
    cfg=json.loads((project/'project.json').read_text())
    out=project/'deliverables/validation/director-ui';out.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(project)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    errors=[];checks=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,args=['--use-angle=metal','--enable-gpu'])
            page=browser.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{server.server_port}/white-model/director.html')
            # project.json is one directory above the web entry point.
            page.wait_for_load_state('networkidle')
            page.wait_for_function('window.__director?.ready')
            assert cfg['title'] in page.title()
            assert page.locator('#drone, #drone-hud').count()==0
            assert page.evaluate("typeof window.__director.drone==='undefined'")
            assert page.locator('#prev').inner_text()=='快退 5 秒'
            duration=page.evaluate('window.__wm.duration')
            start=min(max(1,round(duration*.3)),max(1,duration-6))
            page.evaluate('(t)=>window.__director.seek(t)',start);page.click('#next')
            assert abs(page.evaluate('window.__director.inspect().time')-(start+5))<1/cfg['fps']
            page.click('#prev')
            assert abs(page.evaluate('window.__director.inspect().time')-start)<1/cfg['fps']
            checks.append('configured title and 5-second jumps; no excluded camera mode')
            # Arrow rotation changes only the observer, leaving the story camera untouched.
            story=page.evaluate("window.__director.pose('C01').world")
            before=page.evaluate('window.__director.cameraProbe()')
            page.locator('#viewport canvas').focus();page.keyboard.down('ArrowLeft');page.wait_for_timeout(160);page.keyboard.up('ArrowLeft')
            after=page.evaluate('window.__director.cameraProbe()')
            assert math.dist(before['position'],after['position'])<1e-8
            assert math.dist(before['quaternion'],after['quaternion'])>.01
            assert page.evaluate("window.__director.pose('C01').world")==story
            checks.append('observer turns in place and preserves story camera')
            f1=round(start*cfg['fps']);t2=min(duration-1,start+13);f2=round(t2*cfg['fps'])
            for t,note in [(start,'第一个已保存目标'),(t2,'第二个已保存目标')]:
                page.evaluate('(t)=>window.__director.seek(t)',t)
                page.locator('#note').fill(note);page.locator('#note').press('Enter')
            assert page.evaluate('window.__director.inspect().bookmarks')==[f1,f2]
            pick=page.locator(f'#bookmarks .bookmark[data-frame="{f1}"] button').first
            pick.evaluate('(el)=>window.savedBookmarkNode=el');page.wait_for_timeout(350)
            assert pick.evaluate('(el)=>el===window.savedBookmarkNode')
            checks.append('Enter saves two targets; bookmark nodes survive periodic refresh')
            source=page.evaluate('window.__director.inspect().selected')
            assert source,'工作台没有默认选中对象'
            copied=page.evaluate('(id)=>window.__director.cloneComponent(id)',source)
            assert copied and copied!=source
            page.evaluate('([id,note])=>window.__director.componentNote(id,note)',[copied,'静态副本测试'])
            page.locator('#note').fill('第二个已保存目标');page.locator('#note').press('Enter')
            exported=page.evaluate('async()=>{const b=await window.__director.exportBundle();return {data:b.data,bytes:b.bytes.length};}')
            assert exported['bytes']>1000
            data=exported['data']
            assert data['project']['id']==cfg['id'] and data['fps']==cfg['fps']
            assert data['components'][copied]['note']=='静态副本测试'
            assert len(data['states'])==2 and all('overrides' in s for s in data['states'])
            page.reload();page.wait_for_load_state('networkidle');page.wait_for_function('window.__director?.ready')
            page.evaluate('(data)=>window.__director.importPackage(data)',data)
            restored=page.evaluate('window.__director.inspect()')
            assert len(restored['bookmarks'])==2 and copied in restored['components']
            assert page.locator('#components input').input_value()=='静态副本测试'
            checks.append('components, notes and per-target fixed snapshots round trip through ZIP data')
            for field,value in [('id','unrelated-project'),('fps',cfg['fps']+1),('sourceHash','wrong-version')]:
                invalid=json.loads(json.dumps(data))
                if field=='fps':invalid[field]=value
                else:invalid['project'][field]=value
                rejected=page.evaluate('async data=>{try{await window.__director.importPackage(data);return "";}catch(e){return e.message;}}',invalid)
                assert rejected and len(page.evaluate('window.__director.inspect().bookmarks'))==2
                assert copied in page.evaluate('window.__director.inspect().components')
            checks.append('wrong project, fps and source version rejected without losing saved work')
            page.evaluate('(id)=>window.__director.removeComponent(id)',copied)
            assert page.locator('#components .component-row').count()==0
            delete=page.locator(f'#bookmarks .bookmark[data-frame="{f1}"] .delete')
            delete.scroll_into_view_if_needed();box=delete.bounding_box()
            page.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2)
            page.mouse.down();page.wait_for_timeout(400);page.mouse.up()
            assert page.evaluate('window.__director.inspect().bookmarks')==[f2]
            checks.append('copy deletion and held bookmark deletion work across UI refresh')
            # Browser recording documents free edits; the terminal generation gate is separate.
            page.evaluate('window.__director.seek(0)');page.click('#record')
            assert page.evaluate('window.__director.recording()')
            actual=page.locator('#record-canvas canvas').evaluate('(el)=>[el.width,el.height]')
            assert actual==[cfg['width'],cfg['height']],actual
            page.wait_for_timeout(150)
            with page.expect_download(timeout=60000) as event:page.keyboard.press('Space')
            event.value.save_as(str(out/'browser-story.mp4'))
            page.wait_for_function("!document.body.classList.contains('recording')")
            assert not page.evaluate('window.__director.recording()')
            assert abs(page.evaluate('window.__director.inspect().time'))<1/cfg['fps']
            assert (out/'browser-story.mp4').stat().st_size>1000
            assert page.locator('#record-observer').is_enabled()
            checks.append('recording uses configured resolution, Space exports MP4, start frame and both buttons restored')
            page.screenshot(path=str(out/'director-ui.png'),full_page=True)
            browser.close()
        assert not errors,errors
        report={'passed':True,'checks':checks,'errors':errors,'configuration':cfg}
        (out/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(json.dumps(report,ensure_ascii=False))
    finally:
        server.shutdown();server.server_close()

if __name__=='__main__': main()
