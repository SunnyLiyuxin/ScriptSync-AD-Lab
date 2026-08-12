<script lang="ts">
  /**
   * 根布局：全局样式、协作会话初始化
   */
  let { children } = $props();
</script>

<div class="app">
  <header class="app-header">
    <h1>ScriptSync 口述稿协作平台</h1>
  </header>
  <main>
    {@render children()}
  </main>
</div>

<style>
  :global(body) {
    margin: 0;
    background: #f5f7fa;
    color: #1a1a2e;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .app-header {
    height: 60px;
    background: #ffffff;
    border-bottom: 1px solid #e1e4e8;
    display: flex;
    align-items: center;
    padding: 0 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  .app-header h1 {
    font-size: 16px;
    font-weight: 600;
    color: #0969da;
    margin: 0;
  }
  main {
    flex: 1;
    overflow: hidden;
  }
</style>
