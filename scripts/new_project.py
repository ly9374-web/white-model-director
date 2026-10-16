#!/usr/bin/env python3
"""Copy the bundled seed into a NEW project directory; never install the skill."""
import argparse
import json
from pathlib import Path
import shutil
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--title', required=True)
    args = parser.parse_args()
    skill = Path(__file__).resolve().parents[1]
    target = args.output.expanduser().resolve()
    if target.exists():
        parser.error(f'目录已存在，不覆盖：{target}')
    shutil.copytree(skill / 'assets/project-template', target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
    config_path = target / 'project.json'
    config = json.loads(config_path.read_text())
    config.update(id=uuid.uuid4().hex, title=args.title, template=True)
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
    reference = (skill / 'assets/reference-template.md').read_text()
    (target / 'reference.md').write_text(reference.replace('{{视频名称}}', args.title))
    for command in target.glob('*.command'):
        command.chmod(0o755)
    print(f'已复制到 {target}')
    print('这是通用空骨架工程（仅一块灰地面、网格和灯光，没有人物、道具和剧情）。请根据已澄清的剧情填写 reference.md，从零搭建全新场景、人物与动作，验证后将 project.json 的 template 改为 false。')


if __name__ == '__main__':
    main()
