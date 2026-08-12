<script lang="ts">
  /**
   * 编辑器页面：初始化协作会话 + 加载 TimelineEditor
   * 阶段2：增加「邀请协作」浮动按钮（仅 owner 可见）+ 邀请码管理弹窗
   */
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
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

  // 邀请码管理
  let showInviteModal = $state(false);
  let invitations = $state<any[]>([]);
  let newInviteRole = $state<'narrator' | 'reviewer' | 'manager'>('narrator');
  let newInviteHours = $state(72);
  let inviteLoading = $state(false);
  let inviteMsg = $state('');

  onMount(async () => {
    const token = browser ? localStorage.getItem('token') : null;
    if (!token) {
      error = '未登录，正在跳转...';
      loading = false;
      setTimeout(() => goto('/'), 1500);
      return;
    }

    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      userInfo = { userId: payload.userId, username: payload.username };

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

      if (!collabRes.ok) {
        if (collabRes.status === 403) {
          error = '你不是该项目成员，请通过邀请码加入';
          loading = false;
          setTimeout(() => goto('/'), 2000);
          return;
        }
        throw new Error('获取协作 token 失败');
      }
      const { token: collabToken, roomName } = await collabRes.json();

      if (roleRes.ok) {
        const roleData = await roleRes.json();
        myRole = roleData.role as MemberRole;
      }
      if (membersRes.ok) {
        const membersData = await membersRes.json();
        members = (membersData.members || []) as ProjectMember[];
      }

      const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/collab-ws`;

      const colors = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f9', '#f032e6'];
      collab = initCollab({
        roomName,
        wsUrl,
        token: collabToken,
        userId: userInfo.userId,
        username: userInfo.username,
        color: colors[Math.floor(Math.random() * colors.length)],
      });

      videoSrc = `${API_URL}/api/files/video/${projectId}`;
      loading = false;
      authToken = token;
    } catch (e: any) {
      error = e.message;
      loading = false;
    }
  });

  onDestroy(() => {
    collab?.destroy();
  });

  // 邀请码：打开弹窗并加载列表
  async function openInviteModal() {
    showInviteModal = true;
    inviteMsg = '';
    await loadInvitations();
  }

  async function loadInvitations() {
    if (!authToken) return;
    const res = await fetch(`${API_URL}/api/projects/${projectId}/invitations`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      invitations = data.invitations || [];
    }
  }

  async function createInvite() {
    if (!authToken) return;
    inviteLoading = true;
    inviteMsg = '';
    const res = await fetch(`${API_URL}/api/projects/${projectId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ expires_in_hours: newInviteHours, max_uses: 0, role: newInviteRole }),
    });
    inviteLoading = false;
    if (res.ok) {
      inviteMsg = '邀请码已生成';
      await loadInvitations();
    } else {
      const err = await res.json().catch(() => ({}));
      inviteMsg = err.detail || '生成失败';
    }
  }

  async function revokeInvite(code: string) {
    if (!confirm('确认撤销该邀请码？撤销后他人将无法使用它加入。')) return;
    const res = await fetch(`${API_URL}/api/projects/${projectId}/invitations/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      await loadInvitations();
    }
  }

  function copyInviteLink(code: string) {
    const url = `${window.location.origin}/?invite=${code}`;
    navigator.clipboard.writeText(url).then(() => {
      inviteMsg = `已复制邀请链接：${url}`;
    });
  }

  function exitProject() {
    goto('/');
  }
</script>

{#if loading}
  <div class="loading">正在连接协作会话...</div>
{:else if error}
  <div class="error">{error}</div>
{:else if collab && userInfo}
  <div class="editor-wrap">
    <div class="editor-topbar">
      <button class="btn-back" on:click={exitProject}>← 返回</button>
      {#if myRole === 'owner'}
        <button class="btn-invite" on:click={openInviteModal}>邀请协作</button>
      {/if}
    </div>

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
  </div>
{/if}

{#if showInviteModal}
  <div class="modal-overlay" on:click={() => showInviteModal = false}>
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">
        <h3>邀请协作</h3>
        <button class="btn-close" on:click={() => showInviteModal = false}>×</button>
      </div>

      <div class="modal-section">
        <h4>生成新邀请码</h4>
        <div class="form-row">
          <label>角色</label>
          <select bind:value={newInviteRole}>
            <option value="narrator">口述员（narrator）</option>
            <option value="reviewer">审阅（reviewer）</option>
            <option value="manager">管理员（manager）</option>
          </select>
        </div>
        <div class="form-row">
          <label>有效期（小时）</label>
          <input type="number" bind:value={newInviteHours} min="1" />
        </div>
        <button on:click={createInvite} disabled={inviteLoading}>生成邀请码</button>
        {#if inviteMsg}
          <div class="msg">{inviteMsg}</div>
        {/if}
      </div>

      <div class="modal-section">
        <h4>已有邀请码</h4>
        {#each invitations as inv}
          <div class="invite-item" class:revoked={inv.revoked}>
            <div class="invite-code">{inv.code}</div>
            <div class="invite-meta">
              角色：{inv.role} · 已用 {inv.use_count} 次 ·
              过期：{new Date(inv.expires_at * 1000).toLocaleString()}
              {#if inv.revoked}<span class="revoked-tag">已撤销</span>{/if}
            </div>
            <div class="invite-actions">
              <button class="btn-small" on:click={() => copyInviteLink(inv.code)}>复制链接</button>
              {#if !inv.revoked}
                <button class="btn-small btn-danger" on:click={() => revokeInvite(inv.code)}>撤销</button>
              {/if}
            </div>
          </div>
        {:else}
          <div class="empty">暂无邀请码</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .loading, .error {
    display: flex; align-items: center; justify-content: center;
    height: calc(100vh - 60px); font-size: 16px;
  }
  .error { color: #d9534f; }

  .editor-wrap { height: 100vh; display: flex; flex-direction: column; }
  .editor-topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 16px; background: #ffffff; border-bottom: 1px solid #e1e4e8;
  }
  .btn-back {
    background: none; border: 1px solid #d0d7de; color: #57606a;
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  .btn-back:hover { background: #f6f8fa; }
  .btn-invite {
    margin-left: auto; background: #0969da; color: white; border: none;
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
  }
  .btn-invite:hover { background: #0860c7; }

  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center; z-index: 100;
  }
  .modal {
    background: #ffffff; padding: 20px; border-radius: 8px; width: 480px;
    max-height: 80vh; overflow-y: auto;
  }
  .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .modal-header h3 { margin: 0; font-size: 18px; color: #1a1a2e; }
  .btn-close {
    background: none; border: none; font-size: 24px; cursor: pointer;
    color: #8c959f; padding: 0; width: 28px; height: 28px;
  }
  .btn-close:hover { color: #1a1a2e; }
  .modal-section { padding: 12px 0; border-top: 1px solid #e1e4e8; }
  .modal-section:first-of-type { border-top: none; padding-top: 0; }
  .modal-section h4 { margin: 0 0 8px; font-size: 14px; color: #1a1a2e; }
  .form-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .form-row label { width: 100px; font-size: 13px; color: #57606a; }
  .form-row select, .form-row input {
    flex: 1; padding: 6px 8px; background: #f6f8fa; border: 1px solid #d0d7de;
    border-radius: 6px; font-size: 13px; color: #1a1a2e;
  }
  .modal-section button {
    background: #0969da; color: white; border: none;
    padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  .modal-section button:disabled { background: #8c959f; cursor: not-allowed; }
  .msg { margin-top: 8px; padding: 6px 10px; background: #dafbe1; border: 1px solid #4ac26b; border-radius: 4px; font-size: 12px; color: #1a7f37; word-break: break-all; }

  .invite-item {
    padding: 10px; background: #f6f8fa; border: 1px solid #e1e4e8;
    border-radius: 6px; margin-bottom: 8px;
  }
  .invite-item.revoked { opacity: 0.5; }
  .invite-code {
    font-family: monospace; font-size: 14px; font-weight: 600; color: #0969da;
    margin-bottom: 4px; word-break: break-all;
  }
  .invite-meta { font-size: 12px; color: #57606a; margin-bottom: 6px; }
  .revoked-tag { display: inline-block; margin-left: 6px; padding: 1px 6px; background: #cf222e; color: white; border-radius: 3px; font-size: 11px; }
  .invite-actions { display: flex; gap: 6px; }
  .btn-small {
    padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #d0d7de;
    background: #ffffff; color: #57606a; cursor: pointer;
  }
  .btn-small:hover { background: #f6f8fa; }
  .btn-danger { color: #cf222e; border-color: #cf222e; }
  .btn-danger:hover { background: #ffebe9; }
  .empty { color: #8c959f; text-align: center; padding: 16px; font-size: 13px; }
</style>
