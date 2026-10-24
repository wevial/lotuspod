"""Comments: the comment boxes a page's sections end with (comments.py), with
the comments panel's islands, the review sheet, attachments, the narrow-window
views and the panel's resize in ts/ and theme/."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "BOX_CLASS": "comments",
    "MIN_SECTIONS": "comments",
    "PAGE_SECTION": "comments",
    "WHOLE_PAGE": "comments",
    "_SectionFinder": "comments",
    "box": "comments",
    "read_boxes": "comments",
    "render_comments": "comments",
    "whole_page_box": "comments",
})
