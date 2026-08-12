"""
FFmpeg 波形提取 + 静音检测

- extract_waveform(video_path, output_json_path, peaks_count=8000)
    用 FFmpeg 提取 WAV，再用 audiowaveform 生成 JSON 峰值；
    系统未装 audiowaveform 时 fallback 到 Python wave + 手动降采样
    （每块取 max(abs(sample))）。
    返回 {peaks: [...], duration: float}

- detect_silence(video_path, threshold=-30, min_duration=1.0)
    用 FFmpeg silencedetect 过滤器，解析 stderr 提取静音段起止时间。
    系统未装 FFmpeg 时返回空列表。
    返回 [{start, end}, ...]

所有外部命令均用 subprocess 调用并捕获异常返回 fallback。
"""
import os
import re
import json
import wave
import struct
import shutil
import logging
import tempfile
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)


def _have(cmd):
    return shutil.which(cmd) is not None


def _ffprobe_duration(video_path):
    """用 ffprobe 取时长（秒）；失败返回 0.0"""
    if not _have('ffprobe'):
        return 0.0
    try:
        proc = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', video_path],
            capture_output=True, text=True, timeout=120,
        )
        if proc.returncode == 0:
            return float(proc.stdout.strip() or 0.0)
    except Exception as e:
        logger.warning(f"ffprobe 取时长失败: {e}")
    return 0.0


def _ffmpeg_extract_wav(video_path, wav_path, sample_rate=8000):
    """用 ffmpeg 抽取单声道 WAV；返回是否成功"""
    if not _have('ffmpeg'):
        return False
    try:
        proc = subprocess.run(
            ['ffmpeg', '-y', '-i', video_path, '-vn', '-ac', '1',
             '-ar', str(sample_rate), '-f', 'wav', wav_path],
            capture_output=True, timeout=600,
        )
        return proc.returncode == 0 and os.path.exists(wav_path)
    except Exception as e:
        logger.warning(f"ffmpeg 抽取 WAV 失败: {e}")
        return False


def extract_waveform(video_path, output_json_path=None, peaks_count=8000):
    """
    提取音频波形峰值。

    :param video_path: 视频文件路径
    :param output_json_path: 可选，把峰值 JSON 写到该路径
    :param peaks_count: 期望峰值点数
    :return: {'peaks': [float, ...] (0~1), 'duration': float}
    """
    result = {'peaks': [], 'duration': 0.0}

    if not _have('ffmpeg'):
        logger.warning("系统未安装 ffmpeg，返回空波形")
        # 仍尝试取时长
        result['duration'] = _ffprobe_duration(video_path)
        if output_json_path:
            try:
                with open(output_json_path, 'w', encoding='utf-8') as f:
                    json.dump(result, f)
            except Exception:
                pass
        return result

    tmp_wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp_wav.close()
    wav_path = tmp_wav.name
    try:
        ok = _ffmpeg_extract_wav(video_path, wav_path)
        if not ok:
            logger.warning("ffmpeg 抽取 WAV 失败，返回空波形")
            result['duration'] = _ffprobe_duration(video_path)
            return result

        # 优先用 audiowaveform
        peaks = _waveform_via_audiowaveform(wav_path, peaks_count)
        if peaks is None:
            # fallback：Python wave + 手动降采样
            peaks = _waveform_via_wave(wav_path, peaks_count)

        duration = 0.0
        try:
            with wave.open(wav_path, 'rb') as w:
                if w.getframerate() > 0:
                    duration = w.getnframes() / float(w.getframerate())
        except Exception:
            pass
        if duration <= 0:
            duration = _ffprobe_duration(video_path)

        result = {'peaks': peaks, 'duration': round(duration, 3)}

        if output_json_path:
            try:
                with open(output_json_path, 'w', encoding='utf-8') as f:
                    json.dump(result, f)
            except Exception as e:
                logger.warning(f"写波形 JSON 失败: {e}")
        return result
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


def _waveform_via_audiowaveform(wav_path, peaks_count):
    """
    用 audiowaveform 工具生成 JSON 峰值。未安装或失败返回 None。
    audiowaveform JSON: {data: [min, max, min, max, ...], bits, length, ...}
    """
    if not _have('audiowaveform'):
        return None
    tmp_json = tempfile.NamedTemporaryFile(suffix='.json', delete=False)
    tmp_json.close()
    json_path = tmp_json.name
    try:
        # 估算 pixels-per-second：peaks_count / duration
        duration = 0.0
        try:
            with wave.open(wav_path, 'rb') as w:
                if w.getframerate() > 0:
                    duration = w.getnframes() / float(w.getframerate())
        except Exception:
            pass
        pps = max(1, int(peaks_count / duration)) if duration > 0 else 100

        proc = subprocess.run(
            ['audiowaveform', '-i', wav_path, '-o', json_path,
             '--output-format', 'json', '--pixels-per-second', str(pps)],
            capture_output=True, timeout=600,
        )
        if proc.returncode != 0 or not os.path.exists(json_path):
            return None
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        raw = data.get('data', [])
        bits = data.get('bits', 16)
        max_val = float((1 << (bits - 1)) - 1) if bits else 32767.0
        # data 交替 min/max，取每个点 max(|min|,|max|) 归一化
        peaks = []
        i = 0
        while i + 1 < len(raw):
            mn = abs(raw[i])
            mx = abs(raw[i + 1])
            peaks.append(round(max(mn, mx) / max_val, 5))
            i += 2
        if not peaks and raw:
            peaks = [round(abs(v) / max_val, 5) for v in raw]
        # 若点数远超期望，做一次抽稀
        if len(peaks) > peaks_count * 2:
            step = max(1, len(peaks) // peaks_count)
            peaks = [max(peaks[i:i + step]) for i in range(0, len(peaks), step)]
        return peaks
    except Exception as e:
        logger.warning(f"audiowaveform 生成波形失败，将 fallback: {e}")
        return None
    finally:
        try:
            os.unlink(json_path)
        except OSError:
            pass


def _waveform_via_wave(wav_path, peaks_count):
    """Python wave + 手动降采样：每块取 max(abs(sample))，归一化到 0~1"""
    try:
        with wave.open(wav_path, 'rb') as w:
            n_frames = w.getnframes()
            n_channels = w.getnchannels()
            sampwidth = w.getsampwidth()
            frames = w.readframes(n_frames)
    except Exception as e:
        logger.warning(f"wave 读取失败: {e}")
        return []

    if n_frames <= 0 or n_channels <= 0:
        return []

    # 解包样本
    total = n_frames * n_channels
    try:
        if sampwidth == 1:
            samples = struct.unpack(f'<{total}B', frames)
            samples = [s - 128 for s in samples]            # 8-bit unsigned → 有符号
            max_val = 128.0
        elif sampwidth == 2:
            samples = struct.unpack(f'<{total}h', frames)
            max_val = 32768.0
        elif sampwidth == 4:
            samples = struct.unpack(f'<{total}i', frames)
            max_val = 2147483648.0
        else:
            logger.warning(f"不支持的采样宽度: {sampwidth}")
            return []
    except struct.error as e:
        logger.warning(f"样本解包失败: {e}")
        return []

    # 多声道取第 0 声道
    if n_channels > 1:
        samples = samples[::n_channels]

    block = max(1, len(samples) // peaks_count)
    peaks = []
    for i in range(0, len(samples), block):
        chunk = samples[i:i + block]
        if chunk:
            peaks.append(round(max(abs(s) for s in chunk) / max_val, 5))
    return peaks


def detect_silence(video_path, threshold=-30, min_duration=1.0):
    """
    用 FFmpeg silencedetect 过滤器检测静音段。

    :param video_path: 视频文件路径
    :param threshold: 静音阈值（dB），默认 -30
    :param min_duration: 最小静音时长（秒），默认 1.0
    :return: [{'start': float, 'end': float}, ...]；未装 ffmpeg 返回 []
    """
    if not _have('ffmpeg'):
        logger.warning("系统未安装 ffmpeg，返回空静音段列表")
        return []

    cmd = [
        'ffmpeg', '-i', video_path,
        '-af', f'silencedetect=noise={threshold}dB:d={min_duration}',
        '-f', 'null', '-',
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        logger.warning("ffmpeg silencedetect 超时")
        return []
    except Exception as e:
        logger.warning(f"ffmpeg silencedetect 异常: {e}")
        return []

    stderr = proc.stderr or ''
    starts = []
    ends = []
    for line in stderr.splitlines():
        m = re.search(r'silence_start:\s*([\d.]+)', line)
        if m:
            starts.append(float(m.group(1)))
            continue
        m = re.search(r'silence_end:\s*([\d.]+)', line)
        if m:
            ends.append(float(m.group(1)))

    segments = []
    for i, s in enumerate(starts):
        if i < len(ends):
            segments.append({'start': round(s, 3), 'end': round(ends[i], 3)})
        else:
            segments.append({'start': round(s, 3), 'end': round(s + min_duration, 3)})
    return segments
