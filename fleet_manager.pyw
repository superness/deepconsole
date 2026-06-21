#!/usr/bin/env pythonw
"""DeepConsole Fleet Manager — a small native GUI to launch/monitor/stop the arms.

Double-click this file (it's a .pyw, so no console) or run `python fleet_manager.pyw`.

What it does:
  - Launch N arms, each with its own Electron profile + workspace under C:\\github\\.arms
    (same contract as launch-arms.ps1; identities arm-0..arm-(N-1), resumable).
  - Live roster from the Overmind (:9200): name, status, focus, age, pid.
  - Stop one arm (by pid) or stop the whole fleet.
  - Service health for the shared backend (:8000) and Overmind (:9200), with Start buttons.
  - Board summary (open / claimed / done).
"""
import json
import os
import subprocess
import threading
import time
import tkinter as tk
import urllib.request
from tkinter import messagebox, ttk

DEEPCONSOLE = r"C:\github\deepconsole"
LOCALLLM    = r"C:\github\localllm-abuddi"
ARMS_ROOT   = r"C:\github\.arms"
OVERMIND    = "http://localhost:9200"
BACKEND     = "http://localhost:8000"

BG, PANEL, LINE, TXT, MUT = "#0b0e14", "#131822", "#27303f", "#e6edf3", "#8b97a7"
GRN, RED, AMB, BLU = "#26d07c", "#ff5470", "#ffb454", "#4aa8ff"


def _get(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


def _spawn(args, cwd, console=False):
    flags = subprocess.CREATE_NEW_CONSOLE if console else subprocess.CREATE_NO_WINDOW
    return subprocess.Popen(args, cwd=cwd, creationflags=flags)


class FleetManager:
    def __init__(self, root):
        self.root = root
        root.title("DeepConsole Fleet Manager")
        root.configure(bg=BG)
        root.geometry("760x460")

        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=TXT,
                        rowheight=24, borderwidth=0)
        style.configure("Treeview.Heading", background=BG, foreground=MUT, borderwidth=0)
        style.map("Treeview", background=[("selected", "#22456b")])

        # ---- top controls ----
        top = tk.Frame(root, bg=BG); top.pack(fill="x", padx=12, pady=(12, 6))
        tk.Label(top, text="⏚ Fleet Manager", bg=BG, fg=GRN, font=("Segoe UI", 13, "bold")).pack(side="left")
        tk.Label(top, text="Arms", bg=BG, fg=MUT).pack(side="left", padx=(16, 4))
        self.n = tk.IntVar(value=3)
        tk.Spinbox(top, from_=1, to=12, textvariable=self.n, width=4, bg=PANEL, fg=TXT,
                   buttonbackground=PANEL, relief="flat", justify="center").pack(side="left")
        self._btn(top, "▶ Launch Fleet", self.launch_fleet, BLU).pack(side="left", padx=(10, 4))
        self._btn(top, "■ Stop All", self.stop_all, RED).pack(side="left", padx=4)

        # ---- services row ----
        svc = tk.Frame(root, bg=BG); svc.pack(fill="x", padx=12, pady=4)
        self.be_dot = self._dot(svc, "backend :8000")
        self._btn(svc, "start", lambda: self.start_service("backend"), PANEL, small=True).pack(side="left", padx=(2, 14))
        self.ov_dot = self._dot(svc, "overmind :9200")
        self._btn(svc, "start", lambda: self.start_service("overmind"), PANEL, small=True).pack(side="left", padx=(2, 14))
        self.board_lbl = tk.Label(svc, text="board —", bg=BG, fg=MUT); self.board_lbl.pack(side="left")

        # ---- roster ----
        cols = ("arm", "status", "focus", "age", "pid")
        self.tree = ttk.Treeview(root, columns=cols, show="headings", height=12)
        for c, w in zip(cols, (90, 90, 320, 60, 70)):
            self.tree.heading(c, text=c.upper())
            self.tree.column(c, width=w, anchor="w")
        self.tree.pack(fill="both", expand=True, padx=12, pady=6)
        self.tree.tag_configure("working", foreground=GRN)
        self.tree.tag_configure("idle", foreground=TXT)
        self.tree.tag_configure("offline", foreground=MUT)

        bot = tk.Frame(root, bg=BG); bot.pack(fill="x", padx=12, pady=(0, 10))
        self._btn(bot, "■ Stop Selected", self.stop_selected, PANEL, small=True).pack(side="left")
        self.status = tk.Label(bot, text="", bg=BG, fg=MUT); self.status.pack(side="right")

        self._poll()  # kick off the background refresh loop

    # ---- widget helpers ----
    def _btn(self, parent, text, cmd, color, small=False):
        fg = "#04121f" if color == BLU else ("#ffffff" if color == RED else TXT)
        b = tk.Button(parent, text=text, command=cmd, bg=color, fg=fg, relief="flat",
                      activebackground=color, font=("Segoe UI", 9, "bold" if not small else "normal"),
                      padx=8, pady=3, cursor="hand2", bd=0)
        return b

    def _dot(self, parent, label):
        f = tk.Frame(parent, bg=BG); f.pack(side="left")
        dot = tk.Label(f, text="●", bg=BG, fg=MUT); dot.pack(side="left")
        tk.Label(f, text=label, bg=BG, fg=TXT).pack(side="left", padx=(2, 2))
        return dot

    # ---- actions ----
    def launch_fleet(self):
        n = self.n.get()
        threading.Thread(target=self._launch_thread, args=(n,), daemon=True).start()

    def _launch_thread(self, n):
        # start shared services first if down (the first arm would too, but be explicit)
        if not _get(OVERMIND + "/health"): self.start_service("overmind"); time.sleep(2)
        if not _get(BACKEND + "/health"): self.start_service("backend"); time.sleep(3)
        for i in range(n):
            slot = f"arm-{i}"
            profile = os.path.join(ARMS_ROOT, slot, "profile")
            os.makedirs(profile, exist_ok=True)
            os.makedirs(os.path.join(ARMS_ROOT, slot, "work"), exist_ok=True)
            self._set_status(f"launching {slot}…")
            try:
                # --autonomous: skip the session picker + auto-enable autonomous mode (the fleet's whole point)
                _spawn(["npm.cmd", "start", "--", f"--user-data-dir={profile}", "--autonomous"], DEEPCONSOLE)
            except Exception as e:
                self._set_status(f"launch error: {e}")
            time.sleep(5 if i == 0 else 1.5)   # first arm spawns shared services
        self._set_status(f"launched {n} arms")

    def start_service(self, which):
        try:
            if which == "backend":
                _spawn(["python", "-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "8000"], LOCALLLM, console=True)
            else:
                _spawn(["python", "-m", "uvicorn", "overmind.app:app", "--host", "127.0.0.1", "--port", "9200"], DEEPCONSOLE, console=True)
            self._set_status(f"started {which}")
        except Exception as e:
            messagebox.showerror("start failed", str(e))

    def stop_selected(self):
        sel = self.tree.selection()
        if not sel:
            return
        for item in sel:
            vals = self.tree.item(item, "values")
            pid = vals[4] if len(vals) > 4 else ""
            if pid and pid.isdigit():
                subprocess.run(["taskkill", "/F", "/T", "/PID", pid], capture_output=True)
        self._set_status("stopped selected")

    def stop_all(self):
        if not messagebox.askyesno("Stop all arms", "Kill all Electron arm processes?"):
            return
        subprocess.run(["taskkill", "/F", "/IM", "electron.exe"], capture_output=True)
        self._set_status("stopped all arms")

    def _set_status(self, msg):
        self.root.after(0, lambda: self.status.config(text=msg))

    # ---- polling ----
    def _poll(self):
        threading.Thread(target=self._poll_once, daemon=True).start()
        self.root.after(3000, self._poll)

    def _poll_once(self):
        be = _get(BACKEND + "/health") is not None
        ov = _get(OVERMIND + "/health") is not None
        roster = (_get(OVERMIND + "/arms") or {}).get("roster", []) if ov else []
        board = (_get(OVERMIND + "/board") or {}).get("board", []) if ov else []
        self.root.after(0, lambda: self._render(be, ov, roster, board))

    def _render(self, be, ov, roster, board):
        self.be_dot.config(fg=GRN if be else RED)
        self.ov_dot.config(fg=GRN if ov else RED)
        op = sum(1 for i in board if i["state"] == "open" and not i.get("blocked"))
        cl = sum(1 for i in board if i["state"] == "claimed")
        dn = sum(1 for i in board if i["state"] == "done")
        self.board_lbl.config(text=f"board:  {op} ready · {cl} claimed · {dn} done")
        now = time.time()
        live = {i for i in self.tree.get_children()}
        for i in live:
            self.tree.delete(i)
        # latest entry per arm name wins; show newest first
        seen = {}
        for a in roster:
            seen[a["name"]] = a
        for a in sorted(seen.values(), key=lambda x: x["name"]):
            age = int(now - a["last_seen"])
            st = a["status"]
            tag = "offline" if st == "offline" else ("working" if st == "working" else "idle")
            self.tree.insert("", "end", tags=(tag,),
                             values=(a["name"], st, (a.get("focus") or "")[:60], f"{age}s", a.get("pid", "")))


if __name__ == "__main__":
    try:  # so the taskbar groups the window under the pinned shortcut, not generic python
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("DeepConsole.FleetManager")
    except Exception:
        pass
    root = tk.Tk()
    ICON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fleet_manager.ico")
    if os.path.exists(ICON):
        try: root.iconbitmap(ICON)
        except Exception: pass
    FleetManager(root)
    root.mainloop()
