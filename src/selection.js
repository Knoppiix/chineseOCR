const { ipcRenderer } = require('electron');

let startX, startY, selectionBox;

// Add keydown listener directly on load for immediate escape functionality
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    console.log('Escape key pressed. Sending selection:done');
    // Explicitly remove selectionBox if it exists
    if (selectionBox && selectionBox.parentNode) {
      selectionBox.parentNode.removeChild(selectionBox);
    }
    ipcRenderer.send('selection:done');
    window.close(); // Close the current selection window
  }
});

document.addEventListener('mousedown', (e) => {
  startX = e.clientX;
  startY = e.clientY;
  selectionBox = document.createElement('div');
  selectionBox.classList.add('selection-box');
  selectionBox.style.left = `${startX}px`;
  selectionBox.style.top = `${startY}px`;
  document.body.appendChild(selectionBox);

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

function onMouseMove(e) {
  const width = e.clientX - startX;
  const height = e.clientY - startY;
  selectionBox.style.width = `${Math.abs(width)}px`;
  selectionBox.style.height = `${Math.abs(height)}px`;
  selectionBox.style.left = `${width > 0 ? startX : e.clientX}px`;
  selectionBox.style.top = `${height > 0 ? startY : e.clientY}px`;
}

function onMouseUp(e) {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);

  const rect = {
    x: parseInt(selectionBox.style.left),
    y: parseInt(selectionBox.style.top),
    width: parseInt(selectionBox.style.width),
    height: parseInt(selectionBox.style.height)
  };

  // Explicitly remove the selectionBox from the DOM
  if (selectionBox && selectionBox.parentNode) {
    selectionBox.parentNode.removeChild(selectionBox);
  }

  ipcRenderer.send('screenshot:region', rect);
  ipcRenderer.send('selection:done');
  window.close(); // Close the current selection window
}