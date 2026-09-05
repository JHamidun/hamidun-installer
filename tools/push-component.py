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
import re
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


def gated_files_map(zip_path: Path, platform):
    """{базовое имя файла: sha256} для членов архива, которые ПРОВЕРЯЕТ второй гейт.

    Второй гейт — вшитый vendor/checksums.json (Confirm-HmArtifact в install-скриптах,
    ключ = БАЗОВОЕ имя файла). Его манифест уезжает в exe, а содержимое опубликованного
    архива фиксируется здесь: пересобрал vendor и собрал lite без перепубликации — и у
    пользователя докачка проходит, а установка падает с «файл подменён». Записываем
    фактические sha, чтобы tools/build-lite.js мог сверить это ДО релиза.
    """
    chk_path = REPO_ROOT / "vendor" / "checksums.json"
    if not chk_path.exists():
        if platform in (None, "win32"):
            raise SystemExit(
                "[fail] нет vendor/checksums.json — не с чем сверять целостность публикуемого архива.\n"
                "       Запусти `npm run fetch:vendor` (он генерит манифест) и повтори публикацию."
            )
        return {}
    manifest = json.loads(chk_path.read_text(encoding="utf-8")).get("files", {})
    # Манифест checksums.json описывает АРТЕФАКТЫ УСТАНОВЩИКА (vendor/apps/*, course/*,
    # nomad-src) — их и проверяет Confirm-HmArtifact/verify_artifact по базовому имени.
    # Контентные деревья ниже — это то, что ставится пользователю (конфиг-пак, npm-кэш,
    # колёса); их файлы НИКОМУ не передаются в гейт, а совпадение базового имени там
    # закономерно и безобидно: config-pack несёт свой canvas-fonts/JetBrainsMono-*.ttf,
    # а манифест — совсем другой шрифт из vendor/apps для терминала. Без этого исключения
    # сборка ложно падала бы «рассинхрон манифеста» на файле, который никто не верифицирует.
    CONTENT_TREES = ("config-pack/", "npm-cache/", "pywheels/")
    gated = {}
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            if info.filename.startswith(CONTENT_TREES):
                continue
            name = info.filename.rsplit("/", 1)[-1]
            if name not in manifest:
                continue
            h = hashlib.sha256()
            with z.open(info) as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    h.update(chunk)
            digest = h.hexdigest().lower()
            prev = gated.get(name)
            if prev and prev != digest:
                # Рантайм-гейт ключуется базовым именем — два разных файла с одним именем
                # в одном архиве сделали бы проверку недетерминированной.
                raise SystemExit(
                    f"[fail] в архиве два разных файла с именем «{name}» — второй гейт "
                    f"(checksums.json) ключуется базовым именем и стал бы неоднозначным."
                )
            gated[name] = digest
    return gated


def snapshot_bytes(path: Path):
    """Снимок байтов архива ОДИН раз (в память) + его sha256/size. Дальше во ВСЕ
    зеркала и в реестр идут ИМЕННО эти байты — sha не может «разъехаться» с тем,
    что реально залито (P1-3: никаких повторных чтений файла с диска)."""
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest().lower()
    return data, sha, len(data)


def _zip_add(z, arcname, filepath):
    """Детерминированная запись файла в zip: фиксированный mtime (1980-01-01) + режим
    0755 для исполняемых, 0644 для остальных. Байты архива воспроизводимы при идентичном
    содержимом → sha (content-addressed ключ) стабилен между прогонами, перезалив того же
    контента идемпотентен (иначе mtime исходников менял бы sha при байт-идентичном
    содержимом → объекты-сироты в S3).

    Режим раньше был жёстко 0644 — исполняемый бит терялся у ВСЕГО, что едет в
    darwin-компонентах: бинаря внутри .app скрепки (Contents/MacOS/<bin>), uv/uvx, .sh.
    На macOS докачанный архив распаковывается `ditto -x -k` (запасной — `unzip`), оба
    берут права из архива; дальше mascot.sh копирует бандл тем же `ditto`, который
    сохраняет режим как есть, и chmod не делает нигде. LaunchAgent получал бы на запуске
    Permission denied, а health-check — молчаливый провал вместо внятной причины.

    Берём ровно один бит (есть ли x у владельца) и нормализуем в 0755/0644, а не копируем
    st_mode целиком: полный режим тянет umask и групповые биты сборочной машины, от них
    sha архива менялся бы без изменения содержимого. На Windows st_mode исполняемости не
    несёт вовсе (обычный файл — 0o666), поэтому там результат тот же 0644, что и раньше,
    и sha уже опубликованных win32-компонентов не сдвигается."""
    zi = zipfile.ZipInfo(arcname, date_time=(1980, 1, 1, 0, 0, 0))
    zi.compress_type = zipfile.ZIP_DEFLATED
    try:
        executable = bool(os.stat(filepath).st_mode & 0o111)
    except OSError:
        executable = False
    zi.external_attr = (0o755 if executable else 0o644) << 16
    with open(filepath, "rb") as f:
        z.writestr(zi, f.read())


def make_zip(src: Path, zip_prefix: str = "") -> Path:
    """Возвращает путь к zip-архиву. Правила:
    - .zip файл -> используем как есть;
    - директория -> zip её содержимого (корень = содержимое папки);
    - .tar.gz/.tgz -> распаковываем и перепаковываем в zip;
    - любой иной файл -> zip с этим единственным файлом в корне.

    zip_prefix (напр. "apps" или "npm-cache") — путь ВНУТРИ архива, под который
    кладётся содержимое. Нужен, чтобы zip повторял vendor/-раскладку без копирования
    в staging: git.ps1 читает HM_VENDOR/apps/git-setup.exe, значит объект git должен
    содержать apps/git-setup.exe. remote-fetch распакует в staging=HM_VENDOR → 1:1.
    """
    pref = zip_prefix.strip("/")
    def arc(name):
        return f"{pref}/{name}" if pref else name

    src = src.resolve()
    if src.is_file() and src.suffix.lower() == ".zip" and not pref:
        # Без префикса .zip уезжает как есть — его содержимое и есть содержимое артефакта.
        print(f"  вход уже zip — использую как есть: {src.name}")
        return src
    # С префиксом .zip НЕ распаковываем: скрипт ждёт САМ файл по пути внутри vendor
    # (macOS: vscode.sh читает $HM_VENDOR/apps/vscode.zip и распаковывает его сам).
    # Поэтому кладём его в архив как обычный файл под нужным префиксом — ниже, в
    # ветке bare-файла. Раньше здесь стоял отказ, из-за которого публикация vscode
    # для darwin падала целиком.

    tmp = Path(tempfile.mkdtemp(prefix="pushcomp_")) / (src.stem.split(".")[0] + ".zip")

    if src.is_dir():
        print(f"  упаковываю папку в zip{(' под ' + pref + '/') if pref else ''}: {src}")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(src.rglob("*")):
                if p.is_file():
                    _zip_add(z, arc(p.relative_to(src).as_posix()), p)
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
                    _zip_add(z, arc(p.relative_to(exdir).as_posix()), p)
        return tmp

    # bare-файл (напр. одиночный бинарь)
    print(f"  оборачиваю одиночный файл в zip{(' под ' + pref + '/') if pref else ''}: {src.name}")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        _zip_add(z, arc(src.name), src)
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

    # Регион чистим и проверяем ПЕРЕД клиентом. Прецедент: в секрете GitHub
    # YCLOUD_S3_REGION лежало значение, которое boto3 отверг
    # (InvalidRegionError: doesn't match a supported format) — и второе зеркало
    # молча отваливалось на КАЖДОЙ публикации darwin-компонентов. В логе была
    # одна строка [warn], реестр получал одно зеркало вместо двух, и заметить это
    # можно было только пересчитав mirrors в remote-components.json. Регион для
    # S3-совместимых хранилищ — не секрет и не влияет на маршрутизацию при явном
    # endpoint_url, поэтому битое значение чиним, а не роняем публикацию.
    # Endpoint чистим по той же причине: следом за регионом всплыл
    # ValueError('Invalid endpoint') — в секрете лежало значение, которое boto3 не
    # принимает. Оба раза симптом одинаков: одна строка [warn] в логе и молча
    # потерянное второе зеркало, а не падение публикации.
    endpoint = (endpoint or "").strip().strip('"').strip("'").strip().rstrip('/')
    if endpoint and not endpoint.startswith(("http://", "https://")):
        endpoint = "https://" + endpoint

    region = (region or "").strip().strip('"').strip("'").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.\-]*", region or ""):
        host = (endpoint or "").split("//")[-1].split("/")[0]
        fallback = "ru-central1" if "yandexcloud" in host else "ru-1"
        print(f"  [warn] регион {prefix}_REGION непригоден для boto3 — беру {fallback}")
        region = fallback

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
    ap.add_argument("--zip-prefix", default="", help="путь внутри zip под содержимое (напр. apps, npm-cache) — чтобы объект повторял vendor/-раскладку")
    args = ap.parse_args()

    src = Path(args.source)
    if not src.exists():
        print(f"ОШИБКА: источник не найден: {src}", file=sys.stderr)
        sys.exit(1)

    # Запись реестра всегда указывает на install-скрипт (main.js берёт его по id). Если
    # скрипта нет — компонент упал бы у пользователя с «Script not found» после докачки
    # сотен МБ. Проверяем ДО заливки: реестр не должен содержать недостижимых записей.
    script_rel = platform_to_script(args.remoteId, args.platform or "win32")
    if not (REPO_ROOT / script_rel).exists():
        print(f"ОШИБКА: нет install-скрипта {script_rel} для «{args.remoteId}» — публиковать нечего "
              f"(после докачки установщик не нашёл бы, что запускать).", file=sys.stderr)
        sys.exit(1)

    creds = load_creds()
    if not (creds.get("REGRU_S3_ENDPOINT") and creds.get("REGRU_S3_ACCESS_KEY")
            and creds.get("REGRU_S3_SECRET_KEY") and creds.get("REGRU_S3_BUCKET")):
        print("ОШИБКА: не хватает REGRU_S3_* кредов в ~/.claude/.credentials.master.env "
              "(нужны REGRU_S3_ENDPOINT, REGRU_S3_ACCESS_KEY, REGRU_S3_SECRET_KEY, REGRU_S3_BUCKET).",
              file=sys.stderr)
        sys.exit(2)

    # Сторож исполняемого бита. Права в архив кладёт _zip_add по st_mode исходника, а на
    # Windows st_mode исполняемости не несёт вовсе (обычный файл — 0o666): darwin-архив,
    # собранный там, уехал бы к пользователю целиком неисполняемым, и узнали бы об этом
    # по молчащей скрепке на чужой машине. Единственный штатный путь публикации darwin —
    # macOS-раннер (.github/workflows/build-mac-lite.yml), поэтому это не ограничение, а
    # проверка, что публикуют оттуда, откуда задумано. Fail-closed, без флага обхода:
    # обойти его значит выложить заведомо сломанное.
    if args.platform == "darwin" and sys.platform != "darwin":
        print(f"ОШИБКА: darwin-компонент публикуется с {sys.platform}, а не с macOS.\n"
              "       Права на файлы там не определяются, и в архив уедет 0644 на всём —\n"
              "       бинарь внутри .app, uv/uvx и .sh станут незапускаемыми у пользователя.\n"
              "       Публикуй darwin-компоненты с macOS (workflow build-mac-lite.yml).",
              file=sys.stderr)
        sys.exit(2)

    # 1. Упаковка в zip
    print(f"[1/5] Готовлю архив для «{args.remoteId}»…")
    zip_path = make_zip(src, args.zip_prefix)

    # 2. Снимок байтов ОДИН раз → sha256+size из НИХ (P1-3). Эти же байты уходят
    #    во все зеркала и в реестр — рассинхрон sha/контента исключён.
    print("[2/5] Снимаю байты, считаю SHA-256 и размер…")
    data, sha, size = snapshot_bytes(zip_path)
    print(f"  sha256={sha}")
    print(f"  size={size} байт ({size/1024/1024:.2f} МБ)")
    # sha файлов архива, которые потом проверит вшитый checksums.json (второй гейт) —
    # чтобы build-lite мог поймать рассинхрон «архив опубликован / vendor пересобран».
    gated = gated_files_map(zip_path, args.platform)
    print(f"  файлов под вторым гейтом (checksums.json): {len(gated)}"
          + (f" — {', '.join(sorted(gated))}" if gated else ""))

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

    # Второе зеркало — Yandex Cloud Object Storage (storage.yandexcloud.net,
    # публично-читаемый бакет). Критично для РФ-аудитории: падение/троттлинг
    # Reg.ru S3 не кладёт лёгкую редакцию — remote-fetch пробьёт второе зеркало.
    # Загружаем ТЕ ЖЕ снятые байты (P1-3), ключ тот же content-addressed.
    yc_url = None
    if creds.get("YCLOUD_S3_ACCESS_KEY") and creds.get("YCLOUD_S3_BUCKET"):
        print("  Заливаю в Yandex Cloud (2-е зеркало)…")
        # Yandex НЕ фатален: любое исключение (EndpointConnectionError/SSL/таймаут —
        # НЕ ClientError, s3_upload их не глотает) приравниваем к «зеркало пропущено»,
        # иначе сбой 2-го зеркала уронил бы публикацию ПОСЛЕ успешного Reg.ru и компонент
        # не попал бы в реестр. Первичное зеркало живо — публикуем с одним regru.
        try:
            yc_up = s3_upload(creds, "YCLOUD_S3", key, data)
        except Exception as e:  # noqa: BLE001 — транспорт/ACL/креды
            print(f"  [warn] Yandex Cloud upload исключение ({e!r}) — второе зеркало пропущено.")
            yc_up = None
        if yc_up:
            yc_url = f"{creds['YCLOUD_S3_ENDPOINT'].rstrip('/')}/{creds['YCLOUD_S3_BUCKET']}/{key}"
            mirrors.append({"host": "yandex", "url": yc_url})
            print(f"  Yandex Cloud: {yc_url}")
        else:
            print("  [warn] Yandex Cloud upload не удался — второе зеркало пропущено.")
    else:
        print("  Yandex Cloud: YCLOUD_S3_* креды не заданы — второе зеркало пропущено.")

    # 4. Проверка публичной анонимной доступности ПЕРЕД записью реестра (P2):
    #    установщик качает без кредов — приватный объект дал бы ему 403/mismatch.
    print("[4/5] Проверяю анонимную загрузку объекта (как это сделает установщик)…")
    ok_pub, detail = verify_public_get(regru_url, sha, size)
    if not ok_pub:
        print(f"ОШИБКА: объект недоступен/несовпадает анонимно: {detail}\n"
              f"  Реестр НЕ обновлён (иначе установщик получил бы битую ссылку).\n"
              f"  Проверь public-read ACL бакета/объекта: {regru_url}", file=sys.stderr)
        sys.exit(4)
    print("  Reg.ru: публичная загрузка OK (200, размер и sha совпали).")

    # Yandex-зеркало проверяем тоже; если оно не читается анонимно/не совпало —
    # НЕ роняем публикацию (Reg.ru жив), а УБИРАЕМ битое зеркало из реестра, чтобы
    # remote-fetch не пробовал мёртвый url. Реестр никогда не содержит битую ссылку.
    if yc_url:
        ok_yc, dyc = verify_public_get(yc_url, sha, size)
        if ok_yc:
            print("  Yandex Cloud: публичная загрузка OK (200, размер и sha совпали).")
        else:
            print(f"  [warn] Yandex-зеркало не прошло анонимную проверку ({dyc}) — "
                  f"убираю его из реестра (остаётся только Reg.ru).")
            mirrors[:] = [m for m in mirrors if m.get("host") != "yandex"]

    # 5. upsert реестра
    print("[5/5] Обновляю remote-components.json…")
    reg = load_registry()
    entry = {
        "remoteId": args.remoteId,
        "name": args.name or args.remoteId,
        "sizeBytes": size,
        "sha256": sha,
        "mirrors": mirrors,
        "installRelPath": script_rel,
        # Build-time (рантайм его игнорирует): {имя файла: sha256} для членов архива,
        # которые проверяет вшитый vendor/checksums.json. tools/build-lite.js сверяет
        # это с манифестом, который уезжает в exe, и не даёт выпустить рассинхрон.
        "gatedFiles": gated,
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
