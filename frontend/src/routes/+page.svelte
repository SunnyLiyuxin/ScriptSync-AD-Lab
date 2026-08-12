<script lang="ts">
  /**
   * 主页：项目列表 + 创建项目
   */
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';

  const API_URL = ''; // 空字符串=相对路径，通过 Vite proxy 代理到 API

  let projects = $state<any[]>([]);
  // 安全访问 localStorage：SSR 时不存在，浏览器端才有
  let token = $state(browser ? (localStorage.getItem('token') || '') : '');
  let showCreate = $state(false);
  let newName = $state('');
  let newDesc = $state('');

  onMount(() => {
    if (token) loadProjects();
  });

  async function loadProjects() {
    const res = await fetch(`${API_URL}/api/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) projects = await res.json();
  }

  async function createProject() {
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

  // MVP 临时登录：直接填 token（生产接 OAuth/手机号）
  function saveToken() {
    if (browser) localStorage.setItem('token', token);
    loadProjects();
  }
</script>

<div class="home">
  <div class="auth-bar">
    <input bind:value={token} placeholder="粘贴 JWT token（MVP 临时方案）" />
    <button on:click={saveToken}>连接</button>
  </div>

  <div class="projects-section">
    <div class="section-header">
      <h2>我的项目</h2>
      <button on:click={() => showCreate = !showCreate}>+ 新建项目</button>
    </div>

    {#if showCreate}
      <div class="create-form">
        <input bind:value={newName} placeholder="项目名称" />
        <textarea bind:value={newDesc} placeholder="项目描述（选填）"></textarea>
        <button on:click={createProject}>创建</button>
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
        <div class="empty">暂无项目，请新建</div>
      {/each}
    </div>
  </div>
</div>

<style>
  .home { padding: 20px; max-width: 900px; margin: 0 auto; }
  .auth-bar { display: flex; gap: 8px; margin-bottom: 20px; }
  .auth-bar input {
    flex: 1;
    padding: 8px 12px;
    background: #ffffff;
    border: 1px solid #d0d7de;
    color: #1a1a2e;
    border-radius: 6px;
    font-size: 13px;
  }
  .auth-bar input:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 3px rgba(9,105,218,0.1); }
  button {
    padding: 8px 16px;
    background: #0969da;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.15s;
  }
  button:hover { background: #0860c7; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .section-header h2 { margin: 0; font-size: 18px; color: #1a1a2e; }
  .create-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 20px;
    padding: 16px;
    background: #ffffff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
  }
  .create-form input, .create-form textarea {
    padding: 8px 12px;
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    color: #1a1a2e;
    border-radius: 6px;
    font-size: 13px;
    font-family: inherit;
  }
  .create-form input:focus, .create-form textarea:focus { outline: none; border-color: #0969da; }
  .project-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .project-card {
    background: #ffffff;
    border: 1px solid #e1e4e8;
    border-radius: 8px;
    padding: 16px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .project-card:hover {
    border-color: #0969da;
    box-shadow: 0 4px 12px rgba(9,105,218,0.1);
    transform: translateY(-2px);
  }
  .project-card h3 { margin: 0 0 8px; font-size: 16px; color: #0969da; }
  .project-card p { margin: 0 0 8px; font-size: 13px; color: #57606a; }
  .time { font-size: 11px; color: #8c959f; }
  .empty { color: #8c959f; text-align: center; padding: 40px; }
</style>
