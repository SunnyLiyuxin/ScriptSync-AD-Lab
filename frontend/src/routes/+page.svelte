<script lang="ts">
  /**
   * 主页：三个入口
   * 1. 注册/登录（用户系统）
   * 2. 创建项目（登录后可见）
   * 3. 输入邀请码加入项目（登录后可见）
   */
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';

  const API_URL = ''; // 空字符串=相对路径，通过 Vite proxy 代理到 API

  // 登录态
  let token = $state(browser ? (localStorage.getItem('token') || '') : '');
  let username = $state(browser ? (localStorage.getItem('username') || '') : '');
  let isLoggedIn = $state(!!token);

  // 注册/登录表单
  let showAuth = $state(false);
  let authMode = $state<'login' | 'register'>('login');
  let authUsername = $state('');
  let authPassword = $state('');
  let authError = $state('');

  // 项目列表
  let projects = $state<any[]>([]);
  let showCreate = $state(false);
  let newName = $state('');
  let newDesc = $state('');

  // 邀请码加入
  let inviteCode = $state('');
  let inviteError = $state('');
  let invitePreview = $state<any>(null);

  onMount(() => {
    // URL 带 ?invite=xxx 时，自动填入邀请码输入框
    const params = new URLSearchParams(window.location.search);
    const code = params.get('invite');
    if (code) inviteCode = code;
    if (token) loadProjects();
  });

  async function loadProjects() {
    const res = await fetch(`${API_URL}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) projects = await res.json();
    else if (res.status === 401) {
      // token 失效
      logout();
    }
  }

  async function submitAuth() {
    authError = '';
    if (!authUsername.trim() || !authPassword) {
      authError = '用户名和密码不能为空';
      return;
    }
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const res = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: authUsername.trim(), password: authPassword }),
    });
    if (res.ok) {
      const data = await res.json();
      token = data.token;
      username = data.username;
      isLoggedIn = true;
      if (browser) {
        localStorage.setItem('token', token);
        localStorage.setItem('username', username);
      }
      showAuth = false;
      authPassword = '';
      loadProjects();
    } else {
      const err = await res.json().catch(() => ({}));
      authError = err.detail || '操作失败';
    }
  }

  function logout() {
    token = '';
    username = '';
    isLoggedIn = false;
    projects = [];
    if (browser) {
      localStorage.removeItem('token');
      localStorage.removeItem('username');
    }
  }

  async function createProject() {
    if (!newName.trim()) return;
    const res = await fetch(`${API_URL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: newName, description: newDesc }),
    });
    if (res.ok) {
      const p = await res.json();
      showCreate = false;
      newName = '';
      newDesc = '';
      loadProjects();
    }
  }

  function enterProject(id: string) {
    goto(`/editor/${id}`);
  }

  // 邀请码：输入后预览项目信息
  async function previewInvite() {
    inviteError = '';
    invitePreview = null;
    if (!inviteCode.trim()) {
      inviteError = '请输入邀请码';
      return;
    }
    const res = await fetch(`${API_URL}/api/invitations/${encodeURIComponent(inviteCode.trim())}/info`);
    if (res.ok) {
      invitePreview = await res.json();
    } else {
      const err = await res.json().catch(() => ({}));
      inviteError = err.detail || '邀请码无效';
    }
  }

  // 邀请码：确认加入
  async function joinByInvite() {
    if (!inviteCode.trim()) return;
    if (!isLoggedIn) {
      inviteError = '请先登录或注册';
      return;
    }
    const res = await fetch(`${API_URL}/api/invitations/${encodeURIComponent(inviteCode.trim())}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      goto(`/editor/${data.projectId}`);
    } else {
      const err = await res.json().catch(() => ({}));
      inviteError = err.detail || '加入失败';
    }
  }
</script>

<div class="home">
  <header class="top-bar">
    <div class="brand">ScriptSync</div>
    {#if isLoggedIn}
      <div class="user-info">
        <span class="user-avatar">{username.charAt(0).toUpperCase()}</span>
        <span class="user-name">{username}</span>
        <button class="btn-text" on:click={logout}>退出</button>
      </div>
    {:else}
      <button on:click={() => { showAuth = true; authMode = 'login'; }}>登录</button>
      <button class="btn-secondary" on:click={() => { showAuth = true; authMode = 'register'; }}>注册</button>
    {/if}
  </header>

  {#if !isLoggedIn}
    <!-- 未登录：引导注册/登录 -->
    <div class="hero">
      <h1>口述稿全流程协作平台</h1>
      <p>多人实时协作 · AI 客观中性检测 · 工作分配与权限管理</p>
      <div class="hero-actions">
        <button on:click={() => { showAuth = true; authMode = 'register'; }}>立即注册</button>
        <button class="btn-secondary" on:click={() => { showAuth = true; authMode = 'login'; }}>已有账号，登录</button>
      </div>
    </div>
  {:else}
    <!-- 已登录：项目列表 + 邀请码加入 + 创建项目 -->
    <div class="main-grid">
      <div class="projects-section">
        <div class="section-header">
          <h2>我的项目</h2>
          <button on:click={() => showCreate = !showCreate}>+ 新建项目</button>
        </div>

        {#if showCreate}
          <div class="create-form">
            <input bind:value={newName} placeholder="项目名称" />
            <textarea bind:value={newDesc} placeholder="项目描述（选填）"></textarea>
            <button on:click={createProject}>创建项目</button>
          </div>
        {/if}

        <div class="project-list">
          {#each projects as p}
            <div class="project-card" on:click={() => enterProject(p.id)} role="button" tabindex="0">
              <h3>{p.name}</h3>
              <p>{p.description || '无描述'}</p>
              <span class="time">创建于 {new Date(p.created_at * 1000).toLocaleString()}</span>
            </div>
          {:else}
            <div class="empty">暂无项目，请新建或通过邀请码加入</div>
          {/each}
        </div>
      </div>

      <div class="invite-section">
        <h3>通过邀请码加入</h3>
        <p class="hint">输入项目创建人分享给你的邀请码</p>
        <input bind:value={inviteCode} placeholder="输入邀请码" on:keydown={(e) => { if (e.key === 'Enter') previewInvite(); }} />
        <button on:click={previewInvite}>查询</button>
        {#if inviteError}
          <div class="error">{inviteError}</div>
        {/if}
        {#if invitePreview}
          <div class="invite-preview">
            <div class="preview-name">{invitePreview.projectName}</div>
            <div class="preview-role">加入后角色：{invitePreview.role}</div>
            <div class="preview-expire">有效期至：{new Date(invitePreview.expiresAt * 1000).toLocaleString()}</div>
            <button on:click={joinByInvite}>确认加入</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- 注册/登录弹窗 -->
  {#if showAuth}
    <div class="modal-overlay" on:click={() => showAuth = false}>
      <div class="modal" on:click|stopPropagation>
        <div class="modal-tabs">
          <button class:active={authMode === 'login'} on:click={() => { authMode = 'login'; authError = ''; }}>登录</button>
          <button class:active={authMode === 'register'} on:click={() => { authMode = 'register'; authError = ''; }}>注册</button>
        </div>
        <input bind:value={authUsername} placeholder="用户名" />
        <input type="password" bind:value={authPassword} placeholder="密码（至少 6 位）" on:keydown={(e) => { if (e.key === 'Enter') submitAuth(); }} />
        {#if authError}
          <div class="error">{authError}</div>
        {/if}
        <button on:click={submitAuth}>{authMode === 'login' ? '登录' : '注册并登录'}</button>
        <button class="btn-text" on:click={() => showAuth = false}>取消</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .home { padding: 0; max-width: 1100px; margin: 0 auto; min-height: 100vh; }
  .top-bar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 16px 20px; border-bottom: 1px solid #e1e4e8; background: #ffffff;
    position: sticky; top: 0; z-index: 10;
  }
  .brand { font-size: 20px; font-weight: 700; color: #0969da; }
  .user-info { display: flex; align-items: center; gap: 12px; }
  .user-avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: #0969da; color: white;
    display: flex; align-items: center; justify-content: center;
    font-weight: 600; font-size: 14px;
  }
  .user-name { font-size: 14px; color: #1a1a2e; font-weight: 500; }
  .btn-text { background: none; color: #57606a; border: none; padding: 4px 8px; font-size: 13px; cursor: pointer; }
  .btn-text:hover { color: #0969da; text-decoration: underline; }
  .btn-secondary { background: #ffffff; color: #0969da; border: 1px solid #0969da; }
  .btn-secondary:hover { background: #f6f8fa; }

  .hero { text-align: center; padding: 80px 20px; }
  .hero h1 { font-size: 32px; color: #1a1a2e; margin-bottom: 12px; }
  .hero p { font-size: 15px; color: #57606a; margin-bottom: 28px; }
  .hero-actions { display: flex; gap: 12px; justify-content: center; }

  .main-grid { display: grid; grid-template-columns: 1fr 320px; gap: 24px; padding: 24px 20px; }
  .projects-section { }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .section-header h2 { margin: 0; font-size: 18px; color: #1a1a2e; }
  .create-form {
    display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px;
    padding: 16px; background: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px;
  }
  .create-form input, .create-form textarea {
    padding: 8px 12px; background: #f6f8fa; border: 1px solid #d0d7de;
    color: #1a1a2e; border-radius: 6px; font-size: 13px; font-family: inherit;
  }
  .create-form input:focus, .create-form textarea:focus { outline: none; border-color: #0969da; }
  .project-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .project-card {
    background: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 16px;
    cursor: pointer; transition: all 0.15s;
  }
  .project-card:hover {
    border-color: #0969da; box-shadow: 0 4px 12px rgba(9,105,218,0.1); transform: translateY(-2px);
  }
  .project-card h3 { margin: 0 0 8px; font-size: 16px; color: #0969da; }
  .project-card p { margin: 0 0 8px; font-size: 13px; color: #57606a; }
  .time { font-size: 11px; color: #8c959f; }
  .empty { color: #8c959f; text-align: center; padding: 40px; grid-column: 1 / -1; }

  .invite-section {
    background: #ffffff; border: 1px solid #e1e4e8; border-radius: 8px; padding: 16px;
    height: fit-content;
  }
  .invite-section h3 { margin: 0 0 8px; font-size: 15px; color: #1a1a2e; }
  .invite-section .hint { margin: 0 0 12px; font-size: 12px; color: #8c959f; }
  .invite-section input {
    width: 100%; padding: 8px 12px; background: #f6f8fa; border: 1px solid #d0d7de;
    color: #1a1a2e; border-radius: 6px; font-size: 13px; margin-bottom: 8px; box-sizing: border-box;
  }
  .invite-section input:focus { outline: none; border-color: #0969da; }
  .invite-preview {
    margin-top: 12px; padding: 12px; background: #f0f7ff; border: 1px solid #0969da;
    border-radius: 6px; font-size: 13px;
  }
  .preview-name { font-weight: 600; color: #0969da; margin-bottom: 4px; }
  .preview-role, .preview-expire { color: #57606a; font-size: 12px; margin-bottom: 2px; }
  .invite-preview button { margin-top: 8px; width: 100%; }

  button {
    padding: 8px 16px; background: #0969da; color: white; border: none;
    border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
    transition: background 0.15s;
  }
  button:hover { background: #0860c7; }
  .error { color: #cf222e; font-size: 12px; margin-top: 4px; }

  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 100;
  }
  .modal {
    background: #ffffff; padding: 24px; border-radius: 8px; width: 360px;
    display: flex; flex-direction: column; gap: 12px;
  }
  .modal-tabs { display: flex; gap: 4px; margin-bottom: 4px; }
  .modal-tabs button {
    flex: 1; background: #f6f8fa; color: #57606a; border: 1px solid #d0d7de;
  }
  .modal-tabs button.active { background: #0969da; color: white; border-color: #0969da; }
  .modal input {
    padding: 8px 12px; background: #f6f8fa; border: 1px solid #d0d7de;
    color: #1a1a2e; border-radius: 6px; font-size: 13px;
  }
  .modal input:focus { outline: none; border-color: #0969da; }
</style>
