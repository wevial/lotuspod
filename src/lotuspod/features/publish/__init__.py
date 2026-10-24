"""Publishing: a page rendered from the template (render.py, with its
markdown, images and sections in markdown.py, media.py and sections.py), the
manifest (manifest.py) and publish, here or over ssh (publish.py and
publish_sources.py), with `lotuspod render`, `lotuspod manifest` and
`lotuspod publish` in commands.py."""

from lotuspod.features import public_edge
from lotuspod.features.publish.manifest import cmd_manifest

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "images": "markdown",
    "to_body": "markdown",
    "CONTENT_TYPES": "media",
    "DEFAULT_MAX_BYTES": "media",
    "EXTENSIONS": "media",
    "MEDIA_DIR_NAME": "media",
    "MediaError": "media",
    "STORED_NAME": "media",
    "URL_PREFIX": "media",
    "check": "media",
    "load_stored": "media",
    "media_dir": "media",
    "named_type": "media",
    "store": "media",
    "stored_file": "media",
    "_PAGE_NAME": "publish",
    "cmd_publish": "publish",
    "media_cap": "publish_sources",
    "_H2Collector": "render",
    "kept_block_hashes": "render",
    "page_owner": "render",
    "version_stamp": "render",
})
