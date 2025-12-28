"""
Strollcast Modal App - Serverless podcast generation.

This module defines the Modal App and container image used by all functions.
"""

import modal

# Container image with ffmpeg and Python dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "elevenlabs>=1.0.0",
        "boto3>=1.34.0",
        "httpx>=0.27.0",
        "anthropic>=0.40.0",
        "pymupdf>=1.24.0",
    )
)

# Modal App definition
app = modal.App(
    name="strollcast",
    image=image,
    secrets=[
        modal.Secret.from_name("elevenlabs"),
        modal.Secret.from_name("cloudflare-r2"),
        modal.Secret.from_name("cloudflare-d1"),
        modal.Secret.from_name("anthropic"),
    ],
)

# Voice configuration
VOICES = {
    "ERIC": "gP8LZQ3GGokV0MP5JYjg",      # ElevenLabs Eric voice
    "MAYA": "21m00Tcm4TlvDq8ikWAM",       # ElevenLabs Rachel voice
}

MODEL_ID = "eleven_turbo_v2_5"

# ElevenLabs synthesis settings (must match cache key generation)
VOICE_SETTINGS = {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "use_speaker_boost": True,
}

# Audio normalization target
TARGET_LUFS = -16
