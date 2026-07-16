#!/bin/bash
# Курс-симулятор «Вайбкодинг с Claude Code» — macOS
set +e

DRY="${HM_DRY_RUN:-}"
ZIP="${HM_VENDOR:-}/course/vibecoding-course.zip"
if [ ! -f "$ZIP" ]; then
  echo "Архив курса не найден во вшитых ресурсах (vendor/course/vibecoding-course.zip) — пересобери установщик покупательского издания."
  exit 1
fi

TARGET="${HM_COURSE_TARGET:-$HOME/HamidunCourse}"
# развернём ~ в пути
TARGET="${TARGET/#\~/$HOME}"
# Защита: если из config.json прилетел Windows-путь (%USERPROFILE%\HamidunCourse) —
# не создаём мусорную папку с literal-именем (и не падаем на mkdir от «/»), ставим в дефолт.
case "$TARGET" in
  *%*|*\\*) TARGET="$HOME/HamidunCourse" ;;
esac
COURSE_DIR="$TARGET/vibecoding-course"   # zip содержит верхнюю папку vibecoding-course/

if [ -n "$DRY" ]; then
  echo "  [dry-run] WOULD: распаковать $ZIP -> $TARGET (курс окажется в $COURSE_DIR)"
  [ "$HM_COURSE_GLOBAL" = "1" ] && echo "  [dry-run] WOULD: глобально поставить навыки наставника в ~/.claude"
  [ -n "$HM_COURSE_BEACON_URL" ] && echo "  [dry-run] WOULD: включить маяк завершения -> $HM_COURSE_BEACON_URL"
  echo "  [dry-run] WOULD: создать ярлык запуска на рабочем столе"
  exit 0
fi

echo "Распаковываю курс-симулятор в $TARGET ..."
mkdir -p "$TARGET"
# Повторная установка: сносим контентные папки курса — unzip -o не удаляет файлы,
# исчезнувшие из новой версии, и наставник продолжал бы видеть старые уроки.
# Прогресс ученика не трогаем: sandbox/ и .course/state.json / identity.json в архив не входят.
if [ -f "$COURSE_DIR/CLAUDE.md" ]; then
  echo "Курс уже установлен — обновляю файлы курса (прогресс и sandbox сохраняются)."
  # Только папки из архива. Внутри .claude — лишь skills/commands: settings.local.json
  # (накопленные разрешения Claude Code) и прочие runtime-файлы должны пережить обновление.
  for sub in "tracks" ".claude/skills" ".claude/commands" ".course/knowledge"; do
    p="$COURSE_DIR/$sub"
    if [ -e "$p" ]; then
      rm -rf "$p" 2>/dev/null
      # rm -rf при EPERM/uchg молчит; unzip -o поверх намешал бы старое с новым.
      if [ -e "$p" ]; then
        echo "Не удалось обновить файлы курса ($sub): нет прав или папка занята. Проверь права на папку курса и запусти установку ещё раз."
        exit 1
      fi
    fi
  done
fi
if ! /usr/bin/unzip -o -q "$ZIP" -d "$TARGET"; then
  echo "Не удалось распаковать курс."
  exit 1
fi
if [ ! -f "$COURSE_DIR/CLAUDE.md" ]; then
  echo "Курс распаковался неожиданно (нет CLAUDE.md в $COURSE_DIR)."
  exit 1
fi
echo "Курс распакован: $COURSE_DIR"
# P0-4: квитанция владения — ТОЧНЫЙ путь созданного артефакта (main соберёт в receipt).
echo "HM-RECEIPT path $COURSE_DIR"

# --- маяк завершения (опционально) ---
# ВАЖНО: правим yaml через /usr/bin/perl, НЕ через python3 — на чистом Mac без CLT
# bare python3 это Apple-шим, открывающий GUI-диалог «установить Command Line Tools»
# посреди установки (правило всех mac-скриптов этого репо). Байтовый I/O — кириллица
# в файле не перекодируется.
if [ -n "$HM_COURSE_BEACON_URL" ]; then
  CFG="$COURSE_DIR/.course/config.yaml"
  if [ -f "$CFG" ]; then
    if HM_URL="$HM_COURSE_BEACON_URL" /usr/bin/perl -e '
      my $p = $ARGV[0];
      open(my $in, "<", $p) or exit 1; local $/; my $t = <$in>; close $in;
      my $block = "completion_beacon:\n  enabled: true\n  url: \"$ENV{HM_URL}\"";
      if ($t =~ /^completion_beacon:/m) {
        $t =~ s/^completion_beacon:.*?(?=^\S|\z)/$block\n\n/ms;
      } else {
        $t =~ s/\s*\z//; $t .= "\n\n$block\n";
      }
      open(my $out, ">", $p) or exit 1; print $out $t; close $out or exit 1;
    ' "$CFG" 2>/dev/null; then
      echo "Маяк завершения включён."
    else
      echo "Маяк включить не удалось (не критично)."
    fi
  fi
fi

# --- глобальная установка наставника в ~/.claude (опционально) ---
if [ "$HM_COURSE_GLOBAL" = "1" ]; then
  SKILLS_SRC="$COURSE_DIR/.claude/skills"
  SKILLS_DST="$HOME/.claude/skills"
  if [ -d "$SKILLS_SRC" ]; then
    mkdir -p "$SKILLS_DST"
    skfail=""
    for d in "$SKILLS_SRC"/*/; do
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      rm -rf "$SKILLS_DST/$name"
      # rm -rf при root-owned/uchg молчит; cp -R с trailing-slash тогда домешал бы
      # новые файлы в старую папку (стейл-версия навыка осталась бы грузиться).
      if [ -e "$SKILLS_DST/$name" ]; then
        echo "Не удалось обновить навык $name: нет прав или папка занята. Проверь права на ~/.claude/skills и запусти установку ещё раз."
        skfail=1; continue
      fi
      cp -R "$d" "$SKILLS_DST/$name"
    done
    [ -z "$skfail" ] && echo "Навыки курса установлены глобально в ~/.claude/skills."
  fi
  CLAUDE_MD="$HOME/.claude/CLAUDE.md"
  BEGIN='# >>> vibecoding-course >>>'
  END='# <<< vibecoding-course <<<'
  mkdir -p "$HOME/.claude"
  # Бэкап ОДИН раз: повторный запуск не должен перетирать оригинал версией,
  # в которую блок курса уже вписан.
  [ -f "$CLAUDE_MD" ] && [ ! -f "$CLAUDE_MD.bak-course" ] && cp "$CLAUDE_MD" "$CLAUDE_MD.bak-course"
  # perl вместо python3 — та же причина, что и у маяка выше.
  if HM_CRS="$COURSE_DIR" HM_BEGIN="$BEGIN" HM_END="$END" /usr/bin/perl -e '
    my $p = $ARGV[0];
    my ($begin, $end, $course) = ($ENV{HM_BEGIN}, $ENV{HM_END}, $ENV{HM_CRS});
    my $t = "";
    if (-e $p) { open(my $in, "<", $p) or exit 1; local $/; $t = <$in>; close $in; }
    my $note = "$begin\nРежим наставника по вайбкодингу доступен глобально. Курс: $course\nВести ученика — по скиллам course-driver / course-check / course-role и файлу $course/CLAUDE.md.\n$end";
    if (index($t, $begin) >= 0) { $t =~ s/\Q$begin\E.*?\Q$end\E/$note/s; }
    else { $t =~ s/\s*\z//; $t .= "\n\n$note\n"; }
    open(my $out, ">", $p) or exit 1; print $out $t; close $out or exit 1;
  ' "$CLAUDE_MD" 2>/dev/null; then
    echo "Наставник подключён глобально (блок в ~/.claude/CLAUDE.md)."
  else
    echo "Не удалось подключить наставника глобально (блок в ~/.claude/CLAUDE.md не записан)."
  fi
fi

# --- ярлык-лаунчер на рабочем столе (.command) ---
SHORTCUT="${HM_COURSE_SHORTCUT:-Курс вайбкодинг (Claude Code)}"
LAUNCHER="$HOME/Desktop/$SHORTCUT.command"
# Terminal исполняет .command с GUI-PATH (без ~/.local/bin и homebrew) и не сорсит
# профили — без строки export PATH команда claude не нашлась бы никогда.
{
  echo '#!/bin/bash'
  echo 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'
  echo "cd \"$COURSE_DIR\" || exit 1"
  echo '[ -x "$HOME/.local/bin/claude" ] && exec "$HOME/.local/bin/claude"'
  echo 'command -v claude >/dev/null 2>&1 && exec claude || { echo "Открой эту папку в Claude Code и напиши: поехали"; open .; }'
} > "$LAUNCHER" 2>/dev/null && chmod +x "$LAUNCHER" 2>/dev/null && { echo "Ярлык создан: $LAUNCHER"; echo "HM-RECEIPT path $LAUNCHER"; } || echo "Ярлык не создался (не критично)."

echo "OK: курс-симулятор установлен. Открой ярлык «$SHORTCUT» (или папку $COURSE_DIR) и напиши агенту «поехали»."
exit 0
