#!/usr/bin/env python3
import http.server
import json
import re
import ssl
import socketserver
import urllib.error
import urllib.parse
import urllib.request


def read_supabase_config():
    with open("config.js", "r", encoding="utf-8") as f:
        text = f.read()
    url = re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", text)
    key = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']+)'", text)
    if not url or not key:
        raise RuntimeError("config.js içinde Supabase URL veya anon key bulunamadı")
    return url.group(1).rstrip("/"), key.group(1)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/supabase/"):
            self.proxy_supabase()
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path.startswith("/api/supabase/"):
            self.proxy_supabase(head_only=True)
            return
        super().do_HEAD()

    def do_POST(self):
        if self.path.startswith("/api/supabase/"):
            self.proxy_supabase(with_body=True)
            return
        self.send_error(404)

    def do_PATCH(self):
        if self.path.startswith("/api/supabase/"):
            self.proxy_supabase(with_body=True)
            return
        self.send_error(404)

    def proxy_supabase(self, head_only=False, with_body=False):
        try:
            base_url, anon_key = read_supabase_config()
            parsed = urllib.parse.urlsplit(self.path)
            table_path = parsed.path.removeprefix("/api/supabase/")
            if not re.fullmatch(r"[A-Za-z0-9_./-]+", table_path):
                self.send_error(400, "Invalid Supabase path")
                return

            target = f"{base_url}/rest/v1/{table_path}"
            if parsed.query:
                target = f"{target}?{parsed.query}"
            print(f"→ Supabase proxy: {self.command} /{table_path}", flush=True)

            body = None
            if with_body:
                length = int(self.headers.get("Content-Length", "0") or 0)
                body = self.rfile.read(length) if length else b""

            headers = {
                "apikey": anon_key,
                "Authorization": f"Bearer {anon_key}",
                "Content-Type": self.headers.get("Content-Type", "application/json"),
                "Accept": "application/json",
            }
            prefer = self.headers.get("Prefer")
            if prefer:
                headers["Prefer"] = prefer

            request = urllib.request.Request(
                target,
                data=body,
                headers=headers,
                method="HEAD" if head_only else self.command,
            )

            context = ssl._create_unverified_context()
            with urllib.request.urlopen(request, timeout=15, context=context) as response:
                payload = b"" if head_only else response.read()
                print(f"← Supabase proxy: {response.status} /{table_path}", flush=True)
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
                content_range = response.headers.get("Content-Range")
                if content_range:
                    self.send_header("Content-Range", content_range)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if not head_only:
                    self.wfile.write(payload)
        except urllib.error.HTTPError as e:
            payload = e.read()
            print(f"← Supabase proxy error: {e.code} {self.path}", flush=True)
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            print(f"← Supabase proxy exception: {e}", flush=True)
            payload = json.dumps({"message": str(e)}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
    def log_message(self, format, *args):
        print("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), format % args), flush=True)

class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


PORT = 8765
with ThreadingTCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
    print(f"✅ Sunucu hazır: http://localhost:{PORT}")
    httpd.serve_forever()
