/* ============================================================================
 * RTP Sequence Visualizer
 * ----------------------------------------------------------------------------
 * Loads/saves RTPBuit sequencer patterns in the native RTP0 binary format
 * (.rtpseq) and can still import/export the legacy JSON representation.
 *
 * Binary layout (little-endian, matches BuitPersistenceManager.cpp):
 *   Header (8): 'R','T','P','0', version, nScenes, SCENE_BLOCK_SIZE, selScene
 *   Per scene:  nameLen(1), name bytes, selSeq(1, v>=2), nSeq(1)
 *   Per seq:    type, midiCh, color, lengthPages, input, port,
 *               nNotes_lo, nNotes_hi, enabled(v>=2), clockDivider(v>=3)
 *   Per note:   low u32  = note|read<<8|vel<<16|len<<24|ttl<<28
 *               high u32 = midiCh|destPort<<4|usbHostIdx<<8|state<<16|lit<<17
 * ==========================================================================*/

'use strict';

// ── Constants (mirror firmware constants.h) ──────────────────────────────────
const RTP_VERSION   = 3;
const SEQ_BLOCK     = 16;   // steps per page
const SCENE_BLOCK   = 16;   // sequences per scene
const N_PAGES       = 16;
const N_COLORS      = 32;

const TYPE_NAMES = ['DRUM', 'BASS', 'MONO', 'POLY', 'CONTROL', 'HARMONY'];

// port parameter value -> label (RTPEventNoteSequence::getPortAsMidiPort)
const PORT_NAMES = [
    'Default route', 'USB Device', 'USB Host (all)', 'DIN',
    'All ports', 'USB Host 1', 'USB Host 2', 'USB Host 3', 'USB Host 4'
];

// clock divider index -> pulses per step / label (CLOCK_DIVIDER_PULSES[11])
const CLOCK_DIVIDER_PULSES  = [96, 48, 24, 16, 12, 8, 6, 4, 3, 2, 1];
const CLOCK_DIVIDER_LABELS  = ['1/1', '1/2', '1/4', '1/4T', '1/8', '1/8T',
                               '1/16', '1/16T', '1/32', '1/32T', '1/64'];

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Chord type index -> name, matching RTPLibrary chordStep[N_CHORDS] table
// (NOT the firmware CHORD_TYPE_NAMES, which is misaligned with the table).
const CHORD_NAMES = ['note','maj','min','maj7','min7','7','dim','dim7',
                     'm7b5','aug','maj9','m9','9','sus4','sus2','6'];

const TYPE_HARMONY = 5;

// ── State ────────────────────────────────────────────────────────────────────
let sequencerData       = null;
let currentSceneIndex   = -1;
let currentSequenceIndex = -1;
let selectedNoteIndex   = -1;
let currentFileName     = '';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fileInput        = $('fileInput');
const loadFileBtn      = $('loadFileBtn');
const saveFileBtn      = $('saveFileBtn');
const exportJsonBtn    = $('exportJsonBtn');
const fileNameLabel    = $('fileName');
const scenesList       = $('scenesList');
const sequencesContainer = $('sequencesContainer');
const currentSceneIndexSpan = $('currentSceneIndex');
const currentSceneNameSpan  = $('currentSceneName');
const notesGrid        = $('notesGrid');
const noteInspector    = $('noteInspector');
const dropOverlay      = $('dropOverlay');
const statusBar        = $('statusBar');

// ── Firmware color palette (ColorFunctions.cpp colorMapper) ──────────────────
function colorForIndex(idx) {
    const hue = ((idx % N_COLORS) / N_COLORS) * 360;
    const c = 255;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    let r = 0, g = 0, b = 0;
    if      (hue < 60)  { r = c; g = x; }
    else if (hue < 120) { r = x; g = c; }
    else if (hue < 180) { g = c; b = x; }
    else if (hue < 240) { g = x; b = c; }
    else if (hue < 300) { r = x; b = c; }
    else                { r = c; b = x; }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function noteName(n) {
    if (n < 0 || n > 127) return String(n);
    return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

// ============================================================================
// RTP0 binary codec
// ============================================================================
function parseRtpseq(buffer) {
    const dv = new DataView(buffer);
    if (buffer.byteLength < 8) throw new Error('File too small');
    if (dv.getUint8(0) !== 0x52 || dv.getUint8(1) !== 0x54 ||
        dv.getUint8(2) !== 0x50 || dv.getUint8(3) !== 0x30) {
        throw new Error('Not an RTP0 pattern file');
    }
    let o = 4;
    const u8  = () => dv.getUint8(o++);
    const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
    const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };

    const version  = u8();
    if (version < 1 || version > 4) throw new Error('Unsupported RTP version ' + version);
    const nScenes  = u8();
    /* sceneBlock */ u8();
    const selScene = u8();

    const scenes = [];
    for (let i = 0; i < nScenes; i++) {
        const nameLen = u8();
        let name = '';
        for (let k = 0; k < nameLen; k++) name += String.fromCharCode(u8());
        const selSeq = version >= 2 ? u8() : 0;
        const nSeq   = u8();
        const seqs = [];
        for (let j = 0; j < nSeq; j++) {
            const t = u8(), c = u8(), col = u8(), len = u8(), inp = u8(), port = u8();
            const nNotes = u16();
            const en  = version >= 2 ? u8() : 1;
            const div = version >= 3 ? u8() : 6;
            let nm = '';
            if (version >= 4) {
                const nmLen = u8();
                for (let k = 0; k < nmLen; k++) nm += String.fromCharCode(u8());
            }
            const notes = [];
            for (let k = 0; k < nNotes; k++) {
                const low = u32(), high = u32();
                notes.push({
                    n:   low & 0xFF,
                    r:   (low >>> 8)  & 0xFF,
                    v:   (low >>> 16) & 0xFF,
                    l:   (low >>> 24) & 0xF,
                    ttl: (low >>> 28) & 0xF,
                    on:  ((high >>> 16) & 1) !== 0,
                    lit: ((high >>> 17) & 1) !== 0
                });
            }
            seqs.push({ t, c, col, l: len, i: inp, p: port, e: en, d: div, nm, s: notes });
        }
        scenes.push({ n: name, sel: selSeq, q: seqs });
    }
    return { sel: selScene, sc: scenes };
}

function serializeRtpseq(data) {
    const enc = new TextEncoder();
    // Write v4 only when a sequence actually carries a name, so files stay
    // loadable by firmware that only understands up to v3.
    const hasNames = data.sc.some(sc => sc.q.some(q => q.nm));
    const version = hasNames ? 4 : 3;

    let size = 8;
    for (const scene of data.sc) {
        size += 1 + enc.encode(scene.n || '').length + 2;
        for (const seq of scene.q) {
            size += 10 + seq.s.length * 8;
            if (version >= 4) size += 1 + enc.encode(seq.nm || '').length;
        }
    }
    const buf = new ArrayBuffer(size);
    const dv  = new DataView(buf);
    let o = 0;
    const u8  = v => { dv.setUint8(o, v & 0xFF); o += 1; };
    const u16 = v => { dv.setUint16(o, v & 0xFFFF, true); o += 2; };
    const u32 = v => { dv.setUint32(o, v >>> 0, true); o += 4; };

    u8(0x52); u8(0x54); u8(0x50); u8(0x30);          // 'RTP0'
    u8(version); u8(data.sc.length); u8(SCENE_BLOCK); u8(data.sel || 0);

    for (const scene of data.sc) {
        const nb = enc.encode(scene.n || '');
        u8(nb.length);
        for (const b of nb) u8(b);
        u8(scene.sel || 0);
        u8(scene.q.length);
        for (const seq of scene.q) {
            u8(seq.t); u8(seq.c); u8(seq.col || 0); u8(seq.l);
            u8(seq.i || 0); u8(seq.p || 0);
            u16(seq.s.length);
            u8(seq.e ? 1 : 0);
            u8(seq.d === undefined ? 6 : seq.d);
            if (version >= 4) {
                const snb = enc.encode(seq.nm || '');
                u8(snb.length);
                for (const b of snb) u8(b);
            }
            for (const note of seq.s) {
                const low = (note.n & 0xFF) | ((note.r & 0xFF) << 8) |
                            ((note.v & 0xFF) << 16) | ((note.l & 0xF) << 24) |
                            (((note.ttl === undefined ? note.l : note.ttl) & 0xF) << 28);
                // per-note ch/port/hostIdx are overwritten at playback; use defaults
                const high = (0xFF << 8) | ((note.on ? 1 : 0) << 16) |
                             ((note.lit ? 1 : 0) << 17);
                u32(low); u32(high);
            }
        }
    }
    return buf;
}

// ============================================================================
// Legacy JSON import / export (firmware-compatible key names)
// ============================================================================
function normalizeJson(data) {
    const scenes = (data.sc || data.scenes || []).map(scene => ({
        n:   scene.n || '',
        sel: scene.sel || 0,
        q:   (scene.q || []).map(seq => {
            const t = seq.t !== undefined ? seq.t : (seq.type || 0);
            const rawNotes = seq.s || seq.seq || [];
            const notes = rawNotes.map(note => {
                const v = note.v !== undefined ? note.v : (note.vel || 0);
                const r = note.r !== undefined ? note.r : (note.read || 0);
                const l = note.l !== undefined ? note.l : (note.len || 1);
                return { n: t === 0 ? r : 0, r, v, l, ttl: l, on: v > 0, lit: false };
            });
            return {
                t,
                c:   seq.c !== undefined ? seq.c : (seq.ch || 1),
                col: seq.col || 0,
                l:   seq.l || Math.max(1, Math.ceil(notes.length / SEQ_BLOCK)),
                i:   seq.i || 0,
                p:   seq.p || 0,
                e:   seq.e === undefined ? 1 : seq.e,
                d:   seq.d === undefined ? 6 : seq.d,
                nm:  seq.n || '',
                s:   notes
            };
        })
    }));
    return { sel: data.sel || 0, sc: scenes };
}

function toFirmwareJson(data) {
    return {
        sel: data.sel || 0,
        sc: data.sc.map(scene => ({
            n: scene.n, sel: scene.sel || 0,
            q: scene.q.map(seq => ({
                t: seq.t, c: seq.c, p: seq.p || 0, i: seq.i || 0,
                l: seq.l, d: seq.d === undefined ? 6 : seq.d,
                e: seq.e ? 1 : 0, n: seq.nm || '',
                s: seq.s.map(note => ({
                    r: seq.t === 0 ? note.n : note.r,
                    v: note.on ? note.v : 0,
                    l: note.l
                }))
            }))
        }))
    };
}

// ============================================================================
// File loading
// ============================================================================
function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const buf = e.target.result;
            const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
            let data;
            if (head[0] === 0x52 && head[1] === 0x54 && head[2] === 0x50 && head[3] === 0x30) {
                data = parseRtpseq(buf);
            } else {
                data = normalizeJson(JSON.parse(new TextDecoder().decode(buf)));
            }
            currentFileName = file.name;
            loadSequencerData(data);
            setStatus(`Loaded ${file.name} — ${data.sc.length} scene(s)`);
        } catch (err) {
            setStatus('Error: ' + err.message, true);
        }
    };
    reader.readAsArrayBuffer(file);
}

function loadSequencerData(data) {
    sequencerData = data;
    saveFileBtn.disabled = false;
    exportJsonBtn.disabled = false;
    fileNameLabel.textContent = currentFileName || 'untitled';
    renderScenesList();
    if (sequencerData.sc.length > 0) {
        selectScene(Math.min(sequencerData.sel || 0, sequencerData.sc.length - 1));
    }
}

function setStatus(msg, isError) {
    statusBar.textContent = msg;
    statusBar.classList.toggle('error', !!isError);
}

// ============================================================================
// Rendering — scenes
// ============================================================================
function renderScenesList() {
    scenesList.innerHTML = '';
    if (!sequencerData) return;
    sequencerData.sc.forEach((scene, index) => {
        const li = document.createElement('li');
        li.className = 'scene-item';
        li.dataset.index = index;
        li.textContent = scene.n || `Scene ${index + 1}`;
        li.title = 'Double-click to rename';
        if (index === currentSceneIndex) li.classList.add('active');
        li.addEventListener('click', () => selectScene(index));
        li.addEventListener('dblclick', () => renameScene(li, scene));
        scenesList.appendChild(li);
    });
}

function renameScene(li, scene) {
    const input = document.createElement('input');
    input.className = 'scene-rename';
    input.value = scene.n || '';
    input.maxLength = 32;
    li.textContent = '';
    li.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
        scene.n = input.value.trim();
        renderScenesList();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = scene.n || ''; input.blur(); }
    });
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

function selectScene(index) {
    currentSceneIndex = index;
    currentSequenceIndex = -1;
    selectedNoteIndex = -1;
    if (sequencerData) sequencerData.sel = index;
    const scene = sequencerData.sc[index];
    currentSceneIndexSpan.textContent = index + 1;
    currentSceneNameSpan.textContent = scene.n ? `— ${scene.n}` : '';
    document.querySelectorAll('.scene-item').forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.index) === index);
    });
    renderSequences();
    clearSequenceEditor();
}

// ============================================================================
// Rendering — sequence cards (4×4 trellis layout, row 0 at bottom)
// ============================================================================
function renderSequences() {
    sequencesContainer.innerHTML = '';
    if (currentSceneIndex === -1 || !sequencerData) return;
    const scene = sequencerData.sc[currentSceneIndex];
    if (!scene.q || scene.q.length === 0) {
        sequencesContainer.innerHTML = '<p class="empty-hint">No sequences in this scene</p>';
        return;
    }

    const numCols = 4;
    const numRows = Math.ceil(scene.q.length / numCols);
    const rows = [];
    for (let i = 0; i < numRows; i++) rows.push(scene.q.slice(i * numCols, (i + 1) * numCols));
    rows.reverse();

    rows.forEach((row, rowIdx) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'sequence-row';
        sequencesContainer.appendChild(rowDiv);

        row.forEach((sequence, colIdx) => {
            const index = (numRows - 1 - rowIdx) * numCols + colIdx;
            const card = document.createElement('div');
            card.className = 'sequence-card';
            card.dataset.index = index;
            if (!sequence.e) card.classList.add('muted');
            if (index === currentSequenceIndex) card.classList.add('selected');
            card.style.setProperty('--seq-color', colorForIndex(sequence.col || 0));

            const head = document.createElement('div');
            head.className = 'card-head';
            head.innerHTML =
                `<span class="type-dot"></span>` +
                `<span class="card-title">${escapeHtml(sequence.nm || 'Seq ' + (index + 1))}</span>` +
                `<span class="card-type">${TYPE_NAMES[sequence.t] || '?'}</span>`;
            card.appendChild(head);

            const meta = document.createElement('div');
            meta.className = 'card-meta';
            meta.innerHTML =
                `<span>CH ${sequence.c}</span>` +
                `<span>${PORT_NAMES[sequence.p] || 'Port ' + sequence.p}</span>` +
                `<span>${CLOCK_DIVIDER_LABELS[sequence.d] || '1/16'}</span>` +
                `<span>${sequence.l}p</span>`;
            card.appendChild(meta);

            const preview = document.createElement('div');
            preview.className = 'sequence-preview';
            createMiniSequencePreview(preview, sequence);
            card.appendChild(preview);

            card.addEventListener('click', () => selectSequence(index));
            rowDiv.appendChild(card);
        });
    });
}

function createMiniSequencePreview(container, sequence) {
    container.innerHTML = '';
    if (!sequence || !sequence.s) return;
    const grid = document.createElement('div');
    grid.className = 'mini-grid';
    container.appendChild(grid);
    const color = colorForIndex(sequence.col || 0);
    const total = sequence.s.length;
    const bars = Math.ceil(total / SEQ_BLOCK);
    for (let bar = 0; bar < bars; bar++) {
        const barDiv = document.createElement('div');
        barDiv.className = 'mini-bar';
        for (let step = 0; step < SEQ_BLOCK; step++) {
            const idx = bar * SEQ_BLOCK + step;
            if (idx >= total) break;
            const cell = document.createElement('div');
            cell.className = 'mini-cell';
            if (sequence.s[idx].on) {
                cell.classList.add('active');
                cell.style.backgroundColor = color;
                cell.style.opacity = 0.35 + 0.65 * (sequence.s[idx].v / 127);
            }
            barDiv.appendChild(cell);
        }
        grid.appendChild(barDiv);
    }
}

// ============================================================================
// Add / remove scenes & sequences
// ============================================================================
function makeEmptyNote() {
    return { n: 0, r: 0, v: 0, l: 1, ttl: 1, on: false, lit: false };
}

function makeDefaultSequence() {
    return {
        t: 2, c: 1, col: 8, l: 1, i: 0, p: 0, e: 1, d: 6, nm: '',
        s: Array.from({ length: SEQ_BLOCK }, makeEmptyNote)
    };
}

function addScene() {
    if (!sequencerData) return;
    const seqs = [];
    for (let i = 0; i < SCENE_BLOCK; i++) seqs.push(makeDefaultSequence());
    sequencerData.sc.push({ n: '', sel: 0, q: seqs });
    renderScenesList();
    selectScene(sequencerData.sc.length - 1);
    setStatus(`Scene added — ${sequencerData.sc.length} scenes`);
}

function removeScene() {
    if (!sequencerData || sequencerData.sc.length <= 1) {
        setStatus('Cannot remove the last scene', true);
        return;
    }
    sequencerData.sc.splice(currentSceneIndex, 1);
    if (sequencerData.sel >= sequencerData.sc.length)
        sequencerData.sel = sequencerData.sc.length - 1;
    const next = Math.min(currentSceneIndex, sequencerData.sc.length - 1);
    renderScenesList();
    selectScene(next);
    setStatus(`Scene removed — ${sequencerData.sc.length} scenes`);
}

function addSequence() {
    const scene = sequencerData && sequencerData.sc[currentSceneIndex];
    if (!scene) return;
    if (scene.q.length >= SCENE_BLOCK) {
        setStatus('Scene already has 16 sequences', true);
        return;
    }
    scene.q.push(makeDefaultSequence());
    renderSequences();
    selectSequence(scene.q.length - 1);
}

function removeSequence() {
    const scene = sequencerData && sequencerData.sc[currentSceneIndex];
    if (!scene || scene.q.length === 0) return;
    const idx = currentSequenceIndex >= 0 ? currentSequenceIndex : scene.q.length - 1;
    scene.q.splice(idx, 1);
    if (scene.sel >= scene.q.length) scene.sel = Math.max(0, scene.q.length - 1);
    currentSequenceIndex = -1;
    selectedNoteIndex = -1;
    renderSequences();
    clearSequenceEditor();
}

// ============================================================================
// Sequence editor
// ============================================================================
function selectSequence(index) {
    currentSequenceIndex = index;
    selectedNoteIndex = -1;
    document.querySelectorAll('.sequence-card').forEach(card => {
        card.classList.toggle('selected', parseInt(card.dataset.index, 10) === index);
    });
    loadSequenceIntoEditor();
}

function currentSequence() {
    if (currentSceneIndex === -1 || currentSequenceIndex === -1) return null;
    return sequencerData.sc[currentSceneIndex].q[currentSequenceIndex];
}

function loadSequenceIntoEditor() {
    const seq = currentSequence();
    if (!seq) return;

    $('sequenceName').value    = seq.nm || '';
    $('sequenceType').value    = seq.t;
    $('sequenceChannel').value = seq.c;
    $('sequencePort').value    = seq.p || 0;
    $('sequenceInput').value   = seq.i || 0;
    $('sequenceDivider').value = seq.d === undefined ? 6 : seq.d;
    $('sequenceLength').value  = seq.l;
    $('sequenceColor').value   = seq.col || 0;
    $('sequenceEnabled').checked = !!seq.e;
    updateColorSwatch();

    const dot = $('editorTypeDot');
    dot.style.backgroundColor = colorForIndex(seq.col || 0);

    $('editorTitle').textContent =
        `${seq.nm || 'Sequence ' + (currentSequenceIndex + 1)} — ${TYPE_NAMES[seq.t] || '?'}`;

    renderNotesGrid(seq);
    hideNoteInspector();
}

function updateColorSwatch() {
    $('colorSwatch').style.backgroundColor = colorForIndex(parseInt($('sequenceColor').value));
}

function updateSequenceProperty() {
    const seq = currentSequence();
    if (!seq) return;
    seq.t   = parseInt($('sequenceType').value);
    seq.nm  = $('sequenceName').value.trim();
    seq.c   = parseInt($('sequenceChannel').value);
    seq.p   = parseInt($('sequencePort').value);
    seq.i   = parseInt($('sequenceInput').value);
    seq.d   = parseInt($('sequenceDivider').value);
    seq.col = parseInt($('sequenceColor').value);
    seq.e   = $('sequenceEnabled').checked ? 1 : 0;

    const newLen = parseInt($('sequenceLength').value);
    if (newLen !== seq.l) {
        seq.l = newLen;
        resizeSequence(seq, newLen * SEQ_BLOCK);
    }

    $('editorTypeDot').style.backgroundColor = colorForIndex(seq.col || 0);
    $('editorTitle').textContent =
        `${seq.nm || 'Sequence ' + (currentSequenceIndex + 1)} — ${TYPE_NAMES[seq.t] || '?'}`;
    updateColorSwatch();
    renderSequences();
    renderNotesGrid(seq);
}

function resizeSequence(seq, newSize) {
    while (seq.s.length < newSize) {
        seq.s.push({ n: 0, r: 0, v: 0, l: 1, ttl: 1, on: false, lit: false });
    }
    seq.s.length = newSize;
}

// ============================================================================
// Notes grid
// ============================================================================
function renderNotesGrid(sequence) {
    notesGrid.innerHTML = '';
    if (!sequence || !sequence.s) return;
    const color = colorForIndex(sequence.col || 0);
    const total = sequence.s.length;
    const bars = Math.ceil(total / SEQ_BLOCK);

    for (let bar = 0; bar < bars; bar++) {
        const row = document.createElement('div');
        row.className = 'notes-row';

        const label = document.createElement('span');
        label.className = 'bar-label';
        label.textContent = bar + 1;
        row.appendChild(label);

        for (let i = 0; i < SEQ_BLOCK; i++) {
            const idx = bar * SEQ_BLOCK + i;
            if (idx >= total) break;
            const note = sequence.s[idx];
            const cell = document.createElement('div');
            cell.className = 'note-cell';
            cell.dataset.index = idx;
            if (i % 4 === 0) cell.classList.add('beat-start');
            paintNoteCell(cell, note, color, sequence.t);

            cell.addEventListener('click', () => onNoteClick(idx));
            cell.addEventListener('dblclick', () => toggleNote(idx));
            cell.addEventListener('wheel', e => onNoteWheel(e, idx), { passive: false });
            row.appendChild(cell);
        }
        notesGrid.appendChild(row);
    }
}

// Label shown inside an active cell, per sequence type.
// Harmony tracks store root (r, 0-11) + chord type (v, 0-15) instead of
// pitch/velocity, so they get chord labels like "Am7".
function cellLabel(seqType, note) {
    if (seqType === TYPE_HARMONY) {
        const root  = NOTE_NAMES[note.r % 12];
        const chord = CHORD_NAMES[note.v & 0xF];
        return chord === 'note' ? root : root + chord;
    }
    if (seqType === 0) return note.n ? noteName(note.n) : '';   // drum: pitch
    return note.n ? noteName(note.n) : (note.r || '');
}

function paintNoteCell(cell, note, color, seqType) {
    cell.classList.toggle('active', note.on);
    cell.classList.toggle('selected', parseInt(cell.dataset.index) === selectedNoteIndex);
    if (note.on) {
        cell.style.backgroundColor = color;
        cell.style.opacity = 0.3 + 0.7 * (note.v / 127);
    } else {
        cell.style.backgroundColor = '';
        cell.style.opacity = '';
    }
    const isHarmony = seqType === TYPE_HARMONY;
    cell.innerHTML =
        `<span class="cell-note">${note.on ? cellLabel(seqType, note) : ''}</span>` +
        `<span class="cell-vel">${note.on && !isHarmony ? note.v : ''}</span>` +
        `<span class="cell-len">${note.on && note.l > 1 ? note.l : ''}</span>`;
}

function onNoteClick(idx) {
    selectedNoteIndex = idx;
    const seq = currentSequence();
    document.querySelectorAll('.note-cell').forEach(c =>
        c.classList.toggle('selected', parseInt(c.dataset.index) === idx));
    showNoteInspector(seq, idx);
}

function toggleNote(idx) {
    const seq = currentSequence();
    if (!seq || idx >= seq.s.length) return;
    const note = seq.s[idx];
    note.on = !note.on;
    if (note.on && note.v === 0) note.v = 100;
    refreshNote(idx);
}

function onNoteWheel(e, idx) {
    e.preventDefault();
    const seq = currentSequence();
    if (!seq || idx >= seq.s.length) return;
    const note = seq.s[idx];
    if (!note.on) return;
    const delta = e.deltaY < 0 ? 1 : -1;
    if (e.shiftKey) {
        note.l = Math.max(1, Math.min(15, note.l + delta));
        note.ttl = note.l;
    } else if (seq.t === TYPE_HARMONY) {
        // wheel cycles chord types on harmony tracks
        note.v = Math.max(0, Math.min(15, note.v + delta));
    } else {
        note.v = Math.max(1, Math.min(127, note.v + delta * 5));
    }
    refreshNote(idx);
    if (selectedNoteIndex === idx) showNoteInspector(seq, idx);
}

function refreshNote(idx) {
    const seq = currentSequence();
    const cell = notesGrid.querySelector(`.note-cell[data-index="${idx}"]`);
    if (cell && seq) paintNoteCell(cell, seq.s[idx], colorForIndex(seq.col || 0), seq.t);
    updateMiniPreview(seq);
}

function updateMiniPreview(sequence) {
    const card = sequencesContainer.querySelector(
        `.sequence-card[data-index="${currentSequenceIndex}"]`);
    if (card) {
        const preview = card.querySelector('.sequence-preview');
        if (preview) createMiniSequencePreview(preview, sequence);
    }
}

// ============================================================================
// Note inspector
// ============================================================================
function showNoteInspector(seq, idx) {
    const note = seq.s[idx];
    const isHarmony = seq.t === TYPE_HARMONY;
    noteInspector.hidden = false;
    $('niStep').textContent = idx + 1;
    $('niOn').checked = note.on;
    $('niLen').value = note.l;

    // Harmony steps are (root, chord type); everything else is pitch/vel/etc.
    $('niStandardFields').hidden = isHarmony;
    $('niHarmonyFields').hidden = !isHarmony;
    if (isHarmony) {
        $('niRoot').value = note.r % 12;
        $('niChord').value = note.v & 0xF;
    } else {
        $('niNote').value = note.n;
        $('niNoteName').textContent = noteName(note.n);
        $('niRead').value = note.r;
        $('niVel').value = note.v;
        $('niVelRange').value = note.v;
        $('niLit').checked = note.lit;
    }
}

function hideNoteInspector() {
    noteInspector.hidden = true;
    selectedNoteIndex = -1;
}

function applyNoteInspector() {
    const seq = currentSequence();
    if (!seq || selectedNoteIndex < 0) return;
    const note = seq.s[selectedNoteIndex];
    note.on  = $('niOn').checked;
    note.l   = Math.max(1, Math.min(15, parseInt($('niLen').value) || 1));
    note.ttl = note.l;
    if (seq.t === TYPE_HARMONY) {
        note.r = parseInt($('niRoot').value);
        note.v = parseInt($('niChord').value);
    } else {
        note.n   = Math.max(0, Math.min(127, parseInt($('niNote').value) || 0));
        note.r   = Math.max(0, Math.min(127, parseInt($('niRead').value) || 0));
        note.v   = Math.max(0, Math.min(127, parseInt($('niVel').value) || 0));
        note.lit = $('niLit').checked;
        $('niNoteName').textContent = noteName(note.n);
    }
    refreshNote(selectedNoteIndex);
}

// ============================================================================
// Editor helpers
// ============================================================================
function clearSequenceEditor() {
    notesGrid.innerHTML = '';
    $('editorTitle').textContent = 'Select a sequence';
    $('editorTypeDot').style.backgroundColor = 'transparent';
    hideNoteInspector();
}

// ============================================================================
// Save / export
// ============================================================================
function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

function saveChanges() {
    if (!sequencerData) return;
    const buf = serializeRtpseq(sequencerData);
    const name = (currentFileName || 'pattern.rtpseq')
        .replace(/\.(json|bin)$/i, '.rtpseq');
    download(new Blob([buf], { type: 'application/octet-stream' }),
             name.endsWith('.rtpseq') ? name : name + '.rtpseq');
    setStatus(`Saved ${name} (${buf.byteLength} bytes)`);
}

function exportJson() {
    if (!sequencerData) return;
    const json = JSON.stringify(toFirmwareJson(sequencerData));
    download(new Blob([json], { type: 'application/json' }), 'scenes.json');
    setStatus('Exported scenes.json (legacy format — note pitch is not preserved)');
}

// ============================================================================
// Init
// ============================================================================
function init() {
    loadFileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
    saveFileBtn.addEventListener('click', saveChanges);
    exportJsonBtn.addEventListener('click', exportJson);

    // Sequence property controls
    for (const id of ['sequenceType', 'sequenceChannel', 'sequencePort',
                      'sequenceInput', 'sequenceDivider', 'sequenceLength',
                      'sequenceColor', 'sequenceEnabled']) {
        $(id).addEventListener('change', updateSequenceProperty);
    }
    $('sequenceName').addEventListener('input', updateSequenceProperty);
    $('sequenceColor').addEventListener('input', updateColorSwatch);

    // Scene / sequence add-remove
    $('addSceneBtn').addEventListener('click', addScene);
    $('removeSceneBtn').addEventListener('click', removeScene);
    $('addSeqBtn').addEventListener('click', addSequence);
    $('removeSeqBtn').addEventListener('click', removeSequence);

    // Note inspector controls
    for (const id of ['niOn', 'niNote', 'niRead', 'niVel', 'niLen', 'niLit',
                      'niRoot', 'niChord']) {
        $(id).addEventListener('change', applyNoteInspector);
    }
    $('niVelRange').addEventListener('input', e => {
        $('niVel').value = e.target.value;
        applyNoteInspector();
    });
    $('niNote').addEventListener('input', e => {
        $('niNoteName').textContent = noteName(parseInt(e.target.value) || 0);
    });

    // Drag & drop
    let dragDepth = 0;
    window.addEventListener('dragenter', e => {
        e.preventDefault();
        dragDepth++;
        dropOverlay.hidden = false;
    });
    window.addEventListener('dragleave', e => {
        e.preventDefault();
        if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.hidden = true; }
    });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
        e.preventDefault();
        dragDepth = 0;
        dropOverlay.hidden = true;
        if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });

    // Auto-load: try a pattern next to the app (works when served by a
    // webserver, e.g. the ESP32), then fall back to the legacy JSON demo.
    fetch('pattern.rtpseq')
        .then(r => r.ok ? r.arrayBuffer() : Promise.reject())
        .then(buf => {
            currentFileName = 'pattern.rtpseq';
            loadSequencerData(parseRtpseq(buf));
            setStatus('Loaded pattern.rtpseq');
        })
        .catch(() => fetch('data/scenes.json')
            .then(r => r.ok ? r.json() : Promise.reject())
            .then(data => {
                currentFileName = 'scenes.json';
                loadSequencerData(normalizeJson(data));
                setStatus('Loaded legacy scenes.json');
            })
            .catch(() => setStatus('Drop a .rtpseq or .json file to begin')));
}

window.addEventListener('DOMContentLoaded', init);
