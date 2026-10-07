#!/usr/bin/env python3
"""
Stamp a version on every asset so phones cannot serve a stale app.

iOS keeps js and css even when the html is re-fetched, which leaves a phone
running last week's code against this week's page. Adding ?v=<stamp> to every
reference makes the URL change, so the cache has nothing to reuse.

Run before each commit:  python3 stamp.py
"""
import re, subprocess, pathlib, datetime

HERE = pathlib.Path(__file__).parent
try:
    n = subprocess.run(['git', 'rev-list', '--count', 'HEAD'],
                       cwd=HERE, capture_output=True, text=True).stdout.strip()
    stamp = f"{int(n) + 1}"
except Exception:
    stamp = datetime.datetime.now().strftime('%m%d%H%M')

idx = (HERE / 'index.html').read_text()
idx = re.sub(r'href="style\.css(\?v=[^"]*)?"', f'href="style.css?v={stamp}"', idx)
idx = re.sub(r'src="app\.js(\?v=[^"]*)?"',     f'src="app.js?v={stamp}"',     idx)
(HERE / 'index.html').write_text(idx)

app = (HERE / 'app.js').read_text()
for mod in ('firebase-config.js', 'cases.js', 'crypto.js'):
    app = re.sub(rf"from '\./{re.escape(mod)}(\?v=[^']*)?'",
                 f"from './{mod}?v={stamp}'", app)
(HERE / 'app.js').write_text(app)

print(f"stamped v={stamp}")
