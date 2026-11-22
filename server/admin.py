"""Catalog administration with local and hosted SQLite modes."""

import base64
import binascii
from collections import deque
from contextlib import closing
from hashlib import pbkdf2_hmac, sha256
import hmac
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import unquote, urlsplit

from PIL import Image, ImageOps, UnidentifiedImageError

from publisher import PublishError, push_overlay


PROJECT = Path(__file__).resolve().parent.parent
DIST = PROJECT / "dist"
BASELINE_PATH = DIST / "data" / "catalog.js"
STATE_DIR = Path(os.environ.get(
    "TK_ADMIN_STATE_DIR", Path(os.environ.get("LOCALAPPDATA", Path.home())) / "TobaccoKitchen"
))


def configured_public_origin(value):
    if not value:
        return None
    label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    match = re.fullmatch(rf"https://({label}(?:\.{label})+)/?", value, re.ASCII | re.IGNORECASE)
    if not match or len(match[1]) > 253 or match[1].rsplit(".", 1)[-1].isdigit():
        raise ValueError("TK_ADMIN_PUBLIC_ORIGIN must be a single HTTPS origin without a port or path")
    return f"https://{match[1].lower()}"


PUBLIC_ORIGIN = configured_public_origin(os.environ.get("TK_ADMIN_PUBLIC_ORIGIN"))
PAGES_ORIGIN = "https://liuyisi120800-cpu.github.io"
PORT = int(os.environ.get("TK_ADMIN_PORT", os.environ.get("PORT", "8767") if PUBLIC_ORIGIN else "8767"))
BIND = "0.0.0.0" if PUBLIC_ORIGIN else "127.0.0.1"
HOST = urlsplit(PUBLIC_ORIGIN).hostname if PUBLIC_ORIGIN else f"{BIND}:{PORT}"
VALID_HOSTS = {HOST, f"{HOST}:443"} if PUBLIC_ORIGIN else {HOST}
ORIGIN = PUBLIC_ORIGIN or f"http://{HOST}"
PUBLISH_DISABLED = bool(PUBLIC_ORIGIN) or os.environ.get("TK_ADMIN_DISABLE_PUBLISH") == "1"
MAX_BODY = 12 * 1024 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
IMAGE_PATH = re.compile(r"assets/products/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:webp|png|jpe?g|avif)", re.IGNORECASE)
UPLOAD = re.compile(r"data:image/(?:png|jpeg|jpg|webp|avif);base64,(.+)", re.DOTALL)
COOKIE = "tk_admin_session"
COOKIE_FLAGS = "Path=/; HttpOnly; SameSite=Strict" + ("; Secure" if PUBLIC_ORIGIN else "")
SESSION_SECONDS = 8 * 60 * 60


class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.body = {"error": message, **extra}


def read_baseline():
    source = BASELINE_PATH.read_text(encoding="utf-8")
    parser = json.JSONDecoder()
    array, _ = parser.raw_decode(source[source.index("["):])
    return {
        row["id"]: {
            **row,
            "region": row.get("region", "unknown"),
            "outOfStock": row.get("outOfStock", False),
            "revision": 0,
        }
        for row in array
    }


def crop_upload(value):
    if not isinstance(value, str) or not (match := UPLOAD.fullmatch(value)):
        raise ApiError(400, "请选择 PNG、JPEG、WebP 或 AVIF 图片。")
    try:
        source = base64.b64decode(match[1], validate=True)
        with Image.open(BytesIO(source)) as incoming:
            if incoming.width * incoming.height > 40_000_000:
                raise ApiError(400, "图片像素过大，请缩小后上传。")
            photo = ImageOps.exif_transpose(incoming)
            photo.thumbnail((1000, 1000), Image.Resampling.LANCZOS)
            if "A" in photo.getbands() or "transparency" in photo.info:
                transparent = photo.convert("RGBA")
                photo = Image.new("RGB", transparent.size, "white")
                photo.paste(transparent, mask=transparent.getchannel("A"))
            else:
                photo = photo.convert("RGB")
        for size, quality in ((1000, 86), (850, 80), (750, 76), (600, 72), (500, 66)):
            photo.thumbnail((size, size), Image.Resampling.LANCZOS)
            encoded = BytesIO()
            photo.save(encoded, format="WEBP", quality=quality, method=4)
            if encoded.tell() <= 128 * 1024:
                return encoded.getvalue()
    except (binascii.Error, OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ApiError(400, "无法读取图片，请检查文件格式。") from exc
    raise ApiError(400, "图片压缩后仍过大，请缩小后重试。")


def number(value, label):
    if value is None:
        return None
    if type(value) not in (int, float) or not 0 <= value <= MAX_SAFE_INTEGER or not math.isfinite(value):
        raise ApiError(400, f"{label}须为有效的非负数字。")
    return value


def field(data, key, label, limit, required=False):
    value = data.get(key, "")
    if not isinstance(value, str) or len(value.strip()) > limit or (required and not value.strip()):
        raise ApiError(400, f"请填写有效的{label}。")
    return value.strip()


def local_path(relative):
    dest = (DIST / relative).resolve()
    return dest if dest.is_relative_to(DIST.resolve()) and dest.is_file() else None


class Catalog:
    def __init__(self):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.path = STATE_DIR / "admin.sqlite3"
        self.baseline_lock = threading.Lock()
        self.baseline_mtime = BASELINE_PATH.stat().st_mtime_ns
        self.baseline = read_baseline()
        self.publish_event = threading.Event()
        with closing(self.connect()) as conn:
            conn.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS products (
                    id INTEGER PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS product_images (
                    path TEXT PRIMARY KEY,
                    content BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS catalog_status (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    revision INTEGER NOT NULL,
                    published_revision INTEGER NOT NULL,
                    next_id INTEGER NOT NULL,
                    state TEXT NOT NULL,
                    message TEXT
                );
                INSERT OR IGNORE INTO catalog_status VALUES (1, 0, 0, 1000000, 'idle', NULL);
                """
            )
            with conn:
                if PUBLIC_ORIGIN:
                    conn.execute("BEGIN IMMEDIATE")
                    if seed := os.environ.get("TK_ADMIN_CATALOG_SEED"):
                        self.seed_catalog(conn, seed)
                    conn.execute(
                        """UPDATE catalog_status SET published_revision = revision, state = 'published', message = NULL
                           WHERE revision > 0"""
                    )
                else:
                    conn.execute(
                        """UPDATE catalog_status SET state = 'pending', message = NULL
                           WHERE revision > published_revision"""
                    )
        if not PUBLISH_DISABLED:
            threading.Thread(target=self.publish_loop, daemon=True, name="catalog-publisher").start()
            self.publish_event.set()

    def seed_catalog(self, conn, source):
        status = conn.execute(
            """SELECT next_id FROM catalog_status WHERE id = 1 AND revision = 0 AND published_revision = 0
               AND NOT EXISTS (SELECT 1 FROM products) AND NOT EXISTS (SELECT 1 FROM product_images)"""
        ).fetchone()
        if status is None:
            return

        error = "TK_ADMIN_CATALOG_SEED must contain a valid published catalog update"
        try:
            seed = json.loads(source)
        except ValueError:
            raise ValueError(error) from None
        if not isinstance(seed, dict):
            raise ValueError(error)
        revision = seed.get("revision")
        products = seed.get("products")
        if type(revision) is not int or not 0 < revision < MAX_SAFE_INTEGER or not isinstance(products, list) or not products:
            raise ValueError(error)

        payloads = {}
        next_id = status["next_id"]
        for product in products:
            if not isinstance(product, dict):
                raise ValueError(error)
            item_id = product.get("id")
            item_revision = product.get("revision")
            if (type(item_id) is not int or not 0 <= item_id < MAX_SAFE_INTEGER or item_id in payloads
                    or type(item_revision) is not int or not 0 < item_revision <= revision
                    or not all(isinstance(product.get(key), str) and product[key].strip() for key in ("name", "brand"))):
                raise ValueError(error)
            try:
                self.validate_image(conn, product.get("image"))
                payloads[item_id] = json.dumps(product, ensure_ascii=False, allow_nan=False)
            except (ApiError, ValueError):
                raise ValueError(error) from None
            next_id = max(next_id, item_id + 1)

        conn.executemany("INSERT INTO products(id, payload) VALUES (?, ?)", payloads.items())
        conn.execute("UPDATE catalog_status SET revision = ?, next_id = ? WHERE id = 1", (revision, next_id))

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=8)
        connection.row_factory = sqlite3.Row
        return connection

    def baseline_products(self):
        with self.baseline_lock:
            latest = BASELINE_PATH.stat().st_mtime_ns
            if latest != self.baseline_mtime:
                self.baseline = read_baseline()
                self.baseline_mtime = latest
            return self.baseline

    def status(self, conn=None):
        if conn is None:
            with closing(self.connect()) as local:
                return self.status(local)
        row = conn.execute("SELECT * FROM catalog_status WHERE id = 1").fetchone()
        return {
            "state": row["state"],
            "message": row["message"],
            "revision": row["revision"],
            "publishedRevision": row["published_revision"],
        }

    def all_products(self):
        baseline = self.baseline_products()
        with closing(self.connect()) as conn, conn:
            conn.execute("BEGIN")
            changes = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM products ORDER BY id")]
            items = {**baseline, **{item["id"]: item for item in changes}}
            return {"products": list(items.values()), "sync": self.status(conn)}

    def public_updates(self):
        with closing(self.connect()) as conn, conn:
            conn.execute("BEGIN")
            revision = self.status(conn)["publishedRevision"]
            products = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM products ORDER BY id")]
            for product in products:
                path = product.get("image")
                if isinstance(path, str) and path.startswith("assets/products/admin-") and IMAGE_PATH.fullmatch(path):
                    product["image"] = f"{PUBLIC_ORIGIN}/{path}"
            return {"revision": revision, "products": products}

    def image(self, path):
        with closing(self.connect()) as conn:
            row = conn.execute("SELECT content FROM product_images WHERE path = ?", (path,)).fetchone()
            return row[0] if row else None

    def validate_image(self, conn, value):
        if value is None:
            return None
        if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(char) <= 32 for char in value):
            raise ApiError(400, "请输入有效的 HTTPS 图片网址。")
        if IMAGE_PATH.fullmatch(value):
            if local_path(value) or conn.execute("SELECT 1 FROM product_images WHERE path = ?", (value,)).fetchone():
                return value
            raise ApiError(400, "找不到指定的商品图片。")
        try:
            url = urlsplit(value)
        except ValueError as exc:
            raise ApiError(400, "请输入有效的 HTTPS 图片网址。") from exc
        if url.scheme != "https" or not url.hostname or url.username or url.password or "\\" in value:
            raise ApiError(400, "请输入有效的 HTTPS 图片网址。")
        return value

    def save(self, data, image_upload):
        if not isinstance(data, dict):
            raise ApiError(400, "缺少要保存的商品数据。")
        region = data.get("region")
        out_of_stock = data.get("outOfStock", False)
        if region not in ("domestic", "international", "unknown") or type(out_of_stock) is not bool:
            raise ApiError(400, "请检查国内外分类和库存状态。")
        product = {
            "name": field(data, "name", "烟品名称", 160, True),
            "brand": field(data, "brand", "品牌", 120, True),
            "region": region,
            "price": number(data.get("price"), "价格"),
            "tar": number(data.get("tar"), "焦油"),
            "nicotine": number(data.get("nicotine"), "尼古丁"),
            "type": field(data, "type", "规格", 160),
            "description": field(data, "description", "介绍", 4000),
            "outOfStock": out_of_stock,
        }
        item_id = data.get("id")
        seen = data.get("revision", 0)
        if (item_id is not None and (type(item_id) is not int or item_id < 0)
                or type(seen) is not int or seen < 0):
            raise ApiError(400, "商品编号或版本无效。")
        compressed = crop_upload(image_upload) if image_upload is not None else None
        baseline = self.baseline_products()
        with closing(self.connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            status = conn.execute("SELECT * FROM catalog_status WHERE id = 1").fetchone()
            next_id = status["next_id"]
            if item_id is None:
                while next_id in baseline:
                    next_id += 1
                item_id = next_id
                next_id += 1
            else:
                row = conn.execute("SELECT payload FROM products WHERE id = ?", (item_id,)).fetchone()
                previous = json.loads(row[0]) if row else baseline.get(item_id)
                if previous is None:
                    raise ApiError(404, "未找到该商品。")
                if seen != previous["revision"]:
                    raise ApiError(409, "商品已在其他窗口更新，请重新载入后再修改。", code="conflict")
                for key in ("variant", "alias"):
                    if key in previous:
                        product[key] = previous[key]
            if compressed is not None:
                image = f"assets/products/admin-{item_id}-{sha256(compressed).hexdigest()[:16]}.webp"
                conn.execute("INSERT OR IGNORE INTO product_images VALUES (?, ?)", (image, compressed))
            else:
                image = self.validate_image(conn, data.get("image"))
            revision = status["revision"] + 1
            product.update(id=item_id, revision=revision, image=image)
            conn.execute(
                """INSERT INTO products(id, payload) VALUES (?, ?)
                   ON CONFLICT(id) DO UPDATE SET payload=excluded.payload""",
                (item_id, json.dumps(product, ensure_ascii=False, allow_nan=False)),
            )
            state = "publishing" if status["state"] == "publishing" else "pending"
            published = status["published_revision"]
            if PUBLIC_ORIGIN:
                state = "published"
                published = revision
            conn.execute(
                """UPDATE catalog_status SET revision = ?, published_revision = ?, next_id = ?,
                   state = ?, message = NULL WHERE id = 1""",
                (revision, published, next_id, state),
            )
            result = {"product": product, "sync": self.status(conn)}
        self.publish_event.set()
        return result

    def retry(self):
        if PUBLIC_ORIGIN:
            return self.status()
        with closing(self.connect()) as conn, conn:
            conn.execute(
                """UPDATE catalog_status SET state = 'pending', message = NULL
                   WHERE revision > published_revision AND state != 'publishing'"""
            )
            result = self.status(conn)
        self.publish_event.set()
        return result

    def publish_loop(self):
        while True:
            self.publish_event.wait()
            self.publish_event.clear()
            try:
                self.publish_once()
            except Exception:
                with closing(self.connect()) as conn, conn:
                    conn.execute(
                        "UPDATE catalog_status SET state = 'error', message = ? WHERE id = 1",
                        ("发布服务遇到错误，请重试。",),
                    )

    def publish_once(self):
        with closing(self.connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            status = self.status(conn)
            revision = status["revision"]
            if revision <= status["publishedRevision"]:
                return
            products = [json.loads(row[0]) for row in conn.execute("SELECT payload FROM products ORDER BY id")]
            paths = {item.get("image") for item in products}
            images = {
                row[0]: row[1]
                for row in conn.execute("SELECT path, content FROM product_images")
                if row[0] in paths
            }
            conn.execute("UPDATE catalog_status SET state = 'publishing', message = NULL WHERE id = 1")
        try:
            push_overlay(revision, products, images)
        except PublishError as exc:
            with closing(self.connect()) as conn, conn:
                conn.execute(
                    "UPDATE catalog_status SET state = 'error', message = ? WHERE id = 1", (str(exc),)
                )
            return
        with closing(self.connect()) as conn, conn:
            conn.execute(
                """UPDATE catalog_status
                   SET published_revision = ?, state = CASE WHEN revision = ? THEN 'published' ELSE 'pending' END,
                       message = NULL
                   WHERE id = 1""",
                (revision, revision),
            )
            if self.status(conn)["revision"] > revision:
                self.publish_event.set()


class Authentication:
    def __init__(self):
        source = os.environ.get("TK_ADMIN_CONFIG")
        if source is None:
            source = (STATE_DIR / "admin-config.json").read_text(encoding="utf-8-sig")
        try:
            config = json.loads(source)
        except ValueError:
            raise ValueError("Invalid administrator credential configuration") from None
        self.username = config["username"].encode("utf-8")
        self.salt = bytes.fromhex(config["salt"])
        self.digest = bytes.fromhex(config["passwordHash"])
        self.iterations = int(config["iterations"])
        if not self.username or len(self.salt) < 16 or len(self.digest) != 32 or not 100_000 <= self.iterations <= 10_000_000:
            raise ValueError("Invalid administrator credential configuration")
        self.lock = threading.Lock()
        self.failures = deque()
        self.sessions = {}

    def login(self, username, password):
        if not isinstance(username, str) or not isinstance(password, str) or len(username) > 256 or len(password) > 1024:
            raise ApiError(400, "请输入有效的账号和密码。")
        with self.lock:
            now = time.monotonic()
            while self.failures and self.failures[0] <= now - 60:
                self.failures.popleft()
            if len(self.failures) >= 5:
                raise ApiError(429, "尝试次数过多，请稍后再试。")
            computed = pbkdf2_hmac("sha256", password.encode(), self.salt, self.iterations)
            if not (hmac.compare_digest(self.username, username.encode()) & hmac.compare_digest(self.digest, computed)):
                self.failures.append(now)
                raise ApiError(401, "账号或密码错误。")
            self.failures.clear()
            self.sessions = {token: record for token, record in self.sessions.items() if record[1] > now}
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.sessions[token] = (csrf, now + SESSION_SECONDS)
            return token, csrf

    def verify(self, token):
        with self.lock:
            record = self.sessions.get(token)
            if record and record[1] > time.monotonic():
                return record[0]
            self.sessions.pop(token, None)
            return None

    def logout(self, token):
        with self.lock:
            self.sessions.pop(token, None)


class Handler(BaseHTTPRequestHandler):
    server_version = "TobaccoKitchen"
    sys_version = ""

    def log_message(self, format, *args):
        pass

    def write(self, status, content, content_type, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if PUBLIC_ORIGIN:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self'; "
            "script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def json(self, status, body, headers=None):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.write(status, data, "application/json; charset=utf-8", headers)

    def body(self):
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ApiError(415, "请求格式须为 JSON。")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ApiError(400, "无效的请求长度。") from exc
        if length < 0 or length > MAX_BODY or self.headers.get("Transfer-Encoding"):
            raise ApiError(413, "请求过大。")
        try:
            value = json.loads(self.rfile.read(length)) if length else {}
        except (ValueError, UnicodeError) as exc:
            raise ApiError(400, "无法读取请求内容。") from exc
        if not isinstance(value, dict):
            raise ApiError(400, "无法读取请求内容。")
        return value

    def token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return ""
        return cookie[COOKIE].value if COOKIE in cookie else ""

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.dispatch(False)

    def do_POST(self):
        self.dispatch(True)

    def dispatch(self, post):
        try:
            hosts = self.headers.get_all("Host", [])
            if len(hosts) != 1 or hosts[0].lower() not in VALID_HOSTS:
                raise ApiError(403, "开发者服务不接受此网址。" if PUBLIC_ORIGIN else "开发者服务只接受本机地址。")
            path = unquote(urlsplit(self.path).path, errors="strict")
            if PUBLIC_ORIGIN and path == "/api/catalog/updates" and not post:
                headers = {"Vary": "Origin"}
                if self.headers.get("Origin") == PAGES_ORIGIN:
                    headers["Access-Control-Allow-Origin"] = PAGES_ORIGIN
                self.json(200, self.server.catalog.public_updates(), headers)
            elif path.startswith("/api/admin/"):
                self.api(path, post)
            elif post:
                raise ApiError(404, "没有找到该页面。")
            else:
                self.static(path)
        except ApiError as exc:
            self.json(exc.status, exc.body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass
        except (UnicodeError, ValueError):
            self.json(400, {"error": "请求无效。"})
        except Exception:
            self.json(500, {"error": "开发者服务遇到错误，请重试。"})

    def api(self, path, post):
        if post and self.headers.get_all("Origin", []) != [ORIGIN]:
            raise ApiError(403, "请在开发者页面提交请求。" if PUBLIC_ORIGIN else "请在本机开发者页面提交请求。")
        auth = self.server.auth
        catalog = self.server.catalog
        token = self.token()
        csrf = auth.verify(token)
        if path == "/api/admin/session" and not post:
            self.json(200, {"authenticated": bool(csrf), **({"csrfToken": csrf} if csrf else {})})
            return
        if path == "/api/admin/login" and post:
            body = self.body()
            new_token, csrf = auth.login(body.get("username"), body.get("password"))
            auth.logout(token)
            cookie = f"{COOKIE}={new_token}; {COOKIE_FLAGS}; Max-Age={SESSION_SECONDS}"
            self.json(200, {"authenticated": True, "csrfToken": csrf}, {"Set-Cookie": cookie})
            return
        if not csrf:
            raise ApiError(401, "请先登录开发者模式。")
        if post and not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), csrf):
            raise ApiError(403, "会话验证失败，请重新登录。")
        if path == "/api/admin/catalog" and not post:
            self.json(200, catalog.all_products())
        elif path == "/api/admin/sync":
            if post:
                self.body()
            self.json(200, catalog.retry() if post else catalog.status())
        elif path == "/api/admin/products" and post:
            body = self.body()
            self.json(200, catalog.save(body.get("product"), body.get("imageUpload")))
        elif path == "/api/admin/logout" and post:
            self.body()
            auth.logout(token)
            self.json(200, {"authenticated": False}, {
                "Set-Cookie": f"{COOKIE}=; {COOKIE_FLAGS}; Max-Age=0",
            })
        else:
            raise ApiError(404, "没有找到该操作。")

    def static(self, path):
        if path in ("/", "/admin", "/admin/"):
            path = "/admin.html"
        if path not in ("/admin.html", "/admin.js", "/admin.css", "/styles.css") and not path.startswith("/assets/"):
            raise ApiError(404, "没有找到该页面。")
        relative = path[1:]
        if ".." in relative.split("/") or "\\" in relative:
            raise ApiError(404, "没有找到该页面。")
        if IMAGE_PATH.fullmatch(relative) and relative.startswith("assets/products/admin-"):
            content = self.server.catalog.image(relative)
            if content:
                self.write(200, content, "image/webp")
                return
        dest = local_path(relative)
        if not dest:
            raise ApiError(404, "没有找到该页面。")
        mime = mimetypes.guess_type(dest.name)[0] or "application/octet-stream"
        if mime.startswith("text/") or dest.suffix == ".js":
            mime = f"{mime}; charset=utf-8"
        self.write(200, dest.read_bytes(), mime)


def main():
    auth = Authentication()
    catalog = Catalog()
    with ThreadingHTTPServer((BIND, PORT), Handler) as server:
        server.auth = auth
        server.catalog = catalog
        print(f"Catalog administration: {ORIGIN}/admin", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
