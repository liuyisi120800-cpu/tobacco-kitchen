"""Publish catalog overlays without exposing the administrator database."""

import base64
import hashlib
import json
import os
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4


REPOSITORY = "liuyisi120800-cpu/tobacco-kitchen"
PUBLIC_URL = "https://liuyisi120800-cpu.github.io/tobacco-kitchen/"
REF = "main"
BATCH_BYTES = 192 * 1024
COMMIT_QUERY = """mutation Publish($input:CreateCommitOnBranchInput!) {
  createCommitOnBranch(input:$input) { commit { oid } }
}"""


class PublishError(Exception):
    """An error safe to show in the local administrator view."""


def github(endpoint, *, method=None, payload=None):
    args = ["gh", "api", endpoint]
    if method:
        args.extend(["--method", method])
    if payload is not None:
        args.extend(["--input", "-"])
    try:
        result = subprocess.run(
            args,
            input=(json.dumps(payload).encode("utf-8") if payload is not None else None),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=40,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            env={**os.environ, "GH_PROMPT_DISABLED": "1"},
            check=False,
        )
    except FileNotFoundError as exc:
        raise PublishError("找不到 GitHub CLI。请恢复命令行发布环境后重试。") from exc
    except subprocess.TimeoutExpired as exc:
        raise PublishError("GitHub 发布请求超时，请重试。") from exc
    if result.returncode:
        raise PublishError("GitHub 拒绝了发布请求。请检查网络及 GitHub CLI 登录后重试。")
    if result.stdout:
        try:
            body = json.loads(result.stdout)
        except ValueError as exc:
            raise PublishError("GitHub 返回了无法读取的发布响应，请重试。") from exc
        if isinstance(body, dict) and body.get("errors"):
            raise PublishError("GitHub 拒绝了发布请求，请重试。")
        return body
    return None


def blob_hash(content):
    return hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()


def batches(files):
    group = []
    used = 0
    for path, content in sorted(files.items(), key=lambda item: len(item[1])):
        if group and (len(group) >= 12 or used + len(content) > BATCH_BYTES):
            yield group
            group = []
            used = 0
        group.append({"path": path, "contents": base64.b64encode(content).decode("ascii")})
        used += len(content)
    if group:
        yield group


def push_overlay(revision, products, images):
    overlay = json.dumps(
        {"revision": revision, "products": products}, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8") + b"\n"
    files = {"data/updates.json": overlay, **images}
    root = f"repos/{REPOSITORY}"
    base = github(f"{root}/git/ref/heads/{REF}")["object"]["sha"]
    tree = github(f"{root}/git/trees/{base}?recursive=1")
    if tree.get("truncated"):
        raise PublishError("公开目录较大，暂时无法核对发布文件。")
    hashes = {entry["path"]: entry["sha"] for entry in tree["tree"] if entry["type"] == "blob"}
    changed = {path: content for path, content in files.items() if hashes.get(path) != blob_hash(content)}
    if changed:
        branch = f"catalog-admin-{uuid4().hex[:14]}" if len(changed) > 1 else REF
        if branch != REF:
            github(f"{root}/git/refs", method="POST", payload={"ref": f"refs/heads/{branch}", "sha": base})
        head = base
        try:
            for group in batches(changed):
                result = github("graphql", method="POST", payload={"query": COMMIT_QUERY, "variables": {"input": {
                    "branch": {"repositoryNameWithOwner": REPOSITORY, "branchName": branch},
                    "expectedHeadOid": head,
                    "message": {"headline": f"Update catalog revision {revision}"},
                    "fileChanges": {"additions": group},
                }}})
                head = result["data"]["createCommitOnBranch"]["commit"]["oid"]
            if branch != REF:
                updated = github(f"{root}/git/refs/heads/{REF}", method="PATCH", payload={"sha": head, "force": False})
                if updated["object"]["sha"] != head:
                    raise PublishError("公开目录的发布分支响应异常，请重试。")
        finally:
            if branch != REF:
                try:
                    github(f"{root}/git/refs/heads/{branch}", method="DELETE")
                except PublishError:
                    pass
    wait_for_public_overlay(revision, overlay)


def wait_for_public_overlay(revision, expected):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        request = Request(
            f"{PUBLIC_URL}data/updates.json?revision={revision}&check={uuid4().hex[:8]}",
            headers={"Cache-Control": "no-cache", "User-Agent": "TobaccoKitchenCatalog/1.0"},
        )
        try:
            with urlopen(request, timeout=5) as response:
                if response.read(len(expected) + 1) == expected:
                    return
        except (HTTPError, URLError, TimeoutError):
            pass
        time.sleep(3)
    raise PublishError("GitHub 已收到更新，但公开页面还未同步。请稍后重试确认。")
