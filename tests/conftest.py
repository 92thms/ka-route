import sys
from pathlib import Path

# Keep imports identical for `pytest` and `python -m pytest` in local runs and CI.
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT))
sys.path.insert(0, str(REPOSITORY_ROOT / "api"))
