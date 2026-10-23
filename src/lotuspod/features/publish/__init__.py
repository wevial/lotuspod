"""Publishing: a page rendered from the template (render.py, with its
markdown, images and sections in markdown.py, media.py and sections.py), the
manifest (manifest.py) and publish, here or over ssh (publish.py and
publish_sources.py), with `lotuspod render`, `lotuspod manifest` and
`lotuspod publish` in commands.py."""

from lotuspod.features.publish.manifest import cmd_manifest
