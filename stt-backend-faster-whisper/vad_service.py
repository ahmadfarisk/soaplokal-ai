"""
vad_service.py

Decides where a continuous audio stream should be cut into phrases.
Runs on the browser's native audio rate (48000 Hz) — no resampling here,
that only happens once per finalized chunk, in a later phase.

One VoiceActivityDetector instance = one live session's state. The
WebSocket handler creates one per connection and feeds it every incoming
audio block.
"""

import webrtcvad

from collections import deque



SAMPLE_RATE = 48000
FRAME_DURATION_MS = 30  # webrtcvad only accepts 10, 20, or 30
BYTES_PER_SAMPLE = 2  # 16-bit PCM
FRAME_SIZE_BYTES = int(SAMPLE_RATE * (FRAME_DURATION_MS / 1000) * BYTES_PER_SAMPLE)

# --- Tuning knobs -----------------------------------------------------------
# If phrases cut off too early mid-sentence, raise SILENCE_FRAMES_TO_END_PHRASE
# first. 30 frames * 30ms = ~900ms; try 40 (~1.2s) if still too eager.
SILENCE_FRAMES_TO_END_PHRASE = 30
 
# How many consecutive frames of silence are needed before a phrase is allowed
# to end AT ALL, once it's already reached MIN_PHRASE_DURATION_MS long. Below
# that minimum duration, silence is ignored entirely and the phrase keeps
# accumulating — this stops a short utterance from being finalized the
# instant it starts, purely because the very next frame happened to be quiet.
MIN_PHRASE_DURATION_MS = 4000
MIN_PHRASE_DURATION_FRAMES = int(MIN_PHRASE_DURATION_MS / FRAME_DURATION_MS)
 
# Safety valve: if a phrase somehow keeps growing forever (e.g. continuous
# speech with no real pause), force a cut so it doesn't grow unbounded.
MAX_PHRASE_DURATION_MS = 30000
MAX_PHRASE_DURATION_FRAMES = int(MAX_PHRASE_DURATION_MS / FRAME_DURATION_MS)

MIN_SPEECH_FRAMES_TO_KEEP = 5  # discard chunks shorter than ~150ms (coughs, clicks)


PADDING_FRAMES = 10  # ~300ms (* 30ms) lookback — frames kept even while nothing's been classified as speech yet


class VoiceActivityDetector:
    """One instance per live session. Feed it raw PCM bytes as they arrive;
    it tells you when a phrase is finished."""

    def __init__(self, aggressiveness: int = 3):
        # aggressiveness: 0 (lenient) to 3 (strict) — how easily background
        # noise gets mistaken for speech. Start at 2, tune from real testing.
        self._vad = webrtcvad.Vad(aggressiveness)
        self._leftover = b""  # bytes that didn't fill a complete frame yet
        self._current_chunk = bytearray()
        self._silence_run = 0
        self._has_had_speech = False
        self._frame_count = 0  # total frames (speech + silence) in the current phrase

        # For padding
        # self._padding_buffer = deque(maxlen=PADDING_FRAMES)

    def feed(self, audio_bytes: bytes) -> bytes | None:
        """
        Call this with each incoming block of raw PCM bytes from the
        WebSocket. Returns the finalized phrase's bytes if this call caused
        a phrase to end, otherwise None.
        """
        # Audio blocks from the frontend won't always line up exactly with
        # webrtcvad's fixed 30ms frame size, so we buffer leftovers between calls.
        data = self._leftover + audio_bytes
        finalized = None

        offset = 0
        while offset + FRAME_SIZE_BYTES <= len(data):
            frame = data[offset : offset + FRAME_SIZE_BYTES]
            offset += FRAME_SIZE_BYTES

            # self._padding_buffer.append(frame)

            is_speech = self._vad.is_speech(frame, SAMPLE_RATE)

            if is_speech:
                # if not self._has_had_speech:
                #     # First speech frame of a new phrase — prepend the lookback buffer
                #     # so a word's onset isn't lost to a frame that got classified as silence.
                #     self._current_chunk.extend(b"".join(self._padding_buffer))
                #     # self._frame_count += len(self._padding_buffer) - 1  # -1 since this frame is counted below either way
                # self._current_chunk.extend(frame)
                # # self._frame_count += 1
                # self._silence_run = 0
                # self._has_had_speech = True

                # OLD one without padding
                self._current_chunk.extend(frame)
                self._frame_count += 1
                self._silence_run = 0
                self._has_had_speech = True

            elif self._has_had_speech:
                # Keep a little trailing silence in the chunk — sounds more
                # natural than cutting off the instant speech stops.
                self._current_chunk.extend(frame)
                self._frame_count += 1
                self._silence_run += 1

                # Only let silence end the phrase once it's already reached
                # the minimum length — otherwise a pause early into a short
                # utterance would finalize it immediately.
                long_enough = self._frame_count >= MIN_PHRASE_DURATION_FRAMES
                much_too_long = self._frame_count >= MAX_PHRASE_DURATION_FRAMES
                if (long_enough and self._silence_run >= SILENCE_FRAMES_TO_END_PHRASE) or much_too_long:
                    finalized = self._finalize_if_long_enough()
                    if finalized is not None:
                        # A frame already finalized this call — return it now
                        # rather than silently continuing to scan more frames.
                        self._leftover = data[offset:]
                        return finalized
                    continue  # finalize returned None (too short) — keep scanning this call's frames
            # else: silence before any speech has started — just drop it, nothing to buffer yet

        self._leftover = data[offset:]
        return finalized

    def _finalize_if_long_enough(self) -> bytes | None:
        chunk = bytes(self._current_chunk)
        self._current_chunk = bytearray()
        self._silence_run = 0
        self._has_had_speech = False
        self._frame_count = 0  # was missing — without this, frame_count kept growing across phrases

        # self._padding_buffer.clear()

        min_bytes = MIN_SPEECH_FRAMES_TO_KEEP * FRAME_SIZE_BYTES
        if len(chunk) < min_bytes:
            return None  # too short — likely noise, discard rather than transcribe
        return chunk

    def flush(self) -> bytes | None:
        """
        Force-finalizes whatever's currently buffered, bypassing the normal
        silence-wait and MIN_PHRASE_DURATION_FRAMES gating entirely. Call
        this once, when the user clicks Stop, so trailing speech since the
        last finalized phrase isn't silently discarded.

        Still applies the same MIN_SPEECH_FRAMES_TO_KEEP check as a normal
        finalize — if there's only a sliver of audio buffered (or nothing
        was ever classified as speech at all), this returns None rather
        than sending a near-empty chunk to Whisper.
        """
        if not self._has_had_speech:
            return None  # nothing buffered — e.g. Stop was clicked during silence
        return self._finalize_if_long_enough()