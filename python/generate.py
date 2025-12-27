#!/usr/bin/env python3
"""
Generate podcast audio from a script.

Supports two TTS backends:
- macOS: Uses built-in 'say' command (free, fast, for previewing)
- ElevenLabs: High-quality AI voices (requires API key)

Usage:
    python generate.py <episode-folder>              # ElevenLabs (production)
    python generate.py <episode-folder> --preview    # macOS TTS (preview)

Example:
    python generate.py ../public/zhao-2023-pytorch-fsdp --preview
    python generate.py ../public/zhao-2023-pytorch-fsdp
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

# macOS TTS voices
MACOS_ERIC_VOICE = "Daniel"   # British male
MACOS_MAYA_VOICE = "Samantha" # American female

# ElevenLabs voice IDs
ELEVENLABS_ERIC_VOICE = "gP8LZQ3GGokV0MP5JYjg"  # Eric - male voice
ELEVENLABS_MAYA_VOICE = "21m00Tcm4TlvDq8ikWAM"  # Rachel - clear female voice

# Cache directory and model settings
CACHE_DIR = Path(__file__).parent / ".cache"
MODEL_ID = "eleven_turbo_v2_5"


def get_cache_key(text, voice_id):
    """Generate a cache key based on text, voice, and model settings."""
    cache_data = json.dumps({
        "text": text,
        "voice_id": voice_id,
        "model_id": MODEL_ID,
        "stability": 0.5,
        "similarity_boost": 0.75,
        "style": 0.0,
    }, sort_keys=True)
    return hashlib.sha256(cache_data.encode()).hexdigest()


def get_cached_audio(cache_key):
    """Check if audio exists in cache and return path if so."""
    cache_path = CACHE_DIR / f"{cache_key}.mp3"
    if cache_path.exists():
        return cache_path
    return None


def save_to_cache(cache_key, audio_data):
    """Save audio data to cache."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_path = CACHE_DIR / f"{cache_key}.mp3"
    with open(cache_path, 'wb') as f:
        f.write(audio_data)
    return cache_path


def parse_podcast_script(filepath):
    """Parse the podcast markdown and extract speaker segments."""
    with open(filepath, 'r') as f:
        content = f.read()

    segments = []
    lines = content.split('\n')

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Match speaker lines: **ERIC:** or **MAYA:**
        speaker_match = re.match(r'\*\*([A-Z]+):\*\*\s*(.*)', line)
        if speaker_match:
            speaker = speaker_match.group(1)
            text = speaker_match.group(2)

            # Clean up the text - remove markdown formatting and source annotations
            text = re.sub(r'\{\{src:[^}]+\}\}', '', text)  # Remove {{src:...}} annotations
            text = re.sub(r'\*\*\[.*?\]\*\*', '', text)  # Remove bold brackets
            text = re.sub(r'\[.*?\]', '', text)  # Remove brackets
            text = text.replace('**', '')  # Remove remaining bold markers
            text = text.replace('*', '')   # Remove italic markers
            text = text.strip()

            if text and speaker in ['ERIC', 'MAYA']:
                segments.append({
                    'speaker': speaker,
                    'text': text
                })

        # Add pause for section headers
        elif line.startswith('## ['):
            segments.append({
                'speaker': 'PAUSE',
                'text': None
            })

    return segments


def generate_audio_macos(text, voice, output_path):
    """Generate audio using macOS 'say' command."""
    # Generate AIFF first, then convert to MP3
    aiff_path = output_path.with_suffix('.aiff')

    cmd_say = ['say', '-v', voice, '-o', str(aiff_path), text]
    result = subprocess.run(cmd_say, capture_output=True)

    if result.returncode != 0:
        return False

    # Convert to MP3 using ffmpeg
    cmd_convert = [
        'ffmpeg', '-y', '-i', str(aiff_path),
        '-c:a', 'libmp3lame', '-q:a', '2',
        str(output_path)
    ]
    result = subprocess.run(cmd_convert, capture_output=True)

    # Clean up AIFF
    if aiff_path.exists():
        aiff_path.unlink()

    return result.returncode == 0


def generate_audio_elevenlabs(client, text, voice_id, output_path):
    """Generate audio using ElevenLabs API with caching."""
    cache_key = get_cache_key(text, voice_id)

    # Check cache first
    cached_path = get_cached_audio(cache_key)
    if cached_path:
        shutil.copy(cached_path, output_path)
        return "cached"

    # Generate new audio via API
    try:
        audio_generator = client.text_to_speech.convert(
            voice_id=voice_id,
            text=text,
            model_id=MODEL_ID,
            voice_settings={
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True
            }
        )

        # Collect all chunks from the generator
        audio_data = b''.join(chunk for chunk in audio_generator)

        # Save to cache
        save_to_cache(cache_key, audio_data)

        # Write to output
        with open(output_path, 'wb') as f:
            f.write(audio_data)

        return "generated"
    except Exception as e:
        print(f"\nError generating audio: {e}")
        return None


def generate_silence(output_path, duration_ms=500):
    """Generate a silent audio file using ffmpeg."""
    cmd = [
        'ffmpeg', '-y', '-f', 'lavfi',
        '-i', f'anullsrc=r=44100:cl=mono',
        '-t', str(duration_ms / 1000),
        '-c:a', 'libmp3lame',
        str(output_path)
    ]
    subprocess.run(cmd, capture_output=True)


def concatenate_with_ffmpeg(audio_files, output_path, temp_dir):
    """Concatenate audio files using ffmpeg."""
    # Create a file list for ffmpeg
    list_file = temp_dir / "filelist.txt"
    with open(list_file, 'w') as f:
        for audio_file in audio_files:
            f.write(f"file '{audio_file}'\n")

    # Use ffmpeg to concatenate
    cmd = [
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0',
        '-i', str(list_file),
        '-c:a', 'aac', '-b:a', '128k',
        str(output_path)
    ]
    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0


def get_audio_duration(filepath):
    """Get audio duration using ffprobe."""
    cmd = [
        'ffprobe', '-v', 'error', '-show_entries',
        'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1',
        str(filepath)
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return float(result.stdout.strip())
    except:
        return 0


def format_vtt_timestamp(seconds):
    """Format seconds as VTT timestamp (HH:MM:SS.mmm)."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def generate_webvtt(segments_with_timing, output_path):
    """Generate a WebVTT transcript file with speaker labels.

    Args:
        segments_with_timing: List of dicts with 'speaker', 'text', 'start', 'end'
        output_path: Path to save the VTT file
    """
    lines = ["WEBVTT", ""]

    for i, segment in enumerate(segments_with_timing):
        if segment['speaker'] == 'PAUSE':
            continue

        start = format_vtt_timestamp(segment['start'])
        end = format_vtt_timestamp(segment['end'])
        speaker = segment['speaker'].capitalize()  # Eric, Maya
        text = segment['text']

        lines.append(f"{i + 1}")
        lines.append(f"{start} --> {end}")
        lines.append(f"<v {speaker}>{text}")
        lines.append("")

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    return output_path


def analyze_loudness(filepath):
    """Analyze audio loudness using ffmpeg loudnorm filter (first pass)."""
    cmd = [
        'ffmpeg', '-i', str(filepath), '-af',
        'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
        '-f', 'null', '-'
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    # Parse the JSON output from stderr
    output = result.stderr
    # Find the JSON block in the output
    json_start = output.rfind('{')
    json_end = output.rfind('}') + 1
    if json_start != -1 and json_end > json_start:
        try:
            return json.loads(output[json_start:json_end])
        except json.JSONDecodeError:
            return None
    return None


def normalize_audio(input_path, output_path, stats=None):
    """Normalize audio using ffmpeg loudnorm filter (two-pass for accuracy).

    Target: -16 LUFS (podcast standard)
    """
    if stats is None:
        # Single-pass mode (less accurate but faster)
        cmd = [
            'ffmpeg', '-y', '-i', str(input_path), '-af',
            'loudnorm=I=-16:TP=-1.5:LRA=11',
            '-c:a', 'libmp3lame', '-q:a', '2',
            str(output_path)
        ]
    else:
        # Two-pass mode with measured stats (more accurate)
        measured_i = stats.get('input_i', '-24')
        measured_tp = stats.get('input_tp', '-2')
        measured_lra = stats.get('input_lra', '7')
        measured_thresh = stats.get('input_thresh', '-34')
        offset = stats.get('target_offset', '0')

        cmd = [
            'ffmpeg', '-y', '-i', str(input_path), '-af',
            f'loudnorm=I=-16:TP=-1.5:LRA=11:'
            f'measured_I={measured_i}:measured_TP={measured_tp}:'
            f'measured_LRA={measured_lra}:measured_thresh={measured_thresh}:'
            f'offset={offset}:linear=true',
            '-c:a', 'libmp3lame', '-q:a', '2',
            str(output_path)
        ]

    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0


def normalize_and_reassemble(episode_dir, script_path):
    """Reassemble podcast from cache with normalized audio (no API calls)."""
    episode_name = episode_dir.name
    temp_dir = episode_dir / "temp_segments"

    print("=" * 60)
    print(f"Normalize & Reassemble: {episode_name}")
    print("=" * 60)

    # Parse the podcast script
    print("\n[1/5] Parsing podcast script...")
    segments = parse_podcast_script(script_path)
    speech_segments = [s for s in segments if s['speaker'] in ['ERIC', 'MAYA']]
    print(f"      Found {len(segments)} segments ({len(speech_segments)} speech)")

    # Verify all segments are cached before proceeding
    print("\n[2/5] Verifying cache...")
    missing = []
    for i, segment in enumerate(segments):
        if segment['speaker'] in ['ERIC', 'MAYA']:
            voice_id = ELEVENLABS_ERIC_VOICE if segment['speaker'] == 'ERIC' else ELEVENLABS_MAYA_VOICE
            cache_key = get_cache_key(segment['text'], voice_id)
            if not get_cached_audio(cache_key):
                missing.append((i, segment['speaker'], segment['text'][:50]))

    if missing:
        print(f"      ERROR: {len(missing)} segments missing from cache:")
        for i, speaker, text in missing[:5]:
            print(f"        - Segment {i} ({speaker}): {text}...")
        if len(missing) > 5:
            print(f"        ... and {len(missing) - 5} more")
        print("\n      Run without --normalize first to generate missing segments.")
        return 1

    print(f"      All {len(speech_segments)} speech segments found in cache")

    # Create temp directory
    temp_dir.mkdir(exist_ok=True)

    # Analyze and normalize audio segments
    print("\n[3/6] Analyzing and normalizing audio segments...")
    print("      (Two-pass loudnorm to -16 LUFS)")

    audio_files = []
    segments_with_timing = []
    total = len(segments)
    current_time = 0.0

    for i, segment in enumerate(segments):
        speaker = segment['speaker']
        text = segment['text']

        if speaker == 'PAUSE':
            pause_path = temp_dir / f"segment_{i:04d}.mp3"
            generate_silence(pause_path, 800)
            audio_files.append(pause_path)
            current_time += 0.8  # 800ms pause
        else:
            voice_id = ELEVENLABS_ERIC_VOICE if speaker == 'ERIC' else ELEVENLABS_MAYA_VOICE
            cache_key = get_cache_key(text, voice_id)
            cached_path = get_cached_audio(cache_key)

            # Normalize the cached audio
            normalized_path = temp_dir / f"segment_{i:04d}.mp3"

            # Two-pass normalization: analyze then normalize
            stats = analyze_loudness(cached_path)
            if stats:
                normalize_audio(cached_path, normalized_path, stats)
            else:
                # Fall back to single-pass if analysis fails
                normalize_audio(cached_path, normalized_path)

            audio_files.append(normalized_path)
            segment_duration = get_audio_duration(normalized_path)
            segments_with_timing.append({
                'speaker': speaker,
                'text': text,
                'start': current_time,
                'end': current_time + segment_duration
            })
            current_time += segment_duration

            # Add a small pause after each segment
            pause_path = temp_dir / f"pause_{i:04d}.mp3"
            generate_silence(pause_path, 300)
            audio_files.append(pause_path)
            current_time += 0.3  # 300ms pause

        # Progress indicator
        pct = (i + 1) * 100 // total
        bar = '#' * (pct // 5) + '-' * (20 - pct // 5)
        print(f"\r      [{bar}] {pct}% ({i+1}/{total})", end='', flush=True)

    print(f"\n      Normalized {len(audio_files)} audio files")

    # Combine all segments
    print("\n[4/6] Combining normalized audio segments...")
    m4a_output = episode_dir / f"{episode_name}.m4a"

    if concatenate_with_ffmpeg(audio_files, m4a_output, temp_dir):
        print(f"      Created: {m4a_output.name}")
    else:
        print("      Error combining audio files")
        return 1

    # Get duration
    duration_seconds = get_audio_duration(m4a_output)
    duration_minutes = duration_seconds / 60
    size_mb = m4a_output.stat().st_size / (1024 * 1024)

    print(f"      Duration: {duration_minutes:.1f} minutes")
    print(f"      Size: {size_mb:.1f} MB")

    # Generate WebVTT transcript
    print("\n[5/6] Generating WebVTT transcript...")
    folder_parts = episode_name.split('-')
    if len(folder_parts) >= 3:
        author = folder_parts[0]
        year = folder_parts[1]
        name = '-'.join(folder_parts[2:])
        podcast_id = f"{name}-{year}"
    else:
        podcast_id = episode_name

    api_dir = episode_dir.parent / "api"
    api_dir.mkdir(exist_ok=True)
    vtt_output = api_dir / f"{podcast_id}.vtt"
    generate_webvtt(segments_with_timing, vtt_output)
    print(f"      Created: {vtt_output}")

    # Cleanup temp files
    print("\n[6/6] Cleaning up temporary files...")
    for f in temp_dir.glob("*.mp3"):
        f.unlink()
    for f in temp_dir.glob("*.txt"):
        f.unlink()
    temp_dir.rmdir()

    print("\n" + "=" * 60)
    print("COMPLETE!")
    print("=" * 60)
    print(f"\nNormalized podcast saved to: {m4a_output}")
    print(f"Transcript saved to: {vtt_output}")
    print(f"Duration: {duration_minutes:.1f} minutes")
    print(f"Size: {size_mb:.1f} MB")

    return 0


def main():
    parser = argparse.ArgumentParser(
        description='Generate podcast audio from a script.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python generate.py ../public/zhao-2023-pytorch-fsdp --preview    # Fast preview with macOS TTS
  python generate.py ../public/zhao-2023-pytorch-fsdp              # Production with ElevenLabs
  python generate.py ../public/zhao-2023-pytorch-fsdp --normalize  # Reassemble from cache with normalization
        """
    )
    parser.add_argument(
        'episode_folder',
        help='Path to the episode folder containing script.md'
    )
    parser.add_argument(
        '--preview',
        action='store_true',
        help='Use macOS TTS for quick preview (no API key needed)'
    )
    parser.add_argument(
        '--normalize',
        action='store_true',
        help='Reassemble podcast from cache with audio normalization (no API calls)'
    )
    args = parser.parse_args()

    episode_dir = Path(args.episode_folder).resolve()
    script_path = episode_dir / "script.md"
    temp_dir = episode_dir / "temp_segments"

    if not episode_dir.exists():
        print(f"Error: Episode folder not found: {episode_dir}")
        return 1

    if not script_path.exists():
        print(f"Error: Script not found: {script_path}")
        return 1

    # Handle normalize mode (reassemble from cache with normalization)
    if args.normalize:
        return normalize_and_reassemble(episode_dir, script_path)

    episode_name = episode_dir.name
    use_macos = args.preview

    print("=" * 60)
    print(f"Podcast Generator: {episode_name}")
    print(f"Backend: {'macOS TTS (preview)' if use_macos else 'ElevenLabs'}")
    print("=" * 60)

    # Initialize ElevenLabs client if needed
    client = None
    if not use_macos:
        api_key = os.environ.get("ELEVENLABS_API_KEY")
        if not api_key:
            print("\nError: ELEVENLABS_API_KEY not set.")
            print("Use --preview for macOS TTS, or set the API key.")
            return 1

        from elevenlabs import ElevenLabs
        print("\n[1/5] Initializing ElevenLabs client...")
        client = ElevenLabs(api_key=api_key)

        # Check available characters
        try:
            subscription = client.user.get_subscription()
            print(f"      Character limit: {subscription.character_count}/{subscription.character_limit}")
            remaining = subscription.character_limit - subscription.character_count
            print(f"      Remaining: {remaining:,} characters")
        except Exception as e:
            print(f"      Could not fetch subscription info: {e}")
    else:
        print("\n[1/5] Using macOS TTS (no API key needed)...")

    # Create temp directory
    temp_dir.mkdir(exist_ok=True)

    # Parse the podcast script
    print("\n[2/5] Parsing podcast script...")
    segments = parse_podcast_script(script_path)
    print(f"      Found {len(segments)} segments")

    # Calculate total characters
    total_chars = sum(len(s['text']) for s in segments if s['text'])
    print(f"      Total characters to synthesize: {total_chars:,}")

    # Generate audio for each segment
    backend_name = "macOS TTS" if use_macos else "ElevenLabs"
    print(f"\n[3/5] Generating audio segments with {backend_name}...")
    if not use_macos:
        print("      (Using cache when available)")

    audio_files = []
    segments_with_timing = []
    total = len(segments)
    cache_hits = 0
    api_calls = 0
    current_time = 0.0

    for i, segment in enumerate(segments):
        speaker = segment['speaker']
        text = segment['text']

        output_path = temp_dir / f"segment_{i:04d}.mp3"

        if speaker == 'PAUSE':
            generate_silence(output_path, 800)
            audio_files.append(output_path)
            current_time += 0.8  # 800ms pause
        else:
            if use_macos:
                voice = MACOS_ERIC_VOICE if speaker == 'ERIC' else MACOS_MAYA_VOICE
                if generate_audio_macos(text, voice, output_path):
                    audio_files.append(output_path)
                    segment_duration = get_audio_duration(output_path)
                    segments_with_timing.append({
                        'speaker': speaker,
                        'text': text,
                        'start': current_time,
                        'end': current_time + segment_duration
                    })
                    current_time += segment_duration
                    # Add a small pause after each segment
                    pause_path = temp_dir / f"pause_{i:04d}.mp3"
                    generate_silence(pause_path, 300)
                    audio_files.append(pause_path)
                    current_time += 0.3  # 300ms pause
            else:
                voice_id = ELEVENLABS_ERIC_VOICE if speaker == 'ERIC' else ELEVENLABS_MAYA_VOICE
                result = generate_audio_elevenlabs(client, text, voice_id, output_path)
                if result:
                    audio_files.append(output_path)
                    segment_duration = get_audio_duration(output_path)
                    segments_with_timing.append({
                        'speaker': speaker,
                        'text': text,
                        'start': current_time,
                        'end': current_time + segment_duration
                    })
                    current_time += segment_duration
                    # Add a small pause after each segment
                    pause_path = temp_dir / f"pause_{i:04d}.mp3"
                    generate_silence(pause_path, 300)
                    audio_files.append(pause_path)
                    current_time += 0.3  # 300ms pause

                    if result == "cached":
                        cache_hits += 1
                    else:
                        api_calls += 1

        # Progress indicator
        pct = (i + 1) * 100 // total
        bar = '#' * (pct // 5) + '-' * (20 - pct // 5)
        print(f"\r      [{bar}] {pct}% ({i+1}/{total})", end='', flush=True)

    print(f"\n      Generated {len(audio_files)} audio files")
    if not use_macos:
        print(f"      Cache hits: {cache_hits}, API calls: {api_calls}")

    # Combine all segments
    print("\n[4/5] Combining audio segments with ffmpeg...")

    # Use different filename for preview
    if use_macos:
        m4a_output = episode_dir / f"{episode_name}-preview.m4a"
    else:
        m4a_output = episode_dir / f"{episode_name}.m4a"

    if concatenate_with_ffmpeg(audio_files, m4a_output, temp_dir):
        print(f"      Created: {m4a_output.name}")
    else:
        print("      Error combining audio files")
        return 1

    # Get duration
    duration_seconds = get_audio_duration(m4a_output)
    duration_minutes = duration_seconds / 60
    size_mb = m4a_output.stat().st_size / (1024 * 1024)

    print(f"      Duration: {duration_minutes:.1f} minutes")
    print(f"      Size: {size_mb:.1f} MB")

    # Generate WebVTT transcript
    print("\n[5/6] Generating WebVTT transcript...")
    # Determine the podcast ID from folder name (e.g., "qiu-2025-gated-attention" -> "gated-attention-2025")
    folder_parts = episode_name.split('-')
    if len(folder_parts) >= 3:
        # Format: author-year-name -> name-year
        author = folder_parts[0]
        year = folder_parts[1]
        name = '-'.join(folder_parts[2:])
        podcast_id = f"{name}-{year}"
    else:
        podcast_id = episode_name

    # Save VTT to public/api/<podcast_id>.vtt
    api_dir = episode_dir.parent / "api"
    api_dir.mkdir(exist_ok=True)
    vtt_output = api_dir / f"{podcast_id}.vtt"
    generate_webvtt(segments_with_timing, vtt_output)
    print(f"      Created: {vtt_output}")

    # Cleanup temp files
    print("\n[6/6] Cleaning up temporary files...")
    for f in temp_dir.glob("*.mp3"):
        f.unlink()
    for f in temp_dir.glob("*.txt"):
        f.unlink()
    temp_dir.rmdir()

    print("\n" + "=" * 60)
    print("COMPLETE!")
    print("=" * 60)
    print(f"\nPodcast saved to: {m4a_output}")
    print(f"Transcript saved to: {vtt_output}")
    print(f"Duration: {duration_minutes:.1f} minutes")
    print(f"Size: {size_mb:.1f} MB")

    if use_macos:
        print("\nThis is a PREVIEW using macOS TTS.")
        print("For production quality, run without --preview flag.")

    return 0


if __name__ == "__main__":
    exit(main())
