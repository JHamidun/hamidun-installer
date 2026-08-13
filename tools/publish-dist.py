#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""publish-dist.py — выложить готовые дистрибутивы (exe/dmg) на боевые ссылки.

ЗАЧЕМ ОТДЕЛЬНЫЙ ИНСТРУМЕНТ. push-component.py публикует КОМПОНЕНТЫ (zip внутрь
реестра докачки), а сами установщики до сих пор заливались руками или из
mac-workflow. Ручная заливка Windows опасна ровно одним: имена локально и на S3
НЕ совпадают, причём перекрёстно.

    release/Hamidun-Setup-Windows.exe        (~1,2 ГБ, ПОЛНАЯ офлайн)
        -> vibecoding/downloads/Hamidun-Setup-Windows-Offline.exe
    release/Hamidun-Setup-Windows-Lite.exe   (~84 МБ, лёгкая)
        -> vibecoding/downloads/Hamidun-Setup-Windows.exe        <- да, без суффикса

То есть файл с именем «...-Lite.exe» уезжает в ключ «...-Windows.exe», а файл без
суффикса — в ключ с суффиксом «-Offline». Перепутать их местами — значит отдать
человеку, выбравшему «полная офлайн-версия», лёгкую сборку, которая полезет в сеть
за 1,2 ГБ. Внешне ссылка рабочая, подмена всплывёт только у пользователя.

Поэтому здесь fail-closed: у каждой цели заявлен диапазон размера (edition), и файл
вне диапазона публиковать нельзя. Ошибиться местами больше не получится — offline
не пролезет в lite-ключ и наоборот.

Ритуал заливки повторяет build-mac-lite.yml (он уже обкатан на боевом .dmg):
  • старый объект НЕ удаляем — заливаем поверх (delete_object означал бы гарантированные
    404 для всех, кто зашёл во время многоминутной заливки);
  • перед заливкой снимаем ТОЛЬКО свои осиротевшие multipart (чужие in-flight не трогаем);
  • multipart с порогом 64 МиБ, ACL public-read, честный ContentType;
  • после заливки — анонимный HEAD: размер обязан совпасть с локальным.

Запуск:
    python tools/publish-dist.py --dry-run          показать план
    python tools/publish-dist.py --only win-offline
    python tools/publish-dist.py                    выложить всё, что найдено
"""
import argparse
import io
import os
import sys
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')

REPO = os.path.dirname(os.path.abspath(os.path.dirname(__file__)))
MIB = 1024 * 1024

# Цели публикации. min/max — fail-closed рамки размера для этой редакции.
TARGETS = {
    'win-offline': {
        'local': 'release/Hamidun-Setup-Windows.exe',
        'key': 'vibecoding/downloads/Hamidun-Setup-Windows-Offline.exe',
        'type': 'application/vnd.microsoft.portable-executable',
        'min_mib': 600, 'max_mib': 2500,
        'mirrors': ['REGRU_S3'],
        'note': 'полная офлайн-версия Windows',
    },
    'win-lite': {
        'local': 'release/Hamidun-Setup-Windows-Lite.exe',
        'key': 'vibecoding/downloads/Hamidun-Setup-Windows.exe',
        'type': 'application/vnd.microsoft.portable-executable',
        'min_mib': 20, 'max_mib': 250,
        'mirrors': ['REGRU_S3', 'YCLOUD_S3'],
        'note': 'лёгкая версия Windows (докачка компонентов из сети)',
    },
}


def load_creds():
    path = os.path.expanduser('~/.claude/.credentials.master.env')
    env = {}
    with io.open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def client_for(env, prefix):
    import boto3
    from botocore.config import Config
    need = [f'{prefix}_ENDPOINT', f'{prefix}_ACCESS_KEY', f'{prefix}_SECRET_KEY', f'{prefix}_BUCKET']
    if not all(env.get(k) for k in need):
        return None, None, None
    region = (env.get(f'{prefix}_REGION') or '').strip() or 'ru-1'
    c = boto3.client(
        's3',
        endpoint_url=env[f'{prefix}_ENDPOINT'],
        aws_access_key_id=env[f'{prefix}_ACCESS_KEY'],
        aws_secret_access_key=env[f'{prefix}_SECRET_KEY'],
        region_name=region,
        config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}),
    )
    return c, env[f'{prefix}_BUCKET'], env[f'{prefix}_ENDPOINT'].rstrip('/')


def head_size(url):
    """Анонимный HEAD — ровно то, что увидит пользователь, а не наш авторизованный клиент."""
    try:
        req = urllib.request.Request(url, method='HEAD')
        with urllib.request.urlopen(req, timeout=60) as r:
            return int(r.headers.get('Content-Length') or 0)
    except Exception as e:
        print('     (HEAD не удался: %s)' % str(e)[:70])
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--only', choices=sorted(TARGETS))
    args = ap.parse_args()

    try:
        from boto3.s3.transfer import TransferConfig
    except ImportError:
        raise SystemExit('нужен boto3: python -m pip install --user boto3')

    env = load_creds()
    names = [args.only] if args.only else sorted(TARGETS)
    cfg = TransferConfig(multipart_threshold=64 * MIB, multipart_chunksize=64 * MIB, use_threads=True)

    plan, problems = [], []
    for name in names:
        t = TARGETS[name]
        p = os.path.join(REPO, t['local'].replace('/', os.sep))
        if not os.path.exists(p):
            problems.append('%s: нет файла %s' % (name, t['local']))
            continue
        mib = os.path.getsize(p) / MIB
        if not (t['min_mib'] <= mib <= t['max_mib']):
            problems.append('%s: размер %.1f МиБ вне рамок редакции %d–%d МиБ — похоже, перепутаны сборки'
                            % (name, mib, t['min_mib'], t['max_mib']))
            continue
        plan.append((name, t, p, os.path.getsize(p)))

    for name, t, p, size in plan:
        print('  %-12s %-40s %8.1f МиБ  ->  %s' % (name, t['local'], size / MIB, t['key']))
        print('               %s; зеркала: %s' % (t['note'], ', '.join(t['mirrors'])))
    for pr in problems:
        print('  ПРОПУСК ' + pr)
    if not plan:
        raise SystemExit('публиковать нечего')
    if args.dry_run:
        print('\n[dry-run] ничего не залито.')
        return

    print('')
    failures = []
    for name, t, p, size in plan:
        for prefix in t['mirrors']:
            s3, bucket, endpoint = client_for(env, prefix)
            if not s3:
                print('  %s/%s: кредов нет — зеркало пропущено' % (name, prefix))
                continue
            # Свои осиротевшие multipart — снимаем; чужие заливки в тот же бакет не трогаем.
            try:
                for u in s3.list_multipart_uploads(Bucket=bucket).get('Uploads', []):
                    if u['Key'] == t['key']:
                        s3.abort_multipart_upload(Bucket=bucket, Key=u['Key'], UploadId=u['UploadId'])
                        print('  снят осиротевший multipart: ' + u['Key'])
            except Exception as e:
                print('  (список multipart недоступен: %s)' % str(e)[:60])

            print('  заливаю %s -> %s/%s …' % (name, prefix, t['key']))
            s3.upload_file(p, bucket, t['key'],
                           ExtraArgs={'ACL': 'public-read', 'ContentType': t['type']}, Config=cfg)
            url = '%s/%s/%s' % (endpoint, bucket, t['key'])
            got = head_size(url)
            ok = got == size
            print('     %s  %s' % (url, 'OK' if ok else 'РАЗМЕР НЕ СОВПАЛ (%s против %s)' % (got, size)))
            if not ok:
                failures.append(url)

    if failures:
        raise SystemExit('проверка после заливки не сошлась: ' + ', '.join(failures))
    print('\nГотово.')


if __name__ == '__main__':
    main()
