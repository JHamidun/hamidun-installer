#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
push-component.py — публикация remote-компонента в CDN и обновление реестра.

Модель Ninite: тяжёлые рантаймы не вшиваются в установщик, а лежат в облаке и
докачиваются по требованию (см. remote-components.json + src/remote-fetch.js).
Этот тул: упаковывает артефакт в zip, считает sha256+size, заливает в Reg.ru S3
(ACL public-read), при наличии R2-кредов — дублирует в Cloudflare R2, и делает
upsert записи в remote-components.json (идемпотентно, overwrite).

Использование:
    python tools/push-component.py <remoteId> <файл-или-папка> [--platform win32|darwin|linux] [--name "..."]

Примеры:
    python tools/push-component.py uv vendor/uv-x86_64-pc-windows-msvc.zip --platform win32 --name "uv (Astral)"
    python tools/push-component.py ffmpeg C:/downloads/ffmpeg --platform win32

Креды берутся из ~/.claude/.credentials.master.env:
    REGRU_S3_ENDPOINT, REGRU_S3_ACCESS_KEY, REGRU_S3_SECRET_KEY, REGRU_S3_BUCKET, REGRU_S3_REGION
R2 (опционально, если появятся):
    R2_S3_ENDPOINT, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET, R2_PUBLIC_BASE

Ключ объекта в бакете (CONTENT-ADDRESSED / IMMUTABLE — sha256 в имени):
    vibecoding-installer/<remoteId>-<sha256>.zip                 (без --platform)
    vibecoding-installer/<remoteId>-<platform>-<sha256>.zip      (с --platform)

Почему immutable: выпущенный установщик ждёт КОНКРЕТНЫЙ sha256. Перезалив под
mutable-именем (uv-win32.zip) перетёр бы объект, и старые установщики получили бы
вечный sha-mismatch. При content-addressed имени перезалив того же контента
идемпотентен (тот же ключ), а новый контент = новый ключ. Реестр всегда указывает
на объект с sha в имени.
"""
import argparse
import hashlib
import json
import os
import sys
import tarfile
import tempfile
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

S3_PREFIX = "vibecoding-installer"
CRED_FILE = Path.home() / ".claude" / ".credentials.master.env"
REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY = REPO_ROOT / "remote-components.json"


def load_creds():
    """Читает KEY=VALUE из .credentials.master.env (без сторонних либ)."""
    creds = {}
    if not CRED_FILE.exists():
        return creds
    for line in CRED_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        creds[k.strip()] = v.strip()
    return creds


def platform_to_script(remote_id, platform):
    if platform == "darwin":
        return f"scripts/macos/{remote_id}.sh"
    # win32 (и всё прочее) — PowerShell
    return f"scripts/windows/{remote_id}.ps1"


def snapshot_bytes(path: Path):
    """Снимок байтов архива ОДИН раз (в память) + его sha256/size. Дальше во ВСЕ
    зеркала и в реестр идут ИМЕННО эти байты — sha не может «разъехаться» с тем,
    что реально залито (P1-3: никаких повторных чтений файла с диска)."""
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest().lower()
    return data, sha, len(data)


def make_zip(src: Path) -> Path:
    """Возвращает путь к zip-архиву. Правила:
    - .zip файл -> используем как есть;
    - директория -> zip её содержимого (корень = содержимое папки);
    - .tar.gz/.tgz -> распаковываем и перепаковываем в zip;
    - любой иной файл -> zip с этим единственным файлом в корне.
    """
    src = src.resolve()
    if src.is_file() and src.suffix.lower() == ".zip":
        print(f"  вход уже zip — использую как есть: {src.name}")
        return src

    tmp = Path(tempfile.mkdtemp(prefix="pushcomp_")) / (src.stem.split(".")[0] + ".zip")

    if src.is_dir():
        print(f"  упаковываю папку в zip: {src}")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(src.rglob("*")):
                if p.is_file():
                    z.write(p, p.relative_to(src).as_posix())
        return tmp

    name = src.name.lower()
    if name.endswith(".tar.gz") or name.endswith(".tgz"):
        print(f"  распаковываю tar.gz и перепаковываю в zip: {src.name}")
        exdir = Path(tempfile.mkdtemp(prefix="pushcomp_ex_"))
        exroot = exdir.resolve()
        with tarfile.open(src, "r:gz") as t:
            # БЕЗОПАСНАЯ распаковка: проверяем не только имена (traversal через
            # commonpath, не .startswith — тот ловится на exdir vs exdir-evil), но и
            # ТИПЫ членов. Symlink/hardlink/устройства/FIFO — отвергаем (link-target
            # мог указывать за пределы каталога). Распаковываем ТОЛЬКО обычные
            # файлы и каталоги (P1-5).
            safe = []
            for m in t.getmembers():
                mp = (exdir / m.name).resolve()
                try:
                    if os.path.commonpath([str(mp), str(exroot)]) != str(exroot):
                        raise RuntimeError(f"tar path traversal: {m.name}")
                except ValueError:
                    # разные диски/корни (Windows) → точно выход за пределы
                    raise RuntimeError(f"tar path traversal (diff root): {m.name}")
                if m.issym() or m.islnk():
                    raise RuntimeError(f"tar содержит ссылку (отклонено): {m.name}")
                if m.ischr() or m.isblk() or m.isfifo() or m.isdev():
                    raise RuntimeError(f"tar содержит спец-файл (отклонено): {m.name}")
                if m.isreg() or m.isdir():
                    safe.append(m)
            try:
                # Py3.12+: filter="data" дополнительно блокирует абсолютные пути,
                # '..', links и опасные биты прав.
                t.extractall(exdir, members=safe, filter="data")
            except TypeError:
                t.extractall(exdir, members=safe)  # Py<3.12 — ручные проверки выше
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(exdir.rglob("*")):
                if p.is_file():
                    z.write(p, p.relative_to(exdir).as_posix())
        return tmp

    # bare-файл (напр. одиночный бинарь)
    print(f"  оборачиваю одиночный файл в zip: {src.name}")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(src, src.name)
    return tmp


def s3_upload(creds, prefix, key, data: bytes):
    """Загрузка ГОТОВЫХ байтов в S3-совместимое хранилище (path-style, SigV4).
    Принимает именно те байты, по которым посчитан sha (P1-3) — никаких повторных
    чтений файла с диска. Возвращает public url или None."""
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError

    endpoint = creds.get(f"{prefix}_ENDPOINT") or creds.get(f"{prefix}_S3_ENDPOINT")
    access = creds.get(f"{prefix}_ACCESS_KEY") or creds.get(f"{prefix}_S3_ACCESS_KEY")
    secret = creds.get(f"{prefix}_SECRET_KEY") or creds.get(f"{prefix}_S3_SECRET_KEY")
    bucket = creds.get(f"{prefix}_BUCKET") or creds.get(f"{prefix}_S3_BUCKET")
    region = creds.get(f"{prefix}_REGION") or creds.get(f"{prefix}_S3_REGION") or "ru-1"
    if not (endpoint and access and secret and bucket):
        return None

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name=region,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )
    put_kwargs = dict(Bucket=bucket, Key=key, Body=data, ContentType="application/zip")
    try:
        client.put_object(ACL="public-read", **put_kwargs)
    except ClientError as e:
        # Некоторые провайдеры отклоняют ACL-параметр — пробуем без него.
        print(f"  [warn] put с ACL public-read не прошёл ({e.response.get('Error', {}).get('Code')}), пробую без ACL…")
        client.put_object(**put_kwargs)
    public_url = f"{endpoint.rstrip('/')}/{bucket}/{key}"
    return public_url


def verify_public_get(url, expected_sha, expected_size):
    """Анонимный (без кредов) GET публичного URL. Установщик качает объект БЕЗ
    авторизации — если бакет/объект приватный, он получит 403 и docker-mismatch.
    Поэтому ПЕРЕД записью в реестр убеждаемся: объект реально скачивается
    анонимно, ровно того размера и sha (P2). Возвращает (ok, detail)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "hamidun-setup-verify"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            if resp.status != 200:
                return False, f"HTTP {resp.status}"
            body = resp.read()
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code} (объект недоступен анонимно — бакет приватный?)"
    except Exception as e:  # noqa: BLE001 — сеть/TLS/таймаут
        return False, str(e)
    got_sha = hashlib.sha256(body).hexdigest().lower()
    if len(body) != expected_size:
        return False, f"размер {len(body)} != ожидаемого {expected_size}"
    if got_sha != expected_sha:
        return False, f"sha {got_sha[:12]}… != ожидаемого {expected_sha[:12]}…"
    return True, "ok"


def load_registry():
    if REGISTRY.exists():
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    return {"components": []}


def save_registry(reg):
    REGISTRY.write_text(json.dumps(reg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def upsert(reg, entry):
    comps = reg.setdefault("components", [])
    for i, e in enumerate(comps):
        if e.get("remoteId") == entry["remoteId"] and e.get("platform") == entry.get("platform"):
            comps[i] = entry
            return "обновлена"
    comps.append(entry)
    return "добавлена"


def main():
    ap = argparse.ArgumentParser(description="Публикация remote-компонента в CDN + upsert реестра.")
    ap.add_argument("remoteId")
    ap.add_argument("source", help="файл (.zip/.tar.gz/бинарь) или папка")
    ap.add_argument("--platform", choices=["win32", "darwin", "linux"], default=None)
    ap.add_argument("--name", default=None)
    ap.add_argument("--dry-run", action="store_true", help="не заливать, только показать план")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.exists():
        print(f"ОШИБКА: источник не найден: {src}", file=sys.stderr)
        sys.exit(1)

    creds = load_creds()
    if not (creds.get("REGRU_S3_ENDPOINT") and creds.get("REGRU_S3_ACCESS_KEY")
            and creds.get("REGRU_S3_SECRET_KEY") and creds.get("REGRU_S3_BUCKET")):
        print("ОШИБКА: не хватает REGRU_S3_* кредов в ~/.claude/.credentials.master.env "
              "(нужны REGRU_S3_ENDPOINT, REGRU_S3_ACCESS_KEY, REGRU_S3_SECRET_KEY, REGRU_S3_BUCKET).",
              file=sys.stderr)
        sys.exit(2)

    # 1. Упаковка в zip
    print(f"[1/5] Готовлю архив для «{args.remoteId}»…")
    zip_path = make_zip(src)

    # 2. Снимок байтов ОДИН раз → sha256+size из НИХ (P1-3). Эти же байты уходят
    #    во все зеркала и в реестр — рассинхрон sha/контента исключён.
    print("[2/5] Снимаю байты, считаю SHA-256 и размер…")
    data, sha, size = snapshot_bytes(zip_path)
    print(f"  sha256={sha}")
    print(f"  size={size} байт ({size/1024/1024:.2f} МБ)")

    # Ключ объекта CONTENT-ADDRESSED / IMMUTABLE: sha в имени (P1-2). Перезалив
    # того же контента идемпотентен; выпущенные установщики не ломаются.
    suffix = f"-{args.platform}" if args.platform else ""
    key = f"{S3_PREFIX}/{args.remoteId}{suffix}-{sha}.zip"

    if args.dry_run:
        print(f"[dry-run] WOULD upload -> Reg.ru S3 key: {key}")
        print(f"[dry-run] WOULD upsert entry remoteId={args.remoteId} platform={args.platform}")
        return

    # 3. Заливка Reg.ru S3 (+ R2 если есть) — ИМЕННО снятыми байтами.
    print("[3/5] Заливаю в Reg.ru S3…")
    regru_url = s3_upload(creds, "REGRU_S3", key, data)
    if not regru_url:
        print("ОШИБКА: заливка в Reg.ru S3 не удалась.", file=sys.stderr)
        sys.exit(3)
    # Публичный path-style url (стабильно из известных кредов).
    regru_url = f"{creds['REGRU_S3_ENDPOINT'].rstrip('/')}/{creds['REGRU_S3_BUCKET']}/{key}"
    print(f"  Reg.ru: {regru_url}")

    mirrors = [{"host": "regru", "url": regru_url}]

    r2_up = s3_upload(creds, "R2", key, data) if (creds.get("R2_ACCESS_KEY") or creds.get("R2_S3_ACCESS_KEY")) else None
    if r2_up:
        r2_base = creds.get("R2_PUBLIC_BASE", "").rstrip("/")
        r2_url = f"{r2_base}/{key}" if r2_base else r2_up
        mirrors.append({"host": "r2", "url": r2_url})
        print(f"  R2: {r2_url}")
    else:
        # R2 пока не подключён — плейсхолдер (remote-fetch его молча игнорирует).
        mirrors.append({"host": "r2", "url": f"https://R2-PLACEHOLDER-NOT-CONFIGURED/{key}"})
        print("  R2: не настроен — записан плейсхолдер (докачка его игнорирует).")

    # 4. Проверка публичной анонимной доступности ПЕРЕД записью реестра (P2):
    #    установщик качает без кредов — приватный объект дал бы ему 403/mismatch.
    print("[4/5] Проверяю анонимную загрузку объекта (как это сделает установщик)…")
    ok_pub, detail = verify_public_get(regru_url, sha, size)
    if not ok_pub:
        print(f"ОШИБКА: объект недоступен/несовпадает анонимно: {detail}\n"
              f"  Реестр НЕ обновлён (иначе установщик получил бы битую ссылку).\n"
              f"  Проверь public-read ACL бакета/объекта: {regru_url}", file=sys.stderr)
        sys.exit(4)
    print("  Публичная загрузка OK (200, размер и sha совпали).")

    # 5. upsert реестра
    print("[5/5] Обновляю remote-components.json…")
    reg = load_registry()
    entry = {
        "remoteId": args.remoteId,
        "name": args.name or args.remoteId,
        "sizeBytes": size,
        "sha256": sha,
        "mirrors": mirrors,
        "installRelPath": platform_to_script(args.remoteId, args.platform or "win32"),
    }
    if args.platform:
        entry["platform"] = args.platform
    action = upsert(reg, entry)
    save_registry(reg)
    print(f"  Запись «{args.remoteId}»"
          + (f" ({args.platform})" if args.platform else "")
          + f" {action} в {REGISTRY.name}.")
    print("ГОТОВО.")


if __name__ == "__main__":
    main()
