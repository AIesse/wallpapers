# 壁纸精选小程序

典雅暗色 + 香槟金风格壁纸小程序。微信官方鉴权登录，GitHub JSON 文件作数据库，本地图片库经 Cloudflare 代理对外服务。

## 功能

- **分类浏览**：风景 / 城市 / 抽象 / 科技 / 动漫 / 极简，双列瀑布流 + 下拉刷新 + 触底加载
- **特色专区（多端壁纸）**：每张壁纸同时提供手机版（竖屏）与电脑版（横屏）双版本，列表可按设备筛选，详情页一键切换版本
- **积分体系**：每日签到 +1 分；下载壁纸 -1 分；新用户赠送 3 分；下载历史记录
- **微信官方鉴权**：`wx.login` → code → 后端 `code2Session` 换 openid，签发 token，全程静默
- **流量主**：「我的」页预留 banner 广告位，另预留激励视频广告入口

## 目录结构

```
wallpaper-app/
├── server/            # Node 后端（Express）
│   ├── index.js       # 全部接口 + GitHub JSON 数据库读写
│   ├── wallpapers/    # 本地壁纸图片库（Cloudflare 代理此目录）
│   └── .env.example
├── miniprogram/       # 微信小程序
│   ├── app.js         # 静默登录 / 请求封装 / 事件总线
│   ├── pages/index    # 首页：分类 + 瀑布流 + 特色专区设备筛选
│   ├── pages/detail   # 详情：预览 / 多端版本切换 / 扣分下载
│   └── pages/mine     # 我的：积分签到 / 下载历史 / 广告位
└── scripts/gen-icons.js  # tabBar 图标生成脚本
```

## 一、管理后台

访问 `https://wallpaper.example.com/admin`（与 API 同一服务），密码为环境变量 `ADMIN_PASSWORD`。

| 模块 | 功能 |
|---|---|
| 仪表盘 | 用户数 / 壁纸数 / 累计下载 / 今日签到 / 启用中公告 / 最近操作 |
| 壁纸管理 | 新增（上传手机版/电脑版图片）、编辑、删除（可选连同图片文件）、标题搜索、分类筛选 |
| 分类管理 | 增删改、排序；分类下有壁纸时禁止删除 |
| 消息公告 | 发布/编辑/启停；生效起止时间；弹出频次（仅一次 / 每日一次 / 每次启动）；小程序启动弹窗展示并支持跳转 |
| 用户管理 | 查看（openid 脱敏）、手动调整积分（必填原因，记录日志） |
| 下载记录 | 全量下载流水（含设备版本） |
| 操作日志 | 管理端全部写操作留痕（保留最近 500 条） |

边界处理：上传仅允许 jpg/png/webp、单文件 ≤ 15MB；文件名时间戳+随机串防碰撞；删除文件限定在 wallpapers 目录内防路径穿越；管理员 token 24 小时过期；所有数据写入沿用串行队列避免 GitHub 提交冲突。

## 二、GitHub JSON 数据库

1. 新建一个仓库（如 `yourname/wallpaper-db`），无需手工建文件，服务启动时会自动创建：
   - `db/users.json` — 用户（openid、积分、签到日期）
   - `db/categories.json` — 分类
   - `db/wallpapers.json` — 壁纸元数据
   - `db/downloads.json` — 下载记录
2. 生成具有该仓库读写权限的 Personal Access Token（Fine-granted，Contents: Read & Write）。
3. 可选加速：用 Cloudflare Worker 反代 `api.github.com`，把 `GH_API` 指向反代域名。

壁纸元数据格式（`db/wallpapers.json`）：

```json
[
  {
    "id": 1,
    "category": "featured",
    "title": "极光",
    "device": "both",
    "mobile_file": "featured/aurora-m.jpg",
    "desktop_file": "featured/aurora-d.jpg",
    "downloads": 0,
    "created_at": "2026-08-16"
  }
]
```

`device`：`mobile` / `desktop` / `both`（特色专区建议用 both）。图片文件放到 `server/wallpapers/` 对应路径（如 `server/wallpapers/featured/aurora-m.jpg`）。

## 二、后端部署

```bash
cd server
cp .env.example .env   # 填入 WX_APPID / WX_SECRET / GH_* / CDN_BASE
npm install
npm start              # 默认 3000 端口
```

Cloudflare 侧：将你的域名（如 `wallpaper.example.com`）A/CNAME 指向服务器，开启橙色云代理；SSL/TLS 设为「完全」。`CDN_BASE` 填 `https://wallpaper.example.com`。

## 三、小程序配置

1. 微信开发者工具导入 `wallpaper-app/`，填入你的 AppID（`project.config.json`）。
2. `miniprogram/app.js` 的 `globalData.baseURL` 改为后端域名。
3. 小程序后台「开发管理 → 服务器域名」把域名加入 `request 合法域名` 和 `downloadFile 合法域名`。
4. 流量主：后台开通后在 `pages/mine/mine.js` 填入 `AD_UNIT_BANNER` / `AD_UNIT_REWARDED`。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/login | 微信 code 登录，返回 token |
| GET | /api/user/info | 积分 / 签到状态 |
| POST | /api/checkin | 每日签到 +1 分 |
| GET | /api/categories | 分类列表 |
| GET | /api/wallpapers?category=&device=&page= | 壁纸分页（device 仅特色专区用） |
| GET | /api/wallpapers/:id | 壁纸详情（含手机/电脑双版本地址） |
| POST | /api/wallpapers/:id/download | 下载扣 1 分，返回文件地址 |
| GET | /api/user/downloads | 下载历史 |
