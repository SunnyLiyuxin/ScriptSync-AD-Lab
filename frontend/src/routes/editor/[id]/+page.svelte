<script lang="ts">
  /**
   * 编辑器页面：初始化协作会话 + 加载 TimelineEditor
   */
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import * as Y from 'yjs';
  import type { WebsocketProvider } from 'y-websocket';
  import { initCollab, type CollabInstance } from '../../../lib/collaboration/yjs-setup';
  import TimelineEditor from '../../../components/TimelineEditor.svelte';
  import type { MemberRole, ProjectMember } from '../../../types/project';

  const API_URL = ''; // 空字符串=相对路径，通过 Vite proxy 代理到 API
  const projectId = $derived($page.params.id ?? '');

  let collab: CollabInstance | null = $state(null);
  let videoSrc = $state('');
  let loading = $state(true);
  let error = $state('');
  let userInfo = $state<{ userId: string; username: string } | null>(null);
  let authToken = $state('');
  let myRole = $state<MemberRole | null>(null);
  let members = $state<ProjectMember[]>([]);

  onMount(async () => {
    const token = browser ? localStorage.getItem('token') : null;
    if (!token) {
      error = '未登录';
      loading = false;
      return;
    }

    try {
      // 解析 token 获取用户信息（MVP，生产由后端返回）
      const payload = JSON.parse(atob(token.split('.')[1]));
      userInfo = { userId: payload.userId, username: payload.username };

      // 并行拉取：协作 token + 我的角色 + 成员列表
      const [collabRes, roleRes, membersRes] = await Promise.all([
        fetch(`${API_URL}/api/projects/${projectId}/collab-token`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/api/projects/${projectId}/my-role`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/api/projects/${projectId}/members`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (!collabRes.ok) throw new Error('获取协作 token 失败');
      const { token: collabToken, roomName } = await collabRes.json();

      // my-role 失败不阻塞（可能是成员列表未同步）
      if (roleRes.ok) {
        const roleData = await roleRes.json();
        myRole = roleData.role as MemberRole;
      }
      if (membersRes.ok) {
        const membersData = await membersRes.json();
        members = (membersData.members || []) as ProjectMember[];
      }

      // 通过 Vite proxy 同源访问协作服务端，避免跨域和 localhost 问题
      const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/collab-ws`;

      // 初始化协作
      const colors = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f9', '#f032e6'];
      collab = initCollab({
        roomName,
        wsUrl,
        token: collabToken,
        userId: userInfo.userId,
        username: userInfo.username,
        color: colors[Math.floor(Math.random() * colors.length)],
      });

      // 加载片源
      videoSrc = `${API_URL}/api/files/video/${projectId}`;
      loading = false;
      // 缓存 token 供子组件上传视频用
      authToken = token;
    } catch (e: any) {
      error = e.message;
      loading = false;
    }
  });

  onDestroy(() => {
    collab?.destroy();
  });
</script>

{#if loading}
  <div class="loading">正在连接协作会话...</div>
{:else if error}
  <div class="error">{error}</div>
{:else if collab && userInfo}
  <TimelineEditor
    doc={collab.doc}
    provider={collab.provider}
    userId={userInfo.userId}
    username={userInfo.username}
    {videoSrc}
    {projectId}
    {authToken}
    {myRole}
    {members}
  />
{/if}

<style>
  .loading, .error {
    display: flex;
    align-items: center;
    justify-content: center;
    height: calc(100vh - 60px);
    font-size: 16px;
  }
  .error { color: #d9534f; }
</style>
