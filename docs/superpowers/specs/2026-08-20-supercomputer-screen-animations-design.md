# Supercomputer Screen Animation Sequence Design Spec

## Overview
An interactive web application showcasing a high-tech retro-futuristic Supercomputer Monitor. Inside its screen, it continuously animates through three distinct cybernetic states in a smooth sequence:
1. **Constellation / Star Network**: Glowing star points, distance-based synaptic lines, and a sweeping radar scanline.
2. **Waving AI Orb**: A fluid, glowing energy orb that comes to life and waves hello at the user with particle sparkles.
3. **Holographic Writing**: An animated cyber pen/cursor that writes out glowing neon lines of code and messaging line-by-line across a digital terminal grid.

---

## Visual Architecture & UI Design

### 1. The Supercomputer Monitor Frame
- **Monitor Chassis**: Metallic dark-slate bezel with subtle bevel shadows, chrome accents, and corner status lights (Power, Data Bus, Neural Link).
- **Glass Panel Effects**: Subtle scanline texture, glare reflection, and adjustable CRT glow.
- **Top Header Status Dock**: Interactive dock displaying the current active mode icon (`[🌌 CONSTELLATION]`, `[🔮 WAVING ORB]`, `[✍️ WRITING TERMINAL]`) with mode progress indicators.

### 2. Screen State 1: Constellation / Star Network 🌌
- **Visuals**: 
  - Deep space midnight gradient canvas.
  - Floating star nodes that drift with soft glow and twinkling opacity.
  - Dynamic vector lines connecting adjacent stars when within proximity thresholds.
  - Horizontal laser bus line sweeping vertically across the screen with trailing light luminescence.
- **Interactivity**: Mouse move gently pulls nearby star nodes; click spawns a temporary star node cluster.

### 3. Screen State 2: Waving AI Orb 🔮👋
- **Visuals**:
  - Smooth morphing transition from the starfield into a centered fluid energy orb.
  - Procedural plasma particles orbiting the core with fluid organic noise motion.
  - **Waving Animation**: The orb's fluid body extends a waving energy arm/arc towards the viewer, radiating glowing shockwave rings and sparkling stars.
- **Interactivity**: Hovering produces energy filaments connecting the orb to the cursor.

### 4. Screen State 3: Holographic Writing ✍️
- **Visuals**:
  - Grid notebook / matrix background overlay.
  - Animated holographic laser pen tip moving smoothly along text paths.
  - Renders glowing neon lines of code, neural logic, and AI thought logs letter-by-line in real-time (`"AI_CORE_ONLINE"`, `"SYNAPSING_LOGIC..."`, `"HELLO_WORLD"`).
- **Interactivity**: Click to write custom text or accelerate typing speed.

---

## Interactive Controls & Customization Dock
- **Sequence Auto-Play**: Automatically transitions `Constellation (6s) -> Waving Orb (6s) -> Writing Terminal (6s) -> Loop`.
- **Manual Mode Selector**: Click any top dock icon to freeze or jump directly to that animation.
- **Playback & Speed Slider**: Control animation cycle duration and particle count.
- **Color Theme Matrix**: Cyber Cyan, Aurora Violet, Quantum Gold, Synth Matrix Green.
