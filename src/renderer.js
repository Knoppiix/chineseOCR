const { ipcRenderer } = require('electron');
const { translate, findWordsInText } = require('./translator');

const fullScreenshotBtn = document.getElementById('full-screenshot-btn');
const regionScreenshotBtn = document.getElementById('region-screenshot-btn');
const canvas = document.getElementById('screenshot-canvas');
const ctx = canvas.getContext('2d');
const hoverTextDiv = document.getElementById('hover-text');
const loadingIndicator = document.getElementById('loading-indicator');

let ocrData = [];

if (fullScreenshotBtn) {
  fullScreenshotBtn.addEventListener('click', () => {
    loadingIndicator.style.display = 'block';
    canvas.style.display = 'none';
    ipcRenderer.send('screenshot:full');
  });
}

if (regionScreenshotBtn) {
  regionScreenshotBtn.addEventListener('click', () => {
    loadingIndicator.style.display = 'block';
    canvas.style.display = 'none';
    ipcRenderer.send('screenshot:region-select');
  });
}

ipcRenderer.on('ocr:display-results', (event, { image, ocrData: newOcrData, error }) => {
  loadingIndicator.style.display = 'none';
  canvas.style.display = 'block';
  if (error) {
    console.error('Error from main process:', error);
    // Optionally display the error on the page
    return;
  }

  const img = new Image();
  img.onload = async () => { // Make the onload handler async
    try {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const originalOcrData = newOcrData;
      const displayData = [];

      // Group OCR results by line
      const lines = originalOcrData.reduce((acc, item) => {
          const yCenter = (item.bounding_box[0][1] + item.bounding_box[2][1]) / 2;
          const line = acc.find(l => Math.abs(l.yCenter - yCenter) < 20); // Group items within 20px vertically
          if (line) {
              line.items.push(item);
          } else {
              acc.push({ yCenter, items: [item] });
          }
          return acc;
      }, []);

      // Sort items within each line by their x-coordinate
      lines.forEach(line => line.items.sort((a, b) => a.bounding_box[0][0] - b.bounding_box[0][0]));

      // Process each line to find words and draw boxes
      for (const line of lines) { // Use for...of loop to allow await
          const lineText = line.items.map(item => item.text).join('');
          const words = await findWordsInText(lineText); // Await the async call
          let itemIndex = 0;

          while (itemIndex < line.items.length) {
              const word = words.find(w => w.startIndex === itemIndex);
              if (word) {
                  // This is a word from the dictionary, create a merged box
                  const wordItems = line.items.slice(word.startIndex, word.endIndex + 1);
                  const firstItemBox = wordItems[0].bounding_box;
                  const lastItemBox = wordItems[wordItems.length - 1].bounding_box;

                  const minX = Math.min(...firstItemBox.map(p => p[0]));
                  const minY = Math.min(...wordItems.flatMap(item => item.bounding_box.map(p => p[1])));
                  const maxX = Math.max(...lastItemBox.map(p => p[0]));
                  const maxY = Math.max(...wordItems.flatMap(item => item.bounding_box.map(p => p[1])));

                  const mergedBox = {
                      text: word.text,
                      bounding_box: [
                          [minX, minY],
                          [maxX, minY],
                          [maxX, maxY],
                          [minX, maxY]
                      ],
                      translation: word.translation
                  };
                  displayData.push(mergedBox);

                  ctx.strokeStyle = 'blue';
                  ctx.lineWidth = 2;
                  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
                  itemIndex = word.endIndex + 1;
              } else {
                  // This is a single character, not part of a dictionary word
                  const item = line.items[itemIndex];
                  const singleCharTranslation = await translate(item.text); // Await the async call

                  if (singleCharTranslation) { // Only draw if a translation exists
                      const box = item.bounding_box;
                      const minX = Math.min(box[0][0], box[1][0], box[2][0], box[3][0]);
                      const minY = Math.min(box[0][1], box[1][1], box[2][1], box[3][1]);
                      const maxX = Math.max(box[0][0], box[1][0], box[2][0], box[3][0]);
                      const maxY = Math.max(box[0][1], box[1][1], box[2][1], box[3][1]);
                      const width = maxX - minX;
                      const height = maxY - minY;
                      ctx.strokeStyle = 'red';
                      ctx.lineWidth = 2;
                      ctx.strokeRect(minX, minY, width, height);

                      // Add translation to the item before pushing to displayData
                      displayData.push({ ...item, translation: singleCharTranslation });
                  } else {
                      // If no translation, still push the item but without drawing a box
                      displayData.push(item);
                  }
                  itemIndex++;
              }
          }
      }

      // Update ocrData with the data used for display
      ocrData = displayData;
    } catch (err) {
      console.error('Error during OCR display processing:', err);
    }
  };
  img.src = `data:image/png;base64,${image}`;
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  let hoveredText = null;
  ocrData.forEach(item => {
    const box = item.bounding_box;
    const minX = Math.min(box[0][0], box[1][0], box[2][0], box[3][0]);
    const minY = Math.min(box[0][1], box[1][1], box[2][1], box[3][1]);
    const maxX = Math.max(box[0][0], box[1][0], box[2][0], box[3][0]);
    const maxY = Math.max(box[0][1], box[1][1], box[2][1], box[3][1]);

    if (x >= minX && x <= maxX && y >= minY && y <= maxY && item.translation) {
      hoveredText = item.text;
      const translation = item.translation;
      let displayText = item.text;
      if (translation) {
        displayText += `\n[${translation.pinyin}]\n${translation.english.join('; ')}`;
      }
      hoverTextDiv.style.left = `${e.clientX + 10}px`;
      hoverTextDiv.style.top = `${e.clientY + 10}px`;
      hoverTextDiv.innerText = displayText;
      hoverTextDiv.style.display = 'block';
    }
  });

  if (!hoveredText) {
    hoverTextDiv.style.display = 'none';
  }
});

canvas.addEventListener('mouseout', () => {
  hoverTextDiv.style.display = 'none';
});

canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  ocrData.forEach(item => {
    const box = item.bounding_box;
    const minX = Math.min(box[0][0], box[1][0], box[2][0], box[3][0]);
    const minY = Math.min(box[0][1], box[1][1], box[2][1], box[3][1]);
    const maxX = Math.max(box[0][0], box[1][0], box[2][0], box[3][0]);
    const maxY = Math.max(box[0][1], box[1][1], box[2][1], box[3][1]);

    if (x >= minX && x <= maxX && y >= minY && y <= maxY && item.translation) {
      ipcRenderer.send('wordbook:add', item);
      alert(`'${item.text}' added to Word Book.`);
    }
  });
});