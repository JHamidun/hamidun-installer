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
    python tools/publish-vendor.py                    # все win32-компоненты, что есть в vendor/
    python tools/publish-vendor.py --platform darwin  # то же для macOS-раскладки vendor (запускать НА маке)
    python tools/publish-vendor.py --only git,node    # точечно
    python tools/publish-vendor.py --skip-existing    # пропустить те, что уже в реестре (по remoteId+platform)
    python tools/publish-vendor.py --dry-run          # показать план, ничего не заливать

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

# remoteId -> спецификация публикации.
#   kind="single": один источник (файл/папка) + zip_prefix (путь внутри архива).
#   kind="staged": список частей (src_rel, dest_rel[, required]) — собрать staging-папку
#                  и запушить её как есть. src_rel может быть glob'ом; dest_rel,
#                  оканчивающийся на "/", = каталог назначения (имя файла сохраняется).
#                  required по умолчанию: литерал — обязателен, glob — нет; третьим
#                  элементом можно потребовать, чтобы glob дал хотя бы одно совпадение.
# name — человекочитаемое. Карты платформенные: COMPONENTS (win32) / COMPONENTS_DARWIN.
COMPONENTS = {
    "git":    {"kind": "single", "src": "apps/git-setup.exe",    "prefix": "apps",              "name": "Git for Windows"},
    "node":   {"kind": "single", "src": "apps/node-lts.msi",     "prefix": "apps",              "name": "Node.js LTS"},
    "vscode": {"kind": "single", "src": "apps/vscode-setup.exe", "prefix": "apps",              "name": "Visual Studio Code"},
    "cursor": {"kind": "single", "src": "apps/cursor-setup.exe", "prefix": "apps",              "name": "Cursor"},
    "claude": {"kind": "single", "src": "npm-cache",             "prefix": "npm-cache",         "name": "Claude Code CLI (npm-cache)"},
    "uv":     {"kind": "single", "src": "apps/uv",               "prefix": "apps/uv",           "name": "uv (Astral)"},
    "mascot": {"kind": "single", "src": "apps/claude-mascot",    "prefix": "apps/claude-mascot","name": "Claude Mascot"},
    # handy — БЫЛ ПРОПУЩЕН, и это молча ломало lite-издание. Артефакт лежит в vendor
    # (apps/handy-setup.exe), гейт целостности на него есть (vendor/checksums.json), и
    # install-скрипт есть (scripts/windows/handy.ps1) — но записи в реестре докачки не
    # было, поэтому loadRemoteMaps (src/main.js) НЕ считал компонент удалённым, а
    # build-lite.js кладёт в vendor-lite только uv+курс+checksums. Итог для человека,
    # выбравшего «Handy» в лёгком издании: handy.ps1 не находит установщик и уходит в
    # graceful skip (exit 120) — компонент просто не появляется, без объяснения.
    # ВНИМАНИЕ ПРИ ПУБЛИКАЦИИ: components.json показывает handy на win32 И darwin. Как
    # только запись win32 попадёт в реестр, lite на macOS начнёт считать handy удалённым
    # (авто-remote по id) и упрётся в «нет сборки для платформы», если darwin-записи нет.
    # Значит win32 и darwin публикуются ПАРОЙ (darwin — на маке, из apps/handy-macos-*.dmg).
    "handy":  {"kind": "single", "src": "apps/handy-setup.exe",  "prefix": "apps",              "name": "Handy (голосовой ввод)"},
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

# macOS-раскладка (имена — ИЗ tools/fetch-vendor-mac.sh; читают их scripts/macos/*.sh
# через $HM_VENDOR). Публикуется НА маке, после `bash tools/fetch-vendor-mac.sh`.
#
# ПОЧЕМУ ОБЕ АРХИТЕКТУРЫ В ОДНОМ АРХИВЕ: dmg универсальный (arm64 + x86_64), а запись
# реестра выбирается ТОЛЬКО по platform (remote-fetch.pickEntry не знает про arch) —
# значит arch-специфичные артефакты (git-macos-<arch>.tar.gz, claude-code-<arch>.vsix)
# едут парой, и install-скрипт берёт свой через arch_tag. Отсюда glob'ы в parts.
#
# uv В КАРТЕ НЕТ СОЗНАТЕЛЬНО: он bundled-only (main.js BUNDLED_ONLY={uv}) — едет внутри
# lite-dmg (vendor-lite), remote-запись для него была бы недостижима.
COMPONENTS_DARWIN = {
    # git: dugite-native, две арх-сборки (git.sh: $HM_VENDOR/apps/git-macos-$(arch_tag).tar.gz)
    # glob НЕ обязателен: нет ни одного тарболла → компонент целиком уходит в SKIP
    # (как git в win-карте), а не роняет прогон; одна арх без другой публикуется как есть —
    # у второй арх git.sh штатно уходит в CLT-фолбэк (см. fetch-vendor-mac.sh: там это warn).
    "git":    {"kind": "staged", "parts": [("apps/git-macos-*.tar.gz", "apps/")],
               "name": "Git for macOS (dugite, arm64+x64)"},
    "node":   {"kind": "single", "src": "apps/node.pkg",   "prefix": "apps",              "name": "Node.js LTS (macOS pkg)"},
    # vscode.sh ставит редактор из apps/vscode.zip (darwin-universal), расширения —
    # свой vsix при наличии, иначе Marketplace (в lite — Marketplace, как на Windows).
    "vscode": {"kind": "single", "src": "apps/vscode.zip", "prefix": "apps",              "name": "Visual Studio Code (macOS)"},
    "cursor": {"kind": "single", "src": "apps/cursor.dmg", "prefix": "apps",              "name": "Cursor (macOS dmg)"},
    "claude": {"kind": "single", "src": "npm-cache",       "prefix": "npm-cache",         "name": "Claude Code CLI (npm-cache)"},
    "mascot": {"kind": "single", "src": "apps/claude-mascot", "prefix": "apps/claude-mascot", "name": "Claude Mascot (macOS)"},
    # nomad — как на Windows: дерево + манифест целостности (nomad.sh верифицирует
    # fail-closed ДО uv tool install). nomad-src.sha256 генерит fetch-vendor-mac.sh —
    # публиковать ТОЛЬКО после свежего фетча, иначе обязательная часть отсутствует.
    "nomad":  {"kind": "staged", "parts": [("nomad-src", "nomad-src"),
                                           ("nomad-src.sha256", "nomad-src.sha256")],
               "name": "Nomad (source + integrity manifest)"},
    "config": {"kind": "single", "src": "config-pack",     "prefix": "config-pack",       "name": "Claude config pack (v38)"},
    # handy: пара к win32-записи. Записи здесь не было вовсе — при том что win-карта
    # прямо предписывает публиковать обе платформы ПАРОЙ, а components.json показывает
    # handy и на darwin. Итог: release-check держал блокер, а в lite-издании на маке
    # компонент был недостижим — не вшит и качать неоткуда.
    # Обе арх ОБЯЗАТЕЛЬНЫ как группа (True): universal-сборки Handy не даёт, онлайн-
    # фолбэка у компонента нет. Публиковать половину — значит завести запись в реестре,
    # которая для второй архитектуры молча не сработает; лучше честный отказ публикации.
    "handy":  {"kind": "staged", "parts": [("apps/handy-macos-*.dmg", "apps/", True)],
               "name": "Handy (голосовой ввод, arm64+x64)"},
    # pydeps: как в win32 — установщик Python + колёса + requirements.txt ВНУТРИ архива
    # (в lite config-pack не вшит, а pydeps.sh читает список пакетов через HM_VENDOR).
    "pydeps": {"kind": "staged", "parts": [("apps/python.pkg",               "apps/python.pkg"),
                                           ("pywheels",                      "pywheels"),
                                           ("config-pack/requirements.txt",  "config-pack/requirements.txt")],
               "name": "Python + wheels (pydeps, macOS)"},
    # extension: claude-code-<arch>.vsix (обе арх — обязательны как группа) + шрифт.
    # chatgpt-*.vsix СЮДА НЕ КЛАДЁМ (та же логика, что на Windows: его читает только
    # vscode.sh из СВОЕГО staging, а в lite Codex ставится из Marketplace).
    "extension": {"kind": "staged", "parts": [("apps/claude-code-*.vsix",           "apps/", True),
                                              ("apps/JetBrainsMono-Regular.ttf",    "apps/JetBrainsMono-Regular.ttf")],
                  "name": "VS Code extensions (Claude Code + шрифт, macOS)"},
}

PLATFORM_MAPS = {"win32": COMPONENTS, "darwin": COMPONENTS_DARWIN}


def load_registry_ids():
    if not REGISTRY.exists():
        return set()
    reg = json.loads(REGISTRY.read_text(encoding="utf-8"))
    return {(c.get("remoteId"), c.get("platform")) for c in reg.get("components", [])}


def run_push(remote_id, source, name, zip_prefix=None, dry=False, platform="win32"):
    cmd = [sys.executable, str(PUSH), remote_id, str(source), "--platform", platform, "--name", name]
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
    for part in spec["parts"]:
        src_rel, dest_rel = part[0], part[1]
        is_glob = any(ch in src_rel for ch in "*?[")
        # Обязательность: литерал — всегда, glob — только если помечен явно третьим
        # элементом (напр. claude-code-*.vsix: имя арх-зависимо, но хотя бы одна
        # сборка обязана быть, иначе уедет extension без панели Claude).
        required = part[2] if len(part) > 2 else (not is_glob)
        matches = sorted(VENDOR.glob(src_rel)) if is_glob else \
                  ([VENDOR / src_rel] if (VENDOR / src_rel).exists() else [])
        # Молчаливый silent-skip публиковал бы неполный составной артефакт
        # (напр. extension без claude-code.vsix) с кодом 0.
        if required and not matches:
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
    ap.add_argument("--platform", choices=sorted(PLATFORM_MAPS), default="win32",
                    help="раскладка vendor и platform записи реестра (по умолчанию win32)")
    ap.add_argument("--skip-existing", action="store_true", help="пропустить компоненты, уже присутствующие в реестре (remoteId+platform)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    plat = args.platform
    components = PLATFORM_MAPS[plat]
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    ids = list(components.keys()) if not only else [i for i in components if i in only]
    if only - set(components):
        print(f"[warn] неизвестные id в --only для платформы {plat}: "
              f"{', '.join(sorted(only - set(components)))}", file=sys.stderr)
    print(f"[publish-vendor] платформа: {plat}; компонентов в карте: {len(components)}")

    existing = load_registry_ids()
    results = {"ok": [], "skip_missing": [], "skip_existing": [], "fail": []}

    for rid in ids:
        spec = components[rid]
        if args.skip_existing and (rid, plat) in existing:
            print(f"\n=== {rid}: уже в реестре — пропуск (--skip-existing) ===")
            results["skip_existing"].append(rid)
            continue

        if spec["kind"] == "single":
            src = VENDOR / spec["src"]
            if not src.exists():
                print(f"\n=== {rid}: нет в vendor/ ({spec['src']}) — SKIP ===")
                results["skip_missing"].append(rid)
                continue
            rc = run_push(rid, src, spec["name"], spec.get("prefix"), args.dry_run, plat)
        else:  # staged
            stage = stage_composite(spec)
            if not stage:
                print(f"\n=== {rid}: нет частей в vendor/ — SKIP ===")
                results["skip_missing"].append(rid)
                continue
            try:
                rc = run_push(rid, stage, spec["name"], None, args.dry_run, plat)
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
