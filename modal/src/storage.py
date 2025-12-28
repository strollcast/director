"""
R2 storage client for Strollcast.

Provides functions to read/write audio segments and episode files to Cloudflare R2.
"""

import os
from functools import lru_cache

import boto3
from botocore.exceptions import ClientError


# Bucket names
CACHE_BUCKET = "strollcast-cache"
OUTPUT_BUCKET = "strollcast-output"


@lru_cache(maxsize=1)
def get_r2_client():
    """Get an S3-compatible client for Cloudflare R2."""
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )


def get_cached_segment(cache_key: str) -> bytes | None:
    """
    Retrieve a cached audio segment from R2.

    Args:
        cache_key: SHA256 hash of segment parameters

    Returns:
        Audio bytes if found, None if not cached
    """
    client = get_r2_client()
    key = f"segments/{cache_key}.mp3"

    try:
        response = client.get_object(Bucket=CACHE_BUCKET, Key=key)
        return response["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchKey":
            return None
        raise


def save_cached_segment(cache_key: str, audio_data: bytes) -> None:
    """
    Save an audio segment to R2 cache.

    Args:
        cache_key: SHA256 hash of segment parameters
        audio_data: Normalized MP3 audio bytes
    """
    client = get_r2_client()
    key = f"segments/{cache_key}.mp3"

    client.put_object(
        Bucket=CACHE_BUCKET,
        Key=key,
        Body=audio_data,
        ContentType="audio/mpeg",
    )


def upload_episode(episode_name: str, audio_data: bytes) -> str:
    """
    Upload final episode audio to R2 output bucket.

    Args:
        episode_name: Episode folder name (e.g., "zhao-2023-pytorch-fsdp")
        audio_data: Final M4A audio bytes

    Returns:
        Public URL of the uploaded file
    """
    client = get_r2_client()
    key = f"episodes/{episode_name}.m4a"

    client.put_object(
        Bucket=OUTPUT_BUCKET,
        Key=key,
        Body=audio_data,
        ContentType="audio/mp4",
    )

    # Return the public URL (assumes public access is configured)
    public_domain = os.environ.get("R2_PUBLIC_DOMAIN", f"{OUTPUT_BUCKET}.r2.dev")
    return f"https://{public_domain}/{key}"


def upload_transcript(podcast_id: str, vtt_content: str) -> str:
    """
    Upload WebVTT transcript to R2 output bucket.

    Args:
        podcast_id: Podcast identifier (e.g., "pytorch-fsdp-2023")
        vtt_content: WebVTT formatted transcript

    Returns:
        Public URL of the uploaded file
    """
    client = get_r2_client()
    key = f"api/{podcast_id}.vtt"

    client.put_object(
        Bucket=OUTPUT_BUCKET,
        Key=key,
        Body=vtt_content.encode("utf-8"),
        ContentType="text/vtt",
    )

    public_domain = os.environ.get("R2_PUBLIC_DOMAIN", f"{OUTPUT_BUCKET}.r2.dev")
    return f"https://{public_domain}/{key}"


