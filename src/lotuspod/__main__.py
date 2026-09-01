"""Entry point for ``python -m lotuspod`` (mirrors the ``lotuspod`` console script)."""

from lotuspod.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
