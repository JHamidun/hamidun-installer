#!/usr/bin/env python3
"""
Hamidun Bridge agent — стабильный зарубежный IP только для ИИ-доменов (split-tunnel).

Поднимает SSH dynamic forward (системный `ssh -D` → локальный SOCKS5), отдаёт PAC,
который гонит ТОЛЬКО ИИ-домены через SOCKS, ставит системный прокси на этот PAC и
поднимает локальный HTTP→SOCKS мост для CLI (Claude Code/Codex через HTTPS_PROXY).
Живёт в трее, переподключается, мягко простаивает пока не настроен сервер.

Конфиг: <appdata>/HamidunBridge/config.json
  {
    "enrollEndpoint": "",            # https://bridge.hamidun.../enroll (пусто => idle)
    "bridgeToken": "",               # выдаёт бот после оплаты/trial
    "ssh": {"host":"","port":22,"user":"","keyPath":"","password":""},  # "База": свой VPS напрямую
    "socksPort": 1080, "httpPort": 1081, "pacPort": 1082,
    "pacDomains": ["claude.ai","anthropic.com","openai.com","chatgpt.com","oaistatic.com","higgsfield.ai"],
    "enabled": false
  }
"""
import json, os, sys, time, threading, subprocess, socket, struct, select
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest

IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"

def app_dir():
    base = (os.environ.get("LOCALAPPDATA") if IS_WIN else os.path.join(os.path.expanduser("~"), "Library", "Application Support")) or os.path.expanduser("~")
    d = os.path.join(base, "HamidunBridge")
    os.makedirs(d, exist_ok=True)
    return d

CFG_PATH = os.path.join(app_dir(), "config.json")
LOG_PATH = os.path.join(app_dir(), "bridge.log")

def log(msg):
    line = time.strftime("%H:%M:%S ") + str(msg)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    print(line, flush=True)

def load_cfg():
    try:
        with open(CFG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def save_cfg(cfg):
    with open(CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ---- получить SSH-доступ: enroll по токену ИЛИ напрямую из конфига ("База") ----
def resolve_ssh(cfg):
    ssh = dict(cfg.get("ssh") or {})
    pac_domains = cfg.get("pacDomains") or []
    endpoint = (cfg.get("enrollEndpoint") or "").strip()
    token = (cfg.get("bridgeToken") or "").strip()
    if endpoint and token:
        # ретраи с бэкоффом: после ребута сеть может быть ещё не поднята (гонка),
        # без ретраев мост молча не встаёт.
        delays = [0, 3, 8, 20, 45]
        for attempt, delay in enumerate(delays):
            if delay:
                time.sleep(delay)
            try:
                body = json.dumps({"bridgeToken": token, "client": socket.gethostname()}).encode()
                req = urlrequest.Request(endpoint, data=body, headers={"Content-Type": "application/json"})
                with urlrequest.urlopen(req, timeout=20) as r:
                    data = json.loads(r.read().decode())
                ssh = {"host": data.get("sshHost", ""), "port": int(data.get("sshPort", 22)),
                       "user": data.get("sshUser", ""), "key": data.get("sshKey", ""), "keyPath": "", "password": ""}
                if data.get("sshKey"):
                    kp = os.path.join(app_dir(), "bridge_key")
                    with open(kp, "w", encoding="utf-8") as f:
                        f.write(data["sshKey"])
                    try: os.chmod(kp, 0o600)
                    except Exception: pass
                    ssh["keyPath"] = kp
                if data.get("pacDomains"):
                    pac_domains = data["pacDomains"]
                log("enroll OK: " + ssh.get("host", ""))
                break
            except Exception as e:
                log("enroll FAIL (попытка %d/%d): %s" % (attempt + 1, len(delays), e))
    return ssh, pac_domains


# ---- SSH dynamic forward (системный ssh -D) с реконнектом ----
class Tunnel:
    def __init__(self, ssh, socks_port):
        self.ssh, self.port, self.proc, self.stop = ssh, socks_port, None, False

    def _cmd(self):
        c = ["ssh", "-N", "-D", "127.0.0.1:%d" % self.port,
             "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30",
             "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes",
             "-p", str(self.ssh.get("port", 22))]
        if self.ssh.get("keyPath"):
            c += ["-i", self.ssh["keyPath"], "-o", "IdentitiesOnly=yes"]
        c += ["%s@%s" % (self.ssh.get("user", ""), self.ssh.get("host", ""))]
        return c

    def run(self):
        while not self.stop:
            if not (self.ssh.get("host") and self.ssh.get("user")):
                log("туннель: нет SSH-доступа — простой"); time.sleep(10); continue
            try:
                log("ssh -D %d → %s" % (self.port, self.ssh.get("host")))
                kw = {}
                if IS_WIN:
                    kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
                self.proc = subprocess.Popen(self._cmd(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)
                self.proc.wait()
            except FileNotFoundError:
                log("ssh не найден (OpenSSH Client). Установите его."); time.sleep(15)
            except Exception as e:
                log("туннель упал: %s" % e)
            if not self.stop:
                time.sleep(3)  # реконнект

    def kill(self):
        self.stop = True
        if self.proc and self.proc.poll() is None:
            try: self.proc.terminate()
            except Exception: pass


# ---- PAC: только ИИ-домены через SOCKS, остальное DIRECT ----
def pac_text(domains, socks_port):
    conds = " || ".join('shExpMatch(host, "*%s")' % d for d in domains)
    # fail-open: "; DIRECT" в конце — если туннель упал, браузер идёт напрямую,
    # а не получает "сайт полностью недоступен".
    return ("function FindProxyForURL(url, host) {\n"
            "  if (%s) { return \"SOCKS5 127.0.0.1:%d; SOCKS 127.0.0.1:%d; DIRECT\"; }\n"
            "  return \"DIRECT\";\n}\n") % (conds or "false", socks_port, socks_port)

def serve_pac(domains, socks_port, pac_port):
    body = pac_text(domains, socks_port).encode()
    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ns-proxy-autoconfig")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        def log_message(self, format, *args): pass
    srv = ThreadingHTTPServer(("127.0.0.1", pac_port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---- HTTP→SOCKS мост для CLI (Claude Code/Codex через HTTPS_PROXY=http://127.0.0.1:httpPort) ----
def host_in_pac(host, domains):
    # тот же матч, что и в PAC: суффиксное совпадение по домену.
    h = (host or "").lower()
    for d in domains or []:
        d = str(d).lower().strip()
        if d and (h == d or h.endswith("." + d) or h.endswith(d)):
            return True
    return False

def serve_http_bridge(socks_port, http_port, pac_domains):
    def socks_connect(dst_host, dst_port):
        s = socket.create_connection(("127.0.0.1", socks_port), timeout=15)
        s.sendall(b"\x05\x01\x00")
        if s.recv(2)[1:2] != b"\x00": raise OSError("socks auth")
        hb = dst_host.encode()
        s.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + struct.pack(">H", dst_port))
        rep = s.recv(10)
        if len(rep) < 2 or rep[1] != 0x00: raise OSError("socks connect")
        return s
    def direct_connect(dst_host, dst_port):
        return socket.create_connection((dst_host, dst_port), timeout=15)
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def do_CONNECT(self):
            try:
                host, _, port = self.path.partition(":")
                dport = int(port or 443)
                # ограничиваем проксирование доменами из pac_domains —
                # остальной CLI-HTTPS идёт напрямую, НЕ через VPS.
                if host_in_pac(host, pac_domains):
                    up = socks_connect(host, dport)
                else:
                    up = direct_connect(host, dport)
            except Exception:
                self.send_response(502); self.end_headers(); return
            self.send_response(200, "Connection Established"); self.end_headers()
            self._pump(self.connection, up)
        def _pump(self, a, b):
            a.setblocking(False); b.setblocking(False)
            try:
                while True:
                    r, _, x = select.select([a, b], [], [a, b], 60)
                    if x or not r: break
                    for s in r:
                        d = s.recv(65536)
                        if not d: return
                        (b if s is a else a).sendall(d)
            except Exception:
                pass
            finally:
                for s in (a, b):
                    try: s.close()
                    except Exception: pass
        def log_message(self, format, *args): pass
    srv = ThreadingHTTPServer(("127.0.0.1", http_port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---- macOS: активные сетевые сервисы (Wi-Fi, Ethernet, USB-модемы, ...) ----
def mac_active_services():
    """Возвращает список активных (не отключённых) сетевых сервисов.
    Отключённые сервисы в `-listallnetworkservices` помечены '*' в начале."""
    svcs = []
    try:
        out = subprocess.check_output(["networksetup", "-listallnetworkservices"],
                                      stderr=subprocess.DEVNULL, text=True)
        for line in out.splitlines():
            line = line.rstrip("\n")
            if not line or line.startswith("An asterisk"):
                continue
            if line.startswith("*"):  # отключённый сервис — пропускаем
                continue
            svcs.append(line.strip())
    except Exception as e:
        log("networksetup -listallnetworkservices FAIL: %s" % e)
    if not svcs:
        svcs = ["Wi-Fi"]  # запасной вариант
    return svcs


# ---- системный прокси на PAC + HTTPS_PROXY для CLI ----
def _mac_pac_env_file():
    return os.path.join(app_dir(), "cli_proxy.env")

def _mac_write_cli_env(http_proxy):
    """Пишет источаемый (source-able) файл env для CLI: HTTPS_PROXY/ALL_PROXY.
    На macOS нет user-level setx, поэтому кладём файл, который можно подключить в
    ~/.zshrc / ~/.bashrc. Идемпотентно: перезапись."""
    try:
        with open(_mac_pac_env_file(), "w", encoding="utf-8") as f:
            f.write("# Hamidun Bridge — прокси для CLI (source в ~/.zshrc/~/.bashrc)\n")
            f.write('export HTTPS_PROXY="%s"\n' % http_proxy)
            f.write('export https_proxy="%s"\n' % http_proxy)
            f.write('export ALL_PROXY="%s"\n' % http_proxy)
            f.write('export all_proxy="%s"\n' % http_proxy)
    except Exception as e:
        log("cli env write FAIL: %s" % e)

def _mac_clear_cli_env():
    """Идемпотентно очищает CLI-env файл (пустые export'ы = откат)."""
    try:
        with open(_mac_pac_env_file(), "w", encoding="utf-8") as f:
            f.write("# Hamidun Bridge — мост выключен: прокси для CLI снят\n")
            f.write('export HTTPS_PROXY=""\n')
            f.write('export https_proxy=""\n')
            f.write('export ALL_PROXY=""\n')
            f.write('export all_proxy=""\n')
    except Exception as e:
        log("cli env clear FAIL: %s" % e)

def set_system_proxy(pac_port, http_port, on):
    """Ставит/снимает системный PAC-прокси. ИДЕМПОТЕНТНО: повторный OFF безопасен,
    используется в fail-open cleanup при падении/убийстве агента."""
    pac_url = "http://127.0.0.1:%d/proxy.pac" % pac_port
    http_proxy = "http://127.0.0.1:%d" % http_port
    if IS_WIN:
        import winreg, ctypes
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Internet Settings", 0, winreg.KEY_WRITE)
            if on:
                winreg.SetValueEx(key, "AutoConfigURL", 0, winreg.REG_SZ, pac_url)
            else:
                try: winreg.DeleteValue(key, "AutoConfigURL")
                except FileNotFoundError: pass
            winreg.CloseKey(key)
            ctypes.windll.wininet.InternetSetOptionW(0, 39, 0, 0)  # SETTINGS_CHANGED
            ctypes.windll.wininet.InternetSetOptionW(0, 37, 0, 0)  # REFRESH
        except Exception as e:
            log("win proxy set FAIL: %s" % e)
        # для Claude Code CLI — user-level HTTPS_PROXY на HTTP-мост
        try:
            subprocess.run(["setx", "HTTPS_PROXY", http_proxy if on else ""],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            log("setx HTTPS_PROXY FAIL: %s" % e)
    elif IS_MAC:
        for svc in mac_active_services():
            try:
                if on:
                    subprocess.run(["networksetup", "-setautoproxyurl", svc, pac_url], stderr=subprocess.DEVNULL)
                    subprocess.run(["networksetup", "-setautoproxystate", svc, "on"], stderr=subprocess.DEVNULL)
                else:
                    subprocess.run(["networksetup", "-setautoproxystate", svc, "off"], stderr=subprocess.DEVNULL)
            except Exception as e:
                log("networksetup(%s) FAIL: %s" % (svc, e))
        # для Claude Code CLI на macOS — HTTPS_PROXY/ALL_PROXY через source-able env файл
        if on:
            _mac_write_cli_env(http_proxy)
        else:
            _mac_clear_cli_env()
    log("системный прокси: %s" % ("ON" if on else "OFF"))


# ---- fail-open cleanup: гарантированно снять системный прокси и PAC при выходе ----
_CLEANUP_DONE = False
_CLEANUP_LOCK = threading.Lock()

def failopen_cleanup():
    """Идемпотентно снимает системный прокси/PAC/CLI-env. Вызывается из atexit и
    из обработчиков SIGINT/SIGTERM — упавший агент НЕ должен оставить юзера без
    интернета/Claude."""
    global _CLEANUP_DONE
    with _CLEANUP_LOCK:
        if _CLEANUP_DONE:
            return
        _CLEANUP_DONE = True
    try:
        cfg = load_cfg()
        set_system_proxy(cfg.get("pacPort", 1082), cfg.get("httpPort", 1081), False)
        log("fail-open cleanup: системный прокси снят")
    except Exception as e:
        try: log("fail-open cleanup FAIL: %s" % e)
        except Exception: pass

def install_failopen_handlers():
    import atexit, signal
    atexit.register(failopen_cleanup)
    def _handler(signum, frame):
        failopen_cleanup()
        # восстановить дефолтное поведение и «повторить» сигнал, чтобы процесс вышел
        try:
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)
        except Exception:
            os._exit(0)
    for sig in ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"):
        s = getattr(signal, sig, None)
        if s is not None:
            try: signal.signal(s, _handler)
            except Exception: pass


# ---- оркестратор ----
class Bridge:
    def __init__(self):
        self.tunnel = None; self.pac_srv = None; self.http_srv = None; self.on = False

    def start(self):
        cfg = load_cfg()
        ssh, domains = resolve_ssh(cfg)
        if not (ssh.get("host") and ssh.get("user")):
            log("мост не настроен (нет сервера/токена) — включить нельзя"); return False
        sp, hp, pp = cfg.get("socksPort", 1080), cfg.get("httpPort", 1081), cfg.get("pacPort", 1082)
        self.tunnel = Tunnel(ssh, sp)
        threading.Thread(target=self.tunnel.run, daemon=True).start()
        self.pac_srv = serve_pac(domains, sp, pp)
        # мост для CLI фильтрует по pac_domains: только ИИ-домены через VPS,
        # остальной CLI-HTTPS идёт напрямую.
        self.http_srv = serve_http_bridge(sp, hp, domains)
        set_system_proxy(pp, hp, True)
        self.on = True
        cfg["enabled"] = True; save_cfg(cfg)
        log("МОСТ ВКЛЮЧЁН"); return True

    def stop(self):
        cfg = load_cfg()
        set_system_proxy(cfg.get("pacPort", 1082), cfg.get("httpPort", 1081), False)
        if self.tunnel: self.tunnel.kill()
        for s in (self.pac_srv, self.http_srv):
            if s:
                try: s.shutdown()
                except Exception: pass
        self.on = False
        cfg["enabled"] = False; save_cfg(cfg)
        log("мост выключен")


def run_tray(bridge):
    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        log("pystray недоступен — headless (включён по конфигу)")
        if load_cfg().get("enabled"): bridge.start()
        while True: time.sleep(3600)
    def icon_img(active):
        img = Image.new("RGB", (64, 64), (7, 9, 38))
        d = ImageDraw.Draw(img); d.ellipse((16, 16, 48, 48), fill=(98, 197, 132) if active else (90, 95, 110))
        return img
    def toggle(icon, item):
        bridge.stop() if bridge.on else bridge.start()
        icon.icon = icon_img(bridge.on)
        icon.title = "Hamidun Bridge — " + ("ВКЛ" if bridge.on else "выкл")
    def status(icon, item):
        cfg = load_cfg(); log("status: enabled=%s endpoint=%s" % (cfg.get("enabled"), bool(cfg.get("enrollEndpoint"))))
    def quit_(icon, item):
        bridge.stop(); icon.stop()
    menu = pystray.Menu(
        pystray.MenuItem(lambda i: ("Выключить мост" if bridge.on else "Включить мост"), toggle),
        pystray.MenuItem("Статус (в лог)", status),
        pystray.MenuItem("Выход", quit_))
    ic = pystray.Icon("HamidunBridge", icon_img(False), "Hamidun Bridge — выкл", menu)
    if load_cfg().get("enabled"):
        bridge.start(); ic.icon = icon_img(True); ic.title = "Hamidun Bridge — ВКЛ"
    ic.run()


if __name__ == "__main__":
    # fail-open: при любом выходе (штатном, SIGINT/SIGTERM, краше) гарантированно
    # снимаем системный прокси/PAC/CLI-env, чтобы не оставить юзера без интернета.
    install_failopen_handlers()
    b = Bridge()
    if "--start" in sys.argv:
        cfg = load_cfg(); cfg["enabled"] = True; save_cfg(cfg)
    if "--headless" in sys.argv:
        # headless уважает сохранённое enabled; если выключено — мягко простаиваем,
        # системный прокси НЕ трогаем.
        if load_cfg().get("enabled"): b.start()
        while True: time.sleep(3600)
    run_tray(b)
