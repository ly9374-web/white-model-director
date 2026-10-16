#!/usr/bin/env python3
"""Serve this project on a free loopback port; never reuse another project's server."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import webbrowser

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        if args and str(args[1] if len(args) > 1 else '').startswith(('4', '5')):
            super().log_message(format, *args)


def create_server(port=0):
    return ThreadingHTTPServer(('127.0.0.1', port), partial(QuietHandler, directory=str(ROOT)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--page', choices=['index.html', 'director.html'], default='index.html')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    server = create_server(args.port)
    url = f'http://127.0.0.1:{server.server_port}/white-model/{args.page}'
    print(url, flush=True)
    print('本窗口提供预览服务；按 Ctrl+C 停止。', flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
