#!/usr/bin/env python3
"""生成仓库根目录的外部应用源文件 fnpack.json（FnDepot 外部源 V2 规范）。

数据来源全部取自仓库内既有文件，无需人工维护：
  - VERSION                       当前版本号
  - update.json                   版本更新说明（changelog）
  - latest/fnmusic-ext.fpk        x86 安装包（固定文件名）
  - latest/fnmusic-ext-arm64.fpk  arm64 安装包（固定文件名）

发版时由 .github/workflows/update-latest-fpk.yml 在写入 latest/ 之后调用，
本地可手动运行：
    python3 packaging/fpk/gen_fnpack_json.py
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CN_TZ = timezone(timedelta(hours=8))

DISPLAY_NAME = "fnMusic 音源扩展"
DESC = (
    "fnmusic-ext 是专为飞牛私有云（fnOS）自带音乐应用打造的无侵入增强扩展：零侵入接管官方音乐入口，"
    "提供 musicdl 聚合、网易云（盒子/免扫码）、洛雪自定义源在线搜索播放，支持分类歌单、38 个热门榜单、"
    "自定义歌单（导入 m3u/m3u8/pls/cue 或大模型点歌）与内置大模型推荐，内置管理页（音源切换/扫码登录/"
    "平台选择/边听边存/检测更新），可随时一条命令还原官方直连。"
)
OS_MIN_VERSION = "1.2.0"
REPO_URL = "https://github.com/12hgl/fnos_music_ext"
# 下载地址使用仓库内固定的 latest/ 目录：发版时由 CI 覆盖写入，链接恒定，
# 相对主源 JSON 解析为 raw.githubusercontent.com/<owner>/<repo>/<branch>/latest/...
PACKAGES = {
    "x86": "./latest/fnmusic-ext.fpk",
    "arm": "./latest/fnmusic-ext-arm64.fpk",
}


def _read(path: str, default: str = "") -> str:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return default


def _sha256_and_size(rel_path: str) -> tuple[str, int]:
    path = os.path.join(REPO_ROOT, rel_path)
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size


def build() -> dict:
    version = _read(os.path.join(REPO_ROOT, "VERSION")).strip().splitlines()[0].strip()
    update = {}
    try:
        update = json.loads(_read(os.path.join(REPO_ROOT, "update.json"), "{}"))
    except json.JSONDecodeError:
        update = {}
    changelog = str(update.get("notes") or "").strip()
    if not changelog:
        changelog = f"更新至 {version}。"

    packages: dict[str, dict] = {}
    for arch, rel in PACKAGES.items():
        sha, size = _sha256_and_size(rel.lstrip("./"))
        packages[arch] = {"download_url": rel, "sha256": sha, "size": size}

    updated_at = datetime.now(CN_TZ).replace(microsecond=0).isoformat()

    return {
        "schema_version": "2",
        "source_info": {
            "name": "fnMusic 扩展源",
            "author": "12hgl",
            "homepage": REPO_URL,
            "description": "飞牛音乐（trim.music）无侵入增强扩展外部应用源。",
        },
        "apps": {
            "fnmusic-ext": {
                "display_name": DISPLAY_NAME,
                "desc": DESC,
                "platform": ["x86", "arm"],
                "categories": ["影音娱乐"],
                "icon_url": "./packaging/fpk/ICON_256.PNG",
                "preview_urls": ["./preview_image/preview.png"],
                "readme_url": "./README.md",
                "bug_report_url": f"{REPO_URL}/issues",
                "maintainer": "12hgl",
                "maintainer_url": REPO_URL,
                "run_as": "root",
                "install_type": "",
                "is_docker": False,
                "service_port": "",
                "releases": {
                    version: {
                        "changelog": changelog,
                        "updated_at": updated_at,
                        "os_min_version": OS_MIN_VERSION,
                        "packages": packages,
                    }
                },
            }
        },
    }


def main() -> None:
    out_path = os.path.join(REPO_ROOT, "fnpack.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(build(), fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"[fnpack] 已生成 {out_path}")


if __name__ == "__main__":
    main()
