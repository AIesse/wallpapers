/**
 * 壁纸小程序后端
 * - 数据库：GitHub 仓库中的 JSON 文件（db/*.json），通过 GitHub Contents API 读写，
 *   也可将 api.github.com 配置 Cloudflare Worker 反代以加速。
 * - 图片：本地 wallpapers/ 目录静态托管，由 Cloudflare 代理对外。
 * - 特色专区：wallpaper.device = 'mobile' | 'desktop' | 'both'，
 *   同一张壁纸提供 mobile_file / desktop_file 两个版本。
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CDN_BASE = process.env.CDN_BASE || 'http://127.0.0.1:3000';
const APPID = process.env.WX_APPID || '';
const APP_SECRET = process.env.WX_SECRET || '';
// GitHub JSON 数据库配置
const GH_API = process.env.GH_API || 'https://api.github.com'; // 可替换为 Cloudflare 反代地址
const GH_REPO = process.env.GH_REPO || 'owner/wallpaper-db';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_TOKEN = process.env.GH_TOKEN || '';
// 管理后台
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // 务必修改

// ---------------- GitHub JSON 数据库 ----------------
const headers = {
  'Authorization': `Bearer ${GH_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'wallpaper-server',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function ghGet(file) {
  try {
    const r = await fetch(`${GH_API}/repos/${GH_REPO}/contents/db/${file}?ref=${GH_BRANCH}`, { headers });
    if (r.status === 404) return { sha: null, content: null };
    if (!r.ok) { console.warn(`ghGet ${file}: ${r.status}，降级为空数据`); return { sha: null, content: null }; }
    const j = await r.json();
    return { sha: j.sha, content: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
  } catch (e) { // 网络异常等：不抛出，避免打挂进程；数据降级为默认值
    console.warn(`ghGet ${file} network error: ${e.message}`);
    return { sha: null, content: null };
  }
}

async function ghPut(file, data, sha) {
  const body = {
    message: `db: update ${file} ${new Date().toISOString()}`,
    branch: GH_BRANCH,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
  };
  if (sha) body.sha = sha;
  try {
    const r = await fetch(`${GH_API}/repos/${GH_REPO}/contents/db/${file}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) { console.warn(`ghPut ${file}: ${r.status}（稍后写入会重试）`); return sha; }
    const j = await r.json().catch(() => ({}));
    return j.content ? j.content.sha : sha;
  } catch (e) {
    console.warn(`ghPut ${file} network error: ${e.message}`);
    return sha;
  }
}

// 内存缓存 + 写队列（避免并发提交冲突）
const cache = {};
let writeChain = Promise.resolve();
async function load(file, fallback) {
  if (cache[file]) return cache[file];
  const { sha, content } = await ghGet(file);
  const doc = { sha, data: content ?? fallback };
  cache[file] = doc;
  return doc;
}
function save(file, mutator) {
  // 修改内存数据并串行提交到 GitHub；失败时保留本地修改，下次提交带上 sha 重试
  writeChain = writeChain.then(async () => {
    const doc = cache[file] || (await load(file, []));
    mutator(doc.data);
    try { doc.sha = (await ghPut(file, doc.data, doc.sha)) || doc.sha; }
    catch (e) { console.error(`save ${file} failed:`, e.message); }
  });
  return writeChain;
}

// ---------------- 初始数据 ----------------
const DEFAULT_CATEGORIES = [
  { key: 'featured', name: '特色专区', sort: 0 },   // 多端壁纸专区：手机 + 电脑双版本
  { key: 'landscape', name: '风景', sort: 1 },
  { key: 'city', name: '城市', sort: 2 },
  { key: 'abstract', name: '抽象', sort: 3 },
  { key: 'tech', name: '科技', sort: 4 },
  { key: 'anime', name: '动漫', sort: 5 },
  { key: 'minimal', name: '极简', sort: 6 },
];
// 壁纸 JSON 结构示例：
// { id, category, title, device: 'mobile'|'desktop'|'both',
//   mobile_file: 'featured/aurora-m.jpg', desktop_file: 'featured/aurora-d.jpg',
//   downloads: 0, created_at }
const DEFAULT_WALLPAPERS = [];

// 全局兜底：任何未捕获的异步异常只记日志，不打挂服务
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException:', e && e.message));

// ---------------- 服务 ----------------
const app = express();
app.use(express.json({ limit: '30mb' })); // 壁纸以 base64 上传，需放宽体积
app.use('/wallpapers', express.static(path.join(__dirname, 'wallpapers'), { maxAge: '7d' }));

const tokens = new Map(); // token -> userId
function makeToken(userId) {
  const t = crypto.randomBytes(32).toString('hex');
  tokens.set(t, userId);
  return t;
}
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = tokens.get(t);
  if (!userId) return res.status(401).json({ code: 401, msg: '未登录' });
  req.userId = userId;
  next();
}
const today = () => new Date().toISOString().slice(0, 10);

// ---------- 登录（微信官方鉴权） ----------
app.post('/api/auth/login', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.json({ code: 400, msg: '缺少 code' });
  try {
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${APPID}&secret=${APP_SECRET}&js_code=${code}&grant_type=authorization_code`;
    const r = await fetch(url).then(r => r.json());
    if (!r.openid) return res.json({ code: 400, msg: '微信登录失败: ' + (r.errmsg || '') });
    const users = await load('users.json', []);
    let user = users.data.find(u => u.openid === r.openid);
    if (!user) {
      user = { id: users.data.reduce((m, u) => Math.max(m, u.id), 0) + 1, openid: r.openid, nickname: '', avatar: '', points: 3, last_checkin: '', created_at: today() };
      await save('users.json', d => d.push(user));
    }
    res.json({ code: 0, data: { token: makeToken(user.id), points: user.points, todayChecked: user.last_checkin === today() } });
  } catch (e) {
    console.error(e);
    res.json({ code: 500, msg: '登录服务异常' });
  }
});

// ---------- 用户信息 / 签到 ----------
app.get('/api/user/info', auth, async (req, res) => {
  const users = await load('users.json', []);
  const u = users.data.find(x => x.id === req.userId);
  if (!u) return res.status(401).json({ code: 401, msg: '用户不存在' });
  res.json({ code: 0, data: { points: u.points, nickname: u.nickname, avatar: u.avatar, todayChecked: u.last_checkin === today() } });
});

app.post('/api/checkin', auth, async (req, res) => {
  const users = await load('users.json', []);
  const u = users.data.find(x => x.id === req.userId);
  if (!u) return res.status(401).json({ code: 401, msg: '用户不存在' });
  if (u.last_checkin === today()) {
    return res.json({ code: 1, msg: '今日已签到', data: { points: u.points } });
  }
  u.last_checkin = today();
  u.points += 1;
  await save('users.json', () => {}); // 数据已在内存中修改，落库
  res.json({ code: 0, data: { points: u.points } });
});

// ---------- 分类 / 壁纸列表 ----------
app.get('/api/categories', async (req, res) => {
  const cats = await load('categories.json', DEFAULT_CATEGORIES);
  res.json({ code: 0, data: [...cats.data].sort((a, b) => a.sort - b.sort) });
});

app.get('/api/wallpapers', async (req, res) => {
  const { category = 'landscape', device = '', page = 1, size = 20 } = req.query;
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  let list = wp.data.filter(w => w.category === category);
  // 特色专区支持按设备筛选：mobile=手机版, desktop=电脑版
  if (device) list = list.filter(w => w.device === device || w.device === 'both');
  const start = (page - 1) * size;
  const pageList = list.slice(start, start + +size).map(w => ({
    id: w.id, title: w.title, device: w.device, downloads: w.downloads,
    // 列表缩略图优先手机版
    thumb: `${CDN_BASE}/wallpapers/${w.mobile_file || w.desktop_file}`,
    has_mobile: !!w.mobile_file, has_desktop: !!w.desktop_file,
  }));
  res.json({ code: 0, data: { list: pageList, hasMore: start + pageList.length < list.length } });
});

// ---------- 壁纸详情 ----------
app.get('/api/wallpapers/:id', async (req, res) => {
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  const w = wp.data.find(x => x.id === +req.params.id);
  if (!w) return res.json({ code: 404, msg: '壁纸不存在' });
  res.json({ code: 0, data: {
    id: w.id, title: w.title, category: w.category, device: w.device, downloads: w.downloads,
    mobile_url: w.mobile_file ? `${CDN_BASE}/wallpapers/${w.mobile_file}` : '',
    desktop_url: w.desktop_file ? `${CDN_BASE}/wallpapers/${w.desktop_file}` : '',
    has_mobile: !!w.mobile_file, has_desktop: !!w.desktop_file,
  } });
});

// ---------- 下载（扣 1 积分；特色专区可选设备版本） ----------
app.post('/api/wallpapers/:id/download', auth, async (req, res) => {
  const { device = 'mobile' } = req.body || {};
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  const users = await load('users.json', []);
  const w = wp.data.find(x => x.id === +req.params.id);
  const u = users.data.find(x => x.id === req.userId);
  if (!w || !u) return res.json({ code: 404, msg: '壁纸不存在' });

  const file = device === 'desktop' ? (w.desktop_file || w.mobile_file) : (w.mobile_file || w.desktop_file);
  if (!file) return res.json({ code: 404, msg: '该壁纸没有此设备版本' });

  const checkedToday = u.last_checkin === today();
  if (u.points < 1) {
    return res.json({ code: 2, msg: checkedToday ? '积分不足，明日签到可得 1 积分' : '积分不足，去签到可获得 1 积分', needCheckin: !checkedToday });
  }
  u.points -= 1;
  w.downloads = (w.downloads || 0) + 1;
  const logs = await load('downloads.json', []);
  logs.data.push({ user_id: u.id, wallpaper_id: w.id, device, created_at: new Date().toISOString() });
  await save('users.json', () => {});
  await save('wallpapers.json', () => {});
  await save('downloads.json', () => {});
  res.json({ code: 0, data: { url: `${CDN_BASE}/wallpapers/${file}`, points: u.points } });
});

// ---------- 下载历史 ----------
app.get('/api/user/downloads', auth, async (req, res) => {
  const logs = await load('downloads.json', []);
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  const list = logs.data.filter(l => l.user_id === req.userId).slice(-100).reverse().map(l => {
    const w = wp.data.find(x => x.id === l.wallpaper_id) || {};
    return { id: l.wallpaper_id, title: w.title || '', device: l.device, created_at: l.created_at,
      thumb: `${CDN_BASE}/wallpapers/${w.mobile_file || w.desktop_file || ''}` };
  });
  res.json({ code: 0, data: { list } });
});

// ---------- 公告（小程序启动弹窗展示） ----------
// 生效条件：enabled 且当前时间在 [start_at, end_at] 区间内；取最新一条
app.get('/api/notice', async (req, res) => {
  try {
    const msgs = await load('messages.json', []);
    const now = Date.now();
    const active = msgs.data
      .filter(m => m.enabled !== false
        && (!m.start_at || Date.parse(m.start_at) <= now)
        && (!m.end_at || Date.parse(m.end_at) >= now))
      .sort((a, b) => b.id - a.id)[0];
    res.json({ code: 0, data: active ? {
      id: active.id, title: active.title, content: active.content,
      link: active.link || '', frequency: active.frequency || 'once',
    } : null });
  } catch (e) {
    res.json({ code: 0, data: null }); // 公告失败不阻塞小程序启动
  }
});

// ================= 管理后台 =================
const adminTokens = new Map(); // token -> 过期时间戳（24h）
function adminAuth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const exp = adminTokens.get(t);
  if (!exp || exp < Date.now()) return res.status(401).json({ code: 401, msg: '未登录或已过期' });
  req.adminToken = t;
  next();
}
async function adminLog(action, detail) {
  const logs = await load('admin_logs.json', []);
  logs.data.push({ id: logs.data.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1, action, detail, created_at: new Date().toISOString() });
  if (logs.data.length > 500) logs.data = logs.data.slice(-500); // 防止无限膨胀
  await save('admin_logs.json', () => {});
}

// 管理页面（单文件静态页）
app.use('/admin', express.static(path.join(__dirname, 'admin')));

app.post('/admin/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ code: 401, msg: '密码错误' });
  }
  const t = crypto.randomBytes(32).toString('hex');
  adminTokens.set(t, Date.now() + 24 * 3600 * 1000);
  res.json({ code: 0, data: { token: t } });
});

// ---------- 仪表盘 ----------
app.get('/admin/api/stats', adminAuth, async (req, res) => {
  const users = await load('users.json', []);
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  const logs = await load('downloads.json', []);
  const msgs = await load('messages.json', []);
  const adminLogs = await load('admin_logs.json', []);
  res.json({ code: 0, data: {
    users: users.data.length,
    wallpapers: wp.data.length,
    downloads: logs.data.length,
    todayCheckins: users.data.filter(u => u.last_checkin === today()).length,
    activeMessages: msgs.data.filter(m => m.enabled !== false).length,
    recentLogs: adminLogs.data.slice(-10).reverse(),
  } });
});

// ---------- 壁纸管理 ----------
app.get('/admin/api/wallpapers', adminAuth, async (req, res) => {
  const { keyword = '', category = '', page = 1, size = 20 } = req.query;
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  let list = wp.data;
  if (keyword) list = list.filter(w => (w.title || '').includes(keyword));
  if (category) list = list.filter(w => w.category === category);
  const start = (page - 1) * size;
  const pageList = list.slice().sort((a, b) => b.id - a.id).slice(start, start + +size);
  res.json({ code: 0, data: { list: pageList, total: list.length } });
});

function validWallpaperPayload(body, cats) {
  const { title, category, device, mobile_file, desktop_file } = body;
  if (!title || !category) return '标题和分类必填';
  if (!cats.data.find(c => c.key === category)) return '分类不存在';
  if (!['mobile', 'desktop', 'both'].includes(device)) return '设备版本无效';
  if ((device === 'mobile' || device === 'both') && !mobile_file) return '缺少手机版图片';
  if ((device === 'desktop' || device === 'both') && !desktop_file) return '缺少电脑版图片';
  return null;
}

app.post('/admin/api/wallpapers', adminAuth, async (req, res) => {
  const cats = await load('categories.json', DEFAULT_CATEGORIES);
  const err = validWallpaperPayload(req.body || {}, cats);
  if (err) return res.json({ code: 400, msg: err });
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  const item = {
    id: wp.data.reduce((m, w) => Math.max(m, w.id), 0) + 1,
    title: req.body.title.trim(), category: req.body.category, device: req.body.device,
    mobile_file: req.body.mobile_file || '', desktop_file: req.body.desktop_file || '',
    downloads: 0, created_at: today(),
  };
  await save('wallpapers.json', d => d.push(item));
  await adminLog('新增壁纸', `${item.title} (#${item.id})`);
  res.json({ code: 0, data: item });
});

app.put('/admin/api/wallpapers/:id', adminAuth, async (req, res) => {
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  const cats = await load('categories.json', DEFAULT_CATEGORIES);
  const w = wp.data.find(x => x.id === +req.params.id);
  if (!w) return res.json({ code: 404, msg: '壁纸不存在' });
  const body = { ...w, ...req.body }; // 允许部分更新
  const err = validWallpaperPayload(body, cats);
  if (err) return res.json({ code: 400, msg: err });
  Object.assign(w, {
    title: body.title.trim(), category: body.category, device: body.device,
    mobile_file: body.mobile_file || '', desktop_file: body.desktop_file || '',
  });
  await save('wallpapers.json', () => {});
  await adminLog('编辑壁纸', `${w.title} (#${w.id})`);
  res.json({ code: 0 });
});

app.delete('/admin/api/wallpapers/:id', adminAuth, async (req, res) => {
  const removeFiles = req.query.removeFiles === 'true';
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  const idx = wp.data.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.json({ code: 404, msg: '壁纸不存在' });
  const [w] = wp.data.splice(idx, 1);
  await save('wallpapers.json', () => {});
  if (removeFiles) {
    for (const f of [w.mobile_file, w.desktop_file]) {
      if (!f) continue;
      // 路径限定在 wallpapers 目录内，防止路径穿越
      const p = path.normalize(path.join(__dirname, 'wallpapers', f));
      if (p.startsWith(path.join(__dirname, 'wallpapers')) && fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  await adminLog('删除壁纸', `${w.title} (#${w.id})${removeFiles ? '（含图片文件）' : ''}`);
  res.json({ code: 0 });
});

// ---------- 图片上传（base64 JSON，保存到本地 wallpapers/uploads/） ----------
app.post('/admin/api/upload', adminAuth, async (req, res) => {
  const { filename = '', data = '' } = req.body || {};
  const base64 = data.includes(',') ? data.split(',')[1] : data; // 兼容 dataURL
  const ext = (path.extname(filename) || '').toLowerCase().replace('.', '');
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
    return res.json({ code: 400, msg: '仅支持 jpg / png / webp 图片' });
  }
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) return res.json({ code: 400, msg: '文件内容为空' });
  if (buf.length > 15 * 1024 * 1024) return res.json({ code: 400, msg: '图片不能超过 15MB' });
  const dir = path.join(__dirname, 'wallpapers', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  // 时间戳 + 随机串防文件名冲突
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  await adminLog('上传图片', name);
  res.json({ code: 0, data: { file: `uploads/${name}`, size: buf.length } });
});

// ---------- 分类管理 ----------
app.get('/admin/api/categories', adminAuth, async (req, res) => {
  const cats = await load('categories.json', DEFAULT_CATEGORIES);
  res.json({ code: 0, data: [...cats.data].sort((a, b) => a.sort - b.sort) });
});
app.post('/admin/api/categories', adminAuth, async (req, res) => {
  const { key, name, sort } = req.body || {};
  if (!key || !name) return res.json({ code: 400, msg: 'key 和名称必填' });
  if (!/^[a-z][a-z0-9_]*$/.test(key)) return res.json({ code: 400, msg: 'key 仅限小写字母/数字/下划线' });
  const cats = await load('categories.json', DEFAULT_CATEGORIES);
  if (cats.data.find(c => c.key === key)) return res.json({ code: 400, msg: 'key 已存在' });
  cats.data.push({ key, name: name.trim(), sort: +sort || 99 });
  await save('categories.json', () => {});
  await adminLog('新增分类', `${name} (${key})`);
  res.json({ code: 0 });
});
app.put('/admin/api/categories/:key', adminAuth, async (req, res) => {
  const cats = await load('categories.json', DEFAULT_CATEGORIES);
  const c = cats.data.find(x => x.key === req.params.key);
  if (!c) return res.json({ code: 404, msg: '分类不存在' });
  const { name, sort } = req.body || {};
  if (name) c.name = name.trim();
  if (sort !== undefined) c.sort = +sort;
  await save('categories.json', () => {});
  await adminLog('编辑分类', `${c.name} (${c.key})`);
  res.json({ code: 0 });
});
app.delete('/admin/api/categories/:key', adminAuth, async (req, res) => {
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  if (wp.data.some(w => w.category === req.params.key)) {
    return res.json({ code: 400, msg: '该分类下仍有壁纸，请先移除壁纸' });
  }
  const cats = await load('categories.json', DEFAULT_CATEGORIES);
  const idx = cats.data.findIndex(x => x.key === req.params.key);
  if (idx < 0) return res.json({ code: 404, msg: '分类不存在' });
  const [c] = cats.data.splice(idx, 1);
  await save('categories.json', () => {});
  await adminLog('删除分类', `${c.name} (${c.key})`);
  res.json({ code: 0 });
});

// ---------- 消息公告管理 ----------
app.get('/admin/api/messages', adminAuth, async (req, res) => {
  const msgs = await load('messages.json', []);
  res.json({ code: 0, data: msgs.data.slice().sort((a, b) => b.id - a.id) });
});
app.post('/admin/api/messages', adminAuth, async (req, res) => {
  const { title, content, link, frequency, start_at, end_at, enabled } = req.body || {};
  if (!title || !content) return res.json({ code: 400, msg: '标题和内容必填' });
  if (frequency && !['once', 'daily', 'always'].includes(frequency)) {
    return res.json({ code: 400, msg: '频次无效' });
  }
  if (start_at && end_at && Date.parse(end_at) < Date.parse(start_at)) {
    return res.json({ code: 400, msg: '结束时间不能早于开始时间' });
  }
  const msgs = await load('messages.json', []);
  const item = {
    id: msgs.data.reduce((m, x) => Math.max(m, x.id), 0) + 1,
    title: title.trim(), content: content.trim(), link: (link || '').trim(),
    frequency: frequency || 'once', start_at: start_at || '', end_at: end_at || '',
    enabled: enabled !== false, created_at: new Date().toISOString(),
  };
  msgs.data.push(item);
  await save('messages.json', () => {});
  await adminLog('发布公告', item.title);
  res.json({ code: 0, data: item });
});
app.put('/admin/api/messages/:id', adminAuth, async (req, res) => {
  const msgs = await load('messages.json', []);
  const m = msgs.data.find(x => x.id === +req.params.id);
  if (!m) return res.json({ code: 404, msg: '公告不存在' });
  const { title, content, link, frequency, start_at, end_at, enabled } = req.body || {};
  if (title !== undefined) m.title = title.trim();
  if (content !== undefined) m.content = content.trim();
  if (link !== undefined) m.link = link.trim();
  if (frequency !== undefined) m.frequency = frequency;
  if (start_at !== undefined) m.start_at = start_at;
  if (end_at !== undefined) m.end_at = end_at;
  if (enabled !== undefined) m.enabled = !!enabled;
  await save('messages.json', () => {});
  await adminLog('编辑公告', m.title);
  res.json({ code: 0 });
});
app.delete('/admin/api/messages/:id', adminAuth, async (req, res) => {
  const msgs = await load('messages.json', []);
  const idx = msgs.data.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.json({ code: 404, msg: '公告不存在' });
  const [m] = msgs.data.splice(idx, 1);
  await save('messages.json', () => {});
  await adminLog('删除公告', m.title);
  res.json({ code: 0 });
});

// ---------- 用户管理 ----------
app.get('/admin/api/users', adminAuth, async (req, res) => {
  const { keyword = '', page = 1, size = 20 } = req.query;
  const users = await load('users.json', []);
  let list = users.data;
  if (keyword) list = list.filter(u => String(u.id) === keyword || (u.nickname || '').includes(keyword));
  const start = (page - 1) * size;
  res.json({ code: 0, data: {
    total: list.length,
    list: list.slice().sort((a, b) => b.id - a.id).slice(start, start + +size).map(u => ({
      id: u.id, openid: u.openid.slice(0, 6) + '****', // 脱敏
      nickname: u.nickname || '微信用户', points: u.points, last_checkin: u.last_checkin,
      downloads: 0, created_at: u.created_at,
    })),
  } });
});
app.post('/admin/api/users/:id/points', adminAuth, async (req, res) => {
  const { delta, reason = '' } = req.body || {};
  const n = +delta;
  if (!Number.isInteger(n) || n === 0) return res.json({ code: 400, msg: '积分变更必须为非零整数' });
  const users = await load('users.json', []);
  const u = users.data.find(x => x.id === +req.params.id);
  if (!u) return res.json({ code: 404, msg: '用户不存在' });
  if (u.points + n < 0) return res.json({ code: 400, msg: '调整后积分不能为负' });
  u.points += n;
  await save('users.json', () => {});
  await adminLog('调整积分', `用户#${u.id} ${n > 0 ? '+' : ''}${n}（${reason || '无备注'}）`);
  res.json({ code: 0, data: { points: u.points } });
});

// ---------- 下载记录 ----------
app.get('/admin/api/downloads', adminAuth, async (req, res) => {
  const { page = 1, size = 50 } = req.query;
  const logs = await load('downloads.json', []);
  const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
  const start = (page - 1) * size;
  const list = logs.data.slice().reverse().slice(start, start + +size).map(l => {
    const w = wp.data.find(x => x.id === l.wallpaper_id) || {};
    return { ...l, title: w.title || `#${l.wallpaper_id}` };
  });
  res.json({ code: 0, data: { total: logs.data.length, list } });
});

// ---------- 管理员操作日志 ----------
app.get('/admin/api/logs', adminAuth, async (req, res) => {
  const logs = await load('admin_logs.json', []);
  res.json({ code: 0, data: logs.data.slice().reverse() });
});

const server = app.listen(PORT, async () => {
  console.log(`wallpaper-server running on :${PORT}`);
  // 启动时预热数据库文件（首次会以默认数据在 GitHub 仓库创建 db/*.json）
  try {
    const cats = await load('categories.json', DEFAULT_CATEGORIES);
    if (!cats.sha) await save('categories.json', () => {});
    const wp = await load('wallpapers.json', DEFAULT_WALLPAPERS);
    if (!wp.sha) await save('wallpapers.json', () => {});
    await load('users.json', []);
    await load('downloads.json', []);
    await load('messages.json', []);
    await load('admin_logs.json', []);
  } catch (e) { console.error('db init warning:', e.message); }
});
