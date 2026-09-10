#!/usr/bin/env python3
import os, re, signal, time
kill = []
for p in os.listdir('/proc'):
    if not p.isdigit():
        continue
    try:
        with open(f'/proc/{p}/cmdline', 'rb') as f:
            cmd = f.read().replace(b'\0', b' ').decode(errors='ignore')
    except Exception:
        continue
    # match java emulator processes and next servers only (not our own shell)
    if re.search(r'firebase-emulator|emulators:?(start|exec)|next-server', cmd) and 'python3' not in cmd:
        kill.append((p, cmd[:90]))
for p, c in kill:
    try:
        os.kill(int(p), signal.SIGKILL)
        print('killed', p, c)
    except Exception as e:
        print('skip', p, e)
time.sleep(2)
