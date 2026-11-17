"""Build the store ZIP from tracked launcher source plus the original bundled artwork."""
import argparse
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/downloads/CMMTools_Video_Studio_Launcher_v1.5.zip'
EXTENSION = ROOT / 'scripts/video-studio-launcher/extension'
VERSION = json.loads((EXTENSION / 'manifest.json').read_text())['version']
DEFAULT_OUTPUT = ROOT / f'public/downloads/CMMTools_Video_Studio_Chrome_Store_v{VERSION}.zip'


def build(output):
    # Keep the original logo bytes without duplicating binary artwork in source.
    with zipfile.ZipFile(SOURCE) as source:
        files = {name.removeprefix('extension/'): source.read(name)
                 for name in source.namelist()
                 if name.startswith('extension/brand/') and not name.endswith('/')}
    for file in EXTENSION.rglob('*'):
        if file.is_file() and file.suffix in ('.html', '.css', '.js', '.json'):
            files[file.relative_to(EXTENSION).as_posix()] = file.read_bytes()
    assert 'manifest.json' in files and 'background.js' in files
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 17, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    build(parser.parse_args().output)
