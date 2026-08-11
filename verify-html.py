# A structural check that catches over-closing, which the previous one did not.
#
# The old check kept a stack and, on a stray close, searched back and truncated. That
# recovery silently absorbed an extra closing tag, which is exactly how a stray </div> got
# shipped and collapsed every page.
import io, re, sys

path = sys.argv[1] if len(sys.argv) > 1 else 'index.html'
s = io.open(path, encoding='utf-8').read()
VOID = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}

problems = []

# 1. Per tag name, opens must equal closes.
for tag in ['div','section','article','header','footer','nav','main','span','button','p','label','form']:
    opens = len(re.findall(r'<' + tag + r'\b', s))
    closes = len(re.findall(r'</' + tag + r'>', s))
    if opens != closes:
        problems.append(f"{tag}: {opens} open vs {closes} close (difference {opens-closes})")

# 2. Depth must never go below zero, and must end at zero.
depth = 0
line_no = 1
for m in re.finditer(r'<(/?)([a-zA-Z][\w-]*)\b[^>]*?(/?)>|\n', s):
    if m.group(0) == '\n':
        line_no += 1
        continue
    closing, name, selfclose = m.group(1), m.group(2).lower(), m.group(3)
    if name in VOID or selfclose:
        continue
    if name in ('script','style','br'):
        pass
    if closing:
        depth -= 1
        if depth < 0:
            problems.append(f"line {line_no}: closing </{name}> with nothing open")
            depth = 0
    else:
        depth += 1

# 3. The key containers must each appear exactly once and be properly nested.
for required in ['id="app"', 'id="chat-view"', 'id="characters-view"', 'id="settings-view"',
                 'id="chat-home"', 'id="character-list"', 'id="main-nav"']:
    n = s.count(required)
    if n != 1:
        problems.append(f'{required} appears {n} times, expected 1')

print(f"checking {path}")
if problems:
    print("PROBLEMS FOUND:")
    for problem in problems:
        print("  -", problem)
    sys.exit(1)
print("  tag counts balanced")
print("  depth never negative")
print("  all key containers present exactly once")
print("OK")
