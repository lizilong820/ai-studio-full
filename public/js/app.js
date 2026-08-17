// App init - 每个页面加载时执行
// 处理登录态、导航栏显示、模型动态加载等

function getToken() {
  return localStorage.getItem('token') || '';
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch (e) {
    return null;
  }
}

function isLoggedIn() {
  return !!getToken();
}

function isAdmin() {
  const u = getUser();
  return u && u.is_admin;
}

// 更新导航栏显示
function updateNavAuth() {
  const token = getToken();
  const user = getUser();
  
  if (token && user) {
    // 已登录
    const creditBadge = document.getElementById('creditBadge');
    const creditNum = document.getElementById('creditNum');
    const userAvatar = document.getElementById('userAvatar');
    const navAuthLinks = document.getElementById('navAuthLinks');
    
    if (creditNum) creditNum.textContent = user.credits != null ? user.credits : '--';
    if (userAvatar) userAvatar.textContent = user.username.charAt(0).toUpperCase();
    
    if (creditBadge) creditBadge.style.display = '';
    if (userAvatar) userAvatar.style.display = '';
    if (navAuthLinks) navAuthLinks.style.display = 'none';
    
    // 显示我的作品入口
    const navMyWorks = document.getElementById('navMyWorks');
    if (navMyWorks) navMyWorks.style.display = '';
    
    // 点击头像跳个人中心
    if (userAvatar) {
      userAvatar.style.cursor = 'pointer';
      userAvatar.onclick = () => window.location.href = '/profile';
    }
    
    // 如果是管理员，显示管理后台入口
    if (user.is_admin) {
      const adminEntry = document.getElementById('adminEntry');
      if (adminEntry) adminEntry.style.display = '';
    }
  } else {
    // 未登录
    const creditBadge = document.getElementById('creditBadge');
    const userAvatar = document.getElementById('userAvatar');
    const navAuthLinks = document.getElementById('navAuthLinks');
    
    if (creditBadge) creditBadge.style.display = 'none';
    if (userAvatar) userAvatar.style.display = 'none';
    if (navAuthLinks) navAuthLinks.style.display = '';
  }
}

// 从后端刷新用户信息
async function refreshUserInfo() {
  if (!isLoggedIn()) return;
  try {
    const res = await fetch('/api/user/profile', {
      headers: { 'Authorization': 'Bearer ' + getToken() }
    });
    const data = await res.json();
    if (data.code === 0) {
      localStorage.setItem('user', JSON.stringify(data.data));
      updateNavAuth();
    } else if (data.code === 401) {
      // token失效
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      updateNavAuth();
    }
  } catch (e) {}
}

// 检查登录 - 未登录跳转
function requireLogin() {
  if (!isLoggedIn()) {
    showToast('请先登录', 'error');
    setTimeout(() => {
      window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
    }, 1000);
    return false;
  }
  return true;
}

// 通用API请求
async function apiRequest(url, options = {}) {
  const token = getToken();
  const headers = Object.assign({}, options.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  
  const res = await fetch(url, Object.assign({}, options, { headers }));
  const data = await res.json();
  
  if (data.code === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    updateNavAuth();
  }
  
  return data;
}

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
  updateNavAuth();
  if (isLoggedIn()) {
    refreshUserInfo();
  }
});
