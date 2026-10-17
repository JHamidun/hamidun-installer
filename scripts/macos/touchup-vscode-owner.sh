#!/usr/bin/env bash
# touchup-vscode-owner.sh — always-run: VS Code в /Applications принадлежит root (так его ставили
# прежние сборки: cp шёл внутри admin_run). Самообновление VS Code тогда каждый раз просит пароль
# или Touch ID для «вспомогательной программы». Здесь НЕТ sudo и ничего не меняется: ещё одно окно
# с паролем посреди установки хуже, чем честная строка с точной командой — поэтому только
# предупреждение. Новые установки отдают приложение человеку сами (HM_VSCODE_INSTALL_SH).
# VS Code, выбранный в этом прогоне, о владельце уже сказал сам (vscode.sh) — не дублируем.
# Сухой прогон (HM_DRY_RUN) ничего не проверяет вовсе.
# Контракт touchup-скриптов — в _lib.sh (hm_touchup_begin): автономен, идемпотентен, ≤5 с,
# без сети, никогда не ненулевой код.
set -uo pipefail
trap 'exit 0' EXIT
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/_lib.sh" 2>/dev/null || { echo "[touchup-vscode-owner] пропущено: нет _lib.sh"; exit 0; }
hm_touchup_begin vscode-owner

if [ -n "${HM_DRY_RUN:-}" ]; then
  echo "  [dry-run] WOULD: проверить, кому принадлежит VS Code в /Applications, и при владельце root напечатать точную команду (ничего не менять)"
  hm_touchup_end
fi
case ",${HM_SELECTED:-}," in *",vscode,"*) hm_touchup_end ;; esac

# HM_VSCODE_APP — только для проверки скрипта; в работе всегда /Applications. В ~/Applications
# приложение по построению принадлежит человеку.
APP="${HM_VSCODE_APP:-/Applications/Visual Studio Code.app}"
if hm_app_is_root_owned "$APP"; then
  echo "[touchup-vscode-owner] $(hm_vscode_owner_hint "$APP")"
fi
hm_touchup_end
