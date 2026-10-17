"""Exercise deletion, undo/redo and package round trips with real keyboard events."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--out',type=Path)
    args=parser.parse_args();project=args.project.resolve()
    out=(args.out or project/'test-results/director-delete').resolve();out.mkdir(parents=True,exist_ok=True)
    if (project/'white-model/serve.py').exists():
        spec=importlib.util.spec_from_file_location('delete_preview_server',project/'white-model/serve.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        class Handler(module.Handler):
            def log_message(self,*_):pass
        handler,entry=Handler,'/director.html'
    else:
        class Handler(SimpleHTTPRequestHandler):
            def log_message(self,*_):pass
        handler,entry=partial(Handler,directory=str(project)),'/white-model/director.html'
    server=ThreadingHTTPServer(('127.0.0.1',0),handler)
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    errors=[];checks=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,args=['--use-angle=metal','--enable-gpu'])
            try:
                page=browser.new_page(viewport={'width':1440,'height':1000})
                page.on('pageerror',lambda error:errors.append(str(error)))
                url=f'http://127.0.0.1:{server.server_port}{entry}'
                page.goto(url);page.wait_for_load_state('networkidle');page.wait_for_function('window.__director?.ready')
                def inspect():return page.evaluate('window.__director.inspect()')
                def select(id):page.evaluate('(id)=>{window.__director.setMode("whole");window.__director.select(id)}',id);page.locator('#viewport canvas').focus()
                def pose(id):return page.evaluate('(id)=>window.__director.pose(id)',id)
                def listed(id):return page.locator(f'#object option[value="{id}"]').count()==1
                ids=page.locator('#object option').evaluate_all('(els)=>els.map(e=>e.value)')
                source=next((id for id in ids if id.startswith('O')),next((id for id in ids if id!='C01'),'C01'))
                # All projects, including an empty template, can copy a registered top-level object.
                clone=page.evaluate('(id)=>window.__director.cloneComponent(id)',source)
                assert clone and listed(clone)
                page.evaluate('(id)=>window.__director.componentNote(id,"删除后要保留的备注")',clone)
                current=pose(clone)['world']['position'];target=[current[0]+.4,current[1],current[2]+.2]
                page.evaluate('([id,position])=>window.__director.edit(id,{position})',[clone,target]);select(clone)
                page.locator('#note').fill('保留这个已保存目标');page.locator('#note').press('Enter');select(clone)
                before=pose(clone);bookmarks=inspect()['bookmarks']
                page.keyboard.press('Delete')
                assert clone in inspect()['deletedObjects'] and clone not in inspect()['components'] and not listed(clone)
                assert not pose(clone)['visible'] and page.locator('#undo').is_enabled()
                page.keyboard.press('Control+z')
                assert listed(clone) and clone in inspect()['components'] and inspect()['selected']==clone
                assert pose(clone)==before and inspect()['components'][clone]['note']=='删除后要保留的备注'
                assert inspect()['bookmarks']==bookmarks
                page.keyboard.press('Control+Shift+z');assert not listed(clone)
                page.click('#undo');assert listed(clone) and pose(clone)==before
                page.click('#redo');assert not listed(clone)
                page.keyboard.press('Meta+z');assert listed(clone)
                checks.append('Delete 删除选中副本；Ctrl/Cmd+Z 和撤销/重做按钮恢复编号、姿态、固定位置、备注与目标书签')
                # Backspace is the key labelled Delete on a Mac keyboard; repeats must not cascade.
                select(clone);page.keyboard.down('Backspace');remaining=inspect()['deletedObjects']
                page.keyboard.down('Backspace');assert inspect()['deletedObjects']==remaining
                page.keyboard.up('Backspace');assert clone in remaining
                page.keyboard.press('Meta+z');assert listed(clone)
                select(clone);page.locator('#note').fill('abc');page.locator('#note').press('End');page.keyboard.press('Backspace')
                assert page.locator('#note').input_value()=='ab' and clone not in inspect()['deletedObjects']
                page.keyboard.press('Delete');assert clone not in inspect()['deletedObjects']
                page.evaluate('''()=>{const e=document.createElement('div');e.contentEditable='true';e.id='delete-text-test';e.textContent='abc';document.body.append(e);e.focus();}''')
                page.keyboard.press('Backspace');assert clone not in inspect()['deletedObjects']
                page.evaluate('document.getElementById("delete-text-test").remove()')
                checks.append('Mac 退格删除可用，长按不连删；输入框与 contenteditable 中只编辑文字')
                select('C01');page.keyboard.press('Delete');assert listed('C01') and 'C01' not in inspect()['deletedObjects']
                if source!='C01':
                    select(source);original=pose(source);page.keyboard.press('Delete')
                    assert not listed(source) and source in inspect()['deletedObjects'] and not pose(source)['visible']
                    page.keyboard.press('Control+z');assert listed(source) and pose(source)==original
                    checks.append('原有组件也能删除和撤销，必需的剧情镜头 C01 保留')
                actor=next((id for id in ids if id.startswith('P')),None)
                if actor:
                    select(actor);page.evaluate('window.__director.setMode("joint")');part=inspect()['selected']
                    if '/' in part:
                        page.locator('#viewport canvas').focus();part_before=pose(part);page.keyboard.press('Delete')
                        assert part in inspect()['deletedObjects'] and inspect()['selected']!=part
                        page.keyboard.press('Control+z');assert inspect()['selected']==part and pose(part)==part_before
                        checks.append('关节部件删除后自动选择可用部件，撤销恢复原部件及选择')
                    page.evaluate('window.__director.setMode("whole")')
                # A later copy can depend on a deleted copy: keep source records for round trips.
                descendant=page.evaluate('(id)=>window.__director.cloneComponent(id)',clone)
                select(clone);page.keyboard.press('Delete');assert listed(descendant) and not listed(clone)
                if source!='C01':select(source);page.keyboard.press('Delete')
                page.locator('#note').fill('采用已删除组件的修改');page.locator('#note').press('Enter')
                select(descendant)
                before_export=inspect()
                bundle=page.evaluate('async()=> (await window.__director.exportBundle()).data')
                assert clone in bundle['deletedObjects'] and clone in bundle['components'] and descendant in bundle['components']
                assert all(not state['target']['objects'][clone]['visible'] for state in bundle['states'])
                assert inspect()==before_export
                page.reload();page.wait_for_load_state('networkidle');page.wait_for_function('window.__director?.ready')
                page.evaluate('(data)=>window.__director.importPackage(data)',bundle)
                assert clone in inspect()['deletedObjects'] and not listed(clone) and listed(descendant)
                if source!='C01':assert not listed(source)
                checks.append('删除状态及链式复制来源随修改包导出/重载/导入；导出不破坏撤销记录')
                restored=inspect();bad=json.loads(json.dumps(bundle));bad['deletedObjects']=['C01']
                rejected=page.evaluate('async data=>{try{await window.__director.importPackage(data);return false}catch{return true}}',bad)
                assert rejected and inspect()==restored and listed(descendant)
                checks.append('非法删除列表被拒绝，原有组件、删除状态与已保存目标完整回滚')
                # Deletion and undo shortcuts cannot mutate editing data during recording.
                select(descendant);page.evaluate('window.__director.startRecording("observer")')
                snapshot=inspect();page.keyboard.press('Delete');page.keyboard.press('Control+z')
                assert inspect()['deletedObjects']==snapshot['deletedObjects'] and listed(descendant)
                checks.append('录制期间忽略删除及撤销编辑快捷键')
                assert not errors,errors
                report={'passed':True,'project':str(project),'checks':checks,'pageErrors':errors}
                (out/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
                print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
            finally:browser.close()
    finally:server.shutdown();server.server_close();worker.join(timeout=5)


if __name__=='__main__':main()
