"""Build the store-upload ZIP from the committed launcher release. Python 3 stdlib only."""
import argparse
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/downloads/CMMTools_Video_Studio_Launcher_v1.5.zip'
DEFAULT_OUTPUT = ROOT / 'public/downloads/CMMTools_Video_Studio_Chrome_Store_v1.5.1.zip'


def build(output):
    with zipfile.ZipFile(SOURCE) as source:
        files = {name.removeprefix('extension/'): source.read(name)
                 for name in source.namelist()
                 if name.startswith('extension/') and not name.endswith('/')}
    manifest = json.loads(files['manifest.json'])
    manifest['version'] = '1.5.1'
    manifest['description'] = 'Open AIVID in a separate studio window with configurable CMMTools display preferences. Uses your own AIVID account.'
    manifest['homepage_url'] = 'https://cmmtools.site/extension'
    manifest['externally_connectable'] = {'matches': ['https://cmmtools.site/*', 'https://www.cmmtools.site/*']}
    files['manifest.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    files['options.html'] = files['options.html'].replace(
        b'Change <code>https://cmmtools.example/*</code> to your real CMMTools domain in <code>manifest.json</code>, then reload the extension. Use the ID in the supplied integration snippet.',
        b'CMMTools website launching is enabled for cmmtools.site. Your installed extension ID is shown above.')
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
