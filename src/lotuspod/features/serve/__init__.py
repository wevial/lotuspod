"""Serve: the allow-list of what serve answers (serve_files.py), its HTTP
handler (handler.py, over the pages pages.py reads), the /api routes
(api.py, a reaction's in reactions.py) behind Cloudflare Access
(access.py), with `lotuspod serve` in commands.py."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "MAX_BODY": "api",
    "MAX_IMAGES": "api",
    "MAX_NAME": "api",
    "MAX_TEXT": "api",
    "UPLOAD_TYPES": "api",
    "Answer": "api",
    "Body": "api",
    "Page": "api",
    "Refusal": "api",
    "_image_names": "api",
    "_json_object": "api",
    "_keys": "api",
    "_media_type": "api",
    "_text": "api",
    "asked_question": "api",
    "changes": "api",
    "chosen": "api",
    "stored_images": "api",
    "summary": "api",
    "checked_emoji": "reactions",
    "emoji_table": "reactions",
    "serve_allow_list": "serve_files",
    "serve_database": "serve_files",
    "serve_db_path": "serve_files",
})
