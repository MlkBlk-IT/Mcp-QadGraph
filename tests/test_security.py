"""Tests de securite du dashboard : CORS, Host/Origin, proxy lecture seule, SSRF.

Aucun Qdrant requis : de faux serveurs HTTP servent de cible.
Lancer :  python -m unittest discover -s tests -v
"""
import http.client
import importlib.util
import json
import os
import socket
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def make_stub():
    """Faux serveur HTTP qui enregistre chaque requete recue."""
    hits = []

    class Handler(BaseHTTPRequestHandler):
        def _reply(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n:
                self.rfile.read(n)
            hits.append((self.command, self.path))
            body = b'{"result": "stub"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = _reply

        def log_message(self, *args):
            pass

    port = free_port()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, port, hits


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.up, up_port, cls.up_hits = make_stub()        # faux Qdrant
        cls.evil, cls.evil_port, cls.evil_hits = make_stub()  # cible SSRF
        cls.port = free_port()
        os.environ["QADGRAPH_PORT"] = str(cls.port)
        os.environ["QADGRAPH_HOST"] = "127.0.0.1"
        os.environ["QADGRAPH_QDRANT"] = "http://127.0.0.1:%d" % up_port
        spec = importlib.util.spec_from_file_location(
            "qadgraph_server_under_test", ROOT / "qadgraph" / "server.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        cls.dash = ThreadingHTTPServer(("127.0.0.1", cls.port), mod.Handler)
        threading.Thread(target=cls.dash.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for srv in (cls.dash, cls.up, cls.evil):
            srv.shutdown()
            srv.server_close()

    def setUp(self):
        self.up_hits.clear()
        self.evil_hits.clear()

    def call(self, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        hdrs = dict(headers or {})
        if data is not None:
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=data, headers=hdrs)
        resp = conn.getresponse()
        out = (resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read())
        conn.close()
        return out

    SEARCH = {"path": "/collections/c/points/search", "body": {"vector": [0.1], "limit": 1}}

    # -- CORS / Host / Origin ------------------------------------------------
    def test_no_permissive_cors_header(self):
        status, headers, _ = self.call("GET", "/favicon.ico")
        self.assertEqual(status, 200)
        self.assertNotIn("access-control-allow-origin", headers)

    def test_options_preflight_not_allowed(self):
        status, headers, _ = self.call("OPTIONS", "/api/qdrant/proxy")
        self.assertEqual(status, 405)
        self.assertNotIn("access-control-allow-origin", headers)

    def test_foreign_host_blocked_dns_rebinding(self):
        status, _, _ = self.call("GET", "/favicon.ico", headers={"Host": "evil.example:%d" % self.port})
        self.assertEqual(status, 403)

    def test_foreign_origin_post_blocked_and_not_forwarded(self):
        status, _, _ = self.call("POST", "/api/qdrant/proxy",
                                 headers={"Origin": "http://evil.example"}, body=self.SEARCH)
        self.assertEqual(status, 403)
        self.assertEqual(self.up_hits, [])

    def test_null_origin_blocked(self):
        status, _, _ = self.call("POST", "/api/qdrant/proxy",
                                 headers={"Origin": "null"}, body=self.SEARCH)
        self.assertEqual(status, 403)

    def test_same_origin_post_allowed(self):
        status, _, _ = self.call("POST", "/api/qdrant/proxy",
                                 headers={"Origin": "http://127.0.0.1:%d" % self.port}, body=self.SEARCH)
        self.assertEqual(status, 200)
        self.assertEqual(self.up_hits, [("POST", "/collections/c/points/search")])

    # -- proxy lecture seule -------------------------------------------------
    def test_proxy_post_write_routes_refused(self):
        for p in ("/collections/c/points/delete", "/collections/c/points",
                  "/collections/c/snapshots", "/collections/c/index",
                  "/collections/c/points/payload"):
            status, _, _ = self.call("POST", "/api/qdrant/proxy", body={"path": p, "body": {}})
            self.assertEqual(status, 403, p)
        self.assertEqual(self.up_hits, [])

    def test_proxy_post_read_route_forwarded(self):
        status, _, _ = self.call("POST", "/api/qdrant/proxy", body=self.SEARCH)
        self.assertEqual(status, 200)
        self.assertEqual(self.up_hits, [("POST", "/collections/c/points/search")])

    def test_proxy_get_relative_path_forwarded(self):
        status, _, _ = self.call("GET", "/api/qdrant/proxy?path=" + urllib.parse.quote("/collections", safe=""))
        self.assertEqual(status, 200)
        self.assertEqual(self.up_hits, [("GET", "/collections")])

    # -- SSRF ----------------------------------------------------------------
    def test_proxy_get_ssrf_authority_rewrite_refused(self):
        evil = "@127.0.0.1:%d/x" % self.evil_port
        status, _, _ = self.call("GET", "/api/qdrant/proxy?path=" + urllib.parse.quote(evil, safe=""))
        self.assertEqual(status, 400)
        self.assertEqual(self.evil_hits, [])

    def test_proxy_post_ssrf_refused(self):
        evil = "@127.0.0.1:%d/collections/c/points/search" % self.evil_port
        status, _, _ = self.call("POST", "/api/qdrant/proxy", body={"path": evil, "body": {}})
        self.assertEqual(status, 403)
        self.assertEqual(self.evil_hits, [])

    def test_proxy_dotdot_refused(self):
        status, _, _ = self.call("GET", "/api/qdrant/proxy?path=" + urllib.parse.quote("/collections/../x", safe=""))
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
