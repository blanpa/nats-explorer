#!/usr/bin/env bash
# Checks the sources of the documentation site under docs/ without building it:
# front matter, unique nav_order, every {% link %} target, every local image and
# every in-page anchor. Jekyll reports a missing {% link %} target but happily
# ships a broken image or a stale #anchor, and the Pages build only runs after a
# push -- this runs anywhere python3 does. Usage: scripts/check-docs.sh [docs-dir]
set -euo pipefail
DIR="${1:-docs}"
[ -d "$DIR" ] || { echo "no such directory: $DIR" >&2; exit 1; }
exec python3 - "$DIR" <<'PY'
import os, re, sys, glob

root = sys.argv[1]
errors = []
pages = {}           # filename -> {title, nav_order, anchors, text}


def slug(heading):
    # kramdown's auto-generated ids: lowercase, non-word characters dropped,
    # spaces to hyphens.
    s = heading.strip().lower()
    s = re.sub(r'`|\*|\[|\]|\(|\)|<[^>]*>', '', s)
    s = re.sub(r'[^\w\s-]', '', s)
    return re.sub(r'\s+', '-', s).strip('-')


for path in sorted(glob.glob(os.path.join(root, '*.md')) +
                   glob.glob(os.path.join(root, '*.html'))):
    name = os.path.basename(path)
    text = open(path, encoding='utf-8').read()
    if not text.startswith('---\n'):
        errors.append(f'{name}: no front matter')
        continue
    fm, _, body = text[4:].partition('\n---\n')
    meta = dict(re.findall(r'^([a-z_]+):\s*(.+)$', fm, re.M))
    if 'title' not in meta:
        errors.append(f'{name}: front matter without a title')
    if 'layout' not in meta:
        errors.append(f'{name}: front matter without a layout')
    anchors = {slug(h) for h in re.findall(r'^#{1,6}\s+(.+?)\s*$', body, re.M)}
    anchors |= set(re.findall(r'id="([^"]+)"', body))
    pages[name] = {'meta': meta, 'anchors': anchors, 'body': body}

# nav_order collisions put pages in an arbitrary order in the sidebar.
orders = {}
for name, page in pages.items():
    order = page['meta'].get('nav_order')
    if order is not None:
        orders.setdefault(order, []).append(name)
for order, names in sorted(orders.items()):
    if len(names) > 1:
        errors.append(f'nav_order {order} used by {", ".join(sorted(names))}')

for name, page in pages.items():
    body = page['body']

    # {% link target.md %}
    for target in re.findall(r'{%\s*link\s+([^\s%]+)\s*%}', body):
        if not os.path.exists(os.path.join(root, target)):
            errors.append(f'{name}: {{% link {target} %}} has no target')

    # {{ '/path' | relative_url }} in an src/href, and plain relative images
    for asset in re.findall(r"{{\s*'(/[^']+)'\s*\|\s*relative_url\s*}}", body):
        if not os.path.exists(os.path.join(root, asset.lstrip('/'))):
            errors.append(f'{name}: asset {asset} does not exist')
    for src in re.findall(r'!\[[^\]]*\]\(([^)\s]+)\)', body) + \
               re.findall(r'<img[^>]+src="([^"{]+)"', body):
        if src.startswith(('http', '//', '{')):
            continue
        if not os.path.exists(os.path.join(root, src.lstrip('/'))):
            errors.append(f'{name}: image {src} does not exist')

    # #anchor, on this page and via {% link other.md %}#anchor
    for anchor in re.findall(r'\]\(#([^)]+)\)', body):
        if anchor not in page['anchors']:
            errors.append(f'{name}: #{anchor} matches no heading on this page')
    for target, anchor in re.findall(
            r'{%\s*link\s+([^\s%]+)\s*%}\)?#([\w-]+)', body):
        other = pages.get(target)
        if other and anchor not in other['anchors']:
            errors.append(f'{name}: #{anchor} matches no heading in {target}')

if errors:
    print('docs check failed:')
    for e in sorted(errors):
        print('  ' + e)
    sys.exit(1)
print(f'docs check: {len(pages)} pages, front matter, links, images and anchors ok')
PY
