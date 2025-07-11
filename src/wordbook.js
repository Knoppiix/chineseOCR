const { ipcRenderer } = require('electron');

const exportBtn = document.getElementById('export-btn');
const wordListDiv = document.getElementById('word-list');

exportBtn.addEventListener('click', () => {
  ipcRenderer.send('wordbook:export');
});

ipcRenderer.on('wordbook:data', (event, wordBook) => {
  wordListDiv.innerHTML = '';
  wordBook.forEach(word => {
    const wordDiv = document.createElement('div');
    let text = word.text;
    if (word.translation) {
      text += ` - [${word.translation.pinyin}] ${word.translation.english.join('; ')}`;
    }
    wordDiv.textContent = text;
    wordListDiv.appendChild(wordDiv);
  });
});
