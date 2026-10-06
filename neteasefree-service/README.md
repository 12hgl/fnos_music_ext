# musicbox-service

网易云音源（默认 `127.0.0.1:8770`），对外暴露稳定的 `/api/v1/*` 契约，供 fnmusic-ext 代理调用。

数据来自兼容 [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 协议的 HTTP 后端
（默认 `https://zm.wwoyun.cn`，可用 `.env` 的 `FNMUSIC_NETEASE_API_BASE` 覆盖）。后端自带服务端登录态，
免扫码即可解析 VIP 直链，因此无需用户级扫码登录。

本地运行：

```bash
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8770
```