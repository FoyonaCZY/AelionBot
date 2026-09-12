"""Export office documents with a disposable LibreOffice profile; never overwrite.
Original AelionBot helper, MIT; see AELION-LICENSE.txt.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

FILTERS = {'pdf': 'pdf', 'docx': 'docx:Office Open XML Text',
           'xlsx': 'xlsx:Calc MS Excel 2007 XML', 'pptx': 'pptx:Impress MS PowerPoint 2007 XML',
           'odt': 'odt', 'ods': 'ods', 'odp': 'odp'}

def export(source, output_dir, fmt, executable=None, timeout=90):
    source, output_dir = Path(source).resolve(strict=True), Path(output_dir).resolve()
    if not source.is_file():
        raise ValueError('Input must be a file')
    if fmt not in FILTERS:
        raise ValueError('Unsupported output format')
    executable = executable or shutil.which('libreoffice') or shutil.which('soffice')
    if not executable:
        raise RuntimeError('LibreOffice is unavailable; use the installed office app or check the work computer setup')
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / (source.stem + '.' + fmt)
    if target.exists():
        raise FileExistsError(f'Refusing to overwrite {target}; choose a new output directory')
    with tempfile.TemporaryDirectory(prefix='aelion-office-') as temp:
        temp = Path(temp)
        converted = temp / 'converted'
        converted.mkdir()
        profile = (temp / 'profile').as_uri()
        command = [executable, '-env:UserInstallation=' + profile, '--headless', '--nologo',
                   '--nodefault', '--nofirststartwizard', '--convert-to', FILTERS[fmt],
                   '--outdir', str(converted), str(source)]
        result = subprocess.run(command, capture_output=True, text=True, errors='replace', timeout=timeout)
        generated = converted / target.name
        if result.returncode != 0 or not generated.is_file() or generated.stat().st_size == 0:
            raise RuntimeError('LibreOffice export failed: ' + (result.stderr or result.stdout)[-2000:])
        # Exclusive creation also protects against another task writing the destination during conversion.
        with target.open('xb') as dest, generated.open('rb') as src:
            shutil.copyfileobj(src, dest)
    return {'path': str(target), 'bytes': target.stat().st_size, 'format': fmt}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--format', choices=FILTERS, default='pdf')
    parser.add_argument('--soffice', help='Optional absolute path to the LibreOffice executable')
    parser.add_argument('--timeout', type=int, default=90)
    args = parser.parse_args()
    if args.timeout < 1 or args.timeout > 110:
        parser.error('--timeout must be between 1 and 110 seconds')
    print(json.dumps(export(args.input, args.out_dir, args.format, args.soffice, args.timeout)))

if __name__ == '__main__':
    main()
