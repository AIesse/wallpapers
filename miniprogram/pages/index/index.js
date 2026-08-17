const app = getApp();

Page({
  data: {
    statusBarHeight: 20,
    categories: [],
    currentCat: 'featured',
    // 特色专区（多端壁纸）：device 筛选 all / mobile / desktop
    deviceFilter: 'all',
    showDeviceFilter: false,
    left: [],
    right: [],
    page: 1,
    hasMore: true,
    loading: false,
    deviceNames: { mobile: '手机', desktop: '电脑', both: '多端' },
  },

  onLoad() {
    const sys = wx.getWindowInfo();
    this.setData({ statusBarHeight: sys.statusBarHeight || 20 });
    this.loadCategories();
  },

  async loadCategories() {
    try {
      const res = await app.request('/api/categories');
      if (res.code === 0) {
        const palette = ['#5eead4', '#60a5fa', '#a78bfa', '#f472b6', '#fb923c', '#fcd34d', '#34d399'];
        const categories = res.data.map((c, i) => ({ ...c, color: palette[i % palette.length] }));
        this.setData({ categories });
        this.reload();
      }
    } catch (e) {
      wx.showToast({ title: '网络异常', icon: 'none' });
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
  },

  reload() {
    this.setData({ left: [], right: [], page: 1, hasMore: true });
    this.loadMore();
  },

  async loadMore() {
    if (this.data.loading || !this.data.hasMore) return;
    this.setData({ loading: true });
    const { currentCat, deviceFilter, page } = this.data;
    const device = currentCat === 'featured' && deviceFilter !== 'all' ? deviceFilter : '';
    try {
      const res = await app.request('/api/wallpapers', { category: currentCat, device, page, size: 20 });
      if (res.code === 0) {
        // 双列瀑布流：按累计高度较矮的一列放入
        const heights = { left: this.colHeight('left'), right: this.colHeight('right') };
        const patch = { hasMore: res.data.hasMore, page: page + 1, loading: false };
        res.data.list.forEach(w => {
          const h = 320 + (w.id % 3) * 90; // 缩略图近似高度（宽 335rpx，比例 9:16~3:4）
          const col = heights.left <= heights.right ? 'left' : 'right';
          heights[col] += h;
          patch[col] = [...this.data[col], w];
        });
        this.setData(patch);
      } else this.setData({ loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },
  colHeight(col) {
    return this.data[col].reduce((s, w) => s + 320 + (w.id % 3) * 90, 0);
  },

  onCatTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.currentCat) return;
    this.setData({ currentCat: key, showDeviceFilter: key === 'featured', deviceFilter: 'all' });
    this.reload();
  },

  onDeviceTap(e) {
    const d = e.currentTarget.dataset.device;
    if (d === this.data.deviceFilter) return;
    this.setData({ deviceFilter: d });
    this.reload();
  },

  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}&category=${this.data.currentCat}&device=${this.data.deviceFilter}` });
  },

  onPullDownRefresh() {
    this.loadCategories().then ? null : null;
    Promise.resolve().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },
});
