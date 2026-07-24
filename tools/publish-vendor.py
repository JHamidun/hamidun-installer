#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
publish-vendor.py — массовая публикация vendor-артефактов как remote-компонентов.

Проходит по карте COMPONENTS (remoteId -> откуда в vendor/ + под каким префиксом
класть внутрь zip, чтобы объект повторял vendor/-раскладку 1:1) и для каждого
зовёт tools/push-component.py (тот: zip -> sha по снятым байтам -> заливка в
Reg.ru S3 + Yandex Cloud (2 зеркала) -> анонимный verify обоих -> upsert реестра).

Смысл содержимого zip = ветка vendor/ этого компонента ОТНОСИТЕЛЬНО HM_VENDOR:
git.ps1 читает $HM_VENDOR/apps/git-setup.exe => объект git несёт apps/git-setup.exe.
remote-fetch распакует архив в staging и main подставит HM_VENDOR=staging => все 18
install-скриптов работают без правок (source-agnostic через HM_VENDOR).

Использование:
    python tools/publish-vendor.py                 # все win32-компоненты, что есть в vendor/
    python tools/publish-vendor.py --only git,node # точечно
    python tools/publish-vendor.py --skip-existing # пропустить те, что уже в реестре (по remoteId+platform)
    python tools/publish-vendor.py --dry-run       # показать план, ничего не заливать

Компоненты, которых нет в локальном vendor/, помечаются SKIP (missing) и не роняют прогон.
Составные (pydeps, extension) собираются во временный staging с корректной структурой.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VENDOR = REPO / "vendor"
PUSH = REPO / "tools" / "push-component.py"
REGISTRY = REPO / "remote-components.json"

# remoteId -> спецификация публикации (win32).
#   kind="single": один источник (файл/папка) + zip_prefix (путь внутри архива).
#   kind="staged": список (src, dest_rel) — собрать staging-папку и запушить её как есть.
# name — человекочитаемое; platform всегда win32 в этой карте (darwin — отдельная фаза).
COMPONENTS = {
    "git":    {"kind": "single", "src": "apps/git-setup.exe",    "prefix": "apps",              "name": "Git for Windows"},
    "node":   {"kind": "single", "src": "apps/node-lts.msi",     "prefix": "apps",              "name": "Node.js LTS"},
    "vscode": {"kind": "single", "src": "apps/vscode-setup.exe", "prefix": "apps",              "name": "Visual Studio Code"},
    "cursor": {"kind": "single", "src": "apps/cursor-setup.exe", "prefix": "apps",              "name": "Cursor"},
    "claude": {"kind": "single", "src": "npm-cache",             "prefix": "npm-cache",         "name": "Claude Code CLI (npm-cache)"},
    "uv":     {"kind": "single", "src": "apps/uv",               "prefix": "apps/uv",           "name": "uv (Astral)"},
    "mascot": {"kind": "single", "src": "apps/claude-mascot",    "prefix": "apps/claude-mascot","name": "Claude Mascot"},
    # nomad — составной: дерево + манифест целостности (nomad.ps1 верифицирует его
    # fail-closed перед uv tool install). nomad-src.sha256 генерит fetch-vendor.ps1 —
    # публиковать nomad ТОЛЬКО после свежего fetch:vendor (иначе required-part упадёт).
    "nomad":  {"kind": "staged", "parts": [("nomad-src", "nomad-src"),
                                           ("nomad-src.sha256", "nomad-src.sha256")],
               "name": "Nomad (source + integrity manifest)"},
    "config": {"kind": "single", "src": "config-pack",           "prefix": "config-pack",       "name": "Claude config pack (v38)"},
    # playwright-browsers НЕ публикуем: компонента с таким id нет в components.json, а
    # loadRemoteMaps (main.js) выводит remote строго по id компонентов — запись реестра была
    # недостижима, install-скрипта scripts/windows/playwright-browsers.ps1 не существует.
    # Браузеры ставит pydeps.ps1 онлайн (`python -m playwright install chromium`) с честным
    # предупреждением при сбое. Если однажды понадобится офлайн — класть их ЧАСТЬЮ pydeps
    # (parts + перепубликация), а не отдельным remoteId.
    # Составные: собираем staging с точной структурой, пушим папку без префикса.
    # requirements.txt ЕДЕТ ВНУТРИ архива: в lite config-pack не вшит и не попадает в
    # staging pydeps, поэтому список пакетов был недостижим НИ ОДНИМ путём и компонент
    # уходил в graceful skip (пакеты не ставились вообще). Путь внутри zip совпадает с
    # тем, что резолвит vendorPick/HM_BUNDLED_CONFIG → pydeps.ps1 находит его без правок.
    "pydeps": {"kind": "staged", "parts": [("apps/python-setup.exe", "apps/python-setup.exe"),
                                           ("pywheels",              "pywheels"),
                                           ("config-pack/requirements.txt", "config-pack/requirements.txt")],
               "name": "Python + wheels (pydeps)"},
    # chatgpt.vsix СЮДА НЕ КЛАДЁМ (был glob apps/*.vsix = +338 МБ на каждого lite-юзера):
    # extension.ps1 читает только claude-code.vsix и шрифт, а единственный потребитель
    # chatgpt.vsix — vscode.ps1 — работает со staging СВОЕГО компонента (vscode), куда
    # архив extension не попадает. В lite Codex ставится из Marketplace.
    "extension": {"kind": "staged", "parts": [("apps/claude-code.vsix", "apps/claude-code.vsix"),
                                              ("apps/JetBrainsMono-Regular.ttf", "apps/JetBrainsMono-Regular.ttf")],  # шрифт: в lite HM_VENDOR=staging, из vendor-lite недостижим
                  "name": "VS Code extensions (Claude Code + шрифт)"},
}


def load_registry_ids():
    if not REGISTRY.exists():
        return set()
    reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
    return {(c.get("remoteId"), c.get("platform")) for c in reg.get("components", [])}


def run_push(remote_id, source, name, zip_prefix=None, dry=False):
    cmd = [sys.executable, str(PUSH), remote_id, str(source), "--platform", "win32", "--name", name]
    if zip_prefix:
        cmd += ["--zip-prefix", zip_prefix]
    if dry:
        cmd += ["--dry-run"]
    print(f"\n>>> {' '.join(str(c) for c in cmd)}")
    return subprocess.call(cmd)


def stage_composite(spec):
    """Собирает временную staging-папку из parts (src-glob-relative-vendor, dest_rel)."""
    stage = Path(tempfile.mkdtemp(prefix="pubvendor_stage_"))
    staged_any = False
    for src_rel, dest_rel in spec["parts"]:
        is_glob = any(ch in src_rel for ch in "*?[")
        matches = sorted(VENDOR.glob(src_rel)) if is_glob else \
                  ([VENDOR / src_rel] if (VENDOR / src_rel).exists() else [])
        # Литеральная (не-glob) часть ОБЯЗАТЕЛЬНА: молчаливый silent-skip публиковал бы
        # неполный составной артефакт (напр. extension без claude-code.vsix) с кодом 0.
        if not is_glob and not matches:
            raise SystemExit(f"[fail] {spec['name']}: обязательная часть отсутствует в vendor/: {src_rel}")
        for m in matches:
            if dest_rel.endswith("/"):
                dst = stage / dest_rel / m.name
            else:
                dst = stage / dest_rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            if m.is_dir():
                shutil.copytree(m, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(m, dst)
            staged_any = True
    return (stage if staged_any else None)


def main():
    ap = argparse.ArgumentParser(description="Массовая публикация vendor-артефактов как remote-компонентов (2 зеркала).")
    ap.add_argument("--only", default="", help="запятыми: git,node,pydeps… (по умолчанию — все)")
    ap.add_argument("--skip-existing", action="store_true", help="пропустить компоненты, уже присутствующие в реестре (remoteId+win32)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    ids = list(COMPONENTS.keys()) if not only else [i for i in COMPONENTS if i in only]
    if only - set(COMPONENTS):
        print(f"[warn] неизвестные id в --only: {', '.join(sorted(only - set(COMPONENTS)))}", file=sys.stderr)

    existing = load_registry_ids()
    results = {"ok": [], "skip_missing": [], "skip_existing": [], "fail": []}

    for rid in ids:
        spec = COMPONENTS[rid]
        if args.skip_existing and (rid, "win32") in existing:
            print(f"\n=== {rid}: уже в реестре — пропуск (--skip-existing) ===")
            results["skip_existing"].append(rid)
            continue

        if spec["kind"] == "single":
            src = VENDOR / spec["src"]
            if not src.exists():
                print(f"\n=== {rid}: нет в vendor/ ({spec['src']}) — SKIP ===")
                results["skip_missing"].append(rid)
                continue
            rc = run_push(rid, src, spec["name"], spec.get("prefix"), args.dry_run)
        else:  # staged
            stage = stage_composite(spec)
            if not stage:
                print(f"\n=== {rid}: нет частей в vendor/ — SKIP ===")
                results["skip_missing"].append(rid)
                continue
            try:
                rc = run_push(rid, stage, spec["name"], None, args.dry_run)
            finally:
                shutil.rmtree(stage, ignore_errors=True)

        (results["ok"] if rc == 0 else results["fail"]).append(rid)

    print("\n" + "=" * 60)
    print("ИТОГ ПУБЛИКАЦИИ:")
    for k, label in [("ok", "залито"), ("fail", "ПРОВАЛ"), ("skip_missing", "нет в vendor"), ("skip_existing", "уже было")]:
        if results[k]:
            print(f"  {label}: {', '.join(results[k])}")
    sys.exit(1 if results["fail"] else 0)


if __name__ == "__main__":
    main()
