import json
import os
import secrets
import sqlite3
import string
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, g, jsonify, request

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


def new_code(db):
    for _ in range(20):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if db.execute("SELECT 1 FROM maps WHERE id = ?", (code,)).fetchone() is None:
            return code
    raise RuntimeError("could not allocate a unique code")


@app.before_request
def rate_limit():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
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
    if request.headers.get("X-Client-Key") != CLIENT_KEY:
        return jsonify(error="Missing or invalid client key."), 401


@app.after_request
def add_cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Client-Key"
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
    return jsonify(id=code), 200


@app.route("/api/maps/<code>", methods=["DELETE"])
def delete_map(code):
    db = get_db()
    row = db.execute("SELECT 1 FROM maps WHERE id = ?", (code,)).fetchone()
    if row is None:
        return jsonify(error="Not found or expired."), 404
    db.execute("DELETE FROM maps WHERE id = ?", (code,))
    db.commit()
    return ("", 204)


def cleanup_loop():
    while True:
        try:
            cutoff = (datetime.now(timezone.utc) - EXPIRY).isoformat()
            db = sqlite3.connect(DB_PATH)
            db.execute("DELETE FROM maps WHERE last_touched < ?", (cutoff,))
            db.commit()
            db.close()
        except Exception:
            pass
        time.sleep(CLEANUP_INTERVAL_SECONDS)


init_db()
threading.Thread(target=cleanup_loop, daemon=True).start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
