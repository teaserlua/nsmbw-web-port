#!/usr/bin/env python3
"""serve.py - local web server for the New Super Mario Bros. Wii web port.

Serves web/ (the port) and game/ (the files you extracted from YOUR disc) on 127.0.0.1 only, with
the headers the browser needs for shared memory (COOP/COEP) and HTTP Range support for the disc
files. Nothing is uploaded anywhere.

Usage: python serve.py [--game PATH_TO_GAME_FOLDER] [--port 8081]
"""
import argparse, http.server, ipaddress, json, os, random, re, socket, socketserver, struct, sys, threading, time, zlib

# ---------------------------------------------------------------- DSU (cemuhook) client bridge
# The browser cannot speak UDP, so this server talks to a DSU server (e.g. the "DSU Remote" phone app,
# port 26760) on your local network and hands the latest pad packet to the page at /dsu/state.
def dsu_host_ok(host):
    try: ip = ipaddress.ip_address(host)
    except ValueError: return False
    return ip.version == 4 and (ip.is_private or ip.is_loopback or ip.is_link_local or ip in ipaddress.ip_network('100.64.0.0/10'))

class DSUClient:
    def __init__(self):
        self.lock = threading.Lock(); self.sock = None; self.addr = None; self.gen = 0
        self.slots = {}; self.last_rx = 0.0; self.cid = random.getrandbits(32)
    def packet(self, msg_type, payload):
        body = struct.pack('<I', msg_type) + payload
        hdr = b'DSUC' + struct.pack('<HHII', 1001, len(body), 0, self.cid)
        pkt = bytearray(hdr + body)
        struct.pack_into('<I', pkt, 8, zlib.crc32(bytes(pkt)) & 0xffffffff)
        return bytes(pkt)
    def connect(self, host, port):
        with self.lock:
            if self.sock: self.sock.close()
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); self.sock.settimeout(0.5)
            self.addr = (host, port); self.slots = {}; self.last_rx = 0.0; self.gen += 1; gen = self.gen
        threading.Thread(target=self.run, args=(gen,), daemon=True).start()
    def disconnect(self):
        with self.lock:
            if self.sock: self.sock.close()
            self.sock = None; self.addr = None; self.slots = {}; self.gen += 1
    def run(self, gen):
        last_req = 0.0
        while True:
            with self.lock:
                if gen != self.gen: return
                sock, addr = self.sock, self.addr
            now = time.time()
            try:
                if now - last_req > 1.0:          # subscribe (servers drop clients after ~5 s of silence)
                    sock.sendto(self.packet(0x100001, struct.pack('<i4B', 4, 0, 1, 2, 3)), addr)
                    sock.sendto(self.packet(0x100002, bytes(8)), addr)
                    last_req = now
                data, _ = sock.recvfrom(2048)
            except socket.timeout: continue
            except OSError:
                time.sleep(0.5); continue
            if len(data) < 32 or data[:4] != b'DSUS': continue
            (mtype,) = struct.unpack_from('<I', data, 16)
            if mtype == 0x100002 and len(data) >= 100:
                with self.lock:
                    if gen != self.gen: return
                    self.slots[data[20]] = (time.time(), data[:100]); self.last_rx = time.time()
    def state(self):
        """latest packet of every live slot (100 bytes each, by slot number)"""
        with self.lock:
            now = time.time()
            live = [v[1] for k, v in sorted(self.slots.items()) if now - v[0] < 3.0 and v[1][31]]
            return b''.join(live), self.addr is not None

DSU = DSUClient()

TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
         '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
         '.txt': 'text/plain; charset=utf-8'}

def make_handler(root_web, root_game):
    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        def log_message(self, *a): pass
        def resolve(self):
            path = self.path.split('?', 1)[0]
            path = re.sub(r'/+', '/', path)
            from urllib.parse import unquote
            path = unquote(path)
            if path in ('', '/'): return os.path.join(root_web, 'index.html')
            parts = [p for p in path.split('/') if p]
            if any(p in ('..', '.') for p in parts): return None
            if parts[0] == 'game':
                base = root_game; rel = parts[1:]
            else:
                base = root_web; rel = parts
            full = os.path.abspath(os.path.join(base, *rel))   # '..' was rejected above; symlinks are allowed
            if not full.startswith(os.path.abspath(base) + os.sep): return None
            return full
        def headers_common(self, ctype, length):
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
            self.send_header('Cache-Control', 'no-cache')
        def do_HEAD(self): self.serve(head=True)
        def do_POST(self):
            # /log: the page sends its log here, saved as nsmbw-log.txt next to the web/ folder
            # (so a crash can be looked at afterwards). ?new=1 starts a new file (the old one is kept as
            # nsmbw-log-previous.txt). Only text, at most 1 MB per request and 30 MB per file.
            if self.path.split('?', 1)[0] == '/nand':
                # backup of the browser's save data: nsmbw-save-backup.bin next to web/ (max 64 MB)
                n = int(self.headers.get('Content-Length') or 0)
                if n <= 0 or n > (64 << 20): return self.reply(400, 'text/plain', b'')
                body = self.rfile.read(n)
                dst = os.path.join(os.path.dirname(os.path.abspath(root_web)), 'nsmbw-save-backup.bin')
                try:
                    with open(dst + '.tmp', 'wb') as f: f.write(body)
                    os.replace(dst + '.tmp', dst)
                except OSError:
                    pass
                return self.reply(200, 'text/plain', b'ok')
            if self.path.split('?', 1)[0] != '/log': return self.reply(404, 'text/plain', b'')
            n = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(min(n, 1 << 20)) if n > 0 else b''
            if n > (1 << 20): self.rfile.read(n - (1 << 20))
            logf = os.path.join(os.path.dirname(os.path.abspath(root_web)), 'nsmbw-log.txt')
            try:
                if 'new=1' in self.path and os.path.exists(logf):
                    os.replace(logf, logf[:-4] + '-previous.txt')
                if not os.path.exists(logf) or os.path.getsize(logf) < (30 << 20):
                    with open(logf, 'ab') as f: f.write(body.replace(b'\r', b''))
            except OSError:
                pass
            self.reply(200, 'text/plain', b'ok')
        def do_GET(self):
            if self.path.startswith('/dsu/'): return self.dsu()
            self.serve(head=False)
        def reply(self, code, ctype, body):
            self.send_response(code); self.headers_common(ctype, len(body)); self.end_headers(); self.wfile.write(body)
        def dsu(self):
            from urllib.parse import urlparse, parse_qs
            u = urlparse(self.path); q = parse_qs(u.query)
            if u.path == '/dsu/connect':
                host = (q.get('host') or [''])[0].strip(); port = int((q.get('port') or ['26760'])[0] or 26760)
                if not dsu_host_ok(host) or not (1 <= port <= 65535):
                    return self.reply(400, 'application/json', json.dumps({'ok': False, 'error': 'invalid IP (only addresses of your local network)'}).encode())
                DSU.connect(host, port); print('DSU: connecting to %s:%d' % (host, port))
                return self.reply(200, 'application/json', json.dumps({'ok': True}).encode())
            if u.path == '/dsu/disconnect':
                DSU.disconnect(); return self.reply(200, 'application/json', b'{"ok":true}')
            if u.path == '/dsu/state':
                pkt, active = DSU.state()
                if not pkt: return self.reply(204 if active else 404, 'application/octet-stream', b'')
                return self.reply(200, 'application/octet-stream', pkt)
            self.reply(404, 'text/plain', b'')
        def serve(self, head):
            full = self.resolve()
            if not full or not os.path.isfile(full):
                self.send_response(404); self.send_header('Content-Length', '0'); self.end_headers(); return
            size = os.path.getsize(full)
            ctype = TYPES.get(os.path.splitext(full)[1].lower(), 'application/octet-stream')
            rng = self.headers.get('Range')
            start, end = 0, size - 1
            if rng:
                m = re.match(r'bytes=(\d*)-(\d*)', rng)
                if m:
                    if m.group(1): start = int(m.group(1))
                    if m.group(2): end = min(int(m.group(2)), size - 1)
                    if not m.group(1) and m.group(2): start = max(0, size - int(m.group(2))); end = size - 1
                if start > end or start >= size:
                    self.send_response(416); self.send_header('Content-Range', 'bytes */%d' % size)
                    self.send_header('Content-Length', '0'); self.end_headers(); return
                self.send_response(206); self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
            else:
                self.send_response(200)
            self.headers_common(ctype, end - start + 1)
            self.end_headers()
            if head: return
            with open(full, 'rb') as f:
                f.seek(start); left = end - start + 1
                while left > 0:
                    b = f.read(min(left, 1 << 20))
                    if not b: break
                    self.wfile.write(b); left -= len(b)
    return H

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', default=os.path.join(here, 'game'))
    ap.add_argument('--web', default=os.path.join(here, 'web'))
    ap.add_argument('--port', type=int, default=8081)
    a = ap.parse_args()
    class TS(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True
    srv = TS(('127.0.0.1', a.port), make_handler(a.web, a.game))
    print('New Super Mario Bros. Wii web: http://127.0.0.1:%d/  (Ctrl+C to stop)' % a.port)
    print('game files from', a.game)
    srv.serve_forever()

if __name__ == '__main__':
    main()
