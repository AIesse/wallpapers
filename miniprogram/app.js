App({
  globalData: {
    baseURL: 'https://wallpaper.example.com', // 改为你的 Cloudflare 代理域名
    token: '',
    userInfo: null,
  },
  onLaunch() {
    // 静默登录：微信官方鉴权 wx.login -> code -> 后端换 openid
    const token = wx.getStorageSync('token');
    if (token) {
      this.globalData.token = token;
      this.refreshUser();
    } else {
      this.silentLogin();
    }
    this.fetchNotice();
  },

  // 公告弹窗：后端返回生效中的最新一条；支持频次 once（看过不再弹）/ daily（每日一次）/ always
  async fetchNotice() {
    try {
      const res = await this.request('/api/notice');
      if (res.code !== 0 || !res.data) return;
      const n = res.data;
      const hideKey = `notice_${n.id}`;
      const todayStr = new Date().toISOString().slice(0, 10);
      const hidden = wx.getStorageSync(hideKey);
      if (n.frequency === 'once' && hidden) return;
      if (n.frequency === 'daily' && hidden === todayStr) return;

      wx.showModal({
        title: n.title || '公告',
        content: n.content || '',
        showCancel: !!n.link,
        confirmText: n.link ? '去看看' : '知道了',
        cancelText: '关闭',
        success: r => {
          if (n.frequency === 'once') wx.setStorageSync(hideKey, '1');
          else if (n.frequency === 'daily') wx.setStorageSync(hideKey, todayStr);
          if (r.confirm && n.link) this.openNoticeLink(n.link);
        },
      });
    } catch (e) { /* 公告拉取失败静默跳过 */ }
  },
  openNoticeLink(link) {
    if (link.startsWith('/pages/')) {
      // 小程序内页面路径
      if (link.startsWith('/pages/mine/mine') || link.startsWith('/pages/index/index')) {
        wx.switchTab({ url: link });
      } else {
        wx.navigateTo({ url: link, fail: () => {} });
      }
    } else if (/^https?:\/\//.test(link)) {
      // 外部链接：复制到浏览器打开（无 web-view 页时的兜底）
      wx.setClipboardData({ data: link, success: () => wx.showToast({ title: '链接已复制', icon: 'none' }) });
    }
  },
  async silentLogin() {
    try {
      const { code } = await wx.login();
      const res = await this.request('/api/auth/login', { code }, 'POST');
      if (res.code === 0) {
        this.globalData.token = res.data.token;
        this.globalData.userInfo = { points: res.data.points, todayChecked: res.data.todayChecked };
        wx.setStorageSync('token', res.data.token);
      }
    } catch (e) {
      console.error('silent login failed', e);
    }
  },
  async refreshUser() {
    try {
      const res = await this.request('/api/user/info');
      if (res.code === 0) {
        this.globalData.userInfo = res.data;
        this.emit('user', res.data);
      } else if (res.code === 401) {
        wx.removeStorageSync('token');
        this.globalData.token = '';
        this.silentLogin();
      }
    } catch (e) { /* 网络异常忽略 */ }
  },
  // 统一请求封装：自动带 token
  request(path, data = {}, method = 'GET') {
    const header = { 'Content-Type': 'application/json' };
    if (this.globalData.token) header.Authorization = 'Bearer ' + this.globalData.token;
    return new Promise((resolve, reject) => {
      wx.request({
        url: this.globalData.baseURL + path,
        method, data, header,
        success: r => resolve(r.data),
        fail: reject,
      });
    });
  },
  // 极简事件总线，页面间同步用户积分状态
  _listeners: {},
  on(event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); },
  off(event, fn) { this._listeners[event] = (this._listeners[event] || []).filter(f => f !== fn); },
  emit(event, payload) { (this._listeners[event] || []).forEach(fn => fn(payload)); },
});
