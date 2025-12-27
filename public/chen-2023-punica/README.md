# Punica: Multi-Tenant LoRA Serving

**Authors:** Lequn Chen, Zihao Ye, Yongji Wu, Danyang Zhuo, Luis Ceze, Arvind Krishnamurthy (University of Washington, Duke University)
**Year:** 2023
**Venue:** MLSys 2024
**Paper:** https://arxiv.org/abs/2310.18547
**Code:** https://github.com/punica-ai/punica

## Summary

This podcast episode covers Punica, a system for efficiently serving multiple LoRA-adapted LLMs on shared GPU infrastructure. The key innovation is the SGMV (Segmented Gather Matrix-Vector) kernel that enables batching requests across different LoRA adapters within a single GPU kernel launch, achieving 12x higher throughput than existing systems.

## Topics Covered

- The multi-tenant LoRA serving problem
- SGMV kernel design and implementation
- Expand and shrink kernel variants
- Split-K parallelization strategy
- System architecture: scheduler, execution layer, memory management
- On-demand adapter loading with millisecond latency
- Performance results across workload distributions
- Connection to vLLM and other serving systems
- Practical deployment considerations

## Quizzes

The episode includes 2 quizzes at the end to test understanding of:
1. The batching challenge with multiple LoRA adapters and how SGMV solves it
2. Why split-K is used for the shrink kernel but not the expand kernel

## Files

- `chen-2023-punica.m4a` - The audio podcast
- `script.md` - Full transcript

## Regenerating

From the repository root:

```bash
cd python

# Production with ElevenLabs
export ELEVENLABS_API_KEY="your-api-key"
pixi run python generate.py ../public/chen-2023-punica

# Normalize audio levels
pixi run python generate.py ../public/chen-2023-punica --normalize
```

Requires `ffmpeg` for audio processing.
