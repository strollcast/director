# Paper Reference URLs for Intra-Episode Links

## Overview

Design for URL format used in VTT transcripts to link between episodes. Links reference papers by their canonical identifier (DOI/arXiv ID) rather than Strollcast episode IDs, enabling:

1. Links to papers before their episodes are generated
2. Stable identifiers tied to the paper's identity, not Strollcast internals
3. Web fallback showing paper info when episode doesn't exist yet

## Problem Statement

Current VTT links use direct audio URLs:
```
[attention paper](https://released.strollcast.com/episodes/vaswani-2017-attention/vaswani-2017-attention.mp3)
```

**Issues:**
- Requires episode to exist before linking
- Tightly coupled to Strollcast's internal episode ID scheme
- No graceful handling when episode doesn't exist
- Links break if episode IDs change

## Solution: DOI-Based Paper URLs

### URL Format

```
https://strollcast.com/paper/{identifier-type}/{identifier}
```

**Examples:**
```
https://strollcast.com/paper/arxiv/1706.03762
https://strollcast.com/paper/arxiv/2301.12345
https://strollcast.com/paper/doi/10.1038/s41586-021-03819-2
```

### arXiv Identifier Mapping

arXiv papers have a [standardized DOI format](https://info.arxiv.org/help/doi.html) assigned by DataCite:

| arXiv ID | arXiv DOI | Strollcast URL |
|----------|-----------|----------------|
| `1706.03762` | `10.48550/arXiv.1706.03762` | `/paper/arxiv/1706.03762` |
| `2301.12345` | `10.48550/arXiv.2301.12345` | `/paper/arxiv/2301.12345` |
| `hep-th/9901001` | `10.48550/arXiv.hep-th/9901001` | `/paper/arxiv/hep-th/9901001` |

We use the short `/paper/arxiv/{id}` format rather than the full DOI because:
- More compact in VTT files
- arXiv IDs are universally recognized in ML/AI community
- Can always reconstruct full DOI: `10.48550/arXiv.{id}`

### VTT Format

**Before:**
```vtt
00:05:23.000 --> 00:05:28.000
This builds on the [attention mechanism](https://released.strollcast.com/episodes/vaswani-2017-attention/vaswani-2017-attention.mp3) from Vaswani et al.
```

**After:**
```vtt
00:05:23.000 --> 00:05:28.000
This builds on the [attention mechanism](https://strollcast.com/paper/arxiv/1706.03762) from Vaswani et al.
```

## Rationale

### Why HTTPS URLs over Custom Schemes?

We evaluated two options:

| Aspect | Custom Scheme (`stroll://`) | HTTPS URL |
|--------|----------------------------|-----------|
| Browser support | None | Full |
| App deep linking | Requires scheme registration | Universal Links / App Links |
| Fallback behavior | None (fails silently) | Web page |
| Security | Can be hijacked by other apps | Verified domain ownership |
| Shareability | Only works in app | Works everywhere |

**Decision:** HTTPS URLs are [strongly recommended](https://developer.android.com/training/app-links) by both Apple and Google for deep linking. They provide graceful degradation and work across all contexts.

### Why DOI/arXiv-Based Identifiers?

1. **Canonical identity:** Papers have a permanent identity independent of Strollcast
2. **Future-proof:** arXiv [assigns DOIs](https://blog.arxiv.org/2022/02/17/new-arxiv-articles-are-now-automatically-assigned-dois/) to all papers since 2022
3. **Extensible:** Same pattern works for non-arXiv papers via DOI
4. **Forward references:** Can link to papers not yet in Strollcast

### Why Not Episode IDs?

Episode IDs (`vaswani-2017-attention`) are:
- Internal to Strollcast
- Only exist after generation
- Could theoretically change
- Not meaningful outside our system

## URL Resolution Behavior

### Web Browser

```
GET https://strollcast.com/paper/arxiv/1706.03762

If episode exists:
  → Redirect to episode page with player
  → 302 https://strollcast.com/episodes/vaswani-2017-attention

If episode doesn't exist:
  → Show paper info page
  → Display: title, authors, abstract (fetched from arXiv)
  → Show "Request Episode" button (for authenticated users)
  → Link to original arXiv page
```

### Mobile App (Universal Links / App Links)

```
App intercepts: https://strollcast.com/paper/arxiv/1706.03762

If episode exists locally:
  → Navigate to episode detail view
  → Start playback

If episode exists on server:
  → Fetch episode metadata
  → Navigate to episode detail view

If episode doesn't exist:
  → Show paper info
  → Option to request generation (if authenticated)
  → Link to arXiv in external browser
```

## Extensibility

### Other Identifier Types

The `/paper/{type}/{id}` pattern supports future sources:

```
/paper/arxiv/1706.03762          # arXiv preprint
/paper/doi/10.1038/s41586-021... # Published paper via DOI
/paper/semantic/abc123           # Semantic Scholar ID (future)
/paper/pmid/12345678             # PubMed ID (future)
```

### Resolution Priority

When multiple identifiers exist for the same paper:
1. Check if we have an episode for the exact identifier
2. Check if we have an episode for a related identifier (e.g., arXiv → published DOI)
3. Fall back to paper info page

## Security Considerations

- **URL validation:** Sanitize identifiers to prevent path traversal
- **Rate limiting:** Limit paper info fetches from arXiv API
- **Domain verification:** Configure Universal Links/App Links properly to prevent URL hijacking

## References

- [arXiv Identifier Scheme](https://info.arxiv.org/help/arxiv_identifier_for_services.html)
- [arXiv DOI Assignment](https://info.arxiv.org/help/doi.html)
- [iOS Universal Links](https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content)
- [Android App Links](https://developer.android.com/training/app-links)
- [Branch.io: Universal Links vs URI Schemes](https://www.branch.io/resources/blog/universal-links-uri-schemes-app-links-and-deep-links-whats-the-difference/)
