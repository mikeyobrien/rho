---
name: termux-media
description: Play audio files, record from microphone, take photos. Use for media playback, voice recording, or camera capture.
---

# Media Operations

## Audio Playback

```bash
termux-media-player play /path/to/file.mp3
termux-media-player pause
termux-media-player play          # resume
termux-media-player stop
termux-media-player info          # current status
```

## Microphone Recording

```bash
# Start recording
termux-microphone-record -f /path/to/output.m4a

# With options
termux-microphone-record -f out.m4a -l 30       # 30 second limit
termux-microphone-record -f out.opus -e opus    # encoder: aac, amr_wb, amr_nb, opus
termux-microphone-record -f out.m4a -b 128      # bitrate in kbps
termux-microphone-record -f out.m4a -r 44100    # sample rate Hz

# Stop recording
termux-microphone-record -q

# Check status
termux-microphone-record -i
```

## Camera Photo

```bash
termux-camera-photo /path/to/photo.jpg

# Options
termux-camera-photo -c 0 photo.jpg    # camera ID (0=back, 1=front usually)
```

## Camera info
```bash
termux-camera-info
```

**Note:** Camera/microphone require respective permissions.
