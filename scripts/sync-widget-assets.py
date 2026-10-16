"""Generate the Apps Script engine from the exact browser source. Run from any cwd.
Use --check in CI/tests to reject stale copies. No dependencies required.
"""
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
source = root / 'recommendation.js'
target = root / 'apps-script' / 'Recommendation.gs'
expected = '// GENERATED from recommendation.js. Do not edit; run python3 scripts/sync-widget-assets.py.\n' + source.read_text()
if '--check' in sys.argv:
    if not target.exists() or target.read_text() != expected:
        raise SystemExit('Recommendation.gs is stale; run python3 scripts/sync-widget-assets.py')
else:
    target.write_text(expected)
    print('Updated apps-script/Recommendation.gs')
