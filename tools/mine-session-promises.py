# -*- coding: utf-8 -*-
"""Достаёт из транскриптов сессий ОБЕЩАНИЯ ассистента и явные хвосты.

Читает потоково: файлы до 1,2 ГБ, целиком в память они не лезут.
Берём только сообщения ассистента (обещает он, не владелец) и только те,
где есть язык намерения или незакрытости. Контекст режем узко — задача
собрать список для разбора, а не пересказать сессию.
"""
import io, json, os, re, sys

FILES = sys.argv[1:]

# Язык обещания. Специально НЕ ловим прошедшее время («сделал», «починил») —
# нас интересует то, что было объявлено к исполнению.
PROMISE = re.compile(
    r"(?:^|[\s«\"(])("
    r"сделаю|доделаю|починю|запущу|проверю|напишу|соберу|выложу|заведу|добавлю|"
    r"приступаю|начинаю|следующим шагом|отдельным заходом|позже|потом верн|"
    r"осталось|остаётся|остается|не закончил|не сделал|не проверен|не подтвержд|"
    r"за тобой|за владельцем|нужно от теб|жду решени|требует решени|"
    r"пока не|временно|заглушк|TODO|FIXME"
    r")", re.I)

# Явные маркеры хвоста в конце хода — самые ценные.
TAIL = re.compile(r"(осталось|за тобой|за владельцем|не закончил|не сделал|"
                  r"следующим шагом|отдельным заходом|жду решени)", re.I)

def text_of(msg):
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out = []
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                out.append(b.get("text") or "")
        return "\n".join(out)
    return ""

seen = set()
rows = []
for path in FILES:
    if not os.path.isfile(path):
        print(f"# нет файла: {path}", file=sys.stderr); continue
    sess = os.path.basename(path)[:8]
    n = 0
    with io.open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            n += 1
            if '"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get("message") or {}
            if m.get("role") != "assistant":
                continue
            t = text_of(m)
            if not t or len(t) < 40:
                continue
            ts = (d.get("timestamp") or "")[:16]
            for para in t.split("\n"):
                para = para.strip()
                if len(para) < 40 or len(para) > 400:
                    continue
                if not PROMISE.search(para):
                    continue
                key = re.sub(r"\W+", "", para.lower())[:90]
                if key in seen:
                    continue
                seen.add(key)
                rows.append({
                    "ts": ts,
                    "sess": sess,
                    "tail": bool(TAIL.search(para)),
                    "text": para,
                })
    print(f"# {sess}: строк {n}, накоплено {len(rows)}", file=sys.stderr)

rows.sort(key=lambda r: r["ts"])
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "promises.jsonl")
with io.open(out, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"# записано {len(rows)} в {out}", file=sys.stderr)
print(f"# из них с явным маркером хвоста: {sum(1 for r in rows if r['tail'])}", file=sys.stderr)
