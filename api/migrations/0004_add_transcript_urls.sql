-- Migration: Add missing transcript URLs
-- Created: 2024-12-28

UPDATE episodes SET transcript_url = 'https://strollcast.com/api/gated-attention-2025.vtt' WHERE id = 'gated-attention-2025';
UPDATE episodes SET transcript_url = 'https://strollcast.com/api/pathways-2022.vtt' WHERE id = 'pathways-2022';
UPDATE episodes SET transcript_url = 'https://strollcast.com/api/megatron-lm-2021.vtt' WHERE id = 'megatron-lm-2021';
UPDATE episodes SET transcript_url = 'https://strollcast.com/api/pytorch-fsdp-2023.vtt' WHERE id = 'pytorch-fsdp-2023';
UPDATE episodes SET transcript_url = 'https://strollcast.com/api/zero-2020.vtt' WHERE id = 'zero-2020';
