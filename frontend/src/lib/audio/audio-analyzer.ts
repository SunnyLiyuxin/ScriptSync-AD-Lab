/**
 * 音频波形提取
 * 复用 ScriptSync 思路：Web Audio API decodeAudioData → 降采样为峰值数组
 * 替代 FFmpeg，纯浏览器实现，零服务器开销
 */

export interface WaveformData {
  peaks: Float32Array;   // 峰值数组（归一化到 0~1）
  duration: number;      // 总时长（秒）
  sampleRate: number;    // 原始采样率
}

/**
 * 从音频/视频文件提取波形
 * @param file 音频或视频文件（File 或 Blob）
 * @param targetPeaks 目标峰值点数（默认 8000，平衡精度与渲染性能）
 */
export async function extractWaveform(
  file: File | Blob,
  targetPeaks = 8000,
): Promise<WaveformData> {
  const arrayBuffer = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new AudioCtx();

  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const duration = audioBuffer.duration;
    const sampleRate = audioBuffer.sampleRate;

    // 降采样为峰值：每个 block 取最大绝对值
    const peaks = new Float32Array(targetPeaks);
    const blockSize = Math.floor(channelData.length / targetPeaks);

    for (let i = 0; i < targetPeaks; i++) {
      let max = 0;
      const start = i * blockSize;
      const end = Math.min(start + blockSize, channelData.length);
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }

    return { peaks, duration, sampleRate };
  } finally {
    ctx.close();
  }
}

/**
 * 从 video 元素提取音频（用于已加载的视频）
 * 通过 captureStream + MediaRecorder 录制，再 decodeAudioData
 * 注：此方式适用于无法直接拿到 File 的场景
 */
export async function extractWaveformFromVideoElement(
  video: HTMLVideoElement,
): Promise<WaveformData> {
  // 简化实现：从 video.src 重新 fetch
  if (!video.src) throw new Error('Video element has no src');
  const response = await fetch(video.src);
  const blob = await response.blob();
  return extractWaveform(blob);
}
