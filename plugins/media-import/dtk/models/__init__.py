"""Vendored subset of the DTK protocol core (Apache-2.0).

Only the modules the Vectrail link importer needs are shipped; package
initialisers are trimmed so importing a submodule does not drag in the full
service stack (FastAPI, Redis, SQLAlchemy, ...).
"""

from dtk.models.content import (
    AlbumImage,
    Author,
    AuthorStats,
    Collection,
    Comment,
    Content,
    ContentPart,
    ContentStats,
    Hashtag,
    Image,
    LiveRoom,
    LiveStatus,
    LiveStream,
    LiveViewer,
    Media,
    MediaAccess,
    Mix,
    Music,
    MusicDetail,
    Page,
    TrendingTopic,
    VideoStream,
)

__all__ = [
    "AlbumImage",
    "Author",
    "AuthorStats",
    "Collection",
    "Comment",
    "Content",
    "ContentPart",
    "ContentStats",
    "Hashtag",
    "Image",
    "LiveRoom",
    "LiveStatus",
    "LiveStream",
    "LiveViewer",
    "Media",
    "MediaAccess",
    "Mix",
    "Music",
    "MusicDetail",
    "Page",
    "TrendingTopic",
    "VideoStream",
]
