"""歌单本地化：本地曲库索引与 (歌名, 歌手) 匹配的离线单测。

不依赖在线音源：直接建一个最小只读飞牛曲库 sqlite，验证
read_local_library_rows / _build_local_match_index / _pick_local_match。
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import proxy.recommend as recommend  # noqa: E402


def _make_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE track (
            id INTEGER PRIMARY KEY, guid TEXT, title TEXT, year INTEGER,
            disc_no INTEGER, track_no INTEGER, isrc TEXT, duration_ms INTEGER,
            is_cue INTEGER, cover_guid TEXT, audio_file_id INTEGER, album_id INTEGER,
            is_audio_file_deleted INTEGER DEFAULT 0, is_admin_deleted INTEGER DEFAULT 0
        );
        CREATE TABLE audio_file (
            id INTEGER PRIMARY KEY, path TEXT, suffix TEXT, size INTEGER,
            bitrate INTEGER, sample_rate INTEGER, bit_depth INTEGER, channel INTEGER,
            container TEXT, codec TEXT, is_physical_file_deleted INTEGER DEFAULT 0
        );
        CREATE TABLE artist (id INTEGER PRIMARY KEY, name TEXT, guid TEXT);
        CREATE TABLE track_artist (track_id INTEGER, artist_id INTEGER);
        CREATE TABLE album (id INTEGER PRIMARY KEY, guid TEXT, name TEXT, release_date TEXT);

        INSERT INTO audio_file VALUES (1,'/music/a.flac','flac',1000,900,44100,16,2,'flac','flac',0);
        INSERT INTO audio_file VALUES (2,'/music/b.mp3','mp3',800,320,44100,0,2,'mp3','mp3',0);
        INSERT INTO audio_file VALUES (3,'/music/gone.flac','flac',900,900,44100,16,2,'flac','flac',1);
        INSERT INTO artist VALUES (1,'周杰伦','ag1'),(2,'A-Lin','ag2');
        INSERT INTO album VALUES (1,'al1','叶惠美','2003-01-01');
        INSERT INTO track VALUES (1,'t1','晴天',2003,1,1,'ISRC1',269000,0,'c1',1,1,0,0);
        INSERT INTO track VALUES (2,'t2','给我一个理由忘记',2010,1,1,'ISRC2',260000,0,'c2',2,1,0,0);
        -- 物理文件已删除的曲目不应进入本地索引
        INSERT INTO track VALUES (3,'t3','消失的歌',2020,1,1,'ISRC3',200000,0,'c3',3,1,0,0);
        INSERT INTO track_artist VALUES (1,1),(2,2),(3,2);
        """
    )
    con.commit()
    con.close()


def test_read_local_library_rows_skips_deleted(tmp_path):
    db = tmp_path / "music.db"
    _make_db(db)
    rows = recommend.read_local_library_rows(str(db))
    guids = {r["guid"] for r in rows}
    assert guids == {"t1", "t2"}  # 物理文件已删除的 t3 被排除
    qing = next(r for r in rows if r["guid"] == "t1")
    assert qing["title"] == "晴天"
    assert qing["artist"] == "周杰伦"
    assert qing["path"] == "/music/a.flac"
    assert qing["source"] == "local"


def test_local_match_index_hits_by_title_and_artist(tmp_path):
    db = tmp_path / "music.db"
    _make_db(db)
    index = recommend.local_match_index(str(db))
    hit = recommend._pick_local_match(index, "晴天", "周杰伦")
    assert hit is not None and hit["guid"] == "t1"
    # 歌名命中但歌手不符 → 不采用
    assert recommend._pick_local_match(index, "晴天", "林俊杰") is None
    # 多歌手分隔写法也能命中
    assert recommend._pick_local_match(index, "给我一个理由忘记", "A-Lin/彭佳慧") is not None
    # 库中不存在
    assert recommend._pick_local_match(index, "不存在的歌", "谁") is None


def test_local_match_index_cached_by_mtime(tmp_path):
    db = tmp_path / "music.db"
    _make_db(db)
    first = recommend.local_match_index(str(db))
    second = recommend.local_match_index(str(db))
    assert first is second  # mtime 未变 → 复用同一索引对象


def test_resolve_recommendations_accepts_local_params():
    import inspect

    sig = inspect.signature(recommend.resolve_recommendations)
    assert "db_path" in sig.parameters
    assert "user_guid" in sig.parameters


def test_custom_playlists_dir_prefers_explicit_env(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    monkeypatch.setenv("FNMUSIC_CUSTOM_PLAYLIST_DIR", str(tmp_path / "explicit"))
    assert recommend.custom_playlists_dir() == str(tmp_path / "explicit")


def test_custom_playlists_dir_falls_back_to_xdg(monkeypatch, tmp_path):
    """容器内 home_dir() 为只读 /srv；有 XDG_DATA_HOME 时必须落在其下（可写）。"""
    monkeypatch.delenv("FNMUSIC_CUSTOM_PLAYLIST_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    assert recommend.custom_playlists_dir() == str(tmp_path / "data" / "custom_playlists")


def test_custom_playlists_dir_without_xdg_uses_home(monkeypatch, tmp_path):
    monkeypatch.delenv("FNMUSIC_CUSTOM_PLAYLIST_DIR", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setenv("FNMUSIC_HOME", str(tmp_path / "home"))
    assert recommend.custom_playlists_dir() == str(tmp_path / "home" / "custom_playlists")