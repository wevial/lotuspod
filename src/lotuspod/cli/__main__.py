"""Entry point for ``python -m lotuspod.cli``, as before cli.py became a package."""

from lotuspod.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
