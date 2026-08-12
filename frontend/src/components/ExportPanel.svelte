<script lang="ts">
  /**
   * 导出面板
   * 四种格式（ASS / SRT / WebVTT / Excel）前端直接生成并下载，省一次后端请求。
   * 可选「调用后端导出」走 POST /api/convert/{source}/{target}。
   */
  import {
    exportToAss,
    exportToSrt,
    exportToVtt,
    exportToExcel,
    downloadFile,
  } from '../lib/export';
  import type { AssEvent } from '../types/ass';

  interface Props {
    events: AssEvent[];
    projectId: string;
    authToken: string;
  }
  let { events, projectId, authToken }: Props = $props();

  let busy = $state<string | null>(null);
  let message = $state('');

  const ASS_MIME = 'text/plain;charset=utf-8';
  const SRT_MIME = 'application/x-subrip;charset=utf-8';
  const VTT_MIME = 'text/vtt;charset=utf-8';
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function flash(msg: string): void {
    message = msg;
    setTimeout(() => { message = ''; }, 2500);
  }

  async function run(key: string, fn: () => Promise<void> | void): Promise<void> {
    busy = key;
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      flash(`导出失败: ${msg}`);
    } finally {
      busy = null;
    }
  }

  // 前端导出
  function onAss(): Promise<void> {
    return run('ass', () => {
      downloadFile(exportToAss(events), `${projectId}.ass`, ASS_MIME);
      flash('ASS 导出成功');
    });
  }
  function onSrt(): Promise<void> {
    return run('srt', () => {
      downloadFile(exportToSrt(events), `${projectId}.srt`, SRT_MIME);
      flash('SRT 导出成功');
    });
  }
  function onVtt(): Promise<void> {
    return run('vtt', () => {
      downloadFile(exportToVtt(events), `${projectId}.vtt`, VTT_MIME);
      flash('WebVTT 导出成功');
    });
  }
  function onExcel(): Promise<void> {
    return run('excel', async () => {
      const blob = await exportToExcel(events);
      downloadFile(blob, `${projectId}.xlsx`, XLSX_MIME);
      flash('Excel 导出成功');
    });
  }

  // 后端导出（可选）
  function onBackendConvert(target: 'srt' | 'vtt'): Promise<void> {
    return run(`backend-${target}`, async () => {
      const res = await fetch(`/api/convert/ass/${target}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ events, projectId }),
      });
      if (!res.ok) throw new Error(`后端返回 ${res.status}`);
      const blob = await res.blob();
      downloadFile(blob, `${projectId}.${target}`, target === 'vtt' ? VTT_MIME : SRT_MIME);
      flash(`${target.toUpperCase()} 后端导出成功`);
    });
  }
</script>

<div class="export-panel">
  <div class="row">
    <button class="btn" disabled={busy !== null} onclick={onAss}>
      {busy === 'ass' ? '…' : 'ASS'}
    </button>
    <button class="btn" disabled={busy !== null} onclick={onSrt}>
      {busy === 'srt' ? '…' : 'SRT'}
    </button>
    <button class="btn" disabled={busy !== null} onclick={onVtt}>
      {busy === 'vtt' ? '…' : 'WebVTT'}
    </button>
    <button class="btn btn-excel" disabled={busy !== null} onclick={onExcel}>
      {busy === 'excel' ? '…' : 'Excel'}
    </button>
  </div>

  <details class="backend">
    <summary>调用后端导出（可选）</summary>
    <div class="row">
      <button
        class="btn btn-ghost"
        disabled={busy !== null}
        onclick={() => onBackendConvert('srt')}
      >
        {busy === 'backend-srt' ? '…' : '后端 → SRT'}
      </button>
      <button
        class="btn btn-ghost"
        disabled={busy !== null}
        onclick={() => onBackendConvert('vtt')}
      >
        {busy === 'backend-vtt' ? '…' : '后端 → VTT'}
      </button>
    </div>
  </details>

  {#if message}
    <div class="msg">{message}</div>
  {/if}
</div>

<style>
  .export-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .btn {
    padding: 6px 14px;
    border: 1px solid #d0d7de;
    background: #ffffff;
    color: #1a1a2e;
    border-radius: 5px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn:hover:not(:disabled) {
    background: #f6f8fa;
    border-color: #0969da;
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .btn-excel {
    background: #1a7f37;
    color: #fff;
    border-color: #1a7f37;
  }
  .btn-excel:hover:not(:disabled) {
    background: #16863d;
  }
  .btn-ghost {
    background: transparent;
    color: #0969da;
    border-color: #0969da;
  }
  .btn-ghost:hover:not(:disabled) {
    background: #ddf4ff;
  }
  .backend summary {
    cursor: pointer;
    font-size: 12px;
    color: #57606a;
    padding: 2px 0;
  }
  .msg {
    font-size: 12px;
    color: #1a7f37;
  }
</style>
