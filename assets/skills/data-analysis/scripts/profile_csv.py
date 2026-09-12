"""Stream CSV counts and numeric summaries; treat empty fields as missing.
Original AelionBot helper, MIT; see AELION-LICENSE.txt.
"""
import argparse
import csv
from decimal import Decimal, InvalidOperation, localcontext
import json
from pathlib import Path

def profile(source):
    source = Path(source).resolve(strict=True)
    with source.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.reader(stream)
        headers = next(reader, None)
        if not headers:
            raise ValueError('CSV has no header')
        columns = [dict(name=name, missing=0, numeric=0, nonnumeric=0, minimum=None, maximum=None, total=Decimal(0)) for name in headers]
        count = malformed = 0
        with localcontext() as context:
            context.prec = 50
            for row in reader:
                count += 1
                if len(row) != len(headers):
                    malformed += 1
                for i, column in enumerate(columns):
                    value = row[i].strip() if i < len(row) else ''
                    if not value:
                        column['missing'] += 1
                        continue
                    try:
                        number = Decimal(value)
                        if not number.is_finite() or abs(number.adjusted()) > 300 or len(number.as_tuple().digits) > 40:
                            raise InvalidOperation
                    except InvalidOperation:
                        column['nonnumeric'] += 1
                        continue
                    column['numeric'] += 1
                    column['minimum'] = number if column['minimum'] is None else min(column['minimum'], number)
                    column['maximum'] = number if column['maximum'] is None else max(column['maximum'], number)
                    column['total'] += number
            for column in columns:
                column['mean'] = column['total'] / column['numeric'] if column['numeric'] else None
                for key in ['minimum', 'maximum', 'total', 'mean']:
                    column[key] = str(column[key]) if column[key] is not None else None
    return {'source': str(source), 'rows': count, 'malformedRows': malformed, 'columns': columns,
            'note': 'Numeric-looking values may be identifiers; missing means an empty/whitespace field. Extra fields in malformed rows are not profiled.'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = profile(args.input)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x', encoding='utf8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    print(json.dumps({'path': str(output.resolve()), 'rows': result['rows'], 'malformedRows': result['malformedRows']}))
