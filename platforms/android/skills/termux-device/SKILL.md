---
name: termux-device
description: Device controls — vibration, torch, volume, battery status, toast messages. Use for haptic feedback, flashlight, or quick status checks.
---

# Device Controls

## Toast (quick popup)
```bash
termux-toast "Message"
termux-toast -s "Short message"           # shorter duration
termux-toast -g top "Top message"         # position: top, middle, bottom
termux-toast -b black -c white "Styled"   # background & text color
```

## Vibration
```bash
termux-vibrate                     # 1 second default
termux-vibrate -d 500              # 500ms
termux-vibrate -f                  # force even in silent mode
```

## Flashlight
```bash
termux-torch on
termux-torch off
```

## Volume
```bash
termux-volume                      # show all streams
termux-volume music 10             # set music to 10
termux-volume ring 5               # set ring to 5
```
Streams: `call`, `system`, `ring`, `music`, `alarm`, `notification`

## Battery Status
```bash
termux-battery-status
```
Returns: `percentage`, `status` (CHARGING/DISCHARGING), `plugged`, `temperature`, etc.

## Brightness
```bash
termux-brightness 128              # 0-255
termux-brightness auto             # auto brightness
```

## WiFi Info
```bash
termux-wifi-connectioninfo         # current connection
termux-wifi-scaninfo               # nearby networks
termux-wifi-enable true/false      # toggle wifi
```

## Sensor Data
```bash
termux-sensor -l                   # list available sensors
termux-sensor -s accelerometer     # read specific sensor
termux-sensor -s accelerometer -n 5  # 5 readings then stop
```
