"""Video journal AI processor: transcription + transcript-only analysis.

Public entry point (Contract B, frozen for the MVP):

    from services.processor.pipeline import process_video

Modes are controlled with the TRANSCRIPTION_MODE and ANALYSIS_MODE
environment variables; see services/processor/README.md.
"""
