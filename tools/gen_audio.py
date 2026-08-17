#!/usr/bin/env python3
"""
Procedural 8-bit style audio generation for Pixel Realm.

Everything here is synthesized from scratch with numpy (square / triangle /
sine oscillators + simple ADSR envelopes + white-noise percussion) and then
compressed to mp3 via ffmpeg, so there are no external sample/license
concerns. Produces:
  - 3 short looping "adventure" background music tracks (different
    scale/tempo/mood each, so picking one at random per session feels varied)
  - a sword-swing "swoosh" sound effect
  - a soft "tip-toe" footstep sound effect

Run: python3 tools/gen_audio.py
"""
import math
import os
import random
import subprocess
import wave

import numpy as np

SR = 44100
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "assets", "audio")
os.makedirs(OUT_DIR, exist_ok=True)


def midi_to_freq(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def square_wave(freq, t, duty=0.5):
    phase = (t * freq) % 1.0
    return np.where(phase < duty, 1.0, -1.0)


def triangle_wave(freq, t):
    phase = (t * freq) % 1.0
    return 2 * np.abs(2 * (phase - np.floor(phase + 0.5))) - 1


def sine_wave(freq, t):
    return np.sin(2 * np.pi * freq * t)


def note_envelope(n, sr, attack=0.006, release=0.05):
    """Simple fade-in/fade-out envelope sized to fit inside n samples, used to
    avoid clicks at note boundaries (a real ADSR sustain isn't needed for
    these short chiptune plinks)."""
    env = np.ones(n)
    a = min(int(sr * attack), n // 2)
    r = min(int(sr * release), n - a)
    if a > 0:
        env[:a] = np.linspace(0, 1, a)
    if r > 0:
        env[n - r:] = np.minimum(env[n - r:], np.linspace(1, 0, r))
    return env


def write_wav(path, samples, sr=SR):
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16)
    with wave.open(path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def to_mp3(wav_path, mp3_path, bitrate="96k"):
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-codec:a", "libmp3lame", "-b:a", bitrate, mp3_path],
        check=True,
    )
    os.remove(wav_path)


# --------------------------------------------------------------------------
# Background music: a tiny step-sequencer chiptune generator. Each track is a
# random walk melody (square lead) over a pentatonic scale, a root-note
# triangle bassline on the beat, and light noise hi-hats/kick for rhythm.
# Tracks are built to an exact number of whole beats at a fixed tempo so the
# loop point lines up cleanly with almost no seam.
# --------------------------------------------------------------------------

PENTATONIC_MAJOR = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28]
PENTATONIC_MINOR = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29]


def make_hat(rng, length, volume=0.05):
    noise = rng.standard_normal(length)
    env = np.linspace(1, 0, length) ** 2
    return noise * env * volume


def make_kick(t_len_samples, sr, volume=0.35):
    t = np.arange(t_len_samples) / sr
    freq_env = 120 * np.exp(-t * 28) + 45
    phase = np.cumsum(2 * np.pi * freq_env / sr)
    tone = np.sin(phase)
    amp_env = np.exp(-t * 18)
    return tone * amp_env * volume


def make_track(seed, bpm, scale, scale_root, n_eighths, lead_duty, mood_vol=1.0):
    rng = random.Random(seed)
    nprng = np.random.default_rng(seed)
    eighth = 60.0 / bpm / 2.0
    eighth_len = int(eighth * SR)
    total_len = eighth_len * n_eighths
    buf = np.zeros(total_len)

    idx = rng.randint(2, min(6, len(scale) - 1))
    hold_left = 0
    for i in range(n_eighths):
        start = i * eighth_len
        # Melody: random walk across the scale, occasionally resting or
        # holding a note across more than one eighth so it doesn't feel like
        # a nonstop machine-gun of notes.
        if hold_left > 0:
            hold_left -= 1
        elif rng.random() < 0.82:
            step = rng.choice([-2, -1, -1, 0, 1, 1, 2])
            idx = max(0, min(len(scale) - 1, idx + step))
            note_len_eighths = rng.choice([1, 1, 1, 2, 2, 3])
            hold_left = note_len_eighths - 1
            length = min(eighth_len * note_len_eighths, total_len - start)
            t = np.arange(length) / SR
            freq = midi_to_freq(scale_root + scale[idx])
            wave = square_wave(freq, t, duty=lead_duty)
            env = note_envelope(length, SR, attack=0.004, release=min(0.08, length / SR * 0.4))
            seg = wave * env * 0.16 * mood_vol
            buf[start:start + length] += seg

        # Bassline: root (down two octaves) on every downbeat (every 4th
        # eighth = each quarter note).
        if i % 4 == 0:
            length = min(eighth_len * 4, total_len - start)
            t = np.arange(length) / SR
            bass_freq = midi_to_freq(scale_root + scale[0] - 24)
            wave = triangle_wave(bass_freq, t)
            env = note_envelope(length, SR, attack=0.008, release=min(0.12, length / SR * 0.3))
            seg = wave * env * 0.20 * mood_vol
            buf[start:start + length] += seg

        # Percussion: soft hi-hat tick every eighth, a little kick thump on
        # beats 1 and 3 of every bar (every 8 eighths / every 4 eighths).
        hat = make_hat(nprng, min(int(SR * 0.025), total_len - start), volume=0.045 * mood_vol)
        buf[start:start + len(hat)] += hat
        if i % 8 in (0, 4):
            kick_len = min(int(SR * 0.18), total_len - start)
            kick = make_kick(kick_len, SR, volume=0.22 * mood_vol)
            buf[start:start + kick_len] += kick

    # Tiny fade in/out at the very ends only (not per-note) so looped
    # playback doesn't pop at the seam.
    fade = min(int(SR * 0.015), total_len // 2)
    buf[:fade] *= np.linspace(0, 1, fade)
    buf[-fade:] *= np.linspace(1, 0, fade)

    peak = np.max(np.abs(buf)) or 1.0
    buf = buf / peak * 0.85
    return buf


def gen_music():
    tracks = [
        dict(seed=101, bpm=132, scale=PENTATONIC_MAJOR, scale_root=64, n_eighths=112, lead_duty=0.5, mood_vol=1.0,
             name="music_adventure1"),
        dict(seed=202, bpm=150, scale=PENTATONIC_MINOR, scale_root=62, n_eighths=96, lead_duty=0.35, mood_vol=0.95,
             name="music_adventure2"),
        dict(seed=303, bpm=118, scale=PENTATONIC_MAJOR, scale_root=57, n_eighths=96, lead_duty=0.5, mood_vol=0.9,
             name="music_adventure3"),
    ]
    for cfg in tracks:
        buf = make_track(cfg["seed"], cfg["bpm"], cfg["scale"], cfg["scale_root"], cfg["n_eighths"], cfg["lead_duty"],
                          cfg["mood_vol"])
        wav_path = os.path.join(OUT_DIR, cfg["name"] + ".wav")
        mp3_path = os.path.join(OUT_DIR, cfg["name"] + ".mp3")
        write_wav(wav_path, buf)
        to_mp3(wav_path, mp3_path, bitrate="96k")
        dur = len(buf) / SR
        print(f"wrote {mp3_path} ({dur:.1f}s loop)")


# --------------------------------------------------------------------------
# Sword swing "swoosh": a short burst of filtered-feeling noise with a fast
# downward pitch sweep, built by mixing bandpass-ish shaped noise (via a
# crude moving-average smoothing pass, since scipy isn't available) with a
# quickly falling tone.
# --------------------------------------------------------------------------

def moving_average(x, window):
    if window <= 1:
        return x
    kernel = np.ones(window) / window
    return np.convolve(x, kernel, mode="same")


def gen_swoosh():
    dur = 0.22
    n = int(SR * dur)
    t = np.arange(n) / SR
    noise = np.random.default_rng(7).standard_normal(n)
    # Smooth the noise progressively less over time to give it a "whip"
    # brightening-then-fading character.
    shaped = moving_average(noise, 9)
    # Fast downward pitch sweep tone layered under the noise for a bit of
    # tonal "whoosh" body.
    freq_env = 1800 * np.exp(-t * 14) + 220
    phase = np.cumsum(2 * np.pi * freq_env / SR)
    tone = np.sin(phase)
    amp_env = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 0.7  # quick rise, longer tail
    seg = (shaped * 0.8 + tone * 0.35) * amp_env
    seg = seg / (np.max(np.abs(seg)) or 1.0) * 0.8
    wav_path = os.path.join(OUT_DIR, "swoosh.wav")
    mp3_path = os.path.join(OUT_DIR, "swoosh.mp3")
    write_wav(wav_path, seg)
    to_mp3(wav_path, mp3_path, bitrate="96k")
    print(f"wrote {mp3_path} ({dur:.2f}s)")


# --------------------------------------------------------------------------
# Footstep "tip-toe": a very short, soft, high-ish noise tap -- two slightly
# different variants so alternating them per-step doesn't sound robotic.
# --------------------------------------------------------------------------

def gen_footstep(seed, name, base_freq):
    dur = 0.09
    n = int(SR * dur)
    t = np.arange(n) / SR
    noise = np.random.default_rng(seed).standard_normal(n)
    shaped = moving_average(noise, 3)
    tone = sine_wave(base_freq, t) * np.exp(-t * 40)
    amp_env = np.exp(-t * 55)
    seg = (shaped * 0.5 + tone * 0.5) * amp_env
    seg = seg / (np.max(np.abs(seg)) or 1.0) * 0.55
    wav_path = os.path.join(OUT_DIR, name + ".wav")
    mp3_path = os.path.join(OUT_DIR, name + ".mp3")
    write_wav(wav_path, seg)
    to_mp3(wav_path, mp3_path, bitrate="80k")
    print(f"wrote {mp3_path} ({dur:.2f}s)")


if __name__ == "__main__":
    gen_music()
    gen_swoosh()
    gen_footstep(11, "footstep1", 320)
    gen_footstep(12, "footstep2", 300)
    print("done.")
