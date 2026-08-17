Component({
  data: {
    selected: 0,
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: '/assets/home.png', activeIcon: '/assets/home-active.png' },
      { pagePath: '/pages/mine/mine', text: '我的', icon: '/assets/user.png', activeIcon: '/assets/user-active.png' },
    ],
  },
  methods: {
    switchTab(e) {
      const index = e.currentTarget.dataset.index;
      const url = this.data.list[index].pagePath;
      wx.switchTab({ url });
      this.setData({ selected: index });
    },
  },
});
