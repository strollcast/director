"""
Podcast episode generator for Strollcast.

Modal functions for generating podcast episodes from scripts.
"""

import hashlib
import json
import os
import re

import modal
from .app import app, VOICES, MODEL_ID, VOICE_SETTINGS, TARGET_LUFS


def compute_cache_key(text: str, voice_id: str) -> str:
    """
    Compute cache key for a segment.

    Must match the key format used in migration script.
    """
    cache_data = json.dumps({
        "text": text,
        "voice_id": voice_id,
        "model_id": MODEL_ID,
        "stability": VOICE_SETTINGS["stability"],
        "similarity_boost": VOICE_SETTINGS["similarity_boost"],
        "style": VOICE_SETTINGS["style"],
        "normalized": True,
        "lufs": TARGET_LUFS,
    }, sort_keys=True)
    return hashlib.sha256(cache_data.encode()).hexdigest()


def parse_script(script_content: str) -> list[dict]:
    """
    Parse podcast script and extract speaker segments.

    Args:
        script_content: Markdown script with **ERIC:** and **MAYA:** tags

    Returns:
        List of segment dicts with 'speaker' and 'text' keys
    """
    segments = []

    for line in script_content.split("\n"):
        line = line.strip()
        if not line:
            continue

        # Match speaker lines: **ERIC:** or **MAYA:**
        speaker_match = re.match(r"\*\*([A-Z]+):\*\*\s*(.*)", line)
        if speaker_match:
            speaker = speaker_match.group(1)
            text = speaker_match.group(2)

            # Clean up markdown and source annotations
            text = re.sub(r"\{\{src:[^}]+\}\}", "", text)  # Remove {{src:...}}
            text = re.sub(r"\*\*\[.*?\]\*\*", "", text)
            text = re.sub(r"\[.*?\]", "", text)
            text = text.replace("**", "").replace("*", "").strip()

            if text and speaker in ["ERIC", "MAYA"]:
                segments.append({"speaker": speaker, "text": text})

        # Add pause for section headers
        elif line.startswith("## ["):
            segments.append({"speaker": "PAUSE", "text": None})

    return segments


@app.function(timeout=60)
def generate_segment(text: str, speaker: str) -> bytes:
    """
    Generate a single audio segment with caching.

    Flow: Check R2 cache → Generate via ElevenLabs → Normalize → Cache → Return

    Args:
        text: Text to synthesize
        speaker: Speaker name ("ERIC" or "MAYA")

    Returns:
        Normalized MP3 audio bytes
    """
    from elevenlabs import ElevenLabs
    from .audio import normalize_audio
    from .storage import get_cached_segment, save_cached_segment

    voice_id = VOICES[speaker]
    cache_key = compute_cache_key(text, voice_id)

    # Check cache first
    cached = get_cached_segment(cache_key)
    if cached:
        return cached

    # Generate via ElevenLabs
    client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])

    audio_generator = client.text_to_speech.convert(
        voice_id=voice_id,
        text=text,
        model_id=MODEL_ID,
        voice_settings=VOICE_SETTINGS,
    )
    raw_audio = b"".join(audio_generator)

    # Normalize before caching
    normalized_audio = normalize_audio(raw_audio, TARGET_LUFS)

    # Save to cache
    save_cached_segment(cache_key, normalized_audio)

    return normalized_audio


@app.function(timeout=900)  # 15 minutes for full episode
def generate_episode(script_content: str, episode_name: str) -> dict:
    """
    Generate a complete podcast episode.

    Args:
        script_content: Markdown script content
        episode_name: Episode folder name (e.g., "zhao-2023-pytorch-fsdp")

    Returns:
        Dict with audio_url, vtt_url, duration, and segment stats
    """
    from .audio import (
        generate_silence,
        get_audio_duration,
        concatenate_segments,
        generate_webvtt,
    )
    from .storage import (
        get_cached_segment,
        upload_episode,
        upload_transcript,
    )

    # Parse script
    segments = parse_script(script_content)
    if not segments:
        raise ValueError("No valid segments found in script")

    # Generate all segments
    audio_segments = []
    timing_info = []
    current_time = 0.0

    cache_hits = 0
    api_calls = 0

    for segment in segments:
        if segment["speaker"] == "PAUSE":
            # Generate 800ms silence for section breaks
            silence = generate_silence(800)
            audio_segments.append(silence)
            current_time += 0.8
        else:
            # Check if cached (for stats)
            voice_id = VOICES[segment["speaker"]]
            cache_key = compute_cache_key(segment["text"], voice_id)
            was_cached = get_cached_segment(cache_key) is not None

            # Generate segment (will use cache if available)
            audio = generate_segment.remote(segment["text"], segment["speaker"])
            audio_segments.append(audio)

            # Track timing for VTT
            duration = get_audio_duration(audio)
            timing_info.append({
                "speaker": segment["speaker"],
                "text": segment["text"],
                "start": current_time,
                "end": current_time + duration,
            })
            current_time += duration

            # Add 300ms pause after each segment
            pause = generate_silence(300)
            audio_segments.append(pause)
            current_time += 0.3

            # Track stats
            if was_cached:
                cache_hits += 1
            else:
                api_calls += 1

    # Concatenate all segments
    final_audio = concatenate_segments(audio_segments)

    # Generate VTT transcript
    vtt_content = generate_webvtt(timing_info)

    # Derive podcast_id from episode_name
    # Format: author-year-name -> name-year
    parts = episode_name.split("-")
    if len(parts) >= 3:
        name = "-".join(parts[2:])
        year = parts[1]
        podcast_id = f"{name}-{year}"
    else:
        podcast_id = episode_name

    # Upload to R2
    audio_url = upload_episode(episode_name, final_audio)
    vtt_url = upload_transcript(podcast_id, vtt_content)

    return {
        "audio_url": audio_url,
        "vtt_url": vtt_url,
        "duration_seconds": current_time,
        "duration_minutes": round(current_time / 60, 1),
        "segment_count": len([s for s in segments if s["speaker"] != "PAUSE"]),
        "cache_hits": cache_hits,
        "api_calls": api_calls,
    }


@app.function(timeout=900)
@modal.web_endpoint(method="POST")
def generate_episode_web(data: dict) -> dict:
    """
    Web endpoint for episode generation (called from Cloudflare Worker).

    Expected data:
    {
        "script_content": "**ERIC:** Hello...",
        "metadata": {
            "id": "paper-2024",
            "title": "Paper Title",
            "authors": "Author et al.",
            "year": 2024,
            "description": "Paper description",
            "paper_url": "https://arxiv.org/abs/...",
            "topics": ["Topic1", "Topic2"]
        }
    }
    """
    from .database import upsert_episode

    script_content = data.get("script_content")
    metadata = data.get("metadata")

    if not script_content:
        return {"error": "script_content is required"}
    if not metadata:
        return {"error": "metadata is required"}

    # Derive episode_name from metadata
    # Format: first_author_lastname-year-short_title
    authors = metadata.get("authors", "unknown")
    first_author = authors.split(",")[0].split(" and ")[0].strip()
    last_name = first_author.split()[-1].lower() if first_author else "unknown"
    year = metadata.get("year", 2024)
    title_slug = metadata.get("id", "episode").split("-")[0]
    episode_name = f"{last_name}-{year}-{title_slug}"

    # Generate episode
    result = generate_episode.local(script_content, episode_name)

    # Update database
    duration_mins = int(result["duration_minutes"])
    duration_str = f"{duration_mins} min"

    episode_data = {
        "id": metadata["id"],
        "title": metadata["title"],
        "authors": metadata.get("authors", "Unknown"),
        "year": metadata.get("year", 2024),
        "description": metadata.get("description", ""),
        "duration": duration_str,
        "duration_seconds": int(result["duration_seconds"]),
        "audio_url": result["audio_url"],
        "transcript_url": result["vtt_url"],
        "paper_url": metadata.get("paper_url"),
        "topics": metadata.get("topics", []),
    }

    upsert_episode(episode_data)

    return {
        "episode_id": metadata["id"],
        "audio_url": result["audio_url"],
        "vtt_url": result["vtt_url"],
        "duration_seconds": result["duration_seconds"],
    }


@app.local_entrypoint()
def main(
    script_path: str = None,
    episode_name: str = None,
    metadata_path: str = None,
    skip_db: bool = False,
):
    """
    CLI entrypoint for episode generation.

    Usage:
        modal run -m src.generator \\
            --script-path ./script.md \\
            --episode-name zhao-2023-pytorch-fsdp \\
            --metadata-path ./metadata.json

    The metadata.json file should contain:
    {
        "id": "pytorch-fsdp-2023",
        "title": "PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel",
        "authors": "Zhao et al.",
        "year": 2023,
        "description": "Meta's production experiences...",
        "paper_url": "https://arxiv.org/abs/2304.11277",
        "topics": ["Distributed Training", "Memory Optimization", "PyTorch"]
    }

    Args:
        script_path: Path to script.md file
        episode_name: Episode folder name (derived from path if not provided)
        metadata_path: Path to JSON file with episode metadata
        skip_db: Skip D1 database update (just generate audio)
    """
    if not script_path:
        print("Error: --script-path is required")
        print("Usage: modal run -m src.generator --script-path <path> --metadata-path <path>")
        return

    from pathlib import Path

    script_file = Path(script_path)
    if not script_file.exists():
        print(f"Error: Script not found: {script_path}")
        return

    # Derive episode name from path if not provided
    if not episode_name:
        episode_name = script_file.parent.name

    print(f"Generating episode: {episode_name}")
    print(f"Script: {script_path}")
    print()

    script_content = script_file.read_text()
    result = generate_episode.remote(script_content, episode_name)

    print("=" * 60)
    print("Episode generated successfully!")
    print("=" * 60)
    print(f"Audio:      {result['audio_url']}")
    print(f"Transcript: {result['vtt_url']}")
    print(f"Duration:   {result['duration_minutes']} minutes")
    print(f"Segments:   {result['segment_count']}")
    print(f"Cache hits: {result['cache_hits']}")
    print(f"API calls:  {result['api_calls']}")

    # Update D1 database if metadata provided
    if not skip_db:
        if not metadata_path:
            print()
            print("⚠️  Skipping D1 update: no metadata file provided")
            print("   Provide --metadata-path to update database")
            print("   Or use --skip-db to suppress this warning")
            return

        metadata_file = Path(metadata_path)
        if not metadata_file.exists():
            print(f"Error: Metadata file not found: {metadata_path}")
            return

        metadata = json.loads(metadata_file.read_text())

        # Validate required fields
        required = ["id", "title", "authors", "year", "description"]
        missing = [f for f in required if f not in metadata]
        if missing:
            print(f"Error: Missing required fields in metadata: {missing}")
            return

        from .database import upsert_episode

        # Format duration string
        duration_mins = int(result['duration_minutes'])
        duration_str = f"{duration_mins} min"

        episode_data = {
            "id": metadata["id"],
            "title": metadata["title"],
            "authors": metadata["authors"],
            "year": metadata["year"],
            "description": metadata["description"],
            "duration": duration_str,
            "duration_seconds": int(result['duration_seconds']),
            "audio_url": result['audio_url'],
            "transcript_url": result['vtt_url'],
            "paper_url": metadata.get("paper_url"),
            "topics": metadata.get("topics", []),
        }

        print()
        print("Updating D1 database...")
        upsert_episode(episode_data)
        print(f"✓ Episode '{metadata['id']}' saved to database")
