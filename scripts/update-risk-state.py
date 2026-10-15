#!/usr/bin/env python3
"""Update the 'État' column of docs/RISK_MATRIX.md from a {ID: 'text'} mapping given as JSON on argv[1] (file)."""
import json, sys, re
states = json.load(open(sys.argv[1]))
p = 'docs/RISK_MATRIX.md'
out = []
for line in open(p, encoding='utf8'):
    m = re.match(r'\| ([ZETANSQO]\d\d) \|', line)
    if m and m.group(1) in states:
        cells = line.rstrip('\n').strip('|').split('|')
        cells[-1] = ' ' + states[m.group(1)] + ' '
        line = '|' + '|'.join(cells) + '|\n'
    out.append(line)
open(p, 'w', encoding='utf8').write(''.join(out))
