// Main application state
let sequencerData = null;
let currentSceneIndex = -1;
let currentSequenceIndex = -1;

// DOM Elements
const fileInput = document.getElementById('fileInput');
const loadFileBtn = document.getElementById('loadFileBtn');
const saveFileBtn = document.getElementById('saveFileBtn');
const scenesList = document.getElementById('scenesList');
const sequencesContainer = document.getElementById('sequencesContainer');
const currentSceneIndexSpan = document.getElementById('currentSceneIndex');
const sequenceType = document.getElementById('sequenceType');
const sequenceChannel = document.getElementById('sequenceChannel');
const notesGrid = document.getElementById('notesGrid');

// Event Listeners
loadFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFileSelect);
saveFileBtn.addEventListener('click', saveChanges);

// Initialize the application
function init() {
    // Check if scenes.json exists in the same directory
    fetch('scenes.json')
        .then(response => {
            if (response.ok) {
                return response.json();
            }
            throw new Error('No scenes.json file found');
        })
        .then(data => {
            loadSequencerData(data);
        })
        .catch(error => {
            console.error('Error loading scenes.json:', error);
        });
}

// Handle file selection
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            loadSequencerData(data);
        } catch (error) {
            alert('Error parsing JSON file: ' + error.message);
        }
    };
    reader.readAsText(file);
}

// Load sequencer data and update UI
function loadSequencerData(data) {
    sequencerData = data;
    saveFileBtn.disabled = false;
    
    // Render scenes list
    renderScenesList();
    
    // Select first scene by default
    if (sequencerData.sc && sequencerData.sc.length > 0) {
        selectScene(0);
    }
}

// Render the list of scenes
function renderScenesList() {
    scenesList.innerHTML = '';
    
    if (!sequencerData || !sequencerData.sc) return;
    
    sequencerData.sc.forEach((scene, index) => {
        const sceneItem = document.createElement('li');
        sceneItem.className = 'scene-item';
        sceneItem.textContent = `Scene ${index + 1}`;
        sceneItem.dataset.index = index;
        
        if (index === currentSceneIndex) {
            sceneItem.classList.add('active');
        }
        
        sceneItem.addEventListener('click', () => selectScene(index));
        scenesList.appendChild(sceneItem);
    });
}

// Select a scene and display its sequences
function selectScene(index) {
    currentSceneIndex = index;
    currentSequenceIndex = -1;
    
    // Update UI
    currentSceneIndexSpan.textContent = index + 1;
    
    // Update active scene in list
    document.querySelectorAll('.scene-item').forEach(item => {
        item.classList.toggle('active', parseInt(item.dataset.index) === index);
    });
    
    // Render sequences for this scene
    renderSequences();
    
    // Clear sequence editor
    clearSequenceEditor();
}

// Render sequences for the current scene
function renderSequences() {
    sequencesContainer.innerHTML = '';
    
    if (currentSceneIndex === -1 || !sequencerData || !sequencerData.sc[currentSceneIndex]) return;
    
    const scene = sequencerData.sc[currentSceneIndex];
    
    if (!scene.q || scene.q.length === 0) {
        sequencesContainer.innerHTML = '<p>No sequences in this scene</p>';
        return;
    }
    
    // Classic matrix layout: group in rows of 4, bottom-to-top
    const sequences = [...scene.q];
    const rows = [];
    const numCols = 4;
    const numRows = Math.ceil(sequences.length / numCols);
    for (let i = 0; i < numRows; i++) {
        rows.push(sequences.slice(i * numCols, (i + 1) * numCols));
    }
    rows.reverse(); // So first row (sequences 1-4) is at the bottom, last row at the top
    
    // Render each row
    rows.forEach((row, rowIdx) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'sequence-row';
        sequencesContainer.appendChild(rowDiv);
        
        // Render each sequence in the row
        row.forEach((sequence, colIdx) => {
            // Compute the actual index in the original scene.q array
            // Since rows are reversed, we need to map back:
            const actualRow = numRows - 1 - rowIdx;
            const index = actualRow * numCols + colIdx;
            const sequenceCard = document.createElement('div');
            sequenceCard.className = 'sequence-card';
            sequenceCard.setAttribute('data-index', index);
            if (index === currentSequenceIndex) {
                sequenceCard.classList.add('selected');
            }
            
            const sequenceTitle = document.createElement('h3');
            
            // Add color indicator for sequence type
            const typeIndicator = document.createElement('span');
            typeIndicator.className = `type-indicator sequence-type-${sequence.t}`;
            sequenceTitle.appendChild(typeIndicator);
            
            // Add sequence number
            const titleText = document.createTextNode(`Sequence ${index + 1}`);
            sequenceTitle.appendChild(titleText);
            
            const sequenceInfo = document.createElement('div');
            sequenceInfo.className = 'sequence-info';
            
            // Get type name based on sequence type
            let typeName = 'Unknown';
            switch(sequence.t) {
                case 0: typeName = 'DRUM'; break;
                case 1: typeName = 'BASS SYNTH'; break;
                case 2: typeName = 'MONO SYNTH'; break;
                case 3: typeName = 'POLY SYNTH'; break;
                case 4: typeName = 'CONTROL TRACK'; break;
                case 5: typeName = 'HARMONY TRACK'; break;
            }
            
            // Create type div
            const typeDiv = document.createElement('div');
            typeDiv.className = 'sequence-type';
            typeDiv.textContent = typeName;
            sequenceInfo.appendChild(typeDiv);
            
            // Create channel div
            const channelDiv = document.createElement('div');
            channelDiv.className = 'sequence-channel';
            channelDiv.textContent = `CH${sequence.c}`;
            sequenceInfo.appendChild(channelDiv);
            
            const sequencePreview = document.createElement('div');
            sequencePreview.className = 'sequence-preview';
            
            // Create a mini visualization of the sequence
            createMiniSequencePreview(sequencePreview, sequence);
            
            sequenceCard.appendChild(sequenceTitle);
            sequenceCard.appendChild(sequenceInfo);
            sequenceCard.appendChild(sequencePreview);
            
            sequenceCard.addEventListener('click', () => {
                selectSequence(index);
            });
            
            rowDiv.appendChild(sequenceCard);
        });
    });
}

// Select a sequence and display it in the editor
function selectSequence(index) {
    currentSequenceIndex = index;
    
    // Update active sequence in grid
    document.querySelectorAll('.sequence-card').forEach(card => {
        card.classList.toggle('active', parseInt(card.dataset.index, 10) === index);
    });
    
    // Load sequence data into editor
    loadSequenceIntoEditor();
}

// Load the current sequence into the editor
function loadSequenceIntoEditor() {
    if (currentSceneIndex === -1 || currentSequenceIndex === -1) return;
    
    const sequence = sequencerData.sc[currentSceneIndex].q[currentSequenceIndex];
    
    // Set sequence properties
    sequenceType.value = sequence.t;
    sequenceChannel.value = sequence.c;
    
    // Update the editor title with sequence type color
    const editorTitle = document.querySelector('.sequence-editor h2');
    editorTitle.innerHTML = '';
    
    // Add color indicator
    const typeIndicator = document.createElement('span');
    typeIndicator.className = `type-indicator sequence-type-${sequence.t}`;
    editorTitle.appendChild(typeIndicator);
    
    // Add text
    const titleText = document.createTextNode('Sequence Editor');
    editorTitle.appendChild(titleText);
    
    // Render notes grid
    renderNotesGrid(sequence);
    
    // Add event listeners for property changes
    sequenceType.onchange = updateSequenceProperty;
    sequenceChannel.onchange = updateSequenceProperty;
}

// Render the notes grid for the current sequence
function renderNotesGrid(sequence) {
    notesGrid.innerHTML = '';
    
    if (!sequence || !sequence.s) return;
    
    // Add sequence type class to the notes grid for styling active notes
    notesGrid.className = `notes-grid sequence-type-${sequence.t}`;
    
    // Calculate how many bars we need (assuming 16 steps per bar)
    const totalNotes = sequence.s.length;
    const barsCount = Math.ceil(totalNotes / 16);
    
    // Render bars in reverse order (from bottom to top)
    for (let bar = barsCount - 1; bar >= 0; bar--) {
        // Add a bar separator if this isn't the last bar (first in reversed order)
        if (bar < barsCount - 1) {
            const barSeparator = document.createElement('div');
            barSeparator.className = 'bar-separator';
            notesGrid.appendChild(barSeparator);
        }
        
        // Create a row for this bar
        const barRow = document.createElement('div');
        barRow.className = 'notes-row';
        notesGrid.appendChild(barRow);
        
        // Add the notes for this bar
        for (let i = 0; i < 16; i++) {
            const noteIndex = bar * 16 + i;
            
            // Skip if we've reached the end of the sequence
            if (noteIndex >= totalNotes) continue;
            
            const note = sequence.s[noteIndex];
            const noteCell = document.createElement('div');
            noteCell.className = 'note-cell';
            noteCell.dataset.index = noteIndex;
            
            // Add beat number indicator for first note in each group of 4
            if (i % 4 === 0) {
                noteCell.dataset.beat = (i / 4) + 1;
            }
            
            if (note.v > 0) {
                noteCell.classList.add('active');
                noteCell.classList.add(`active-type-${sequence.t}`);
                
                // Set brightness based on velocity (0-127)
                const brightness = 50 + (note.v / 127 * 50);
                noteCell.style.filter = `brightness(${brightness}%)`;
            }
            
            // Add velocity and length indicators
            const velocitySpan = document.createElement('span');
            velocitySpan.className = 'velocity';
            velocitySpan.textContent = note.v;
            
            const lengthSpan = document.createElement('span');
            lengthSpan.className = 'length';
            if (note.l) {
                lengthSpan.textContent = note.l;
            }
            
            noteCell.appendChild(velocitySpan);
            noteCell.appendChild(lengthSpan);
            
            // Add click event to toggle note
            noteCell.addEventListener('click', () => toggleNote(noteIndex));
            
            // Add wheel event to change velocity
            noteCell.addEventListener('wheel', (event) => {
                event.preventDefault();
                if (currentSceneIndex === -1 || currentSequenceIndex === -1) return;
                
                const sequence = sequencerData.sc[currentSceneIndex].q[currentSequenceIndex];
                if (!sequence || !sequence.s || noteIndex >= sequence.s.length) return;
                
                // Only adjust velocity if note is active
                if (sequence.s[noteIndex].v > 0) {
                    // Adjust velocity based on wheel direction (up = increase, down = decrease)
                    const delta = event.deltaY < 0 ? 5 : -5;
                    sequence.s[noteIndex].v = Math.max(1, Math.min(127, sequence.s[noteIndex].v + delta));
                    
                    // Update note cell appearance
                    updateNoteCell(noteIndex, sequence);
                    
                    // Update the mini preview
                    updateMiniPreview(sequence);
                }
            });
            
            barRow.appendChild(noteCell);
        }
    }
}

// Toggle note state
function toggleNote(index) {
    if (currentSceneIndex === -1 || currentSequenceIndex === -1) return;
    
    const sequence = sequencerData.sc[currentSceneIndex].q[currentSequenceIndex];
    if (!sequence || !sequence.s || index >= sequence.s.length) return;
    
    // Toggle velocity (0 = off, 127 = on)
    sequence.s[index].v = sequence.s[index].v > 0 ? 0 : 127;
    
    // Update note cell appearance
    updateNoteCell(index, sequence);
    
    // Update the mini preview
    updateMiniPreview(sequence);
}

// Update note cell appearance
function updateNoteCell(index, sequence) {
    // Find the note cell in the grid and update its classes
    const noteCell = document.querySelector(`.note-cell[data-index="${index}"]`);
    if (!noteCell) return;
    
    if (sequence.s[index].v > 0) {
        noteCell.classList.add('active');
        noteCell.classList.add(`active-type-${sequence.t}`);
        
        // Set brightness based on velocity (0-127)
        const brightness = 50 + (sequence.s[index].v / 127 * 50);
        noteCell.style.filter = `brightness(${brightness}%)`;
    } else {
        noteCell.classList.remove('active');
        noteCell.classList.remove(`active-type-${sequence.t}`);
        noteCell.style.filter = '';
    }
    
    // Update velocity display
    const velocitySpan = noteCell.querySelector('.velocity');
    if (velocitySpan) {
        velocitySpan.textContent = sequence.s[index].v;
    }
}

// Update the mini preview
function updateMiniPreview(sequence) {
    const sequenceCard = document.querySelector(`.sequence-card[data-index="${currentSequenceIndex}"]`);
    if (sequenceCard) {
        const previewContainer = sequenceCard.querySelector('.sequence-preview');
        if (previewContainer) {
            createMiniSequencePreview(previewContainer, sequence);
        }
    }
}

// Update sequence property (type or channel)
function updateSequenceProperty() {
    if (currentSceneIndex === -1 || currentSequenceIndex === -1) return;
    
    const sequence = sequencerData.sc[currentSceneIndex].q[currentSequenceIndex];
    
    sequence.t = parseInt(sequenceType.value);
    sequence.c = parseInt(sequenceChannel.value);
    
    // Update the editor title with sequence type color
    const editorTitle = document.querySelector('.sequence-editor h2');
    editorTitle.innerHTML = '';
    
    // Add color indicator
    const typeIndicator = document.createElement('span');
    typeIndicator.className = `type-indicator sequence-type-${sequence.t}`;
    editorTitle.appendChild(typeIndicator);
    
    // Add text
    const titleText = document.createTextNode('Sequence Editor');
    editorTitle.appendChild(titleText);
    
    // Update sequence card info
    renderSequences();
}

// Create a mini sequence preview
function createMiniSequencePreview(container, sequence) {
    container.innerHTML = '';
    
    if (!sequence || !sequence.s) return;
    
    const previewGrid = document.createElement('div');
    previewGrid.className = `mini-grid sequence-type-${sequence.t}`;
    container.appendChild(previewGrid);
    
    // Calculate bars
    const totalNotes = sequence.s.length;
    const barsCount = Math.ceil(totalNotes / 16);
    
    // Process bars in reverse order (bottom to top)
    for (let bar = barsCount - 1; bar >= 0; bar--) {
        const barContainer = document.createElement('div');
        barContainer.className = 'mini-bar';
        
        // Process notes in this bar
        for (let step = 0; step < 16; step++) {
            const noteIndex = bar * 16 + step;
            
            // Skip if we've reached the end of the sequence
            if (noteIndex >= totalNotes) continue;
            
            const note = sequence.s[noteIndex];
            const noteCell = document.createElement('div');
            noteCell.className = 'mini-cell';
            
            if (note.v > 0) {
                noteCell.classList.add('active');
                noteCell.classList.add(`active-type-${sequence.t}`);
            }
            
            barContainer.appendChild(noteCell);
        }
        
        previewGrid.appendChild(barContainer);
    }
}

// Clear the sequence editor
function clearSequenceEditor() {
    sequenceType.value = '';
    sequenceChannel.value = '';
    notesGrid.innerHTML = '';
}

// Save changes to a file
function saveChanges() {
    if (!sequencerData) return;
    
    const jsonString = JSON.stringify(sequencerData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scenes.json';
    a.click();
    
    URL.revokeObjectURL(url);
}

// Initialize the application when the page loads
window.addEventListener('DOMContentLoaded', init);
