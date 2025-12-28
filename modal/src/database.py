"""
D1 database client for Strollcast.

Uses Cloudflare API to insert/update episodes in the D1 database.
"""

import json
import os
from datetime import datetime

import httpx


# D1 database configuration
CLOUDFLARE_ACCOUNT_ID = "24828d2a24b818aa2e994213d8a562c6"
D1_DATABASE_ID = "9c9e8c33-9960-46d2-a092-7a7a239a5c5e"


def get_d1_client():
    """Get HTTP client configured for Cloudflare API."""
    api_token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not api_token:
        raise ValueError("CLOUDFLARE_API_TOKEN environment variable not set")

    return httpx.Client(
        base_url=f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/d1/database/{D1_DATABASE_ID}",
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        timeout=30,
    )


def upsert_episode(episode: dict) -> dict:
    """
    Insert or update an episode in the D1 database.

    Args:
        episode: Episode data with keys:
            - id: Episode ID (e.g., "pytorch-fsdp-2023")
            - title: Episode title
            - authors: Author string (e.g., "Zhao et al.")
            - year: Publication year
            - description: Episode description
            - duration: Duration string (e.g., "24 min")
            - duration_seconds: Duration in seconds
            - audio_url: Full URL to audio file
            - transcript_url: Full URL to VTT file (optional)
            - paper_url: arXiv URL (optional)
            - topics: List of topic strings (optional)

    Returns:
        API response dict
    """
    client = get_d1_client()

    # Convert topics list to JSON string
    topics_json = json.dumps(episode.get("topics", [])) if episode.get("topics") else None

    now = datetime.utcnow().isoformat() + "Z"

    # Use INSERT OR REPLACE for upsert behavior
    sql = """
        INSERT OR REPLACE INTO episodes (
            id, title, authors, year, description, duration, duration_seconds,
            audio_url, transcript_url, paper_url, topics, created_at, updated_at, published
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            COALESCE((SELECT created_at FROM episodes WHERE id = ?), ?),
            ?, 1)
    """

    params = [
        episode["id"],
        episode["title"],
        episode["authors"],
        episode["year"],
        episode["description"],
        episode["duration"],
        episode.get("duration_seconds"),
        episode["audio_url"],
        episode.get("transcript_url"),
        episode.get("paper_url"),
        topics_json,
        episode["id"],  # For COALESCE subquery
        now,  # created_at default
        now,  # updated_at
    ]

    response = client.post("/query", json={"sql": sql, "params": params})
    response.raise_for_status()

    result = response.json()
    if not result.get("success"):
        raise ValueError(f"D1 query failed: {result.get('errors', 'Unknown error')}")

    return result
