# Cadence guide and release notes

Cadence records and edits audio in your browser. Audio stays on this device unless you export it. The site is a static app and needs no recording account or upload service.

## Record

Press **Record**, then **Stop**. Recording setup is optional. To choose a microphone, open **Recording setup**, allow microphone permission, and select a device. Device names may appear only after permission. If the selected microphone disappears, Cadence uses the browser default and shows a status message. If the browser denies permission, allow this site in browser settings and try again. Recording requires a secure origin and browser support for `getUserMedia` and `MediaRecorder`.

The live meter displays RMS level in dBFS and flags peaks near full scale as **CLIPPING**. The waveform is the current input signal. A silent meter may mean a muted, disconnected, or very quiet source. **Test microphone** records a temporary clip of up to 15 seconds that you can play or discard; it is not added to the project.

Presets are **Voice**, **Podcast**, **Music**, **Raw / Unprocessed**, and **Custom**. **Save preset** stores the current configuration under a new name. Select a saved preset, change fields, then press **Update preset** to replace its saved configuration. Changing any field switches the preset label to Custom. Preferences are saved in local browser storage. Software input gain ranges from -24 to +24 dB; it does not change hardware gain. The meter observes the gained signal. Sample rate and channel count are requests to the browser. The applied input settings and actual recording graph rate are shown after capture starts. Noise suppression, echo cancellation, and automatic gain control are independent requests and appear in the applied settings only when the browser reports them. Choose a countdown of Off, 3, 5, or 10 seconds.

**Pause** stops adding audio until **Resume**. The timer excludes paused time. **Marker** adds a bookmark while recording. **Stop after sustained silence** waits for a signal above the threshold and then stops after the chosen duration below it. A 3 dB gap between speech detection and silence detection reduces toggling. It never delays the initial start or automatically pauses, so leading speech is kept. Short pauses below the duration are retained. Use a conservative threshold when speech is quiet.

For **browser tab or system audio**, choose that capture source and press Record or Test. The browser opens its own share dialog. Select a source with audio and enable its audio sharing option. Some browsers and operating systems do not offer system audio; Cadence reports an unavailable audio track instead of recording silence. The screen video is used only to keep the browser capture session alive and is not stored.

**Monitor input** is off by default. Use headphones: speaker output can feed back into the microphone. Monitoring latency depends on the browser and device. Output selection is available only if the browser exposes and allows `setSinkId`.

## Recovery and storage

While recording, Cadence writes approximately one-second encoded chunks to IndexedDB. An active recording prompts before page navigation. After an interruption, a **Recover a recording** panel offers **Recover**, **Save raw**, and **Discard**. Recover works only if the browser's saved chunks form decodable audio; a crash before a final container header or footer may leave only a raw file. Browser eviction, private browsing, storage quota, power loss, and interrupted transactions can also lose data. Export important recordings promptly.

Stored clips are encoded, but editing and export decode clips into memory. Very long clips, complex multitrack mixes, effects, and 96 kHz stereo audio may need substantial memory and may fail on phones. The storage indicator shows saved clip bytes. If the quota is reached, recording stops and saved chunks remain in the recovery panel when possible. The **Save original** button exports the first source recording even after edits.

## Edit and mix

Drag across the waveform to select a region. Zoom and timeline position narrow the view. **Keep selection**, **Remove selection**, fades, normalization, speed, resampling, and channel actions operate on the selected clip. Undo and redo work during the current editing session. The first source bytes are retained on edit and **Reset to original** restores them after a reload. Exported project data includes those original bytes. The timeline shows markers as times.

Clips are separate takes in the browser. Rename each take in the workspace. The clip list's **Track controls** set volume, start offset, mute, and solo. Tick at least two clips to choose tracks; with fewer ticks, **Join ticked**, **Mix ticked**, or **Play mix** uses all clips. Join creates a sequential clip. Play mix auditions the audible tracks; Mix renders them at their offsets to a new clip and leaves the sources intact. A mix can peak above 0 dBFS; inspect levels and adjust track volumes. **Punch in selection** records a new take and replaces the selected region in the active clip. The new take also remains separately available.

The optional live spectrogram runs during playback; low frequencies are at the bottom. It is a frequency view of current playback rather than a precomputed map of the whole recording.

Effects are optional and saved per clip. High-pass, low-pass, three-band EQ, noise gate, compressor, limiter, and output gain affect **playback and WAV/Opus export**. They do not alter the stored source or edit history. The voice preset is a starting point; Reset effects returns to dry audio. Heavy effects may take time before playback begins because Cadence renders them locally.

## Export and transcription

WAV supports 16-bit PCM, 24-bit PCM, and 32-bit float. Export rate can be the source rate or 44.1, 48, or 96 kHz; channels can be the source count, mono, or stereo. Opus in WebM offers 64–256 kbps where WebCodecs audio encoding is available. The browser may decline Opus even when WebCodecs exists. **Save original** downloads the first source recording without effects. MP3 and FLAC encoding are not currently offered: they would need additional encoders and broader compatibility testing.

Local transcription is optional. Press **Transcribe this clip** to explicitly download the roughly 40 MB tiny English speech model and its runtime. Processing stays in the browser, with download and transcription status. Review the text for mistakes, edit it, and choose **Save text**. The first model download needs network access; subsequent availability depends on browser caching. Model inference can be slow or unavailable on low-memory devices. No cloud transcription is required.

## Shortcuts and accessibility

When focus is outside a form field: **Alt+R** record/stop, **Alt+P** pause/resume, **Alt+M** marker. Controls have text labels and can be used by keyboard or touch. The recording status is announced to assistive technology.

## Architecture and browser notes

`recording.ts` handles preferences, constraints, and level measurement. `ui.ts` coordinates devices, capture, playback, editing, and accessibility. `store.ts` stores clips and independent recording chunks in IndexedDB. `dsp.ts` contains sample operations and mixing. `effects.ts` renders playback/export effects with Web Audio. `wav.ts` and the export worker encode WAV; shared `opus.ts` and `webm.ts` encode Opus where WebCodecs exists. The optional speech model reuses Limelight's local transcription code. A service worker precaches the app shell for offline use; model download requires a connection when first requested.

Production uses Netlify's Git connection to the repository's `main` branch. `netlify.toml` runs `npm run build` and publishes `dist`. GitHub Actions runs type checking, unit tests, and Playwright tests on pushes and pull requests.

The automated recording test uses Chromium's fake microphone. It validates browser flow, pause/resume, export, and recovery UI, not microphone hardware quality or every driver. Firefox and Safari support varies by platform for capture settings, system audio, output selection, and WebCodecs. Cadence detects capabilities and exposes applied settings where the browser reports them.

## Troubleshooting

- **No input:** Check the browser's site permission, operating-system input selection, mute switch, and meter. Reopen Recording setup after reconnecting a device.
- **Requested rate not applied:** The browser may ignore ideal capture constraints. Read the applied input settings and graph rate shown after capture begins.
- **Recovery cannot decode:** Save the raw chunks. The last encoded chunk may be missing after an interruption; another player or repair tool may still read part of it.
- **Export runs out of memory:** Export a shorter selection, turn off effects, or use a desktop browser.
- **Monitoring echoes:** Turn monitoring off or use headphones.
- **Transcript unavailable:** Reconnect for the initial model download, free device memory, or edit the text manually.

## Release notes

This release adds recording setup, live metering, microphone tests, capture preferences and presets, pause/resume, incremental recovery, markers, silence stop, monitoring, source preserving edits, redo/reset, multitrack mix, punch in, live spectrogram, EQ and dynamics effects, Opus export, and optional local transcription.
