#!/usr/bin/env python3
"""
Generate podcast audio using ElevenLabs for realistic voices.
Uses ffmpeg for audio processing (no pydub dependency).
"""

import os
import re
import subprocess
import tempfile
from pathlib import Path
from elevenlabs import ElevenLabs

# Configuration - set ELEVENLABS_API_KEY environment variable
API_KEY = os.environ.get("ELEVENLABS_API_KEY")
if not API_KEY:
    raise ValueError("Please set ELEVENLABS_API_KEY environment variable")

# ElevenLabs voice IDs - using pre-made voices
ALEX_VOICE = "pNInz6obpgDQGcFmaJgB"  # Adam - deep male voice
MAYA_VOICE = "21m00Tcm4TlvDq8ikWAM"  # Rachel - clear female voice

# Use script directory as base
SCRIPT_DIR = Path(__file__).parent.resolve()
TEMP_DIR = SCRIPT_DIR / "temp_segments"

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

        # Match speaker lines: **ALEX:** or **MAYA:**
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

            if text and speaker in ['ALEX', 'MAYA']:
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
    """Generate audio using ElevenLabs API."""
    try:
        audio_generator = client.text_to_speech.convert(
            voice_id=voice_id,
            text=text,
            model_id="eleven_turbo_v2_5",
            voice_settings={
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.0,
                "use_speaker_boost": True
            }
        )

        # Collect all chunks from the generator
        audio_data = b''.join(chunk for chunk in audio_generator)

        with open(output_path, 'wb') as f:
            f.write(audio_data)

        return True
    except Exception as e:
        print(f"\nError generating audio: {e}")
        return False

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

def concatenate_with_ffmpeg(audio_files, output_path):
    """Concatenate audio files using ffmpeg."""
    # Create a file list for ffmpeg
    list_file = TEMP_DIR / "filelist.txt"
    with open(list_file, 'w') as f:
        for audio_file in audio_files:
            # Add the audio file
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
    print("=" * 60)
    print("ZeRO Paper Podcast Generator (ElevenLabs)")
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
    TEMP_DIR.mkdir(exist_ok=True)

    # Parse the podcast script
    print("\n[2/5] Parsing podcast script...")
    script_path = SCRIPT_DIR / "script.md"
    segments = parse_podcast_script(script_path)
    print(f"      Found {len(segments)} segments")

    # Calculate total characters
    total_chars = sum(len(s['text']) for s in segments if s['text'])
    print(f"      Total characters to synthesize: {total_chars:,}")

    # Generate audio for each segment
    print("\n[3/5] Generating audio segments with ElevenLabs...")
    print("      (This may take several minutes)")

    audio_files = []
    total = len(segments)

    for i, segment in enumerate(segments):
        speaker = segment['speaker']
        text = segment['text']

        output_path = TEMP_DIR / f"segment_{i:04d}.mp3"

        if speaker == 'PAUSE':
            # Create silence file
            generate_silence(output_path, 800)
            audio_files.append(output_path)
        else:
            voice_id = ALEX_VOICE if speaker == 'ALEX' else MAYA_VOICE

            if generate_audio_elevenlabs(client, text, voice_id, output_path):
                audio_files.append(output_path)
                # Add a small pause after each segment
                pause_path = TEMP_DIR / f"pause_{i:04d}.mp3"
                generate_silence(pause_path, 300)
                audio_files.append(pause_path)

        # Progress indicator
        pct = (i + 1) * 100 // total
        bar = '#' * (pct // 5) + '-' * (20 - pct // 5)
        print(f"\r      [{bar}] {pct}% ({i+1}/{total})", end='', flush=True)

    print(f"\n      Generated {len(audio_files)} audio files")

    # Combine all segments
    print("\n[4/5] Combining audio segments with ffmpeg...")
    m4a_output = SCRIPT_DIR / "podcast.m4a"

    if concatenate_with_ffmpeg(audio_files, m4a_output):
        print(f"      Created: {m4a_output.name}")
    else:
        print("      Error combining audio files")
        return

    # Get duration
    duration_seconds = get_audio_duration(m4a_output)
    duration_minutes = duration_seconds / 60
    size_mb = m4a_output.stat().st_size / (1024 * 1024)

    print(f"      Duration: {duration_minutes:.1f} minutes")
    print(f"      Size: {size_mb:.1f} MB")

    # Cleanup temp files
    print("\n[5/5] Cleaning up temporary files...")
    for f in TEMP_DIR.glob("*.mp3"):
        f.unlink()
    for f in TEMP_DIR.glob("*.txt"):
        f.unlink()
    TEMP_DIR.rmdir()

    print("\n" + "=" * 60)
    print("COMPLETE!")
    print("=" * 60)
    print(f"\nPodcast saved to: {m4a_output}")
    print(f"Duration: {duration_minutes:.1f} minutes")
    print(f"Size: {size_mb:.1f} MB")
    print("\nTo transfer to iPhone:")
    print("  - AirDrop the file to your iPhone")
    print("  - Or upload to iCloud Drive")

if __name__ == "__main__":
    main()
