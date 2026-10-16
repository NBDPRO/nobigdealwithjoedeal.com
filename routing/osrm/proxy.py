"""routing/osrm/proxy.py: the routing service's only public port.

Why a proxy: OSRM's HTTP API is GET with the coordinates in the URL path, and
Cloud Run's request log records every URL. Callers POST the stops as JSON
here instead, so no coordinate ever lands in a log; the proxy asks OSRM on
loopback and returns durations, distances and (optionally) the road geometry.
It never logs a request body or a coordinate (log_message is silenced).

POST /v1/route  {"coords": [[lng, lat], ...] (2..25), "geometry": true|false}
  -> 200 {"ok": true, "legs": [{"sec": n, "m": n}, ...], "sec": n, "m": n,
          "geometry": "<polyline6>" | null}
  -> 200 {"ok": false, "reason": "no_route" | "outside"}   (nothing routable)
  -> 400 bad input, 503 OSRM still starting
GET /healthz -> 200 once OSRM answers.
"""
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OSRM = os.environ.get("OSRM_URL", "http://127.0.0.1:5001")
# Must match the graph's clip box (Dockerfile BBOX): west, south, east, north.
BBOX = tuple(float(x) for x in os.environ.get("BBOX", "-85.40,37.55,-83.65,39.75").split(","))
MAX_STOPS = 25
MAX_BODY = 16 * 1024
START_WAIT_S = 9.0


def in_box(lng, lat):
    w, s, e, n = BBOX
    return w <= lng <= e and s <= lat <= n


def parse(body):
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:
        return None, "bad json"
    coords = data.get("coords") if isinstance(data, dict) else None
    if not isinstance(coords, list) or not (2 <= len(coords) <= MAX_STOPS):
        return None, "coords must be 2..%d points" % MAX_STOPS
    out = []
    for c in coords:
        if not (isinstance(c, list) and len(c) == 2 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in c)):
            return None, "each point is [lng, lat]"
        lng, lat = float(c[0]), float(c[1])
        if not (-180 <= lng <= 180 and -90 <= lat <= 90):
            return None, "each point is [lng, lat]"
        out.append((round(lng, 6), round(lat, 6)))
    return {"coords": out, "geometry": data.get("geometry") is True}, None


def osrm_route(req):
    path = ";".join("%.6f,%.6f" % c for c in req["coords"])
    q = "overview=full&geometries=polyline6" if req["geometry"] else "overview=false"
    url = "%s/route/v1/driving/%s?%s&steps=false&annotations=false&continue_straight=false" % (OSRM, path, q)
    deadline = time.time() + START_WAIT_S
    while True:
        try:
            with urllib.request.urlopen(url, timeout=8) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode("utf-8"))
            except Exception:
                return {"code": "Error"}
        except (urllib.error.URLError, ConnectionError, OSError):
            if time.time() > deadline:
                return None
            time.sleep(0.25)


class Handler(BaseHTTPRequestHandler):
    server_version = "nbd-routing"
    sys_version = ""

    def log_message(self, *args):  # never log: request lines can carry data
        pass

    def _send(self, status, obj):
        body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/healthz":
            return self._send(404, {"ok": False})
        try:
            with urllib.request.urlopen(OSRM + "/nearest/v1/driving/-84.512,39.103", timeout=3) as r:
                return self._send(200 if r.status == 200 else 503, {"ok": r.status == 200})
        except Exception:
            return self._send(503, {"ok": False})

    def do_POST(self):
        if self.path != "/v1/route":
            return self._send(404, {"ok": False})
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            return self._send(400, {"ok": False, "reason": "body"})
        req, err = parse(self.rfile.read(n))
        if err:
            return self._send(400, {"ok": False, "reason": err})
        if not all(in_box(*c) for c in req["coords"]):
            return self._send(200, {"ok": False, "reason": "outside"})
        res = osrm_route(req)
        if res is None:
            return self._send(503, {"ok": False, "reason": "starting"})
        routes = res.get("routes") or []
        if res.get("code") != "Ok" or not routes:
            return self._send(200, {"ok": False, "reason": "no_route"})
        r0 = routes[0]
        legs = [{"sec": round(l.get("duration", 0)), "m": round(l.get("distance", 0))} for l in (r0.get("legs") or [])]
        return self._send(200, {
            "ok": True, "legs": legs, "sec": round(r0.get("duration", 0)), "m": round(r0.get("distance", 0)),
            "geometry": r0.get("geometry") if req["geometry"] else None,
        })


if __name__ == "__main__":
    ThreadingHTTPServer((os.environ.get("HOST", "0.0.0.0"), int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
