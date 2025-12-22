#!/usr/bin/env python3
"""
Generate podcast audio using ElevenLabs for realistic voices.
Uses ffmpeg for audio processing (no pydub dependency).
Caches ElevenLabs API responses locally to save quota.

Usage:
    python generate.py <episode-folder>

Example:
    python generate.py public/zhao-2023-pytorch-fsdp
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from elevenlabs import ElevenLabs

# Configuration - set ELEVENLABS_API_KEY environment variable
API_KEY = os.environ.get("ELEVENLABS_API_KEY")
if not API_KEY:
    raise ValueError("Please set ELEVENLABS_API_KEY environment variable")

# ElevenLabs voice IDs - using pre-made voices
ERIC_VOICE = "gP8LZQ3GGokV0MP5JYjg"  # Eric - male voice
MAYA_VOICE = "21m00Tcm4TlvDq8ikWAM"  # Rachel - clear female voice

# Cache directory
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

            # Clean up the text - remove markdown formatting
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


def main():
    parser = argparse.ArgumentParser(
        description='Generate podcast audio from a script using ElevenLabs.'
    )
    parser.add_argument(
        'episode_folder',
        help='Path to the episode folder containing script.md'
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

    episode_name = episode_dir.name

    print("=" * 60)
    print(f"Podcast Generator: {episode_name}")
    print("=" * 60)

    # Initialize ElevenLabs client
    print("\n[1/5] Initializing ElevenLabs client...")
    client = ElevenLabs(api_key=API_KEY)

    # Check available characters
    try:
        subscription = client.user.get_subscription()
        print(f"      Character limit: {subscription.character_count}/{subscription.character_limit}")
        remaining = subscription.character_limit - subscription.character_count
        print(f"      Remaining: {remaining:,} characters")
    except Exception as e:
        print(f"      Could not fetch subscription info: {e}")

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
    print("\n[3/5] Generating audio segments with ElevenLabs...")
    print("      (Using cache when available)")

    audio_files = []
    total = len(segments)
    cache_hits = 0
    api_calls = 0

    for i, segment in enumerate(segments):
        speaker = segment['speaker']
        text = segment['text']

        output_path = temp_dir / f"segment_{i:04d}.mp3"

        if speaker == 'PAUSE':
            generate_silence(output_path, 800)
            audio_files.append(output_path)
        else:
            voice_id = ERIC_VOICE if speaker == 'ERIC' else MAYA_VOICE

            result = generate_audio_elevenlabs(client, text, voice_id, output_path)
            if result:
                audio_files.append(output_path)
                # Add a small pause after each segment
                pause_path = temp_dir / f"pause_{i:04d}.mp3"
                generate_silence(pause_path, 300)
                audio_files.append(pause_path)

                if result == "cached":
                    cache_hits += 1
                else:
                    api_calls += 1

        # Progress indicator
        pct = (i + 1) * 100 // total
        bar = '#' * (pct // 5) + '-' * (20 - pct // 5)
        print(f"\r      [{bar}] {pct}% ({i+1}/{total})", end='', flush=True)

    print(f"\n      Generated {len(audio_files)} audio files")
    print(f"      Cache hits: {cache_hits}, API calls: {api_calls}")

    # Combine all segments
    print("\n[4/5] Combining audio segments with ffmpeg...")
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

    # Cleanup temp files
    print("\n[5/5] Cleaning up temporary files...")
    for f in temp_dir.glob("*.mp3"):
        f.unlink()
    for f in temp_dir.glob("*.txt"):
        f.unlink()
    temp_dir.rmdir()

    print("\n" + "=" * 60)
    print("COMPLETE!")
    print("=" * 60)
    print(f"\nPodcast saved to: {m4a_output}")
    print(f"Duration: {duration_minutes:.1f} minutes")
    print(f"Size: {size_mb:.1f} MB")
    print("\nTo transfer to iPhone:")
    print("  - AirDrop the file to your iPhone")
    print("  - Or upload to iCloud Drive")

    return 0


if __name__ == "__main__":
    exit(main())
