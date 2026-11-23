#!/usr/bin/env python3
"""Build Lambda Python 3.12 ZIP + WeasyPrint native library layer on AL2023.

Runs inside AWS CodeBuild's Amazon Linux 2023 environment. Never uses Docker,
ECR, or user journal records. A PDF smoke test must pass before artifacts upload.
"""
import ctypes.util
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = Path.cwd()
BUILD = ROOT / 'build'
LAYER = BUILD / 'layer'
LIB = LAYER / 'lib'
PY = LAYER / 'python'
FONTS = LAYER / 'share' / 'fonts'
CONFIG = LAYER / 'etc' / 'fonts'
MAX_UNZIPPED_BYTES = 250 * 1024 * 1024
SKIP = re.compile(r'^(?:libc\.so|libm\.so|libpthread\.so|libdl\.so|librt\.so|libresolv\.so|libutil\.so|libanl\.so|ld-linux|linux-vdso)')
SEEDS = ('pango-1.0', 'pangocairo-1.0', 'pangoft2-1.0', 'cairo',
         'gdk_pixbuf-2.0', 'gobject-2.0', 'glib-2.0', 'gmodule-2.0',
         'gio-2.0', 'harfbuzz', 'fontconfig', 'freetype', 'ffi')


def command(*args, env=None):
    subprocess.run(args, check=True, env=env)


def capture(*args):
    return subprocess.check_output(args, text=True)


def system_libraries():
    """Map installed sonames to paths, including transitive dependencies."""
    result = {}
    for line in capture('ldconfig', '-p').splitlines():
        match = re.match(r'\s*(\S+)\s+\([^)]*\)\s+=>\s+(\S+)', line)
        if match:
            result.setdefault(match.group(1), Path(match.group(2)))
    return result


def dependencies(path):
    output = capture('ldd', str(path))
    missing = re.findall(r'^\s*(\S+)\s+=>\s+not found', output, re.MULTILINE)
    if missing:
        raise RuntimeError(f'Missing native dependencies for {path}: {missing}')
    for line in output.splitlines():
        m = re.match(r'^\s*(\S+)\s+=>\s+(/\S+)', line)
        if m:
            yield m.group(1), Path(m.group(2))


def copy_native_closure():
    libs = system_libraries()
    queue = []
    for stem in SEEDS:
        soname = ctypes.util.find_library(stem)
        if not soname or soname not in libs:
            raise RuntimeError(f'Native library missing: {stem} (expected Pango/Cairo/Fontconfig prerequisites)')
        queue.append((soname, libs[soname]))
    # Wheel extensions may also require system libraries not listed in SEEDS.
    for extension in PY.rglob('*.so'):
        queue.extend(dependencies(extension))
    seen = set()
    while queue:
        soname, source = queue.pop()
        if soname in seen or SKIP.match(soname):
            continue
        if not source.is_file():
            raise RuntimeError(f'Cannot locate required native library: {soname} ({source})')
        seen.add(soname)
        shutil.copyfile(source, LIB / soname)
        queue.extend(dependencies(source))
    print(f'Bundled {len(seen)} native shared libraries')
    return len(seen)


def zip_directory(source, destination):
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path in sorted(source.rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
                z.write(path, path.relative_to(source).as_posix())


def main():
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError(f'This layer must be built with Python 3.12, got {sys.version}')
    if os.uname().machine != 'x86_64':
        raise RuntimeError('The renderer Lambda is x86_64; layer architecture must match')
    BUILD.mkdir(exist_ok=True)
    LIB.mkdir(parents=True, exist_ok=True)
    PY.mkdir(parents=True, exist_ok=True)
    FONTS.mkdir(parents=True, exist_ok=True)
    CONFIG.mkdir(parents=True, exist_ok=True)

    command(sys.executable, '-m', 'pip', 'install', '--no-cache-dir', '--only-binary=:all:',
            '--target', str(PY), 'weasyprint==70.0', 'boto3==1.42.0', 'Pillow>=11,<13')
    native_count = copy_native_closure()
    originals = list(Path('/usr/share/fonts').rglob('DejaVu*.ttf'))
    if not originals:
        raise RuntimeError('DejaVu fonts are missing; PDF glyph/layout would be inconsistent')
    for font in originals:
        shutil.copyfile(font, FONTS / font.name)
    (CONFIG / 'fonts.conf').write_text('''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/opt/share/fonts</dir>
  <cachedir>/tmp/fontconfig-cache</cachedir>
</fontconfig>
''', encoding='utf-8')
    total = sum(p.stat().st_size for p in LAYER.rglob('*') if p.is_file())
    if total >= MAX_UNZIPPED_BYTES - 2 * 1024 * 1024:
        raise RuntimeError(f'Lambda unzipped ZIP + layer must stay below 250 MiB; layer is {total/1024**2:.1f} MiB')

    # Verify Python imports, fonts and native text rendering using the packaged libs.
    # CodeBuild's staging directory is not /opt; point the smoke test at the
    # staged fonts, while packaging the production config for Lambda /opt.
    smoke_config = BUILD / 'fontconfig-smoke.conf'
    smoke_config.write_text(
        '<?xml version="1.0"?><fontconfig><dir>' + str(FONTS) +
        '</dir><cachedir>' + str(BUILD / 'font-cache') + '</cachedir></fontconfig>',
        encoding='utf-8')
    env = dict(os.environ)
    env.update(PYTHONPATH=str(PY), LD_LIBRARY_PATH=f'{LIB}:' + env.get('LD_LIBRARY_PATH', ''),
               FONTCONFIG_PATH=str(BUILD), FONTCONFIG_FILE=str(smoke_config),
               XDG_CACHE_HOME=str(BUILD / 'font-cache'))
    matched_font = subprocess.check_output(
        ['fc-match', '-f', '%{file}', 'DejaVu Serif'], text=True, env=env).strip()
    if not matched_font.startswith(str(FONTS)):
        raise RuntimeError('Fontconfig did not select the fonts bundled into the Lambda layer: ' + matched_font)
    print('Fontconfig bundled-font smoke test PASSED:', matched_font)
    command(sys.executable, '-c', '''from weasyprint import HTML
from PIL import Image
from io import BytesIO
png=BytesIO(); Image.new('RGB',(12,12),'red').save(png,format='PNG')
pdf=HTML(string='<html><body><h1>Reverie PDF test</h1><p>Unicode &amp; fonts</p></body></html>', base_url='.').write_pdf()
assert pdf[:5]==b'%PDF-' and len(pdf)>1000
print('WeasyPrint + Pillow bundled dependencies: PDF smoke test PASSED')''', env=env)

    renderer_root = BUILD / 'renderer'
    renderer_root.mkdir(exist_ok=True)
    for filename in ('memory_export_worker.py', 'journal_pages.py', 'memory-book-templates.json'):
        shutil.copyfile(ROOT / filename, renderer_root / filename)
    zip_directory(renderer_root, BUILD / 'renderer.zip')
    zip_directory(LAYER, BUILD / 'layer.zip')
    manifest = dict(python='3.12', architecture='x86_64', weasyprint='70.0',
                    layer_size_uncompressed=total, bundled_libraries=native_count,
                    bundled_fonts=len(originals),
                    renderer_sha256=hashlib.sha256((BUILD / 'renderer.zip').read_bytes()).hexdigest(),
                    layer_sha256=hashlib.sha256((BUILD / 'layer.zip').read_bytes()).hexdigest())
    (BUILD / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
