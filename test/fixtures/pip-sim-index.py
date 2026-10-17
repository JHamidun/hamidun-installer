"""Фикстура для test/run-tests.js (раздел «Фетчер vendor»): локальный «PyPI» без сети.

Зачем. Находка S-6: `pip download` обычного sdist ИСПОЛНЯЕТ его setup.py на машине сборки. Проверить, что
фетчер этого больше не допускает, можно только исполнением: берём настоящую команду pip против
file://-индекса, где вместо честного пакета лежит подмена, и смотрим, дописался ли «маркер исполнения».

Строит в <root> два индекса, отличающихся ТОЛЬКО содержимым sdist пакета pyaes:
  good/  — пакет, который мы закрепили хешем (setup.py пишет PINNED_EXECUTED: проверенный код исполняться может);
  evil/  — подмена под тем же именем и версией (setup.py пишет DECOY_EXECUTED: это и есть провал).
Проекты индекса: fakepkg (колесо, требует pyaes), fakepkg2 (колесо, требует sdistonly), sdistonly (ТОЛЬКО sdist,
пишет SDISTONLY_EXECUTED), а также пустышки pip, setuptools, wheel, pystray, pillow (их колёса фетчер качает отдельно или добавляет к requirements).
Маркеры пишутся в <root>/markers/. В stdout — sha256 хорошего pyaes (его и закрепляет тест).

usage: python -I pip-sim-index.py <root>
"""
import hashlib
import io
import os
import sys
import tarfile
import zipfile

root = os.path.abspath(sys.argv[1])
markers = os.path.join(root, 'markers')
os.makedirs(markers, exist_ok=True)


def sdist(path, name, version, marker, pkg=True):
    setup = (
        "import os\n"
        "from setuptools import setup\n"
        "open(os.path.join(%r, %r), 'w').write('executed')\n"
        "setup(name=%r, version=%r, packages=%r)\n" % (markers, marker, name, version, [name] if pkg else [])
    )
    members = {
        '%s-%s/setup.py' % (name, version): setup,
        '%s-%s/PKG-INFO' % (name, version): 'Metadata-Version: 1.1\nName: %s\nVersion: %s\n' % (name, version),
    }
    if pkg:
        members['%s-%s/%s/__init__.py' % (name, version, name)] = '# %s\n' % marker
    with tarfile.open(path, 'w:gz') as t:
        for member, text in members.items():
            data = text.encode('utf-8')
            ti = tarfile.TarInfo(member)
            ti.size = len(data)
            ti.mtime = 0
            t.addfile(ti, io.BytesIO(data))


def wheel(path, name, version, requires=()):
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('%s/__init__.py' % name, '')
        meta = 'Metadata-Version: 2.1\nName: %s\nVersion: %s\n' % (name, version)
        for r in requires:
            meta += 'Requires-Dist: %s\n' % r
        z.writestr('%s-%s.dist-info/METADATA' % (name, version), meta)
        z.writestr('%s-%s.dist-info/WHEEL' % (name, version),
                   'Wheel-Version: 1.0\nGenerator: u7\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
        z.writestr('%s-%s.dist-info/RECORD' % (name, version), '')


def build(kind):
    base = os.path.join(root, kind)
    files = os.path.join(base, 'files')
    simple = os.path.join(base, 'simple')
    os.makedirs(files, exist_ok=True)
    sdist(os.path.join(files, 'pyaes-1.6.1.tar.gz'), 'pyaes', '1.6.1',
          'PINNED_EXECUTED' if kind == 'good' else 'DECOY_EXECUTED')
    sdist(os.path.join(files, 'sdistonly-1.0.tar.gz'), 'sdistonly', '1.0', 'SDISTONLY_EXECUTED')
    wheel(os.path.join(files, 'fakepkg-1.0-py3-none-any.whl'), 'fakepkg', '1.0', ['pyaes'])
    wheel(os.path.join(files, 'fakepkg2-1.0-py3-none-any.whl'), 'fakepkg2', '1.0', ['sdistonly'])
    for dummy in ('pip', 'setuptools', 'wheel', 'pystray', 'pillow'):
        wheel(os.path.join(files, '%s-1.0-py3-none-any.whl' % dummy), dummy, '1.0')
    index = {
        'fakepkg': ['fakepkg-1.0-py3-none-any.whl'],
        'fakepkg2': ['fakepkg2-1.0-py3-none-any.whl'],
        'pyaes': ['pyaes-1.6.1.tar.gz'],
        'sdistonly': ['sdistonly-1.0.tar.gz'],
        'pip': ['pip-1.0-py3-none-any.whl'],
        'setuptools': ['setuptools-1.0-py3-none-any.whl'],
        'wheel': ['wheel-1.0-py3-none-any.whl'],
        'pystray': ['pystray-1.0-py3-none-any.whl'],
        'pillow': ['pillow-1.0-py3-none-any.whl'],
    }
    os.makedirs(simple, exist_ok=True)
    for project, names in index.items():
        d = os.path.join(simple, project)
        os.makedirs(d, exist_ok=True)
        links = ''.join('<a href="../../files/%s">%s</a><br/>\n' % (n, n) for n in names)
        with open(os.path.join(d, 'index.html'), 'w') as f:
            f.write('<!DOCTYPE html><html><body>\n%s</body></html>\n' % links)
    with open(os.path.join(simple, 'index.html'), 'w') as f:
        f.write('<!DOCTYPE html><html><body>%s</body></html>\n' % ''.join('<a href="%s/">%s</a>' % (p, p) for p in index))


build('good')
build('evil')
with open(os.path.join(root, 'good', 'files', 'pyaes-1.6.1.tar.gz'), 'rb') as f:
    print(hashlib.sha256(f.read()).hexdigest())
