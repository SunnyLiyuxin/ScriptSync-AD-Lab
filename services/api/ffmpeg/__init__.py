"""ffmpeg 工具包：波形提取 + 静音检测"""
from .waveform import extract_waveform, detect_silence

__all__ = ['extract_waveform', 'detect_silence']
