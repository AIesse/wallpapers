const app = getApp();
// 流量主广告位：在小程序后台「流量主」开通后填入真实 adUnitId
const AD_UNIT_BANNER = '';      // banner 广告位 id
const AD_UNIT_REWARDED = '';    // 激励视频广告位 id（可选用：看广告送积分）

Page({
  data: {
    statusBarHeight: 20,
    user: null,          // { points, todayChecked }
    history: [],
    adUnitBanner: AD_UNIT_BANNER,
    checkedIn: false,
    loading: true,
  },

  onLoad() {
    const sys = wx.getWindowInfo();
    this.setData({ statusBarHeight: sys.statusBarHeight || 20 });
    this.syncUser = u => this.setData({ user: u, checkedIn: !!u.todayChecked });
    app.on('user', this.syncUser);
    this.initRewardedAd();
  },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    app.refreshUser();
    this.loadHistory();
  },
  onUnload() { app.off('user', this.syncUser); },

  async loadHistory() {
    try {
      const res = await app.request('/api/user/downloads');
      if (res.code === 0) this.setData({ history: res.data.list, loading: false });
    } catch (e) { this.setData({ loading: false }); }
  },

  // 每日签到：+1 积分
  async onCheckin() {
    if (this.data.checkedIn) return;
    if (!app.globalData.token) {
      await app.silentLogin();
      if (!app.globalData.token) return wx.showToast({ title: '登录失败，请重试', icon: 'none' });
    }
    try {
      const res = await app.request('/api/checkin', {}, 'POST');
      if (res.code === 0) {
        const u = { ...this.data.user, points: res.data.points, todayChecked: true };
        app.globalData.userInfo = u;
        app.emit('user', u);
        this.setData({ user: u, checkedIn: true });
        wx.showToast({ title: '签到成功 +1 积分', icon: 'success' });
      } else {
        wx.showToast({ title: res.msg || '签到失败', icon: 'none' });
        app.refreshUser();
      }
    } catch (e) {
      wx.showToast({ title: '网络异常', icon: 'none' });
    }
  },

  // 激励视频广告（可选增值入口：观看完整广告额外送积分）
  initRewardedAd() {
    if (!AD_UNIT_REWARDED || !wx.createRewardedVideoAd) return;
    this.rewardedAd = wx.createRewardedVideoAd({ adUnitId: AD_UNIT_REWARDED });
    this.rewardedAd.onError(() => {});
  },
  onWatchAd() {
    if (!this.rewardedAd) return wx.showToast({ title: '广告暂未配置', icon: 'none' });
    this.rewardedAd.show().catch(() => this.rewardedAd.load().then(() => this.rewardedAd.show()));
  },

  onItemTap(e) {
    wx.navigateTo({ url: `/pages/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
