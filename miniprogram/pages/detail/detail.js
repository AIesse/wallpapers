const app = getApp();

Page({
  data: {
    statusBarHeight: 20,
    id: 0,
    wp: null,
    // 当前查看的设备版本：mobile / desktop（特色专区双版本切换）
    version: 'mobile',
    loading: true,
    downloading: false,
    points: 0,
  },

  onLoad(options) {
    const sys = wx.getWindowInfo();
    this.setData({
      statusBarHeight: sys.statusBarHeight || 20,
      id: +options.id,
      version: options.device === 'desktop' ? 'desktop' : 'mobile',
    });
    this.fetch();
    this.syncUser = u => this.setData({ points: u.points });
    app.on('user', this.syncUser);
  },
  onUnload() { app.off('user', this.syncUser); },

  async fetch() {
    try {
      const res = await app.request(`/api/wallpapers/${this.data.id}`);
      if (res.code === 0) {
        const wp = res.data;
        // 仅有电脑版时默认展示电脑版
        const version = wp.has_mobile ? this.data.version : 'desktop';
        this.setData({ wp, version, loading: false });
        wx.setNavigationBarTitle && wx.setNavigationBarTitle({ title: wp.title });
      } else {
        wx.showToast({ title: res.msg || '加载失败', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (e) {
      wx.showToast({ title: '网络异常', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  onVersionTap(e) {
    const v = e.currentTarget.dataset.version;
    if (v !== this.data.version) this.setData({ version: v });
  },

  currentUrl() {
    const { wp, version } = this.data;
    return version === 'desktop' ? wp.desktop_url : wp.mobile_url;
  },

  onPreview() {
    const url = this.currentUrl();
    if (url) wx.previewImage({ urls: [url] });
  },

  // 下载壁纸：先调后端扣 1 积分换取文件地址，再保存到相册
  async onDownload() {
    const { wp, version, downloading } = this.data;
    if (!wp || downloading) return;
    if (!app.globalData.token) {
      await app.silentLogin();
      if (!app.globalData.token) return wx.showToast({ title: '登录失败，请重试', icon: 'none' });
    }
    this.setData({ downloading: true });
    try {
      const res = await app.request(`/api/wallpapers/${wp.id}/download`, { device: version }, 'POST');
      if (res.code === 2) {
        // 积分不足：引导去签到
        const that = this;
        wx.showModal({
          title: '积分不足', content: res.msg, confirmText: '去签到', cancelText: '取消',
          success: r => { if (r.confirm) wx.switchTab({ url: '/pages/mine/mine' }); },
        });
        return;
      }
      if (res.code !== 0) { wx.showToast({ title: res.msg || '下载失败', icon: 'none' }); return; }

      app.globalData.userInfo = { ...(app.globalData.userInfo || {}), points: res.data.points };
      app.emit('user', app.globalData.userInfo);
      this.setData({ points: res.data.points });

      // 电脑版尺寸较大，仍可保存到相册，便于传输到电脑使用
      const dl = await new Promise((resolve, reject) =>
        wx.downloadFile({ url: res.data.url, success: resolve, fail: reject }));
      await new Promise((resolve, reject) =>
        wx.saveImageToPhotosAlbum({ filePath: dl.tempFilePath, success: resolve, fail: reject }));
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '保存失败，请检查相册权限', icon: 'none' });
    } finally {
      this.setData({ downloading: false });
    }
  },

  onBack() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) }); },
});
