import json
import logging
import os
import re
import secrets
import sqlite3
import string
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, g, jsonify, request

logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mush-map-api")

DB_PATH = os.environ.get("DB_PATH", "/data/maps.db")
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
CLIENT_KEY = os.environ.get("CLIENT_KEY", "")
MAX_BODY_BYTES = 3 * 1024 * 1024
EXPIRY = timedelta(days=7)
CLEANUP_INTERVAL_SECONDS = int(os.environ.get("CLEANUP_INTERVAL_SECONDS", 3600))
CODE_ALPHABET = string.ascii_letters + string.digits
CODE_LEN = 6

RATE_LIMIT_WINDOW = 60
RATE_LIMIT_MAX = 30
_rate_state = {}
_rate_lock = threading.Lock()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES


def get_db():
    db = getattr(g, "_db", None)
    if db is None:
        db = g._db = sqlite3.connect(DB_PATH)
    return db


@app.teardown_appcontext
def close_db(_exc):
    db = getattr(g, "_db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute(
        "CREATE TABLE IF NOT EXISTS maps (id TEXT PRIMARY KEY, data TEXT NOT NULL, last_touched TEXT NOT NULL)"
    )
    db.commit()
    db.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def client_ip():
    return request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()


def new_code(db):
    for _ in range(20):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if db.execute("SELECT 1 FROM maps WHERE id = ?", (code,)).fetchone() is None:
            return code
    raise RuntimeError("could not allocate a unique code")


# Live relay polling (see below) runs about once a second per linked browser, far above
# RATE_LIMIT_MAX; it has its own per-link cap instead.
RELAY_POLL_PATH = re.compile(r"^/api/relay/[^/]+/(up|down)$")


@app.before_request
def rate_limit():
    if RELAY_POLL_PATH.match(request.path):
        return None
    ip = client_ip()
    now = time.monotonic()
    with _rate_lock:
        hits = _rate_state.setdefault(ip, [])
        hits[:] = [t for t in hits if now - t < RATE_LIMIT_WINDOW]
        if len(hits) >= RATE_LIMIT_MAX:
            return jsonify(error="Too many requests, slow down."), 429
        hits.append(now)


# Not real auth (the key ships in the frontend JS, so anyone who looks can extract it) -
# just a filter against generic spam bots/scanners that probe for open POST endpoints
# without knowing to send this header. Only gates writes; reading still just needs the code.
@app.before_request
def require_client_key():
    if request.method in ("GET", "OPTIONS") or not CLIENT_KEY:
        return None
    # the bridge on the PbN site can't know the key; a relay's long random code is its key
    if RELAY_POLL_PATH.match(request.path):
        return None
    if request.headers.get("X-Client-Key") != CLIENT_KEY:
        return jsonify(error="Missing or invalid client key."), 401


@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Client-Key"
    return resp


@app.after_request
def log_request(resp):
    if RELAY_POLL_PATH.match(request.path) and resp.status_code < 400:
        return resp   # once a second per linked browser: would drown everything else
    log.info("%s %s %s %s", client_ip(), request.method, request.path, resp.status_code)
    return resp


@app.route("/api/maps/<code>", methods=["OPTIONS"])
@app.route("/api/maps", methods=["OPTIONS"])
def cors_preflight(code=None):
    return ("", 204)


def parse_map_body():
    if request.content_length and request.content_length > MAX_BODY_BYTES:
        return None, (jsonify(error="Map is too large."), 413)
    try:
        data = request.get_json(force=True, silent=False)
    except Exception:
        return None, (jsonify(error="Invalid JSON body."), 400)
    if not isinstance(data, dict) or "rooms" not in data:
        return None, (jsonify(error="Not a valid map (missing 'rooms')."), 400)
    return data, None


@app.route("/api/maps", methods=["POST"])
def create_map():
    data, err = parse_map_body()
    if err:
        return err
    db = get_db()
    code = new_code(db)
    db.execute(
        "INSERT INTO maps (id, data, last_touched) VALUES (?, ?, ?)",
        (code, json.dumps(data), now_iso()),
    )
    db.commit()
    log.info("created map %s (%d bytes)", code, len(json.dumps(data)))
    return jsonify(id=code), 201


@app.route("/api/maps/<code>", methods=["GET"])
def get_map(code):
    db = get_db()
    row = db.execute("SELECT data FROM maps WHERE id = ?", (code,)).fetchone()
    if row is None:
        return jsonify(error="Not found or expired."), 404
    db.execute("UPDATE maps SET last_touched = ? WHERE id = ?", (now_iso(), code))
    db.commit()
    return app.response_class(row[0], mimetype="application/json")


@app.route("/api/maps/<code>", methods=["PUT"])
def update_map(code):
    db = get_db()
    row = db.execute("SELECT 1 FROM maps WHERE id = ?", (code,)).fetchone()
    if row is None:
        return jsonify(error="Not found or expired."), 404
    data, err = parse_map_body()
    if err:
        return err
    db.execute(
        "UPDATE maps SET data = ?, last_touched = ? WHERE id = ?",
        (json.dumps(data), now_iso(), code),
    )
    db.commit()
    log.info("updated map %s (%d bytes)", code, len(json.dumps(data)))
    return jsonify(id=code), 200


@app.route("/api/maps/<code>", methods=["DELETE"])
def delete_map(code):
    db = get_db()
    row = db.execute("SELECT 1 FROM maps WHERE id = ?", (code,)).fetchone()
    if row is None:
        return jsonify(error="Not found or expired."), 404
    db.execute("DELETE FROM maps WHERE id = ?", (code,))
    db.commit()
    log.info("deleted map %s", code)
    return ("", 204)


# ---------- Live relay (js/live.js, userscript/mush-mapper-bridge.user.js) ----------
# Lets a PbN tab in another browser feed one mapper. That browser's bridge posts its game events to
# "up" and polls "down" for commands; the mapper polls "up" and posts to "down". Memory only (a
# restart just unlinks), each side keeps its last RELAY_KEEP items, and a link nobody has touched
# for RELAY_TTL is dropped. Creating a link needs the client key; using one needs only its code.
RELAY_TTL = 24 * 3600
RELAY_KEEP = 200
RELAY_MAX_BODY = 64 * 1024
RELAY_MAX_ITEMS = 50
RELAY_RATE_MAX = 600          # requests per minute per link, both browsers together
RELAY_SIDES = ("up", "down")
_relays = {}                  # code -> {touched, hits, up:[{seq, item}], down:[...], seq:{up, down}}
_relay_lock = threading.Lock()


def relay_get(code):
    """The link, touched and rate-checked, or an error response. Call with _relay_lock held."""
    r = _relays.get(code)
    if r is None:
        return None, (jsonify(error="Link not found or expired."), 404)
    now = time.monotonic()
    r["hits"] = [t for t in r["hits"] if now - t < RATE_LIMIT_WINDOW]
    if len(r["hits"]) >= RELAY_RATE_MAX:
        return None, (jsonify(error="Too many requests, slow down."), 429)
    r["hits"].append(now)
    r["touched"] = time.time()
    return r, None


@app.route("/api/relay", methods=["OPTIONS"])
@app.route("/api/relay/<code>", methods=["OPTIONS"])
@app.route("/api/relay/<code>/<side>", methods=["OPTIONS"])
def relay_preflight(code=None, side=None):
    return ("", 204)


@app.route("/api/relay", methods=["POST"])
def relay_create():
    code = secrets.token_urlsafe(18)
    with _relay_lock:
        _relays[code] = {"touched": time.time(), "hits": [], "up": [], "down": [], "seq": {"up": 0, "down": 0}}
    log.info("relay created")
    return jsonify(code=code), 201


@app.route("/api/relay/<code>/<side>", methods=["GET"])
def relay_read(code, side):
    if side not in RELAY_SIDES:
        return jsonify(error="Unknown side."), 404
    try:
        after = int(request.args.get("after", "-1"))
    except ValueError:
        return jsonify(error="Bad 'after'."), 400
    with _relay_lock:
        r, err = relay_get(code)
        if err:
            return err
        last = r["seq"][side]
        # after=-1: just where the list stands, so a reader starts with what comes next
        items = [] if after < 0 else [x["item"] for x in r[side] if x["seq"] > after]
    return jsonify(items=items, last=last)


@app.route("/api/relay/<code>/<side>", methods=["POST"])
def relay_write(code, side):
    if side not in RELAY_SIDES:
        return jsonify(error="Unknown side."), 404
    if request.content_length and request.content_length > RELAY_MAX_BODY:
        return jsonify(error="Too large."), 413
    try:
        body = request.get_json(force=True, silent=False)
    except Exception:
        return jsonify(error="Invalid JSON body."), 400
    items = body.get("items") if isinstance(body, dict) else None
    if not isinstance(items, list) or len(items) > RELAY_MAX_ITEMS or not all(isinstance(i, dict) for i in items):
        return jsonify(error="Expected {items: [...]}."), 400
    with _relay_lock:
        r, err = relay_get(code)
        if err:
            return err
        for item in items:
            r["seq"][side] += 1
            r[side].append({"seq": r["seq"][side], "item": item})
        del r[side][:-RELAY_KEEP]
        last = r["seq"][side]
    return jsonify(last=last)


@app.route("/api/relay/<code>", methods=["DELETE"])
def relay_delete(code):
    with _relay_lock:
        gone = _relays.pop(code, None)
    if gone is None:
        return jsonify(error="Link not found or expired."), 404
    log.info("relay deleted")
    return ("", 204)


def relay_cleanup():
    cutoff = time.time() - RELAY_TTL
    with _relay_lock:
        stale = [c for c, r in _relays.items() if r["touched"] < cutoff]
        for c in stale:
            del _relays[c]
    if stale:
        log.info("cleanup: dropped %d idle relay link(s)", len(stale))


def cleanup_loop():
    while True:
        try:
            relay_cleanup()
        except Exception:
            log.exception("relay cleanup failed")
        try:
            cutoff = (datetime.now(timezone.utc) - EXPIRY).isoformat()
            db = sqlite3.connect(DB_PATH)
            cur = db.execute("DELETE FROM maps WHERE last_touched < ?", (cutoff,))
            db.commit()
            db.close()
            if cur.rowcount:
                log.info("cleanup: purged %d expired map(s)", cur.rowcount)
        except Exception:
            log.exception("cleanup sweep failed")
        time.sleep(CLEANUP_INTERVAL_SECONDS)


init_db()
threading.Thread(target=cleanup_loop, daemon=True).start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
