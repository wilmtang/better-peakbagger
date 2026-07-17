# Hermes Auto Pan — 3D Map Promotional Video Tooling

This directory contains the automated video recording tooling and final cropped promotional assets for **Better Peakbagger's 3D Terrain Map** feature. 

The assets are fully automated and recorded directly using Playwright on a real GPU-accelerated Chrome instance, ensuring visual fidelity, smooth transitions, and absolute reproducibility.

## 📁 Directory Structure
*   **`promotion.mp4`**: The high-definition cropped final promotional video showcasing the key features in an isolated, clean card layout.
*   **`record.js`**: The portable Playwright automation script used to boot the extension, clean up the page DOM, perform smooth map gestures, and record the viewport.
*   **`README.md`**: This instruction file.

---

## 🚀 How to Re-Record the Promotional Video

If you need to tweak the interactions, adjust the timing, change the crop dimensions, or regenerate the final video asset, you can easily re-run the automated recording pipeline.

### 1. Prerequisites
Make sure you have Playwright and `ffmpeg` installed on your machine:
```bash
# Install dependencies in the repository root
npm install
npx playwright install chromium

# Ensure ffmpeg is available (for cropping and formatting)
brew install ffmpeg
```

### 2. Run the Playwright Recorder
Run the automation script from the repository:
```bash
node store-assets/hermes-auto-pan/record.js
```
*This will boot a headful Chrome window with the local unpacked extension loaded, scroll down to the map area, transition from 2D to 3D terrain, resize the map, perform camera controls (zoom, pan, tilt), sweep across the elevation chart to show synced movement, and select a nearby summit marker before cleanly shutting down.*

### 3. Crop and Post-Process with FFmpeg
The browser video is captured at full viewport dimensions ($1200 \times 1350$) to ensure high-fidelity. To crop it into the perfectly centered, clean, standalone card layout (removing margins and top stats tables), run:

```bash
# 🎥 Generate cropped MP4
ffmpeg -y -i store-assets/hermes-auto-pan/page@*.webm -vf "crop=755:1100:440:10" -c:v libx264 -pix_fmt yuv420p store-assets/hermes-auto-pan/promotion.mp4

# 🎞️ Generate optimized GIF
ffmpeg -y -i store-assets/hermes-auto-pan/page@*.webm -vf "crop=755:1100:440:10,fps=12,scale=500:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" store-assets/hermes-auto-pan/promotion.gif
```

---

## 🛠️ Automated Interaction Timeline (inside `record.js`):
1.  **DOM Sanitization**: Injects custom CSS to set a seamless, solid `#ffffff` background and hides all distracting clutter (footers, view counters, ads, external download links) to isolate the card.
2.  **Strategic Scrolling**: Scrolls the page so the map and interactive stats container perfectly fill the viewport with no top tables visible.
3.  **3D Map Activation**: Programmatically triggers the `#bpb-terrain-toggle` button and handles the first-use permission modal.
4.  **Resizing**: Simulates custom `Shift+Arrow` key events on the map's resize handle to smoothly expand the map viewport width and height.
5.  **Camera Controls**: Performs mouse actions to zoom into Garnet Canyon, pan, and **right-click drag up** to tilt the camera for realistic vertical 3D depth.
6.  **Chart Sync Sweep**: Slowly sweeps the cursor horizontally across the Chart.js canvas, showcasing the synchronized red tracking dot moving dynamically in 3D space on the map above.
7.  **Marker Interactive Popup**: Clicks an offset on the map near Grand Teton to select a nearby peak (Middle/South Teton), showcasing the interactive name link bubble.
