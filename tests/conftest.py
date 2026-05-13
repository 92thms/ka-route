import sys
from pathlib import Path

# Ensure the api/ directory is on sys.path so that `import scraper_http`
# inside api/main.py resolves when tests are run from the project root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
