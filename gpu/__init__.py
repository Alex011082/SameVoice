"""SameVoice local GPU inference services.

Heavy model libraries are imported lazily inside the individual engines so the
main CI suite can validate service contracts without CUDA or model weights.
"""
